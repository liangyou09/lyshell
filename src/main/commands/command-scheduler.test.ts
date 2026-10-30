import { describe, expect, it, vi } from 'vitest'
import { OperationError } from '@shared/operation'
import { CommandNotStartedError, CommandScheduler } from './command-scheduler'
import type { CommandExecutionHandle, ResourceCloseResult } from './types'

function fakeHandle() {
  let resolveResult!: (value: { output: string; exitCode: number }) => void
  let rejectResult!: (error: Error) => void
  let resolveClose!: (value: ResourceCloseResult) => void
  const result = new Promise<{ output: string; exitCode: number }>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  const resourceClosed = new Promise<ResourceCloseResult>(resolve => { resolveClose = resolve })
  const handle: CommandExecutionHandle = { result, resourceClosed, cancel: vi.fn() }
  return { handle, resolveResult, rejectResult, resolveClose }
}

const CLOSED: ResourceCloseResult = { state: 'closed', localClosed: true, remoteTerminated: 'confirmed' }
const NOT_DISPATCHED: ResourceCloseResult = { state: 'closed', localClosed: true, remoteTerminated: 'not-dispatched' }

function scheduler(limits: Partial<ConstructorParameters<typeof CommandScheduler>[0]>) {
  return new CommandScheduler(limits)
}

describe('CommandScheduler 名额', () => {
  it('调用者活动名额限制并发，排队者出队后执行', async () => {
    const owner = scheduler({ globalActive: 5, callerActive: 2, endpointActive: 5, globalQueued: 10, callerQueued: 10 })
    const handles = [fakeHandle(), fakeHandle(), fakeHandle()]
    const dispatches = handles.map((_, index) => vi.fn(() => handles[index].handle))
    const scheduled = handles.map((_, index) => owner.schedule({ callerKey: 'a', dispatch: dispatches[index] }))
    expect(owner.snapshot().active).toBe(2)
    expect(owner.snapshot().queued).toBe(1)
    expect(dispatches[2]).not.toHaveBeenCalled()

    handles[0].resolveResult({ output: 'ok', exitCode: 0 })
    handles[0].resolveClose(CLOSED)
    await scheduled[0].result
    await Promise.resolve()
    expect(owner.snapshot().active).toBe(2)
    expect(owner.snapshot().queued).toBe(0)
  })

  it('端点名额限制同一连接，不同端点互不阻塞', () => {
    const owner = scheduler({ globalActive: 5, callerActive: 5, endpointActive: 1, globalQueued: 10, callerQueued: 10 })
    owner.schedule({ callerKey: 'a', endpointKey: 's1:g1', dispatch: () => fakeHandle().handle })
    owner.schedule({ callerKey: 'a', endpointKey: 's1:g1', dispatch: () => fakeHandle().handle })
    owner.schedule({ callerKey: 'a', endpointKey: 's2:g1', dispatch: () => fakeHandle().handle })
    expect(owner.snapshot().activeByEndpoint).toEqual({ 's1:g1': 1, 's2:g1': 1 })
    expect(owner.snapshot().queued).toBe(1)
  })

  it('全局名额限制所有调用者', () => {
    const owner = scheduler({ globalActive: 2, callerActive: 2, endpointActive: 2, globalQueued: 10, callerQueued: 10 })
    for (const caller of ['a', 'b', 'c']) {
      owner.schedule({ callerKey: caller, dispatch: () => fakeHandle().handle })
      owner.schedule({ callerKey: caller, dispatch: () => fakeHandle().handle })
    }
    expect(owner.snapshot().active).toBe(2)
    expect(owner.snapshot().queued).toBe(4)
  })

  it('公平轮转：一个调用者不能连续占满名额', async () => {
    const owner = scheduler({ globalActive: 1, callerActive: 5, endpointActive: 5, globalQueued: 10, callerQueued: 10 })
    const order: string[] = []
    const a0 = fakeHandle()
    const a1 = fakeHandle()
    const b0 = fakeHandle()
    owner.schedule({ callerKey: 'a', dispatch: () => { order.push('a0'); return a0.handle } })
    const qa1 = owner.schedule({ callerKey: 'a', dispatch: () => { order.push('a1'); return a1.handle } })
    owner.schedule({ callerKey: 'b', dispatch: () => { order.push('b0'); return b0.handle } })

    a0.resolveResult({ output: '', exitCode: 0 })
    a0.resolveClose(CLOSED)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(order).toEqual(['a0', 'b0'])

    b0.resolveResult({ output: '', exitCode: 0 })
    b0.resolveClose(CLOSED)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(order).toEqual(['a0', 'b0', 'a1'])
    expect(qa1.dispatched).toBe(true)
  })

  it('队列满时同步拒绝，不静默扩容', () => {
    const owner = scheduler({ globalActive: 1, callerActive: 5, endpointActive: 5, globalQueued: 2, callerQueued: 1 })
    owner.schedule({ callerKey: 'a', dispatch: () => fakeHandle().handle })
    owner.schedule({ callerKey: 'a', dispatch: () => fakeHandle().handle })
    expect(() => owner.schedule({ callerKey: 'a', dispatch: () => fakeHandle().handle }))
      .toThrowError(/Command queue is full \(caller max 1\)/)
    owner.schedule({ callerKey: 'b', dispatch: () => fakeHandle().handle })
    expect(() => owner.schedule({ callerKey: 'c', dispatch: () => fakeHandle().handle }))
      .toThrowError(/Command queue is full \(global max 2\)/)
  })
})

describe('CommandScheduler 资源关闭契约', () => {
  it('结果失败但资源未关闭时名额继续占用', async () => {
    const owner = scheduler({ globalActive: 1, callerActive: 1, endpointActive: 1, globalQueued: 10, callerQueued: 10 })
    const fake = fakeHandle()
    const scheduled = owner.schedule({ callerKey: 'a', dispatch: () => fake.handle })
    fake.rejectResult(new OperationError('OUTCOME_UNKNOWN', 'remote unknown', 'reconcile-first'))
    await expect(scheduled.result).rejects.toThrow('remote unknown')
    expect(owner.snapshot().active).toBe(1)

    fake.resolveClose(CLOSED)
    await Promise.resolve()
    expect(owner.snapshot().active).toBe(0)
  })

  it('清理未确认不归还名额，reclaim 后才释放并计数 unconfirmed', async () => {
    const owner = scheduler({ globalActive: 1, callerActive: 1, endpointActive: 1, globalQueued: 10, callerQueued: 10 })
    const fake = fakeHandle()
    const scheduled = owner.schedule({ callerKey: 'a', dispatch: () => fake.handle })
    fake.resolveResult({ output: '', exitCode: 0 })
    fake.resolveClose({ state: 'failed', localClosed: false, remoteTerminated: 'unknown', detail: 'taskkill failed' })
    await scheduled.result
    await Promise.resolve()
    expect(owner.snapshot().active).toBe(1)
    expect(owner.snapshot().unconfirmed).toBe(1)

    scheduled.reclaim()
    expect(owner.snapshot().active).toBe(0)
    expect(owner.snapshot().unconfirmed).toBe(0)
  })

  it('取消排队目标：明确 not-started、不执行、不占名额', async () => {
    const owner = scheduler({ globalActive: 1, callerActive: 1, endpointActive: 1, globalQueued: 10, callerQueued: 10 })
    const first = fakeHandle()
    const secondDispatch = vi.fn(() => fakeHandle().handle)
    owner.schedule({ callerKey: 'a', dispatch: () => first.handle })
    const queued = owner.schedule({ callerKey: 'a', dispatch: secondDispatch })
    queued.cancel('client')
    await expect(queued.result).rejects.toBeInstanceOf(CommandNotStartedError)
    await expect(queued.resourceClosed).resolves.toEqual(NOT_DISPATCHED)
    expect(secondDispatch).not.toHaveBeenCalled()
    expect(owner.snapshot().queued).toBe(0)
    expect(owner.snapshot().active).toBe(1)
  })

  it('派发句柄返回前取消：句柄到达后立即取消，不重放', async () => {
    const owner = scheduler({ globalActive: 1, callerActive: 1, endpointActive: 1, globalQueued: 10, callerQueued: 10 })
    const fake = fakeHandle()
    let deliver!: (handle: CommandExecutionHandle) => void
    const scheduled = owner.schedule({
      callerKey: 'a',
      dispatch: () => new Promise(resolve => { deliver = resolve })
    })
    scheduled.cancel('shutdown')
    deliver(fake.handle)
    await Promise.resolve()
    expect(fake.handle.cancel).toHaveBeenCalledWith('shutdown')
  })

  it('同步派发失败按未派发结算并释放名额', async () => {
    const owner = scheduler({ globalActive: 1, callerActive: 1, endpointActive: 1, globalQueued: 10, callerQueued: 10 })
    const next = fakeHandle()
    const scheduled = owner.schedule({
      callerKey: 'a',
      dispatch: () => { throw new OperationError('FORBIDDEN', 'revoked', 'never') }
    })
    await expect(scheduled.result).rejects.toThrow('revoked')
    await expect(scheduled.resourceClosed).resolves.toEqual(NOT_DISPATCHED)
    expect(owner.snapshot().active).toBe(0)

    owner.schedule({ callerKey: 'a', dispatch: () => next.handle })
    expect(owner.snapshot().active).toBe(1)
  })
})

describe('CommandScheduler 关闭', () => {
  it('关闭后同步拒绝新任务，等待真实关闭后才报告 closed', async () => {
    const owner = scheduler({ globalActive: 1, callerActive: 1, endpointActive: 1, globalQueued: 10, callerQueued: 10 })
    const active = fakeHandle()
    const scheduled = owner.schedule({ callerKey: 'a', dispatch: () => active.handle })
    const shutdown = owner.shutdown('shutdown', 1_000)
    expect(shutdown).toBe(owner.shutdown('shutdown', 1_000))
    expect(() => owner.schedule({ callerKey: 'a', dispatch: () => fakeHandle().handle }))
      .toThrowError(/Command scheduler is shutting down/)

    active.resolveClose(CLOSED)
    await expect(shutdown).resolves.toEqual({ state: 'closed', reason: 'shutdown', cancelled: 0, unconfirmed: 0 })
    await expect(scheduled.resourceClosed).resolves.toEqual(CLOSED)
  })

  it('取消排队项并等待在途关闭；关闭未确认时报告 unconfirmed 且名额不提前归还', async () => {
    const owner = scheduler({ globalActive: 1, callerActive: 2, endpointActive: 1, globalQueued: 10, callerQueued: 10 })
    const active = fakeHandle()
    const next = fakeHandle()
    const nextDispatch = vi.fn(() => next.handle)
    owner.schedule({ callerKey: 'a', dispatch: () => active.handle })
    const queued = owner.schedule({ callerKey: 'a', dispatch: nextDispatch })
    const shutdown = owner.shutdown('shutdown', 20)

    await expect(queued.result).rejects.toBeInstanceOf(CommandNotStartedError)
    await expect(queued.resourceClosed).resolves.toEqual(NOT_DISPATCHED)
    expect(nextDispatch).not.toHaveBeenCalled()
    await expect(shutdown).resolves.toEqual({ state: 'unconfirmed', reason: 'shutdown', cancelled: 1, unconfirmed: 1 })
    expect(owner.snapshot().active).toBe(1)

    active.resolveClose(CLOSED)
    await Promise.resolve()
    expect(owner.snapshot().active).toBe(0)
  })
})
