/**
 * 终端输入控制权 —— 共享契约（类型 + 校验 + fence 判定 + 稳定错误）
 *
 * 该模块是**纯逻辑**：不依赖 Node/Electron，main（含 local host worker）与测试共用。
 * 它只描述「一个会话在某个时刻允许谁写」这件事实，不持有租约、不发 IO：
 *   - main 侧的租约与代际在 `@main/terminal/input-control.ts`（InputControlService）；
 *   - 真正落到 PTY 的核对在宿主 `local-host-worker.ts`（协议 v2 的 input-fence）。
 *
 * 纪律：
 *   - 句柄里**只有持有者自己的身份**，不含其他调用方的 principal/credential。
 *   - 权限判定永远在服务端/宿主侧；这里的 check* 函数只负责判断「这份 fence 还作不作数」。
 */

import { OperationError, type OperationErrorCode, type RetryDisposition } from './operation'

// ── 常量 ──────────────────────────────────────────────────────────────────────

/** 本地 PTY 宿主必须声明的最小能力：带 fence 的输入。缺失即拒绝握手。 */
export const INPUT_CONTROL_CAPABILITY = 'input-fence-v1'

/** 租约默认有效期；超时必须显式续期（不自动续期、不自动重放）。 */
export const CONTROL_LEASE_DEFAULT_TTL_MS = 30_000

/** 单次续期允许的最长有效期，避免「一次取得永久有效」。 */
export const CONTROL_LEASE_MAX_TTL_MS = 10 * 60_000

const MAX_ID_CHARS = 128

export const CONTROL_SOURCES = ['gui', 'automation', 'internal'] as const

/**
 * 调用来源：
 *   - gui：人在界面上操作（main 从已认证的 IPC sender 取得）；
 *   - automation：MCP / HTTP / 插件等自动执行（必须带用户上下文确认）；
 *   - internal：main 自己的受控启动路径（例如内部 startup 写入），仍走同一套租约。
 */
export type ControlSource = (typeof CONTROL_SOURCES)[number]

// ── 身份与句柄 ────────────────────────────────────────────────────────────────

/**
 * 已认证的调用身份。**由 main 调用方注入**，绝不接受请求体里的自报身份。
 * `credentialId` 只作为标识（哪把凭据），本身不是凭据值。
 */
export interface ControllerIdentity {
  principalId: string
  credentialId?: string
  source: ControlSource
}

/**
 * 输入围栏：随每一次写入下发、在最终 `pty.write` 前核对的冻结值。
 * 四个代际字段缺一不可——任一不匹配都说明这份输入属于旧连接/旧租约/旧 main 实例。
 */
export interface InputFence {
  /** 同一 session 内每次取得租约严格递增；取得失败也消耗一个值，绝不复用。 */
  epoch: number
  /** main 为每个真实 connector 生成的连接实例 id；换连接即换值。 */
  connectionInstanceId: string
  /** 本 main 实例随机 UUID；main 重启即变，用于跨实例换代。 */
  controllerInstanceId: string
  /** 租约随机 UUID。 */
  leaseId: string
  /** 租约到期时刻（epoch ms）。 */
  expiresAt: number
}

/** 交给调用方的控制句柄：fence + 该持有者自己的身份，不含其他调用方凭据。 */
export interface ControlHandle extends InputFence {
  sessionId: string
  principalId: string
  credentialId?: string
  source: ControlSource
  issuedAt: number
}

/** 只读快照（诊断/界面提示用）：`credentialId` 是标识，不是凭据值。 */
export interface ControlSnapshot {
  sessionId: string
  connectionInstanceId: string | null
  controllerInstanceId: string
  /** 每次 bindSession 换连接实例时递增。 */
  generation: number
  lease: null | {
    leaseId: string
    epoch: number
    issuedAt: number
    expiresAt: number
    principalId: string
    credentialId?: string
    source: ControlSource
  }
}

// ── 稳定错误 ──────────────────────────────────────────────────────────────────

/**
 * 精确失败原因。`code` 走 `@shared/operation` 的稳定枚举（便于跨入口统一处理），
 * `reason` 用于区分「租约过期 / 连接已替换 / 宿主版本不兼容」这类同 code 不同情形。
 */
export type InputControlErrorReason =
  | 'session-not-bound'
  | 'held-by-other'
  | 'context-not-confirmed'
  | 'automation-takeover-denied'
  | 'not-holder'
  | 'lease-expired'
  | 'lease-revoked'
  | 'connection-replaced'
  | 'fence-not-installed'
  | 'credential-revoked'
  | 'fence-install-failed'
  | 'host-rejected'
  | 'version-incompatible'
  | 'invalid-input'

interface ReasonSpec {
  code: OperationErrorCode
  message: string
  retry: RetryDisposition
}

/**
 * 拒绝之后**不得**自动重新取得租约并重放输入（步骤 07 第 4 条），因此除「fence 安装失败
 * （什么都没写出去，可安全重试 acquire）」外一律 `never`。
 */
const REASON_SPECS: Record<InputControlErrorReason, ReasonSpec> = {
  'session-not-bound': {
    code: 'RESOURCE_NOT_FOUND',
    message: 'This session has no registered connection instance',
    retry: 'never'
  },
  'held-by-other': {
    code: 'CONTROL_CONFLICT',
    message: 'Another controller currently holds the input lease for this session',
    retry: 'never'
  },
  'context-not-confirmed': {
    code: 'INVALID_ARGUMENT',
    message: 'Automation must carry an explicit user-confirmed terminal context before acquiring input control',
    retry: 'never'
  },
  'automation-takeover-denied': {
    code: 'FORBIDDEN',
    message: 'Automation cannot take over an existing input lease; a human takeover must come from the GUI',
    retry: 'never'
  },
  'not-holder': {
    code: 'STALE_GENERATION',
    message: 'This control handle is not the current lease for the session',
    retry: 'never'
  },
  'lease-expired': {
    code: 'STALE_GENERATION',
    message: 'The input control lease has expired and must not be renewed implicitly',
    retry: 'never'
  },
  'lease-revoked': {
    code: 'STALE_GENERATION',
    message: 'The input control lease was released or revoked',
    retry: 'never'
  },
  'connection-replaced': {
    code: 'STALE_GENERATION',
    message: 'The session connection was replaced; the previous lease and its input are invalid',
    retry: 'never'
  },
  'fence-not-installed': {
    code: 'STALE_GENERATION',
    message: 'No input fence is currently installed for this session, input is denied',
    retry: 'never'
  },
  'credential-revoked': {
    code: 'UNAUTHENTICATED',
    message: 'The credential that requested input control is no longer valid',
    retry: 'never'
  },
  'fence-install-failed': {
    code: 'CONTROL_CONFLICT',
    message: 'The execution boundary did not confirm the input fence, so no lease was issued',
    retry: 'safe'
  },
  'host-rejected': {
    code: 'CONTROL_CONFLICT',
    message: 'The terminal host rejected the input fence',
    retry: 'never'
  },
  'version-incompatible': {
    code: 'INCOMPATIBLE_VERSION',
    message: 'The terminal host does not speak the fenced input protocol (v2); it cannot be used for controlled input',
    retry: 'never'
  },
  'invalid-input': {
    code: 'INVALID_ARGUMENT',
    message: 'Invalid input control request',
    retry: 'never'
  }
}

/** 带固定 code/reason 的控制权错误；仍是 `OperationError`，调用方可按 code 统一处理。 */
export class InputControlError extends OperationError {
  readonly reason: InputControlErrorReason

  constructor(reason: InputControlErrorReason, message?: string) {
    const spec = REASON_SPECS[reason]
    super(spec.code, message ?? spec.message, spec.retry)
    this.name = 'InputControlError'
    this.reason = reason
  }
}

/** 把任意错误收敛成 InputControlError：已是控制权错误原样返回，其余按 fallback 归类。 */
export function asInputControlError(
  error: unknown,
  fallback: InputControlErrorReason = 'fence-install-failed'
): InputControlError {
  if (error instanceof InputControlError) return error
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return new InputControlError(fallback, text.length > 0 ? text.slice(0, 512) : undefined)
}

/** 宿主/连接器抛错时归类：版本不兼容要单独可辨，其余算宿主拒绝。 */
export function controlErrorForHostFailure(error: unknown): InputControlError {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  if (code === 'incompatible-version') {
    return new InputControlError('version-incompatible')
  }
  return asInputControlError(error, 'host-rejected')
}

// ── 校验 ──────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isBoundedId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS
}

/** epoch 是严格正整数；0/负数/小数/非安全整数都不是合法代际。 */
export function isEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function isExpiry(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

export function isControlSource(value: unknown): value is ControlSource {
  return typeof value === 'string' && (CONTROL_SOURCES as readonly string[]).includes(value)
}

export function isInputFence(value: unknown): value is InputFence {
  if (!isRecord(value)) return false
  return (
    isEpoch(value.epoch) &&
    isBoundedId(value.connectionInstanceId) &&
    isBoundedId(value.controllerInstanceId) &&
    isBoundedId(value.leaseId) &&
    isExpiry(value.expiresAt)
  )
}

export function isControlHandle(value: unknown): value is ControlHandle {
  if (!isRecord(value)) return false
  if (!isInputFence(value)) return false
  if (!isBoundedId(value.sessionId)) return false
  if (!isBoundedId(value.principalId)) return false
  if (!isControlSource(value.source)) return false
  if (value.credentialId !== undefined && !isBoundedId(value.credentialId)) return false
  if (typeof value.issuedAt !== 'number' || !Number.isFinite(value.issuedAt)) return false
  return true
}

export function isControllerIdentity(value: unknown): value is ControllerIdentity {
  if (!isRecord(value)) return false
  if (!isBoundedId(value.principalId)) return false
  if (!isControlSource(value.source)) return false
  if (value.credentialId !== undefined && !isBoundedId(value.credentialId)) return false
  return true
}

/**
 * 只取五个代际字段：句柄里的身份信息**不**随写入下发，
 * 宿主只需要判断「这份输入属于哪个代际」，不需要知道调用方的 principal。
 */
export function fenceOf(handle: InputFence | ControlHandle): InputFence {
  return {
    epoch: handle.epoch,
    connectionInstanceId: handle.connectionInstanceId,
    controllerInstanceId: handle.controllerInstanceId,
    leaseId: handle.leaseId,
    expiresAt: handle.expiresAt
  }
}

export function sameFence(a: InputFence | null | undefined, b: InputFence | null | undefined): boolean {
  if (!a || !b) return a === b
  return (
    a.epoch === b.epoch &&
    a.connectionInstanceId === b.connectionInstanceId &&
    a.controllerInstanceId === b.controllerInstanceId &&
    a.leaseId === b.leaseId &&
    a.expiresAt === b.expiresAt
  )
}

/** 同一次租约（不看 expiresAt）：续期前后仍是同一租约。 */
export function sameLease(a: InputFence | null | undefined, b: InputFence | null | undefined): boolean {
  if (!a || !b) return a === b
  return (
    a.epoch === b.epoch &&
    a.connectionInstanceId === b.connectionInstanceId &&
    a.controllerInstanceId === b.controllerInstanceId &&
    a.leaseId === b.leaseId
  )
}

// ── fence 判定（宿主/连接器/服务共用的唯一判定） ──────────────────────────────

export type FenceInputRejectionReason = 'no-fence' | 'invalid-fence' | 'lease-mismatch' | 'expired'

/**
 * 写入前判定：这份输入能不能落地。
 * 返回 null = 可以写；否则给出固定分类，由宿主映射成 `input-denied` / `input-expired`。
 */
export function checkInputFence(
  active: InputFence | null,
  incoming: InputFence | null | undefined,
  now: number
): FenceInputRejectionReason | null {
  if (!active) return 'no-fence'
  if (!isInputFence(incoming)) return 'invalid-fence'
  if (
    active.epoch !== incoming.epoch ||
    active.connectionInstanceId !== incoming.connectionInstanceId ||
    active.controllerInstanceId !== incoming.controllerInstanceId ||
    active.leaseId !== incoming.leaseId
  ) {
    return 'lease-mismatch'
  }
  if (!(now < active.expiresAt) || !(now < incoming.expiresAt)) return 'expired'
  return null
}

/**
 * 断开/撤销后保留的代际下限：同 epoch 不能被重新安装（旧 fence 永久失效）。
 * `last` 仅用于诊断；断线重连必须重新取得更高代际，不恢复旧租约。
 */
export interface FenceFloor {
  epoch: number
  controllerInstanceId: string
  last: InputFence | null
}

export type FenceInstallRejectionReason = 'invalid-fence' | 'epoch-stale'

/**
 * 安装判定（宿主侧唯一入口）：
 *   1. 新的 main 实例（`controllerInstanceId` 不同）可以接管，即使 epoch 更小
 *      —— 宿主只允许一个活动 main 连接，另一个实例此时拿不到写通道；
 *   2. 同实例内 epoch 必须严格递增（旧代际/旧 main 的延迟安装被拒）；
 *   3. 例外一：同一租约续期——同 epoch、同 leaseId/连接/控制器，且新 expiresAt 不早于旧的；
 */
export function checkFenceInstall(
  previous: InputFence | null,
  floor: FenceFloor | null,
  next: InputFence | null | undefined
): FenceInstallRejectionReason | null {
  if (!isInputFence(next)) return 'invalid-fence'
  if (floor && floor.controllerInstanceId !== next.controllerInstanceId) return null
  // 换了 main 实例（重启/新窗口）：宿主只认一个活动连接，旧实例此时已经没有写通道，
  // 因此允许新实例以自己的 epoch 序列接管。
  if (previous && previous.controllerInstanceId !== next.controllerInstanceId) return null
  if (previous) {
    if (next.epoch > previous.epoch) return null
    if (next.epoch === previous.epoch && sameLease(previous, next) && next.expiresAt >= previous.expiresAt) {
      return null
    }
    return 'epoch-stale'
  }
  const base = floor?.epoch ?? 0
  if (next.epoch > base) return null
  return 'epoch-stale'
}

/** 安装成功后用于记录代际下限；撤销（fence=null）时保留最后安装值，从而让同 epoch 失效。 */
export function nextFenceFloor(previous: InputFence | null, floor: FenceFloor | null): FenceFloor | null {
  if (!previous) return floor
  if (floor && floor.controllerInstanceId === previous.controllerInstanceId && floor.epoch >= previous.epoch) {
    // 同代际续期：只更新诊断中最后确认的有效期。
    if (previous.epoch === floor.epoch) {
      const last = floor.last
      if (!last || previous.expiresAt > last.expiresAt) {
        return { epoch: floor.epoch, controllerInstanceId: floor.controllerInstanceId, last: previous }
      }
    }
    return floor
  }
  return { epoch: previous.epoch, controllerInstanceId: previous.controllerInstanceId, last: previous }
}
