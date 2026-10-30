import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { PluginResourceRegistry, releasePluginSessions } from '../plugin/resource-registry'

// 执行实际注册的 IPC 回调，仅注入 IO 依赖，避免加载 Electron 与原生模块。
const source = ts.createSourceFile('handlers.ts', readFileSync(join(process.cwd(), 'src/main/ipc/handlers.ts'), 'utf8'),
  ts.ScriptTarget.Latest, true)
const callbacks = new Map<string, ts.Expression>()
function findCallback(node: ts.Node): void {
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'applicationIpc.handle'
    && ts.isStringLiteral(node.arguments[0]) && ['plugin:uninstall', 'plugin:disable'].includes(node.arguments[0].text)) {
    callbacks.set(node.arguments[0].text, node.arguments[1])
  }
  ts.forEachChild(node, findCallback)
}
findCallback(source)
function fixture(channel = 'plugin:uninstall') {
  const callback = callbacks.get(channel)
  if (!callback) throw new Error(`${channel} handler not found`)
  const script = ts.transpileModule(`(${callback.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  let entry: { id: string; enabled: boolean; dev: boolean } | undefined = { id: 'plugin', enabled: true, dev: true }
  let revision = 0
  const registry = new PluginResourceRegistry()
  const remove = vi.fn(() => { entry = undefined; return true })
  const cleanup = vi.fn(async () => { registry.release('plugin') })
  const restart = vi.fn(async () => {})
  const deactivate = vi.fn(async () => {})
  const syncPluginViews = vi.fn()
  const handler = runInNewContext(script, {
    assertString: (value: string) => value,
    pluginRepository: { get: () => entry ? { ...entry } : undefined, getRevision: () => revision,
      setEnabled: (_id: string, enabled: boolean) => { entry!.enabled = enabled; revision++; return true }, remove },
    uniquePluginWebOrigins: () => [], getPluginViewRegistry: () => ({ listViews: () => [] }),
    revokeAllPluginTokens: vi.fn(), teardownPluginViews: vi.fn(),
    releasePluginResources: cleanup, pluginResources: registry, pluginHostManager: { restart, deactivatePlugin: deactivate }, syncPluginViews,
    mcpAuditRepository: { append: vi.fn() }, log: { info: vi.fn() }, validationFailure: () => null
  }) as (_event: unknown, id: string) => Promise<{ success: boolean; error?: string }>
  return { getEntry: () => entry, replaceEntry: (enabled = false) => { entry = { id: 'plugin', enabled, dev: true }; revision++ },
    enable: () => { entry!.enabled = true; revision++ }, registry, remove, cleanup, restart, deactivate, syncPluginViews, handler }
}

it.each(['plugin:disable', 'plugin:uninstall'])('停机等待期间替换安装记录，旧 %s 不得撤销新插件', async channel => {
  const { handler, deactivate, replaceEntry, getEntry, cleanup, restart } = fixture(channel)
  let finish!: () => void
  deactivate.mockReturnValue(new Promise<void>(resolve => { finish = resolve }))
  const result = handler(undefined, 'plugin')
  replaceEntry(true)
  finish()
  expect(await result).toMatchObject({ success: false, error: expect.stringContaining('停机期间已变更') })
  expect(getEntry()?.enabled).toBe(true)
  expect(cleanup).not.toHaveBeenCalled()
  expect(restart).not.toHaveBeenCalled()
})

describe('插件卸载失败保留重试入口', () => {
  it('注册表删除保存失败时不报告成功，保留禁用记录并允许重试', async () => {
    const { getEntry, remove, syncPluginViews, handler } = fixture()
    remove.mockReturnValueOnce(false)
    expect(await handler(undefined, 'plugin')).toEqual({ success: false, error: '无法保存插件卸载状态，请重试' })
    expect(getEntry()).toMatchObject({ enabled: false })
    expect(syncPluginViews).not.toHaveBeenCalled()
    expect(await handler(undefined, 'plugin')).toEqual({ success: true })
    expect(getEntry()).toBeUndefined()
  })

  it.each([false, true])('宿主重启先失败后重试卸载，借用终端关闭失败=%s，不能跳过仍在途的关闭', async failClose => {
    const { getEntry, registry, remove, cleanup, restart, handler } = fixture()
    registry.track('plugin', 'borrowed', 0)
    let finish!: () => void
    let fail!: (error: Error) => void
    const deleteLive = vi.fn(() => new Promise<void>((resolve, reject) => { finish = resolve; fail = reject }))
    cleanup.mockImplementation(() => releasePluginSessions(registry, 'plugin', {
      notifyReleased() {}, listSessions: () => [{ id: 'borrowed' }], deleteSaved() {},
      notifySessionDeleted() {}, notifyChanged() {}, deleteLive
    }))
    restart.mockRejectedValueOnce(new Error('restart failed'))
    expect(await handler(undefined, 'plugin')).toEqual({ success: false, error: 'restart failed' })
    expect(registry.owner('borrowed')).toBe('plugin')
    let finished = false
    const second = handler(undefined, 'plugin').then(result => { finished = true; return result })
    await Promise.resolve()
    expect(finished).toBe(false)
    expect(getEntry()).toBeDefined()
    expect(remove).not.toHaveBeenCalled()
    expect(deleteLive).toHaveBeenCalledOnce()
    if (failClose) {
      fail(new Error('close failed'))
      expect(await second).toMatchObject({ success: false, error: expect.stringContaining('close failed') })
      expect(getEntry()).toMatchObject({ enabled: false })
      expect(registry.owner('borrowed')).toBe('plugin')
      const third = handler(undefined, 'plugin')
      await vi.waitFor(() => expect(deleteLive).toHaveBeenCalledTimes(2))
      finish()
      expect(await third).toEqual({ success: true })
    } else {
      finish()
      expect(await second).toEqual({ success: true })
    }
    expect(getEntry()).toBeUndefined()
    expect(remove).toHaveBeenCalledOnce()
    expect(registry.owner('borrowed')).toBeUndefined()
  })

  it.each(['cleanup', 'restart'])('%s 失败时保留禁用记录，重试成功后才移除', async failure => {
    const { getEntry, remove, cleanup, restart, syncPluginViews, handler } = fixture()
    const failing = failure === 'cleanup' ? cleanup : restart
    failing.mockRejectedValueOnce(new Error(`${failure} failed`))

    expect(await handler(undefined, 'plugin')).toEqual({ success: false, error: `${failure} failed` })
    expect(getEntry()).toEqual({ id: 'plugin', enabled: false, dev: true })
    expect(remove).not.toHaveBeenCalled()
    expect(syncPluginViews).not.toHaveBeenCalled()
    expect(await handler(undefined, 'plugin')).toEqual({ success: true })
    expect(getEntry()).toBeUndefined()
    expect(remove).toHaveBeenCalledOnce()
    expect(syncPluginViews).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledTimes(2)
    expect(restart).toHaveBeenCalledTimes(2)
  })

  it.each(['replaced', 'enabled', 'released'])('清理等待期间插件被 %s，旧卸载不能删除新状态', async change => {
    const { getEntry, replaceEntry, enable, registry, remove, cleanup, handler } = fixture()
    let finish!: () => void
    cleanup.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    const result = handler(undefined, 'plugin')
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce())
    if (change === 'replaced') replaceEntry()
    else if (change === 'enabled') enable()
    else registry.release('plugin')
    const latest = getEntry()
    finish()
    expect(await result).toEqual({ success: false, error: '插件在卸载期间已变更，请重试' })
    expect(getEntry()).toBe(latest)
    expect(remove).not.toHaveBeenCalled()
  })
})
