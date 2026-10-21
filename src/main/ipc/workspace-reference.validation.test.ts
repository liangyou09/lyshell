import { describe, expect, it, vi } from 'vitest'
vi.mock('../terminal/session-manager', () => ({ extractErrorMessage: (error: Error) => error.message }))
vi.mock('electron-log', () => ({ default: { warn: vi.fn() } }))
import { validateOptionalWorkspacePresetId } from './validation'

describe('启动器可选目录引用', () => {
  it.each([undefined, null, '', '  '])('清空值 %s 表示未引用目录', value => {
    expect(validateOptionalWorkspacePresetId(value)).toBeUndefined()
  })
  it('接受有界 ID，拒绝非法类型与超长 ID', () => {
    expect(validateOptionalWorkspacePresetId('preset-id')).toBe('preset-id')
    for (const value of [true, 1, {}, [], 'x'.repeat(129)]) {
      expect(() => validateOptionalWorkspacePresetId(value)).toThrow()
    }
  })
})
