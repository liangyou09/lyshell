import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from 'ssh2'
import { SSHConnector } from './ssh'

vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('ssh2', async () => {
  const { EventEmitter } = await import('events')
  class Channel extends EventEmitter {
    close = vi.fn(() => { this.emit('close') })
    pause = vi.fn()
    resume = vi.fn()
    write = vi.fn()
    setWindow = vi.fn()
  }
  class FakeClient extends EventEmitter {
    static instances: FakeClient[] = []
    channels: Channel[] = []
    deferred = false
    open?: () => void
    connect = vi.fn()
    end = vi.fn()
    constructor() { super(); FakeClient.instances.push(this) }
    shell(_options: unknown, callback: (error: null, channel: Channel) => void) {
      const channel = new Channel()
      this.channels.push(channel)
      this.open = () => callback(null, channel)
      if (!this.deferred) this.open()
    }
  }
  return { Client: FakeClient }
})

interface FakeChannel {
  emit(event: string, ...args: unknown[]): boolean
  close: ReturnType<typeof vi.fn>
  pause: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
}
interface FakeClient {
  emit(event: string, ...args: unknown[]): boolean
  listenerCount(event: string): number
  channels: FakeChannel[]
  deferred: boolean
  open?: () => void
  end: ReturnType<typeof vi.fn>
}
const clients = () => (Client as unknown as { instances: FakeClient[] }).instances
const config = { host: 'localhost', port: 22, username: 'test' }
async function connected() {
  const connector = new SSHConnector('source', config)
  connector.on('error', () => {})
  const pending = connector.connect()
  const client = clients().at(-1)!
  client.emit('ready')
  await pending
  return { connector, client }
}
beforeEach(() => { clients().length = 0 })

describe('SSH 原生资源生命周期', () => {
  it('自然退出释放普通 transport，状态和 decoder 同时清理', async () => {
    const { connector, client } = await connected()
    const closed = vi.fn()
    connector.on('close', closed)
    client.channels[0].emit('close')
    expect(closed).toHaveBeenCalledTimes(1)
    expect(connector.isConnected()).toBe(false)
    expect(connector.getClient()).toBeNull()
    expect(client.end).toHaveBeenCalledTimes(1)
    await connector.disconnect()
    expect(client.end).toHaveBeenCalledTimes(1)
  })

  it.each(['source', 'clone'])('先关闭 %s 不影响另一个渠道，最后一个渠道才关闭 transport', async first => {
    const { connector, client } = await connected()
    const clone = new SSHConnector('clone', config)
    clone.setSharedClient(connector.getClient()!)
    await clone.startShellOnly()
    const firstChannel = first === 'source' ? 0 : 1
    client.channels[firstChannel].emit('close')
    expect(client.end).not.toHaveBeenCalled()
    const survivor = first === 'source' ? clone : connector
    expect(survivor.isConnected()).toBe(true)
    expect(survivor.getClient()).not.toBeNull()
    client.channels[1 - firstChannel].emit('close')
    expect(client.end).toHaveBeenCalledTimes(1)
    expect(clone.isConnected()).toBe(false)
    expect(connector.isConnected()).toBe(false)
  })

  it('transport 关闭同步通知所有渠道，并解绑各自监听器', async () => {
    const { connector, client } = await connected()
    const clone = new SSHConnector('clone', config)
    clone.setSharedClient(connector.getClient()!)
    await clone.startShellOnly()
    const closed = [vi.fn(), vi.fn()]
    connector.on('close', closed[0]); clone.on('close', closed[1])
    client.emit('close')
    expect(closed[0]).toHaveBeenCalledTimes(1)
    expect(closed[1]).toHaveBeenCalledTimes(1)
    expect(client.listenerCount('close')).toBe(0)
    expect(client.listenerCount('error')).toBe(0)
    expect(connector.getClient()).toBeNull()
    expect(clone.getClient()).toBeNull()
  })

  it('连接失败立即 reject，不能先清空回调导致连接 Promise 永远悬挂', async () => {
    const connector = new SSHConnector('failed', config)
    connector.on('error', () => {})
    const pending = connector.connect()
    const assertion = expect(pending).rejects.toThrow('authentication failed')
    clients()[0].emit('error', new Error('authentication failed'))
    await assertion
    clients()[0].emit('close')
    expect(connector.getClient()).toBeNull()
  })

  it('取消后的迟到 shell 立即关闭，不能重新挂上已释放的 connector', async () => {
    const connector = new SSHConnector('cancelled', config)
    const pending = connector.connect()
    const client = clients()[0]
    client.deferred = true
    client.emit('ready')
    await pending
    await connector.disconnect()
    client.open!()
    expect(client.channels[0].close).toHaveBeenCalledTimes(1)
    expect(connector.isConnected()).toBe(false)
    expect(connector.getClient()).toBeNull()
  })

  it('shell 尚未创建时记录暂停状态，渠道返回后暂停它', async () => {
    const connector = new SSHConnector('paused', config)
    connector.setOutputPaused(true)
    const pending = connector.connect()
    const client = clients()[0]
    client.emit('ready')
    await pending
    expect(client.channels[0].pause).toHaveBeenCalledTimes(1)
    connector.setOutputPaused(false)
    expect(client.channels[0].resume).toHaveBeenCalledTimes(1)
    await connector.disconnect()
  })
})
