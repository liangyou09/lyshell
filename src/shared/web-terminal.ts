/**
 * 主窗口 → 网页终端（堡垒机 SSH）输入通道的共享契约。
 *
 * 渲染进程、preload 与主进程共用本文件，不能引入 Electron/Node 依赖。
 * 所有来自渲染进程的请求都视为不可信输入，主进程侧必须先用
 * `parseWebTerminalRequest` 做白名单校验再执行。
 */

/** 渲染进程 → 主进程的 IPC 通道名。 */
export const WEB_TERMINAL_CHANNEL = 'web-tab:terminal'

/** 单次 send 允许的最大文本长度（UTF-16 码元，与渲染进程逐行切分上限一致）。 */
export const WEB_TERMINAL_MAX_TEXT = 16384

/** bindingId 必须是 `crypto.randomUUID()` 生成的 v4 UUID（小写）。 */
const BINDING_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export type WebTerminalRequest =
  | { kind: 'bind'; pageId: number }
  | { kind: 'discover'; pageId: number }
  | { kind: 'send'; pageId: number; bindingId: string; text: string; enter: boolean }
  | { kind: 'release'; pageId: number; bindingId: string }

export type WebTerminalError =
  | 'unsupported'
  | 'stale'
  | 'denied'
  | 'busy'
  | 'invalid'
  | 'unavailable'
  | 'uncertain'

export interface WebTerminalResult {
  success: boolean
  bindingId?: string
  /** discover 扫描到的可见 xterm 终端数量；其他请求不返回。 */
  terminalCount?: number
  url?: string
  error?: WebTerminalError
}

const BIND_KEYS = ['kind', 'pageId'] as const
const DISCOVER_KEYS = ['kind', 'pageId'] as const
const SEND_KEYS = ['kind', 'pageId', 'bindingId', 'text', 'enter'] as const
const RELEASE_KEYS = ['kind', 'pageId', 'bindingId'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 只接受恰好这些自有可枚举键，多一个或少一个都拒绝。 */
function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(record)
  if (own.length !== keys.length) return false
  return keys.every(key => Object.prototype.hasOwnProperty.call(record, key))
}

function isPageId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isBindingId(value: unknown): value is string {
  return typeof value === 'string' && BINDING_ID_PATTERN.test(value)
}

/**
 * 终端控制字符白名单：仅允许 tab / LF / CR，其余 C0、DEL 与 C1 全部拒绝，
 * 避免渲染进程借输入通道向远端 shell 注入转义序列。
 */
export function isWebTerminalText(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue
    if (code < 0x20 || code === 0x7f) return false
    if (code >= 0x80 && code <= 0x9f) return false
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      // 未配对的代理项会在 IPC/插入时变成替换字符，直接拒绝（NaN 也走这里）
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index++
      continue
    }
    if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}

/**
 * 严格校验并归一化一次网页终端请求；任何不符合契约的输入返回 null。
 * 纯函数，无副作用，可安全用于主进程与测试。
 */
export function parseWebTerminalRequest(raw: unknown): WebTerminalRequest | null {
  if (!isRecord(raw)) return null
  switch (raw.kind) {
    case 'bind': {
      if (!hasExactKeys(raw, BIND_KEYS)) return null
      return isPageId(raw.pageId) ? { kind: 'bind', pageId: raw.pageId } : null
    }
    case 'discover': {
      if (!hasExactKeys(raw, DISCOVER_KEYS)) return null
      return isPageId(raw.pageId) ? { kind: 'discover', pageId: raw.pageId } : null
    }
    case 'send': {
      if (!hasExactKeys(raw, SEND_KEYS)) return null
      const { pageId, bindingId, text, enter } = raw
      if (!isPageId(pageId) || !isBindingId(bindingId)) return null
      if (typeof text !== 'string' || !isWebTerminalText(text)) return null
      if (text.length > WEB_TERMINAL_MAX_TEXT) return null
      if (typeof enter !== 'boolean') return null
      // 空文本只有配合回车才有意义；否则视为无操作的非法请求
      if (text.length === 0 && !enter) return null
      return { kind: 'send', pageId, bindingId, text, enter }
    }
    case 'release': {
      if (!hasExactKeys(raw, RELEASE_KEYS)) return null
      const { pageId, bindingId } = raw
      if (!isPageId(pageId) || !isBindingId(bindingId)) return null
      return { kind: 'release', pageId, bindingId }
    }
    default:
      return null
  }
}
