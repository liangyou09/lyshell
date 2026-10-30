import { OperationError } from '@shared/operation'
import {
  COMMAND_LIMITS,
  type CancelReason,
  type CommandExecutionHandle,
  type CommandResult,
  type CommandShutdownResult,
  type ResourceCloseResult
} from './types'

/**
 * 全局命令调度：有界的活动名额 + 公平轮转队列。
 *
 * 名额只在资源关闭确认后归还；结果先失败、进程树仍在退出时继续占用（符合 R3 5.4）。
 * 队列满时同步拒绝（RESOURCE_LIMIT），不静默扩容。
 */

export interface SchedulerLimits {
  globalActive: number
  callerActive: number
  endpointActive: number
  globalQueued: number
  callerQueued: number
}

export const DEFAULT_SCHEDULER_LIMITS: SchedulerLimits = {
  globalActive: COMMAND_LIMITS.globalActive,
  callerActive: COMMAND_LIMITS.callerActive,
  endpointActive: COMMAND_LIMITS.endpointActive,
  globalQueued: COMMAND_LIMITS.globalQueued,
  callerQueued: COMMAND_LIMITS.callerQueued
}

/** 尚未派发就被取消/复核失败的结果；明确表示无副作用，不能当作未知结果重放。 */
export class CommandNotStartedError extends OperationError {
  constructor(message: string, readonly cancelReason?: CancelReason, readonly cause?: Error) {
    super('CONTROL_CONFLICT', message, 'never')
    this.name = 'CommandNotStartedError'
  }
}

export interface ScheduledCommandRequest {
  callerKey: string
  endpointKey?: string
  /** 可异步复核（权限/连接 generation）；抛错即未派发。 */
  dispatch: (signal: AbortSignal) => CommandExecutionHandle | Promise<CommandExecutionHandle>
}

export interface ScheduledHandle extends CommandExecutionHandle {
  readonly id: number
  /** 是否真正返回过执行句柄；false 表示没有副作用。 */
  readonly dispatched: boolean
  /** 当前资源关闭状态，供结果组装时读快照，不阻塞等待。 */
  resourceStatus(): ResourceCloseResult['state'] | 'pending'
  /** 明确确认进程/通道已不存在后强制归还名额；仅用于运维恢复。 */
  reclaim(): void
}

export interface SchedulerSnapshot {
  active: number
  queued: number
  unconfirmed: number
  activeByCaller: Record<string, number>
  activeByEndpoint: Record<string, number>
  queuedByCaller: Record<string, number>
}

interface SchedulerEntry {
  id: number
  callerKey: string
  endpointKey: string
  dispatch: ScheduledCommandRequest['dispatch']
  controller: AbortController
  running: boolean
  dispatched: boolean
  resultSettled: boolean
  closeSettled: boolean
  seatReleased: boolean
  /** 是否已计入 unconfirmedGlobal（名额仍被占用）。 */
  stuckCounted: boolean
  closeState?: ResourceCloseResult
  cancelReason?: CancelReason
  handle?: CommandExecutionHandle
  /** 与给调用方的 resourceClosed 同源，供 shutdown 等待真实关闭。 */
  closed: Promise<ResourceCloseResult>
  resolveResult: (result: CommandResult) => void
  rejectResult: (error: Error) => void
  resolveClose: (result: ResourceCloseResult) => void
}

const NOT_DISPATCHED_CLOSE: ResourceCloseResult = {
  state: 'closed',
  localClosed: true,
  remoteTerminated: 'not-dispatched'
}

export class CommandScheduler {
  private readonly limits: SchedulerLimits
  private readonly queueByCaller = new Map<string, SchedulerEntry[]>()
  private callerOrder: string[] = []
  /** 上一次实际启动的调用者；下一次从它之后轮转，避免同一调用者连占名额。 */
  private lastCallerKey?: string
  private activeGlobal = 0
  private activeByCaller = new Map<string, number>()
  private activeByEndpoint = new Map<string, number>()
  private queuedGlobal = 0
  private queuedByCaller = new Map<string, number>()
  private unconfirmedGlobal = 0
  private nextId = 1
  /** 仍占用名额的执行；shutdown 等待它们的真实关闭回执。 */
  private readonly activeEntries = new Set<SchedulerEntry>()
  private shuttingDown = false
  private shutdownPromise?: Promise<CommandShutdownResult>

  constructor(limits: Partial<SchedulerLimits> = {}) {
    this.limits = { ...DEFAULT_SCHEDULER_LIMITS, ...limits }
  }

  /**
   * 入队并尝试立即派发。队列容量不足时同步抛 RESOURCE_LIMIT。
   * 调用方必须在审批（destructive confirmation）之后调用，保证不会为未授权目标占位。
   */
  schedule(request: ScheduledCommandRequest): ScheduledHandle {
    if (this.shuttingDown) {
      throw new OperationError('CONTROL_CONFLICT', 'Command scheduler is shutting down', 'never')
    }
    const queuedForCaller = this.queuedByCaller.get(request.callerKey) ?? 0
    if (queuedForCaller >= this.limits.callerQueued) {
      throw new OperationError(
        'RESOURCE_LIMIT',
        `Command queue is full (caller max ${this.limits.callerQueued})`,
        'never'
      )
    }
    if (this.queuedGlobal >= this.limits.globalQueued) {
      throw new OperationError(
        'RESOURCE_LIMIT',
        `Command queue is full (global max ${this.limits.globalQueued})`,
        'never'
      )
    }

    let resolveResult!: (result: CommandResult) => void
    let rejectResult!: (error: Error) => void
    let resolveClose!: (result: ResourceCloseResult) => void
    const result = new Promise<CommandResult>((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })
    const resourceClosed = new Promise<ResourceCloseResult>(resolve => { resolveClose = resolve })
    const entry: SchedulerEntry = {
      id: this.nextId++,
      callerKey: request.callerKey,
      endpointKey: request.endpointKey ?? request.callerKey,
      dispatch: request.dispatch,
      controller: new AbortController(),
      running: false,
      dispatched: false,
      resultSettled: false,
      closeSettled: false,
      seatReleased: false,
      stuckCounted: false,
      closed: resourceClosed,
      resolveResult: result => resolveResult(result),
      rejectResult: error => rejectResult(error),
      resolveClose: result => resolveClose(result)
    }

    this.enqueue(entry)
    this.pump()

    return {
      id: entry.id,
      result,
      resourceClosed,
      get dispatched() { return entry.dispatched },
      cancel: reason => this.cancel(entry, reason),
      resourceStatus: () => entry.closeState?.state ?? (entry.closeSettled ? 'unconfirmed' : 'pending'),
      reclaim: () => this.reclaim(entry)
    }
  }

  snapshot(): SchedulerSnapshot {
    return {
      active: this.activeGlobal,
      queued: this.queuedGlobal,
      unconfirmed: this.unconfirmedGlobal,
      activeByCaller: Object.fromEntries(this.activeByCaller),
      activeByEndpoint: Object.fromEntries(this.activeByEndpoint),
      queuedByCaller: Object.fromEntries(this.queuedByCaller)
    }
  }

  /**
   * 停止接单：同步拒绝新任务，取消排队与在途执行，并等待真实关闭回执。
   * 超时或关闭未确认时返回 unconfirmed，绝不把未释放的名额报告成成功。
   */
  shutdown(reason: CancelReason = 'shutdown', timeoutMs = 10_000): Promise<CommandShutdownResult> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.shuttingDown = true
    this.shutdownPromise = this.runShutdown(reason, timeoutMs)
    return this.shutdownPromise
  }

  private async runShutdown(reason: CancelReason, timeoutMs: number): Promise<CommandShutdownResult> {
    const queued: SchedulerEntry[] = []
    for (const queue of this.queueByCaller.values()) queued.push(...queue)
    for (const entry of queued) {
      entry.controller.abort()
      this.removeQueued(entry)
      this.finishNotStarted(
        entry,
        new CommandNotStartedError(`Command cancelled before dispatch (${reason})`, reason)
      )
    }

    const active = [...this.activeEntries]
    for (const entry of active) this.cancel(entry, reason)
    // 等待真实关闭；迟到回执仍会释放名额，但本次退出报告已按未确认记录。
    await Promise.all(active.map(entry => Promise.race([entry.closed, delay(timeoutMs)])))
    const unconfirmed = active.filter(entry => entry.closeState?.state !== 'closed').length
    return {
      state: unconfirmed > 0 ? 'unconfirmed' : 'closed',
      reason,
      cancelled: queued.length,
      unconfirmed
    }
  }

  private enqueue(entry: SchedulerEntry): void {
    const queue = this.queueByCaller.get(entry.callerKey)
    if (queue) queue.push(entry)
    else {
      this.queueByCaller.set(entry.callerKey, [entry])
      this.callerOrder.push(entry.callerKey)
    }
    this.queuedGlobal++
    this.queuedByCaller.set(entry.callerKey, (this.queuedByCaller.get(entry.callerKey) ?? 0) + 1)
  }

  private pump(): void {
    while (this.activeGlobal < this.limits.globalActive) {
      if (!this.startNextFair()) break
    }
  }

  /** 轮转调用者；每次只启动一个，再重新从游标处扫描。 */
  private startNextFair(): boolean {
    const total = this.callerOrder.length
    if (total === 0) return false
    const start = this.startIndex()
    for (let offset = 0; offset < total; offset++) {
      const index = (start + offset) % total
      const callerKey = this.callerOrder[index]
      const queue = this.queueByCaller.get(callerKey)
      if (!queue || queue.length === 0) continue
      if ((this.activeByCaller.get(callerKey) ?? 0) >= this.limits.callerActive) continue
      // 同一调用者内部保持 FIFO，但跳过端点名额已满的队首，避免不同连接互相阻塞。
      const entryIndex = queue.findIndex(
        entry => (this.activeByEndpoint.get(entry.endpointKey) ?? 0) < this.limits.endpointActive
      )
      if (entryIndex < 0) continue
      const [head] = queue.splice(entryIndex, 1)
      this.queuedGlobal--
      const remainingForCaller = (this.queuedByCaller.get(callerKey) ?? 1) - 1
      if (remainingForCaller <= 0) this.queuedByCaller.delete(callerKey)
      else this.queuedByCaller.set(callerKey, remainingForCaller)
      if (queue.length === 0) {
        this.queueByCaller.delete(callerKey)
        this.callerOrder.splice(index, 1)
      }
      this.lastCallerKey = callerKey
      this.start(head)
      return true
    }
    return false
  }

  private startIndex(): number {
    const total = this.callerOrder.length
    if (total === 0 || this.lastCallerKey === undefined) return 0
    const index = this.callerOrder.indexOf(this.lastCallerKey)
    return index < 0 ? 0 : (index + 1) % total
  }

  private start(entry: SchedulerEntry): void {
    entry.running = true
    this.activeEntries.add(entry)
    this.activeGlobal++
    this.activeByCaller.set(entry.callerKey, (this.activeByCaller.get(entry.callerKey) ?? 0) + 1)
    this.activeByEndpoint.set(entry.endpointKey, (this.activeByEndpoint.get(entry.endpointKey) ?? 0) + 1)

    let outcome: CommandExecutionHandle | Promise<CommandExecutionHandle>
    try {
      outcome = entry.dispatch(entry.controller.signal)
    } catch (error) {
      this.failBeforeDispatch(entry, error)
      return
    }
    Promise.resolve(outcome).then(
      handle => {
        entry.handle = handle
        entry.dispatched = true
        if (entry.cancelReason) handle.cancel(entry.cancelReason)
        this.attach(entry, handle)
      },
      error => this.failBeforeDispatch(entry, error)
    )
  }

  private attach(entry: SchedulerEntry, handle: CommandExecutionHandle): void {
    handle.result.then(
      result => {
        if (entry.resultSettled) return
        entry.resultSettled = true
        entry.resolveResult(result)
      },
      (error: Error) => {
        if (entry.resultSettled) return
        entry.resultSettled = true
        entry.rejectResult(error)
      }
    )
    handle.resourceClosed.then(
      result => this.settleClose(entry, result),
      (error: Error) => this.settleClose(entry, {
        state: 'unconfirmed',
        localClosed: false,
        remoteTerminated: 'unknown',
        detail: error.message
      })
    )
  }

  private failBeforeDispatch(entry: SchedulerEntry, error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error))
    this.releaseSeat(entry)
    if (entry.resultSettled) return
    entry.resultSettled = true
    entry.rejectResult(failure)
    if (entry.closeSettled) return
    entry.closeSettled = true
    entry.closeState = NOT_DISPATCHED_CLOSE
    entry.resolveClose(NOT_DISPATCHED_CLOSE)
  }

  private settleClose(entry: SchedulerEntry, result: ResourceCloseResult): void {
    if (entry.closeSettled) return
    entry.closeSettled = true
    entry.closeState = result
    if (result.state === 'closed') {
      this.releaseSeat(entry)
    } else {
      // 清理失败/未确认：名额继续占用，直到进程或通道被显式确认回收。
      entry.stuckCounted = true
      this.unconfirmedGlobal++
    }
    entry.resolveClose(result)
  }

  private releaseSeat(entry: SchedulerEntry): void {
    if (entry.seatReleased) return
    entry.seatReleased = true
    this.activeEntries.delete(entry)
    if (entry.stuckCounted) {
      entry.stuckCounted = false
      this.unconfirmedGlobal = Math.max(0, this.unconfirmedGlobal - 1)
    }
    if (!entry.running) return
    this.activeGlobal = Math.max(0, this.activeGlobal - 1)
    decrement(this.activeByCaller, entry.callerKey)
    decrement(this.activeByEndpoint, entry.endpointKey)
    this.pump()
  }

  private cancel(entry: SchedulerEntry, reason: CancelReason): void {
    if (entry.resultSettled && entry.closeSettled) return
    entry.cancelReason ??= reason
    if (!entry.running) {
      this.removeQueued(entry)
      entry.controller.abort()
      this.finishNotStarted(entry, new CommandNotStartedError(`Command cancelled before dispatch (${reason})`, reason))
      return
    }
    entry.controller.abort()
    entry.handle?.cancel(reason)
  }

  private finishNotStarted(entry: SchedulerEntry, error: Error): void {
    if (entry.resultSettled) return
    entry.resultSettled = true
    entry.rejectResult(error)
    if (entry.closeSettled) return
    entry.closeSettled = true
    entry.closeState = NOT_DISPATCHED_CLOSE
    entry.resolveClose(NOT_DISPATCHED_CLOSE)
  }

  private removeQueued(entry: SchedulerEntry): void {
    const queue = this.queueByCaller.get(entry.callerKey)
    if (!queue) return
    const index = queue.indexOf(entry)
    if (index < 0) return
    queue.splice(index, 1)
    this.queuedGlobal--
    const remaining = (this.queuedByCaller.get(entry.callerKey) ?? 1) - 1
    if (remaining <= 0) this.queuedByCaller.delete(entry.callerKey)
    else this.queuedByCaller.set(entry.callerKey, remaining)
    if (queue.length === 0) {
      this.queueByCaller.delete(entry.callerKey)
      const orderIndex = this.callerOrder.indexOf(entry.callerKey)
      if (orderIndex >= 0) this.callerOrder.splice(orderIndex, 1)
    }
  }

  private reclaim(entry: SchedulerEntry): void {
    if (entry.seatReleased) return
    if (!entry.closeSettled) {
      entry.closeSettled = true
      entry.closeState = {
        state: 'unconfirmed',
        localClosed: false,
        remoteTerminated: 'unknown',
        detail: 'Command seat reclaimed before resource close was confirmed'
      }
      entry.stuckCounted = true
      this.unconfirmedGlobal++
      entry.resolveClose(entry.closeState)
    }
    this.releaseSeat(entry)
  }
}

function decrement(map: Map<string, number>, key: string): void {
  const current = map.get(key)
  if (!current) return
  if (current <= 1) map.delete(key)
  else map.set(key, current - 1)
}

/** 关闭等待不保持进程存活。 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    const unref = (timer as unknown as { unref?: () => void }).unref
    if (typeof unref === 'function') unref.call(timer)
  })
}
