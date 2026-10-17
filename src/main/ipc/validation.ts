import log from 'electron-log'
import { DSH_MARKET_ACTIONS, type DshMarketAction } from '@shared/dsh-market'
import type { BrowserDevToolsRequest } from '@shared/browser-devtools'
import { extractErrorMessage } from '../terminal/session-manager'
import { type BrowserRequest } from '@shared/browser-settings'
import { validateBrowserSettings } from '../browser/validation'

export function validateBrowserRequest(raw: unknown): BrowserRequest {
  const value = assertObject(raw, 'browserRequest')
  switch (value.kind) {
    case 'get': case 'passwords': return { kind: value.kind }
    case 'save': return { kind: 'save', settings: validateBrowserSettings(value.settings) }
    case 'clear': return { kind: 'clear', target: assertEnum(value.target, 'target', ['cache', 'siteData'] as const) }
    case 'deletePassword': return { kind: 'deletePassword', id: assertString(value.id, 'id', { maxLength: 128 }) }
    case 'certificateInfo': case 'trustCertificate': {
      const url = assertString(value.url, 'url', { maxLength: 16384 })
      let parsed: URL
      try { parsed = new URL(url) } catch { throw new ValidationError('Invalid certificate URL') }
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new ValidationError('Invalid certificate URL')
      const guestId = assertNumber(value.guestId, 'guestId', { min: 1, integer: true })
      return value.kind === 'certificateInfo' ? { kind: 'certificateInfo', guestId, url: parsed.href }
        : { kind: 'trustCertificate', guestId, url: parsed.href, certificateId: assertString(value.certificateId, 'certificateId', { maxLength: 128 }) }
    }
    case 'savePassword': return {
      kind: 'savePassword', origin: assertString(value.origin, 'origin', { maxLength: 4096 }),
      username: assertString(value.username, 'username', { maxLength: 1024, allowEmpty: true }),
      password: assertString(value.password, 'password', { maxLength: 4096 })
    }
    default: throw new ValidationError('Unknown browser request')
  }
}

interface StringOptions {
  maxLength?: number
  allowEmpty?: boolean
}

/** 插件动作回执只接收有界请求标识、布尔结果及可选错误，身份另由 sender 核对。 */
export function validatePluginActionReceipt(raw: unknown): { requestId: string; ok: boolean; error?: string } | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const data = raw as Record<string, unknown>
  if (typeof data.requestId !== 'string' || !/^act-[a-z0-9-]{1,100}$/.test(data.requestId) || typeof data.ok !== 'boolean') return undefined
  if (data.error !== undefined && (typeof data.error !== 'string' || data.error.length > 4096)) return undefined
  return { requestId: data.requestId, ok: data.ok, ...(typeof data.error === 'string' ? { error: data.error } : {}) }
}

/** 只有主窗口 renderer 可认领资源管理器启动请求，webview/浮窗不能消费队列。 */
export function assertExplorerLaunchConsumer(senderId: number, consumerId: number | null): void {
  if (senderId !== consumerId) throw new ValidationError('Explorer launch requires the main window')
}

/** 插件连接只传动作请求 ID，不接受 renderer 自报 pluginId。 */
export function assertPluginActionRequestId(value: unknown): string | undefined {
  return value === undefined ? undefined : assertString(value, 'pluginActionRequestId', { maxLength: 128 })
}

/** 普通克隆仅传源运行时 ID，归属由 main 从该会话推导。 */
export function assertConnectionCloneSourceId(value: unknown): string | undefined {
  return value === undefined ? undefined : assertString(value, 'sourceSessionId', { maxLength: 128 })
}

interface NumberOptions {
  min?: number
  max?: number
  integer?: boolean
}

interface ArrayOptions {
  maxItems?: number
  maxItemLength?: number
}

interface RecordOptions {
  maxItems?: number
  maxKeyLength?: number
  maxValueLength?: number
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

export function validateWebTabDevToolsRequest(raw: unknown): BrowserDevToolsRequest {
  const value = assertObject(raw, 'devtoolsRequest')
  const pageId = assertNumber(value.pageId, 'pageId', { min: 1, max: Number.MAX_SAFE_INTEGER, integer: true })
  const kind = assertEnum(value.kind, 'kind', ['open', 'layout', 'close'] as const)
  const inspectorId = kind !== 'open' ? assertNumber(value.inspectorId, 'inspectorId', { min: 1, max: Number.MAX_SAFE_INTEGER, integer: true }) : undefined
  if (kind === 'close') return { kind, pageId, inspectorId: inspectorId! }
  if (kind === 'layout' && value.bounds === null) return { kind, pageId, inspectorId: inspectorId!, bounds: null }
  const bounds = assertObject(value.bounds, 'bounds')
  const parsed = {
    x: assertNumber(bounds.x, 'x', { min: -100000, max: 100000 }),
    y: assertNumber(bounds.y, 'y', { min: -100000, max: 100000 }),
    width: assertNumber(bounds.width, 'width', { min: 0, max: 100000 }),
    height: assertNumber(bounds.height, 'height', { min: 0, max: 100000 })
  }
  return kind === 'open' ? { kind, pageId, bounds: parsed } : { kind, pageId, inspectorId: inspectorId!, bounds: parsed }
}

/** POST 页签认领只收主进程发放的 UUID token 和有效 guest id。 */
export function validateWebTabPostLoadRequest(token: unknown, webContentsId: unknown):
  { token: string; webContentsId: number } | null {
  if (typeof token !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(token)) return null
  if (typeof webContentsId !== 'number' || !Number.isSafeInteger(webContentsId) || webContentsId < 1) return null
  return { token, webContentsId }
}

/**
 * sanitizeSessionEncoding 已上移 @shared/encoding —— 收口消费者是 repository
 * （load/saveSession），IPC 入口与它共用同一实现，此处不再自带真相源。
 */

export function assertString(value: unknown, name: string, options: StringOptions = {}): string {
  if (typeof value !== 'string') {
    throw new ValidationError(`${name} must be a string`)
  }

  if (!options.allowEmpty && value.length === 0) {
    throw new ValidationError(`${name} is required`)
  }

  if (options.maxLength && value.length > options.maxLength) {
    throw new ValidationError(`${name} is too long`)
  }

  return value
}

/** dsh 工作区 ID 校验：非空字符串，≤128。dsh:workspace:* / dsh:web:* 各处理器共用。 */
export function assertWorkspaceId(value: unknown): string {
  return assertString(value, 'workspaceId', { maxLength: 128 })
}

export function assertNumber(value: unknown, name: string, options: NumberOptions = {}): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`${name} must be a finite number`)
  }

  if (options.integer && !Number.isInteger(value)) {
    throw new ValidationError(`${name} must be an integer`)
  }

  if (options.min !== undefined && value < options.min) {
    throw new ValidationError(`${name} is too small`)
  }

  if (options.max !== undefined && value > options.max) {
    throw new ValidationError(`${name} is too large`)
  }

  return value
}

export function assertStringArray(value: unknown, name: string, options: ArrayOptions = {}): string[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(`${name} must be an array`)
  }

  if (options.maxItems !== undefined && value.length > options.maxItems) {
    throw new ValidationError(`${name} has too many items`)
  }

  return value.map((item, index) => assertString(item, `${name}[${index}]`, {
    maxLength: options.maxItemLength
  }))
}

export function assertStringRecord(
  value: unknown,
  name: string,
  options: RecordOptions = {}
): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${name} must be an object`)
  }

  const source = value as Record<string, unknown>
  const entries = Object.entries(source)
  if (options.maxItems !== undefined && entries.length > options.maxItems) {
    throw new ValidationError(`${name} has too many items`)
  }

  const result: Record<string, string> = {}
  for (const [key, val] of entries) {
    // 空 key 会让 node-pty spawn 返回 EINVAL；NUL 会截断环境变量（C 字符串以 \0 结尾），
    // 二者在服务端直接拒绝，而非等启动时才报错。
    if (key.length === 0) {
      throw new ValidationError(`${name} key must not be empty`)
    }
    if (key.includes('\0')) {
      throw new ValidationError(`${name} key must not contain NUL`)
    }
    if (options.maxKeyLength !== undefined && key.length > options.maxKeyLength) {
      throw new ValidationError(`${name} key is too long`)
    }
    if (typeof val !== 'string') {
      throw new ValidationError(`${name}[${key}] must be a string`)
    }
    if (val.includes('\0')) {
      throw new ValidationError(`${name}[${key}] must not contain NUL`)
    }
    if (options.maxValueLength !== undefined && val.length > options.maxValueLength) {
      throw new ValidationError(`${name}[${key}] is too long`)
    }
    result[key] = val
  }
  return result
}

export function assertObject<T extends Record<string, unknown> = Record<string, unknown>>(value: unknown, name: string): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${name} must be an object`)
  }
  return value as T
}

export function assertBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ValidationError(`${name} must be a boolean`)
  }
  return value
}

/** 枚举字符串校验：值必须是 allowed 之一（workspace.isolation 等小枚举字段用）。 */
export function assertEnum<T extends string>(value: unknown, name: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ValidationError(`${name} must be one of: ${allowed.join(', ')}`)
  }
  return value as T
}

export function normalizeTimeout(value: unknown, defaultMs: number, maxMs: number): number {
  if (value === undefined || value === null) {
    return defaultMs
  }
  return assertNumber(value, 'timeout', { min: 1, max: maxMs, integer: true })
}

export function validationFailure(error: unknown): { success: false, error: string } | null {
  if (error instanceof ValidationError) {
    log.warn('Rejected invalid IPC request:', error.message)
    return { success: false, error: error.message }
  }
  return null
}

export function invalidRequest(message: string): never {
  throw new ValidationError(message)
}

export function validateDshMarketAction(value: unknown): DshMarketAction {
  return assertEnum(value, 'market action', DSH_MARKET_ACTIONS)
}

export function failureFromError(error: unknown): { success: false, error: string } {
  return validationFailure(error) || { success: false, error: extractErrorMessage(error as Error) }
}
