/**
 * 外部等待模式的隔离匹配契约 —— 纯逻辑模块（不依赖 Node/Electron）。
 *
 * 纪律（R1）：
 *   - 外部提供的 `waitForPattern` / `pattern` **绝不在主线程编译或执行**；
 *     编译与匹配都发生在 `pattern-worker.ts` 的独立 Worker 线程里，可被 terminate 打断。
 *   - 模式默认仍是 `regex`（与旧行为兼容）；`literal` 表示纯子串匹配，不编译正则。
 *   - 不接受任意 flags：`g`/`y` 会让 `lastIndex` 在多次匹配之间残留状态，跨轮询结果不可复现。
 *   - 同步校验只做「形态 + 长度 + 模式」，语法错误由 Worker 内的 `new RegExp` 发现。
 */
import { OperationError, type OperationErrorCode, type RetryDisposition } from '@shared/operation'

// ── 模式 ──────────────────────────────────────────────────────────────────────

export type MatchMode = 'regex' | 'literal'

export const MATCH_MODES: readonly MatchMode[] = ['regex', 'literal']

/** 未显式给出 pattern 时 wait_for_prompt 使用的内置提示符（正则模式）。 */
export const BUILTIN_PROMPT_PATTERN = '[$#>%]\\s*$'

export function isMatchMode(value: unknown): value is MatchMode {
  return typeof value === 'string' && (MATCH_MODES as readonly string[]).includes(value)
}

export interface PatternSpec {
  pattern: string
  /** 缺省 = 'regex' */
  mode?: MatchMode
}

// ── 上限 ──────────────────────────────────────────────────────────────────────

/**
 * 初始上限（计划 R1 3.3）。测试可注入更小的值，但生产值只能收紧不能放宽。
 * 注意：Worker 的 `resourceLimits` 不是 RSS 上限，这里靠「有界池 + 输入预算 + 硬超时」约束。
 */
export interface PatternLimits {
  /** 单个 pattern 源长度（UTF-16 code units），入队前同步检查 */
  maxPatternChars: number
  /** 单个匹配基底长度 */
  maxBaseChars: number
  /** 单个任务所有基底合计长度 */
  maxJobInputChars: number
  /** Worker 总数（含正在停止、尚未确认退出的 Worker） */
  maxWorkers: number
  /** 全局排队任务上限 */
  maxQueuedJobs: number
  /** 每个可信主体同时等待的任务数上限（按整个等待调用计，不是单次 match） */
  maxWaitersPerCaller: number
  /** 全局等待任务数上限（覆盖整个等待调用，排队/在途匹配另计） */
  maxWaiters: number
  /** 全局预留输入字符预算（排队 + 在途快照） */
  reservedInputChars: number
  /** 单次匹配硬超时：从 Worker `ready` 后 postMessage 起算，覆盖编译 + 匹配 */
  matchDeadlineMs: number
  /** Worker 启动期限：超过仍未就绪则判失败（没有主线程兜底） */
  workerStartDeadlineMs: number
  /** terminate 后等待 exit 确认的期限 */
  workerExitDeadlineMs: number
  /** 排队总期限默认值（含排队等待） */
  defaultQueueTimeoutMs: number
}

export const PATTERN_LIMITS: PatternLimits = {
  maxPatternChars: 2048,
  maxBaseChars: 1_048_576,
  maxJobInputChars: 2_097_152,
  maxWorkers: 2,
  maxQueuedJobs: 16,
  maxWaitersPerCaller: 4,
  maxWaiters: 16,
  reservedInputChars: 16_777_216,
  matchDeadlineMs: 100,
  workerStartDeadlineMs: 2_000,
  workerExitDeadlineMs: 5_000,
  defaultQueueTimeoutMs: 2_000
}

// ── 稳定错误 ──────────────────────────────────────────────────────────────────

/**
 * 精确失败原因。`code` 走 `@shared/operation` 的稳定枚举，`reason` 区分同 code 的不同情形
 * （例如「正则执行超时」必须与「池容量不足」区分，前者禁止自动重试同一表达式）。
 */
export type PatternFailureReason =
  | 'INVALID_PATTERN'
  | 'PATTERN_NOT_A_STRING'
  | 'PATTERN_TOO_LONG'
  | 'UNSUPPORTED_MATCH_MODE'
  | 'MATCH_INPUT_INVALID'
  | 'MATCH_INPUT_TOO_LARGE'
  | 'MATCH_QUEUE_FULL'
  | 'MATCH_QUEUE_TIMEOUT'
  | 'MATCH_EXECUTION_TIMEOUT'
  | 'MATCH_WORKER_START_FAILED'
  | 'MATCH_WORKER_FAILED'
  | 'MATCH_WORKER_UNAVAILABLE'
  | 'MATCH_SERVICE_SHUTDOWN'
  | 'MATCH_CANCELLED'
  | 'MATCH_AUTHORIZATION_REVOKED'
  | 'PATTERN_MODE_WITHOUT_PATTERN'

interface PatternFailureSpec {
  code: OperationErrorCode
  message: string
  retry: RetryDisposition
}

/**
 * 公共消息固定不变（不外泄正则原文、堆栈或用户输出）。
 * 超时类错误一律 `never`：同一表达式自动重试只会再撞一次同一死循环。
 */
const FAILURE_SPECS: Record<PatternFailureReason, PatternFailureSpec> = {
  INVALID_PATTERN: {
    code: 'INVALID_ARGUMENT',
    message: 'Wait pattern is not a valid regular expression',
    retry: 'never'
  },
  PATTERN_TOO_LONG: {
    code: 'INVALID_ARGUMENT',
    message: 'Wait pattern exceeds the maximum length',
    retry: 'never'
  },
  PATTERN_NOT_A_STRING: {
    code: 'INVALID_ARGUMENT',
    message: 'Wait pattern must be a string',
    retry: 'never'
  },
  UNSUPPORTED_MATCH_MODE: {
    code: 'INVALID_ARGUMENT',
    message: 'Wait pattern mode is not supported',
    retry: 'never'
  },
  MATCH_INPUT_INVALID: {
    code: 'INVALID_ARGUMENT',
    message: 'Wait pattern input is invalid',
    retry: 'never'
  },
  MATCH_INPUT_TOO_LARGE: {
    code: 'RESOURCE_LIMIT',
    message: 'Wait pattern input exceeds the maximum size',
    retry: 'safe'
  },
  MATCH_QUEUE_FULL: {
    code: 'RESOURCE_LIMIT',
    message: 'Wait pattern matcher is at capacity',
    retry: 'safe'
  },
  MATCH_QUEUE_TIMEOUT: {
    code: 'RESOURCE_LIMIT',
    message: 'Wait pattern matching could not start in time',
    retry: 'safe'
  },
  MATCH_EXECUTION_TIMEOUT: {
    code: 'RESOURCE_LIMIT',
    message: 'Wait pattern matching exceeded the execution deadline',
    retry: 'never'
  },
  MATCH_WORKER_START_FAILED: {
    code: 'RESOURCE_LIMIT',
    message: 'Wait pattern matcher is unavailable',
    retry: 'never'
  },
  MATCH_WORKER_FAILED: {
    code: 'RESOURCE_LIMIT',
    message: 'Wait pattern matcher stopped unexpectedly',
    retry: 'never'
  },
  MATCH_WORKER_UNAVAILABLE: {
    code: 'RESOURCE_LIMIT',
    message: 'Wait pattern matcher has no available worker',
    retry: 'safe'
  },
  MATCH_SERVICE_SHUTDOWN: {
    code: 'FORBIDDEN',
    message: 'Application is shutting down',
    retry: 'never'
  },
  MATCH_CANCELLED: {
    code: 'RESOURCE_LIMIT',
    message: 'Wait pattern matching was cancelled',
    retry: 'safe'
  },
  MATCH_AUTHORIZATION_REVOKED: {
    code: 'FORBIDDEN',
    message: 'Terminal authorization was revoked while observing output',
    retry: 'never'
  },
  PATTERN_MODE_WITHOUT_PATTERN: {
    code: 'INVALID_ARGUMENT',
    message: 'Wait pattern mode requires an explicit pattern',
    retry: 'never'
  }
}

/** 带固定 `code` / `reason` 的匹配错误；仍是 `OperationError`，调用方可按 code 统一处理。 */
export class PatternMatchError extends OperationError {
  readonly reason: PatternFailureReason

  constructor(reason: PatternFailureReason, message?: string) {
    const spec = FAILURE_SPECS[reason]
    super(spec.code, message ?? spec.message, spec.retry)
    this.name = 'PatternMatchError'
    this.reason = reason
  }
}

/**
 * 把任意错误收敛成 PatternMatchError：已知原因原样返回，其余按 fallback 归类。
 * 不透传原始错误文本：公共消息固定，避免把正则原文/堆栈/终端输出带进响应。
 */
export function asPatternMatchError(error: unknown, fallback: PatternFailureReason = 'MATCH_WORKER_FAILED'): PatternMatchError {
  if (error instanceof PatternMatchError) return error
  return new PatternMatchError(fallback)
}

/**
 * 输入已经发出、但观测阶段无法确认结果时的错误：
 * 统一 `OUTCOME_UNKNOWN` + `reconcile-first`（调用方必须先对账，绝不能按「安全重试」重发同一段输入），
 * 同时保留精确的 `reason` 供日志/诊断区分（例如硬超时 vs 授权撤销）。
 */
export class PatternOutcomeUnknownError extends OperationError {
  readonly reason: PatternFailureReason

  constructor(
    reason: PatternFailureReason,
    message = 'Terminal output could not be confirmed after input; reconcile before sending more input'
  ) {
    super('OUTCOME_UNKNOWN', message, 'reconcile-first')
    this.name = 'PatternOutcomeUnknownError'
    this.reason = reason
  }
}

/**
 * 把观测阶段的任意错误收敛成「输入已发出、结果未知」：
 *   - 已经是 OUTCOME_UNKNOWN 的错误原样返回；
 *   - 会话/连接被替换保留 STALE_GENERATION（同样 reconcile-first，语义更精确）；
 *   - PatternMatchError 保留其 `reason`，但 code 改为 OUTCOME_UNKNOWN；
 *   - 授权撤销映射到固定 reason `MATCH_AUTHORIZATION_REVOKED`。
 */
export function asOutcomeUnknownError(
  error: unknown,
  fallback: PatternFailureReason = 'MATCH_WORKER_FAILED'
): OperationError {
  if (error instanceof PatternOutcomeUnknownError) return error
  if (error instanceof OperationError) {
    if (error.code === 'OUTCOME_UNKNOWN' || error.code === 'STALE_GENERATION') return error
    if (error.code === 'FORBIDDEN') return new PatternOutcomeUnknownError('MATCH_AUTHORIZATION_REVOKED')
  }
  if (error instanceof PatternMatchError) return new PatternOutcomeUnknownError(error.reason)
  return new PatternOutcomeUnknownError(fallback)
}

// ── 同步校验 ──────────────────────────────────────────────────────────────────

/**
 * 同步校验 pattern 形态、长度与模式。**不编译正则**（编译必须在 Worker 内）。
 * 失败直接抛 PatternMatchError（INVALID_ARGUMENT），调用方据此在写终端之前终止。
 */
export function validatePatternSpec(
  spec: PatternSpec,
  limits: Pick<PatternLimits, 'maxPatternChars'> = PATTERN_LIMITS
): { pattern: string; mode: MatchMode } {
  if (!spec || typeof spec !== 'object') throw new PatternMatchError('INVALID_PATTERN')
  const pattern = spec.pattern
  if (typeof pattern !== 'string' || pattern.length === 0) throw new PatternMatchError('INVALID_PATTERN')
  if (pattern.length > limits.maxPatternChars) throw new PatternMatchError('PATTERN_TOO_LONG')
  const rawMode = spec.mode
  const mode: MatchMode = rawMode === undefined ? 'regex' : rawMode
  if (!isMatchMode(mode)) throw new PatternMatchError('UNSUPPORTED_MATCH_MODE')
  return { pattern, mode }
}

/** 校验一组匹配基底：类型、单条长度、合计长度。 */
export function validateMatchInputs(
  inputs: readonly string[],
  limits: Pick<PatternLimits, 'maxBaseChars' | 'maxJobInputChars'> = PATTERN_LIMITS
): number {
  if (!Array.isArray(inputs) || inputs.length === 0) throw new PatternMatchError('MATCH_INPUT_INVALID')
  let total = 0
  for (const input of inputs) {
    if (typeof input !== 'string') throw new PatternMatchError('MATCH_INPUT_INVALID')
    if (input.length > limits.maxBaseChars) throw new PatternMatchError('MATCH_INPUT_TOO_LARGE')
    total += input.length
    if (total > limits.maxJobInputChars) throw new PatternMatchError('MATCH_INPUT_TOO_LARGE')
  }
  return total
}

// ── Worker 协议 ───────────────────────────────────────────────────────────────

/** 协议版本：Worker 首帧 `ready` 回带；不匹配即视为启动失败（不做旧协议兼容）。 */
export const PATTERN_WORKER_PROTOCOL = 1

export interface PatternWorkerMatchRequest {
  type: 'match'
  jobId: string
  generation: number
  pattern: string
  mode: MatchMode
  inputs: string[]
}

export interface PatternWorkerCompileRequest {
  type: 'compile'
  jobId: string
  generation: number
  pattern: string
  mode: MatchMode
}

export type PatternWorkerRequest = PatternWorkerMatchRequest | PatternWorkerCompileRequest

export interface PatternWorkerReady {
  type: 'ready'
  protocol: number
}

export interface PatternWorkerMatchResponse {
  type: 'match'
  jobId: string
  generation: number
  matched: boolean
  matchedIndex: number
  elapsedMs: number
}

export interface PatternWorkerCompileResponse {
  type: 'compile'
  jobId: string
  generation: number
  elapsedMs: number
}

export interface PatternWorkerErrorResponse {
  type: 'error'
  jobId: string
  generation: number
  reason: PatternFailureReason
  message: string
}

export type PatternWorkerResponse =
  | PatternWorkerReady
  | PatternWorkerMatchResponse
  | PatternWorkerCompileResponse
  | PatternWorkerErrorResponse

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 主线程侧对 Worker 回包的防御性校验：形态不合法按迟到/异常消息丢弃。 */
export function isPatternWorkerResponse(value: unknown): value is PatternWorkerResponse {
  if (!isRecord(value)) return false
  if (value.type === 'ready') return typeof value.protocol === 'number'
  if (value.type !== 'match' && value.type !== 'compile' && value.type !== 'error') return false
  if (typeof value.jobId !== 'string' || value.jobId.length === 0) return false
  if (typeof value.generation !== 'number' || !Number.isSafeInteger(value.generation) || value.generation <= 0) return false
  if (value.type === 'error') {
    return typeof value.reason === 'string' && value.reason in FAILURE_SPECS && typeof value.message === 'string'
  }
  if (value.type === 'match') {
    return typeof value.matched === 'boolean'
      && typeof value.matchedIndex === 'number'
      && typeof value.elapsedMs === 'number'
  }
  return typeof value.elapsedMs === 'number'
}
