import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitForQuitCleanup } from './quit-cleanup'

afterEach(() => { vi.useRealTimers() })

describe('应用退出清理等待', () => {
  it('DSH 立即完成时仍等待插件清理，完成后清除兜底计时器', async () => {
    vi.useFakeTimers()
    let finish!: () => void
    const pluginCleanup = new Promise<void>(resolve => { finish = resolve })
    const exit = vi.fn()
    const error = vi.fn()
    const cleanup = waitForQuitCleanup([Promise.resolve(), pluginCleanup], 6000, error).then(exit)
    await vi.advanceTimersByTimeAsync(2500)
    expect(exit).not.toHaveBeenCalled()
    finish()
    await cleanup
    expect(exit).toHaveBeenCalledOnce()
    expect(error).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('单项失败记录错误，仍等另一项清理完成', async () => {
    let finish!: () => void
    const error = vi.fn()
    const exit = vi.fn()
    const failure = new Error('plugin cleanup failed')
    const cleanup = waitForQuitCleanup([Promise.reject(failure), new Promise<void>(resolve => { finish = resolve })], 6000, error).then(exit)
    await Promise.resolve()
    expect(error).toHaveBeenCalledWith(failure)
    expect(exit).not.toHaveBeenCalled()
    finish()
    await cleanup
    expect(exit).toHaveBeenCalledOnce()
  })

  it('清理卡住时达到预算后退出，迟到拒绝仍被处理', async () => {
    vi.useFakeTimers()
    let fail!: (error: Error) => void
    const error = vi.fn()
    const cleanup = waitForQuitCleanup([new Promise<void>((_resolve, reject) => { fail = reject })], 6000, error)
    await vi.advanceTimersByTimeAsync(6000)
    await cleanup
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: 'Application cleanup timed out' }))
    fail(new Error('late failure'))
    await Promise.resolve()
    expect(error).toHaveBeenCalledTimes(2)
  })
})
