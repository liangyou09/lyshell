import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectTransferSSH } from './ssh-transfer-connection'

const { ClientMock } = vi.hoisted(() => ({ ClientMock: vi.fn() }))
vi.mock('ssh2', () => ({ Client: ClientMock }))

const config = { host: 'server', port: 22, username: 'user', password: 'test-secret' }
const timeoutError = () => Object.assign(new Error('Timed out while waiting for handshake'), { level: 'client-timeout' })
const makeClient = () => Object.assign(new EventEmitter(), { connect: vi.fn(), destroy: vi.fn() })

beforeEach(() => {
  vi.useFakeTimers()
  ClientMock.mockReset()
})
afterEach(() => { vi.useRealTimers() })

describe('connectTransferSSH', () => {
  it('首次成功就返回连接，认证参数正确传递但不记录凭据', async () => {
    const client = makeClient()
    const log = vi.fn()
    ClientMock.mockReturnValue(client)
    client.connect.mockImplementation(() => client.emit('ready'))
    expect(await connectTransferSSH(config, log)).toBe(client)
    expect(ClientMock).toHaveBeenCalledOnce()
    expect(client.connect).toHaveBeenCalledWith(expect.objectContaining({ ...config, readyTimeout: 30000 }))
    expect(log.mock.calls.flat().join(' ')).not.toContain(config.password)
    expect(client.destroy).not.toHaveBeenCalled()
  })

  it('握手超时先销毁旧连接再重试，无显式配置时第二次限时 60 秒', async () => {
    const first = makeClient()
    const second = makeClient()
    ClientMock.mockReturnValueOnce(first).mockReturnValueOnce(second)
    first.connect.mockImplementation(() => first.emit('error', timeoutError()))
    second.connect.mockImplementation(() => second.emit('ready'))
    const connecting = connectTransferSSH(config, vi.fn())
    await vi.advanceTimersByTimeAsync(999)
    expect(ClientMock).toHaveBeenCalledOnce()
    expect(first.destroy).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(await connecting).toBe(second)
    expect(second.connect).toHaveBeenCalledWith(expect.objectContaining({ readyTimeout: 60000 }))
  })

  it('显式超时与私钥口令两次都保持原值', async () => {
    const first = makeClient()
    const second = makeClient()
    ClientMock.mockReturnValueOnce(first).mockReturnValueOnce(second)
    first.connect.mockImplementation(() => first.emit('error', timeoutError()))
    second.connect.mockImplementation(() => second.emit('ready'))
    const keyConfig = { host: 'server', port: 22, username: 'user', privateKey: 'test-key', passphrase: 'test-phrase', readyTimeout: 120000 }
    const connecting = connectTransferSSH(keyConfig, vi.fn())
    await vi.advanceTimersByTimeAsync(1000)
    await connecting
    for (const client of [first, second]) {
      expect(client.connect).toHaveBeenCalledWith(expect.objectContaining({ readyTimeout: 120000, privateKey: 'test-key', passphrase: 'test-phrase' }))
    }
  })

  it('认证拒绝不重试', async () => {
    const client = makeClient()
    ClientMock.mockReturnValue(client)
    client.connect.mockImplementation(() => client.emit('error', Object.assign(new Error('All configured authentication methods failed'), { level: 'client-authentication' })))
    await expect(connectTransferSSH(config, vi.fn())).rejects.toThrow('All configured authentication methods failed')
    expect(ClientMock).toHaveBeenCalledOnce()
    expect(client.destroy).toHaveBeenCalledOnce()
  })

  it('显式禁用握手超时与保活时，两次连接都保留零值', async () => {
    const first = makeClient()
    const second = makeClient()
    ClientMock.mockReturnValueOnce(first).mockReturnValueOnce(second)
    first.connect.mockImplementation(() => first.emit('error', Object.assign(new Error('reset'), { code: 'ECONNRESET' })))
    second.connect.mockImplementation(() => second.emit('ready'))
    const connecting = connectTransferSSH({ ...config, readyTimeout: 0, keepaliveInterval: 0 }, vi.fn())
    await vi.advanceTimersByTimeAsync(1000)
    expect(await connecting).toBe(second)
    for (const client of [first, second]) {
      expect(client.connect).toHaveBeenCalledWith(expect.objectContaining({ readyTimeout: 0, keepaliveInterval: 0 }))
    }
  })

  it('二次超时终止并报告认证阶段，不无限重试或保留旧 socket', async () => {
    const first = makeClient()
    const second = makeClient()
    ClientMock.mockReturnValueOnce(first).mockReturnValueOnce(second)
    for (const client of [first, second]) {
      client.connect.mockImplementation(() => {
        client.emit('handshake')
        client.emit('error', timeoutError())
      })
    }
    const result = expect(connectTransferSSH(config, vi.fn())).rejects.toThrow('stage: authentication')
    await vi.advanceTimersByTimeAsync(1000)
    await result
    expect(ClientMock).toHaveBeenCalledTimes(2)
    expect(first.destroy).toHaveBeenCalledOnce()
    expect(second.destroy).toHaveBeenCalledOnce()
  })

  it('认证前连接关闭可重试，成功后连接错误不触发再次认证', async () => {
    const first = makeClient()
    const second = makeClient()
    ClientMock.mockReturnValueOnce(first).mockReturnValueOnce(second)
    first.connect.mockImplementation(() => first.emit('close'))
    second.connect.mockImplementation(() => second.emit('ready'))
    const connecting = connectTransferSSH(config, vi.fn())
    await vi.advanceTimersByTimeAsync(1000)
    expect(await connecting).toBe(second)
    second.emit('error', timeoutError())
    await vi.advanceTimersByTimeAsync(1000)
    expect(ClientMock).toHaveBeenCalledTimes(2)
    expect(second.destroy).not.toHaveBeenCalled()
  })

  it('算法协商错误不重试', async () => {
    const client = makeClient()
    ClientMock.mockReturnValue(client)
    client.connect.mockImplementation(() => client.emit('error', Object.assign(new Error('Handshake failed: no matching cipher'), { level: 'handshake' })))
    await expect(connectTransferSSH(config, vi.fn())).rejects.toThrow('no matching cipher')
    expect(ClientMock).toHaveBeenCalledOnce()
  })

  it('同步配置错误不重试', async () => {
    const client = makeClient()
    ClientMock.mockReturnValue(client)
    client.connect.mockImplementation(() => { throw new Error('Invalid private key') })
    await expect(connectTransferSSH(config, vi.fn())).rejects.toThrow('Invalid private key')
    expect(ClientMock).toHaveBeenCalledOnce()
  })
})
