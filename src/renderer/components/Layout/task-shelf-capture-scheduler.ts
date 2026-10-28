/** 预览采集调度：合并同资源请求、限并发/排队/临时字节、复检有效性并按全局代际丢弃旧结果。纯逻辑，不创建或销毁 guest。 */
import type { ShelfFrameToken } from './task-shelf-resource-budget'
import { compareShelfFrameTokens, estimateShelfDecodedBytes, isShelfFrameToken, isShelfResourceId } from './task-shelf-resource-budget'

export type ShelfCapturePriority = 'bulkVisible' | 'explicitShelf' | 'explicitMain'
export const SHELF_CAPTURE_PRIORITY: Readonly<Record<ShelfCapturePriority, number>> = Object.freeze({ bulkVisible: 1, explicitShelf: 2, explicitMain: 3 })

export interface ShelfCaptureRequest { resourceId: string; token: ShelfFrameToken }
export interface ShelfCaptureFrame { dataUrl?: string; width: number; height: number }

export interface ShelfCaptureSchedulerConfig {
  /** 由消费者注入真实采集；调度器只等待其 Promise，不取消、不叠加。 */
  capture: (request: ShelfCaptureRequest) => Promise<ShelfCaptureFrame> | ShelfCaptureFrame
  nativeConcurrency?: number
  pendingResources?: number
  temporaryBytes?: number
  watchdogMs?: number
  maxPixels?: number
}

export const SHELF_CAPTURE_DEFAULTS = Object.freeze({
  nativeConcurrency: 1,
  pendingResources: 16,
  temporaryBytes: 64 * 1024 * 1024,
  watchdogMs: 5000,
  maxPixels: 4_194_304,
})

export interface ShelfCaptureSubmit {
  resourceId: string
  token: ShelfFrameToken
  priority: ShelfCapturePriority
  /** 出队与返回后各复检一次；false 时不采集、不提交。 */
  isValid: () => boolean
  /** 仅计量采集链临时预留，调度器不持有截图数据。 */
  temporaryBytes?: number
}

export type ShelfCaptureRejectReason = 'queue-full' | 'circuit-open' | 'temporary' | 'stale' | 'invalid-request'

export type ShelfCaptureResult =
  | { status: 'captured'; resourceId: string; token: ShelfFrameToken; priority: ShelfCapturePriority; frame: ShelfCaptureFrame }
  | { status: 'invalid'; resourceId: string; token: ShelfFrameToken; priority: ShelfCapturePriority; reason: 'context' | 'result'; detail?: string }
  | { status: 'stale'; resourceId: string; token: ShelfFrameToken; priority: ShelfCapturePriority; detail?: string }
  | { status: 'failed'; resourceId: string; token: ShelfFrameToken; priority: ShelfCapturePriority; error: unknown }
  | { status: 'cancelled'; resourceId: string; token: ShelfFrameToken; priority: ShelfCapturePriority }
  | { status: 'rejected'; resourceId: string; token: ShelfFrameToken; priority: ShelfCapturePriority; reason: ShelfCaptureRejectReason; detail?: string }

export type ShelfCaptureSubmitResult =
  | { accepted: true; resourceId: string; merged: boolean; promise: Promise<ShelfCaptureResult> }
  | { accepted: false; resourceId: string; reason: ShelfCaptureRejectReason; detail?: string }

export interface ShelfCaptureDiagnostics {
  running: number
  queued: number
  pending: number
  circuitOpen: boolean
  watchdogTrips: number
  temporaryBytes: number
  temporaryLimitBytes: number
  temporaryPeakBytes: number
  captures: number
  submitted: number
  merged: number
  captured: number
  stale: number
  invalid: number
  failed: number
  rejected: number
  evicted: number
  cancelled: number
  watchdogDropped: number
}

interface Descriptor {
  resourceId: string
  token: ShelfFrameToken
  priority: ShelfCapturePriority
  isValid: () => boolean
  temporaryBytes: number
  sequence: number
  promise: Promise<ShelfCaptureResult>
  resolve: (result: ShelfCaptureResult) => void
  cancelled: boolean
  restart: boolean
  reservedBytes: number
  timer?: ReturnType<typeof setTimeout>
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

function readConfig(options: ShelfCaptureSchedulerConfig) {
  const { capture, ...overrides } = options
  if (typeof capture !== 'function') throw new TypeError('ShelfCaptureScheduler 需要 capture 函数')
  const config = { ...SHELF_CAPTURE_DEFAULTS, ...overrides }
  const counts = [config.nativeConcurrency, config.pendingResources, config.temporaryBytes, config.watchdogMs, config.maxPixels]
  if (!counts.every(isCount) || config.nativeConcurrency < 1 || config.pendingResources < 1 || config.maxPixels < 1) {
    throw new RangeError('ShelfCaptureSchedulerConfig 非法：并发/队列/字节/看门狗须为非负安全整数，并发、队列与像素上限 >= 1')
  }
  return { capture, config: Object.freeze(config) }
}

/** 全局实例由消费者创建并长期持有；watchdog 只熔断，不释放真实在途，也不会发起第二个采集。 */
export function createShelfCaptureScheduler(options: ShelfCaptureSchedulerConfig) {
  const { capture, config } = readConfig(options)
  const pending = new Map<string, Descriptor>()
  const queue: Descriptor[] = []
  const running = new Set<Descriptor>()
  let sequence = 0, temporaryBytes = 0, temporaryPeakBytes = 0, circuitOpen = false, watchdogTrips = 0
  const stats = { captures: 0, submitted: 0, merged: 0, captured: 0, stale: 0, invalid: 0, failed: 0, rejected: 0, evicted: 0, cancelled: 0, watchdogDropped: 0 }

  const rank = (priority: ShelfCapturePriority) => SHELF_CAPTURE_PRIORITY[priority] || 0
  const safeValid = (descriptor: Descriptor) => {
    try { return descriptor.isValid() } catch { return false }
  }
  const base = (descriptor: Descriptor) => ({ resourceId: descriptor.resourceId, token: { ...descriptor.token }, priority: descriptor.priority })
  const rejectResult = (descriptor: Descriptor, reason: ShelfCaptureRejectReason, detail?: string): ShelfCaptureResult =>
    ({ status: 'rejected', ...base(descriptor), reason, detail: detail && detail.length > 200 ? detail.slice(0, 200) : detail })
  const drainQueue = (reason: ShelfCaptureRejectReason) => {
    for (const descriptor of queue.splice(0)) {
      pending.delete(descriptor.resourceId)
      stats.rejected += 1
      if (reason === 'circuit-open') stats.watchdogDropped += 1
      descriptor.resolve(rejectResult(descriptor, reason))
    }
  }

  const dispatch = (descriptor: Descriptor) => {
    running.add(descriptor)
    descriptor.reservedBytes = descriptor.temporaryBytes
    temporaryBytes += descriptor.reservedBytes
    temporaryPeakBytes = Math.max(temporaryPeakBytes, temporaryBytes)
    const token = { ...descriptor.token }
    if (config.watchdogMs > 0) {
      descriptor.timer = setTimeout(() => {
        if (!running.has(descriptor)) return
        circuitOpen = true
        watchdogTrips += 1
        drainQueue('circuit-open')
      }, config.watchdogMs)
    }
    let promise: Promise<ShelfCaptureFrame>
    try { promise = Promise.resolve(capture({ resourceId: descriptor.resourceId, token: { ...token } })) }
    catch (error) { promise = Promise.reject(error) }
    stats.captures += 1
    promise.then(frame => settle(descriptor, token, { frame }), error => settle(descriptor, token, { error }))
  }

  const pump = () => {
    while (running.size < config.nativeConcurrency && queue.length) {
      if (circuitOpen) { drainQueue('circuit-open'); return }
      let best = 0
      for (let index = 1; index < queue.length; index += 1) {
        const candidate = queue[index], current = queue[best]
        if (rank(candidate.priority) > rank(current.priority) ||
          (rank(candidate.priority) === rank(current.priority) && candidate.sequence < current.sequence)) best = index
      }
      const descriptor = queue.splice(best, 1)[0]
      if (descriptor.cancelled) {
        pending.delete(descriptor.resourceId)
        descriptor.resolve({ status: 'cancelled', ...base(descriptor) })
        continue
      }
      if (!safeValid(descriptor)) {
        pending.delete(descriptor.resourceId)
        stats.invalid += 1
        descriptor.resolve({ status: 'invalid', ...base(descriptor), reason: 'context' })
        continue
      }
      if (temporaryBytes + descriptor.temporaryBytes > config.temporaryBytes) {
        pending.delete(descriptor.resourceId)
        stats.rejected += 1
        descriptor.resolve(rejectResult(descriptor, 'temporary'))
        continue
      }
      dispatch(descriptor)
    }
  }

  const settle = (descriptor: Descriptor, token: ShelfFrameToken, outcome: { frame: ShelfCaptureFrame } | { error: unknown }) => {
    if (descriptor.timer) { clearTimeout(descriptor.timer); descriptor.timer = undefined }
    running.delete(descriptor)
    temporaryBytes = Math.max(0, temporaryBytes - descriptor.reservedBytes)
    // 看门狗只熔断排队；真实在途 Promise 落下且没有其它在途时自动恢复，不依赖消费者兜底。
    if (circuitOpen && running.size === 0) circuitOpen = false
    if (descriptor.cancelled) {
      pending.delete(descriptor.resourceId)
      stats.cancelled += 1
      descriptor.resolve({ status: 'cancelled', ...base(descriptor) })
      pump()
      return
    }
    if (descriptor.restart || compareShelfFrameTokens(descriptor.token, token) > 0) {
      descriptor.restart = false
      if (circuitOpen) {
        pending.delete(descriptor.resourceId)
        stats.rejected += 1
        descriptor.resolve(rejectResult(descriptor, 'circuit-open'))
      } else { queue.push(descriptor); pump() }
      return
    }
    pending.delete(descriptor.resourceId)
    if ('error' in outcome) {
      stats.failed += 1
      descriptor.resolve({ status: 'failed', ...base(descriptor), error: outcome.error })
      pump()
      return
    }
    if (!validFrame(outcome.frame)) {
      stats.invalid += 1
      descriptor.resolve({ status: 'invalid', ...base(descriptor), reason: 'result', detail: '尺寸非法或超过单次像素上限' })
      pump()
      return
    }
    if (!safeValid(descriptor)) {
      stats.invalid += 1
      descriptor.resolve({ status: 'invalid', ...base(descriptor), reason: 'context' })
      pump()
      return
    }
    stats.captured += 1
    descriptor.resolve({ status: 'captured', ...base(descriptor), frame: outcome.frame })
    pump()
  }

  const validFrame = (value: unknown): value is ShelfCaptureFrame => {
    if (!value || typeof value !== 'object') return false
    const frame = value as Record<string, unknown>
    const bytes = estimateShelfDecodedBytes(frame.width, frame.height)
    return bytes !== null && bytes > 0 && bytes / 4 <= config.maxPixels &&
      (frame.dataUrl === undefined || (typeof frame.dataUrl === 'string' && frame.dataUrl.length > 0))
  }

  const submit = (input: ShelfCaptureSubmit): ShelfCaptureSubmitResult => {
    const { resourceId, token, priority, isValid } = input || {}
    const temporary = input?.temporaryBytes ?? 0
    if (!isShelfResourceId(resourceId) || !isShelfFrameToken(token) ||
      !Object.prototype.hasOwnProperty.call(SHELF_CAPTURE_PRIORITY, priority) ||
      typeof isValid !== 'function' || !isCount(temporary)) {
      return { accepted: false, resourceId: typeof resourceId === 'string' ? resourceId : '', reason: 'invalid-request' }
    }
    if (temporary > config.temporaryBytes) return { accepted: false, resourceId, reason: 'temporary' }
    const existing = pending.get(resourceId)
    if (existing) {
      const order = compareShelfFrameTokens(token, existing.token)
      if (order < 0) { stats.stale += 1; return { accepted: false, resourceId, reason: 'stale', detail: 'token 早于当前待处理代际' } }
      existing.priority = rank(priority) > rank(existing.priority) ? priority : existing.priority
      if (order > 0) {
        existing.token = { ...token }
        existing.isValid = isValid
        existing.temporaryBytes = Math.max(existing.temporaryBytes, temporary)
        if (running.has(existing)) existing.restart = true
      }
      stats.merged += 1
      return { accepted: true, resourceId, merged: true, promise: existing.promise }
    }
    if (circuitOpen) { stats.rejected += 1; return { accepted: false, resourceId, reason: 'circuit-open' } }
    if (pending.size >= config.pendingResources) {
      for (const descriptor of [...queue]) {
        if (safeValid(descriptor)) continue
        queue.splice(queue.indexOf(descriptor), 1)
        pending.delete(descriptor.resourceId)
        stats.invalid += 1
        descriptor.resolve({ status: 'invalid', ...base(descriptor), reason: 'context' })
      }
    }
    if (pending.size >= config.pendingResources) {
      const victim = queue
        .filter(descriptor => rank(descriptor.priority) < rank(priority))
        .sort((a, b) => rank(a.priority) - rank(b.priority) || a.sequence - b.sequence)[0]
      if (!victim) { stats.rejected += 1; return { accepted: false, resourceId, reason: 'queue-full', detail: '队列容量已满' } }
      queue.splice(queue.indexOf(victim), 1)
      pending.delete(victim.resourceId)
      stats.evicted += 1
      victim.resolve(rejectResult(victim, 'queue-full', '被更高优先级请求替换'))
    }
    let resolve!: (result: ShelfCaptureResult) => void
    const promise = new Promise<ShelfCaptureResult>(done => { resolve = done })
    const descriptor: Descriptor = {
      resourceId, token: { ...token }, priority, isValid, temporaryBytes: temporary, sequence: ++sequence,
      promise, resolve, cancelled: false, restart: false, reservedBytes: 0,
    }
    pending.set(resourceId, descriptor)
    queue.push(descriptor)
    stats.submitted += 1
    pump()
    return { accepted: true, resourceId, merged: false, promise }
  }

  const cancel = (resourceId: string): boolean => {
    const descriptor = pending.get(resourceId)
    if (!descriptor) return false
    descriptor.cancelled = true
    if (running.has(descriptor)) return true
    const index = queue.indexOf(descriptor)
    if (index >= 0) queue.splice(index, 1)
    pending.delete(resourceId)
    stats.cancelled += 1
    descriptor.resolve({ status: 'cancelled', ...base(descriptor) })
    pump()
    return true
  }

  return {
    submit,
    cancel,
    resetCircuit: () => { circuitOpen = false; pump() },
    diagnostics: (): ShelfCaptureDiagnostics => ({
      running: running.size, queued: queue.length, pending: pending.size, circuitOpen, watchdogTrips,
      temporaryBytes, temporaryLimitBytes: config.temporaryBytes, temporaryPeakBytes, ...stats,
    }),
  }
}
