import { OperationError, type RetryDisposition } from '@shared/operation'
import { CommandNotStartedError, CommandScheduler, type ScheduledHandle } from './command-scheduler'
import { CommandOutputBudget, jsonEscapedBytes, type OutputBudgetLimits } from './output-budget'
import type { CommandOutputLimitError } from '../file/command-output'
import {
  COMMAND_LIMITS,
  type BatchCommandRequest,
  type CancelReason,
  type CommandBatchExecution,
  type CommandBatchResult,
  type CommandResult,
  type CommandShutdownResult,
  type CommandTargetOutcome,
  type CommandTargetSpec,
  type ResourceCloseResult
} from './types'

/**
 * 全局命令服务：把一批目标交给调度器，按批次汇总结果，并统一记账输出/发送预算。
 *
 * 关键时序（R3 5.4/5.5）：
 * - 名额由 CommandScheduler 在 resourceClosed 确认后才归还，result 先失败不影响占用；
 * - 每批结果的保留字节按实际 UTF-8 增量预留，只有 release() 才归还；
 * - 发送预算由 HTTP 入口在序列化前预留、响应结束后释放（见 tmp/remediation-r3-interface.md）。
 */

/** 取消后等待资源关闭回执的上限；超时按 unconfirmed 返回，名额仍被调度器占用。 */
const CLOSE_GRACE_MS = 5_000

/** 整批期限上限，防止单个请求长期占用全局名额。 */
const MAX_TOTAL_TIMEOUT_MS = 10 * 60_000

export interface CommandServiceOptions {
  scheduler?: CommandScheduler
  budget?: CommandOutputBudget
  limits?: Partial<OutputBudgetLimits>
}

export interface CommandServiceShutdownResult extends CommandShutdownResult {
  /** 本次关闭涉及的批次数量。 */
  batches: number
}

/** 批次内部句柄：供 shutdown 取消、停止收集并释放保留预算。 */
interface ServiceBatch {
  abandon(reason: CancelReason): Promise<void>
  release(): void
}

type SettledResult =
  | { status: 'fulfilled'; value: CommandResult }
  | { status: 'rejected'; reason: unknown }

export class CommandService {
  readonly scheduler: CommandScheduler
  readonly budget: CommandOutputBudget
  private batchSequence = 0
  private shuttingDown = false
  private shutdownPromise?: Promise<CommandServiceShutdownResult>
  private readonly activeBatches = new Set<ServiceBatch>()

  constructor(options: CommandServiceOptions = {}) {
    this.scheduler = options.scheduler ?? new CommandScheduler()
    this.budget = options.budget ?? new CommandOutputBudget(options.limits)
  }

  runBatch(request: BatchCommandRequest): CommandBatchExecution {
    if (this.shuttingDown) {
      throw new OperationError('CONTROL_CONFLICT', 'Command service is shutting down', 'never')
    }
    const batchId = `batch-${++this.batchSequence}`
    const targets = request.targets
    const perCommandTimeoutMs = request.timeoutMs ?? 30_000
    const totalTimeoutMs = Math.min(
      Math.max(1, request.totalTimeoutMs ?? COMMAND_LIMITS.totalTimeoutMs),
      MAX_TOTAL_TIMEOUT_MS
    )
    const outcomes = new Array<CommandTargetOutcome | undefined>(targets.length)
    const handles = new Map<number, ScheduledHandle>()
    const targetBytes = new Map<number, number>()
    let pending = targets.length
    let cancelled = false
    let cancelReason: CancelReason | undefined
    let signalCancelled!: () => void
    const cancelledSignal = new Promise<void>(resolve => { signalCancelled = resolve })
    let finished = false
    let released = false
    /** 结果落定后批次不再接受新的输出预留，避免关闭后才到达的数据继续计入预算。 */
    let accepting = true
    const batchState: { batch?: ServiceBatch } = {}
    let resolveResults!: (result: CommandBatchResult) => void
    const results = new Promise<CommandBatchResult>(resolve => { resolveResults = resolve })

    const finishIfDone = (): void => {
      if (finished || pending > 0) return
      finished = true
      accepting = false
      clearTimeout(totalTimer)
      if (batchState.batch) this.activeBatches.delete(batchState.batch)
      const retainedBytes = this.budget.retainedBytesFor(batchId)
      resolveResults({
        results: targets.map((_, index) => outcomes[index] ?? {
          sessionId: targets[index].sessionId,
          state: 'not-started',
          error: 'Command was not dispatched',
          retryDisposition: 'safe'
        }),
        retainedBytes,
        totalTimeoutMs
      })
    }

    const settleTarget = (index: number, outcome: CommandTargetOutcome): void => {
      if (outcomes[index]) return
      outcomes[index] = outcome
      pending--
      finishIfDone()
    }

    const releaseTargetBytes = (index: number): void => {
      if (released) return
      const bytes = targetBytes.get(index) ?? 0
      if (bytes <= 0) return
      targetBytes.delete(index)
      this.budget.releaseRetainedBytes(batchId, bytes)
    }

    /** 批次共享上限 + 全局上限；超限抛 RESOURCE_LIMIT，collector 会转成带 partialOutput 的失败。 */
    const reserveFor = (index: number) => (deltaBytes: number): void => {
      this.assertAccepting(accepting)
      this.budget.reserveRetained(batchId, deltaBytes)
      targetBytes.set(index, (targetBytes.get(index) ?? 0) + deltaBytes)
    }

    /** 失败诊断片段也必须计入预算；容量不足时省略片段（不伪造成功输出）。 */
    const retainPartial = (index: number, partial: string | undefined): string | undefined => {
      if (!partial || released || !accepting) return undefined
      const bytes = Buffer.byteLength(partial, 'utf8')
      try {
        this.budget.reserveRetained(batchId, bytes)
      } catch {
        return undefined
      }
      targetBytes.set(index, (targetBytes.get(index) ?? 0) + bytes)
      return partial
    }

    const cancelAll = (reason: CancelReason): void => {
      if (cancelled || finished) return
      cancelled = true
      cancelReason = reason
      signalCancelled()
      for (const handle of handles.values()) handle.cancel(reason)
    }

    /**
     * 整批期限到点：立即给出可发送的结果（OUTCOME_UNKNOWN + unconfirmed），不无限等待清理回执。
     * 名额仍由调度器持有，直到对应 resourceClosed 确认；不会因为结果返回而提前释放。
     */
    const settleDeadline = (reason: CancelReason): void => {
      accepting = false
      const deadlineError = 'Command did not produce a result before the batch deadline; inspect side effects before retrying'
      for (let index = 0; index < targets.length; index++) {
        const handle = handles.get(index)
        const notStarted = !handle?.dispatched
        settleTarget(index, {
          sessionId: targets[index].sessionId,
          state: notStarted ? 'not-started' : 'outcome-unknown',
          error: notStarted ? 'Command was not started before the batch deadline' : deadlineError,
          code: notStarted ? 'RESOURCE_LIMIT' : 'OUTCOME_UNKNOWN',
          retryDisposition: notStarted ? 'safe' : 'reconcile-first',
          resourceClosed: handle?.resourceStatus() === 'closed' ? 'closed' : 'unconfirmed',
          remoteTerminated: notStarted ? 'not-dispatched' : 'unknown',
          cancelReason: reason
        })
      }
    }

    const totalTimer = setTimeout(() => {
      cancelAll('total-timeout')
      settleDeadline('total-timeout')
    }, totalTimeoutMs)
    const unref = (totalTimer as unknown as { unref?: () => void }).unref
    if (typeof unref === 'function') unref.call(totalTimer)

    /** 取消后最多再等这么久拿结果/关闭回执；超时按 unknown 返回，名额继续占用。 */
    const afterCancelDeadline = <T>(value: T): Promise<T> =>
      cancelledSignal.then(() => delay(CLOSE_GRACE_MS)).then(() => value)

    const track = (index: number, target: CommandTargetSpec, handle: ScheduledHandle): void => {
      handles.set(index, handle)
      const closeWithinGrace = Promise.race([
        handle.resourceClosed,
        afterCancelDeadline<ResourceCloseResult>({
          state: 'unconfirmed',
          localClosed: false,
          remoteTerminated: 'unknown',
          detail: 'Resource close was not confirmed before the batch result deadline'
        })
      ]).catch((error: Error): ResourceCloseResult => ({
        state: 'unconfirmed',
        localClosed: false,
        remoteTerminated: 'unknown',
        detail: error.message
      }))

      const settledWithinGrace = Promise.race<SettledResult | { status: 'pending' }>([
        handle.result.then<SettledResult, SettledResult>(
          value => ({ status: 'fulfilled', value }),
          reason => ({ status: 'rejected', reason })
        ),
        afterCancelDeadline({ status: 'pending' })
      ])

      void Promise.all([settledWithinGrace, closeWithinGrace]).then(([result, close]) => {
        if (result.status === 'pending') {
          // 已取消但执行句柄迟迟不结算：没有结果，也没有关闭回执，不能归还名额。
          settleTarget(index, {
            sessionId: target.sessionId,
            state: 'outcome-unknown',
            error: 'Command did not produce a result before the batch deadline; inspect side effects before retrying',
            code: 'OUTCOME_UNKNOWN',
            retryDisposition: 'reconcile-first',
            resourceClosed: close.state,
            remoteTerminated: close.remoteTerminated,
            cancelReason
          })
          return
        }
        if (result.status === 'rejected') {
          // 完整输出已在句柄失败时丢弃；诊断片段按实际保留量重新计入预算。
          releaseTargetBytes(index)
          settleTarget(index, this.failureOutcome(index, target, handle, asError(result.reason), close, cancelReason, retainPartial))
          return
        }
        settleTarget(index, {
          sessionId: target.sessionId,
          state: 'completed',
          output: result.value.output,
          exitCode: result.value.exitCode,
          resourceClosed: close.state,
          remoteTerminated: close.remoteTerminated,
          cancelReason: cancelled ? cancelReason : undefined
        })
      })
    }

    const scheduleTarget = (index: number, target: CommandTargetSpec): void => {
      let handle: ScheduledHandle
      try {
        handle = this.scheduler.schedule({
          callerKey: request.callerKey,
          endpointKey: target.endpointKey ?? target.sessionId,
          dispatch: async signal => {
            if (cancelled || signal.aborted) {
              throw new CommandNotStartedError(
                `Command cancelled before dispatch (${cancelReason ?? 'client'})`,
                cancelReason ?? 'client'
              )
            }
            // 出队后、派发前复核：权限、会话对象、连接 generation、插件状态。
            await target.revalidate?.()
            if (cancelled || signal.aborted) {
              throw new CommandNotStartedError(
                `Command cancelled before dispatch (${cancelReason ?? 'client'})`,
                cancelReason ?? 'client'
              )
            }
            return target.dispatch({
              signal,
              timeoutMs: perCommandTimeoutMs,
              reserveBytes: reserveFor(index)
            })
          }
        })
      } catch (error) {
        settleTarget(index, {
          sessionId: target.sessionId,
          state: 'not-started',
          error: error instanceof OperationError ? error.message : 'Command queue is unavailable',
          code: error instanceof OperationError ? error.code : 'RESOURCE_LIMIT',
          retryDisposition: 'safe'
        })
        return
      }
      track(index, target, handle)
    }

    for (let index = 0; index < targets.length; index++) scheduleTarget(index, targets[index])

    /** shutdown 时先取消，再让排队取消的 rejection 落地，最后才把未结算项标成 unknown。 */
    const batch: ServiceBatch = {
      abandon: async (reason: CancelReason): Promise<void> => {
        cancelAll(reason)
        accepting = false
        await delay(0)
        settleDeadline(reason)
        await results.then(() => undefined)
      },
      release: (): void => {
        if (released) return
        released = true
        accepting = false
        targetBytes.clear()
        this.budget.releaseRetained(batchId)
      }
    }
    batchState.batch = batch
    if (!finished) this.activeBatches.add(batch)
    if (targets.length === 0) finishIfDone()

    return {
      results,
      cancel(reason: CancelReason) {
        cancelAll(reason)
      },
      release: () => {
        batchState.batch?.release()
      }
    }
  }

  /**
   * 停止接单：同步拒绝新批次，取消所有排队与在途命令，等待真实关闭回执。
   * 超时或关闭未确认时返回 unconfirmed；不把未释放的名额报告成成功。
   */
  shutdown(reason: CancelReason = 'shutdown'): Promise<CommandServiceShutdownResult> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.shuttingDown = true
    this.shutdownPromise = this.runShutdown(reason)
    return this.shutdownPromise
  }

  private async runShutdown(reason: CancelReason): Promise<CommandServiceShutdownResult> {
    const batches = [...this.activeBatches]
    // 先同步关闭调度器（拒绝新派发、取消排队），再停批次收集，避免释放名额时把排队项放出去。
    const schedulerShutdown = this.scheduler.shutdown(reason)
    await Promise.all(batches.map(batch => batch.abandon(reason)))
    const schedulerResult = await schedulerShutdown
    for (const batch of batches) batch.release()
    this.activeBatches.clear()
    return { ...schedulerResult, batches: batches.length }
  }

  private assertAccepting(accepting: boolean): void {
    if (!accepting) {
      throw new OperationError('RESOURCE_LIMIT', 'Command batch no longer accepts output (results already settled)', 'never')
    }
  }

  /** HTTP 入口在 JSON.stringify 之前预留；bytes 必须是转义后的保守字节数。 */
  reserveSendBytes(ownerKey: string, bytes: number): void {
    this.budget.reserveSend(ownerKey, bytes)
  }

  /** 响应 end/close 后释放；幂等。 */
  releaseSendBytes(ownerKey: string): void {
    this.budget.releaseSend(ownerKey)
  }

  /** 估算目标结果序列化后的保守字节数（含 sessionId 与对象结构余量，不含整批外壳）。 */
  estimateSendBytes(outcome: CommandTargetOutcome): number {
    return jsonEscapedBytes(outcome.sessionId)
      + jsonEscapedBytes(outcome.output ?? '')
      + jsonEscapedBytes(outcome.partialOutput ?? '')
      + jsonEscapedBytes(outcome.error ?? '')
      + jsonEscapedBytes(outcome.reason ?? '')
      + 256
  }

  /** 整批结果的保守发送字节数；0 结果也保留固定外壳余量。 */
  estimateBatchSendBytes(batch: CommandBatchResult): number {
    return batch.results.reduce((total, outcome) => total + this.estimateSendBytes(outcome), 512)
  }

  private failureOutcome(
    index: number,
    target: CommandTargetSpec,
    handle: ScheduledHandle,
    error: Error,
    close: ResourceCloseResult,
    batchCancelReason: CancelReason | undefined,
    retainPartial: (index: number, partial: string | undefined) => string | undefined
  ): CommandTargetOutcome {
    const op = error instanceof OperationError ? error : undefined
    const neverDispatched = !handle.dispatched || close.remoteTerminated === 'not-dispatched'
    const partial = neverDispatched ? undefined : retainPartial(index, (error as CommandOutputLimitError).partialOutput)
    const detailReason = (error as Error & { reason?: unknown }).reason
    const reason = typeof detailReason === 'string' && ['OUTPUT_LIMIT', 'COMMAND_TIMEOUT', 'COMMAND_CANCELLED', 'FORBIDDEN'].includes(detailReason)
      ? detailReason : op?.code === 'RESOURCE_LIMIT' ? 'OUTPUT_LIMIT' : op?.code === 'FORBIDDEN' ? 'FORBIDDEN' : undefined
    const base = {
      sessionId: target.sessionId,
      error: op?.message ?? (neverDispatched ? 'Command could not be dispatched' : 'Command outcome is unknown; inspect side effects before retrying'),
      resourceClosed: close.state,
      remoteTerminated: close.remoteTerminated,
      cancelReason: batchCancelReason
    }

    if (neverDispatched) {
      return {
        ...base,
        state: 'not-started',
        code: op?.code,
        retryDisposition: op?.code === 'FORBIDDEN' ? 'never' : 'safe'
      }
    }

    // 已派发但关闭/远端结果不明确：优先报告 OUTCOME_UNKNOWN，避免 RESOURCE_LIMIT 被误读为可安全重试。
    const outcomeUnknown = close.state !== 'closed' || close.remoteTerminated !== 'confirmed'
    if (outcomeUnknown) {
      return {
        ...base,
        state: 'outcome-unknown',
        code: 'OUTCOME_UNKNOWN',
        retryDisposition: 'reconcile-first',
        reason,
        partialOutput: partial
      }
    }

    const state = op?.code === 'FORBIDDEN' || op?.code === 'INVALID_ARGUMENT' || op?.code === 'RESOURCE_LIMIT'
      ? 'failed'
      : 'outcome-unknown'
    const retryDisposition: RetryDisposition = op?.retryDisposition ?? 'reconcile-first'
    return {
      ...base,
      state,
      code: op?.code ?? 'OUTCOME_UNKNOWN',
      retryDisposition,
      reason,
      partialOutput: partial || undefined
    }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** 不在事件循环里保持进程存活，延长器只服务于请求生命周期。 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    const unref = (timer as unknown as { unref?: () => void }).unref
    if (typeof unref === 'function') unref.call(timer)
  })
}
