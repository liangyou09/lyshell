import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SHELF_CAPTURE_DEFAULTS, createShelfCaptureScheduler, type ShelfCaptureFrame, type ShelfCapturePriority,
  type ShelfCaptureRequest, type ShelfCaptureSubmitResult,
} from './task-shelf-capture-scheduler'
import type { ShelfFrameToken } from './task-shelf-resource-budget'

interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void }
const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const token = (sequence = 1): ShelfFrameToken =>
  ({ instanceGeneration: 1, navigationGeneration: 1, geometryRevision: 1, sequence })
const submit = (scheduler: ReturnType<typeof createShelfCaptureScheduler>, resourceId: string, sequence = 1,
  priority: ShelfCapturePriority = 'bulkVisible', options: { isValid?: () => boolean; temporaryBytes?: number } = {}) =>
  scheduler.submit({ resourceId, token: token(sequence), priority, isValid: options.isValid ?? (() => true), temporaryBytes: options.temporaryBytes })
const accepted = (result: ShelfCaptureSubmitResult) => {
  if (!result.accepted) throw new Error(`不应拒绝：${result.reason}`)
  return result.promise
}
const frame = (width = 10, height = 10, dataUrl?: string): ShelfCaptureFrame => ({ width, height, dataUrl })
const flush = async () => { for (let index = 0; index < 5; index += 1) await Promise.resolve() }
const fake = () => {
  const gates = new Map<string, Deferred<ShelfCaptureFrame>>()
  const requests: ShelfCaptureRequest[] = []
  const capture = (request: ShelfCaptureRequest) => {
    requests.push(request)
    const gate = deferred<ShelfCaptureFrame>()
    gates.set(request.resourceId, gate)
    return gate.promise
  }
  return { gates, requests, capture, gate: (id: string) => gates.get(id)! }
}

afterEach(() => { vi.useRealTimers() })

describe('配置与合并', () => {
  it('默认值、非法并发与采集函数校验', () => {
    expect(SHELF_CAPTURE_DEFAULTS).toEqual({
      nativeConcurrency: 1, pendingResources: 16, temporaryBytes: 64 * 1024 * 1024, watchdogMs: 5000, maxPixels: 4_194_304,
    })
    expect(() => createShelfCaptureScheduler({ capture: () => frame(), nativeConcurrency: 0 })).toThrow(RangeError)
    expect(() => createShelfCaptureScheduler({ capture: () => frame(), pendingResources: 0 })).toThrow(RangeError)
  })
  it('同 resourceId 合并为一次原生采集并共享结果，提升优先级', async () => {
    const gate = deferred<ShelfCaptureFrame>()
    const requests: ShelfCaptureRequest[] = []
    const scheduler = createShelfCaptureScheduler({ capture: request => { requests.push(request); return gate.promise } })
    const first = accepted(submit(scheduler, 'pane-1', 1, 'bulkVisible'))
    const second = accepted(submit(scheduler, 'pane-1', 1, 'explicitMain'))
    expect(requests).toHaveLength(1)
    expect(scheduler.diagnostics()).toMatchObject({ running: 1, queued: 0, pending: 1, merged: 1, captures: 1 })
    gate.resolve(frame(10, 10, 'data:one'))
    expect((await first).status).toBe('captured')
    expect((await second).status).toBe('captured')
    expect(scheduler.diagnostics()).toMatchObject({ captured: 1, merged: 1, running: 0, temporaryBytes: 0 })
  })
})

describe('并发、队列与优先级', () => {
  it('悬挂请求不叠加原生调用；看门狗只熔断，结算前保留 inflight 额度', async () => {
    vi.useFakeTimers()
    const io = fake()
    const scheduler = createShelfCaptureScheduler({ capture: io.capture, watchdogMs: 5000 })
    const hanging = accepted(submit(scheduler, 'a', 1, 'bulkVisible', { temporaryBytes: 10 }))
    const queued = accepted(submit(scheduler, 'b', 1, 'bulkVisible', { temporaryBytes: 5 }))
    await vi.advanceTimersByTimeAsync(5000)
    expect(io.requests).toHaveLength(1)
    expect(scheduler.diagnostics()).toMatchObject({
      circuitOpen: true, watchdogTrips: 1, running: 1, queued: 0, temporaryBytes: 10, temporaryPeakBytes: 10,
    })
    expect((await queued).status).toBe('rejected')
    expect(submit(scheduler, 'c', 1)).toMatchObject({ accepted: false, reason: 'circuit-open' })
    expect(scheduler.diagnostics()).toMatchObject({ watchdogDropped: 1 })

    scheduler.resetCircuit()
    const later = accepted(submit(scheduler, 'd', 1, 'bulkVisible', { temporaryBytes: 5 }))
    await vi.advanceTimersByTimeAsync(10000)
    expect(io.requests).toHaveLength(1)
    expect(scheduler.diagnostics()).toMatchObject({ running: 1, queued: 1, temporaryBytes: 10 })

    io.gate('a').resolve(frame())
    expect((await hanging).status).toBe('captured')
    expect(io.requests).toHaveLength(2)
    expect(scheduler.diagnostics()).toMatchObject({ running: 1, queued: 0, temporaryBytes: 5 })
    io.gate('d').resolve(frame())
    expect((await later).status).toBe('captured')
    expect(scheduler.diagnostics()).toMatchObject({ running: 0, queued: 0, pending: 0, temporaryBytes: 0 })
  })
  it('真实在途结算后自动恢复调度，不依赖消费者手动 resetCircuit', async () => {
    vi.useFakeTimers()
    const io = fake()
    const scheduler = createShelfCaptureScheduler({ capture: io.capture, watchdogMs: 5000 })
    const hanging = accepted(submit(scheduler, 'a', 1))
    const dropped = accepted(submit(scheduler, 'b', 1))
    await vi.advanceTimersByTimeAsync(5000)
    expect((await dropped).status).toBe('rejected')
    expect(scheduler.diagnostics()).toMatchObject({ circuitOpen: true, running: 1 })
    expect(submit(scheduler, 'c', 1)).toMatchObject({ accepted: false, reason: 'circuit-open' })

    io.gate('a').resolve(frame())
    expect((await hanging).status).toBe('captured')
    // 真实 Promise 落下即恢复，下一次提交直接派出原生调用。
    expect(scheduler.diagnostics()).toMatchObject({ circuitOpen: false, running: 0 })
    const next = accepted(submit(scheduler, 'd', 1))
    expect(io.requests).toHaveLength(2)
    io.gate('d').resolve(frame())
    expect((await next).status).toBe('captured')
  })
  it('队列超限优先淘汰低优先级排队项，且被淘汰者不执行', async () => {
    const io = fake()
    const scheduler = createShelfCaptureScheduler({ capture: io.capture, pendingResources: 3 })
    accepted(submit(scheduler, 'a', 1, 'explicitShelf'))
    const low = accepted(submit(scheduler, 'b', 1, 'bulkVisible'))
    accepted(submit(scheduler, 'c', 1, 'bulkVisible'))
    expect(submit(scheduler, 'e', 1, 'bulkVisible')).toMatchObject({ accepted: false, reason: 'queue-full' })
    expect(accepted(submit(scheduler, 'd', 1, 'explicitMain'))).toBeDefined()
    expect(await low).toMatchObject({ status: 'rejected', reason: 'queue-full' })
    expect(scheduler.diagnostics()).toMatchObject({ pending: 3, queued: 2, evicted: 1 })
    io.gate('a').resolve(frame())
    await flush()
    expect(io.requests.map(request => request.resourceId)).toEqual(['a', 'd'])
    io.gate('d').resolve(frame())
    await flush()
    expect(io.requests.map(request => request.resourceId)).toEqual(['a', 'd', 'c'])
    io.gate('c').resolve(frame())
    await flush()
    expect(io.gates.has('b')).toBe(false)
  })
  it('入队时清扫失效描述符腾出容量，排队失效不触发采集', async () => {
    const io = fake()
    let valid = true
    const scheduler = createShelfCaptureScheduler({ capture: io.capture, pendingResources: 2 })
    const running = accepted(submit(scheduler, 'a'))
    const waiting = accepted(submit(scheduler, 'b', 1, 'bulkVisible', { isValid: () => valid }))
    valid = false
    const replacement = accepted(submit(scheduler, 'c'))
    expect(await waiting).toMatchObject({ status: 'invalid', reason: 'context' })
    expect(scheduler.diagnostics()).toMatchObject({ pending: 2, queued: 1, invalid: 1 })
    io.gate('a').resolve(frame())
    await running
    expect(io.requests.map(request => request.resourceId)).toEqual(['a', 'c'])
    io.gate('c').resolve(frame())
    await replacement
    expect(io.gates.has('b')).toBe(false)
  })
})

describe('代际与结果校验', () => {
  it('运行中合并更新 token 后丢弃旧布局结果并重采', async () => {
    const io = fake()
    const scheduler = createShelfCaptureScheduler({ capture: io.capture })
    const result = accepted(submit(scheduler, 'a', 1))
    const merged = submit(scheduler, 'a', 2, 'explicitShelf')
    expect(merged).toMatchObject({ accepted: true, merged: true })
    io.gate('a').resolve(frame(10, 10, 'old'))
    await flush()
    expect(io.requests.map(request => request.token.sequence)).toEqual([1, 2])
    io.gates.get('a')!.resolve(frame(20, 20, 'new'))
    const final = await result
    expect(final).toMatchObject({ status: 'captured', token: { sequence: 2 }, frame: { dataUrl: 'new' } })
    expect(scheduler.diagnostics()).toMatchObject({ captured: 1, merged: 1, running: 0, queued: 0 })
  })
  it('提交旧 token 与非法请求明确拒绝', () => {
    const io = fake()
    const scheduler = createShelfCaptureScheduler({ capture: io.capture })
    accepted(submit(scheduler, 'a', 3))
    expect(submit(scheduler, 'a', 2)).toMatchObject({ accepted: false, reason: 'stale' })
    expect(scheduler.submit({ resourceId: '', token: token(), priority: 'bulkVisible', isValid: () => true }))
      .toMatchObject({ accepted: false, reason: 'invalid-request' })
    expect(scheduler.submit({ resourceId: 'x', token: { ...token(), sequence: 1.5 }, priority: 'bulkVisible', isValid: () => true }))
      .toMatchObject({ accepted: false, reason: 'invalid-request' })
    expect(scheduler.submit({ resourceId: 'x', token: token(), priority: 'nope' as ShelfCapturePriority, isValid: () => true }))
      .toMatchObject({ accepted: false, reason: 'invalid-request' })
    expect(submit(scheduler, 'x', 1, 'bulkVisible', { temporaryBytes: -1 })).toMatchObject({ accepted: false, reason: 'invalid-request' })
    expect(scheduler.diagnostics()).toMatchObject({ stale: 1 })
  })
  it('旧尺寸/超大结果标记无效，不提交给消费者', async () => {
    const io = fake()
    const scheduler = createShelfCaptureScheduler({ capture: io.capture })
    const result = accepted(submit(scheduler, 'a'))
    io.gate('a').resolve(frame(5000, 1000))
    expect(await result).toMatchObject({ status: 'invalid', reason: 'result' })
    const negative = accepted(submit(scheduler, 'b'))
    io.gate('b').resolve(frame(-1, 10))
    expect(await negative).toMatchObject({ status: 'invalid', reason: 'result' })
    expect(scheduler.diagnostics()).toMatchObject({ invalid: 2, captured: 0, running: 0 })
  })
  it('采集前复检有效性，返回时再次复检', async () => {
    const io = fake()
    let valid = true
    const scheduler = createShelfCaptureScheduler({ capture: io.capture })
    const result = accepted(submit(scheduler, 'a', 1, 'bulkVisible', { isValid: () => valid }))
    valid = false
    io.gate('a').resolve(frame())
    expect(await result).toMatchObject({ status: 'invalid', reason: 'context' })
    expect(scheduler.diagnostics()).toMatchObject({ invalid: 1, captures: 1 })
  })
})

describe('临时字节、取消与失败', () => {
  it('临时预留超限拒绝排队项，峰值按真实运行占用统计', async () => {
    const io = fake()
    const scheduler = createShelfCaptureScheduler({ capture: io.capture, nativeConcurrency: 2, temporaryBytes: 100 })
    const first = accepted(submit(scheduler, 'a', 1, 'bulkVisible', { temporaryBytes: 60 }))
    const overflow = accepted(submit(scheduler, 'b', 1, 'bulkVisible', { temporaryBytes: 50 }))
    expect(await overflow).toMatchObject({ status: 'rejected', reason: 'temporary' })
    const second = accepted(submit(scheduler, 'c', 1, 'bulkVisible', { temporaryBytes: 40 }))
    expect(submit(scheduler, 'd', 1, 'bulkVisible', { temporaryBytes: 101 })).toMatchObject({ accepted: false, reason: 'temporary' })
    expect(scheduler.diagnostics()).toMatchObject({ running: 2, temporaryBytes: 100, temporaryPeakBytes: 100, captures: 2 })
    io.gate('a').resolve(frame())
    io.gate('c').resolve(frame())
    expect((await first).status).toBe('captured')
    expect((await second).status).toBe('captured')
    expect(scheduler.diagnostics()).toMatchObject({ temporaryBytes: 0, running: 0 })
  })
  it('取消排队立即结算，运行中等待真实 settle 后释放额度', async () => {
    const io = fake()
    const scheduler = createShelfCaptureScheduler({ capture: io.capture, temporaryBytes: 100 })
    const running = accepted(submit(scheduler, 'a', 1, 'bulkVisible', { temporaryBytes: 20 }))
    const waiting = accepted(submit(scheduler, 'b'))
    expect(scheduler.cancel('b')).toBe(true)
    expect(await waiting).toMatchObject({ status: 'cancelled' })
    expect(scheduler.diagnostics()).toMatchObject({ running: 1, queued: 0, pending: 1, temporaryBytes: 20 })
    expect(scheduler.cancel('a')).toBe(true)
    expect(scheduler.diagnostics()).toMatchObject({ running: 1, temporaryBytes: 20 })
    io.gate('a').resolve(frame())
    expect(await running).toMatchObject({ status: 'cancelled' })
    expect(scheduler.diagnostics()).toMatchObject({ running: 0, pending: 0, temporaryBytes: 0, cancelled: 2 })
    expect(scheduler.cancel('missing')).toBe(false)
  })
  it('采集失败结算 failed 并继续调度后续资源', async () => {
    const io = fake()
    const scheduler = createShelfCaptureScheduler({ capture: io.capture })
    const first = accepted(submit(scheduler, 'a'))
    const second = accepted(submit(scheduler, 'b'))
    io.gate('a').reject(new Error('backend down'))
    const failed = await first
    expect(failed.status).toBe('failed')
    expect(io.requests.map(request => request.resourceId)).toEqual(['a', 'b'])
    io.gate('b').resolve(frame())
    expect((await second).status).toBe('captured')
    expect(scheduler.diagnostics()).toMatchObject({ failed: 1, captured: 1, running: 0 })
  })
})
