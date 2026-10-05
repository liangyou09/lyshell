import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { ConnectionStatus } from '@shared/types'
import { PluginResourceRegistry, releasePluginSessions } from '../plugin/resource-registry'
import { resolveSessionResourceOwner, trackSessionResource } from './session-resources'

// 执行实际 HTTP handler，仅替换 IO，避免加载 Electron 和原生连接器。
const source = ts.createSourceFile('http-server.ts', readFileSync(join(process.cwd(), 'src/main/mcp/http-server.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'handleReconnectSession')
if (!declaration) throw new Error('handleReconnectSession not found')
const script = ts.transpileModule(`(${declaration.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

function fixture(status = ConnectionStatus.DISCONNECTED, ownerPluginId?: string, saved = false) {
  const registry = new PluginResourceRegistry()
  const session = { id: 'target', config: { id: 'target', ownerPluginId }, status }
  let live: typeof session | undefined = session
  const enabled = new Set(['plugin', 'owner'])
  const authorize = vi.fn(async () => ({ allowed: true }))
  const reconnect = vi.fn(async () => {
    session.status = ConnectionStatus.CONNECTED
    return session
  })
  const deleting = vi.fn(() => false)
  const sendJson = vi.fn()
  const handler = runInNewContext(script, {
    pluginResources: registry, resolveSessionResourceOwner, trackSessionResource,
    pluginRepository: { get: (id: string) => ({ enabled: enabled.has(id) }) },
    sessionRepository: { get: () => saved ? session.config : undefined },
    sessionManager: { getSession: () => live, isSessionDeleting: deleting, reconnectSession: reconnect },
    authorizeMcpOperation: authorize, resolveRuntimeSessionId: (id: string) => id,
    sendJson, log: { info: vi.fn(), error: vi.fn() }
  }) as (data: { sessionId: string }, res: unknown, binding: { kind: string; pluginId?: string; originSessionId?: string }) => Promise<void>
  const call = (binding = { kind: 'plugin', pluginId: 'plugin' }) => handler({ sessionId: 'target' }, {}, binding)
  const deleteSaved = vi.fn()
  const deleteLive = vi.fn(async () => { live = undefined })
  const release = (id: string) => releasePluginSessions(registry, id, {
    listSessions: () => live ? [{ id: live.id, ownerPluginId: live.config.ownerPluginId }] : [],
    notifyReleased() {}, notifySessionDeleted() {}, notifyChanged() {}, deleteSaved, deleteLive
  })
  return { registry, session, enabled, authorize, reconnect, deleting, sendJson, call, handler, release, deleteSaved, deleteLive,
    replace: () => { live = { ...session } } }
}

describe('MCP 重连的插件资源生命周期', () => {
  it.each([ConnectionStatus.DISCONNECTED, ConnectionStatus.ERROR, ConnectionStatus.CONNECTED])('重连 %s 用户终端，禁用关闭新连接并保留用户配置', async status => {
    const f = fixture(status, undefined, true)
    f.reconnect.mockImplementation(async () => {
      expect(f.registry.owner('target')).toBe('plugin')
      return f.session
    })
    await f.call()
    expect(f.sendJson).toHaveBeenCalledWith({}, 200, expect.objectContaining({ success: true }))
    await f.release('plugin')
    expect(f.deleteLive).toHaveBeenCalledWith('target')
    expect(f.deleteSaved).not.toHaveBeenCalled()
  })

  it.each([false, true])('已有插件归属不转移，只有实际保存项才删除配置：saved=%s', async saved => {
    const f = fixture(ConnectionStatus.DISCONNECTED, 'owner', saved)
    await f.call()
    expect(f.registry.owner('target')).toBe('owner')
    await f.release('plugin')
    expect(f.deleteLive).not.toHaveBeenCalled()
    await f.release('owner')
    expect(f.deleteLive).toHaveBeenCalledWith('target')
    expect(f.deleteSaved.mock.calls).toEqual(saved ? [['target']] : [])
  })

  it('插件终端的 session token 重连另一个终端，继承来源插件归属', async () => {
    const f = fixture()
    f.registry.track('plugin', 'origin', 0)
    await f.handler({ sessionId: 'target' }, {}, { kind: 'session', originSessionId: 'origin' })
    expect(f.registry.owner('target')).toBe('plugin')
  })

  it.each(['generation', 'disabled', 'replaced', 'deleting'] as const)('授权等待期间 %s，拒绝重连', async change => {
    const f = fixture()
    let finish!: () => void
    f.authorize.mockImplementation(() => new Promise(resolve => { finish = () => resolve({ allowed: true }) }))
    const result = f.call()
    if (change === 'generation') f.registry.release('plugin')
    if (change === 'disabled') f.enabled.delete('plugin')
    if (change === 'replaced') f.replace()
    if (change === 'deleting') f.deleting.mockReturnValue(true)
    finish()
    await result
    expect(f.reconnect).not.toHaveBeenCalled()
    expect(f.registry.owner('target')).toBeUndefined()
    expect(f.sendJson).toHaveBeenCalledWith({}, 403, expect.objectContaining({ success: false }))
  })

  it('全局 token 重连用户终端不创建插件归属', async () => {
    const f = fixture()
    await f.handler({ sessionId: 'target' }, {}, { kind: 'global' })
    expect(f.reconnect).toHaveBeenCalledOnce()
    expect(f.registry.owner('target')).toBeUndefined()
  })
})
