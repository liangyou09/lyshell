import { randomUUID } from 'crypto'
import {
  TERMINAL_OUTPUT_PACKET_SIZE, TERMINAL_OUTPUT_HIGH_WATER,
  TERMINAL_OUTPUT_LOW_WATER, TERMINAL_OUTPUT_MAX_PENDING,
  type TerminalOutputReceipt
} from '@shared/terminal-output'

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
  timer?: ReturnType<typeof setTimeout>
}

/** 每个窗口/会话最多一包 IPC 在途；慢消费者把背压传播到真实输入源。 */
export class TerminalOutputDispatcher {
  private consumers = new Map<string, Map<number, Consumer>>()
  private paused = new Set<string>()

  constructor(private setPaused: (sessionId: string, paused: boolean) => void) {}

  subscribe(windowId: number, sessionId: string, send: Consumer['send'], initialData = ''): string {
    if (initialData.length > TERMINAL_OUTPUT_MAX_PENDING) throw new Error('Initial terminal output exceeds buffer limit')
    this.remove(windowId, sessionId)
    const consumer: Consumer = {
      windowId, sessionId, send, subscriptionId: randomUUID(), chunks: [],
      head: 0, offset: 0, pending: 0, sequence: 0, inFlight: false, inFlightSize: 0
    }
    let group = this.consumers.get(sessionId)
    if (!group) this.consumers.set(sessionId, group = new Map())
    group.set(windowId, consumer)
    if (initialData) {
      consumer.chunks.push(initialData)
      consumer.pending = initialData.length
      this.schedule(consumer, 16)
      this.updatePause(sessionId)
    }
    return consumer.subscriptionId
  }

  append(sessionId: string, data: string): void {
    if (!data) return
    const group = this.consumers.get(sessionId)
    if (!group) return // 无图形消费者的 MCP 会话不创建输出积压。
    for (const consumer of [...group.values()]) {
      if (consumer.pending + data.length > TERMINAL_OUTPUT_MAX_PENDING) {
        // 原生流暂停后仍可能有迟到数据；明确报告过载，不能悄悄丢弃或无限堆积。
        this.remove(consumer.windowId, sessionId, consumer.subscriptionId)
        try { consumer.send('', { subscriptionId: consumer.subscriptionId, sequence: ++consumer.sequence, error: 'overflow' }) } catch { /* 窗口已销毁 */ }
        continue
      }
      consumer.chunks.push(data)
      consumer.pending += data.length
      this.schedule(consumer, 16)
    }
    this.updatePause(sessionId)
  }

  acknowledge(windowId: number, sessionId: string, subscriptionId: string, sequence: number): void {
    const consumer = this.consumers.get(sessionId)?.get(windowId)
    if (!consumer || consumer.subscriptionId !== subscriptionId || !consumer.inFlight || consumer.sequence !== sequence) return
    consumer.pending -= consumer.inFlightSize
    consumer.inFlightSize = 0
    consumer.inFlight = false
    this.schedule(consumer, 0)
    this.updatePause(sessionId)
  }

  remove(windowId: number, sessionId: string, subscriptionId?: string): void {
    const group = this.consumers.get(sessionId)
    const consumer = group?.get(windowId)
    if (!consumer || (subscriptionId !== undefined && consumer.subscriptionId !== subscriptionId)) return
    clearTimeout(consumer.timer)
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

  /** 新 connector 替换旧输入源时，继承尚未消费完成的输出背压。 */
  refreshPause(sessionId: string): void {
    this.setPaused(sessionId, this.paused.has(sessionId))
  }

  private schedule(consumer: Consumer, delay: number): void {
    if (consumer.timer !== undefined || consumer.inFlight || !consumer.pending) return
    consumer.timer = setTimeout(() => {
      consumer.timer = undefined
      this.flush(consumer)
    }, delay)
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
    try { consumer.send(data, { subscriptionId: consumer.subscriptionId, sequence }) }
    catch { this.remove(consumer.windowId, consumer.sessionId, consumer.subscriptionId) }
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
