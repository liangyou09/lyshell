import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionConfig } from '@shared/types'
import { ConnectionStatus, ConnectionType } from '@shared/types'

vi.mock('electron', () => ({ app: {} }))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@main/file', () => ({ fileManager: { removeConnector: vi.fn(async () => {}) }, cancelDownloadsBySession: vi.fn(), cancelUploadsBySession: vi.fn() }))
vi.mock('@main/mcp/auth', () => ({ bindSessionToken: vi.fn(() => 'test-token'), revokeSessionToken: vi.fn() }))
vi.mock('@main/mcp/http-port', () => ({ getMcpHttpPort: () => 12345 }))
vi.mock('../connectors', async () => {
  const { EventEmitter } = await import('events')
  class Connector extends EventEmitter {
    async connect() {}
    disconnect = vi.fn(async () => {})
    write = vi.fn()
    resize = vi.fn()
    getSpawnCwd() { return null }
  }
  return { SSHConnector: Connector, TelnetConnector: Connector, SerialConnector: Connector, LocalConnector: Connector,
    ConnectionStatus: { CONNECTED: 'connected', CONNECTING: 'connecting', DISCONNECTED: 'disconnected', ERROR: 'error' },
    ConnectionType: { SSH: 'ssh', TELNET: 'telnet', SERIAL: 'serial', LOCAL: 'local' } }
})
import { SessionManager } from './session-manager'
import { TelnetConnector } from '../connectors'
import { bindSessionToken, revokeSessionToken } from '@main/mcp/auth'
import { OutputBuffer } from './output-buffer'

const managers: SessionManager[] = []
async function fixture() {
  const manager = new SessionManager()
  managers.push(manager)
  const session = await manager.createSession({
    id: 'failure-case', name: 'Test', type: ConnectionType.TELNET, telnet: { host: 'localhost', port: 23 },
    terminal: {} as SessionConfig['terminal'], tags: [], createdAt: new Date(), updatedAt: new Date()
  })
  return { manager, session }
}
beforeEach(() => { vi.clearAllMocks() })
afterEach(async () => {
  vi.restoreAllMocks()
  for (const manager of managers.splice(0)) for (const session of manager.getAllSessions()) await manager.deleteSession(session.id)
  vi.useRealTimers()
})

describe('会话失败资源清理', () => {
  it('本地 PTY 启动失败后撤销刚签发的会话 token', async () => {
    const { manager, session } = await fixture()
    session.config.type = ConnectionType.LOCAL
    session.config.local = {}
    vi.spyOn(TelnetConnector.prototype, 'connect').mockRejectedValueOnce(new Error('PTY spawn failed'))
    await expect(manager.connectSession(session.id)).rejects.toThrow('PTY spawn failed')
    expect(bindSessionToken).toHaveBeenCalledWith(session.id)
    expect(revokeSessionToken).toHaveBeenCalledWith(session.id)
    expect(session.connector!.disconnect).toHaveBeenCalledOnce()
    expect(session.status).toBe(ConnectionStatus.ERROR)
    expect(session.outputBuffer).toBeUndefined()
  })

  it('连接失败主动断开 connector、撤销凭据并保留错误状态，无延迟保活定时器', async () => {
    vi.useFakeTimers()
    const { manager, session } = await fixture()
    vi.spyOn(TelnetConnector.prototype, 'connect').mockRejectedValueOnce(new Error('spawn failed'))
    await expect(manager.connectSession(session.id)).rejects.toThrow('spawn failed')
    expect(session.connector!.disconnect).toHaveBeenCalledOnce()
    expect(revokeSessionToken).toHaveBeenCalledWith(session.id)
    expect(session.status).toBe(ConnectionStatus.ERROR)
    expect(session.outputBuffer).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('无等待者时立即释放缓冲；活跃等待者的捕获缓冲保留到自身结束', async () => {
    vi.useFakeTimers()
    const { manager, session } = await fixture()
    const buffer = new OutputBuffer()
    buffer.append('captured output')
    session.outputBuffer = buffer
    session.pendingWaitLock = true
    await manager.disconnectSession(session.id)
    expect(session.outputBuffer).toBeUndefined()
    expect(buffer.getOutputSince(0, false).text).toBe('captured output')
    expect(vi.getTimerCount()).toBe(0)
    session.pendingWaitLock = false

    const inactive = new OutputBuffer()
    inactive.append('not captured')
    const second = await manager.createSession({ ...session.config, id: 'inactive-case' })
    second.outputBuffer = inactive
    await manager.disconnectSession(second.id)
    expect(inactive.size()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
