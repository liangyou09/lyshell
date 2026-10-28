// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shelfPreviewClockState, subscribeShelfPreviewClock } from './task-shelf-preview-clock'

/** `hidden` 在 jsdom 中只读，用 getter 覆盖模拟窗口可见性变化。 */
const setHidden = (value: boolean) => vi.spyOn(document, 'hidden', 'get').mockReturnValue(value)

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  vi.restoreAllMocks(); vi.clearAllTimers(); vi.useRealTimers()
  expect(shelfPreviewClockState().listeners).toBe(0)
})

describe('任务架预览时钟', () => {
  it('多个缩略图共用一个 500ms 节拍，全部退订后停表并解绑 visibilitychange', async () => {
    const add = vi.spyOn(document, 'addEventListener')
    const remove = vi.spyOn(document, 'removeEventListener')
    const first = vi.fn(), second = vi.fn()
    const releaseFirst = subscribeShelfPreviewClock(first)
    const releaseSecond = subscribeShelfPreviewClock(second)
    expect(shelfPreviewClockState()).toEqual({ listeners: 2, running: true })
    expect(add.mock.calls.filter(call => call[0] === 'visibilitychange')).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(499)
    expect(first).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)

    releaseFirst(); releaseFirst()
    expect(shelfPreviewClockState()).toEqual({ listeners: 1, running: true })
    releaseSecond()
    expect(shelfPreviewClockState()).toEqual({ listeners: 0, running: false })
    expect(remove.mock.calls.filter(call => call[0] === 'visibilitychange')).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(2000)
    expect(first).toHaveBeenCalledTimes(1)
  })

  it('窗口隐藏时不启动、停表，恢复可见立即补一次再继续', async () => {
    const hidden = setHidden(true)
    const listener = vi.fn()
    const release = subscribeShelfPreviewClock(listener)
    expect(shelfPreviewClockState()).toEqual({ listeners: 1, running: false })
    await vi.advanceTimersByTimeAsync(2000)
    expect(listener).not.toHaveBeenCalled()

    hidden.mockReturnValue(false)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(listener).toHaveBeenCalledTimes(1)
    expect(shelfPreviewClockState()).toMatchObject({ listeners: 1, running: true })
    await vi.advanceTimersByTimeAsync(500)
    expect(listener).toHaveBeenCalledTimes(2)

    hidden.mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(shelfPreviewClockState().running).toBe(false)
    await vi.advanceTimersByTimeAsync(2000)
    expect(listener).toHaveBeenCalledTimes(2)
    release()
  })

  it('单个订阅抛错不影响其它订阅与节拍', async () => {
    const broken = vi.fn(() => { throw new Error('缩略图绘制失败') })
    const healthy = vi.fn()
    const releaseBroken = subscribeShelfPreviewClock(broken)
    const releaseHealthy = subscribeShelfPreviewClock(healthy)
    await vi.advanceTimersByTimeAsync(500)
    expect(broken).toHaveBeenCalledTimes(1)
    expect(healthy).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(healthy).toHaveBeenCalledTimes(2)
    releaseBroken(); releaseHealthy()
  })
})
