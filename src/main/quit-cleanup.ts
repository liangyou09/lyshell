/**
 * 退出清理的共用期限与有界等待器。
 *
 * 目标：退出总期限从流程开始（drain）一次性计算，后续每个阶段/每一步只能消费剩余量，
 * 不能各自重新起算 —— 否则「插件准备永久不返回」会把总期限无限推后。任何单项失败或
 * 超时只记入报告，不截断其他清理项。
 *
 * 保留 `waitForQuitCleanup` 供既有调用方与回归测试使用（语义不变）；新代码应使用
 * `runBoundedStep` / `runBoundedSteps`。
 */

/** 一次性计算出的退出期限。`startedAt` 是流程开始时刻，不是单步开始时刻。 */
export interface ShutdownDeadline {
  readonly startedAt: number
  readonly deadlineAt: number
}

export type BoundedStepStatus = 'completed' | 'failed' | 'pending'

export interface BoundedStepOutcome {
  status: BoundedStepStatus
  durationMs: number
  error?: string
}

export function createShutdownDeadline(budgetMs: number, now: number = Date.now()): ShutdownDeadline {
  const budget = Number.isFinite(budgetMs) ? Math.max(0, Math.floor(budgetMs)) : 0
  return { startedAt: now, deadlineAt: now + budget }
}

export function shutdownRemainingMs(deadline: ShutdownDeadline, now: number = Date.now()): number {
  return Math.max(0, deadline.deadlineAt - now)
}

/** 把子预算裁到总期限之内：子阶段不得突破总期限。 */
export function clampDeadline(deadline: ShutdownDeadline, ceilingAt: number): ShutdownDeadline {
  const deadlineAt = Math.min(deadline.deadlineAt, ceilingAt)
  return { startedAt: Math.min(deadline.startedAt, deadlineAt), deadlineAt }
}

/** 诊断用的错误描述：定长，避免把整段堆栈/响应体塞进退出报告。 */
export function describeShutdownError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 300)
  if (typeof error === 'string') return error.slice(0, 300)
  try { return String(error).slice(0, 300) } catch { return 'Unprintable cleanup error' }
}

/**
 * 在剩余预算内执行一个清理步骤；预算耗尽视为 `pending`（未确认），并调用 onError。
 * 步骤的 Promise 即使迟到落定也已被接管，不会产生未处理 rejection。
 */
export function runBoundedStep(
  run: () => unknown,
  deadline: ShutdownDeadline,
  onError: (error: unknown) => void,
  now: () => number = Date.now
): Promise<BoundedStepOutcome> {
  const startedAt = now()
  const remaining = Math.max(0, deadline.deadlineAt - startedAt)
  const report = (error: unknown): void => {
    // 错误回调自身失败不能阻断退出流程
    try { onError(error) } catch { /* ignore */ }
  }
  if (remaining <= 0) {
    const error = new Error('Shutdown budget exhausted before cleanup step started')
    report(error)
    return Promise.resolve({ status: 'pending', durationMs: 0, error: describeShutdownError(error) })
  }
  return new Promise<BoundedStepOutcome>(resolve => {
    let settled = false
    const timer: { handle?: ReturnType<typeof setTimeout> } = {}
    const finish = (outcome: BoundedStepOutcome): void => {
      if (settled) return
      settled = true
      if (timer.handle) clearTimeout(timer.handle)
      resolve(outcome)
    }
    timer.handle = setTimeout(() => {
      const error = new Error(`Shutdown cleanup step exceeded its ${remaining}ms budget`)
      report(error)
      finish({ status: 'pending', durationMs: now() - startedAt, error: describeShutdownError(error) })
    }, remaining)
    timer.handle.unref?.()
    let work: Promise<unknown>
    try {
      work = Promise.resolve(run())
    } catch (error) {
      report(error)
      finish({ status: 'failed', durationMs: now() - startedAt, error: describeShutdownError(error) })
      return
    }
    work.then(
      () => finish({ status: 'completed', durationMs: now() - startedAt }),
      error => {
        report(error)
        finish({ status: 'failed', durationMs: now() - startedAt, error: describeShutdownError(error) })
      }
    )
  })
}

/** 并行执行多个有界步骤：彼此隔离，任一失败/超时不影响其他项。 */
export function runBoundedSteps(
  steps: readonly (() => unknown)[],
  deadline: ShutdownDeadline,
  onError: (error: unknown) => void,
  now: () => number = Date.now
): Promise<BoundedStepOutcome[]> {
  return Promise.all(steps.map(step => runBoundedStep(step, deadline, onError, now)))
}

/** 等待所有退出清理；单项失败不能截断其他清理，超时只作为退出兜底。 */
export async function waitForQuitCleanup(
  cleanups: readonly Promise<unknown>[], timeoutMs: number, onError: (error: unknown) => void
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const budget = new Promise<void>(resolve => {
    timer = setTimeout(() => {
      onError(new Error('Application cleanup timed out'))
      resolve()
    }, timeoutMs)
    timer.unref?.()
  })
  try {
    await Promise.race([
      Promise.all(cleanups.map(cleanup => cleanup.catch(onError))),
      budget
    ])
  } finally {
    clearTimeout(timer)
  }
}
