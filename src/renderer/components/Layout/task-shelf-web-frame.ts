/**
 * 任务架网页缩略图的只读采集管线：应用级调度器 + 帧缓存 + 页代际。
 * 只读取既有 webview，不创建、导航、聚焦 guest；不持有无界页引用。
 */
import type { WebviewTag } from 'electron'
import {
  createShelfFrameCache,
  isShelfResourceId,
  type ShelfBudgetConfig,
  type ShelfDecodedReservation,
  type ShelfFrameCacheDiagnostics,
  type ShelfFrameLease,
  type ShelfFrameOfferInput,
  type ShelfFrameToken,
  type ShelfFrameView,
  type ShelfTemporaryReservation,
} from './task-shelf-resource-budget'
import {
  createShelfCaptureScheduler,
  type ShelfCaptureDiagnostics,
  type ShelfCaptureFrame,
  type ShelfCapturePriority,
  type ShelfCaptureSchedulerConfig,
} from './task-shelf-capture-scheduler'

export interface ShelfWebFrame { image?: string; width: number; height: number }
export interface ShelfWebPreviewHandle {
  readonly resourceId: string
  readonly page: WebviewTag
  release(): void
}

export interface ShelfPreviewDiagnostics {
  sources: number
  visibleSources: number
  scheduler: ShelfCaptureDiagnostics
  cache: ShelfFrameCacheDiagnostics
}

export interface ShelfWebPreviewRuntime {
  open(page: WebviewTag, resourceId: string, priority?: ShelfCapturePriority): ShelfWebPreviewHandle | null
  refresh(handle: ShelfWebPreviewHandle): Promise<ShelfWebFrame | null>
  acquireDisplay(resourceId: string): ShelfFrameLease | null
  releaseDisplay(lease: ShelfFrameLease): boolean
  current(resourceId: string): ShelfFrameView | null
  /** 终端 Canvas 与网页解码帧共用同一 decoded 预算。 */
  reserveCanvas(bytes: number): ShelfDecodedReservation | null
  releaseCanvas(reservation: ShelfDecodedReservation): boolean
  diagnostics(): ShelfPreviewDiagnostics
  dispose(): void
}

export interface ShelfWebPreviewRuntimeOptions {
  budget?: Partial<ShelfBudgetConfig>
  scheduler?: Partial<Omit<ShelfCaptureSchedulerConfig, 'capture'>>
  maxSources?: number
}

/** 原始截图物理像素硬上限（与方案 9.2 表一致）。 */
export const SHELF_MAX_RAW_PIXELS = 4_194_304
export const SHELF_PREVIEW_MAX_WIDTH = 960
export const SHELF_PREVIEW_MAX_HEIGHT = 600
const SOURCE_CACHE_MS = 400
const MAX_SOURCE_DESCRIPTORS = 64

interface Source {
  resourceId: string
  page: WebviewTag
  instanceGeneration: number
  navigationGeneration: number
  geometryRevision: number
  sequence: number
  width: number
  height: number
  dpr: number
  visible: number
  priority: ShelfCapturePriority
  blocked: boolean
  active: boolean
  failures: number
  retryAt: number
  stableAt: number
  lastUsed: number
  navHandler?: EventListener
  pending?: { at: number; promise: Promise<ShelfWebFrame | null> }
  last?: { at: number; token: ShelfFrameToken }
}

interface HandleRecord extends ShelfWebPreviewHandle { source: Source; open: boolean }

const RANK: Record<ShelfCapturePriority, number> = { bulkVisible: 1, explicitShelf: 2, explicitMain: 3 }
const priorityOf = (value: ShelfCapturePriority | undefined): ShelfCapturePriority =>
  value && Object.prototype.hasOwnProperty.call(RANK, value) ? value : 'bulkVisible'

const pageAlive = (page: WebviewTag): boolean => (page as unknown as { isConnected?: boolean }).isConnected !== false
const now = () => Date.now()

interface Measurement { width: number; height: number; dpr: number }

/** CSS 视口 × DPR 的保守估算；无法核实或超过原始像素上限时返回 null（不调用 capturePage）。 */
function measurePage(page: WebviewTag): Measurement | null {
  if (!page || typeof page.getBoundingClientRect !== 'function') return null
  const rect = page.getBoundingClientRect()
  const cssWidth = Number(rect?.width), cssHeight = Number(rect?.height)
  if (!(cssWidth > 0) || !(cssHeight > 0)) return null
  const view = (page as unknown as { ownerDocument?: Document }).ownerDocument?.defaultView ??
    (typeof window !== 'undefined' ? window : undefined)
  const dpr = Math.max(1, Number(view?.devicePixelRatio) || 1)
  const width = Math.ceil(cssWidth * dpr), height = Math.ceil(cssHeight * dpr)
  const pixels = width * height
  if (!Number.isSafeInteger(pixels) || pixels < 1 || pixels > SHELF_MAX_RAW_PIXELS) return null
  return { width, height, dpr }
}

const tokenOf = (source: Source): ShelfFrameToken => ({
  instanceGeneration: source.instanceGeneration,
  navigationGeneration: source.navigationGeneration,
  geometryRevision: source.geometryRevision,
  sequence: source.sequence,
})

const sameToken = (a: ShelfFrameToken, b: ShelfFrameToken) =>
  a.instanceGeneration === b.instanceGeneration && a.navigationGeneration === b.navigationGeneration &&
  a.geometryRevision === b.geometryRevision && a.sequence === b.sequence

/** 可注入的小型运行时，供测试与单例共用；不创建 guest。 */
export function createShelfWebPreviewRuntime(options: ShelfWebPreviewRuntimeOptions = {}): ShelfWebPreviewRuntime {
  const cache = createShelfFrameCache(options.budget)
  const maxSources = options.maxSources ?? MAX_SOURCE_DESCRIPTORS
  if (!Number.isSafeInteger(maxSources) || maxSources < 1) throw new RangeError('maxSources 须为正安全整数')
  const byPage = new WeakMap<WebviewTag, Source>()
  const pageInstances = new WeakMap<WebviewTag, number>()
  const byId = new Map<string, WeakRef<Source>>()
  let instanceCounter = 0
  let disposed = false

  const instanceOf = (page: WebviewTag): number => {
    let value = pageInstances.get(page)
    if (value === undefined) { value = ++instanceCounter; pageInstances.set(page, value) }
    return value
  }

  const sourceById = (resourceId: string): Source | undefined => {
    const entry = byId.get(resourceId)
    const source = entry?.deref()
    if (!source) { if (entry) byId.delete(resourceId); return undefined }
    return source
  }

  const captureSource = async (request: { resourceId: string; token: ShelfFrameToken }): Promise<ShelfCaptureFrame> => {
    const source = sourceById(request.resourceId)
    if (!source || !source.active) throw new Error('预览资源已失效')
    if (!source.visible || !pageAlive(source.page)) throw new Error('预览已离屏')
    const measured = measurePage(source.page)
    if (!measured) throw new Error('无法核实 guest 视口')
    const raw = await source.page.capturePage()
    const latest = measurePage(source.page)
    // 原生返回后先复检，再分配缩放图与编码字符串；失效结果不能继续扩大临时分配。
    if (!sourceValid(source, request.token) || !latest || latest.width !== measured.width || latest.height !== measured.height || latest.dpr !== measured.dpr) throw new Error('预览上下文已变化')
    const size = raw.getSize()
    const pixels = size.width * size.height
    if (!Number.isSafeInteger(pixels) || size.width < 1 || size.height < 1) throw new Error('截图尺寸非法')
    if (pixels > SHELF_MAX_RAW_PIXELS || size.width > measured.width || size.height > measured.height) {
      // 实际尺寸超出预算时不 resize、不 toDataURL，熔断该源并保留旧帧。
      source.blocked = true
      throw new Error('截图超过物理像素预算')
    }
    if (raw.isEmpty()) throw new Error('截图没有可用表面')
    const scale = Math.min(1, SHELF_PREVIEW_MAX_WIDTH / size.width, SHELF_PREVIEW_MAX_HEIGHT / size.height)
    const width = Math.max(1, Math.round(size.width * scale))
    const height = Math.max(1, Math.round(size.height * scale))
    const dataUrl = raw.resize({ width, height }).toDataURL()
    if (!dataUrl) throw new Error('截图编码失败')
    return { dataUrl, width, height }
  }

  const scheduler = createShelfCaptureScheduler({ capture: captureSource, ...options.scheduler })

  const detach = (source: Source) => {
    source.active = false
    scheduler.cancel(source.resourceId)
    cache.invalidate(source.resourceId)
    if (source.navHandler) {
      try { source.page.removeEventListener('did-start-navigation', source.navHandler) } catch { /* guest 已销毁 */ }
      source.navHandler = undefined
    }
    if (byId.get(source.resourceId)?.deref() === source) byId.delete(source.resourceId)
  }

  const prune = () => {
    for (const [id, ref] of byId) {
      const source = ref.deref()
      if (!source || !source.active) byId.delete(id)
    }
    if (byId.size < maxSources) return true
    const idle = [...byId.entries()]
      .map(([id, ref]) => ({ id, source: ref.deref() }))
      .filter((entry): entry is { id: string; source: Source } => !!entry.source && entry.source.visible === 0)
      .sort((a, b) => a.source.lastUsed - b.source.lastUsed)
    while (byId.size >= maxSources && idle.length) detach(idle.shift()!.source)
    return byId.size < maxSources
  }

  const ensureSource = (page: WebviewTag, resourceId: string): Source | null => {
    const existing = sourceById(resourceId)
    if (existing?.page === page && existing.active) return existing
    if (existing) detach(existing)
    if (!prune()) return null
    const source: Source = {
      resourceId, page, instanceGeneration: instanceOf(page),
      navigationGeneration: 0, geometryRevision: 0, sequence: 0,
      width: 0, height: 0, dpr: 1, visible: 0, priority: 'bulkVisible',
      blocked: false, active: true, failures: 0, retryAt: 0, stableAt: 0, lastUsed: now(),
    }
    const onNavigate = (event: Event) => {
      const detail = event as Event & { isMainFrame?: boolean }
      if (detail.isMainFrame === false) return
      source.navigationGeneration += 1
      source.sequence += 1
      source.blocked = false
      source.failures = 0; source.retryAt = 0
      source.last = undefined
      scheduler.cancel(resourceId)
      cache.invalidate(resourceId)
    }
    try {
      page.addEventListener('did-start-navigation', onNavigate)
      source.navHandler = onNavigate
    } catch { /* 测试或已销毁 guest 没有事件 API */ }
    byPage.set(page, source)
    byId.set(resourceId, new WeakRef(source))
    return source
  }

  const sourceValid = (source: Source, token: ShelfFrameToken): boolean =>
    !disposed && source.active && source.visible > 0 && !source.blocked &&
    pageAlive(source.page) && sameToken(tokenOf(source), token)

  const reserveForCapture = (source: Source, measured: Measurement): ShelfTemporaryReservation | null => {
    const rawBytes = measured.width * measured.height * 4
    const outWidth = Math.min(SHELF_PREVIEW_MAX_WIDTH, measured.width)
    const outHeight = Math.min(SHELF_PREVIEW_MAX_HEIGHT, measured.height)
    const decodedBytes = outWidth * outHeight * 4
    // DataURL 按 2 bytes/codeunit 保守估算，base64 膨胀再留余量。
    const encodedBytes = outWidth * outHeight * 8
    const current = cache.get(source.resourceId)
    const oldBytes = current ? current.encodedBytes + current.decodedBytes : 0
    const total = rawBytes + decodedBytes + encodedBytes + oldBytes
    if (!Number.isSafeInteger(total)) return null
    return cache.reserveTemporary(total)
  }

  const frameFromCache = (source: Source, token: ShelfFrameToken): ShelfWebFrame | null => {
    const view = cache.get(source.resourceId)
    if (!view || !sameToken(view.token, token)) return null
    return { image: view.dataUrl, width: view.width, height: view.height }
  }

  const noteGeometry = (source: Source, measured: Measurement, cancelPending: boolean): boolean => {
    if (measured.width === source.width && measured.height === source.height && measured.dpr === source.dpr) return false
    source.stableAt = source.width > 0 ? now() + 200 : 0
    source.width = measured.width; source.height = measured.height; source.dpr = measured.dpr
    source.geometryRevision += 1
    source.sequence += 1
    source.blocked = false
    source.failures = 0; source.retryAt = 0
    source.last = undefined
    if (cancelPending) scheduler.cancel(source.resourceId)
    cache.invalidate(source.resourceId)
    return true
  }

  const refresh = (handle: ShelfWebPreviewHandle): Promise<ShelfWebFrame | null> => {
    const record = handle as HandleRecord
    const source = record.source
    if (!record.open || !source.active || source.visible < 1 || disposed || source.blocked) return Promise.resolve(null)
    if (source.pending) return source.pending.promise

    const measured = measurePage(source.page)
    if (!measured) return Promise.resolve(null)
    noteGeometry(source, measured, true)
    if (now() < source.stableAt) return Promise.resolve(null)
    if (now() < source.retryAt) return Promise.resolve(null)
    if (source.last && now() - source.last.at < SOURCE_CACHE_MS) return Promise.resolve(frameFromCache(source, source.last.token))
    const reservation = reserveForCapture(source, measured)
    if (!reservation) return Promise.resolve(null)
    const token = { ...tokenOf(source), sequence: ++source.sequence }
    const submitted = scheduler.submit({
      resourceId: source.resourceId, token, priority: source.priority, temporaryBytes: reservation.bytes,
      isValid: () => sourceValid(source, token),
    })
    if (!submitted.accepted) { cache.releaseTemporary(reservation); return Promise.resolve(null) }

    const pending = { at: now(), promise: Promise.resolve(null as ShelfWebFrame | null) }
    pending.promise = submitted.promise.then(async result => {
      try {
        // 采集期间视口/DPR 变化：实际画面已不代表当前代际，丢弃且不编码提交。
        const latest = measurePage(source.page)
        if (latest) noteGeometry(source, latest, false)
        if (!latest || result.status !== 'captured' || !sourceValid(source, token)) {
          if (result.status === 'failed') { source.failures++; source.retryAt = now() + Math.min(30000, 500 * 2 ** Math.min(6, source.failures - 1)) }
          return null
        }
        const offer: ShelfFrameOfferInput = {
          resourceId: source.resourceId, token, dataUrl: result.frame.dataUrl ?? '',
          width: result.frame.width, height: result.frame.height,
        }
        if (!offer.dataUrl || !cache.offer(offer).ok) return null
        source.failures = 0; source.retryAt = 0
        return { image: offer.dataUrl, width: offer.width, height: offer.height }
      } finally {
        cache.releaseTemporary(reservation)
      }
    }).catch(() => null).finally(() => {
      if (source.pending === pending) source.pending = undefined
      // 时间窗只保存小型 token；编码图唯一属于有界缓存，不能在 source 里另留被淘汰帧。
      source.last = { at: pending.at, token }
    })
    source.pending = pending
    return pending.promise
  }

  const runtime: ShelfWebPreviewRuntime = {
    open(page, resourceId, priority) {
      if (disposed || !isShelfResourceId(resourceId) || !page) return null
      const source = ensureSource(page, resourceId)
      if (!source) return null
      source.visible += 1
      source.lastUsed = now()
      const next = priorityOf(priority)
      if (RANK[next] > RANK[source.priority]) source.priority = next
      const handle: HandleRecord = {
        resourceId, page, source, open: true,
        release: () => {
          if (!handle.open) return
          handle.open = false
          source.visible = Math.max(0, source.visible - 1)
          source.lastUsed = now()
          if (source.visible === 0) {
            scheduler.cancel(resourceId)
            source.last = undefined
          }
        },
      }
      return handle
    },
    refresh,
    acquireDisplay: resourceId => cache.acquire(resourceId, { decoded: true }),
    releaseDisplay: lease => cache.release(lease),
    current: resourceId => cache.get(resourceId),
    reserveCanvas: bytes => cache.reserveDecoded(bytes),
    releaseCanvas: reservation => cache.releaseDecoded(reservation),
    diagnostics: () => {
      let sources = 0, visibleSources = 0
      for (const ref of byId.values()) {
        const source = ref.deref()
        if (!source?.active) continue
        sources += 1
        if (source.visible > 0) visibleSources += 1
      }
      return { sources, visibleSources, scheduler: scheduler.diagnostics(), cache: cache.diagnostics() }
    },
    dispose() {
      disposed = true
      for (const ref of [...byId.values()]) {
        const source = ref.deref()
        if (source) detach(source)
      }
      byId.clear()
    },
  }
  return runtime
}

let singleton = createShelfWebPreviewRuntime()

/** 单例由渲染层长期持有；测试可显式 reset。 */
export const getShelfWebPreviewRuntime = (): ShelfWebPreviewRuntime => singleton
export function resetShelfWebPreviewRuntime(): void {
  singleton.dispose()
  singleton = createShelfWebPreviewRuntime()
}
export const openShelfWebPreview = (
  page: WebviewTag, resourceId: string, priority?: ShelfCapturePriority
): ShelfWebPreviewHandle | null => singleton.open(page, resourceId, priority)
export const refreshShelfWebPreview = (handle: ShelfWebPreviewHandle) => singleton.refresh(handle)
export const acquireShelfDisplayFrame = (resourceId: string): ShelfFrameLease | null => singleton.acquireDisplay(resourceId)
export const releaseShelfDisplayFrame = (lease: ShelfFrameLease): boolean => singleton.releaseDisplay(lease)
export const currentShelfFrame = (resourceId: string): ShelfFrameView | null => singleton.current(resourceId)
export const reserveShelfCanvas = (bytes: number): ShelfDecodedReservation | null => singleton.reserveCanvas(bytes)
export const releaseShelfCanvas = (reservation: ShelfDecodedReservation): boolean => singleton.releaseCanvas(reservation)
export const shelfPreviewDiagnostics = (): ShelfPreviewDiagnostics => singleton.diagnostics()

/**
 * 兼容入口（脚本与旧调用方）：同 page 在途结果共享、成功帧缓存 400ms，语义与旧实现一致。
 * 采集仍走应用级调度与帧预算，只读取既有 guest，不创建/导航/聚焦。
 * 与旧实现的差异：宽度/高度返回缩放后的输出尺寸（旧实现返回原始尺寸），失败不再抛错而返回空帧，
 * 避免隐藏 guest 的截图失败中断旧调用方流程。
 */
const legacyIds = new WeakMap<WebviewTag, string>()
const legacyFrames = new WeakMap<WebviewTag, Promise<ShelfWebFrame>>()
const legacyLastAt = new WeakMap<WebviewTag, number>()
let legacySequence = 0
const legacyId = (page: WebviewTag): string => {
  let id = legacyIds.get(page)
  if (id === undefined) { id = `legacy:${++legacySequence}`; legacyIds.set(page, id) }
  return id
}
export function captureShelfWebFrame(page: WebviewTag): Promise<ShelfWebFrame> {
  const previous = legacyFrames.get(page)
  if (previous) return previous
  const id = legacyId(page)
  const cached = singleton.current(id)
  const at = legacyLastAt.get(page)
  if (at !== undefined && now() - at < SOURCE_CACHE_MS && cached) return Promise.resolve({ image: cached.dataUrl, width: cached.width, height: cached.height })
  legacyLastAt.set(page, now())
  const promise = Promise.resolve().then(async (): Promise<ShelfWebFrame> => {
      const handle = singleton.open(page, legacyId(page), 'explicitMain')
      if (!handle) return { width: 0, height: 0 }
      try {
        return (await singleton.refresh(handle)) ?? { width: 0, height: 0 }
      } catch { return { width: 0, height: 0 } }
      finally { handle.release() }
    })
  legacyFrames.set(page, promise)
  // 已完成的 Promise 也会长期持有其 DataURL；只保留在途，成功帧统一由有界缓存拥有。
  const release = () => { if (legacyFrames.get(page) === promise) legacyFrames.delete(page) }
  void promise.then(release, release)
  return promise
}
