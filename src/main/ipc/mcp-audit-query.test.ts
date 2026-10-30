import { describe, expect, it, vi } from 'vitest'
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
import { validateMcpAuditQuery } from './validation'

describe('审计查询边界', () => {
  it('保留合法分页与过滤，只暴露明确字段', () => {
    expect(validateMcpAuditQuery(undefined)).toEqual({})
    expect(validateMcpAuditQuery({ operation: 'execute', allowed: false, limit: 20000, offset: 0 }))
      .toEqual({ operation: 'execute', allowed: false, limit: 20000, offset: 0 })
  })
  it.each([null, [], { unknown: true }, { limit: 0 }, { limit: 20001 }, { offset: -1 }, { offset: 1.5 }, { allowed: 'yes' }, { operation: 'a'.repeat(513) }])('拒绝非法查询 %j', raw => {
    expect(() => validateMcpAuditQuery(raw)).toThrow()
  })
})
