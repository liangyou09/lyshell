import { randomUUID } from 'node:crypto'
import { OperationError } from '@shared/operation'
import type { BrowserHostBounds, BrowserHostHandle, BrowserHostPhase, BrowserHostRequest, BrowserHostResult, BrowserHostSnapshot } from '@shared/browser-host'

/** sender/document 都由可信 IPC 适配器提供，不接受 renderer 自报。 */
export interface BrowserHostOwner { sender: object; document: object }
export type BrowserHostNativeState = Pick<BrowserHostSnapshot, 'url' | 'loading' | 'canGoBack' | 'canGoForward' | 'visible' | 'bounds' | 'protection'>
/** 原生资源适配口；不依赖 Electron 窗口或 HTTP/IPC 注册模块。 */
export interface BrowserHostPort {
  state(): BrowserHostNativeState
  verified(): boolean
  destroyed(): boolean
  detached(): boolean
  attach(): void
  detach(): void
  navigate(url: string): Promise<void>
  back(): void
  forward(): void
  reload(ignoreCache: boolean): void
  stop(): void
  focus(): void
  setBounds(bounds: BrowserHostBounds): void
  setVisible(visible: boolean): void
  capture(): Promise<string>
  close(): void
  subscribe(listener: (event: 'changed' | 'crashed' | 'destroyed') => void): () => void
}
interface RecordState {
  handle: BrowserHostHandle
  owner: BrowserHostOwner
  port: BrowserHostPort
  phase: BrowserHostPhase
  revision: number
  unsubscribe: () => void
  captureBusy?: boolean
  closePromise?: Promise<BrowserHostSnapshot>
  closeResolve?: (snapshot: BrowserHostSnapshot) => void
  closeTimer?: ReturnType<typeof setTimeout>
}
const EMPTY_BOUNDS: BrowserHostBounds = { x: 0, y: 0, width: 0, height: 0 }
export class BrowserHostService {
  private readonly records = new Map<string, RecordState>()
  private draining = false
  constructor(private readonly deps: {
    enabled: () => boolean
    isOwnerCurrent: (owner: BrowserHostOwner) => boolean
    create: (owner: BrowserHostOwner) => BrowserHostPort
    validateUrl: (url: string) => boolean
    closeTimeoutMs?: number
    captureBytes?: number
  }) {}
  private current(owner: BrowserHostOwner): void {
    if (!this.deps.isOwnerCurrent(owner)) throw new OperationError('FORBIDDEN', 'The browser host requires its current application document')
  }
  private record(owner: BrowserHostOwner, handle: BrowserHostHandle): RecordState {
    this.current(owner)
    const record = this.records.get(handle.hostId)
    if (!record || record.owner.sender !== owner.sender || record.owner.document !== owner.document) throw new OperationError('FORBIDDEN', 'The browser host is not owned by this document')
    if (record.handle.generation !== handle.generation || record.handle.kind !== handle.kind) throw new OperationError('STALE_GENERATION', 'The browser host generation has changed')
    return record
  }
  private snapshot(record: RecordState): BrowserHostSnapshot {
    let state: BrowserHostNativeState = { url: '', loading: false, canGoBack: false, canGoForward: false, visible: false, bounds: EMPTY_BOUNDS, protection: 'unknown' }
    if (!record.port.destroyed()) state = record.port.state()
    return { ...state, bounds: { ...state.bounds }, handle: { ...record.handle }, phase: record.phase, revision: record.revision, readonly: true }
  }
  private notify(record: RecordState, event: 'changed' | 'crashed' | 'destroyed'): void {
    if (this.records.get(record.handle.hostId) !== record || record.phase === 'closed') return
    record.revision++
    if (event === 'crashed' && !['closing', 'close-unconfirmed'].includes(record.phase)) record.phase = 'crashed'
    if (event === 'destroyed') {
      try { if (!record.port.detached()) record.port.detach() } catch { /* 移除失败时保留容量和原句柄。 */ }
      if (!this.confirmClosed(record)) record.phase = 'close-unconfirmed'
    }
  }
  private confirmClosed(record: RecordState): boolean {
    if (record.phase === 'closed') return true
    // 从窗口移除 view 与 WebContents 销毁必须分别获得证据。
    if (!record.port.destroyed() || !record.port.detached()) return false
    record.phase = 'closed'; record.revision++
    clearTimeout(record.closeTimer); record.closeTimer = undefined
    record.unsubscribe()
    record.closeResolve?.(this.snapshot(record)); record.closeResolve = undefined
    return true
  }
  private closeRecord(record: RecordState): Promise<BrowserHostSnapshot> {
    if (record.phase === 'closed') return Promise.resolve(this.snapshot(record))
    if (record.closePromise) return record.closePromise
    record.phase = 'closing'; record.revision++
    const promise = new Promise<BrowserHostSnapshot>(resolve => { record.closeResolve = resolve })
    record.closePromise = promise
    try { record.port.setVisible(false) } catch { /* 继续尝试独立的移除和销毁。 */ }
    try { record.port.detach() } catch { /* 未确认 detach 时容量继续保留。 */ }
    try { if (!record.port.destroyed()) record.port.close() } catch { /* 由期限和原生证据决定结果。 */ }
    if (!this.confirmClosed(record)) {
      record.closeTimer = setTimeout(() => {
        record.closeTimer = undefined
        if (this.confirmClosed(record)) return
        record.phase = 'close-unconfirmed'; record.revision++
        record.closePromise = undefined
        record.closeResolve?.(this.snapshot(record)); record.closeResolve = undefined
      }, this.deps.closeTimeoutMs ?? 1500)
    }
    return promise
  }
  async request(owner: BrowserHostOwner, request: BrowserHostRequest): Promise<BrowserHostResult> {
    this.current(owner)
    if (request.kind === 'capabilities') return { success: true, pilotEnabled: this.deps.enabled() && !this.draining }
    if (request.kind === 'create-readonly-pilot') {
      if (!this.deps.enabled() || this.draining) throw new OperationError('UNSUPPORTED_CAPABILITY', 'The readonly browser pilot is disabled')
      if (!this.deps.validateUrl(request.url)) throw new OperationError('INVALID_ARGUMENT', 'The readonly pilot requires a permitted HTTP document URL')
      // 未确认关闭的旧实例也占用唯一试点名额。
      if ([...this.records.values()].some(record => record.phase !== 'closed')) throw new OperationError('RESOURCE_LIMIT', 'The readonly browser pilot already has an active host')
      for (const [id, record] of this.records) if (record.phase === 'closed') this.records.delete(id)
      const port = this.deps.create(owner)
      const record: RecordState = { handle: { hostId: randomUUID(), generation: 1, kind: 'web-contents-view' }, owner, port, phase: 'created', revision: 1, unsubscribe: () => {} }
      this.records.set(record.handle.hostId, record)
      record.unsubscribe = port.subscribe(event => this.notify(record, event))
      try {
        if (!port.verified()) throw new OperationError('FORBIDDEN', 'The readonly browser contract could not be verified')
        await port.navigate(request.url)
        this.current(owner)
        if (['closing', 'close-unconfirmed', 'closed', 'crashed'].includes(record.phase) || port.destroyed()) throw new OperationError('OUTCOME_UNKNOWN', 'The readonly browser closed during navigation', 'reconcile-first')
        record.revision++
        return { success: true, snapshot: this.snapshot(record) }
      } catch (error) {
        await this.closeRecord(record)
        throw error
      }
    }
    const record = this.record(owner, request.host)
    if (request.kind === 'close') {
      const snapshot = await this.closeRecord(record)
      this.current(owner)
      return { success: true, snapshot }
    }
    if (request.kind === 'inspect') return { success: true, snapshot: this.snapshot(record) }
    if (this.draining || ['closing', 'close-unconfirmed', 'closed', 'crashed'].includes(record.phase)) throw new OperationError('STALE_GENERATION', 'The browser host is unavailable')
    if (!record.port.verified()) throw new OperationError('FORBIDDEN', 'The readonly browser contract could not be verified')
    switch (request.kind) {
      case 'attach': record.port.attach(); record.phase = 'attached'; break
      case 'detach': record.port.detach(); record.phase = 'detached'; break
      case 'navigate':
        if (!this.deps.validateUrl(request.url)) throw new OperationError('INVALID_ARGUMENT', 'The readonly pilot requires a permitted HTTP document URL')
        await record.port.navigate(request.url); break
      case 'back': record.port.back(); break
      case 'forward': record.port.forward(); break
      case 'reload': record.port.reload(request.ignoreCache === true); break
      case 'stop': record.port.stop(); break
      case 'focus': if (record.phase === 'attached' && record.port.state().visible) record.port.focus(); break
      case 'bounds': record.port.setBounds(request.bounds); break
      case 'visibility': record.port.setVisible(request.visible && record.phase === 'attached'); break
      case 'capture': {
        if (record.captureBusy) throw new OperationError('RESOURCE_LIMIT', 'The browser host already has a preview capture in flight')
        record.captureBusy = true
        const captureRevision = record.revision
        try {
          const image = await record.port.capture()
          this.current(owner); this.record(owner, request.host)
          if (['closing', 'close-unconfirmed', 'closed', 'crashed'].includes(record.phase) || record.port.destroyed()) throw new OperationError('OUTCOME_UNKNOWN', 'The browser host closed during preview capture', 'reconcile-first')
          if (record.revision !== captureRevision) throw new OperationError('STALE_GENERATION', 'The browser changed during preview capture', 'safe')
          if (image.length > (this.deps.captureBytes ?? 8 * 1024 * 1024)) throw new OperationError('RESOURCE_LIMIT', 'The browser preview exceeds its response budget')
          return { success: true, snapshot: this.snapshot(record), image }
        } finally { record.captureBusy = false }
      }
    }
    this.current(owner); this.record(owner, request.host)
    if (['closing', 'close-unconfirmed', 'closed', 'crashed'].includes(record.phase) || record.port.destroyed()) throw new OperationError('OUTCOME_UNKNOWN', 'The browser host closed during the operation', 'reconcile-first')
    record.revision++
    return { success: true, snapshot: this.snapshot(record) }
  }
  async releaseOwner(sender: object): Promise<void> {
    await Promise.all([...this.records.values()].filter(record => record.owner.sender === sender).map(record => this.closeRecord(record)))
  }
  async shutdown(): Promise<BrowserHostSnapshot[]> {
    this.draining = true
    return Promise.all([...this.records.values()].map(record => this.closeRecord(record)))
  }
}
