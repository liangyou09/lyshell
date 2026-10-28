import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalConnector } from './local'
import { LocalHostClient } from '../terminal/local-host-client'

vi.mock('node-pty', () => ({ spawn: vi.fn() }))
vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => true } }))
vi.mock('electron-log', () => ({ default: { info() {}, warn() {}, debug() {} } }))
vi.mock('../env/refresh', () => ({ readSystemPath: async () => null }))
vi.mock('../terminal/local-host-client', () => ({ LocalHostClient: { create: vi.fn(), attach: vi.fn() } }))

function makeHost() {
  return Object.assign(new EventEmitter(), {
    id: 'cb307d5f-eb03-4273-a658-c15da4b55937',
    status: vi.fn().mockResolvedValue({ running: true, retained: false }),
    retain: vi.fn().mockResolvedValue(undefined), detach: vi.fn().mockResolvedValue(undefined),
    terminate: vi.fn().mockResolvedValue(undefined), write: vi.fn(), resize: vi.fn(), pause: vi.fn(), resume: vi.fn()
  })
}
beforeEach(() => { vi.clearAllMocks() })
describe('本地连接器与常驻宿主', () => {
  it.each(['create', 'attach'] as const)('%s 等待期间变化的终端尺寸必须在就绪后补发', async method => {
    const host = makeHost()
    let resolve!: (value: LocalHostClient) => void
    vi.mocked(LocalHostClient[method]).mockReturnValue(new Promise(done => { resolve = done }))
    const connector = new LocalConnector('t', method === 'attach' ? { terminalHostId: host.id } : {}, {}, { userDataDir: 'C:/qa' })
    const connecting = connector.connect()
    await vi.waitFor(() => expect(LocalHostClient[method]).toHaveBeenCalled())
    connector.resize(146, 37)
    resolve(host as unknown as LocalHostClient)
    await connecting
    expect(host.resize).toHaveBeenCalledWith(146, 37)
    connector.resize(146, 37)
    expect(host.resize).toHaveBeenCalledTimes(1)
  })
  it('应用退出时收纳和普通终端都结束原进程，先撤销保活', async () => {
    const host = makeHost()
    vi.mocked(LocalHostClient.create).mockResolvedValue(host as unknown as LocalHostClient)
    const connector = new LocalConnector('t', {}, {}, { userDataDir: 'C:/qa' })
    await connector.connect()
    await connector.retainForShelf(true)
    expect(host.retain).toHaveBeenCalledWith(true)
    await connector.disconnectForQuit()
    expect(host.retain).toHaveBeenLastCalledWith(false)
    expect(host.retain.mock.invocationCallOrder.at(-1)!).toBeLessThan(host.terminate.mock.invocationCallOrder[0])
    expect(host.detach).not.toHaveBeenCalled()
    expect(host.terminate).toHaveBeenCalledTimes(1)
    const another = new LocalConnector('u', {}, {}, { userDataDir: 'C:/qa' })
    await another.connect(); await another.disconnectForQuit()
    expect(host.terminate).toHaveBeenCalledTimes(2)
  })
  it('撤销保活失败仍尝试终止，终止失败不能声称已结束', async () => {
    const host = makeHost()
    vi.mocked(LocalHostClient.create).mockResolvedValue(host as unknown as LocalHostClient)
    const connector = new LocalConnector('t', {}, {}, { userDataDir: 'C:/qa' })
    await connector.connect()
    host.retain.mockRejectedValue(new Error('retention unknown'))
    host.terminate.mockRejectedValue(new Error('termination unknown'))
    await expect(connector.disconnectForQuit()).rejects.toThrow('termination unknown')
    expect(host.terminate).toHaveBeenCalledOnce()
    expect(connector.localHostHasExited).toBe(false)
  })
  it('新宿主 ID 不反写传入配置，避免首次启动命令被误判为恢复而跳过', async () => {
    const host = makeHost(), config = { cwd: 'C:/qa' }
    vi.mocked(LocalHostClient.create).mockResolvedValue(host as unknown as LocalHostClient)
    const connector = new LocalConnector('t', config, {}, { userDataDir: 'C:/qa' })
    await connector.connect()
    expect(config).toEqual({ cwd: 'C:/qa' })
    expect(connector.localHostId).toBe(host.id)
  })
  it('取消尚未完成的附着不终止原进程', async () => {
    const host = makeHost()
    let resolve!: (value: LocalHostClient) => void
    vi.mocked(LocalHostClient.attach).mockReturnValue(new Promise(done => { resolve = done }))
    const connector = new LocalConnector('t', { terminalHostId: host.id }, {}, { userDataDir: 'C:/qa' })
    const connecting = connector.connect()
    await vi.waitFor(() => expect(LocalHostClient.attach).toHaveBeenCalled())
    await connector.disconnect()
    resolve(host as unknown as LocalHostClient)
    await expect(connecting).rejects.toThrow('cancelled')
    expect(host.detach).toHaveBeenCalledTimes(1)
    expect(host.terminate).not.toHaveBeenCalled()
  })
  it('宿主状态读取失败解除附着，不误报连接成功', async () => {
    const host = makeHost(); host.status.mockRejectedValue(new Error('unknown'))
    vi.mocked(LocalHostClient.attach).mockResolvedValue(host as unknown as LocalHostClient)
    const connector = new LocalConnector('t', { terminalHostId: host.id }, {}, { userDataDir: 'C:/qa' })
    await expect(connector.connect()).rejects.toThrow('unknown')
    expect(host.detach).toHaveBeenCalledTimes(1)
    expect(host.terminate).not.toHaveBeenCalled()
    expect(connector.isConnected()).toBe(false)
  })
  it('原进程已退出时拒绝把空终端当成续接', async () => {
    const host = makeHost(); host.status.mockResolvedValue({ running: false, retained: true })
    vi.mocked(LocalHostClient.attach).mockResolvedValue(host as unknown as LocalHostClient)
    const connector = new LocalConnector('t', { terminalHostId: host.id }, {}, { userDataDir: 'C:/qa' })
    await expect(connector.connect()).rejects.toThrow('已经结束')
    expect(LocalHostClient.create).not.toHaveBeenCalled()
    expect(connector.localHostHasExited).toBe(true)
  })
  it('只有真实退出或成功终止才确认宿主结束，断链与终止失败保持未知', async () => {
    const host = makeHost()
    vi.mocked(LocalHostClient.create).mockResolvedValue(host as unknown as LocalHostClient)
    const connector = new LocalConnector('t', {}, {}, { userDataDir: 'C:/qa' })
    await connector.connect()
    host.terminate.mockRejectedValueOnce(new Error('unknown'))
    await expect(connector.disconnect()).rejects.toThrow('unknown')
    expect(connector.localHostHasExited).toBe(false)
    await connector.disconnect()
    expect(connector.localHostHasExited).toBe(true)
    const another = new LocalConnector('u', {}, {}, { userDataDir: 'C:/qa' })
    await another.connect()
    host.emit('disconnect')
    expect(another.localHostHasExited).toBe(false)
  })
})
