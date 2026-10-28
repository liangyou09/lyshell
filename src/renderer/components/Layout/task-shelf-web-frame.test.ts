import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebviewTag } from 'electron'
import { captureShelfWebFrame } from './task-shelf-web-frame'

const frame = { getSize: () => ({ width: 1800, height: 1200 }), isEmpty: () => false, resize: vi.fn(() => ({ toDataURL: () => 'data:image/png;base64,frame' })) }
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })
describe('任务缩影共享网页帧', () => {
  it('同一时段的方格与内容区只截一帧，下一周期更新', async () => {
    vi.useFakeTimers()
    const page = { capturePage: vi.fn(async () => frame) }
    const first = captureShelfWebFrame(page as unknown as WebviewTag)
    const second = captureShelfWebFrame(page as unknown as WebviewTag)
    expect(second).toBe(first)
    expect(await first).toEqual({ width: 1800, height: 1200, image: 'data:image/png;base64,frame' })
    expect(frame.resize).toHaveBeenCalledWith({ width: 900, height: 600 })
    await vi.advanceTimersByTimeAsync(500)
    await captureShelfWebFrame(page as unknown as WebviewTag)
    expect(page.capturePage).toHaveBeenCalledTimes(2)
  })
  it('慢截图即使超过缓存周期也不会叠加新请求，失败后允许恢复', async () => {
    vi.useFakeTimers()
    let fail!: (error: Error) => void
    const page = { capturePage: vi.fn(() => new Promise<typeof frame>((_resolve, reject) => { fail = reject })) }
    const first = captureShelfWebFrame(page as unknown as WebviewTag)
    await vi.advanceTimersByTimeAsync(1000)
    expect(captureShelfWebFrame(page as unknown as WebviewTag)).toBe(first)
    expect(page.capturePage).toHaveBeenCalledTimes(1)
    fail(new Error('no frame'))
    await expect(first).rejects.toThrow('no frame')
    page.capturePage.mockResolvedValue(frame)
    expect((await captureShelfWebFrame(page as unknown as WebviewTag)).image).toBeTruthy()
  })
})
