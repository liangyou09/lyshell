/**
 * 应用生命周期：正常退出编排 + 新业务 gate。
 *
 * 设计要点（见 docs/lyshell-complete-remediation-plan-2026-10-30.md 4.4）：
 * - 状态 `running → draining → stopped`；任何阶段出现未知致命异常改为 `fatal`。
 * - `draining` 之后拒绝一切新的外部业务变更，只保留生命周期协调器内部的清理通道。
 *   内部通道用 AsyncLocalStorage 令牌授予，HTTP/IPC 的 `cleanup:true` 之类参数
 *   无法伪造（本模块不提供任何外部开关）。
 * - 退出步骤分三段：`prepare`（顺序，插件 release 需要 token/HTTP 存活）→
 *   `revoke`（顺序，撤外部入口与 token）→ `final`（并行，等待进程/持久化落定）。
 * - 总期限从 `beginDrain` 起算，覆盖 `prepareShutdown()`；每步只能消费剩余预算。
 *
 * 本模块刻意不依赖 electron：可在 vitest 里直接构造实例做状态与期限断言，
 * Electron 入口只在 src/main/index.ts 里接线。
 */
import { AsyncLocalStorage } from 'async_hooks'
import {
  clampDeadline,
  createShutdownDeadline,
  describeShutdownError,
  runBoundedStep,
  type BoundedStepStatus,
  type ShutdownDeadline
} from '../quit-cleanup'

export type LifecyclePhase = 'running' | 'draining' | 'fatal' | 'stopped'

export type ShutdownStepKind = 'prepare' | 'revoke' | 'final'

/**
 * 总期限 = prepare + final 的上界。
 * - prepare 7500ms：与 plugin-host 内部 deactivate 的 7500ms 硬期限对齐；
 * - final 用总期限剩余量：prepare 用满时仍 ≥ 8s，等于旧 waitForQuitCleanup 的预算
 *   （dsh 树杀 2500 + 单步下限 1500 + 余量 500 的下界）。
 * - `revoke` 不设子预算：该阶段只做**同步**撤权/发起停止，任何 step 返回 Promise 即视为
 *   接线错误（其完成必须登记到 final 等待）。这样即使 prepare 用尽预算，必要撤权也不会被跳过。
 */
export const SHUTDOWN_TOTAL_BUDGET_MS = 18_000
export const SHUTDOWN_PREPARE_BUDGET_MS = 7_500

export interface LifecycleLogger {
  info(message: string, ...details: unknown[]): void
  warn(message: string, ...details: unknown[]): void
}

export interface AppLifecycleOptions {
  totalBudgetMs?: number
  prepareBudgetMs?: number
  now?: () => number
  logger?: LifecycleLogger
}

/** 业务 gate：HTTP / IPC / 命令服务只依赖这个窄接口。 */
export interface BusinessGate {
  readonly phase: LifecyclePhase
  accepts(): boolean
  assertAcceptsBusiness(operation: string): void
  runBusiness<T>(operation: string, work: () => T | Promise<T>): Promise<T>
  wrap<Args extends unknown[], R>(
    operation: string,
    listener: (...args: Args) => R
  ): (...args: Args) => Promise<Awaited<R>>
}

export class LifecycleRejectedError extends Error {
  readonly code = 'LIFECYCLE_REJECTED'

  constructor(readonly operation: string, readonly phase: LifecyclePhase) {
    super(phase === 'fatal'
      ? `Application is in a fatal state; ${operation} was refused`
      : `Application is shutting down; ${operation} was refused`)
    this.name = 'LifecycleRejectedError'
  }
}

export interface ShutdownStepOutcome {
  name: string
  kind: ShutdownStepKind
  status: BoundedStepStatus
  durationMs: number
  error?: string
}

export interface ShutdownReport {
  kind: 'stopped' | 'fatal'
  reason: string
  startedAt: number
  finishedAt: number
  elapsedMs: number
  budgetMs: number
  timedOut: boolean
  outcomes: ShutdownStepOutcome[]
  /** 未确认（失败/超时）的步骤名；下次启动只做保守恢复，不自动重放。 */
  unconfirmed: string[]
}

interface ShutdownStep {
  kind: ShutdownStepKind
  name: string
  run: () => unknown
}

const CLEANUP_SCOPE = Symbol('lyshell:lifecycle-internal-cleanup')
const STEP_KINDS: readonly ShutdownStepKind[] = ['prepare', 'revoke', 'final']

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    ((typeof value === 'object' && value !== null) || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

export class AppLifecycle implements BusinessGate {
  private currentPhase: LifecyclePhase = 'running'
  private drainReason = 'app-quit'
  private drainStartedAt: number | undefined
  private totalDeadline: ShutdownDeadline | undefined
  private shutdownPromise: Promise<ShutdownReport> | undefined
  private shutdownStarted = false
  private readonly steps: ShutdownStep[] = []
  private readonly cleanupScope = new AsyncLocalStorage<symbol>()
  private lifecycleLogger: LifecycleLogger | undefined
  private fatalDetail: string | undefined
  private readonly totalBudgetMs: number
  private readonly prepareBudgetMs: number
  private readonly now: () => number

  constructor(options: AppLifecycleOptions = {}) {
    this.totalBudgetMs = Math.max(0, Math.floor(options.totalBudgetMs ?? SHUTDOWN_TOTAL_BUDGET_MS))
    this.prepareBudgetMs = Math.max(0, Math.floor(options.prepareBudgetMs ?? SHUTDOWN_PREPARE_BUDGET_MS))
    this.now = options.now ?? Date.now
    this.lifecycleLogger = options.logger
  }

  get phase(): LifecyclePhase {
    return this.currentPhase
  }

  /** 退出总期限的绝对时刻（未开始 drain 时为 undefined），供 dsh 等子预算取上限。 */
  get deadlineAt(): number | undefined {
    return this.totalDeadline?.deadlineAt
  }

  get fatalReason(): string | undefined {
    return this.fatalDetail
  }

  setLogger(logger: LifecycleLogger): void {
    this.lifecycleLogger = logger
  }

  /**
   * 是否接受新的业务操作。`draining` 只放行协调器内部的清理；`fatal`/`stopped` 连内部
   * 清理令牌也一律拒绝（致命状态下不得再产生新的业务/清理副作用）。
   */
  accepts(): boolean {
    if (this.currentPhase === 'fatal' || this.currentPhase === 'stopped') return false
    return this.currentPhase === 'running' || this.cleanupScope.getStore() === CLEANUP_SCOPE
  }

  assertAcceptsBusiness(operation: string): void {
    if (this.accepts()) return
    throw new LifecycleRejectedError(operation, this.currentPhase)
  }

  async runBusiness<T>(operation: string, work: () => T | Promise<T>): Promise<T> {
    this.assertAcceptsBusiness(operation)
    return await work()
  }

  wrap<Args extends unknown[], R>(
    operation: string,
    listener: (...args: Args) => R
  ): (...args: Args) => Promise<Awaited<R>> {
    return async (...args: Args): Promise<Awaited<R>> => {
      this.assertAcceptsBusiness(operation)
      return await listener(...args)
    }
  }

  /** 只允许生命周期协调器（退出步骤内部）调用的清理通道。 */
  runInternalCleanup<T>(work: () => T): T {
    return this.cleanupScope.run(CLEANUP_SCOPE, work)
  }

  /**
   * 进入 draining 并固定总期限。幂等：重复调用返回同一期限，不重新起算。
   * 致命状态下不改变状态（致命退出不执行正常清理）。
   */
  beginDrain(reason: string): ShutdownDeadline {
    if (this.totalDeadline) return this.totalDeadline
    const startedAt = this.now()
    this.drainReason = reason
    this.drainStartedAt = startedAt
    this.totalDeadline = createShutdownDeadline(this.totalBudgetMs, startedAt)
    if (this.currentPhase === 'running') this.currentPhase = 'draining'
    this.log('info', `[lifecycle] draining (reason=${reason}, total budget ${this.totalBudgetMs}ms)`)
    return this.totalDeadline
  }

  /**
   * 注册退出步骤。必须在 drain 之前完成（drain 之后注册会抛错，避免「注册了但没执行」
   * 的假象）；返回取消注册函数。
   */
  registerStep(kind: ShutdownStepKind, name: string, run: () => unknown): () => void {
    if (this.shutdownStarted || this.currentPhase === 'fatal' || this.currentPhase === 'stopped') {
      throw new Error(`Cannot register shutdown step "${name}" after the shutdown plan started`)
    }
    if (!STEP_KINDS.includes(kind)) throw new Error(`Unknown shutdown step kind: ${String(kind)}`)
    if (this.steps.some(step => step.name === name)) {
      throw new Error(`Duplicate shutdown step name: ${name}`)
    }
    const step: ShutdownStep = { kind, name, run }
    this.steps.push(step)
    return () => {
      const index = this.steps.indexOf(step)
      if (index >= 0) this.steps.splice(index, 1)
    }
  }

  /** 进入致命状态：关闭所有新业务入口，记录最小原因（定长）。 */
  enterFatal(reason: string): void {
    if (this.currentPhase === 'fatal' || this.currentPhase === 'stopped') return
    this.currentPhase = 'fatal'
    this.fatalDetail = reason.slice(0, 300)
    this.log('warn', '[lifecycle] fatal state entered; new business requests are refused')
  }

  /**
   * 执行退出计划；幂等。正常路径按实际完成时间返回（不空等总期限）。
   * 每个步骤在独立预算内执行，失败/超时只进入 `unconfirmed`。
   */
  runShutdown(): Promise<ShutdownReport> {
    if (this.shutdownPromise) return this.shutdownPromise
    if (this.currentPhase === 'stopped') {
      return Promise.resolve(this.buildReport('stopped', [], this.totalDeadline ?? createShutdownDeadline(0, this.now())))
    }
    const deadline = this.beginDrain(this.drainReason)
    if (this.currentPhase === 'fatal') {
      // 致命路径由 fatal handler 直接非零退出；即便被调用也不执行正常清理。
      return Promise.resolve(this.buildReport('fatal', [], deadline))
    }
    this.shutdownStarted = true
    const plan = this.executeShutdown(deadline)
    this.shutdownPromise = plan
    return plan
  }

  private async executeShutdown(deadline: ShutdownDeadline): Promise<ShutdownReport> {
    const outcomes: ShutdownStepOutcome[] = []
    // prepare：顺序执行。插件 release/deactivate 依赖仍然有效的 host token 与 HTTP 通道。
    const prepareDeadline = clampDeadline(
      createShutdownDeadline(this.prepareBudgetMs, deadline.startedAt), deadline.deadlineAt
    )
    for (const step of this.stepsOf('prepare')) outcomes.push(await this.runStep(step, prepareDeadline))
    // revoke：只做同步撤权/发起停止（不等待），保证 prepare 用尽预算后必要撤权仍全部执行；
    // 异步清理的完成 Promise 必须由接线方登记到 final 阶段等待。
    for (const step of this.stepsOf('revoke')) outcomes.push(this.runSyncStep(step))
    // final：并行，消费总期限剩余量；单项失败不阻断其他项。
    const finalOutcomes = await Promise.all(this.stepsOf('final').map(step => this.runStep(step, deadline)))
    outcomes.push(...finalOutcomes)
    // 退出途中进入 fatal：不能被最后的 stopped 覆盖（致命/正常退出必须在日志与报告里可区分）。
    const fatalDuringShutdown = this.currentPhase === 'fatal'
    if (!fatalDuringShutdown) this.currentPhase = 'stopped'
    const report = this.buildReport(fatalDuringShutdown ? 'fatal' : 'stopped', outcomes, deadline)
    if (fatalDuringShutdown) {
      this.log('warn', `[lifecycle] fatal state entered during shutdown after ${report.elapsedMs}ms; ${report.unconfirmed.length} step(s) unconfirmed`)
    } else {
      this.log('info', `[lifecycle] stopped after ${report.elapsedMs}ms with ${report.unconfirmed.length} unconfirmed step(s)`)
    }
    return report
  }

  private stepsOf(kind: ShutdownStepKind): ShutdownStep[] {
    return this.steps.filter(step => step.kind === kind)
  }

  /** revoke 步骤必须是同步撤权；返回 Promise 视为接线错误（其完成应由 final 等待）。 */
  private runSyncStep(step: ShutdownStep): ShutdownStepOutcome {
    const startedAt = this.now()
    try {
      const result = this.runInternalCleanup(() => step.run())
      if (isThenable(result)) {
        void Promise.resolve(result).catch(() => undefined)
        throw new Error(
          `Revoke step "${step.name}" returned a promise; revoke may only revoke synchronously and must register completion for the final phase`
        )
      }
      return { name: step.name, kind: step.kind, status: 'completed', durationMs: this.now() - startedAt }
    } catch (error) {
      this.log('warn', `[lifecycle] shutdown step "${step.name}" failed`, error)
      return {
        name: step.name,
        kind: step.kind,
        status: 'failed',
        durationMs: this.now() - startedAt,
        error: describeShutdownError(error)
      }
    }
  }

  private async runStep(step: ShutdownStep, deadline: ShutdownDeadline): Promise<ShutdownStepOutcome> {
    const outcome = await runBoundedStep(
      () => this.runInternalCleanup(() => step.run()),
      deadline,
      error => this.log('warn', `[lifecycle] shutdown step "${step.name}" failed`, error),
      this.now
    )
    if (outcome.status !== 'completed') {
      this.log('warn', `[lifecycle] shutdown step "${step.name}" unconfirmed (${outcome.status})`)
    }
    return { name: step.name, kind: step.kind, status: outcome.status, durationMs: outcome.durationMs, error: outcome.error }
  }

  private buildReport(kind: 'stopped' | 'fatal', outcomes: ShutdownStepOutcome[], deadline: ShutdownDeadline): ShutdownReport {
    const finishedAt = this.now()
    const elapsedMs = Math.max(0, finishedAt - (this.drainStartedAt ?? deadline.startedAt))
    return {
      kind,
      reason: this.drainReason,
      startedAt: this.drainStartedAt ?? deadline.startedAt,
      finishedAt,
      elapsedMs,
      budgetMs: this.totalBudgetMs,
      timedOut: elapsedMs > this.totalBudgetMs || outcomes.some(outcome => outcome.status === 'pending'),
      outcomes,
      unconfirmed: outcomes.filter(outcome => outcome.status !== 'completed').map(outcome => outcome.name)
    }
  }

  private log(level: 'info' | 'warn', message: string, ...details: unknown[]): void {
    try {
      if (!this.lifecycleLogger) return
      if (level === 'info') this.lifecycleLogger.info(message, ...details)
      else this.lifecycleLogger.warn(message, ...details)
    } catch {
      // 日志失败不能阻断生命周期流程（致命路径同样由 fatal handler 兜底退出）
    }
  }
}

/** 进程单例：Electron 入口与 HTTP/IPC gate 共用同一状态机。 */
export const appLifecycle = new AppLifecycle()
export const businessGate: BusinessGate = appLifecycle
