/**
 * 输出按 UTF-16 代码单元计量，与 xterm.write / 字符串游标一致。
 * 注意：不是 UTF-8 字节数；中文、emoji 的“宽度”与这里的计量无关。
 *
 * 下面的容量参数都是**可调候选值**，集中放在这里便于按实测调整。
 */

/** 单帧最大字符数（UTF-16 代码单元）。 */
export const TERMINAL_OUTPUT_PACKET_SIZE = 64 * 1024
/** 高水位：每消费者积压达到即暂停 PTY。 */
export const TERMINAL_OUTPUT_HIGH_WATER = 256 * 1024
/** 低水位：回落到此值以下（含）才恢复 PTY。 */
export const TERMINAL_OUTPUT_LOW_WATER = 64 * 1024
/** 单个 GUI 消费者允许积压的上限（含未 ACK 的在途帧）。 */
export const TERMINAL_OUTPUT_MAX_PENDING = 1024 * 1024

/** GUI 队列全局总预算（所有窗口所有会话的积压之和，UTF-16 代码单元）。候选值 8 MiB。 */
export const TERMINAL_OUTPUT_TOTAL_QUEUE_BUDGET = 8 * 1024 * 1024
/** 同时存在的 GUI 消费者（即订阅）数量上限。候选值 64。 */
export const TERMINAL_OUTPUT_MAX_CONSUMERS = 64
/**
 * 单消费者等待 ACK 的上限（毫秒）。候选值 15000。
 * 超时后该消费者被撤销并解除背压：PTY 与其他消费者的 ACK 不再被它阻塞。
 */
export const TERMINAL_OUTPUT_ACK_TIMEOUT_MS = 15_000

/** 单次增量读默认的响应字符数（UTF-16 代码单元）。候选值 64 KiB。 */
export const TERMINAL_OUTPUT_MAX_RESPONSE_CHARS = 64 * 1024
/** 单次增量读允许的响应硬上限（UTF-16 代码单元）。候选值 1 MiB。 */
export const TERMINAL_OUTPUT_HARD_MAX_RESPONSE_CHARS = 1024 * 1024

/** 单会话历史缓冲容量上限（UTF-16 代码单元）。候选值 1 MiB。 */
export const TERMINAL_OUTPUT_HISTORY_LIMIT = 1024 * 1024
/** 所有会话历史缓冲的合计容量上限（UTF-16 代码单元）。候选值 32 MiB。 */
export const TERMINAL_OUTPUT_HISTORY_TOTAL_BUDGET = 32 * 1024 * 1024

/**
 * 回执错误码。任取其一即表示该消费者已失效，渲染层不应再按正常帧处理。
 * - `overflow`        单消费者积压超过 TERMINAL_OUTPUT_MAX_PENDING
 * - `queue-budget`    GUI 队列全局总预算耗尽
 * - `ack-timeout`     ACK 有界等待超时，消费者被撤销
 * - `consumer-limit`  消费者数量达到 TERMINAL_OUTPUT_MAX_CONSUMERS
 * - `send-failed`     发送通道抛错，消费者被撤销
 * - `disposed`        窗口/会话/调度器已销毁
 */
export type TerminalOutputReceiptError =
  | 'overflow'
  | 'queue-budget'
  | 'ack-timeout'
  | 'consumer-limit'
  | 'send-failed'
  | 'disposed'
  | 'history-gap'

export interface TerminalOutputReceipt {
  subscriptionId: string
  sequence: number
  error?: TerminalOutputReceiptError
}

export type TerminalOutputControl =
  | { kind: 'subscribe'; sessionId: string }
  | { kind: 'ack'; sessionId: string; subscriptionId: string; sequence: number }
  | { kind: 'unsubscribe'; sessionId: string; subscriptionId: string }

/**
 * 增量读取请求。游标与代际都由 `OutputBuffer.readIncremental` 返回：
 * - 代际不符 = 缓冲已被清空/重建，旧游标整体失效；
 * - 游标早于 earliestCursor = 这段历史被容量挤掉（永久缺口）。
 */
export interface TerminalOutputReadRequest {
  /** 上次结果里的 outputEpoch；首次读取可省略。 */
  outputEpoch?: number
  /** 上次结果里的 nextCursor；首次读取传 0。 */
  cursor: number
  /** 是否剥离 ANSI，默认 false（与 getOutputSince 语义一致）。 */
  stripAnsi?: boolean
  /** 本次最多返回多少 UTF-16 代码单元；缺省用默认值，超硬上限按硬上限。 */
  maxChars?: number
}

export type TerminalOutputReadErrorCode =
  /** 请求字段不合法（游标/上限不是安全整数或越界）。 */
  | 'request-invalid'
  /** outputEpoch 与当前实例不符。 */
  | 'epoch-mismatch'
  /** 游标为负或不是安全整数。 */
  | 'cursor-invalid'
  /** 游标领先于最新写入位置。 */
  | 'cursor-ahead'

/** 历史缺口：请求游标早于实际起点，这一段**永久丢失**，与响应截断不同。 */
export interface TerminalOutputHistoryGap {
  fromCursor: number
  toCursor: number
  lostChars: number
}

export interface TerminalOutputReadFailure {
  ok: false
  code: TerminalOutputReadErrorCode
  message: string
}

export interface TerminalOutputReadResult {
  ok: true
  /** 本次文本；stripAnsi 为真时已剥离控制序列，因此长度可能小于游标推进量。 */
  text: string
  outputEpoch: number
  /** 回显请求的游标。 */
  cursor: number
  /** 当前仍可取到的最早游标。 */
  earliestCursor: number
  /** 当前最新游标（等于下次无缺口读取的 nextCursor 上界）。 */
  latestCursor: number
  /** 下次读取应传的游标。 */
  nextCursor: number
  /** 非空表示请求位置之后有一段历史已被挤掉，无法补齐。 */
  historyGap?: TerminalOutputHistoryGap
  /** 本次因 maxChars 截断，剩余内容仍可用 nextCursor 继续读。 */
  responseTruncated: boolean
  /** 本次生效的响应上限。 */
  maxChars: number
}
