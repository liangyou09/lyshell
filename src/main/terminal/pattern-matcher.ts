/**
 * 有界隔离匹配池 —— 外部 wait pattern 的唯一执行入口。
 *
 * 设计要点（对应计划 R1 3.3 与主代理核对项）：
 *   - **主线程不编译、不执行外部正则**：全部交给 `pattern-worker.ts` 的 Worker 线程。
 *   - **只向 ready 且健康的 Worker 派发**：Worker 首帧 `ready` 之前任务留在队列里；
 *     `ready` 才触发派发。冷启动有独立的 2s 期限，不占用 100ms 执行期限。
 *   - **100ms 执行期限从 ready 后 `postMessage` 起算**（覆盖 Worker 内编译 + 匹配）。
 *   - **退出确认后才归还容量**：terminate 之后等 `exit` 事件；等不到就一直占着槽位并计入
 *     `unavailableSlots`，不会无限重建 Worker 来「假装恢复」。
 *   - **terminate 前先标 stopping**：`finish()` 内的 pump 不会把新任务派给仍在跑旧正则的
 *     Worker；终止中 Worker 持有的输入快照预算保留到 exit 确认后才归还。
 *   - **迟到消息丢弃**：按 `jobId + generation` 双重核对，旧代际/已结算任务的回包只计数不生效。
 *   - **shutdown**：拒绝新任务、拒结排队、terminate 在途、清理定时器与监听。
 */
import { Worker } from 'worker_threads'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  PATTERN_LIMITS,
  PATTERN_WORKER_PROTOCOL,
  PatternMatchError,
  isPatternWorkerResponse,
  validateMatchInputs,
  validatePatternSpec,
  type MatchMode,
  type PatternFailureReason,
  type PatternLimits,
  type PatternSpec,
  type PatternWorkerRequest
} from './pattern-contract'

/** 覆盖 Worker 脚本路径（仅测试/诊断；生产走 `dist/main/patternWorker.js`）。 */
export const PATTERN_WORKER_SCRIPT_ENV = 'LYSHELL_PATTERN_WORKER_SCRIPT'

/**
 * Worker 启动失败后的冷却窗口：期间不再重建 Worker，让排队任务按期限快速失败，
 * 避免「脚本缺失/加载即崩」时在队列期限内无界重建。
 */
const WORKER_START_COOLDOWN_MS = 1_000

export interface PatternMatcherOptions {
  workerScriptPath?: string
  limits?: Partial<PatternLimits>
}

export interface MatchRequest {
  spec: PatternSpec
  /** 待匹配基底，按顺序；通常 [rawOutput, cleanOutput] */
  inputs: string[]
  /** 可信主体键（凭据 id / principalId），不接受请求体自报身份 */
  callerKey: string
  /** 总期限（含排队），默认 `PATTERN_LIMITS.defaultQueueTimeoutMs` */
  timeoutMs?: number
  signal?: AbortSignal
}

export interface MatchResult {
  matched: boolean
  /** 命中的基底下标；未命中 -1 */
  matchedIndex: number
  elapsedMs: number
  pattern: string
  mode: MatchMode
}

/**
 * 「等待器」租约：配额覆盖调用方的**整个**等待过程（sendAndWait / waitForPattern），
 * 而不是某个短暂的 `match()` Promise。`release()` 幂等。
 */
export interface WaiterLease {
  readonly callerKey: string
  release(): void
}

export interface PatternMatcherDiagnostics {
  workers: number
  readyWorkers: number
  idleWorkers: number
  queued: number
  inflight: number
  reservedChars: number
  waiters: number
  callers: number
  spawned: number
  startFailures: number
  timeouts: number
  terminations: number
  lateMessages: number
  failures: number
  unavailableSlots: number
  closed: boolean
}

type JobKind = 'compile' | 'match'

interface PatternJob {
  id: string
  kind: JobKind
  pattern: string
  mode: MatchMode
  inputs: string[]
  inputChars: number
  callerKey: string
  /** 单调时钟下的总期限 */
  deadline: number
  queueTimer: NodeJS.Timeout | null
  execTimer: NodeJS.Timeout | null
  /** execTimer 触发时应报的原因（总期限先到 = 排队超时，否则 = 执行超时） */
  execTimeoutReason: PatternFailureReason | null
  settled: boolean
  dispatched: boolean
  signal?: AbortSignal
  abortListener?: () => void
  resolve: (result: InternalMatchResult) => void
  reject: (error: PatternMatchError) => void
}

interface InternalMatchResult {
  matched: boolean
  matchedIndex: number
  elapsedMs: number
}

type JobOutcome = { result: InternalMatchResult } | { error: PatternMatchError }

interface WorkerSlot {
  worker: Worker
  /** 每个 Worker 一份严格递增的代际，回包必须与之一致 */
  generation: number
  job: PatternJob | null
  ready: boolean
  /** 已禁止派发，正在（或已经）terminate */
  stopping: boolean
  /** 已经发起过 terminate（幂等标记，不参与对外诊断） */
  terminating: boolean
  exited: boolean
  released: boolean
  startTimer: NodeJS.Timeout | null
  exitTimer: NodeJS.Timeout | null
  /** 终止中仍被这个 Worker 持有的输入快照预算，exit 确认后才归还 */
  retainedChars: number
  unavailableCounted?: boolean
  exitPromise: Promise<void>
  resolveExit: () => void
}

function now(): number {
  return performance.now()
}

function normalizeCallerKey(value: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed.length > 0 ? trimmed.slice(0, 128) : 'caller:unknown'
}

function resolveWorkerScriptPath(explicit?: string): string {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  const override = process.env[PATTERN_WORKER_SCRIPT_ENV]
  if (typeof override === 'string' && override.trim().length > 0) return override
  const dir = typeof __dirname === 'string' && __dirname.length > 0 ? __dirname : process.cwd()
  return join(dir, 'patternWorker.js')
}

/** 有界、可终止、可关闭的隔离匹配器。生产使用文件末尾的单例 `patternMatcher`。 */
export class PatternMatcher {
  readonly limits: PatternLimits
  private readonly workerScriptPath: string
  private readonly slots: WorkerSlot[] = []
  private readonly queue: PatternJob[] = []
  private readonly callers = new Map<string, number>()
  private readonly inflight = new Map<string, number>()
  private waiters = 0
  private reservedChars = 0
  private workerGeneration = 0
  private jobCounter = 0
  private closed = false
  private spawned = 0
  private startFailures = 0
  private startBlockedUntil = 0
  private lastServedCaller = ''
  private timeouts = 0
  private terminations = 0
  private lateMessages = 0
  private failures = 0
  private unavailableSlots = 0

  constructor(options: PatternMatcherOptions = {}) {
    this.limits = { ...PATTERN_LIMITS, ...options.limits }
    this.workerScriptPath = resolveWorkerScriptPath(options.workerScriptPath)
  }

  /** 同步形态/长度/模式校验；不编译正则。 */
  validate(spec: PatternSpec): { pattern: string; mode: MatchMode } {
    return validatePatternSpec(spec, this.limits)
  }

  /**
   * 取一个「等待器」租约：全局与每主体配额覆盖整个等待调用。
   * 配额不足时同步抛 `MATCH_QUEUE_FULL`（RESOURCE_LIMIT/safe），调用方此时还没有任何副作用。
   */
  acquireWaiter(rawCallerKey: string): WaiterLease {
    if (this.closed) throw new PatternMatchError('MATCH_SERVICE_SHUTDOWN')
    const callerKey = normalizeCallerKey(rawCallerKey)
    if ((this.callers.get(callerKey) ?? 0) >= this.limits.maxWaitersPerCaller) {
      throw new PatternMatchError('MATCH_QUEUE_FULL')
    }
    if (this.waiters >= this.limits.maxWaiters) throw new PatternMatchError('MATCH_QUEUE_FULL')
    this.waiters++
    this.callers.set(callerKey, (this.callers.get(callerKey) ?? 0) + 1)
    let released = false
    return {
      callerKey,
      release: (): void => {
        if (released) return
        released = true
        this.waiters = Math.max(0, this.waiters - 1)
        const remaining = (this.callers.get(callerKey) ?? 0) - 1
        if (remaining > 0) this.callers.set(callerKey, remaining)
        else this.callers.delete(callerKey)
      }
    }
  }

  /** 在 Worker 内编译验证；失败说明没有可用语法，调用方不得写终端。 */
  async compile(spec: PatternSpec, options: { callerKey: string; timeoutMs?: number; signal?: AbortSignal }): Promise<void> {
    const normalized = this.validate(spec)
    await this.enqueue('compile', normalized.pattern, normalized.mode, [], 0, options.callerKey, options.timeoutMs, options.signal)
  }

  /** 在 Worker 内编译 + 匹配；永不回退到主线程执行。 */
  async match(request: MatchRequest): Promise<MatchResult> {
    const normalized = this.validate(request.spec)
    const inputChars = validateMatchInputs(request.inputs, this.limits)
    const result = await this.enqueue(
      'match',
      normalized.pattern,
      normalized.mode,
      request.inputs,
      inputChars,
      request.callerKey,
      request.timeoutMs,
      request.signal
    )
    return {
      matched: result.matched,
      matchedIndex: result.matchedIndex,
      elapsedMs: result.elapsedMs,
      pattern: normalized.pattern,
      mode: normalized.mode
    }
  }

  diagnostics(): PatternMatcherDiagnostics {
    let inflight = 0
    for (const count of this.inflight.values()) inflight += count
    return {
      workers: this.slots.length,
      readyWorkers: this.slots.filter(slot => slot.ready && !slot.stopping && !slot.exited).length,
      idleWorkers: this.slots.filter(slot => slot.ready && !slot.stopping && !slot.exited && slot.job === null).length,
      queued: this.queue.length,
      inflight,
      reservedChars: this.reservedChars,
      waiters: this.waiters,
      callers: this.callers.size,
      spawned: this.spawned,
      startFailures: this.startFailures,
      timeouts: this.timeouts,
      terminations: this.terminations,
      lateMessages: this.lateMessages,
      failures: this.failures,
      unavailableSlots: this.unavailableSlots,
      closed: this.closed
    }
  }

  /** 关闭：拒绝新任务、拒结排队任务、terminate 在途 Worker；返回退出确认结果。 */
  async shutdown(): Promise<{ confirmedExits: number; unconfirmedExits: number }> {
    if (this.closed && this.slots.length === 0 && this.queue.length === 0) {
      return { confirmedExits: 0, unconfirmedExits: 0 }
    }
    this.closed = true
    for (const job of [...this.queue]) {
      this.finish(job, { error: new PatternMatchError('MATCH_SERVICE_SHUTDOWN') })
    }
    const slots = [...this.slots]
    for (const slot of slots) {
      // 先禁止派发，再结算在途任务，最后 terminate（顺序与超时路径一致）。
      slot.stopping = true
      if (slot.job) this.finish(slot.job, { error: new PatternMatchError('MATCH_SERVICE_SHUTDOWN') })
      this.terminateSlot(slot)
    }
    let deadlineTimer: NodeJS.Timeout | null = null
    if (slots.length > 0) {
      await Promise.race([
        Promise.all(slots.map(slot => slot.exitPromise)),
        new Promise<void>(resolve => {
          deadlineTimer = setTimeout(resolve, Math.max(0, this.limits.workerExitDeadlineMs))
          deadlineTimer.unref?.()
        })
      ])
      if (deadlineTimer) {
        clearTimeout(deadlineTimer)
        deadlineTimer = null
      }
    }
    for (const slot of slots) {
      if (slot.exited) this.releaseSlot(slot)
    }
    this.queue.length = 0
    const confirmedExits = slots.filter(slot => slot.exited).length
    return { confirmedExits, unconfirmedExits: slots.length - confirmedExits }
  }

  // ── 入队与预算 ──────────────────────────────────────────────────────────────

  private enqueue(
    kind: JobKind,
    pattern: string,
    mode: MatchMode,
    inputs: string[],
    inputChars: number,
    rawCallerKey: string,
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined
  ): Promise<InternalMatchResult> {
    if (this.closed) return Promise.reject(new PatternMatchError('MATCH_SERVICE_SHUTDOWN'))
    if (signal?.aborted) return Promise.reject(new PatternMatchError('MATCH_CANCELLED'))

    const callerKey = normalizeCallerKey(rawCallerKey)
    if (this.reservedChars + inputChars > this.limits.reservedInputChars) {
      return Promise.reject(new PatternMatchError('MATCH_INPUT_TOO_LARGE'))
    }
    if (this.queue.length >= this.limits.maxQueuedJobs) {
      return Promise.reject(new PatternMatchError('MATCH_QUEUE_FULL'))
    }

    const budgetMs = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : this.limits.defaultQueueTimeoutMs

    return new Promise<InternalMatchResult>((resolve, reject) => {
      const job: PatternJob = {
        id: `pattern-job-${++this.jobCounter}`,
        kind,
        pattern,
        mode,
        inputs,
        inputChars,
        callerKey,
        deadline: now() + budgetMs,
        queueTimer: null,
        execTimer: null,
        execTimeoutReason: null,
        settled: false,
        dispatched: false,
        signal,
        resolve,
        reject
      }
      this.reservedChars += inputChars
      job.queueTimer = setTimeout(() => this.onQueueDeadline(job), Math.max(1, budgetMs))
      job.queueTimer.unref?.()
      if (signal) {
        job.abortListener = () => this.cancelJob(job)
        signal.addEventListener('abort', job.abortListener, { once: true })
      }
      this.queue.push(job)
      this.pump()
    })
  }

  private onQueueDeadline(job: PatternJob): void {
    if (job.settled) return
    job.queueTimer = null
    this.timeouts++
    const slot = this.slots.find(candidate => candidate.job === job)
    if (slot) this.stopAndFinish(slot, job, new PatternMatchError('MATCH_QUEUE_TIMEOUT'))
    else this.finish(job, { error: new PatternMatchError('MATCH_QUEUE_TIMEOUT') })
  }

  private cancelJob(job: PatternJob): void {
    if (job.settled) return
    const slot = this.slots.find(candidate => candidate.job === job) ?? null
    if (slot) {
      // 在途任务：先禁止派发再结算，最后 terminate（容量等 exit 确认）。
      slot.stopping = true
      this.finish(job, { error: new PatternMatchError('MATCH_CANCELLED') })
      this.terminateSlot(slot)
      return
    }
    this.finish(job, { error: new PatternMatchError('MATCH_CANCELLED') })
  }

  // ── 派发 ────────────────────────────────────────────────────────────────────

  private pump(): void {
    if (this.closed) return
    while (this.queue.length > 0) {
      const slot = this.acquireReadySlot()
      if (slot === 'failed') {
        // Worker 根本起不来（脚本缺失/创建抛错）：快速失败，不让调用方白等到期限。
        this.failQueue(new PatternMatchError('MATCH_WORKER_START_FAILED'))
        return
      }
      if (slot === 'waiting') return
      const job = this.takeNextJob()
      if (!job) return
      this.dispatch(slot, job)
    }
  }

  /**
   * 公平出队：同主体同时只允许 1 个在途任务；并优先轮换到「上一次没被服务」的主体，
   * 避免一个调用方的长队列把其他调用方饿死。
   */
  private takeNextJob(): PatternJob | null {
    let fallback = -1
    for (let index = 0; index < this.queue.length; index++) {
      const job = this.queue[index]
      if ((this.inflight.get(job.callerKey) ?? 0) > 0) continue
      if (job.callerKey !== this.lastServedCaller) return this.queue.splice(index, 1)[0]
      if (fallback < 0) fallback = index
    }
    if (fallback >= 0) return this.queue.splice(fallback, 1)[0]
    return null
  }

  /**
   * 只返回 **ready 且健康** 的槽位；没有就创建一个并等待它的 `ready` 帧（返回 'waiting'）。
   * `'failed'` 表示 Worker 创建直接抛错，调用方应立即失败排队任务。
   */
  private acquireReadySlot(): WorkerSlot | 'waiting' | 'failed' {
    const ready = this.slots.find(slot => slot.ready && !slot.stopping && !slot.exited && slot.job === null)
    if (ready) return ready
    if (this.slots.length >= this.limits.maxWorkers) return 'waiting'
    // 启动冷却：反复失败时不在队列期限内无界重建。
    if (now() < this.startBlockedUntil) {
      // 冷却期内且没有任何仍在启动的 Worker：直接按「启动失败」快速返回，
      // 不让调用方把启动故障误当成排队超时一直等到自己的期限。
      const starting = this.slots.some(slot => !slot.stopping && !slot.exited && !slot.released)
      return starting ? 'waiting' : 'failed'
    }
    const created = this.createSlot()
    if (!created) return 'failed'
    return 'waiting'
  }

  private createSlot(): WorkerSlot | null {
    let worker: Worker
    try {
      // resourceLimits 只是 V8 堆上限的软边界，不是 RSS 上限；真正的边界是池大小 + 输入预算 + 硬超时。
      worker = new Worker(this.workerScriptPath, {
        workerData: { protocol: PATTERN_WORKER_PROTOCOL },
        resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 }
      })
    } catch {
      this.failures++
      this.onStartFailure()
      return null
    }
    let resolveExit: () => void = () => {}
    const exitPromise = new Promise<void>(resolve => { resolveExit = resolve })
    const slot: WorkerSlot = {
      worker,
      generation: ++this.workerGeneration,
      job: null,
      ready: false,
      stopping: false,
      terminating: false,
      exited: false,
      released: false,
      startTimer: null,
      exitTimer: null,
      retainedChars: 0,
      exitPromise,
      resolveExit
    }
    worker.on('message', (message: unknown) => this.onMessage(slot, message))
    worker.on('error', () => this.onWorkerError(slot))
    worker.on('exit', () => this.onWorkerExit(slot))
    slot.startTimer = setTimeout(() => this.onStartDeadline(slot), this.limits.workerStartDeadlineMs)
    slot.startTimer.unref?.()
    this.slots.push(slot)
    this.spawned++
    return slot
  }

  private onStartFailure(): void {
    this.startFailures++
    this.startBlockedUntil = now() + WORKER_START_COOLDOWN_MS
  }

  private dispatch(slot: WorkerSlot, job: PatternJob): void {
    job.dispatched = true
    slot.job = job
    this.lastServedCaller = job.callerKey
    this.inflight.set(job.callerKey, (this.inflight.get(job.callerKey) ?? 0) + 1)

    const remaining = job.deadline - now()
    if (remaining <= 0) {
      this.timeouts++
      this.finish(job, { error: new PatternMatchError('MATCH_QUEUE_TIMEOUT') })
      return
    }
    // 执行期限从 ready 后 postMessage 起算；与总期限分别计算，哪个先到就按哪个报错。
    const execBudget = Math.min(this.limits.matchDeadlineMs, remaining)
    job.execTimeoutReason = remaining <= this.limits.matchDeadlineMs ? 'MATCH_QUEUE_TIMEOUT' : 'MATCH_EXECUTION_TIMEOUT'
    job.execTimer = setTimeout(() => this.onExecDeadline(slot, job), Math.max(1, execBudget))
    job.execTimer.unref?.()

    const request: PatternWorkerRequest = job.kind === 'compile'
      ? { type: 'compile', jobId: job.id, generation: slot.generation, pattern: job.pattern, mode: job.mode }
      : { type: 'match', jobId: job.id, generation: slot.generation, pattern: job.pattern, mode: job.mode, inputs: job.inputs }
    try {
      slot.worker.postMessage(request)
    } catch {
      this.onWorkerError(slot)
    }
  }

  private onExecDeadline(slot: WorkerSlot, job: PatternJob): void {
    if (job.settled) return
    job.execTimer = null
    this.timeouts++
    this.stopAndFinish(slot, job, new PatternMatchError(job.execTimeoutReason ?? 'MATCH_EXECUTION_TIMEOUT'))
  }

  /**
   * 统一的「先禁止派发 → 结算任务 → terminate」路径。
   * 顺序很关键：`finish()` 会 pump，若此时还允许向本槽位派发，新任务就会落进
   * 仍在执行旧正则的 Worker，随后被 terminate 一起杀掉。
   */
  private stopAndFinish(slot: WorkerSlot, job: PatternJob | null, error: PatternMatchError): void {
    const startupFailure = !slot.ready
    slot.stopping = true
    if (job) this.finish(job, { error })
    this.terminateSlot(slot)
    // 启动失败且池里已没有能服务的 Worker：队列立刻失败，别把「起不来」拖成排队超时。
    if (startupFailure) this.failQueueIfStartupBlocked()
  }

  /**
   * 启动失败后若池里已无任何仍可能提供服务的 Worker，队列任务立即以启动失败结束。
   * 有正在启动的其他 Worker 时保持排队（它们仍可能 ready）。
   */
  private failQueueIfStartupBlocked(): void {
    if (this.queue.length === 0) return
    const serviceable = this.slots.some(slot => !slot.stopping && !slot.exited && !slot.released)
    if (!serviceable) this.failQueue(new PatternMatchError('MATCH_WORKER_START_FAILED'))
  }

  // ── Worker 回包/生命周期 ────────────────────────────────────────────────────

  private onMessage(slot: WorkerSlot, raw: unknown): void {
    if (slot.released) {
      this.lateMessages++
      return
    }
    if (!isPatternWorkerResponse(raw)) {
      this.lateMessages++
      return
    }
    const message = raw
    if (message.type === 'ready') {
      if (slot.stopping || slot.exited) {
        this.lateMessages++
        return
      }
      if (message.protocol !== PATTERN_WORKER_PROTOCOL) {
        this.onStartDeadline(slot)
        return
      }
      slot.ready = true
      this.startFailures = 0
      this.startBlockedUntil = 0
      if (slot.startTimer) {
        clearTimeout(slot.startTimer)
        slot.startTimer = null
      }
      // 冷启动完成：此前只能留在队列里的任务现在可以派发。
      this.pump()
      return
    }
    if (message.generation !== slot.generation) {
      this.lateMessages++
      return
    }
    const job = slot.job
    if (!job || job.settled || job.id !== message.jobId) {
      this.lateMessages++
      return
    }
    if (message.type === 'error') {
      this.failures++
      // 语法错误只是这个表达式不可用，Worker 仍然健康；Worker 自身异常才停掉它。
      if (message.reason === 'MATCH_WORKER_FAILED') this.stopAndFinish(slot, job, new PatternMatchError('MATCH_WORKER_FAILED'))
      else this.finish(job, { error: new PatternMatchError(message.reason) })
      return
    }
    this.finish(job, {
      result: {
        matched: message.type === 'match' ? message.matched : false,
        matchedIndex: message.type === 'match' ? message.matchedIndex : -1,
        elapsedMs: message.elapsedMs
      }
    })
  }

  private onStartDeadline(slot: WorkerSlot): void {
    slot.startTimer = null
    if (slot.ready || slot.released) return
    this.failures++
    this.onStartFailure()
    this.stopAndFinish(slot, slot.job, new PatternMatchError('MATCH_WORKER_START_FAILED'))
  }

  private onWorkerError(slot: WorkerSlot): void {
    if (slot.released || slot.exited || slot.stopping) return
    this.failures++
    // 启动阶段（还没 ready）的 error 同样计入启动失败，避免立即重建。
    if (!slot.ready) this.onStartFailure()
    // 出错的 Worker 不能留在池里占位（启动失败常常只发 error 不发 exit）：
    // 先禁止派发并结算任务，再终止；只有 exit 确认后才归还容量。
    this.stopAndFinish(slot, slot.job, new PatternMatchError('MATCH_WORKER_FAILED'))
  }

  private onWorkerExit(slot: WorkerSlot): void {
    if (slot.exited) return
    slot.exited = true
    if (slot.startTimer) {
      clearTimeout(slot.startTimer)
      slot.startTimer = null
    }
    if (slot.exitTimer) {
      clearTimeout(slot.exitTimer)
      slot.exitTimer = null
    }
    slot.resolveExit()
    if (slot.job) {
      this.failures++
      slot.stopping = true
      this.finish(slot.job, { error: new PatternMatchError('MATCH_WORKER_FAILED') })
    }
    this.releaseSlot(slot)
  }

  /**
   * 终止一个 Worker：先解除 message 监听，再 terminate，并在期限内核验 exit。
   * 幂等：重复调用（超时路径 + 迟到 error/exit）不会重复计数或重复 terminate。
   */
  private terminateSlot(slot: WorkerSlot): void {
    if (slot.released || slot.terminating) return
    slot.terminating = true
    slot.stopping = true
    this.terminations++
    if (slot.startTimer) {
      clearTimeout(slot.startTimer)
      slot.startTimer = null
    }
    slot.worker.removeAllListeners('message')
    try {
      const termination = slot.worker.terminate()
      if (termination && typeof termination.catch === 'function') termination.catch(() => {})
    } catch {
      // 已经退出：onWorkerExit 会完成结算。
    }
    slot.exitTimer = setTimeout(() => {
      slot.exitTimer = null
      if (!slot.exited) {
        // exit 未确认：槽位保持不可用（容量不归还），由诊断与调用方看到容量不足。
        if (!slot.unavailableCounted) { slot.unavailableCounted = true; this.unavailableSlots++ }
      }
    }, Math.max(1, this.limits.workerExitDeadlineMs))
    slot.exitTimer.unref?.()
    void slot.exitPromise.then(() => {
      if (slot.exitTimer) {
        clearTimeout(slot.exitTimer)
        slot.exitTimer = null
      }
      this.releaseSlot(slot)
    })
  }

  private releaseSlot(slot: WorkerSlot): void {
    if (slot.released) return
    slot.released = true
    if (slot.unavailableCounted) {
      slot.unavailableCounted = false
      this.unavailableSlots = Math.max(0, this.unavailableSlots - 1)
    }
    if (slot.startTimer) {
      clearTimeout(slot.startTimer)
      slot.startTimer = null
    }
    if (slot.exitTimer) {
      clearTimeout(slot.exitTimer)
      slot.exitTimer = null
    }
    slot.worker.removeAllListeners()
    // 终止期间保留的输入预算：只有确认退出后才归还。
    if (slot.retainedChars > 0) {
      this.reservedChars = Math.max(0, this.reservedChars - slot.retainedChars)
      slot.retainedChars = 0
    }
    const index = this.slots.indexOf(slot)
    if (index >= 0) this.slots.splice(index, 1)
    this.pump()
  }

  // ── 结算 ────────────────────────────────────────────────────────────────────

  private failQueue(error: PatternMatchError): void {
    for (const job of [...this.queue]) this.finish(job, { error })
  }

  /** 唯一结算出口：清定时器/监听/预算/槽位，然后唤醒调用方并继续派发。 */
  private finish(job: PatternJob, outcome: JobOutcome): void {
    if (job.settled) return
    job.settled = true
    if (job.queueTimer) {
      clearTimeout(job.queueTimer)
      job.queueTimer = null
    }
    if (job.execTimer) {
      clearTimeout(job.execTimer)
      job.execTimer = null
    }
    if (job.abortListener && job.signal) {
      job.signal.removeEventListener('abort', job.abortListener)
      job.abortListener = undefined
    }
    const queuedIndex = this.queue.indexOf(job)
    if (queuedIndex >= 0) this.queue.splice(queuedIndex, 1)
    let slot: WorkerSlot | null = null
    if (job.dispatched) {
      slot = this.slots.find(candidate => candidate.job === job) ?? null
      if (slot) slot.job = null
      const inflight = (this.inflight.get(job.callerKey) ?? 0) - 1
      if (inflight > 0) this.inflight.set(job.callerKey, inflight)
      else this.inflight.delete(job.callerKey)
    }
    if (slot && slot.stopping && !slot.exited) {
      // 终止中的 Worker 仍持有这份输入快照：预算保留到 exit 确认（releaseSlot）后再归还。
      slot.retainedChars += job.inputChars
    } else {
      this.reservedChars = Math.max(0, this.reservedChars - job.inputChars)
    }

    if ('error' in outcome) job.reject(outcome.error)
    else job.resolve(outcome.result)
    this.pump()
  }
}

/** 进程级单例：所有外部 wait 入口共用同一个有界池。 */
export const patternMatcher = new PatternMatcher()

/**
 * 退出流程挂接点（`src/main/index.ts` 的 `revoke/pattern-matcher` 步骤）：
 *
 * ```ts
 * const patternMatcherShutdown: { current?: () => Promise<void> } = {}
 * patternMatcherShutdown.current = stopPatternMatcher
 * ```
 *
 * 幂等；必须在 `stopMcpHttpServer()` 之后调用。关闭会拒绝新任务、拒结排队任务并 terminate
 * 在途 Worker；只有**确认退出的** Worker 才归还槽位，未确认的数量以 reject 上报，
 * 由退出协调器记入 unconfirmed（不静默吞掉）。
 */
export async function stopPatternMatcher(): Promise<void> {
  const { confirmedExits, unconfirmedExits } = await patternMatcher.shutdown()
  if (unconfirmedExits > 0) {
    throw new Error(`Wait pattern matcher did not confirm ${unconfirmedExits} worker exit(s) (confirmed ${confirmedExits})`)
  }
}
