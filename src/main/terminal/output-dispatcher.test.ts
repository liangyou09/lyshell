import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalOutputDispatcher } from './output-dispatcher'
import { TERMINAL_OUTPUT_PACKET_SIZE as PACKET, TERMINAL_OUTPUT_HIGH_WATER as HIGH, TERMINAL_OUTPUT_MAX_PENDING as MAX, type TerminalOutputReceipt } from '@shared/terminal-output'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

function fixture() {
  const pause = vi.fn()
  // 旧用例只覆盖背压/回执校验，不涉及 ACK 超时；用较长阈值隔离 15s 默认值，
  // 有界 ACK 等待的行为见文件末尾的新用例。
  const dispatcher = new TerminalOutputDispatcher(pause, { ackTimeoutMs: 600_000 })
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
    // 用 16ms 推进代替“跑完所有挂起定时器”：后者会跳过 15s ACK 有界等待直接触发超时撤销，
    // 而本用例只想验证伪造 ACK 不能提前放行下一包。
    vi.advanceTimersByTime(16)
    expect(packets).toHaveLength(1)
    ack(0)
    vi.advanceTimersByTime(16)
    expect(packets).toHaveLength(2)
    ack(0)
    vi.advanceTimersByTime(16)
    expect(packets).toHaveLength(2)
  })

  it('多窗口独立确认，销毁最后一个慢窗口后恢复输入源', () => {
    const { dispatcher, pause, packets, ack } = fixture()
    const second = vi.fn()
    dispatcher.subscribe(2, 'a', second)
    dispatcher.append('a', 'x'.repeat(HIGH))
    vi.runOnlyPendingTimers()
    // 逐帧确认：用 16ms 推进触发 flush，避免 runOnlyPendingTimers 连带触发窗口 2 的
    // ACK 超时定时器，使“窗口 2 一直不回 ACK”这一前提被提前打破。
    for (let i = 0; i < HIGH / PACKET; i++) { ack(i); vi.advanceTimersByTime(16) }
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

/** 小阈值 + 独立收包数组，便于用可控定时器精确驱动 ACK 超时 */
function boundedLimits(overrides: Partial<{ globalQueueBudget: number; maxConsumers: number; ackTimeoutMs: number }> = {}) {
  const ACK = 1000
  const pause = vi.fn()
  const dispatcher = new TerminalOutputDispatcher(pause, {
    ackTimeoutMs: ACK,
    globalQueueBudget: 4 * 1024 * 1024,
    maxConsumers: 8,
    ...overrides
  })
  return { dispatcher, pause, ACK }
}

describe('终端输出有界 ACK 等待与全局预算', () => {
  it('GUI 失联超时后撤销消费者、显式报错、解除背压，并允许重订阅恢复消费', () => {
    const { dispatcher, pause, ACK } = boundedLimits()
    const packets: Array<{ data: string; receipt: TerminalOutputReceipt }> = []
    const send = (data: string, receipt: TerminalOutputReceipt) => packets.push({ data, receipt })
    const subscription = dispatcher.subscribe(1, 'a', send)

    dispatcher.append('a', 'x'.repeat(HIGH))
    vi.runOnlyPendingTimers()
    expect(packets).toHaveLength(1)
    expect(pause).toHaveBeenLastCalledWith('a', true)

    vi.advanceTimersByTime(ACK)
    expect(packets).toHaveLength(2)
    expect(packets[1].data).toBe('')
    expect(packets[1].receipt.error).toBe('ack-timeout')
    expect(packets[1].receipt.subscriptionId).toBe(subscription)
    // 背压必须解除：不能因为 GUI 失联让 PTY 永久暂停。
    expect(pause).toHaveBeenLastCalledWith('a', false)
    expect(dispatcher.getSnapshot()).toMatchObject({
      consumerCount: 0,
      totalPending: 0,
      pausedSessions: 0,
      diagnostics: { ackTimeouts: 1 }
    })

    // 迟到的旧 ACK 无效，且不能再产生任何帧或定时器。
    dispatcher.acknowledge(1, 'a', subscription, packets[0].receipt.sequence)
    dispatcher.append('a', 'ignored')
    vi.advanceTimersByTime(ACK * 4)
    expect(packets).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)

    // 重新订阅后恢复消费，旧订阅号不影响新订阅。
    const next: Array<{ data: string; receipt: TerminalOutputReceipt }> = []
    const nextId = dispatcher.subscribe(1, 'a', (data, receipt) => next.push({ data, receipt }))
    expect(nextId).not.toBe(subscription)
    dispatcher.append('a', 'recovered')
    vi.advanceTimersByTime(16)
    expect(next.map(p => p.data).join('')).toBe('recovered')
    dispatcher.acknowledge(1, 'a', nextId, next[0].receipt.sequence)
    expect(dispatcher.getSnapshot().totalPending).toBe(0)
  })

  it('多个消费者隔离：一个失联被撤销，另一个继续确认并收完数据', () => {
    const { dispatcher, pause, ACK } = boundedLimits()
    const slow: TerminalOutputReceipt[] = []
    const fast: Array<{ data: string; receipt: TerminalOutputReceipt }> = []
    const slowId = dispatcher.subscribe(1, 'a', (_data, receipt) => slow.push(receipt))
    const fastId = dispatcher.subscribe(2, 'a', (data, receipt) => fast.push({ data, receipt }))

    dispatcher.append('a', 'y'.repeat(HIGH))
    vi.advanceTimersByTime(16)
    expect(slow).toHaveLength(1)
    expect(fast).toHaveLength(1)
    expect(pause).toHaveBeenLastCalledWith('a', true)

    // 窗口 2 正常确认，窗口 1 一直不回 ACK。
    for (let i = 0; i < HIGH / PACKET; i += 1) {
      dispatcher.acknowledge(2, 'a', fastId, fast[i].receipt.sequence)
      vi.advanceTimersByTime(16)
    }
    expect(fast.map(p => p.data).join('')).toHaveLength(HIGH)
    expect(dispatcher.getSnapshot().sessions[0]).toMatchObject({ consumers: 2, pending: HIGH })

    vi.advanceTimersByTime(ACK)
    expect(slow[1].error).toBe('ack-timeout')
    expect(slow[1].subscriptionId).toBe(slowId)
    expect(pause).toHaveBeenLastCalledWith('a', false)
    expect(dispatcher.getSnapshot()).toMatchObject({ consumerCount: 1, totalPending: 0 })
  })

  it('旧 ACK、重复 ACK 与重订阅都不会污染背压计数', () => {
    const { dispatcher } = boundedLimits()
    const packets: Array<{ data: string; receipt: TerminalOutputReceipt }> = []
    const send = (data: string, receipt: TerminalOutputReceipt) => packets.push({ data, receipt })
    const first = dispatcher.subscribe(1, 'a', send)
    dispatcher.append('a', 'z'.repeat(PACKET * 2))
    vi.advanceTimersByTime(16)
    expect(packets).toHaveLength(1)

    dispatcher.acknowledge(1, 'a', first, packets[0].receipt.sequence)
    dispatcher.acknowledge(1, 'a', first, packets[0].receipt.sequence) // 重复 ACK
    dispatcher.acknowledge(1, 'a', 'stale-subscription', packets[0].receipt.sequence)
    expect(dispatcher.getSnapshot().totalPending).toBe(PACKET)

    const second: Array<{ data: string; receipt: TerminalOutputReceipt }> = []
    const secondId = dispatcher.subscribe(1, 'a', (data, receipt) => second.push({ data, receipt }))
    dispatcher.acknowledge(1, 'a', first, packets[0].receipt.sequence)
    dispatcher.append('a', 'fresh')
    vi.advanceTimersByTime(16)
    expect(second).toHaveLength(1)
    expect(second[0].data).toBe('fresh')
    expect(second[0].receipt.subscriptionId).toBe(secondId)
    dispatcher.acknowledge(1, 'a', secondId, second[0].receipt.sequence)
    expect(dispatcher.getSnapshot().totalPending).toBe(0)
  })

  it('重订阅清理旧消费者的 ACK 定时器，不会误报超时', () => {
    const { dispatcher, ACK } = boundedLimits()
    const packets: TerminalOutputReceipt[] = []
    const first = dispatcher.subscribe(1, 'a', (_data, receipt) => packets.push(receipt))
    dispatcher.append('a', 'x'.repeat(HIGH))
    vi.runOnlyPendingTimers()
    expect(packets).toHaveLength(1)

    const nextId = dispatcher.subscribe(1, 'a', vi.fn())
    vi.advanceTimersByTime(ACK * 3)
    expect(packets.filter(r => r.error)).toHaveLength(0)
    expect(dispatcher.getSnapshot()).toMatchObject({ consumerCount: 1, diagnostics: { ackTimeouts: 0 } })
    // 旧订阅的 ACK 不生效。
    dispatcher.acknowledge(1, 'a', first, 1)
    expect(dispatcher.getSnapshot().totalPending).toBe(0)
    expect(nextId).not.toBe(first)
  })

  it('GUI 队列全局总预算超限时只撤销超限会话的消费者并报 queue-budget', () => {
    const { dispatcher, pause } = boundedLimits({ globalQueueBudget: 1000 })
    const a: Array<{ data: string; receipt: TerminalOutputReceipt }> = []
    const b: TerminalOutputReceipt[] = []
    const aId = dispatcher.subscribe(1, 'a', (data, receipt) => a.push({ data, receipt }))
    dispatcher.subscribe(2, 'b', (_data, receipt) => b.push(receipt))

    dispatcher.append('a', 'x'.repeat(600))
    expect(dispatcher.getSnapshot().totalPending).toBe(600)
    dispatcher.append('b', 'x'.repeat(600))
    expect(b[0].error).toBe('queue-budget')
    const snapshot = dispatcher.getSnapshot()
    expect(snapshot.totalPending).toBe(600)
    expect(snapshot.consumerCount).toBe(1)
    expect(snapshot.sessions).toEqual([expect.objectContaining({ sessionId: 'a', consumers: 1 })])
    expect(snapshot.diagnostics.queueBudget).toBe(1)
    // 会话 b 从未进入暂停（积压未到高水位），撤销它不应产生多余的恢复调用。
    expect(pause).not.toHaveBeenCalledWith('b', true)

    // 会话 a 的消费者不受影响，仍能正常确认。
    vi.advanceTimersByTime(16)
    expect(a).toHaveLength(1)
    expect(a[0].data).toHaveLength(600)
    dispatcher.acknowledge(1, 'a', aId, a[0].receipt.sequence)
    expect(dispatcher.getSnapshot().totalPending).toBe(0)
  })

  it('消费者数量上限拒绝新订阅并报 consumer-limit，同窗口重订阅不受限', () => {
    const { dispatcher } = boundedLimits({ maxConsumers: 1 })
    const errors: TerminalOutputReceipt[] = []
    const first = dispatcher.subscribe(1, 'a', vi.fn())
    const rejected = dispatcher.subscribe(2, 'b', (_data, receipt) => errors.push(receipt))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ error: 'consumer-limit', subscriptionId: rejected })
    expect(dispatcher.getSnapshot()).toMatchObject({ consumerCount: 1, diagnostics: { consumerLimit: 1 } })

    // 同窗口重订阅是替换，不占额外名额。
    const replacement = dispatcher.subscribe(1, 'a', vi.fn())
    expect(replacement).not.toBe(first)
    expect(dispatcher.getSnapshot().consumerCount).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('订阅初始历史超过全局预算时明确拒绝，不静默截断', () => {
    const { dispatcher } = boundedLimits({ globalQueueBudget: 10 })
    const errors: TerminalOutputReceipt[] = []
    dispatcher.subscribe(1, 'a', (_data, receipt) => errors.push(receipt), 'h'.repeat(20))
    expect(errors).toHaveLength(1)
    expect(errors[0].error).toBe('queue-budget')
    expect(dispatcher.getSnapshot()).toMatchObject({ consumerCount: 0, totalPending: 0 })
  })

  it('dispose 撤销全部消费者、通知 disposed、清理定时器并解除背压', () => {
    const { dispatcher, pause } = boundedLimits()
    const packets: TerminalOutputReceipt[] = []
    dispatcher.subscribe(1, 'a', (_data, receipt) => packets.push(receipt))
    dispatcher.subscribe(2, 'b', (_data, receipt) => packets.push(receipt))
    dispatcher.append('a', 'x'.repeat(HIGH))
    dispatcher.append('b', 'y'.repeat(HIGH))
    vi.runOnlyPendingTimers()
    expect(packets).toHaveLength(2)

    dispatcher.dispose()
    expect(packets).toHaveLength(4)
    expect(packets.slice(2).every(r => r.error === 'disposed')).toBe(true)
    expect(pause).toHaveBeenCalledWith('a', false)
    expect(pause).toHaveBeenCalledWith('b', false)
    expect(vi.getTimerCount()).toBe(0)
    expect(dispatcher.getSnapshot()).toMatchObject({ disposed: true, consumerCount: 0, totalPending: 0 })
    expect(() => dispatcher.subscribe(1, 'a', vi.fn())).toThrow(/disposed/)
    dispatcher.dispose() // 幂等
  })
})
