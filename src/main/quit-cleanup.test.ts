import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clampDeadline,
  createShutdownDeadline,
  runBoundedStep,
  runBoundedSteps,
  shutdownRemainingMs,
  waitForQuitCleanup
} from './quit-cleanup'

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

describe('退出期限与有界步骤', () => {
  it('期限从流程开始时刻一次性计算，剩余量随后续时间递减到 0', () => {
    const deadline = createShutdownDeadline(5000, 1000)
    expect(deadline).toEqual({ startedAt: 1000, deadlineAt: 6000 })
    expect(shutdownRemainingMs(deadline, 1000)).toBe(5000)
    expect(shutdownRemainingMs(deadline, 4500)).toBe(1500)
    expect(shutdownRemainingMs(deadline, 6000)).toBe(0)
    expect(shutdownRemainingMs(deadline, 9000)).toBe(0)
  })

  it('子阶段预算被裁到总期限之内，不突破总退出期限', () => {
    const total = createShutdownDeadline(18_000, 0)
    const prepare = createShutdownDeadline(7_500, 1000)
    expect(clampDeadline(prepare, total.deadlineAt)).toEqual({ startedAt: 1000, deadlineAt: 8500 })

    const overflow = createShutdownDeadline(20_000, 0)
    const clamped = clampDeadline(overflow, total.deadlineAt)
    expect(clamped.deadlineAt).toBe(18_000)
    expect(clamped.startedAt).toBe(0)
  })

  it('步骤完成返回 completed，不调用错误回调', async () => {
    const onError = vi.fn()
    const outcome = await runBoundedStep(() => Promise.resolve('ok'), createShutdownDeadline(200), onError)
    expect(outcome.status).toBe('completed')
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0)
    expect(onError).not.toHaveBeenCalled()
  })

  it('同步抛错与异步拒绝都记为 failed，并继续返回结果', async () => {
    const onError = vi.fn()
    const syncFailure = await runBoundedStep(() => { throw new Error('boom') }, createShutdownDeadline(200), onError)
    expect(syncFailure.status).toBe('failed')
    expect(syncFailure.error).toContain('Error: boom')

    const asyncFailure = await runBoundedStep(() => Promise.reject(new Error('late boom')), createShutdownDeadline(200), onError)
    expect(asyncFailure.status).toBe('failed')
    expect(asyncFailure.error).toContain('Error: late boom')
    expect(onError).toHaveBeenCalledTimes(2)
  })

  it('超过预算记为 pending，迟到拒绝仍被接管且不产生未处理 rejection', async () => {
    const onError = vi.fn()
    let rejectLate!: (error: Error) => void
    const stuck = new Promise<void>((_resolve, reject) => { rejectLate = reject })
    const outcome = await runBoundedStep(() => stuck, createShutdownDeadline(30), onError)
    expect(outcome.status).toBe('pending')
    expect(outcome.error).toContain('exceeded its')

    rejectLate(new Error('after timeout'))
    await Promise.resolve()
    await Promise.resolve()
    expect(onError).toHaveBeenCalledTimes(2)
  })

  it('预算已耗尽时不再启动步骤，直接记为 pending', async () => {
    const onError = vi.fn()
    const run = vi.fn()
    const outcome = await runBoundedStep(run, createShutdownDeadline(0), onError)
    expect(outcome.status).toBe('pending')
    expect(outcome.error).toContain('budget exhausted')
    expect(run).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('budget exhausted') }))
  })

  it('错误回调自身抛错不阻断退出流程', async () => {
    const onError = vi.fn(() => { throw new Error('logger failed') })
    const outcome = await runBoundedStep(() => Promise.reject(new Error('cleanup failed')), createShutdownDeadline(200), onError)
    expect(outcome.status).toBe('failed')
    expect(onError).toHaveBeenCalledOnce()
  })

  it('并行步骤彼此隔离：完成/失败/超时互不阻断', async () => {
    const onError = vi.fn()
    const outcomes = await runBoundedSteps([
      () => Promise.resolve(),
      () => Promise.reject(new Error('transfer failed')),
      () => new Promise<void>(() => { /* never settles */ })
    ], createShutdownDeadline(40), onError)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['completed', 'failed', 'pending'])
    expect(onError).toHaveBeenCalledTimes(2)
  })

  it('错误描述定长，避免把整段响应体写进退出报告', () => {
    const outcome = runBoundedStep(
      () => { throw new Error('x'.repeat(2000)) },
      createShutdownDeadline(100),
      () => { /* noop */ }
    )
    return outcome.then(result => {
      expect(result.error?.length).toBeLessThanOrEqual(300)
      expect(result.error).toContain('Error: xxx')
    })
  })
})
