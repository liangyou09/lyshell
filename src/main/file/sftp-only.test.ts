import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FileManager } from './manager'

const calls = vi.hoisted(() => ({ getSFTP: vi.fn(), disconnect: vi.fn(), clients: 0 }))
vi.mock('electron-log', () => ({ default: { info() {}, warn() {}, error() {}, debug() {} } }))
vi.mock('./ssh-file-client', async () => {
  const { EventEmitter } = await import('events')
  return { SSHFileClient: class extends EventEmitter {
  constructor() { super(); calls.clients++ }
  getSFTP = calls.getSFTP
  async disconnect() { calls.disconnect(); this.emit('close') }
} } })

beforeEach(() => { calls.getSFTP.mockReset(); calls.disconnect.mockClear(); calls.clients = 0 })
const config = { host: 'fixture', port: 22, username: 'fixture' }

describe('SFTP 文件管理器', () => {
  it('并发命令请求复用同一个持久 shell', async () => {
    const manager = new FileManager()
    manager.setGetSSHConfigFn(async () => ({ ...config, shellEnterCommands: 'enter' }))
    const [first, second] = await Promise.all([manager.getCommandConnector('s'), manager.getCommandConnector('s')])
    expect(first).toBe(second)
    expect(calls.clients).toBe(1)
    await manager.removeConnector('s')
  })
  it('SFTP 拒绝时不创建连接器；下次重试仍请求 SFTP', async () => {
    const manager = new FileManager()
    manager.setGetSSHConfigFn(() => config)
    calls.getSFTP.mockRejectedValue(new Error('subsystem rejected'))
    await expect(manager.getConnector('s')).rejects.toThrow('SFTP 不可用')
    expect(manager.getExistingConnector('s')).toBeUndefined()
    calls.getSFTP.mockResolvedValue({})
    const connector = await manager.getConnector('s')
    expect(connector.getType()).toBe('sftp')
    expect(calls.getSFTP).toHaveBeenCalledTimes(2)
    expect(calls.clients).toBe(1)
  })

  it('断开期间迟到的 SFTP 初始化不能复活连接器', async () => {
    const manager = new FileManager()
    manager.setGetSSHConfigFn(() => config)
    let ready!: () => void
    calls.getSFTP.mockImplementation(() => new Promise<void>(resolve => { ready = resolve }))
    const pending = manager.getConnector('s')
    await vi.waitFor(() => expect(ready).toBeTypeOf('function'))
    await manager.removeConnector('s')
    ready()
    await expect(pending).rejects.toThrow('disconnected')
    expect(manager.getExistingConnector('s')).toBeUndefined()
    expect(calls.disconnect).toHaveBeenCalledTimes(1)
  })

  it('断开期间迟到的配置读取不再创建 SSH 客户端', async () => {
    const manager = new FileManager()
    let ready!: (value: typeof config) => void
    manager.setGetSSHConfigFn(() => new Promise(resolve => { ready = resolve }))
    const pending = manager.getConnector('s')
    await manager.removeConnector('s')
    ready(config)
    await expect(pending).rejects.toThrow('disconnected')
    expect(calls.clients).toBe(0)
  })
})
