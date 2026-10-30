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
    constructor(_id: string, readonly receivedConfig?: Record<string, unknown>) { super() }
    async connect() {}
    disconnect = vi.fn(async () => {})
    write = vi.fn()
    async writeConfirmed(data: string) { this.write(data) }
    async setInputControl() {}
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
  it('大输入逐块确认并重验授权；交接后停止旧粘贴和旧排队输入，不重放', async () => {
    const { manager, session } = await fixture()
    await manager.connectSession(session.id)
    manager.inputControl.setCredentialValidator(() => true)
    const first = await manager.acquireInput(session.id, { principalId: 'gui:1', source: 'gui' })
    let acknowledge!: () => void
    const write = vi.spyOn(session.connector!, 'writeConfirmed').mockImplementation(async () => {
      await new Promise<void>(resolve => { acknowledge = resolve })
    })
    const paste = manager.writeToSession(session.id, 'a'.repeat(96 * 1024), first)
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce())
    const queued = manager.writeToSession(session.id, 'OLD', first)
    // 先挂 rejection 处理，避免测试把预期拒绝当作未处理异常。
    const outcomes = Promise.allSettled([paste, queued])
    await manager.acquireInput(session.id, { principalId: 'gui:2', source: 'gui' }, { takeover: true })
    acknowledge()
    const results = await outcomes
    expect(results).toMatchObject([{ status: 'rejected', reason: { code: 'OUTCOME_UNKNOWN' } },
      { status: 'rejected', reason: { code: 'STALE_GENERATION' } }])
    expect(write).toHaveBeenCalledOnce()
    expect(write.mock.calls[0][0]).toHaveLength(32 * 1024)
  })
  it.each([true, false])('本地宿主确认退出=%s，只有确认后才清除运行引用供普通重连', async exited => {
    const { manager, session } = await fixture()
    session.config.type = ConnectionType.LOCAL
    const hostId = 'cb307d5f-eb03-4273-a658-c15da4b55937'
    session.config.local = { terminalHostId: hostId }
    await manager.connectSession(session.id)
    Object.assign(session.connector!, { localHostId: hostId, localHostHasExited: exited })
    await manager.disconnectSession(session.id)
    expect(session.config.local.terminalHostId).toBe(exited ? undefined : hostId)
    await manager.connectSession(session.id)
    expect((session.connector as unknown as { receivedConfig: object }).receivedConfig).toMatchObject(exited ? {} : { terminalHostId: hostId })
    if (exited) expect((session.connector as unknown as { receivedConfig: Record<string, unknown> }).receivedConfig.terminalHostId).toBeUndefined()
  })
  it('SSH 已保存历史出现在恢复终端的显示流和迟到订阅缓冲里，排在新输出前且不发送到远端', async () => {
    const { manager, session } = await fixture()
    session.config.type = ConnectionType.SSH
    session.config.ssh = { host: 'fixture', port: 22, username: 'test' }
    const displayed: string[] = []
    manager.on('terminal:data', ({ sessionId, data }) => { if (sessionId === session.id) displayed.push(data) })
    manager.retainSshContext(session.id, true, 'saved history\nsecond line\u001b]52;c;secret\u0007')
    await manager.connectSession(session.id)
    session.connector!.emit('data', 'new login prompt\r\n')
    const initial = session.outputBuffer!.getOutputSince(0, false).text
    expect(initial).toContain('saved history\r\nsecond line')
    expect(initial.indexOf('saved history')).toBeLessThan(initial.indexOf('new login prompt'))
    expect(displayed.join('')).toBe(initial)
    expect(initial).not.toContain('52;c;secret')
    expect(session.connector!.write).not.toHaveBeenCalled()
  })
  it('只有 SSH 收纳后持有上下文尾部，断开清理仍保留末段输出和 OSC 目录', async () => {
    const { manager, session } = await fixture()
    session.config.type = ConnectionType.SSH
    session.config.ssh = { host: 'fixture', port: 22, username: 'test' }
    session.config.ssh.keepSessionAlive = true
    session.config.ssh.resumeSessionName = 'lyshell-legacy'
    await manager.connectSession(session.id)
    expect((session.connector as unknown as { receivedConfig: object }).receivedConfig).toMatchObject({ keepSessionAlive: false, resumeSessionName: undefined })
    session.connector!.emit('data', 'before collect\n')
    expect(session.shelfOutputBuffer).toBeUndefined()
    manager.retainSshContext(session.id, true)
    session.connector!.emit('data', '\u001b]7;file://fixture/srv/project\u0007last output\n')
    expect(session.cwd).toBe('/srv/project')
    await manager.disconnectSession(session.id)
    expect(session.outputBuffer).toBeUndefined()
    expect(session.shelfOutputBuffer?.getOutputSince(0).text).toContain('last output')
    manager.retainSshContext(session.id, false)
    expect(session.shelfOutputBuffer).toBeUndefined()
    const telnet = await manager.createSession({ ...session.config, id: 'telnet-unchanged', type: ConnectionType.TELNET, telnet: { host: 'device', port: 23 } })
    manager.retainSshContext(telnet.id, true)
    expect(telnet.shelfOutputBuffer).toBeUndefined()
  })
  it('本地新宿主仍发送首次启动命令，原宿主附着不重放命令', async () => {
    vi.useFakeTimers()
    const { manager, session } = await fixture()
    session.config.type = ConnectionType.LOCAL
    session.config.local = {}
    session.config.startupCommands = ['echo first-launch']
    const connecting = manager.connectSession(session.id)
    await vi.advanceTimersByTimeAsync(250)
    await connecting
    expect(session.connector!.write).toHaveBeenCalledWith('echo first-launch\r')
    await manager.disconnectSession(session.id)
    session.config.local.terminalHostId = 'cb307d5f-eb03-4273-a658-c15da4b55937'
    await manager.connectSession(session.id)
    await vi.advanceTimersByTimeAsync(250)
    expect(session.connector!.write).not.toHaveBeenCalled()
  })
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
