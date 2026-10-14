// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkbenchSnapshot } from './useWorkbenchSnapshot'

const { getSnapshot, patch, noteKey, notePhase, getPayload } = vi.hoisted(() => ({
  getSnapshot: vi.fn(), patch: vi.fn(), noteKey: vi.fn(), notePhase: vi.fn(), getPayload: vi.fn()
}))
vi.mock('../../stores/pane-store', () => ({
  usePaneStore: { getState: () => ({ updateDshWebInPane: patch, getOverlayPayload: getPayload }) }
}))
vi.mock('../../stores/workbench-detail', () => ({
  workbenchDetailLane: () => ({ noteKey, notePhase })
}))

const response = (phase: string, petSessionId: string | null = 'pet-1') => ({
  success: true, snapshot: { phase, viewer: { petSessionId } }
})
const tick = async (ms = 1500) => {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  getPayload.mockReturnValue({ kind: 'dshWeb', workbenchKey: 'held:1:-:pet-1' })
  getSnapshot.mockResolvedValue(response('held'))
  vi.stubGlobal('electronAPI', { getExclusiveSnapshot: getSnapshot })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('共享工作台无界面轮询', () => {
  it('held/releasing 显示共享信号，free 清除信号和 Pet 目标，并回报详情身份', async () => {
    renderHook(() => useWorkbenchSnapshot('__dsh_web__'))
    await tick(0)
    expect(patch).toHaveBeenLastCalledWith('__dsh_web__', { readOnly: false, held: true, petSessionId: 'pet-1' })
    expect(noteKey).toHaveBeenLastCalledWith('held:1:-:pet-1')
    expect(notePhase).toHaveBeenLastCalledWith('held')
    getSnapshot.mockResolvedValue(response('releasing', 'pet-2'))
    await tick()
    expect(patch).toHaveBeenLastCalledWith('__dsh_web__', { readOnly: false, held: true, petSessionId: 'pet-2' })
    getSnapshot.mockResolvedValue(response('free', null))
    await tick()
    expect(patch).toHaveBeenLastCalledWith('__dsh_web__', { readOnly: false, held: false, petSessionId: null })
    expect(notePhase).toHaveBeenLastCalledWith('free')
  })

  it('拒绝携带缓存快照的失败响应、缺失相位和 IPC 异常，下一次成功仍可恢复', async () => {
    renderHook(() => useWorkbenchSnapshot('__dsh_web__'))
    await tick(0)
    getSnapshot.mockResolvedValue({ ...response('free', null), success: false, error: 'bridge unavailable' })
    await tick()
    getSnapshot.mockResolvedValue({ success: true, snapshot: { viewer: null } })
    await tick()
    getSnapshot.mockRejectedValue(new Error('offline'))
    await tick()
    expect(patch).toHaveBeenCalledTimes(1)
    expect(notePhase).toHaveBeenCalledTimes(1)
    getSnapshot.mockResolvedValue(response('free', null))
    await tick()
    expect(notePhase).toHaveBeenLastCalledWith('free')
  })

  it('慢响应不会并发堆积或被每次定时器作废', async () => {
    let resolve!: (value: ReturnType<typeof response>) => void
    getSnapshot.mockReturnValue(new Promise(r => { resolve = r }))
    renderHook(() => useWorkbenchSnapshot('__dsh_web__'))
    await tick(4500)
    expect(getSnapshot).toHaveBeenCalledTimes(1)
    await act(async () => { resolve(response('held')) })
    expect(notePhase).toHaveBeenLastCalledWith('held')
    getSnapshot.mockResolvedValue(response('free', null))
    await tick()
    expect(getSnapshot).toHaveBeenCalledTimes(2)
    expect(notePhase).toHaveBeenLastCalledWith('free')
  })

  it('卸载后迟到响应不写回，也不再轮询', async () => {
    let resolve!: (value: ReturnType<typeof response>) => void
    getSnapshot.mockReturnValue(new Promise(r => { resolve = r }))
    const { unmount } = renderHook(() => useWorkbenchSnapshot('__dsh_web__'))
    unmount()
    await act(async () => { resolve(response('free', null)) })
    await tick(3000)
    expect(patch).not.toHaveBeenCalled()
    expect(notePhase).not.toHaveBeenCalled()
    expect(getSnapshot).toHaveBeenCalledTimes(1)
  })

  it('overlay 身份变化后旧请求不写入新页签', async () => {
    let resolve!: (value: ReturnType<typeof response>) => void
    getSnapshot.mockReturnValueOnce(new Promise(r => { resolve = r }))
    const { rerender } = renderHook(({ id }) => useWorkbenchSnapshot(id), { initialProps: { id: 'old' } })
    rerender({ id: 'new' })
    await tick(0)
    expect(patch).toHaveBeenCalledTimes(1)
    expect(patch).toHaveBeenLastCalledWith('new', expect.objectContaining({ held: true }))
    await act(async () => { resolve(response('free', null)) })
    expect(patch).toHaveBeenCalledTimes(1)
  })

  it('页签已移除时不推进详情状态机', async () => {
    getPayload.mockReturnValue(undefined)
    renderHook(() => useWorkbenchSnapshot('__dsh_web__'))
    await tick(0)
    expect(patch).not.toHaveBeenCalled()
    expect(notePhase).not.toHaveBeenCalled()
  })
})
