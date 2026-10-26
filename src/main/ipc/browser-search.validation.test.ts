import { describe, expect, it, vi } from 'vitest'
vi.mock('electron-log', () => ({ default: { warn: vi.fn() } }))
vi.mock('../terminal/session-manager', () => ({ extractErrorMessage: (error: Error) => error.message }))
import { validateBrowserRequest } from './validation'

describe('搜索联想 IPC 校验', () => {
  it('只接受有界查询，不允许 renderer 指定任意目标地址或引擎', () => {
    expect(validateBrowserRequest({ kind: 'searchSuggestions', query: '中文', url: 'http://localhost/private', engine: 'forged' }))
      .toEqual({ kind: 'searchSuggestions', query: '中文' })
    for (const query of [null, 12, '', 'x'.repeat(201)]) expect(() => validateBrowserRequest({ kind: 'searchSuggestions', query })).toThrow()
  })
})
