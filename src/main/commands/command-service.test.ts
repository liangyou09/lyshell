import { describe, expect, it, vi } from 'vitest'
import { OperationError } from '@shared/operation'
import { CommandOutputBudget } from './output-budget'
import { CommandScheduler } from './command-scheduler'
import { CommandService } from './command-service'
import type {
  BatchCommandRequest,
  CommandExecutionHandle,
  CommandResult,
  ResourceCloseResult
} from './types'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const CLOSED: ResourceCloseResult = { state: 'closed', localClosed: true, remoteTerminated: 'confirmed' }

function controllableHandle() {
  const result = deferred<CommandResult>()
  const close = deferred<ResourceCloseResult>()
  const cancel = vi.fn()
  const handle: CommandExecutionHandle = { result: result.promise, resourceClosed: close.promise, cancel }
  return { handle, result, close, cancel }
}

function request(overrides: Partial<BatchCommandRequest> = {}): BatchCommandRequest {
  return {
    callerKey: 'caller-a',
    targets: [],
    timeoutMs: 1_234,
    ...overrides
  }
}

describe('CommandService 批次编排', () => {
  it('按目标顺序返回结果、真实 exitCode 与资源关闭状态', async () => {
    const service = new CommandService()
    const first = controllableHandle()
    const second = controllableHandle()
    const seenTimeouts: number[] = []
    const execution = service.runBatch(request({
      targets: [
        { sessionId: 's1', dispatch: context => { seenTimeouts.push(context.timeoutMs); return first.handle } },
        { sessionId: 's2', dispatch: context => { seenTimeouts.push(context.timeoutMs); return second.handle } }
      ]
    }))
    first.result.resolve({ output: 'one', exitCode: 0 })
    first.close.resolve(CLOSED)
    second.result.resolve({ output: '二', exitCode: 7 })
    second.close.resolve(CLOSED)

    const batch = await execution.results
    expect(batch.results).toHaveLength(2)
    expect(batch.results[0]).toMatchObject({ sessionId: 's1', state: 'completed', output: 'one', exitCode: 0, resourceClosed: 'closed' })
    expect(batch.results[1]).toMatchObject({ sessionId: 's2', state: 'completed', output: '二', exitCode: 7 })
    expect(seenTimeouts).toEqual([1_234, 1_234])
    expect(batch.retainedBytes).toBe(0)
    expect(batch.totalTimeoutMs).toBe(55_000)
    execution.release()
  })

  it('批次保留预算超限：后续目标 not-started + RESOURCE_LIMIT，失败目标字节归还', async () => {
    const service = new CommandService({
      budget: new CommandOutputBudget({ batchBytes: 10, globalBytes: 100, sendBytes: 100 })
    })
    const first = controllableHandle()
    const execution = service.runBatch(request({
      targets: [
        {
          sessionId: 's1',
          dispatch: context => {
            context.reserveBytes(6)
            return first.handle
          }
        },
        {
          sessionId: 's2',
          dispatch: context => {
            context.reserveBytes(6)
            return controllableHandle().handle
          }
        }
      ]
    }))
    first.result.resolve({ output: 'abcdef', exitCode: 0 })
    first.close.resolve(CLOSED)

    const batch = await execution.results
    expect(batch.results[0].state).toBe('completed')
    expect(batch.results[1]).toMatchObject({ state: 'not-started', code: 'RESOURCE_LIMIT' })
    expect(batch.results[1].error).toMatch(/batch max 10 bytes/)
    expect(batch.retainedBytes).toBe(6)
    execution.release()
    expect(service.budget.retainedBytes).toBe(0)
  })

  it('整批期限到点返回 OUTCOME_UNKNOWN，取消执行但名额保留到资源关闭', async () => {
    const service = new CommandService()
    const first = controllableHandle()
    const second = controllableHandle()
    const execution = service.runBatch(request({
      totalTimeoutMs: 20,
      targets: [
        { sessionId: 's1', dispatch: () => first.handle },
        { sessionId: 's2', dispatch: () => second.handle }
      ]
    }))

    const batch = await execution.results
    expect(batch.totalTimeoutMs).toBe(20)
    for (const outcome of batch.results) {
      expect(outcome).toMatchObject({
        state: 'outcome-unknown',
        code: 'OUTCOME_UNKNOWN',
        retryDisposition: 'reconcile-first',
        resourceClosed: 'unconfirmed',
        cancelReason: 'total-timeout'
      })
    }
    expect(first.cancel).toHaveBeenCalledWith('total-timeout')
    expect(service.scheduler.snapshot().active).toBe(2)

    first.result.reject(new Error('after cancel'))
    first.close.resolve(CLOSED)
    second.result.reject(new Error('after cancel'))
    second.close.resolve(CLOSED)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(service.scheduler.snapshot().active).toBe(0)
    execution.release()
  })

  it.each(['queued', 'revalidate'] as const)('整批期限区分已派发与尚未派发的 %s，结果返回不提前归还执行位', async waiting => {
    const service = new CommandService({
      scheduler: new CommandScheduler({ globalActive: waiting === 'queued' ? 1 : 2, callerActive: 2 })
    })
    const active = controllableHandle()
    const revalidation = deferred<void>()
    const revalidate = vi.fn(() => revalidation.promise)
    const neverDispatch = vi.fn(() => controllableHandle().handle)
    const execution = service.runBatch(request({
      totalTimeoutMs: 30,
      targets: [
        { sessionId: 'active', dispatch: context => { context.reserveBytes(5); return active.handle } },
        { sessionId: 'waiting', revalidate, dispatch: neverDispatch }
      ]
    }))
    const batch = await execution.results
    expect(batch.results[0]).toMatchObject({
      sessionId: 'active', state: 'outcome-unknown', code: 'OUTCOME_UNKNOWN', retryDisposition: 'reconcile-first',
      resourceClosed: 'unconfirmed', remoteTerminated: 'unknown', cancelReason: 'total-timeout'
    })
    expect(batch.results[1]).toMatchObject({
      sessionId: 'waiting', state: 'not-started', code: 'RESOURCE_LIMIT', retryDisposition: 'safe',
      remoteTerminated: 'not-dispatched', cancelReason: 'total-timeout'
    })
    expect(neverDispatch).not.toHaveBeenCalled()
    expect(revalidate).toHaveBeenCalledTimes(waiting === 'queued' ? 0 : 1)
    expect(active.cancel).toHaveBeenCalledWith('total-timeout')
    const occupied = waiting === 'queued' ? 1 : 2
    expect(service.scheduler.snapshot()).toMatchObject({ active: occupied, queued: 0 })
    execution.release()
    expect(service.budget.retainedBytes).toBe(0)
    expect(service.scheduler.snapshot().active).toBe(occupied)

    // 取消不能令异步 revalidate 的在途工作消失；它返回后才确认未派发并归还其名额。
    revalidation.resolve(undefined)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(neverDispatch).not.toHaveBeenCalled()
    expect(service.scheduler.snapshot().active).toBe(1)
    active.result.reject(new OperationError('OUTCOME_UNKNOWN', 'Command was interrupted', 'reconcile-first'))
    active.close.resolve(CLOSED)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(service.scheduler.snapshot().active).toBe(0)
  })

  it('SSH 超时的固定 COMMAND_TIMEOUT 原因跨批次结果投影保留', async () => {
    const service = new CommandService()
    const target = controllableHandle()
    const execution = service.runBatch(request({ targets: [{ sessionId: 'ssh', dispatch: () => target.handle }] }))
    target.result.reject(Object.assign(
      new OperationError('OUTCOME_UNKNOWN', 'SSH command timeout; remote outcome is unknown', 'reconcile-first'),
      { reason: 'COMMAND_TIMEOUT' }
    ))
    target.close.resolve({ state: 'closed', localClosed: true, remoteTerminated: 'unknown' })
    const batch = await execution.results
    expect(batch.results[0]).toMatchObject({
      state: 'outcome-unknown', code: 'OUTCOME_UNKNOWN', retryDisposition: 'reconcile-first',
      reason: 'COMMAND_TIMEOUT', error: 'SSH command timeout; remote outcome is unknown'
    })
    execution.release()
    expect(service.scheduler.snapshot().active).toBe(0)
    expect(service.budget.retainedBytes).toBe(0)
  })

  it('普通执行异常的秘密样例文本不进入公开结果', async () => {
    const service = new CommandService()
    const target = controllableHandle()
    const execution = service.runBatch(request({ targets: [{ sessionId: 'ssh', dispatch: () => target.handle }] }))
    const secret = 'fixture-secret-token=private-value; fixture raw terminal content'
    target.result.reject(new Error(secret))
    target.close.resolve({ state: 'closed', localClosed: true, remoteTerminated: 'unknown' })
    const batch = await execution.results
    expect(batch.results[0]).toMatchObject({
      state: 'outcome-unknown', code: 'OUTCOME_UNKNOWN', retryDisposition: 'reconcile-first',
      error: 'Command outcome is unknown; inspect side effects before retrying'
    })
    expect(JSON.stringify(batch)).not.toContain('fixture-secret-token')
    expect(JSON.stringify(batch)).not.toContain('fixture raw terminal content')
    execution.release()
    expect(service.scheduler.snapshot().active).toBe(0)
    expect(service.budget.retainedBytes).toBe(0)
  })

  it('出队后复核失败：不派发、not-started/FORBIDDEN 且不重试', async () => {
    const service = new CommandService()
    const dispatch = vi.fn(() => controllableHandle().handle)
    const execution = service.runBatch(request({
      targets: [{
        sessionId: 's1',
        revalidate: () => { throw new OperationError('FORBIDDEN', 'session revoked', 'never') },
        dispatch
      }]
    }))
    const batch = await execution.results
    expect(batch.results[0]).toMatchObject({
      state: 'not-started',
      code: 'FORBIDDEN',
      retryDisposition: 'never',
      error: 'session revoked'
    })
    expect(dispatch).not.toHaveBeenCalled()
    expect(service.scheduler.snapshot().active).toBe(0)
    execution.release()
  })

  it('清理未确认时结果可返回，但调度名额不归还', async () => {
    const service = new CommandService()
    const target = controllableHandle()
    const execution = service.runBatch(request({
      targets: [{ sessionId: 's1', dispatch: () => target.handle }]
    }))
    target.result.resolve({ output: 'done', exitCode: 0 })
    target.close.resolve({ state: 'failed', localClosed: false, remoteTerminated: 'unknown', detail: 'taskkill failed' })

    const batch = await execution.results
    expect(batch.results[0]).toMatchObject({
      state: 'completed',
      output: 'done',
      resourceClosed: 'failed',
      remoteTerminated: 'unknown'
    })
    expect(service.scheduler.snapshot().active).toBe(1)
    expect(service.scheduler.snapshot().unconfirmed).toBe(1)
    execution.release()
  })

  it('队列/名额不足时同步给出 not-started，不抛给调用方', async () => {
    const service = new CommandService({
      scheduler: new CommandScheduler({ globalQueued: 0 })
    })
    const execution = service.runBatch(request({
      targets: [{ sessionId: 's1', dispatch: () => controllableHandle().handle }]
    }))
    const batch = await execution.results
    expect(batch.results[0]).toMatchObject({ state: 'not-started', code: 'RESOURCE_LIMIT' })
    expect(batch.results[0].error).toMatch(/Command queue is full/)
    execution.release()
  })

  it('失败结果归还该目标已预留的字节', async () => {
    const service = new CommandService()
    const target = controllableHandle()
    const execution = service.runBatch(request({
      targets: [{
        sessionId: 's1',
        dispatch: context => {
          context.reserveBytes(4)
          return target.handle
        }
      }]
    }))
    target.result.reject(new OperationError('OUTCOME_UNKNOWN', 'remote unknown', 'reconcile-first'))
    target.close.resolve({ state: 'closed', localClosed: true, remoteTerminated: 'unknown' })

    const batch = await execution.results
    expect(batch.results[0]).toMatchObject({
      state: 'outcome-unknown',
      code: 'OUTCOME_UNKNOWN',
      retryDisposition: 'reconcile-first'
    })
    expect(batch.retainedBytes).toBe(0)
    execution.release()
  })
})

describe('CommandService 发送预算', () => {
  it('按转义后字节预留/释放，估算包含结构余量', async () => {
    const service = new CommandService({
      budget: new CommandOutputBudget({ batchBytes: 1000, globalBytes: 1000, sendBytes: 300 })
    })
    const outcome = { sessionId: 's1', state: 'completed' as const, output: '"\\\n中文', exitCode: 0 }
    const estimate = service.estimateSendBytes(outcome)
    expect(estimate).toBeGreaterThan(Buffer.byteLength(outcome.output))
    // sessionId 也进入预估，避免长 ID 在 JSON 编码后才超卖。
    expect(service.estimateSendBytes({ ...outcome, sessionId: 's10' })).toBe(estimate + 1)
    const batch = { results: [outcome], retainedBytes: 0, totalTimeoutMs: 55_000 }
    expect(service.estimateBatchSendBytes(batch)).toBe(estimate + 512)

    service.reserveSendBytes('req-1', 200)
    expect(() => service.reserveSendBytes('req-2', 200)).toThrowError(/send max 300 bytes/)
    service.releaseSendBytes('req-1')
    service.releaseSendBytes('req-1')
    expect(service.budget.sendBytes).toBe(0)
  })

  it('release 幂等：拒绝后再次调用不重复归还', async () => {
    const service = new CommandService()
    const target = controllableHandle()
    const execution = service.runBatch(request({
      targets: [{
        sessionId: 's1',
        dispatch: context => {
          context.reserveBytes(5)
          return target.handle
        }
      }]
    }))
    target.result.resolve({ output: 'ok', exitCode: 0 })
    target.close.resolve(CLOSED)
    const batch = await execution.results
    expect(batch.retainedBytes).toBe(5)
    execution.release()
    execution.release()
    expect(service.budget.retainedBytes).toBe(0)
  })

  it('两个调用者各 50 个目标：活动位、排队数、端点并发与保留额度均在界内', async () => {
    const service = new CommandService()
    const handles: ReturnType<typeof controllableHandle>[] = []
    const batchRequest = (callerKey: string, prefix: string): BatchCommandRequest => request({
      callerKey,
      targets: Array.from({ length: 50 }, (_, index) => ({
        sessionId: `${prefix}${index}`,
        dispatch: context => {
          context.reserveBytes(1024)
          const created = controllableHandle()
          handles.push(created)
          return created.handle
        }
      }))
    })
    const first = service.runBatch(batchRequest('caller-a', 'a'))
    const second = service.runBatch(batchRequest('caller-b', 'b'))

    await vi.waitFor(() => expect(service.scheduler.snapshot().active).toBe(8))
    const snapshot = service.scheduler.snapshot()
    expect(snapshot.active).toBeLessThanOrEqual(16)
    expect(snapshot.queued).toBe(92)
    expect(snapshot.activeByCaller).toEqual({ 'caller-a': 4, 'caller-b': 4 })
    for (const endpoint of Object.values(snapshot.activeByEndpoint)) expect(endpoint).toBeLessThanOrEqual(2)
    expect(service.budget.retainedBytes).toBe(8 * 1024)

    const settled = new Set<ReturnType<typeof controllableHandle>>()
    while (settled.size < handles.length) {
      for (const handle of handles) {
        if (settled.has(handle)) continue
        settled.add(handle)
        handle.result.resolve({ output: 'ok', exitCode: 0 })
        handle.close.resolve(CLOSED)
      }
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    const [batchA, batchB] = await Promise.all([first.results, second.results])
    expect(batchA.results).toHaveLength(50)
    expect(batchB.results).toHaveLength(50)
    expect(batchA.results.every(result => result.state === 'completed')).toBe(true)
    expect(batchB.results.every(result => result.state === 'completed')).toBe(true)
    expect(service.scheduler.snapshot().active).toBe(0)
    first.release()
    second.release()
    expect(service.budget.retainedBytes).toBe(0)
  })
})

describe('CommandService 输出限制与关闭', () => {
  function limitError(partialOutput: string): Error {
    return Object.assign(
      new OperationError('RESOURCE_LIMIT', 'Command output limit exceeded (batch max 100 bytes)', 'never'),
      { partialOutput }
    )
  }

  it('保留 partialOutput 时计入批次预算；关闭不明时升级 OUTCOME_UNKNOWN 并保留 OUTPUT_LIMIT 原因', async () => {
    const service = new CommandService({
      budget: new CommandOutputBudget({ batchBytes: 100, globalBytes: 100, sendBytes: 100 })
    })
    const target = controllableHandle()
    const execution = service.runBatch(request({
      targets: [{ sessionId: 's1', dispatch: () => target.handle }]
    }))
    target.result.reject(limitError('中文'))
    target.close.resolve({ state: 'unconfirmed', localClosed: true, remoteTerminated: 'unknown' })

    const batch = await execution.results
    expect(batch.results[0]).toMatchObject({
      state: 'outcome-unknown',
      code: 'OUTCOME_UNKNOWN',
      retryDisposition: 'reconcile-first',
      reason: 'OUTPUT_LIMIT',
      partialOutput: '中文'
    })
    expect(batch.retainedBytes).toBe(Buffer.byteLength('中文'))
    execution.release()
    expect(service.budget.retainedBytes).toBe(0)
  })

  it('诊断片段没有剩余容量时省略，不超卖预算', async () => {
    const service = new CommandService({
      budget: new CommandOutputBudget({ batchBytes: 3, globalBytes: 3, sendBytes: 100 })
    })
    const target = controllableHandle()
    const execution = service.runBatch(request({
      targets: [{ sessionId: 's1', dispatch: () => target.handle }]
    }))
    target.result.reject(limitError('中文'))
    target.close.resolve({ state: 'unconfirmed', localClosed: true, remoteTerminated: 'unknown' })

    const batch = await execution.results
    expect(batch.results[0]).toMatchObject({ code: 'OUTCOME_UNKNOWN', reason: 'OUTPUT_LIMIT' })
    expect(batch.results[0].partialOutput).toBeUndefined()
    expect(batch.retainedBytes).toBe(0)
    execution.release()
  })

  it('关闭已确认时保留 RESOURCE_LIMIT 与不可重试语义', async () => {
    const service = new CommandService()
    const target = controllableHandle()
    const execution = service.runBatch(request({
      targets: [{ sessionId: 's1', dispatch: () => target.handle }]
    }))
    target.result.reject(limitError('片段'))
    target.close.resolve(CLOSED)

    const batch = await execution.results
    expect(batch.results[0]).toMatchObject({
      state: 'failed',
      code: 'RESOURCE_LIMIT',
      retryDisposition: 'never',
      reason: 'OUTPUT_LIMIT',
      partialOutput: '片段'
    })
    execution.release()
  })

  it('shutdown：同步拒绝新批次，取消排队与在途，等待关闭后释放预算', async () => {
    const service = new CommandService({
      scheduler: new CommandScheduler({ globalActive: 1, callerActive: 2, endpointActive: 1, globalQueued: 10, callerQueued: 10 })
    })
    const active = controllableHandle()
    const queued = controllableHandle()
    const queuedDispatch = vi.fn(() => queued.handle)
    const activeExecution = service.runBatch(request({
      targets: [{
        sessionId: 's1',
        dispatch: context => {
          context.reserveBytes(5)
          return active.handle
        }
      }]
    }))
    const queuedExecution = service.runBatch(request({
      targets: [{ sessionId: 's2', dispatch: queuedDispatch }]
    }))

    // 让首批真正拿到执行句柄后再关闭，覆盖“在途 + 排队”两种取消路径。
    await new Promise(resolve => setTimeout(resolve, 0))
    const shutdown = service.shutdown('shutdown')
    expect(shutdown).toBe(service.shutdown('shutdown'))
    expect(() => service.runBatch(request())).toThrowError(/Command service is shutting down/)
    active.close.resolve(CLOSED)

    const [activeBatch, queuedBatch] = await Promise.all([activeExecution.results, queuedExecution.results])
    expect(activeBatch.results[0].state).toBe('outcome-unknown')
    expect(queuedBatch.results[0].state).toBe('not-started')
    expect(queuedDispatch).not.toHaveBeenCalled()
    await expect(shutdown).resolves.toEqual({
      state: 'closed',
      reason: 'shutdown',
      cancelled: 1,
      unconfirmed: 0,
      batches: 2
    })
    expect(service.budget.retainedBytes).toBe(0)
  })

  it('release 之后迟到的预留被拒绝，不产生预算增长', async () => {
    const service = new CommandService()
    let lateReserve!: (bytes: number) => void
    const execution = service.runBatch(request({
      targets: [{
        sessionId: 's1',
        dispatch: context => {
          lateReserve = context.reserveBytes
          return controllableHandle().handle
        }
      }]
    }))
    await vi.waitFor(() => expect(lateReserve).toBeTypeOf('function'))
    execution.release()
    expect(() => lateReserve(3)).toThrowError(/no longer accepts output/)
    expect(service.budget.retainedBytes).toBe(0)
  })
})
