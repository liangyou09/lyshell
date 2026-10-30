import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionConfig } from '@shared/types'
import { ConnectionStatus, ConnectionType } from '@shared/types'
vi.mock('electron', () => ({ app: {} }))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@main/file', () => ({ fileManager: { removeConnector: async () => {} }, cancelDownloadsBySession: vi.fn(), cancelUploadsBySession: vi.fn() }))
vi.mock('@main/mcp/auth', () => ({ revokeSessionToken: vi.fn() }))
vi.mock('../connectors', async () => {
  const { EventEmitter } = await import('events')
  class Connector extends EventEmitter {
    getClient() { return {} }
    setSharedClient() {}
    async startShellOnly() {}
    async disconnect() {}
    getEncoding() { return 'utf-8' }
  }
  return { SSHConnector: Connector, TelnetConnector: Connector, SerialConnector: Connector, LocalConnector: Connector,
    ConnectionStatus: { CONNECTED: 'connected', CONNECTING: 'connecting', DISCONNECTED: 'disconnected', ERROR: 'error' },
    ConnectionType: { SSH: 'ssh' } }
})
import { SSHConnector } from '../connectors'
import { SessionManager } from './session-manager'
import { pluginResources, releasePluginSessions } from '@main/plugin/resource-registry'

const managers: SessionManager[] = []
async function source(originSavedSessionId?: string) {
  const manager = new SessionManager()
  managers.push(manager)
  manager.on('session:deleted', id => pluginResources.forgetLiveSession(id))
  const session = await manager.createSession({
    id: '', name: 'SSH', type: ConnectionType.SSH, ssh: { host: 'host', port: 22, username: 'user' },
    terminal: {
      fontFamily: 'Consolas', fontSize: 12, theme: {} as SessionConfig['terminal']['theme'],
      cursorStyle: 'bar', cursorBlink: false, scrollback: 10, encoding: 'utf-8'
    }, originSavedSessionId,
    tags: [], createdAt: new Date(), updatedAt: new Date()
  })
  session.status = ConnectionStatus.CONNECTED
  session.connector = new SSHConnector(session.id, session.config.ssh!)
  pluginResources.track('plugin', session.id, pluginResources.generation('plugin'))
  return { manager, session }
}
function release(manager: SessionManager) {
  return releasePluginSessions(pluginResources, 'plugin', {
    notifyReleased() {}, deleteSaved() {}, notifySessionDeleted() {}, notifyChanged() {},
    listSessions: () => manager.getAllSessions().map(s => ({ id: s.id, originSavedSessionId: s.config.originSavedSessionId, ownerPluginId: s.config.ownerPluginId })),
    deleteLive: id => manager.deleteSession(id)
  })
}
afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const manager of managers.splice(0)) {
    for (const session of manager.getAllSessions()) await manager.deleteSession(session.id)
  }
  pluginResources.release('plugin')
})

describe('插件 SSH 克隆渠道回收', () => {
  it('SSH 克隆同样受运行时会话上限限制，满额后不再开启 shell', async () => {
    const { manager, session } = await source()
    for (let index = 1; index < 256; index++) await manager.createSession({ ...session.config, id: `limit-${index}` })
    const open = vi.spyOn(SSHConnector.prototype, 'startShellOnly')
    await expect(manager.cloneChannel(session.id)).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
    expect(manager.getAllSessions()).toHaveLength(256)
    expect(open).not.toHaveBeenCalled()
  })

  it('开始退出后禁止克隆，等待 shell 的旧克隆也不得发布 connected', async () => {
    const { manager, session } = await source()
    let finish!: () => void
    const open = vi.spyOn(SSHConnector.prototype, 'startShellOnly').mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
    const cloning = manager.cloneChannel(session.id)
    const status = vi.fn()
    manager.on('session:status', status)
    await manager.beginShutdown()
    finish()
    expect(await cloning).toBeNull()
    await expect(manager.cloneChannel(session.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(open).toHaveBeenCalledOnce()
    expect(status.mock.calls.some(([event]) => event.status === ConnectionStatus.CONNECTED)).toBe(false)
  })

  it('shell 创建期间已绑定数据和错误监听，首包保留且错误不能逃出 EventEmitter', async () => {
    const { manager, session } = await source()
    let finish!: () => void
    vi.spyOn(SSHConnector.prototype, 'startShellOnly').mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
    const output = vi.fn()
    manager.on('terminal:data', output)
    const cloning = manager.cloneChannel(session.id)
    const clone = manager.getAllSessions().find(s => s.id !== session.id)!
    clone.connector!.emit('data', 'early banner\r\n')
    const raw = clone.outputBuffer?.getOutputSince(0, false).text
    let escaped: unknown
    try { clone.connector!.emit('error', new Error('connection lost while opening')) } catch (error) { escaped = error }
    finish()
    const result = await cloning
    expect(raw).toBe('early banner\r\n')
    expect(output).toHaveBeenCalledWith({ sessionId: clone.id, data: 'early banner\r\n' })
    expect(escaped).toBeUndefined()
    expect(result).toBeNull()
    expect(manager.getSession(clone.id)).toBeUndefined()
    expect(manager.getSession(session.id)).toBe(session)
  })

  it('shell 创建期间关闭后不能再发布 connected 或保留僵尸克隆', async () => {
    const { manager, session } = await source()
    let finish!: () => void
    vi.spyOn(SSHConnector.prototype, 'startShellOnly').mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
    const status = vi.fn()
    manager.on('session:status', status)
    const cloning = manager.cloneChannel(session.id)
    const clone = manager.getAllSessions().find(s => s.id !== session.id)!
    clone.connector!.emit('close')
    finish()
    expect(await cloning).toBeNull()
    expect(status.mock.calls.some(([event]) => event.id === clone.id && event.status === ConnectionStatus.CONNECTED)).toBe(false)
    expect(manager.getSession(clone.id)).toBeUndefined()
  })

  it('异步断开尚未完成时就标记来源正在删除，完成后清除标记', async () => {
    const { manager, session } = await source()
    let finish!: () => void
    vi.spyOn(manager, 'disconnectSession').mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
    const deletion = manager.deleteSession(session.id)
    expect(manager.getSession(session.id)).toBeDefined()
    expect(manager.isSessionDeleting(session.id)).toBe(true)
    finish()
    await deletion
    expect(manager.getSession(session.id)).toBeUndefined()
    expect(manager.isSessionDeleting(session.id)).toBe(false)
  })
  it.each([undefined, 'user-saved'])('来源保存项为 %s 时继承运行时归属，禁用清空所有克隆', async origin => {
    const { manager, session } = await source(origin)
    const clone = await manager.cloneChannel(session.id)
    expect(clone?.config.ownerPluginId).toBe('plugin')
    expect(pluginResources.owner(clone!.id)).toBe('plugin')
    const nested = await manager.cloneChannel(clone!.id)
    expect(pluginResources.owner(nested!.id)).toBe('plugin')
    await release(manager)
    expect(manager.getAllSessions()).toEqual([])
    await expect(manager.reconnectSession(clone!.id)).rejects.toThrow('Session not found')
  })

  it('开启渠道期间禁用，迟到的成功返回不能复活会话或发送 connected', async () => {
    const { manager, session } = await source('user-saved')
    let finish!: () => void
    vi.spyOn(SSHConnector.prototype, 'startShellOnly').mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
    const connected = vi.fn()
    manager.on('session:status', connected)
    const cloning = manager.cloneChannel(session.id)
    expect(manager.getAllSessions()).toHaveLength(2)
    let released = false
    const cleanup = release(manager).then(() => { released = true })
    await Promise.resolve()
    expect(released).toBe(false)
    finish()
    await cleanup
    expect(await cloning).toBeNull()
    expect(manager.getAllSessions()).toEqual([])
    expect(connected.mock.calls.some(([data]) => data.status === ConnectionStatus.CONNECTED)).toBe(false)
  })

  it('迟到的 shell 关闭失败，禁用和克隆都报告失败并保留归属，下一次回收可重试', async () => {
    const { manager, session } = await source('user-saved')
    let finish!: () => void
    vi.spyOn(SSHConnector.prototype, 'startShellOnly').mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
    const cloning = manager.cloneChannel(session.id)
    const clone = manager.getAllSessions().find(s => s.id !== session.id)!
    const close = vi.spyOn(clone.connector!, 'disconnect').mockRejectedValueOnce(new Error('channel close failed')).mockResolvedValue(undefined)
    const cloneFailure = expect(cloning).rejects.toThrow('channel close failed')
    const cleanup = release(manager)
    const cleanupFailure = expect(cleanup).rejects.toThrow('channel close failed')
    await Promise.resolve()
    expect(close).not.toHaveBeenCalled()
    expect(manager.getSession(clone.id)).toBe(clone)
    finish()
    await Promise.all([cloneFailure, cleanupFailure])
    expect(close).toHaveBeenCalledOnce()
    expect(manager.getSession(clone.id)).toBe(clone)
    expect(manager.isSessionDeleting(clone.id)).toBe(true)
    expect(pluginResources.owner(clone.id)).toBe('plugin')
    await release(manager)
    expect(close).toHaveBeenCalledTimes(2)
    expect(manager.getSession(clone.id)).toBeUndefined()
    expect(pluginResources.owner(clone.id)).toBeUndefined()
  })

  it('普通用户渠道不被插件清理误删', async () => {
    const { manager, session } = await source('user-saved')
    pluginResources.forgetLiveSession(session.id)
    const clone = await manager.cloneChannel(session.id)
    expect(clone?.config.ownerPluginId).toBeUndefined()
    await release(manager)
    expect(manager.getAllSessions()).toHaveLength(2)
  })

  it('禁用等待中的 shell 创建失败也能完成回收，不留下悬空任务', async () => {
    const { manager, session } = await source()
    let fail!: (error: Error) => void
    vi.spyOn(SSHConnector.prototype, 'startShellOnly').mockImplementation(() => new Promise<void>((_resolve, reject) => { fail = reject }))
    const cloning = manager.cloneChannel(session.id)
    const cleanup = release(manager)
    fail(new Error('shell request failed'))
    await cleanup
    expect(await cloning).toBeNull()
    expect(manager.getAllSessions()).toEqual([])
  })

  it('shell 创建期间同步重入删除，仍等待同一个创建任务且不死锁', async () => {
    const { manager, session } = await source()
    let deletion!: Promise<boolean>
    let cloneId!: string
    vi.spyOn(SSHConnector.prototype, 'startShellOnly').mockImplementation(() => {
      cloneId = manager.getAllSessions().find(s => s.id !== session.id)!.id
      deletion = manager.deleteSession(cloneId)
      return Promise.resolve()
    })
    expect(await manager.cloneChannel(session.id)).toBeNull()
    expect(await deletion).toBe(true)
    expect(manager.getSession(cloneId)).toBeUndefined()
    expect(pluginResources.owner(cloneId)).toBeUndefined()
  })

  it('shell 永不响应时回收有界失败，重试可再次等待，迟到成功后自动关闭', async () => {
    vi.useFakeTimers()
    const { manager, session } = await source()
    let finish!: () => void
    vi.spyOn(SSHConnector.prototype, 'startShellOnly').mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
    const cloning = manager.cloneChannel(session.id)
    const clone = manager.getAllSessions().find(s => s.id !== session.id)!
    const close = vi.spyOn(clone.connector!, 'disconnect').mockResolvedValue(undefined)
    const first = expect(release(manager)).rejects.toThrow('SSH shell cleanup timed out')
    await vi.advanceTimersByTimeAsync(5000)
    await first
    expect(manager.getSession(clone.id)).toBe(clone)
    expect(manager.isSessionDeleting(clone.id)).toBe(true)
    expect(pluginResources.owner(clone.id)).toBe('plugin')
    expect(close).not.toHaveBeenCalled()
    const second = expect(release(manager)).rejects.toThrow('SSH shell cleanup timed out')
    await vi.advanceTimersByTimeAsync(5000)
    await second
    expect(vi.getTimerCount()).toBe(0)
    finish()
    expect(await cloning).toBeNull()
    expect(close).toHaveBeenCalledOnce()
    expect(manager.getSession(clone.id)).toBeUndefined()
    expect(pluginResources.owner(clone.id)).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('超时后重新回收遇到迟到的关闭失败，保留资源并支持下一次重试', async () => {
    vi.useFakeTimers()
    const { manager, session } = await source()
    let finish!: () => void
    vi.spyOn(SSHConnector.prototype, 'startShellOnly').mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
    const cloning = manager.cloneChannel(session.id)
    const clone = manager.getAllSessions().find(s => s.id !== session.id)!
    const close = vi.spyOn(clone.connector!, 'disconnect').mockRejectedValueOnce(new Error('late close failed')).mockResolvedValue(undefined)
    const cloneFailure = expect(cloning).rejects.toThrow('late close failed')
    const first = expect(release(manager)).rejects.toThrow('SSH shell cleanup timed out')
    await vi.advanceTimersByTimeAsync(5000)
    await first
    const second = expect(release(manager)).rejects.toThrow('late close failed')
    finish()
    await Promise.all([second, cloneFailure])
    expect(pluginResources.owner(clone.id)).toBe('plugin')
    expect(manager.getSession(clone.id)).toBe(clone)
    await release(manager)
    expect(close).toHaveBeenCalledTimes(2)
    expect(manager.getSession(clone.id)).toBeUndefined()
    expect(pluginResources.owner(clone.id)).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })
})
