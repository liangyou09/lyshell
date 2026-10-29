import { afterEach, describe, expect, it, vi } from 'vitest'
import { BackendRecovery, harnessExitEvidence } from './backend-recovery'

afterEach(() => { vi.useRealTimers() })

describe('Harness 有限恢复', () => {
  it('连续启动失败退避且封顶，不因短暂 ready 重置预算', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000)
    const policy = new BackendRecovery({ delays: [10, 20, 30] })
    const start = vi.fn(async () => false)
    policy.schedule(start)
    await vi.runAllTimersAsync()
    expect(start).toHaveBeenCalledTimes(3)
    expect(policy.snapshot()).toEqual({ phase: 'exhausted', attempts: 3 })
    policy.ready()
    expect(policy.schedule(start)).toBe(false)
    policy.stop()
  })
  it('退出/用户停止后撤销排队重启，迟到的启动回执不能复活', async () => {
    vi.useFakeTimers()
    let finish!: (ok: boolean) => void
    const policy = new BackendRecovery({ delays: [1] })
    const start = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve }))
    policy.schedule(start)
    await vi.advanceTimersByTimeAsync(1)
    policy.stop(); finish(false)
    await vi.runAllTimersAsync()
    expect(start).toHaveBeenCalledTimes(1)
    expect(policy.snapshot().phase).toBe('stopped')
    expect(policy.schedule(start)).toBe(false)
  })
  it('同时多次故障只排一个重启，稳定运行后重置预算', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000)
    const policy = new BackendRecovery({ delays: [1], stableMs: 100 })
    const start = vi.fn(async () => true)
    expect(policy.schedule(start)).toBe(true)
    expect(policy.schedule(start)).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(policy.snapshot().phase).toBe('idle')
    await vi.advanceTimersByTimeAsync(101)
    expect(policy.schedule(start)).toBe(true)
    await vi.runAllTimersAsync()
    expect(start).toHaveBeenCalledTimes(2)
    policy.stop()
  })
  it('错误证据只含固定分类，不记录凭据、URL、provider 正文', () => {
    const evidence = harnessExitEvidence('TypeError https://localhost/?token=secret\nauthorization: bearer private\nENOMEM')
    expect(evidence.errorCodes).toEqual(['ENOMEM', 'TypeError'])
    expect(JSON.stringify(evidence)).not.toMatch(/secret|private|localhost|authorization/)
  })
})
