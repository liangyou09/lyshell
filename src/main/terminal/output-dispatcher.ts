import { randomUUID } from 'crypto'
import {
  TERMINAL_OUTPUT_PACKET_SIZE, TERMINAL_OUTPUT_HIGH_WATER,
  TERMINAL_OUTPUT_LOW_WATER, TERMINAL_OUTPUT_MAX_PENDING,
  TERMINAL_OUTPUT_TOTAL_QUEUE_BUDGET, TERMINAL_OUTPUT_MAX_CONSUMERS,
  TERMINAL_OUTPUT_ACK_TIMEOUT_MS,
  type TerminalOutputReceipt, type TerminalOutputReceiptError
} from '@shared/terminal-output'

export interface TerminalOutputDispatcherLimits {
  /** 所有消费者积压之和的预算（UTF-16 码元） */
  globalQueueBudget: number
  /** 同时存在的消费者数量上限 */
  maxConsumers: number
  /** 等待单个消费者 ACK 的上限（毫秒） */
  ackTimeoutMs: number
}

/** 只读诊断快照，便于验证背压/撤销行为（不参与控制流） */
export interface TerminalOutputDispatcherSnapshot {
  disposed: boolean
  consumerCount: number
  sessionCount: number
  /** 所有消费者积压之和（含未 ACK 的在途帧） */
  totalPending: number
  globalQueueBudget: number
  maxConsumers: number
  ackTimeoutMs: number
  pausedSessions: number
  /** 每个会话的消费者数与积压，便于定位单个慢消费者 */
  sessions: Array<{ sessionId: string; consumers: number; pending: number; paused: boolean }>
  diagnostics: {
    ackTimeouts: number
    overflow: number
    queueBudget: number
    consumerLimit: number
    sendFailures: number
  }
}

interface Consumer {
  windowId: number
  sessionId: string
  subscriptionId: string
  send(data: string, receipt: TerminalOutputReceipt): void
  chunks: string[]
  head: number
  offset: number
  pending: number
  sequence: number
  inFlight: boolean
  inFlightSize: number
  /** 待发送的 flush 定时器 */
  timer?: ReturnType<typeof setTimeout>
  /** 在途帧的 ACK 超时定时器 */
  ackTimer?: ReturnType<typeof setTimeout>
}

function normalizePositive(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value < 1) return fallback
  return Math.floor(value)
}

/**
 * 每个窗口/会话最多一包 IPC 在途；慢消费者把背压传播到真实输入源。
 *
 * 有界性保证：
 * - 单消费者积压超过 MAX_PENDING → 撤销该消费者并回 `overflow`；
 * - 所有消费者积压之和超过 globalQueueBudget → 撤销该会话中积压最大的消费者
 *   并回 `queue-budget`（不静默丢数据，也不影响其他会话）；
 * - 消费者数量超过 maxConsumers → 新订阅回 `consumer-limit`；
 * - 在途帧等待 ACK 超过 ackTimeoutMs → 撤销该消费者并回 `ack-timeout`，
 *   同时解除它造成的 PTY 暂停，PTY/MCP 消费不会被失联的 GUI 永久阻塞。
 *
 * ACK 严格校验 subscriptionId + sequence：重订阅后旧订阅的 ACK 会被忽略，
 * 重复 ACK 不会二次扣减 pending。
 */
export class TerminalOutputDispatcher {
  private consumers = new Map<string, Map<number, Consumer>>()
  private paused = new Set<string>()
  private totalPending = 0
  private disposed = false
  private readonly limits: TerminalOutputDispatcherLimits
  private readonly stats = {
    ackTimeouts: 0,
    overflow: 0,
    queueBudget: 0,
    consumerLimit: 0,
    sendFailures: 0
  }

  constructor(
    private setPaused: (sessionId: string, paused: boolean) => void,
    limits: Partial<TerminalOutputDispatcherLimits> = {}
  ) {
    this.limits = {
      globalQueueBudget: normalizePositive(limits.globalQueueBudget, TERMINAL_OUTPUT_TOTAL_QUEUE_BUDGET),
      maxConsumers: normalizePositive(limits.maxConsumers, TERMINAL_OUTPUT_MAX_CONSUMERS),
      ackTimeoutMs: normalizePositive(limits.ackTimeoutMs, TERMINAL_OUTPUT_ACK_TIMEOUT_MS)
    }
  }

  subscribe(windowId: number, sessionId: string, send: Consumer['send'], initialData = ''): string {
    if (this.disposed) throw new Error('Terminal output dispatcher is disposed')
    if (initialData.length > TERMINAL_OUTPUT_MAX_PENDING) throw new Error('Initial terminal output exceeds buffer limit')
    const group = this.consumers.get(sessionId)
    const existing = group?.get(windowId)
    const subscriptionId = randomUUID()

    // 消费者数量上限：替换同窗口同会话的旧订阅不受限制，否则明确拒绝。
    if (!existing && this.countConsumers() >= this.limits.maxConsumers) {
      this.stats.consumerLimit += 1
      this.sendError(send, subscriptionId, 0, 'consumer-limit')
      return subscriptionId
    }

    this.remove(windowId, sessionId)
    if (initialData && this.totalPending + initialData.length > this.limits.globalQueueBudget) {
      // 全局队列预算已满：明确拒绝本次订阅，而不是悄悄截断历史。
      this.stats.queueBudget += 1
      this.sendError(send, subscriptionId, 0, 'queue-budget')
      return subscriptionId
    }

    const consumer: Consumer = {
      windowId, sessionId, send, subscriptionId, chunks: [],
      head: 0, offset: 0, pending: 0, sequence: 0, inFlight: false, inFlightSize: 0
    }
    const target = this.consumers.get(sessionId)
    if (!target) this.consumers.set(sessionId, new Map([[windowId, consumer]]))
    else target.set(windowId, consumer)
    if (initialData) {
      consumer.chunks.push(initialData)
      this.addPending(consumer, initialData.length)
      this.schedule(consumer, 16)
      this.updatePause(sessionId)
    }
    return subscriptionId
  }

  append(sessionId: string, data: string): void {
    if (!data || this.disposed) return
    const group = this.consumers.get(sessionId)
    if (!group) return // 无图形消费者的 MCP 会话不创建输出积压。
    for (const consumer of [...group.values()]) {
      if (consumer.pending + data.length > TERMINAL_OUTPUT_MAX_PENDING) {
        // 原生流暂停后仍可能有迟到数据；明确报告过载，不能悄悄丢弃或无限堆积。
        this.stats.overflow += 1
        this.failConsumer(consumer, 'overflow')
        continue
      }
      consumer.chunks.push(data)
      this.addPending(consumer, data.length)
      this.schedule(consumer, 16)
    }
    this.enforceQueueBudget(sessionId)
    this.updatePause(sessionId)
  }

  acknowledge(windowId: number, sessionId: string, subscriptionId: string, sequence: number): void {
    if (this.disposed) return
    const consumer = this.consumers.get(sessionId)?.get(windowId)
    // 旧订阅/旧序号的 ACK 一律无效；重复 ACK 因 inFlight 已清而自然失效。
    if (!consumer || consumer.subscriptionId !== subscriptionId || !consumer.inFlight || consumer.sequence !== sequence) return
    this.clearAckTimer(consumer)
    this.addPending(consumer, -consumer.inFlightSize)
    consumer.inFlightSize = 0
    consumer.inFlight = false
    this.schedule(consumer, 0)
    this.updatePause(sessionId)
  }

  remove(windowId: number, sessionId: string, subscriptionId?: string): void {
    const group = this.consumers.get(sessionId)
    const consumer = group?.get(windowId)
    if (!consumer || (subscriptionId !== undefined && consumer.subscriptionId !== subscriptionId)) return
    this.clearTimers(consumer)
    this.addPending(consumer, -consumer.pending)
    group!.delete(windowId)
    if (!group!.size) this.consumers.delete(sessionId)
    this.updatePause(sessionId)
  }

  removeWindow(windowId: number): void {
    for (const sessionId of [...this.consumers.keys()]) this.remove(windowId, sessionId)
  }

  removeSession(sessionId: string): void {
    for (const consumer of [...(this.consumers.get(sessionId)?.values() ?? [])]) this.remove(consumer.windowId, sessionId)
  }

  invalidateHistory(sessionId: string): void {
    for (const consumer of [...(this.consumers.get(sessionId)?.values() ?? [])]) this.failConsumer(consumer, 'history-gap')
  }

  /** 新 connector 替换旧输入源时，继承尚未消费完成的输出背压。 */
  refreshPause(sessionId: string): void {
    this.setPaused(sessionId, this.paused.has(sessionId))
  }

  /**
   * 销毁调度器：撤销全部消费者、清理全部定时器、解除所有 PTY 暂停。
   * 销毁后旧 ACK 全部无效，subscribe 会抛错。
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const sessionId of [...this.consumers.keys()]) {
      for (const consumer of [...(this.consumers.get(sessionId)?.values() ?? [])]) {
        this.failConsumer(consumer, 'disposed')
      }
    }
    this.consumers.clear()
    this.paused.clear()
    this.totalPending = 0
  }

  /** 只读诊断快照（不改变任何状态） */
  getSnapshot(): TerminalOutputDispatcherSnapshot {
    const sessions: TerminalOutputDispatcherSnapshot['sessions'] = []
    let consumerCount = 0
    let totalPending = 0
    for (const [sessionId, group] of this.consumers) {
      let pending = 0
      for (const consumer of group.values()) pending += consumer.pending
      consumerCount += group.size
      totalPending += pending
      sessions.push({ sessionId, consumers: group.size, pending, paused: this.paused.has(sessionId) })
    }
    return {
      disposed: this.disposed,
      consumerCount,
      sessionCount: this.consumers.size,
      totalPending,
      globalQueueBudget: this.limits.globalQueueBudget,
      maxConsumers: this.limits.maxConsumers,
      ackTimeoutMs: this.limits.ackTimeoutMs,
      pausedSessions: this.paused.size,
      sessions,
      diagnostics: { ...this.stats }
    }
  }

  private countConsumers(): number {
    let count = 0
    for (const group of this.consumers.values()) count += group.size
    return count
  }

  private addPending(consumer: Consumer, delta: number): void {
    consumer.pending += delta
    if (consumer.pending < 0) consumer.pending = 0
    this.totalPending += delta
    if (this.totalPending < 0) this.totalPending = 0
  }

  /** 通知消费者失效：先摘除（清定时器/释放背压），再发一帧错误回执 */
  private failConsumer(consumer: Consumer, error: TerminalOutputReceiptError): void {
    const { windowId, sessionId, subscriptionId } = consumer
    const sequence = consumer.sequence + 1
    this.remove(windowId, sessionId, subscriptionId)
    this.sendError(consumer.send, subscriptionId, sequence, error)
  }

  private sendError(
    send: Consumer['send'],
    subscriptionId: string,
    sequence: number,
    error: TerminalOutputReceiptError
  ): void {
    try {
      send('', { subscriptionId, sequence, error })
    } catch { /* 窗口已销毁，错误自然无人接收 */ }
  }

  /** 全局队列预算：撤销本会话中积压最大的消费者，直到回到预算内 */
  private enforceQueueBudget(sessionId: string): void {
    if (this.totalPending <= this.limits.globalQueueBudget) return
    const group = this.consumers.get(sessionId)
    if (!group) return
    const ordered = [...group.values()].sort((a, b) => b.pending - a.pending)
    for (const consumer of ordered) {
      if (this.totalPending <= this.limits.globalQueueBudget) break
      // 前面的消费者被撤销时可能已经连带移除同会话的其他消费者，这里只处理仍存活的。
      if (this.consumers.get(sessionId)?.get(consumer.windowId) !== consumer) continue
      this.stats.queueBudget += 1
      this.failConsumer(consumer, 'queue-budget')
    }
  }

  private schedule(consumer: Consumer, delay: number): void {
    if (consumer.timer !== undefined || consumer.inFlight || !consumer.pending) return
    consumer.timer = setTimeout(() => {
      consumer.timer = undefined
      this.flush(consumer)
    }, delay)
  }

  private clearAckTimer(consumer: Consumer): void {
    if (consumer.ackTimer !== undefined) {
      clearTimeout(consumer.ackTimer)
      consumer.ackTimer = undefined
    }
  }

  private clearTimers(consumer: Consumer): void {
    if (consumer.timer !== undefined) {
      clearTimeout(consumer.timer)
      consumer.timer = undefined
    }
    this.clearAckTimer(consumer)
  }

  /**
   * 在途帧的 ACK 有界等待：超时即撤销消费者，并解除它造成的背压。
   * 只有当前存活的消费者且仍在等待该序号时才生效。
   */
  private armAckTimer(consumer: Consumer, sequence: number): void {
    this.clearAckTimer(consumer)
    consumer.ackTimer = setTimeout(() => {
      consumer.ackTimer = undefined
      const current = this.consumers.get(consumer.sessionId)?.get(consumer.windowId)
      if (current !== consumer || !consumer.inFlight || consumer.sequence !== sequence) return
      this.stats.ackTimeouts += 1
      this.failConsumer(consumer, 'ack-timeout')
    }, this.limits.ackTimeoutMs)
  }

  private flush(consumer: Consumer): void {
    if (this.consumers.get(consumer.sessionId)?.get(consumer.windowId) !== consumer || consumer.inFlight) return
    let remaining = TERMINAL_OUTPUT_PACKET_SIZE
    const parts: string[] = []
    while (remaining && consumer.head < consumer.chunks.length) {
      const chunk = consumer.chunks[consumer.head]
      const take = Math.min(remaining, chunk.length - consumer.offset)
      parts.push(chunk.slice(consumer.offset, consumer.offset + take))
      consumer.offset += take
      remaining -= take
      if (consumer.offset === chunk.length) {
        consumer.chunks[consumer.head++] = ''
        consumer.offset = 0
      }
    }
    if (consumer.head > 64) {
      consumer.chunks = consumer.chunks.slice(consumer.head)
      consumer.head = 0
    }
    const data = parts.join('')
    if (!data) return
    // pending 包括在途数据，直到渲染层确认完成才扣减。
    const sequence = ++consumer.sequence
    consumer.inFlight = true
    const size = data.length
    // 在途长度独立存储，ACK 不接受客户端自行上报的字节数。
    consumer.inFlightSize = size
    try {
      consumer.send(data, { subscriptionId: consumer.subscriptionId, sequence })
    } catch {
      this.stats.sendFailures += 1
      this.failConsumer(consumer, 'send-failed')
      return
    }
    this.armAckTimer(consumer, sequence)
  }

  private updatePause(sessionId: string): void {
    const group = this.consumers.get(sessionId)
    const max = Math.max(0, ...[...(group?.values() ?? [])].map(c => c.pending))
    const wasPaused = this.paused.has(sessionId)
    const pause = wasPaused ? max > TERMINAL_OUTPUT_LOW_WATER : max >= TERMINAL_OUTPUT_HIGH_WATER
    if (pause === wasPaused) return
    if (pause) this.paused.add(sessionId)
    else this.paused.delete(sessionId)
    this.setPaused(sessionId, pause)
  }
}
