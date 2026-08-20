import log from 'electron-log'
import { extractErrorMessage } from '../terminal/session-manager'

interface StringOptions {
  maxLength?: number
  allowEmpty?: boolean
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

export function failureFromError(error: unknown): { success: false, error: string } {
  return validationFailure(error) || { success: false, error: extractErrorMessage(error as Error) }
}
