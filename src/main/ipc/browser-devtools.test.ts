import { describe, expect, it, vi } from 'vitest'
vi.mock('electron-log', () => ({ default: { warn: vi.fn() } }))
vi.mock('../terminal/session-manager', () => ({ extractErrorMessage: (error: Error) => error.message }))
import { validateWebTabDevToolsRequest } from './validation'

describe('开发者工具 IPC 输入', () => {
  it('只接收明确动作、有效 guest ID 和有限尺寸', () => {
    expect(validateWebTabDevToolsRequest({ kind: 'close', pageId: 12, inspectorId: 13, extra: 'ignored' })).toEqual({ kind: 'close', pageId: 12, inspectorId: 13 })
    expect(validateWebTabDevToolsRequest({ kind: 'layout', pageId: 12, inspectorId: 13, bounds: null })).toEqual({ kind: 'layout', pageId: 12, inspectorId: 13, bounds: null })
  })
  it.each([
    null, {}, { kind: 'open', pageId: '12' }, { kind: 'close', pageId: 0 },
    { kind: 'close', pageId: 1.5 }, { kind: 'unknown', pageId: 12 },
    { kind: 'open', pageId: 12, bounds: null },
    { kind: 'open', pageId: 12, bounds: { x: 0, y: 0, width: Infinity, height: 100 } }
  ])('拒绝异常参数 %j', value => expect(() => validateWebTabDevToolsRequest(value)).toThrow())
})
