/**
 * 传输尝试（attempt）主进程侧辅助逻辑。
 *
 * Worker 只负责执行一次尝试并回报 `result`；终态判定、进度归属、取消确认与
 * “退出但没有终态”的兜底语义都必须由主进程掌控，避免 Worker 的迟到/错误消息
 * 回退或伪造终态。本模块是纯逻辑，便于单测。
 */
import { randomUUID } from 'crypto'
import {
  buildSyntheticResult,
  describeTransferTempPattern,
  type TransferAttemptResult,
  type TransferDirection,
  type TransferErrorCode,
  type TransferOutcome,
  type TransferPhase
} from './transfer-commit'

/** 取消确认等待上限：超时后强制终止 Worker */
export interface TransferAttemptTimeouts {
  cancelGraceMs: number
  terminateWaitMs: number
}

/** 可变对象：测试可缩短等待时间，生产使用默认值 */
export const transferAttemptTimeouts: TransferAttemptTimeouts = {
  cancelGraceMs: 10_000,
  terminateWaitMs: 2_000
}

/** 每个任务只允许一个终态回执的台账上限（防止长期运行内存增长） */
export const TRANSFER_TERMINAL_LEDGER_LIMIT = 512

export interface AttemptIdentity {
  taskId: string
  attemptId: string
  direction: TransferDirection
  sessionId: string
  expectedSize: number
  targetPath: string
  startedAt: number
}

export function createAttemptId(): string {
  return randomUUID()
}

export function createAttempt(input: {
  taskId: string
  sessionId: string
  direction: TransferDirection
  expectedSize: number
  targetPath: string
}): AttemptIdentity {
  return {
    taskId: input.taskId,
    attemptId: createAttemptId(),
    direction: input.direction,
    sessionId: input.sessionId,
    expectedSize: input.expectedSize,
    targetPath: input.targetPath,
    startedAt: Date.now()
  }
}

/** Worker → 主进程的消息（全部带 taskId/attemptId，主进程按派发值校验） */
export type TransferWorkerMessage =
  | { type: 'progress'; taskId: string; attemptId: string; phase: TransferPhase; transferredSize: number; fileSize: number; speed: number }
  | { type: 'phase'; taskId: string; attemptId: string; phase: TransferPhase }
  | { type: 'temp'; taskId: string; attemptId: string; tempPath: string }
  | { type: 'result'; taskId: string; attemptId: string; result: TransferAttemptResult }
  | { type: 'log'; taskId: string; attemptId: string; level: 'info' | 'warn' | 'error'; message: string }

const PHASES: ReadonlySet<string> = new Set(['data', 'verifying', 'committing', 'completed'])
const OUTCOMES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled', 'outcome-unknown'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 只接受属于本次尝试的消息；taskId 或 attemptId 不符一律丢弃 */
export function isMessageForAttempt(message: unknown, identity: { taskId: string; attemptId: string }): boolean {
  if (!isRecord(message)) return false
  return message.taskId === identity.taskId && message.attemptId === identity.attemptId
}

export function isTransferPhase(value: unknown): value is TransferPhase {
  return typeof value === 'string' && PHASES.has(value)
}

export function isTransferOutcome(value: unknown): value is TransferOutcome {
  return typeof value === 'string' && OUTCOMES.has(value)
}

/** 校验 Worker 上报的结果结构；不合法视为没有终态 */
export function isAttemptResult(value: unknown): value is TransferAttemptResult {
  if (!isRecord(value)) return false
  return (
    typeof value.taskId === 'string' &&
    typeof value.attemptId === 'string' &&
    (value.direction === 'upload' || value.direction === 'download') &&
    isTransferOutcome(value.outcome) &&
    isTransferPhase(value.phase) &&
    Number.isSafeInteger(value.expectedSize) && (value.expectedSize as number) >= 0 &&
    Number.isSafeInteger(value.transferredSize) && (value.transferredSize as number) >= 0 &&
    Number.isSafeInteger(value.bytesWritten) && (value.bytesWritten as number) >= 0 &&
    Array.isArray(value.warnings) && value.warnings.length <= 64 && value.warnings.every(item => typeof item === 'string' && item.length <= 4096) &&
    typeof value.tempPattern === 'string' &&
    (value.error === undefined || isRecord(value.error) && typeof value.error.code === 'string' && typeof value.error.message === 'string') &&
    typeof value.targetPath === 'string' &&
    typeof value.commitDispatched === 'boolean' &&
    typeof value.committed === 'boolean'
  )
}

/**
 * Worker 退出但没有 result 时的兜底判定：
 * - 已请求取消：无法证明远端/本地已回滚，只能报结果未知；
 * - 处于 committing：提交可能已发出，报结果未知；
 * - 其余：确定失败（临时文件清理状态未知）。
 */
export function classifyExitWithoutResult(input: {
  identity: AttemptIdentity
  cancelRequested: boolean
  lastPhase: TransferPhase
  lastTransferredSize: number
  lastTempPath?: string
  terminated: boolean
}): TransferAttemptResult {
  const { identity, cancelRequested, lastPhase, lastTransferredSize, lastTempPath, terminated } = input
  const base = {
    taskId: identity.taskId,
    attemptId: identity.attemptId,
    direction: identity.direction,
    expectedSize: identity.expectedSize,
    transferredSize: lastTransferredSize,
    targetPath: identity.targetPath,
    tempPath: lastTempPath,
    commitDispatched: lastPhase === 'committing' || lastPhase === 'completed'
  }

  if (cancelRequested) {
    return buildSyntheticResult({
      ...base,
      outcome: 'outcome-unknown',
      phase: lastPhase,
      code: 'TRANSFER_CANCEL_UNCONFIRMED',
      message: terminated
        ? '取消请求已发出，但传输 Worker 在确认前被强制终止；无法确认目标是否已被替换，请核查目标与残留临时文件'
        : '取消请求已发出，但传输 Worker 在确认前退出；无法确认目标是否已被替换，请核查目标与残留临时文件',
      tempCleanup: 'unknown'
    })
  }
  if (base.commitDispatched) {
    return buildSyntheticResult({
      ...base,
      outcome: 'outcome-unknown',
      phase: lastPhase,
      code: 'TRANSFER_COMMIT_ACK_LOST',
      message: '传输 Worker 在提交阶段退出且未回报结果；无法确认提交是否生效，已停止重试，请核查目标与残留临时文件',
      tempCleanup: 'unknown'
    })
  }
  return buildSyntheticResult({
    ...base,
    outcome: 'failed',
    phase: lastPhase,
    code: 'TRANSFER_WORKER_EXIT_WITHOUT_RESULT',
    message: '传输 Worker 未回报终态即退出；旧目标未被替换，临时文件清理状态未知',
    tempCleanup: 'unknown'
  })
}

/** Manager 转发给渲染进程的终态/进度载荷（字段与现有 file:progress 契约兼容） */
export interface TransferRendererPayload {
  taskId: string
  sessionId: string
  attemptId: string
  direction: TransferDirection
  progress: number
  transferredSize: number
  fileSize: number
  speed: number
  phase: TransferPhase
  completed?: boolean
  failed?: boolean
  cancelled?: boolean
  outcomeUnknown?: boolean
  code?: TransferErrorCode
  error?: string
  tempPath?: string
  tempPattern: string
  targetPath: string
  tempCleanup?: string
  tempResidual?: string
  warnings?: string[]
}

function percent(transferred: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return transferred > 0 ? 100 : 0
  return Math.max(0, Math.min(100, Math.round((transferred / total) * 100)))
}

/**
 * 把一次尝试的结果折叠成唯一一条终态回执：
 * - completed → completed:true（progress 固定 100）；
 * - cancelled → cancelled:true；
 * - failed → failed:true + 错误码；
 * - outcome-unknown → failed:true + outcomeUnknown:true + 待核查信息（不重试）。
 */
export function resultToRendererPayload(result: TransferAttemptResult, sessionId: string): TransferRendererPayload {
  const payload: TransferRendererPayload = {
    taskId: result.taskId,
    sessionId,
    attemptId: result.attemptId,
    direction: result.direction,
    progress: result.outcome === 'completed' ? 100 : percent(result.transferredSize, result.expectedSize),
    transferredSize: result.transferredSize,
    fileSize: result.expectedSize,
    speed: 0,
    phase: result.phase,
    tempPath: result.tempPath,
    tempPattern: result.tempPattern,
    targetPath: result.targetPath,
    tempCleanup: result.tempCleanup,
    tempResidual: result.tempResidual,
    warnings: result.warnings.length > 0 ? result.warnings : undefined
  }

  if (result.outcome === 'completed') {
    payload.completed = true
    payload.progress = 100
    return payload
  }
  if (result.outcome === 'cancelled') {
    payload.cancelled = true
    payload.code = result.error?.code
    payload.error = result.error?.message
    return payload
  }
  payload.failed = true
  payload.code = result.error?.code
  payload.error = result.error?.message
  if (result.outcome === 'outcome-unknown') {
    payload.outcomeUnknown = true
  }
  return payload
}

/** 进度消息 → 渲染进程载荷；phase 与 attemptId 一律用主进程记录值 */
export function progressToRendererPayload(input: {
  identity: AttemptIdentity
  phase: TransferPhase
  transferredSize: number
  speed: number
}): TransferRendererPayload {
  const { identity, phase, transferredSize, speed } = input
  return {
    taskId: identity.taskId,
    sessionId: identity.sessionId,
    attemptId: identity.attemptId,
    direction: identity.direction,
    progress: percent(transferredSize, identity.expectedSize),
    transferredSize,
    fileSize: identity.expectedSize,
    speed,
    phase,
    tempPattern: describeTransferTempPattern(identity.targetPath, identity.direction, identity.attemptId),
    targetPath: identity.targetPath
  }
}

/**
 * 终态台账：保证每个任务只发一条终态回执，且旧尝试/迟到消息不能回退终态。
 * 有界 FIFO，溢出时淘汰最旧记录（只会导致旧任务重复终态的抑制失效，不会回退新任务）。
 */
export function createTerminalLedger(limit = TRANSFER_TERMINAL_LEDGER_LIMIT) {
  const entries = new Map<string, { attemptId: string; outcome: TransferOutcome }>()

  return {
    /** 是否已经结算过终态（同一任务同一尝试） */
    has(taskId: string, attemptId: string): boolean {
      return entries.has(taskId) && entries.get(taskId)!.attemptId === attemptId
    },
    /** 记录终态；返回 false 表示该任务已有更早/相同的终态，调用方不得再发回执 */
    record(taskId: string, attemptId: string, outcome: TransferOutcome): boolean {
      const existing = entries.get(taskId)
      if (existing && existing.attemptId === attemptId) return false
      if (existing && existing.attemptId !== attemptId) {
        // 同一 taskId 的新尝试（理论上不应发生）覆盖旧记录，但旧尝试的迟到消息会被 has 拒绝
        entries.delete(taskId)
      }
      entries.set(taskId, { attemptId, outcome })
      while (entries.size > limit) {
        const oldest = entries.keys().next()
        if (oldest.done) break
        entries.delete(oldest.value)
      }
      return true
    },
    get(taskId: string): { attemptId: string; outcome: TransferOutcome } | undefined {
      return entries.get(taskId)
    },
    delete(taskId: string): void {
      entries.delete(taskId)
    },
    clear(): void {
      entries.clear()
    },
    get size(): number {
      return entries.size
    }
  }
}

/** 取消确认结果：confirmed 才允许宣布 cancelled */
export type CancelConfirmation = 'confirmed' | 'unconfirmed'

export function confirmationFromResult(result: TransferAttemptResult): CancelConfirmation {
  return result.outcome === 'cancelled' ? 'confirmed' : 'unconfirmed'
}
