import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SSHConfig } from '@shared/types'
import { SSHFileClient } from './ssh-file-client'

/**
 * R02 资源测试：单在途连接 / 断开取消等待 / 代次与实例校验 / 单在途 SFTP / 迟到事件隔离。
 * 全部使用 mock ssh2 transport，不做任何真实网络操作。
 */

const ssh2Mock = vi.hoisted(() => ({ ClientMock: vi.fn() }))

vi.mock('ssh2', () => ({ Client: ssh2Mock.ClientMock }))
vi.mock('electron-log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const CONNECTION_CLOSED = 'SSH file connection closed'

interface MockClient extends EventEmitter {
  connect: ReturnType<typeof vi.fn>
  // 其余方法只用于调用次数断言，放宽签名避免与 vi.fn 的返回类型冲突
  end: (...args: any[]) => any
  destroy: (...args: any[]) => any
  sftp: (...args: any[]) => any
  sftpCallbacks: Array<(err: Error | undefined, sftp: unknown) => void>
}

const config = {
  host: 'mock-host',
  port: 22,
  username: 'mock-user',
  password: 'mock-password',
} as SSHConfig

/** 每次 getClient 拆包前的微任务冲刷（不依赖真实计时器） */
const flush = async (times = 6): Promise<void> => {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

describe('SSHFileClient resource limits', () => {
  let created: MockClient[]

  const createClient = (): MockClient => {
    const client = new EventEmitter() as unknown as MockClient
    client.connect = vi.fn()
    client.end = vi.fn(() => {
      client.emit('close')
    })
    client.destroy = vi.fn()
    client.sftpCallbacks = []
    client.sftp = vi.fn((cb: (err: Error | undefined, sftp: unknown) => void) => {
      client.sftpCallbacks.push(cb)
    })
    return client
  }

  beforeEach(() => {
    vi.useFakeTimers()
    created = []
    ssh2Mock.ClientMock.mockReset()
    ssh2Mock.ClientMock.mockImplementation(() => {
      const client = createClient()
      created.push(client)
      return client
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('40 个并发 getClient 只建立一个 transport', async () => {
    const fileClient = new SSHFileClient('s1', config)
    const waiters = Array.from({ length: 40 }, () => fileClient.getClient())

    expect(ssh2Mock.ClientMock).toHaveBeenCalledTimes(1)
    expect(created[0].connect).toHaveBeenCalledTimes(1)

    created[0].emit('ready')
    const clients = await Promise.all(waiters)

    expect(clients.every(client => client === created[0])).toBe(true)
    expect(fileClient.isConnected()).toBe(true)
  })

  it('两个请求等待连接时 disconnect：全部拒绝、没有第二个 transport、close 只发一次', async () => {
    const fileClient = new SSHFileClient('s1', config)
    const closes = vi.fn()
    fileClient.on('close', closes)

    const first = fileClient.getClient().then(
      () => ({ ok: true as const }),
      error => ({ ok: false as const, error }),
    )
    const second = fileClient.getClient().then(
      () => ({ ok: true as const }),
      error => ({ ok: false as const, error }),
    )

    await fileClient.disconnect()

    const results = await Promise.all([first, second])
    expect(results.every(result => !result.ok)).toBe(true)
    for (const result of results) {
      expect(result.ok ? null : result.error.message).toBe(CONNECTION_CLOSED)
    }
    expect(created).toHaveLength(1)
    expect(created[0].end).toHaveBeenCalledTimes(1)
    expect(closes).toHaveBeenCalledTimes(1)

    // 迟到的 close 不应再触发一次
    created[0].emit('close')
    await vi.advanceTimersByTimeAsync(2000)
    expect(created).toHaveLength(1)
    expect(closes).toHaveBeenCalledTimes(1)
    expect(fileClient.isConnected()).toBe(false)
  })

  it('手动 disconnect 后新请求会重新连接（旧对象不复活）', async () => {
    const fileClient = new SSHFileClient('s1', config)
    const waiting = fileClient.getClient().catch(() => null)
    await fileClient.disconnect()
    await waiting

    const reconnected = fileClient.getClient()
    expect(ssh2Mock.ClientMock).toHaveBeenCalledTimes(2)
    const next = created[1]
    next.emit('ready')

    await expect(reconnected).resolves.toBe(next)
    expect(fileClient.isConnected()).toBe(true)
    expect(created[0].connect).toHaveBeenCalledTimes(1)
  })

  it('旧连接的迟到 ready/close/error 不污染新连接', async () => {
    const fileClient = new SSHFileClient('s1', config)
    const closes = vi.fn()
    fileClient.on('close', closes)

    const oldWaiter = fileClient.getClient().then(
      () => ({ ok: true as const }),
      error => ({ ok: false as const, error }),
    )
    await fileClient.disconnect()
    expect((await oldWaiter).ok).toBe(false)

    let resolved = false
    const newWaiter = fileClient.getClient().then(client => {
      resolved = true
      return client
    })
    expect(created).toHaveLength(2)
    const next = created[1]

    // 旧 client 的迟到事件：不得把新 waiter 结束掉，也不得改动状态
    created[0].emit('ready')
    await flush()
    expect(resolved).toBe(false)
    expect(fileClient.isConnected()).toBe(false)

    created[0].emit('close')
    created[0].emit('error', new Error('late error'))
    await flush()
    expect(resolved).toBe(false)
    expect(fileClient.isConnected()).toBe(false)
    expect(closes).toHaveBeenCalledTimes(1)

    // 只有当前 client 的 ready 才生效
    next.emit('ready')
    await expect(newWaiter).resolves.toBe(next)
    expect(fileClient.isConnected()).toBe(true)
  })

  it('连接 error 会拒绝全部等待者、只发一次 close，并销毁 transport', async () => {
    const fileClient = new SSHFileClient('s1', config)
    const closes = vi.fn()
    fileClient.on('close', closes)

    const first = fileClient.getClient().then(
      () => ({ ok: true as const }),
      error => ({ ok: false as const, error }),
    )
    const second = fileClient.getClient().then(
      () => ({ ok: true as const }),
      error => ({ ok: false as const, error }),
    )

    const failure = new Error('auth failed')
    created[0].emit('error', failure)

    const results = await Promise.all([first, second])
    expect(results.every(result => !result.ok)).toBe(true)
    for (const result of results) {
      expect(result.ok ? null : result.error).toBe(failure)
    }
    expect(created[0].destroy).toHaveBeenCalledTimes(1)
    expect(closes).toHaveBeenCalledTimes(1)
    expect(fileClient.isConnected()).toBe(false)

    // error 之后迟到的 close 不应该产生第二次回执
    created[0].emit('close')
    await flush()
    expect(closes).toHaveBeenCalledTimes(1)

    // 后续请求仍能建立新连接
    const retry = fileClient.getClient()
    expect(ssh2Mock.ClientMock).toHaveBeenCalledTimes(2)
    created[1].emit('ready')
    await expect(retry).resolves.toBe(created[1])
  })

  it('同步 connect 抛错同样结束等待者，不留下悬挂 Promise', async () => {
    const fileClient = new SSHFileClient('s1', config)
    // 替换本次 connect 行为
    ssh2Mock.ClientMock.mockImplementationOnce(() => {
      const client = createClient()
      client.connect.mockImplementation(() => {
        throw new Error('sync connect failure')
      })
      created.push(client)
      return client
    })

    await expect(fileClient.getClient()).rejects.toThrow('sync connect failure')
    expect(fileClient.isConnected()).toBe(false)

    const retry = fileClient.getClient()
    expect(ssh2Mock.ClientMock).toHaveBeenCalledTimes(2)
    created[1].emit('ready')
    await expect(retry).resolves.toBe(created[1])
  })

  it('并发 getSFTP 只初始化一次，并复用同一 wrapper', async () => {
    const fileClient = new SSHFileClient('s1', config)
    const first = fileClient.getSFTP()
    const second = fileClient.getSFTP()

    created[0].emit('ready')
    await flush()

    expect(created[0].sftp).toHaveBeenCalledTimes(1)
    const wrapper = new EventEmitter()
    created[0].sftpCallbacks[0](undefined, wrapper)

    await expect(Promise.all([first, second])).resolves.toEqual([wrapper, wrapper])
    await expect(fileClient.getSFTP()).resolves.toBe(wrapper)
    expect(created[0].sftp).toHaveBeenCalledTimes(1)
  })

  it('disconnect 取消在途 SFTP，迟到 SFTP 回调不会安装到新连接', async () => {
    const fileClient = new SSHFileClient('s1', config)
    const pendingSftp = fileClient.getSFTP().then(
      () => ({ ok: true as const }),
      error => ({ ok: false as const, error }),
    )
    created[0].emit('ready')
    await flush()
    expect(created[0].sftp).toHaveBeenCalledTimes(1)

    await fileClient.disconnect()
    expect((await pendingSftp).ok).toBe(false)

    // 旧回调迟到：必须被丢弃
    const staleWrapper = new EventEmitter()
    created[0].sftpCallbacks[0](undefined, staleWrapper)
    await flush()

    // 新连接 + 新 SFTP 初始化
    const nextSftp = fileClient.getSFTP()
    expect(ssh2Mock.ClientMock).toHaveBeenCalledTimes(2)
    created[1].emit('ready')
    await flush()
    expect(created[1].sftp).toHaveBeenCalledTimes(1)

    const freshWrapper = new EventEmitter()
    created[1].sftpCallbacks[0](undefined, freshWrapper)
    await expect(nextSftp).resolves.toBe(freshWrapper)
    await expect(fileClient.getSFTP()).resolves.toBe(freshWrapper)

    // 旧 wrapper 从未被当成当前 SFTP
    expect(fileClient.isConnected()).toBe(true)
  })

  it('空闲超时断开后，新请求重新连接', async () => {
    const fileClient = new SSHFileClient('s1', config)
    const connected = fileClient.getClient()
    created[0].emit('ready')
    await connected
    expect(fileClient.isConnected()).toBe(true)

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    await flush()
    expect(fileClient.isConnected()).toBe(false)
    expect(created[0].end).toHaveBeenCalledTimes(1)

    const reconnected = fileClient.getClient()
    expect(ssh2Mock.ClientMock).toHaveBeenCalledTimes(2)
    created[1].emit('ready')
    await expect(reconnected).resolves.toBe(created[1])
  })

  it('连接中反复 disconnect/getClient 始终只有一条在途 transport', async () => {
    const fileClient = new SSHFileClient('s1', config)

    const first = fileClient.getClient().catch(() => null)
    await fileClient.disconnect()
    await first

    const second = fileClient.getClient().catch(() => null)
    await fileClient.disconnect()
    await second

    const third = fileClient.getClient()
    expect(ssh2Mock.ClientMock).toHaveBeenCalledTimes(3)
    expect(created).toHaveLength(3)
    created[2].emit('ready')
    await expect(third).resolves.toBe(created[2])
  })
})
