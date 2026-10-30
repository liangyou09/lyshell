import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectTransferSSH } from './ssh-transfer-connection'

const { ClientMock } = vi.hoisted(() => ({ ClientMock: vi.fn() }))
vi.mock('ssh2', () => ({ Client: ClientMock }))

const config = { host: 'server', port: 22, username: 'user', password: 'test-secret' }
/** 固定指纹：Worker 只做固定匹配，不读盘也不采信请求自报值 */
const hostKey = { endpoint: 'server:22', fingerprint: `SHA256:${'A'.repeat(43)}` }
const timeoutError = () => Object.assign(new Error('Timed out while waiting for handshake'), { level: 'client-timeout' })
const makeClient = () => Object.assign(new EventEmitter(), { connect: vi.fn(), destroy: vi.fn() })

/** 最小的 SSH wire-format 公钥 blob（算法名 + 任意密钥字节） */
const rawHostKey = () => {
  const algorithm = Buffer.from('ssh-ed25519')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(algorithm.length, 0)
  return Buffer.concat([length, algorithm, Buffer.from('host-key-material')])
}

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
    expect(await connectTransferSSH(config, log, hostKey)).toBe(client)
    expect(ClientMock).toHaveBeenCalledOnce()
    expect(client.connect).toHaveBeenCalledWith(expect.objectContaining({ ...config, readyTimeout: 30000, hostVerifier: expect.any(Function) }))
    expect(log.mock.calls.flat().join(' ')).not.toContain(config.password)
    expect(client.destroy).not.toHaveBeenCalled()
  })

  it('缺少可信指纹时不建 TCP、不开 Client（fail closed）', async () => {
    await expect(
      // @ts-expect-error 故意模拟调用方漏传（运行期也必须拒绝）
      connectTransferSSH(config, vi.fn())
    ).rejects.toMatchObject({ code: 'SSH_HOST_KEY_UNAVAILABLE' })
    expect(ClientMock).not.toHaveBeenCalled()
  })

  it('注入的 endpoint 与连接目标不一致时拒绝', async () => {
    await expect(
      connectTransferSSH(config, vi.fn(), { endpoint: 'other:22', fingerprint: hostKey.fingerprint })
    ).rejects.toMatchObject({ code: 'SSH_HOST_KEY_INVALID' })
    expect(ClientMock).not.toHaveBeenCalled()
  })

  it('主机密钥不匹配直接拒绝，且不当作临时网络故障重试', async () => {
    const client = makeClient()
    ClientMock.mockReturnValue(client)
    let permitted: boolean | undefined
    client.connect.mockImplementation((connectionConfig: { hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => void }) => {
      connectionConfig.hostVerifier(rawHostKey(), (ok) => {
        permitted = ok
        if (!ok) client.emit('error', Object.assign(new Error('Host denied (verification failed)'), { level: 'handshake' }))
      })
    })
    const connecting = connectTransferSSH(config, vi.fn(), hostKey)
    connecting.catch(() => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(permitted).toBe(false)
    await expect(connecting).rejects.toThrow('SSH 主机密钥与可信记录不一致')
    expect(ClientMock).toHaveBeenCalledOnce()
    expect(client.destroy).toHaveBeenCalledOnce()
  })

  it('指纹一致时 hostVerifier 放行握手', async () => {
    const client = makeClient()
    ClientMock.mockReturnValue(client)
    const raw = rawHostKey()
    const { computeSshHostKeyFingerprint } = await import('../security/ssh-host-key')
    const pinned = { endpoint: 'server:22', fingerprint: computeSshHostKeyFingerprint(raw) }
    let permitted: boolean | undefined
    client.connect.mockImplementation((connectionConfig: { hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => void }) => {
      connectionConfig.hostVerifier(raw, (ok) => { permitted = ok })
    })
    const connecting = connectTransferSSH(config, vi.fn(), pinned)
    await vi.advanceTimersByTimeAsync(0)
    expect(permitted).toBe(true)
    client.emit('ready')
    expect(await connecting).toBe(client)
  })

  it('握手超时先销毁旧连接再重试，无显式配置时第二次限时 60 秒', async () => {
    const first = makeClient()
    const second = makeClient()
    ClientMock.mockReturnValueOnce(first).mockReturnValueOnce(second)
    first.connect.mockImplementation(() => first.emit('error', timeoutError()))
    second.connect.mockImplementation(() => second.emit('ready'))
    const connecting = connectTransferSSH(config, vi.fn(), hostKey)
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
    const connecting = connectTransferSSH(keyConfig, vi.fn(), hostKey)
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
    await expect(connectTransferSSH(config, vi.fn(), hostKey)).rejects.toThrow('All configured authentication methods failed')
    expect(ClientMock).toHaveBeenCalledOnce()
    expect(client.destroy).toHaveBeenCalledOnce()
  })

  it('显式禁用握手超时与保活时，两次连接都保留零值', async () => {
    const first = makeClient()
    const second = makeClient()
    ClientMock.mockReturnValueOnce(first).mockReturnValueOnce(second)
    first.connect.mockImplementation(() => first.emit('error', Object.assign(new Error('reset'), { code: 'ECONNRESET' })))
    second.connect.mockImplementation(() => second.emit('ready'))
    const connecting = connectTransferSSH({ ...config, readyTimeout: 0, keepaliveInterval: 0 }, vi.fn(), hostKey)
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
    const result = expect(connectTransferSSH(config, vi.fn(), hostKey)).rejects.toThrow('stage: authentication')
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
    const connecting = connectTransferSSH(config, vi.fn(), hostKey)
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
    await expect(connectTransferSSH(config, vi.fn(), hostKey)).rejects.toThrow('no matching cipher')
    expect(ClientMock).toHaveBeenCalledOnce()
  })

  it('同步配置错误不重试', async () => {
    const client = makeClient()
    ClientMock.mockReturnValue(client)
    client.connect.mockImplementation(() => { throw new Error('Invalid private key') })
    await expect(connectTransferSSH(config, vi.fn(), hostKey)).rejects.toThrow('Invalid private key')
    expect(ClientMock).toHaveBeenCalledOnce()
  })
})
