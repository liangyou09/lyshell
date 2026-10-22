import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalOutputDispatcher } from './output-dispatcher'
import { TERMINAL_OUTPUT_PACKET_SIZE as PACKET, TERMINAL_OUTPUT_HIGH_WATER as HIGH, TERMINAL_OUTPUT_MAX_PENDING as MAX, type TerminalOutputReceipt } from '@shared/terminal-output'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

function fixture() {
  const pause = vi.fn()
  const dispatcher = new TerminalOutputDispatcher(pause)
  const packets: Array<{ data: string; receipt: TerminalOutputReceipt }> = []
  const send = (data: string, receipt: TerminalOutputReceipt) => packets.push({ data, receipt })
  const subscription = dispatcher.subscribe(1, 'a', send)
  const ack = (index: number) => dispatcher.acknowledge(1, 'a', subscription, packets[index].receipt.sequence)
  return { dispatcher, pause, packets, send, subscription, ack }
}

describe('终端输出消费回执与背压', () => {
  it('慢消费者最多一包在途；消费后精确按顺序发送，低水位才恢复', () => {
    const { dispatcher, pause, packets, ack } = fixture()
    const source = '0123456789中文😀'.repeat(24000)
    dispatcher.append('a', source)
    expect(pause).toHaveBeenLastCalledWith('a', true)
    vi.runOnlyPendingTimers()
    expect(packets).toHaveLength(1)
    expect(packets[0].data.length).toBe(PACKET)
    vi.advanceTimersByTime(10000)
    expect(packets).toHaveLength(1)
    for (let i = 0; i < Math.ceil(source.length / PACKET); i++) {
      ack(i)
      vi.runOnlyPendingTimers()
    }
    expect(packets.map(p => p.data).join('')).toBe(source)
    expect(pause).toHaveBeenLastCalledWith('a', false)
  })

  it('伪造窗口、token、重复或超前回执均不能放行下一包', () => {
    const { dispatcher, packets, subscription, ack } = fixture()
    dispatcher.append('a', 'x'.repeat(HIGH))
    vi.runOnlyPendingTimers()
    dispatcher.acknowledge(2, 'a', subscription, 1)
    dispatcher.acknowledge(1, 'a', 'old-stream', 1)
    dispatcher.acknowledge(1, 'a', subscription, 2)
    vi.runOnlyPendingTimers()
    expect(packets).toHaveLength(1)
    ack(0)
    vi.runOnlyPendingTimers()
    expect(packets).toHaveLength(2)
    ack(0)
    vi.runOnlyPendingTimers()
    expect(packets).toHaveLength(2)
  })

  it('多窗口独立确认，销毁最后一个慢窗口后恢复输入源', () => {
    const { dispatcher, pause, packets, ack } = fixture()
    const second = vi.fn()
    dispatcher.subscribe(2, 'a', second)
    dispatcher.append('a', 'x'.repeat(HIGH))
    vi.runOnlyPendingTimers()
    for (let i = 0; i < HIGH / PACKET; i++) { ack(i); vi.runOnlyPendingTimers() }
    expect(packets.map(p => p.data).join('')).toHaveLength(HIGH)
    expect(second).toHaveBeenCalledTimes(1)
    expect(pause).toHaveBeenLastCalledWith('a', true)
    dispatcher.removeWindow(2)
    expect(pause).toHaveBeenLastCalledWith('a', false)
    dispatcher.removeWindow(1)
    vi.runAllTimers()
  })

  it('重新订阅隔离旧回执和卸载回调，历史快照只交给新消费者', () => {
    const { dispatcher, packets, subscription } = fixture()
    dispatcher.append('a', 'old')
    vi.runOnlyPendingTimers()
    const next = vi.fn()
    const nextId = dispatcher.subscribe(1, 'a', next, 'history')
    dispatcher.remove(1, 'a', subscription)
    dispatcher.acknowledge(1, 'a', subscription, 1)
    vi.runOnlyPendingTimers()
    expect(next).toHaveBeenCalledWith('history', { subscriptionId: nextId, sequence: 1 })
    expect(packets).toHaveLength(1)
  })

  it('不服从暂停的来源达到硬上限时显式报错并释放消费者', () => {
    const { dispatcher, pause, packets } = fixture()
    dispatcher.append('a', 'x'.repeat(MAX))
    expect(pause).toHaveBeenLastCalledWith('a', true)
    vi.runOnlyPendingTimers()
    dispatcher.append('a', 'overflow')
    expect(packets[1].receipt.error).toBe('overflow')
    expect(pause).toHaveBeenLastCalledWith('a', false)
    dispatcher.append('a', 'ignored after consumer removal')
    vi.runAllTimers()
    expect(packets).toHaveLength(2)
  })

  it('消费者发送失败、删除会话及无消费者输出均不遗留定时器或暂停状态', () => {
    const { dispatcher, pause } = fixture()
    dispatcher.subscribe(1, 'a', () => { throw new Error('closed window') })
    dispatcher.append('a', 'x'.repeat(HIGH))
    vi.runAllTimers()
    expect(pause).toHaveBeenLastCalledWith('a', false)
    dispatcher.subscribe(1, 'b', vi.fn())
    dispatcher.append('b', 'x'.repeat(HIGH))
    dispatcher.removeSession('b')
    expect(pause).toHaveBeenLastCalledWith('b', false)
    dispatcher.append('headless', 'x'.repeat(MAX * 2))
    expect(vi.getTimerCount()).toBe(0)
  })
})
