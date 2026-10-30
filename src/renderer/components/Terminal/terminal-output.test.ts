import { describe, expect, it, vi } from 'vitest'
import { bindTerminalOutput } from './terminal-output'
import type { ElectronAPI } from '@preload/index'
import type { TerminalOutputControl, TerminalOutputReceipt } from '@shared/terminal-output'

function fixture() {
  let receive!: (id: string, data: string, receipt?: TerminalOutputReceipt) => void
  let ready!: (result: { success: boolean; subscriptionId: string }) => void
  const written: Array<{ data: string; done?: () => void }> = []
  const off = vi.fn()
  const control = vi.fn((request: TerminalOutputControl) => request.kind === 'subscribe'
    ? new Promise<{ success: boolean; subscriptionId: string }>(resolve => { ready = resolve })
    : Promise.resolve({ success: true }))
  const api = { terminalOutputControl: control, onTerminalData: (callback: typeof receive) => { receive = callback; return off } } as unknown as ElectronAPI
  const write = (data: string, done?: () => void) => { written.push({ data, done }) }
  const stop = bindTerminalOutput('a', { write }, api)
  return { receive: (data: string, sequence = 1, subscriptionId = 'stream') => receive('a', data, { sequence, subscriptionId }), ready: () => ready({ success: true, subscriptionId: 'stream' }), control, off, stop, written }
}

describe('xterm 消费后确认', () => {
  it('有限历史先排队重置，再重放数据，防旧解析状态污染新历史', async () => {
    let receive!: (id: string, data: string, receipt?: TerminalOutputReceipt) => void
    const writes: string[] = []
    const control = vi.fn(async () => ({ success: true, subscriptionId: 'new', historyTruncated: true }))
    const api = { terminalOutputControl: control, onTerminalData: (callback: typeof receive) => { receive = callback; return () => {} } } as unknown as ElectronAPI
    const stop = bindTerminalOutput('a', { write: data => { writes.push(String(data)) } }, api)
    receive('a', 'bounded-history', { subscriptionId: 'new', sequence: 1 })
    await vi.waitFor(() => expect(writes).toHaveLength(2))
    expect(writes[0].startsWith('\x1bc')).toBe(true)
    expect(writes[1]).toBe('bounded-history')
    stop()
  })

  it('主机历史缺口重新订阅，旧 write callback 不确认新订阅', async () => {
    let receive!: (id: string, data: string, receipt?: TerminalOutputReceipt) => void
    const writes: Array<{ data: string; done?: () => void }> = []
    let sequence = 0
    const control = vi.fn(async (request: TerminalOutputControl) => request.kind === 'subscribe'
      ? { success: true, subscriptionId: `s${++sequence}` } : { success: true })
    const api = { terminalOutputControl: control, onTerminalData: (callback: typeof receive) => { receive = callback; return () => {} } } as unknown as ElectronAPI
    const stop = bindTerminalOutput('a', { write: (data, done) => { writes.push({ data: String(data), done }) } }, api)
    await Promise.resolve()
    receive('a', 'old', { subscriptionId: 's1', sequence: 1 })
    await vi.waitFor(() => expect(writes[0]?.data).toBe('old'))
    receive('a', '', { subscriptionId: 's1', sequence: 2, error: 'history-gap' })
    await vi.waitFor(() => expect(sequence).toBe(2))
    writes[0].done!()
    expect(control.mock.calls.some(([request]) => request.kind === 'ack')).toBe(false)
    expect(writes.some(write => write.data.startsWith('\x1bc'))).toBe(true)
    stop()
  })

  it('等 write callback 完成才发 ACK，忽略其他订阅', async () => {
    const f = fixture()
    f.ready()
    await vi.waitFor(() => expect(f.control.mock.results[0].value).resolves.toEqual({ success: true, subscriptionId: 'stream' }))
    f.receive('ignored', 1, 'previous')
    f.receive('payload')
    expect(f.written).toHaveLength(1)
    expect(f.control).toHaveBeenCalledTimes(1)
    f.written[0].done!()
    expect(f.control).toHaveBeenLastCalledWith({ kind: 'ack', sessionId: 'a', subscriptionId: 'stream', sequence: 1 })
    f.stop()
  })

  it('首包早于 invoke 回执时保留，确认订阅后再处理', async () => {
    const f = fixture()
    f.receive('early')
    expect(f.written).toHaveLength(0)
    f.ready()
    await vi.waitFor(() => expect(f.written).toHaveLength(1))
    expect(f.written[0].data).toBe('early')
    f.stop()
  })

  it('注册尚未返回时销毁，迟到的订阅必须退订', async () => {
    const f = fixture()
    f.stop()
    f.ready()
    await vi.waitFor(() => expect(f.control).toHaveBeenCalledTimes(2))
    expect(f.off).toHaveBeenCalled()
    expect(f.control).toHaveBeenLastCalledWith({ kind: 'unsubscribe', sessionId: 'a', subscriptionId: 'stream' })
    f.receive('late')
    expect(f.written).toHaveLength(0)
  })

  it('销毁后的迟到 write callback 不确认新实例的数据', async () => {
    const f = fixture()
    f.ready()
    await vi.waitFor(() => expect(f.control.mock.results[0].value).resolves.toEqual({ success: true, subscriptionId: 'stream' }))
    f.receive('pending')
    f.stop()
    f.written[0].done!()
    expect(f.control.mock.calls.map(([request]) => request.kind)).toEqual(['subscribe', 'unsubscribe'])
  })
})
