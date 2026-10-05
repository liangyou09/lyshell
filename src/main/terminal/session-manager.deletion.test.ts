import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectionStatus, ConnectionType, type SessionConfig } from '@shared/types'

vi.mock('electron', () => ({ app: {} }))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@main/file', () => ({ fileManager: { removeConnector: vi.fn(async () => {}) }, cancelDownloadsBySession: vi.fn(), cancelUploadsBySession: vi.fn() }))
vi.mock('@main/mcp/auth', () => ({ revokeSessionToken: vi.fn() }))

// 保留真实 SerialConnector，只控制原生打开/关闭回调，复现插件禁用与重连交叠。
const ports = vi.hoisted(() => [] as Array<{
  finishOpen(error?: Error): void; finishClose(error?: Error): void; close(callback: (error?: Error) => void): void; isOpen: boolean; invalidateOnClose: boolean
}>)
vi.mock('serialport', async () => {
  const { EventEmitter } = await import('node:events')
  class Port extends EventEmitter {
    isOpen = false
    closing = false
    invalidateOnClose = false
    finishOpen!: (error?: Error) => void
    finishClose!: (error?: Error) => void
    constructor() { super(); ports.push(this) }
    open(callback: (error?: Error) => void) {
      this.finishOpen = error => { this.isOpen = !error; callback(error) }
    }
    close = vi.fn((callback: (error?: Error) => void) => {
      if (!this.isOpen || this.closing) { queueMicrotask(() => callback(new Error('Port is not open'))); return }
      this.closing = true
      // 内置 bindings-cpp 在原生关闭完成前清空 fd，错误回调也不会恢复 isOpen。
      if (this.invalidateOnClose) this.isOpen = false
      this.finishClose = error => {
        this.closing = false
        if (!error) { this.isOpen = false; this.emit('close') }
        callback(error)
      }
    })
  }
  return { SerialPort: Port }
})
vi.mock('../connectors', async () => {
  const { SerialConnector } = await import('../connectors/serial')
  class UnusedConnector {}
  return { SSHConnector: UnusedConnector, TelnetConnector: UnusedConnector, SerialConnector, LocalConnector: UnusedConnector,
    ConnectionStatus, ConnectionType }
})
import { SerialConnector } from '../connectors/serial'
import { SessionManager } from './session-manager'
import { PluginResourceRegistry, releasePluginSessions } from '../plugin/resource-registry'
import { fileManager } from '@main/file'

async function fixture(connected = true) {
  const manager = new SessionManager()
  const registry = new PluginResourceRegistry()
  const session = await manager.createSession({
    id: 'plugin-live', name: 'Serial', type: ConnectionType.SERIAL, serial: { path: 'COM1', baudRate: 9600 },
    terminal: {} as SessionConfig['terminal'], ownerPluginId: 'a', tags: [], createdAt: new Date(), updatedAt: new Date()
  })
  if (connected) {
    const connector = new SerialConnector(session.id, session.config.serial!)
    const opening = connector.connect()
    ports[0].finishOpen()
    await opening
    session.connector = connector
    session.status = ConnectionStatus.CONNECTED
  }
  registry.track('a', session.id, 0)
  const release = () => releasePluginSessions(registry, 'a', {
    notifyReleased() {}, listSessions: () => manager.getAllSessions().map(s => ({ id: s.id, ownerPluginId: s.config.ownerPluginId })), deleteSaved() {},
    notifySessionDeleted() {}, notifyChanged() {}, deleteLive: id => manager.deleteSession(id)
  })
  return { manager, session, release, registry }
}

afterEach(() => { vi.restoreAllMocks(); vi.mocked(fileManager.removeConnector).mockReset(); ports.length = 0 })

describe('删除中的会话拒绝连接', () => {
  it.each([false, true])('借用用户配置的串口并发回收，关闭失败=%s，所有调用等待同一原生关闭', async failClose => {
    const { manager, session, release, registry } = await fixture()
    session.config.ownerPluginId = undefined
    let finished = 0
    const settle = (error?: unknown): unknown => { finished++; return error }
    const first = release().then(() => settle(), settle)
    const second = release().then(() => settle(), settle)
    await Promise.resolve()
    expect(finished).toBe(0)
    expect(registry.owner(session.id)).toBe('a')
    expect(ports[0].close).toHaveBeenCalledTimes(1)
    ports[0].finishClose(failClose ? new Error('close failed') : undefined)
    const results = await Promise.all([first, second])
    expect(finished).toBe(2)
    if (failClose) {
      expect(results.every(result => result instanceof Error)).toBe(true)
      expect(manager.getSession(session.id)).toBe(session)
      expect(registry.owner(session.id)).toBe('a')
      const third = release()
      const fourth = release()
      expect(ports[0].close).toHaveBeenCalledTimes(2)
      ports[0].finishClose()
      await Promise.all([third, fourth])
    } else expect(results).toEqual([undefined, undefined])
    expect(manager.getSession(session.id)).toBeUndefined()
    expect(registry.owner(session.id)).toBeUndefined()
    expect(ports[0].isOpen).toBe(false)
  })

  it('插件禁用等待串口关闭时，迟到重连被拒绝且不会打开第二个串口', async () => {
    const { manager, session, release } = await fixture()
    const cleanup = release()
    try {
      expect(manager.isSessionDeleting(session.id)).toBe(true)
      await expect(manager.reconnectSession(session.id)).rejects.toThrow('Session is being deleted')
      expect(ports).toHaveLength(1)
      expect(ports[0].close).toHaveBeenCalledTimes(1)
    } finally {
      ports[0].finishClose()
      await cleanup
    }
    expect(manager.getSession(session.id)).toBeUndefined()
    expect(ports[0].isOpen).toBe(false)
  })

  it('直接连接删除中的会话被拒绝，不复用或创建连接器', async () => {
    const { manager, session, release } = await fixture()
    const cleanup = release()
    try {
      await expect(manager.connectSession(session.id)).rejects.toThrow('Session is being deleted')
      expect(ports).toHaveLength(1)
    } finally {
      ports[0].finishClose()
      await cleanup
    }
  })

  it('重连已在等待旧串口断开，期间禁用也不能启动新串口', async () => {
    const { manager, session, release } = await fixture()
    const reconnect = manager.reconnectSession(session.id)
    const result = reconnect.catch(error => error as Error)
    const cleanup = release()
    ports[0].finishClose()
    await cleanup
    expect(await result).toBeInstanceOf(Error)
    expect(ports).toHaveLength(1)
    expect(manager.getSession(session.id)).toBeUndefined()
  })

  it('连接等待文件清理期间开始删除，等待结束后仍不得创建连接器', async () => {
    const { manager, session, release } = await fixture(false)
    let finish!: () => void
    vi.mocked(fileManager.removeConnector).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    const disconnect = manager.disconnectSession(session.id)
    const connecting = manager.connectSession(session.id)
    const result = connecting.catch(error => error as Error)
    const cleanup = release()
    finish()
    await Promise.all([disconnect, cleanup])
    expect(await result).toBeInstanceOf(Error)
    expect(ports).toHaveLength(0)
    expect(manager.getSession(session.id)).toBeUndefined()
  })

  it('正常重连仍关闭旧串口并打开新串口', async () => {
    const { manager, session } = await fixture()
    const reconnect = manager.reconnectSession(session.id)
    ports[0].finishClose()
    await vi.waitFor(() => expect(ports).toHaveLength(2))
    ports[1].finishOpen()
    expect((await reconnect).status).toBe(ConnectionStatus.CONNECTED)
    expect(ports[0].isOpen).toBe(false)
    expect(ports[1].isOpen).toBe(true)
    const deletion = manager.deleteSession(session.id)
    ports[1].finishClose()
    await deletion
    expect(ports[1].isOpen).toBe(false)
  })

  it('串口仍在打开时禁用，等待迟到的成功句柄真正关闭才完成回收', async () => {
    const { manager, session, release } = await fixture(false)
    const opening = manager.connectSession(session.id)
    const result = opening.catch(error => error as Error)
    const connector = session.connector!
    const connected = vi.fn()
    connector.on('connected', connected)
    let finished = false
    const cleanup = release().then(() => { finished = true })
    await Promise.resolve()
    expect(finished).toBe(false)
    expect(ports[0].close).not.toHaveBeenCalled()
    ports[0].finishOpen()
    expect(await result).toBeInstanceOf(Error)
    expect(connected).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(ports[0].close).toHaveBeenCalledTimes(1))
    expect(finished).toBe(false)
    ports[0].finishClose()
    await cleanup
    expect(manager.getSession(session.id)).toBeUndefined()
    expect(connector.isConnected()).toBe(false)
    expect(ports[0].isOpen).toBe(false)
  })

  it('禁用期间原生打开失败，回收正常完成且不关闭未打开的句柄', async () => {
    const { manager, session, release } = await fixture(false)
    const result = manager.connectSession(session.id).catch(error => error as Error)
    const cleanup = release()
    ports[0].finishOpen(new Error('open failed'))
    expect(await result).toMatchObject({ message: 'open failed' })
    await cleanup
    expect(ports[0].close).not.toHaveBeenCalled()
    expect(ports[0].isOpen).toBe(false)
    expect(manager.getSession(session.id)).toBeUndefined()
  })

  it('用户关闭和插件禁用共享删除流程，不提前失效也不误删同 ID 的新会话', async () => {
    const { manager, session, release } = await fixture()
    const deleted = vi.fn()
    manager.on('session:deleted', deleted)
    const first = manager.deleteSession(session.id)
    const second = manager.deleteSession(session.id)
    let finished = false
    const cleanup = release().then(() => { finished = true })
    expect(second).toBe(first)
    expect(ports[0].close).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    expect(finished).toBe(false)
    expect(manager.isSessionDeleting(session.id)).toBe(true)
    await expect(manager.createSession({ ...session.config })).rejects.toThrow('Session already exists')
    ports[0].finishClose()
    await Promise.all([first, second, cleanup])
    expect(deleted.mock.calls).toEqual([[session.id]])
    const replacement = await manager.createSession({ ...session.config, ownerPluginId: undefined })
    await Promise.resolve()
    expect(manager.getSession(session.id)).toBe(replacement)
    expect(manager.isSessionDeleting(session.id)).toBe(false)
    await manager.deleteSession(replacement.id)
  })

  it('断开清理的同步事件中重入删除，也共享同一 Promise 和原生关闭', async () => {
    const { manager, session } = await fixture()
    let nested: Promise<boolean> | undefined
    vi.mocked(fileManager.removeConnector).mockImplementationOnce(async () => { nested = manager.deleteSession(session.id) })
    const deleted = vi.fn()
    manager.on('session:deleted', deleted)
    const first = manager.deleteSession(session.id)
    expect(nested).toBe(first)
    expect(ports[0].close).toHaveBeenCalledTimes(1)
    ports[0].finishClose()
    await Promise.all([first, nested])
    expect(deleted.mock.calls).toEqual([[session.id]])
    expect(manager.getSession(session.id)).toBeUndefined()
  })

  it('直接并发取消打开中的连接器，原生句柄只关闭一次', async () => {
    const { manager, session } = await fixture(false)
    const connector = new SerialConnector(session.id, session.config.serial!)
    const result = connector.connect().catch(error => error as Error)
    const first = connector.disconnect()
    const second = connector.disconnect()
    ports[0].finishOpen()
    expect(await result).toMatchObject({ message: 'Serial connection cancelled' })
    await vi.waitFor(() => expect(ports[0].close).toHaveBeenCalledTimes(1))
    ports[0].finishClose()
    await Promise.all([first, second])
    expect(ports[0].isOpen).toBe(false)
    expect(connector.isConnected()).toBe(false)
    await manager.deleteSession(session.id)
  })

  it('绑定关闭失败仍保留打开的句柄时，后续断开可以重试关闭', async () => {
    const { manager, session } = await fixture()
    const connector = session.connector!
    const failure = connector.disconnect().catch(error => error as Error)
    ports[0].finishClose(new Error('close failed'))
    expect(await failure).toMatchObject({ message: 'close failed' })
    expect(ports[0].isOpen).toBe(true)
    const retry = connector.disconnect()
    expect(ports[0].close).toHaveBeenCalledTimes(2)
    ports[0].finishClose()
    await retry
    expect(ports[0].isOpen).toBe(false)
    await manager.deleteSession(session.id)
  })

  it('插件回收关闭失败返回错误并保留归属，重复删除共享重试且成功后才移除会话', async () => {
    const { manager, session, release, registry } = await fixture()
    const deleted = vi.fn()
    manager.on('session:deleted', deleted)
    const cleanup = release()
    const result = cleanup.catch(error => error as Error)
    ports[0].finishClose(new Error('close failed'))
    expect(await result).toMatchObject({ message: expect.stringContaining('close failed') })
    expect(manager.getSession(session.id)).toBe(session)
    expect(manager.isSessionDeleting(session.id)).toBe(true)
    expect(registry.owner(session.id)).toBe('a')
    expect(registry.track('a', 'late', 0)).toBe(false)
    expect(deleted).not.toHaveBeenCalled()
    await expect(manager.connectSession(session.id)).rejects.toThrow('Session is being deleted')
    await expect(manager.reconnectSession(session.id)).rejects.toThrow('Session is being deleted')
    const retry = release()
    const first = manager.deleteSession(session.id)
    const second = manager.deleteSession(session.id)
    expect(first).toBe(second)
    expect(ports[0].close).toHaveBeenCalledTimes(2)
    ports[0].finishClose()
    await Promise.all([retry, first, second])
    expect(manager.getSession(session.id)).toBeUndefined()
    expect(manager.isSessionDeleting(session.id)).toBe(false)
    expect(registry.owner(session.id)).toBeUndefined()
    expect(deleted.mock.calls).toEqual([[session.id]])
  })

  it('原生绑定关闭前丢弃 fd 时，后续回收仍报告失败，不把 isOpen=false 当作已释放', async () => {
    const { manager, session, release, registry } = await fixture()
    ports[0].invalidateOnClose = true
    const result = release().catch(error => error as Error)
    ports[0].finishClose(new Error('native close failed'))
    expect(await result).toMatchObject({ message: expect.stringContaining('native close failed') })
    expect(ports[0].isOpen).toBe(false)
    await expect(release()).rejects.toThrow('Serial close could not be confirmed')
    expect(ports[0].close).toHaveBeenCalledTimes(1)
    expect(manager.getSession(session.id)).toBe(session)
    expect(manager.isSessionDeleting(session.id)).toBe(true)
    expect(registry.owner(session.id)).toBe('a')
  })

  it('关闭失败也等待文件清理完成才报告错误，失败后删除可重新发起', async () => {
    const { manager, session } = await fixture()
    let finish!: () => void
    vi.mocked(fileManager.removeConnector).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    let finished = false
    const result = manager.deleteSession(session.id).catch(error => { finished = true; return error as Error })
    ports[0].finishClose(new Error('close failed'))
    await Promise.resolve()
    expect(finished).toBe(false)
    expect(manager.isSessionDeleting(session.id)).toBe(true)
    finish()
    expect(await result).toMatchObject({ message: 'close failed' })
    const retry = manager.deleteSession(session.id)
    ports[0].finishClose()
    await retry
    expect(manager.getSession(session.id)).toBeUndefined()
  })

  it('普通断开失败后禁止直接连接覆盖旧连接器，成功重试后可以正常连接', async () => {
    const { manager, session } = await fixture()
    const connector = session.connector
    const result = manager.disconnectSession(session.id).catch(error => error as Error)
    ports[0].finishClose(new Error('close failed'))
    expect(await result).toMatchObject({ message: 'close failed' })
    await expect(manager.connectSession(session.id)).rejects.toThrow('Previous disconnect failed')
    expect(session.connector).toBe(connector)
    expect(ports).toHaveLength(1)
    const retry = manager.disconnectSession(session.id)
    ports[0].finishClose()
    await retry
    const reconnect = manager.connectSession(session.id)
    await vi.waitFor(() => expect(ports).toHaveLength(2))
    ports[1].finishOpen()
    await reconnect
    const deletion = manager.deleteSession(session.id)
    ports[1].finishClose()
    await deletion
  })

  it('普通断开仍在关闭时直接连接必须等待，关闭失败不能替换旧连接器', async () => {
    const { manager, session } = await fixture()
    const connector = session.connector
    const first = manager.disconnectSession(session.id)
    expect(manager.disconnectSession(session.id)).toBe(first)
    const disconnected = first.catch(error => error as Error)
    const connected = manager.connectSession(session.id).catch(error => error as Error)
    await Promise.resolve()
    expect(ports).toHaveLength(1)
    ports[0].finishClose(new Error('close failed'))
    expect(await disconnected).toMatchObject({ message: 'close failed' })
    expect(await connected).toMatchObject({ message: 'close failed' })
    expect(session.connector).toBe(connector)
    expect(ports).toHaveLength(1)
    const deletion = manager.deleteSession(session.id)
    ports[0].finishClose()
    await deletion
  })

  it('普通断开仍在关闭时直接连接，成功后才创建新连接器', async () => {
    const { manager, session } = await fixture()
    const disconnect = manager.disconnectSession(session.id)
    const connect = manager.connectSession(session.id)
    await Promise.resolve()
    expect(ports).toHaveLength(1)
    ports[0].finishClose()
    await disconnect
    await vi.waitFor(() => expect(ports).toHaveLength(2))
    ports[1].finishOpen()
    await connect
    const deletion = manager.deleteSession(session.id)
    ports[1].finishClose()
    await deletion
  })
})
