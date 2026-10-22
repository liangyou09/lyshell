/**
 * TelnetConnector 连接期资源生命周期单测 —— 用假 net.Socket 驱动，不依赖网络时序。
 *
 * 覆盖的契约：连接期（connect 事件之前）的超时/错误/关闭都恰好 reject 一次，并销毁
 * 本次 socket、结束解码流；disconnect 取消悬挂的连接；连接成功撤销连接期 deadline
 * 并移除临时监听；失败/取消后的迟到事件不得把连接器改成已连接，也不得转发数据/close；
 * 连接成功后仍可读写（IAC 过滤与编码行为不变）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Socket } from 'net'
import iconv from 'iconv-lite'

// electron-log 对齐既有测试的 mock 手法（不 mock 会在 vitest Node 环境加载失败）
vi.mock('electron-log', () => ({
  default: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }
}))

// 用假 socket 替代网络：测试只关心连接器在事件序列下的状态与资源释放
vi.mock('net', async () => {
  const { EventEmitter } = await import('events')
  class FakeSocket extends EventEmitter {
    static instances: FakeSocket[] = []
    destroyed = false
    paused = false
    resumed = false
    timeoutMs: number | null = null
    connectArgs: unknown = null
    writes: Array<string | Buffer> = []
    constructor() {
      super()
      FakeSocket.instances.push(this)
    }
    connect(args: unknown): this {
      this.connectArgs = args
      return this
    }
    setTimeout(ms: number): this {
      this.timeoutMs = ms
      return this
    }
    pause(): this {
      this.paused = true
      return this
    }
    resume(): this {
      this.paused = false
      this.resumed = true
      return this
    }
    write(chunk: string | Buffer): boolean {
      this.writes.push(chunk)
      return true
    }
    destroy(): this {
      this.destroyed = true
      return this
    }
  }
  return { Socket: FakeSocket }
})

import { TelnetConnector } from './telnet'
import type { TelnetConfig } from './telnet'

interface FakeSocket {
  emit(event: string, ...args: unknown[]): boolean
  listenerCount(event: string): number
  destroyed: boolean
  paused: boolean
  resumed: boolean
  timeoutMs: number | null
  connectArgs: { host: string; port: number } | null
  writes: Array<string | Buffer>
}
interface Internals {
  socket: FakeSocket | null
  decoder: { end(): void } | null
}

const sockets = (): FakeSocket[] => (Socket as unknown as { instances: FakeSocket[] }).instances
const internals = (c: TelnetConnector): Internals => c as unknown as Internals
const config = (overrides: Partial<TelnetConfig> = {}): TelnetConfig => ({
  host: '127.0.0.1',
  port: 23,
  ...overrides
})

/** 建连接器并接住必挂的 error 监听（BaseConnector 用 EventEmitter 语义） */
const makeConnector = (cfg: TelnetConfig = config()): { connector: TelnetConnector; errors: Error[] } => {
  const connector = new TelnetConnector('telnet-test', cfg)
  const errors: Error[] = []
  connector.on('error', (err: Error) => errors.push(err))
  return { connector, errors }
}

beforeEach(() => {
  sockets().length = 0
})

describe('TelnetConnector 连接期失败', () => {
  it('握手超时只 reject 一次，销毁 socket 并结束解码流', async () => {
    const { connector } = makeConnector(config({ timeout: 5000 }))
    const pending = connector.connect()
    const assertion = expect(pending).rejects.toThrow('Connection timeout')
    const socket = sockets()[0]
    expect(socket.timeoutMs).toBe(5000)

    socket.emit('timeout')
    await assertion

    expect(socket.destroyed).toBe(true)
    expect(internals(connector).socket).toBeNull()
    expect(internals(connector).decoder).toBeNull()
    expect(connector.isConnected()).toBe(false)
  })

  it('超时后迟到的 connect/data/close 不能复活连接或转发数据', async () => {
    const { connector } = makeConnector(config({ timeout: 5000 }))
    const dat: string[] = []
    const closed = vi.fn()
    const connected = vi.fn()
    connector.on('data', (d: string) => dat.push(d))
    connector.on('close', closed)
    connector.on('connected', connected)

    const pending = connector.connect()
    const assertion = expect(pending).rejects.toThrow('Connection timeout')
    const socket = sockets()[0]
    socket.emit('timeout')
    await assertion

    // 真实 net.Socket 的迟到事件：监听已被解绑，既改不了状态也转发不出去
    socket.emit('connect')
    socket.emit('data', Buffer.from('late output'))
    socket.emit('close')

    expect(connector.isConnected()).toBe(false)
    expect(connector.getEncoding()).toBe('utf-8')
    expect(connected).not.toHaveBeenCalled()
    expect(closed).not.toHaveBeenCalled()
    expect(dat).toEqual([])
  })

  it('连接期 socket 错误 reject 并释放资源，错误只上报一次', async () => {
    const { connector, errors } = makeConnector()
    const pending = connector.connect()
    const assertion = expect(pending).rejects.toThrow('connection refused')
    const socket = sockets()[0]

    socket.emit('error', new Error('connection refused'))
    await assertion

    expect(errors.map(e => e.message)).toEqual(['connection refused'])
    expect(socket.destroyed).toBe(true)
    expect(internals(connector).socket).toBeNull()
    expect(internals(connector).decoder).toBeNull()
    expect(connector.isConnected()).toBe(false)
  })

  it('连接期 close 也 reject，Promise 不会永久悬挂', async () => {
    const { connector } = makeConnector()
    const closed = vi.fn()
    connector.on('close', closed)
    const pending = connector.connect()
    const assertion = expect(pending).rejects.toThrow('Connection closed')
    const socket = sockets()[0]

    socket.emit('close')
    await assertion

    expect(internals(connector).socket).toBeNull()
    expect(internals(connector).decoder).toBeNull()
    expect(connector.isConnected()).toBe(false)
    // 握手期关闭不是「已建立会话自然断开」，不该广播 close 去触发会话清理
    expect(closed).not.toHaveBeenCalled()
  })

  it('disconnect 取消进行中的连接：落定 Promise、销毁 socket、丢弃解码流', async () => {
    const { connector } = makeConnector()
    const pending = connector.connect()
    const assertion = expect(pending).rejects.toThrow('Connection cancelled by user')
    const socket = sockets()[0]

    await connector.disconnect()
    await assertion

    expect(socket.destroyed).toBe(true)
    expect(internals(connector).socket).toBeNull()
    expect(internals(connector).decoder).toBeNull()
    expect(connector.isConnected()).toBe(false)

    // 取消之后迟到的 connect 事件不能把状态改成已连接
    socket.emit('connect')
    expect(connector.isConnected()).toBe(false)
  })

  it('失败/取消后写入静默丢弃，不触碰已销毁的 socket', async () => {
    const { connector } = makeConnector()
    const pending = connector.connect()
    const assertion = expect(pending).rejects.toThrow('Connection timeout')
    const socket = sockets()[0]
    socket.emit('timeout')
    await assertion

    expect(() => connector.write('ls\r')).not.toThrow()
    expect(socket.writes).toEqual([])
  })

  it('未落定的旧连接被新 connect 取代时立刻 reject，旧 socket 被销毁', async () => {
    const { connector } = makeConnector()
    const first = connector.connect()
    const firstAssertion = expect(first).rejects.toThrow('superseded')
    const firstSocket = sockets()[0]

    const second = connector.connect()
    const secondSocket = sockets()[1]
    await firstAssertion

    expect(firstSocket).not.toBe(secondSocket)
    expect(firstSocket.destroyed).toBe(true)

    firstSocket.emit('connect')
    expect(connector.isConnected()).toBe(false)

    secondSocket.emit('connect')
    await second
    expect(connector.isConnected()).toBe(true)
  })
})

describe('TelnetConnector 连接成功', () => {
  it('撤销连接期 deadline、移除超时监听且不会因空闲被断开', async () => {
    const { connector } = makeConnector(config({ timeout: 3000 }))
    const pending = connector.connect()
    const socket = sockets()[0]
    expect(socket.timeoutMs).toBe(3000)

    socket.emit('connect')
    await pending

    expect(socket.timeoutMs).toBe(0)
    expect(socket.listenerCount('timeout')).toBe(0)
    // 每条事件恰好一个监听：连接期临时监听已移除，没有重复的 reject 监听
    expect(socket.listenerCount('data')).toBe(1)
    expect(socket.listenerCount('error')).toBe(1)
    expect(socket.listenerCount('close')).toBe(1)
    expect(socket.listenerCount('connect')).toBe(1)
    expect(connector.isConnected()).toBe(true)

    // 空闲不是连接超时：既不断开也不销毁
    socket.emit('timeout')
    expect(connector.isConnected()).toBe(true)
    expect(socket.destroyed).toBe(false)
  })

  it('连接成功后仍可写入（数据按写入编码下发）', async () => {
    const { connector } = makeConnector()
    const pending = connector.connect()
    const socket = sockets()[0]
    socket.emit('connect')
    await pending

    connector.write('ls\r')
    expect(socket.writes).toEqual(['ls\r'])
    expect(socket.connectArgs).toEqual({ host: '127.0.0.1', port: 23 })
  })

  it('IAC 控制序列被过滤，普通数据按 utf-8 解码转发', async () => {
    const { connector } = makeConnector()
    const dat: string[] = []
    connector.on('data', (d: string) => dat.push(d))
    const pending = connector.connect()
    const socket = sockets()[0]
    socket.emit('connect')
    await pending

    socket.emit('data', Buffer.concat([Buffer.from([0xFF, 0xFB, 0x01]), Buffer.from('hi\r\n')]))
    expect(dat.join('')).toBe('hi\r\n')
  })

  it('gbk 编码下读写都走同一编码（既有编码行为不变）', async () => {
    const { connector } = makeConnector(config({ encoding: 'gbk' }))
    const dat: string[] = []
    connector.on('data', (d: string) => dat.push(d))
    const pending = connector.connect()
    const socket = sockets()[0]
    socket.emit('connect')
    await pending

    connector.write('中')
    expect(socket.writes[0]).toEqual(iconv.encode('中', 'gbk'))

    socket.emit('data', iconv.encode('中', 'gbk'))
    expect(dat.join('')).toBe('中')
  })

  it('运行期错误只上报一次，随后 close 收尾并释放 socket 与解码流', async () => {
    const { connector, errors } = makeConnector()
    const closed = vi.fn()
    connector.on('close', closed)
    const pending = connector.connect()
    const socket = sockets()[0]
    socket.emit('connect')
    await pending

    socket.emit('error', new Error('ECONNRESET'))
    expect(errors.map(e => e.message)).toEqual(['ECONNRESET'])
    expect(connector.isConnected()).toBe(false)
    // 错误后仍等 close 收尾，socket 不应被提前释放（close 还要用它做身份校验）
    expect(socket.destroyed).toBe(false)

    socket.emit('close')
    expect(closed).toHaveBeenCalledTimes(1)
    expect(socket.destroyed).toBe(true)
    expect(internals(connector).socket).toBeNull()
    expect(internals(connector).decoder).toBeNull()
    expect(connector.isConnected()).toBe(false)
  })

  it('连接前记录的暂停状态应用到新 socket，成功后仍可恢复', async () => {
    const { connector } = makeConnector()
    connector.setOutputPaused(true)

    const pending = connector.connect()
    const socket = sockets()[0]
    expect(socket.paused).toBe(true)

    socket.emit('connect')
    await pending
    expect(socket.paused).toBe(true)

    connector.setOutputPaused(false)
    expect(socket.paused).toBe(false)
    expect(socket.resumed).toBe(true)
  })

  it('未配置 timeout 时默认 10 秒连接 deadline', async () => {
    const { connector } = makeConnector()
    const pending = connector.connect()
    expect(sockets()[0].timeoutMs).toBe(10000)
    sockets()[0].emit('connect')
    await pending
  })
})

describe('TelnetConnector 失败后重连', () => {
  it('旧 socket 的迟到事件不影响新 attempt，也不转发数据/close', async () => {
    const { connector } = makeConnector()
    const dat: string[] = []
    const closed = vi.fn()
    connector.on('data', (d: string) => dat.push(d))
    connector.on('close', closed)

    const first = connector.connect()
    const firstAssertion = expect(first).rejects.toThrow('Connection timeout')
    const firstSocket = sockets()[0]
    firstSocket.emit('timeout')
    await firstAssertion

    const second = connector.connect()
    const secondSocket = sockets()[1]
    secondSocket.emit('connect')
    await second
    expect(connector.isConnected()).toBe(true)

    // 旧 socket 的迟到事件全部无效
    firstSocket.emit('connect')
    firstSocket.emit('data', Buffer.from('stale'))
    firstSocket.emit('close')
    firstSocket.emit('error', new Error('late error'))

    expect(connector.isConnected()).toBe(true)
    expect(closed).not.toHaveBeenCalled()
    expect(dat).toEqual([])

    // 新 socket 依旧可用
    secondSocket.emit('data', Buffer.from('live'))
    expect(dat.join('')).toBe('live')
    connector.write('pwd\r')
    expect(secondSocket.writes).toEqual(['pwd\r'])
  })
})
