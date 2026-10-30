import type { OperationErrorCode, RetryDisposition } from '@shared/operation'

/**
 * 命令执行与资源生命周期的共享契约。
 *
 * 结果（result）和资源关闭（resourceClosed）是两条独立时间线：命令可以先返回失败，
 * 但进程树/通道可能仍在退出；调度名额只认后者。HTTP 入口不得在 result 落定时归还名额。
 */

export interface CommandResult {
  /** 仅在完整完成且未触及输出预算时提供。 */
  output: string
  /** 真实退出码；无退出码时执行器返回 -1，不伪造 0。 */
  exitCode: number
}

/** 取消原因；入参只用于诊断，不改变结果是否确定的判定。 */
export type CancelReason =
  | 'client'
  | 'request-timeout'
  | 'total-timeout'
  | 'shutdown'
  | 'output-limit'

export type ResourceCloseState = 'closed' | 'unconfirmed' | 'failed'

export interface ResourceCloseResult {
  /** 本地进程树/通道是否确认释放。 */
  state: ResourceCloseState
  localClosed: boolean
  /**
   * 远端命令是否确认终止。
   * SSH channel 关闭只证明本地通道释放，不能证明远端进程树已退出。
   */
  remoteTerminated: 'confirmed' | 'unknown' | 'not-dispatched'
  detail?: string
}

/**
 * 一次实际执行的句柄。cancel 必须幂等，并覆盖取消先于 channel-open / spawn 的时序。
 */
export interface CommandExecutionHandle {
  result: Promise<CommandResult>
  resourceClosed: Promise<ResourceCloseResult>
  cancel(reason: CancelReason): void
}

export type CommandState = 'completed' | 'failed' | 'not-started' | 'outcome-unknown'

/** 单目标结果；字段只做补充，保持既有 output / exitCode / error 语义。 */
export interface CommandTargetOutcome {
  sessionId: string
  state: CommandState
  /** 完整完成时才有真实输出；触达预算时不放部分结果。 */
  output?: string
  /** 已执行命令的真实退出码；未派发时省略。 */
  exitCode?: number
  error?: string
  code?: OperationErrorCode
  retryDisposition?: RetryDisposition
  /** 触达输出预算时保留的有界诊断片段，不冒充 output。 */
  partialOutput?: string
  /** 资源关闭回执；未派发为 not-dispatched。 */
  resourceClosed?: ResourceCloseState
  /** 远端是否确认终止；SSH 关闭本地通道时为 unknown。 */
  remoteTerminated?: ResourceCloseResult['remoteTerminated']
  cancelReason?: CancelReason
  /**
   * 固定失败原因；当 code 因结果不确定升级为 OUTCOME_UNKNOWN 时保留原始诱因
   * （例如 OUTPUT_LIMIT），不改变 reconcile-first 的重试语义。
   */
  reason?: string
}

/**
 * 预算初始值集中在此；调整必须同时更新文档与压力测试，不能只改魔法数字。
 * 单位：活动/排队为条数，输出为 UTF-8 字节，期限为毫秒。
 */
export const COMMAND_LIMITS = {
  /** 全局同时实际执行的命令数。 */
  globalActive: 16,
  /** 单调用者同时实际执行数；公平轮转，防止一个批次占满。 */
  callerActive: 4,
  /** 单端点（受控连接身份）同时实际执行数。 */
  endpointActive: 2,
  /** 全局等待执行的命令数；满则明确拒绝。 */
  globalQueued: 128,
  /** 单调用者等待执行数；保留 50 目标批次的使用能力。 */
  callerQueued: 50,
  /** 单批次保留输出。 */
  batchOutputBytes: 8 * 1024 * 1024,
  /** 全局保留输出（活动收集 + 等待发送结果）。 */
  globalOutputBytes: 32 * 1024 * 1024,
  /** 全局序列化/待发送预算；无容量时排队或拒绝，不做无界 stringify。 */
  globalSendBytes: 64 * 1024 * 1024,
  /** 整批总期限默认值；timeout 仍是单条执行期限。 */
  totalTimeoutMs: 55_000
} as const

/** 批次/单条执行的派发目标。鉴权与连接复核仍由入口闭包负责。 */
export interface CommandTargetSpec {
  sessionId: string
  /** 受控连接身份构造的端点键；缺省退化为 sessionId。 */
  endpointKey?: string
  /**
   * 出队后、派发前的复核：调用者权限、会话对象、连接 generation、插件状态。
   * 抛错表示不派发；不得据此重放已派发的命令。
   */
  revalidate?: () => void | Promise<void>
  /**
   * 实际执行。实现必须在内部调用最终 dispatch guard（F01/F02）。
   * 返回句柄表示已可能产生副作用；同步/异步抛错表示未派发。
   */
  dispatch: (context: CommandDispatchContext) => CommandExecutionHandle
}

/** 调度器交给执行实现的上下文。 */
export interface CommandDispatchContext {
  /** 中止信号；只表达取消，不代替权限复核。 */
  signal: AbortSignal
  /** 单条命令执行期限（已包含入口默认值），执行器必须真正使用它。 */
  timeoutMs: number
  /**
   * 增量预留结果保留字节（同一批共享批次上限）。
   * 超限同步抛 RESOURCE_LIMIT，执行器必须带 partialOutput 失败。
   */
  reserveBytes: (deltaBytes: number) => void
}

export interface BatchCommandRequest {
  /** 调用者键：凭据/主体身份，用于公平排队与配额。 */
  callerKey: string
  targets: readonly CommandTargetSpec[]
  /** 单条命令执行期限；沿用既有默认 30s。 */
  timeoutMs?: number
  /** 整批期限（含排队）；默认 COMMAND_LIMITS.totalTimeoutMs。 */
  totalTimeoutMs?: number
  onOutput?: (sessionId: string, chunk: string) => void
}

export interface CommandBatchResult {
  results: CommandTargetOutcome[]
  /** 结果仍占用的保留字节；release 前一直计入全局预算。 */
  retainedBytes: number
  totalTimeoutMs: number
}

export interface CommandBatchExecution {
  results: Promise<CommandBatchResult>
  /** 取消整批：未派发标 not-started，运行中按真实资源关闭回执返回。 */
  cancel(reason: CancelReason): void
  /**
   * 归还本批结果占用的保留预算。必须在结果发送完成、客户端断开或结果被丢弃后调用；
   * 幂等。未调用会持续占用全局保留额度（不能在 result 落定时自动释放）。
   */
  release(): void
}

/**
 * 关闭结果：不得把未确认清理伪装成成功。
 * state=unconfirmed 时对应的全局名额仍被占用，调用方必须把该状态计入退出报告。
 */
export interface CommandShutdownResult {
  state: 'closed' | 'unconfirmed'
  reason: CancelReason
  /** 未派发即被取消的目标/请求数。 */
  cancelled: number
  /** 已派发但资源关闭未能确认的执行数。 */
  unconfirmed: number
}
