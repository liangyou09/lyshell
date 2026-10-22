import { describe, expect, it, vi } from 'vitest'
import {
  createTransferScheduler,
  DEFAULT_MAX_CONCURRENT_TRANSFERS,
  DEFAULT_MAX_PER_ENDPOINT,
  DEFAULT_MAX_PENDING_TRANSFERS,
  TransferCancelledError,
  TransferQueueFullError,
  transferEndpointKey,
  type TransferLease,
  type TransferScheduler,
} from './transfer-scheduler'

/**
 * R03 调度器单元测试：全局 4 / 每 endpoint 2 / 排队容量 / 取消 / 额度释放。
 * 只测纯调度逻辑，不创建 Worker。
 */

const flush = async (times = 4): Promise<void> => {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

interface Settlement {
  taskId: string
  lease?: TransferLease
  error?: Error
}

function observe(scheduler: TransferScheduler, taskId: string, sessionId: string, endpoint: string, onCancel?: () => void): Promise<Settlement> {
  return scheduler.acquire({ taskId, sessionId, endpoint, onCancel }).then(
    lease => ({ taskId, lease }),
    error => ({ taskId, error: error as Error }),
  )
}

describe('transfer-scheduler', () => {
  it('默认上限是全局 4 / 每 endpoint 2 / 排队容量 64', () => {
    expect(DEFAULT_MAX_CONCURRENT_TRANSFERS).toBe(4)
    expect(DEFAULT_MAX_PER_ENDPOINT).toBe(2)
    expect(DEFAULT_MAX_PENDING_TRANSFERS).toBe(64)
  })

  it('不同 endpoint 也受全局 4 限制', async () => {
    const scheduler = createTransferScheduler()
    const settlements: Promise<Settlement>[] = []
    for (let i = 0; i < 10; i++) {
      settlements.push(observe(scheduler, `t${i}`, 's1', transferEndpointKey(`host-${i}`, 22)))
    }
    await flush()

    expect(scheduler.stats().active).toBe(4)
    expect(scheduler.stats().queued).toBe(6)

    // 释放四个额度，队列按提交顺序补位
    const firstWave = await Promise.all(settlements.slice(0, 4))
    for (const item of firstWave) item.lease!.release()
    await flush()

    expect(scheduler.stats().active).toBe(4)
    expect(scheduler.stats().queued).toBe(2)
    const secondWave = await Promise.all(settlements.slice(4, 8))
    expect(secondWave.map(item => item.taskId)).toEqual(['t4', 't5', 't6', 't7'])

    for (const item of secondWave) item.lease!.release()
    await flush()
    expect(scheduler.stats().active).toBe(2)
    expect(scheduler.stats().queued).toBe(0)

    const lastWave = await Promise.all(settlements.slice(8, 10))
    for (const item of lastWave) item.lease!.release()
    await flush()
    expect(scheduler.stats().active).toBe(0)
    expect(scheduler.stats().queued).toBe(0)
  })

  it('同一 endpoint 最多 2 个，释放后按队列顺序补位', async () => {
    const scheduler = createTransferScheduler()
    const endpoint = transferEndpointKey('same-host', 22)
    const settlements: Promise<Settlement>[] = []
    for (let i = 0; i < 5; i++) {
      settlements.push(observe(scheduler, `e${i}`, 's1', endpoint))
    }
    await flush()

    const stats = scheduler.stats()
    expect(stats.active).toBe(2)
    expect(stats.queued).toBe(3)
    expect(stats.activeByEndpoint[endpoint]).toBe(2)

    const results = await Promise.all(settlements.slice(0, 2))
    results[0].lease!.release()
    await flush()

    expect(scheduler.stats().active).toBe(2)
    expect(scheduler.stats().queued).toBe(2)
    const third = await settlements[2]
    expect(third.lease).toBeTruthy()

    // 收尾：释放剩余额度后 e3/e4 补位
    results[1].lease!.release()
    third.lease!.release()
    await flush()
    const rest = await Promise.all(settlements.slice(3, 5))
    for (const item of rest) item.lease!.release()
    await flush()
    expect(scheduler.stats().active).toBe(0)
    expect(scheduler.stats().queued).toBe(0)
  })

  it('排队容量满时明确拒绝，不会无限排队', async () => {
    const scheduler = createTransferScheduler({ maxConcurrent: 2, maxPerEndpoint: 2, maxPending: 6 })
    const accepted: Promise<Settlement>[] = []
    for (let i = 0; i < 6; i++) {
      accepted.push(observe(scheduler, `cap${i}`, 's1', transferEndpointKey(`h${i}`, 22)))
    }
    await flush()
    expect(scheduler.stats().active).toBe(2)
    expect(scheduler.stats().queued).toBe(4)

    const overflow = await observe(scheduler, 'cap-overflow', 's1', transferEndpointKey('hx', 22))
    expect(overflow.error).toBeInstanceOf(TransferQueueFullError)
    expect((overflow.error as TransferQueueFullError).limit).toBe(6)
    expect(scheduler.stats().active).toBe(2)
    expect(scheduler.stats().queued).toBe(4)

    // 已接受的任务不受影响；全部释放后额度归零
    const settled = await Promise.all(accepted.slice(0, 2))
    for (const item of settled) item.lease?.release()
    await flush()
    const next = await Promise.all(accepted.slice(2, 4))
    for (const item of next) item.lease?.release()
    await flush()
    expect(scheduler.stats().active).toBe(2)
    expect(scheduler.stats().queued).toBe(0)

    const tail = await Promise.all(accepted.slice(4, 6))
    for (const item of tail) item.lease?.release()
    await flush()
    expect(scheduler.stats().active).toBe(0)
    expect(scheduler.stats().queued).toBe(0)
  })

  it('cancelId 取消排队任务：onCancel 执行、Promise 以 TransferCancelledError 结束', async () => {
    const scheduler = createTransferScheduler({ maxConcurrent: 1, maxPerEndpoint: 1 })
    const active = await scheduler.acquire({ taskId: 'active', sessionId: 's1', endpoint: 'ep' })
    const onCancel = vi.fn()
    const queued = observe(scheduler, 'queued', 's1', 'ep', onCancel)
    await flush()
    expect(scheduler.stats().queued).toBe(1)

    expect(scheduler.cancelId('queued')).toBe(true)
    expect(scheduler.cancelId('missing')).toBe(false)
    expect(onCancel).toHaveBeenCalledTimes(1)

    const settlement = await queued
    expect(settlement.error).toBeInstanceOf(TransferCancelledError)
    expect(scheduler.stats().queued).toBe(0)
    expect(scheduler.stats().active).toBe(1)

    active.release()
    await flush()
    expect(scheduler.stats().active).toBe(0)
  })

  it('cancelSession 只取消该会话的排队任务，并按提交顺序返回 id', async () => {
    const scheduler = createTransferScheduler({ maxConcurrent: 1, maxPerEndpoint: 1 })
    const active = await scheduler.acquire({ taskId: 'a', sessionId: 's-keep', endpoint: 'ep' })

    const cancelledCleanup = vi.fn()
    const queuedOne = observe(scheduler, 'q1', 's-drop', 'ep', cancelledCleanup)
    const queuedTwo = observe(scheduler, 'q2', 's-keep', 'ep')
    const queuedThree = observe(scheduler, 'q3', 's-drop', 'ep', cancelledCleanup)
    await flush()

    expect(scheduler.cancelSession('s-drop')).toEqual(['q1', 'q3'])
    expect(cancelledCleanup).toHaveBeenCalledTimes(2)
    expect((await queuedOne).error).toBeInstanceOf(TransferCancelledError)
    expect((await queuedThree).error).toBeInstanceOf(TransferCancelledError)
    expect(scheduler.cancelSession('nobody')).toEqual([])

    active.release()
    await flush()
    // 保留的会话任务正常补位
    const kept = await queuedTwo
    expect(kept.lease).toBeTruthy()
    kept.lease!.release()
    expect(scheduler.stats().active).toBe(0)
    expect(scheduler.stats().queued).toBe(0)
  })

  it('cancelAll 清空队列但不影响已启动额度，release 幂等', async () => {
    const scheduler = createTransferScheduler({ maxConcurrent: 2, maxPerEndpoint: 1 })
    const first = await scheduler.acquire({ taskId: 'a1', sessionId: 's1', endpoint: 'a' })
    const second = await scheduler.acquire({ taskId: 'b1', sessionId: 's2', endpoint: 'b' })
    const queuedA = observe(scheduler, 'a2', 's1', 'a')
    const queuedB = observe(scheduler, 'b2', 's2', 'b')
    await flush()

    expect(scheduler.cancelAll()).toEqual(['a2', 'b2'])
    expect((await queuedA).error).toBeInstanceOf(TransferCancelledError)
    expect((await queuedB).error).toBeInstanceOf(TransferCancelledError)
    expect(scheduler.stats().active).toBe(2)
    expect(scheduler.stats().queued).toBe(0)

    first.release()
    first.release()
    second.release()
    await flush()
    expect(scheduler.stats().active).toBe(0)
    expect(scheduler.stats().activeByEndpoint).toEqual({})
  })

  it('队首被 endpoint 限制时不会阻塞其他 endpoint 的排队任务', async () => {
    const scheduler = createTransferScheduler({ maxConcurrent: 2, maxPerEndpoint: 1 })
    const a1 = await scheduler.acquire({ taskId: 'a1', sessionId: 's1', endpoint: 'a' })
    const b1 = await scheduler.acquire({ taskId: 'b1', sessionId: 's1', endpoint: 'b' })

    const queuedA2 = observe(scheduler, 'a2', 's1', 'a')
    const queuedC1 = observe(scheduler, 'c1', 's1', 'c')
    await flush()
    expect(scheduler.stats().queued).toBe(2)

    // b 的额度释放后，队首 a2 仍被 a 的 endpoint 上限挡住，c1 应越过它启动
    b1.release()
    await flush()

    const c1 = await queuedC1
    expect(c1.lease).toBeTruthy()
    expect(scheduler.stats().activeByEndpoint).toEqual({ a: 1, c: 1 })
    expect(scheduler.stats().queued).toBe(1)

    a1.release()
    await flush()
    const a2 = await queuedA2
    expect(a2.lease).toBeTruthy()

    a2.lease!.release()
    c1.lease!.release()
    await flush()
    expect(scheduler.stats().active).toBe(0)
  })

  it('同一 endpoint 的 40 个混合申请峰值不超过全局与 endpoint 上限', async () => {
    const scheduler = createTransferScheduler()
    const endpoint = transferEndpointKey('mix-host', 22)
    const leases: TransferLease[] = []
    let peakGlobal = 0
    let peakEndpoint = 0
    let settledCount = 0

    const jobs: Promise<void>[] = []
    for (let i = 0; i < 40; i++) {
      const target = i % 2 === 0 ? endpoint : transferEndpointKey(`other-${i % 5}`, 22)
      jobs.push(
        scheduler.acquire({ taskId: `m${i}`, sessionId: 's1', endpoint: target }).then(lease => {
          leases.push(lease)
          settledCount++
          const stats = scheduler.stats()
          peakGlobal = Math.max(peakGlobal, stats.active)
          peakEndpoint = Math.max(peakEndpoint, stats.activeByEndpoint[endpoint] ?? 0)
        }),
      )
      await flush()
    }

    expect(settledCount).toBe(4)
    // 分批释放，模拟 Worker exit 后继续补位
    for (let round = 0; round < 20; round++) {
      const batch = leases.splice(0)
      if (batch.length === 0) {
        await flush()
        if (settledCount >= 40) break
        continue
      }
      for (const lease of batch) {
        lease.release()
        await flush()
      }
      await flush()
    }
    await Promise.all(jobs)

    expect(peakGlobal).toBeLessThanOrEqual(4)
    expect(peakEndpoint).toBeLessThanOrEqual(2)
    expect(settledCount).toBe(40)
    expect(scheduler.stats().active).toBe(0)
    expect(scheduler.stats().queued).toBe(0)
  })
})
