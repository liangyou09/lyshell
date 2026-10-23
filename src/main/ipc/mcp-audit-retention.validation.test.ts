import { describe, expect, it, vi } from 'vitest'
vi.mock('electron-log', () => ({ default: { warn: vi.fn() } }))
vi.mock('../terminal/session-manager', () => ({ extractErrorMessage: (error: Error) => error.message }))
import { validateMcpAuditRetentionLimit, ValidationError } from './validation'

describe('MCP 活动保留条数 IPC 校验', () => {
  it.each([1000, 5000, 10000, 20000])('接受支持的档位 %i', value => {
    expect(validateMcpAuditRetentionLimit(value)).toBe(value)
  })
  it.each([undefined, null, '', '1000', true, {}, [], 0, -1, 1500, 1000.5, Infinity, NaN, 1000000])('拒绝非法或无限制的输入 %j', value => {
    expect(() => validateMcpAuditRetentionLimit(value)).toThrow(ValidationError)
  })
})
