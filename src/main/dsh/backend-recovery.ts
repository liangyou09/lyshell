/** 仅恢复进程，不提交任务。网络超时/模型慢不能触发本状态机。 */
export class BackendRecovery {
  private timer: ReturnType<typeof setTimeout> | null = null
  private generation = 0
  private failures: number[] = []
  private stopped = false
  private readyAt = 0
  private phase: 'idle' | 'waiting' | 'starting' | 'exhausted' | 'stopped' = 'idle'

  constructor(private readonly options: {
    now?: () => number; delays?: readonly number[]; windowMs?: number; stableMs?: number
  } = {}) {}

  snapshot(): { phase: string; attempts: number } {
    return { phase: this.phase, attempts: this.failures.length }
  }

  ready(): void { this.readyAt = this.now(); this.phase = 'idle' }

  /** 用户显式启动才重置预算；一次短暂 ready 不会重置崩溃循环计数。 */
  reset(): void {
    this.stop()
    this.stopped = false; this.failures = []; this.readyAt = 0; this.phase = 'idle'
  }

  stop(): void {
    this.stopped = true; this.generation++
    if (this.timer) clearTimeout(this.timer)
    this.timer = null; this.phase = 'stopped'
  }

  schedule(restart: () => Promise<boolean>): boolean {
    if (this.stopped || this.timer || this.phase === 'starting') return false
    const now = this.now()
    if (this.readyAt && now - this.readyAt >= (this.options.stableMs ?? 120_000)) this.failures = []
    this.readyAt = 0
    this.failures = this.failures.filter(at => now - at < (this.options.windowMs ?? 300_000))
    const delays = this.options.delays ?? [1000, 3000, 10_000]
    if (this.failures.length >= delays.length) { this.phase = 'exhausted'; return false }
    const delay = delays[this.failures.length]
    this.failures.push(now)
    const generation = this.generation
    this.phase = 'waiting'
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.stopped || generation !== this.generation) return
      this.phase = 'starting'
      void restart().catch(() => false).then(ok => {
        if (this.stopped || generation !== this.generation) return
        if (ok) this.ready()
        else { this.phase = 'idle'; this.schedule(restart) }
      })
    }, delay)
    this.timer.unref?.()
    return true
  }

  private now(): number { return (this.options.now ?? Date.now)() }
}

/** 日志只保留固定错误分类；不持久化 provider 文本、URL、命令或环境变量。 */
export function harnessExitEvidence(stderr: string): { stderrBytes: number; errorCodes: string[] } {
  const codes = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EADDRINUSE', 'ENOMEM', 'EPIPE', 'EACCES', 'EPERM', 'ENOSPC',
    'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED', 'SyntaxError', 'TypeError',
    'ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ERR_OUT_OF_RANGE', 'JavaScript heap out of memory',
    'journal/corrupt', 'journal/invalid-state', 'journal/unsafe-path', 'journal/io', 'journal/too-large']
  return { stderrBytes: Buffer.byteLength(stderr), errorCodes: codes.filter(code => stderr.includes(code)) }
}
