import type { ServerResponse } from 'http'

export const MAX_COMMAND_STREAM_QUEUE_BYTES = 256 * 1024
const DRAIN_TIMEOUT_MS = 5000

/** 慢消费者最多暂存 256 KiB；超过容量或 drain 预算时关闭响应并取消执行。 */
export class CommandStreamWriter {
  private queue: string[] = []
  private queuedBytes = 0
  private blocked = false
  private closed = false
  private timer?: ReturnType<typeof setTimeout>
  private waiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = []

  constructor(private res: ServerResponse, private abort: AbortController) {
    res.on('drain', this.onDrain)
    res.on('close', this.onClose)
    res.on('error', this.onClose)
  }

  chunk(chunk: string): void {
    for (let offset = 0; offset < chunk.length; offset += 4096) {
      this.event({ type: 'chunk', chunk: chunk.slice(offset, offset + 4096) })
    }
  }

  event(value: Record<string, unknown>): void {
    if (this.closed || this.res.destroyed || this.res.writableEnded) throw new Error('Command stream closed')
    const frame = `data: ${JSON.stringify(value)}\n\n`
    const bytes = Buffer.byteLength(frame)
    if (this.queuedBytes + bytes > MAX_COMMAND_STREAM_QUEUE_BYTES) {
      this.fail(new Error('Command stream consumer too slow'))
      throw new Error('Command stream consumer too slow')
    }
    this.queue.push(frame)
    this.queuedBytes += bytes
    this.flush()
  }

  private flush(): void {
    while (!this.blocked && this.queue.length && !this.closed) {
      const frame = this.queue.shift()!
      this.queuedBytes -= Buffer.byteLength(frame)
      let writable: boolean
      try { writable = this.res.write(frame) } catch (error) { this.fail(error as Error); return }
      if (!writable) {
        this.blocked = true
        this.timer = setTimeout(() => this.fail(new Error('Command stream drain timeout')), DRAIN_TIMEOUT_MS)
      }
    }
    if (!this.blocked && !this.queue.length) this.waiters.splice(0).forEach(waiter => waiter.resolve())
  }

  private onDrain = (): void => {
    clearTimeout(this.timer)
    this.blocked = false
    this.flush()
  }

  private onClose = (): void => { this.fail(new Error('Command stream closed')) }

  private fail(error: Error): void {
    if (this.closed) return
    this.dispose()
    this.abort.abort()
    this.waiters.splice(0).forEach(waiter => waiter.reject(error))
    this.res.destroy()
  }

  async finish(value: Record<string, unknown>): Promise<void> {
    if (this.closed) throw new Error('Command stream closed')
    if (this.blocked || this.queue.length) await new Promise<void>((resolve, reject) => this.waiters.push({ resolve, reject }))
    if (this.closed) throw new Error('Command stream closed')
    // 最终结果受命令 1 Mi 字符硬上限约束，只写一次；此后不再排队输出。
    try { this.res.end(`data: ${JSON.stringify(value)}\n\n`) }
    finally { this.dispose() }
  }

  private dispose(): void {
    this.closed = true
    clearTimeout(this.timer)
    this.queue = []
    this.queuedBytes = 0
    this.res.removeListener('drain', this.onDrain)
    this.res.removeListener('close', this.onClose)
    this.res.removeListener('error', this.onClose)
  }
}
