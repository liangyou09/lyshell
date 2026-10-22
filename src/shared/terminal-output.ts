/** 输出按 UTF-16 代码单元计量，与 xterm.write / 字符串游标一致。 */
export interface TerminalOutputReceipt {
  subscriptionId: string
  sequence: number
  error?: 'overflow'
}

export type TerminalOutputControl =
  | { kind: 'subscribe'; sessionId: string }
  | { kind: 'ack'; sessionId: string; subscriptionId: string; sequence: number }
  | { kind: 'unsubscribe'; sessionId: string; subscriptionId: string }

export const TERMINAL_OUTPUT_PACKET_SIZE = 64 * 1024
export const TERMINAL_OUTPUT_HIGH_WATER = 256 * 1024
export const TERMINAL_OUTPUT_LOW_WATER = 64 * 1024
export const TERMINAL_OUTPUT_MAX_PENDING = 1024 * 1024
