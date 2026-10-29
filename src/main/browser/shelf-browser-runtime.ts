import type { Session, WebContents, WebPreferences } from 'electron'
import { randomUUID } from 'node:crypto'
import { ShelfResourceLifecycle, type NativeAttachEvidence, type ResourceInit, type ResourceToken, type RestoreMetadata } from './shelf-resource-lifecycle'
import type { ShelfBrowserRequest, ShelfBrowserResult } from '@shared/shelf-browser'
import type { ShelfWebSleep, TaskShelfEntry } from '@shared/task-shelf'
import { shelfWebUrl } from '@shared/task-shelf'
import { READONLY_PARTITION, READONLY_PROVIDER, applyReadonlyPreferences, isReadonlyGuest, readonlyProtection, hasReadonlySession } from './shelf-readonly-contract'
import { WEBBAR_PARTITION } from '@shared/constants'
import { RELOADABLE_PROVIDER, ReloadablePageGuard, initializeReloadableSession } from './shelf-reloadable-guard'
import { requestCancellableGuestClose } from './shelf-cancellable-close'

const MARKER = '--lyshell-shelf-permit='
const PREF = 'lyshellCreatePermit'
interface Pending {
  init: ResourceInit
  owner: WebContents
  url: string
  permitId: string
  timer: ReturnType<typeof setTimeout>
  readonlyMode?: boolean
  taskId?: string
  restore?: ShelfWebSleep
  restoring?: boolean
  partition?: string
  session?: Session
  attaching?: boolean
  attached?: boolean
  reloadableMode?: boolean
  reloadableUrl?: string
}
interface ManagedGuest { pending: Pending; guest: WebContents; token: ResourceToken; revision: number; blocked: boolean; scrollY: number; documentNonce?: string; operation?: string; closeTimer?: ReturnType<typeof setTimeout>; busy?: boolean; restoringView?: boolean; keepaliveReason?: string; guard?: ReloadablePageGuard; reloadEvidence?: { documentNonce: string; url: string; checkedAt: number } }
interface Persistence { read: (taskId: string) => TaskShelfEntry | undefined; save: (taskId: string, revision: number, metadata: ShelfWebSleep) => void | Promise<void>; setReloadable?: (taskId: string, url: string, enabled: boolean) => void }
/** 原生附着事件是实例身份的唯一来源；不接受 renderer 上报的 webContents ID。 */
export class ShelfBrowserRuntime {
  constructor(private readonly enabled = process.env.LYSHELL_SHELF_BROWSER_LIFECYCLE !== '0', private readonly options: { now?: () => number; deepSleepAfterMs?: number; closeTimeoutMs?: number; manualTick?: boolean } = {}) { this.lifecycle = this.makeLifecycle() }
  private persistence?: Persistence
  configurePersistence(value: Persistence): void { this.persistence = value }
  private readonly guests = new Map<string, ManagedGuest>()
  private readonly sleeping = new Map<string, Pending>()
  private readonly wake = new Set<string>()
  private readonly readonlyPartitions = new Set<string>()
  private reloadableSession?: Session
  private reloadableKeepalive: (id: number) => boolean = () => true
  private readonly reloadableGuards = new WeakMap<WebContents, ReloadablePageGuard>()
  private readonly initialGuestUrls = new WeakMap<WebContents, string>()
  private readonly observedGuests = new WeakSet<WebContents>()
  /** web-contents-created 早于首航；did-attach 时重定向可能已经完成。只记录原生首航。 */
  observeGuest(guest: WebContents): void {
    if (!this.enabled || this.observedGuests.has(guest)) return
    this.observedGuests.add(guest)
    const cleanup = () => { guest.removeListener('did-start-navigation', navigation); guest.removeListener('destroyed', cleanup) }
    const navigation = (_event: unknown, url: string, inPlace: boolean, main: boolean) => {
      if (!main || inPlace || url === 'about:blank') return
      this.initialGuestUrls.set(guest, url)
      cleanup()
    }
    guest.on('did-start-navigation', navigation)
    guest.once('destroyed', cleanup)
  }
  configureReloadableSupport(ses: Session, keepalive: (id: number) => boolean): void {
    if (!this.enabled) return
    initializeReloadableSession(ses)
    this.reloadableSession = ses
    this.reloadableKeepalive = keepalive
  }
  private timer?: ReturnType<typeof setInterval>
  private epoch = 0
  private paused = false
  private readonly clock = () => this.options.now?.() ?? Date.now()
  private readonly trusted = new WeakSet<object>()
  readonly lifecycle: ShelfResourceLifecycle
  private makeLifecycle(): ShelfResourceLifecycle { return new ShelfResourceLifecycle({
    safeCloseSupported: false,
    now: this.clock,
    deepSleepAfterMs: this.options.deepSleepAfterMs,
    allowlistedProviderIds: [READONLY_PROVIDER, RELOADABLE_PROVIDER],
    verifyDiscardContract: token => [...this.guests.values()].some(record => record.token.scopeId === token.scopeId && record.token.resourceId === token.resourceId && record.token.instanceGeneration === token.instanceGeneration && record.token.navigationGeneration === token.navigationGeneration && !record.blocked && (record.pending.readonlyMode && record.documentNonce && isReadonlyGuest(record.guest) || record.pending.reloadableMode && record.guard && record.reloadEvidence && this.clock() - record.reloadEvidence.checkedAt <= 2000 && record.reloadEvidence.url === record.pending.reloadableUrl && record.guest.session === this.reloadableSession && !this.reloadableKeepalive(record.guest.id))),
    verifyNativeAttach: evidence => typeof evidence === 'object' && evidence !== null && this.trusted.has(evidence) ? evidence as NativeAttachEvidence : null
  }) }
  private readonly permits = new Map<string, Pending>()
  private readonly aliases = new Map<string, string>()
  private readonly hosts = new Set<number>()
  private init(owner: WebContents, resourceId: string): ResourceInit {
    return { scopeId: `window:${owner.id}`, resourceId: this.aliases.get(`${owner.id}:${resourceId}`) ?? resourceId, ownerId: String(owner.id) }
  }
  bindTask(owner: WebContents, taskId: string, overlayId: string): void {
    let init = this.init(owner, `tab:${overlayId}`)
    if (!this.lifecycle.inspect(init).ok) {
      const saved = this.init(owner, `saved:${taskId}`)
      if (this.lifecycle.inspect(saved).ok) { init = saved; this.aliases.set(`${owner.id}:tab:${overlayId}`, init.resourceId) }
    }
    if (this.lifecycle.inspect(init).ok) this.aliases.set(`${owner.id}:saved:${taskId}`, init.resourceId)
    for (const pending of this.permits.values()) if (pending.owner === owner && pending.init.resourceId === init.resourceId) pending.taskId = taskId
  }
  unbindTask(owner: WebContents, taskId: string): void {
    this.aliases.delete(`${owner.id}:saved:${taskId}`)
    for (const pending of [...this.permits.values(), ...this.sleeping.values()]) if (pending.owner === owner && pending.taskId === taskId) pending.taskId = undefined
  }
  isReadonlyResource(owner: WebContents, overlayId: string, expectedUrl?: string): boolean {
    const init = this.init(owner, `tab:${overlayId}`)
    return [...this.guests.values()].some(record => record.pending.owner === owner && record.pending.init.resourceId === init.resourceId && record.pending.readonlyMode && isReadonlyGuest(record.guest) && (expectedUrl === undefined || !record.guest.isDestroyed() && record.guest.getURL() === expectedUrl)) || this.sleeping.get(this.key(init))?.readonlyMode === true && (expectedUrl === undefined || this.sleeping.get(this.key(init))?.restore?.url === expectedUrl)
  }
  isReloadableResource(owner: WebContents, overlayId: string, expectedUrl?: string): boolean {
    const init = this.init(owner, `tab:${overlayId}`)
    return [...this.guests.values()].some(record => {
      if (record.pending.owner !== owner || record.pending.init.resourceId !== init.resourceId || !record.pending.reloadableMode) return false
      if (expectedUrl === undefined) return true
      if (record.pending.reloadableUrl !== expectedUrl || record.guest.isDestroyed()) return false
      const nativeUrl = record.guest.getURL()
      if (nativeUrl === expectedUrl) return true
      // 关闭事务已核验并落盘后，native URL 会先变 blank，destroyed 稍后才到。
      // 此时迟到的 capture 仍须保留原契约/快照，不能把内部卸载误认成用户换页。
      return nativeUrl === 'about:blank' && !!record.operation && record.pending.restore?.suspendOperationId === record.operation && record.pending.restore.url === expectedUrl
    }) || this.sleeping.get(this.key(init))?.reloadableMode === true && (expectedUrl === undefined || this.sleeping.get(this.key(init))?.restore?.url === expectedUrl)
  }
  hostBoundary(paused = this.paused): void { this.epoch++; this.paused = paused; this.lifecycle.invalidateIdle() }
  private key(init: ResourceInit): string { return `${init.scopeId}\u0000${init.resourceId}` }
  request(owner: WebContents, request: ShelfBrowserRequest): ShelfBrowserResult {
    if (!this.enabled && request.kind === 'reloadPolicy') return { success: false, error: '网页生命周期功能已停用，当前不能更改重载策略。' }
    if (!this.enabled && request.kind === 'permit') {
      const entry = request.taskId ? this.persistence?.read(request.taskId) : undefined
      if (request.readonlyMode || entry?.recovery.kind === 'web' && entry.recovery.readonlyMode) return { success: false, error: '只读隔离需要启用网页生命周期功能。' }
    }
    if (!this.enabled) return { success: true, ...(request.kind === 'permit' ? { permitId: 'disabled' } : { state: 'unmanaged' }), deepSleepSupported: false }
    const init = this.init(owner, request.resourceId)
    if (!this.hosts.has(owner.id)) {
      this.hosts.add(owner.id)
      owner.once('destroyed', () => {
        this.hosts.delete(owner.id)
        for (const [id, pending] of this.permits) {
          if (pending.owner !== owner) continue
          this.lifecycle.abandonPermit(id, { terminationConfirmed: true, reason: 'host-exit' })
          clearTimeout(pending.timer)
          this.lifecycle.closeResource(pending.init)
          this.lifecycle.forgetClosed(pending.init)
          this.permits.delete(id)
        }
        for (const key of this.aliases.keys()) if (key.startsWith(`${owner.id}:`)) this.aliases.delete(key)
        for (const [key, pending] of this.sleeping) if (pending.owner === owner) { this.lifecycle.closeResource(pending.init); this.lifecycle.forgetClosed(pending.init); this.sleeping.delete(key) }
        for (const key of this.wake) if (key.startsWith(`window:${owner.id}\u0000`)) this.wake.delete(key)
        if (!this.hosts.size) { clearInterval(this.timer); this.timer = undefined }
      })
    }
    if (request.kind === 'reloadPolicy') {
      const record = this.guests.get(this.key(init))
      if (!record || record.guest.isDestroyed() || record.operation || record.pending.readonlyMode || record.pending.url === 'about:blank' || !record.guard || record.guest.session !== this.reloadableSession) return { success: false, error: '当前网页尚不可设置闲置重载，请等页面完成加载；POST/插件页面不支持。' }
      const url = record.guest.getURL()
      if (url !== request.url) return { success: false, error: '页面已经导航，请重新设置当前页面。' }
      if (request.enabled && !shelfWebUrl(url)) return { success: false, error: '该网址含敏感信息或不能安全重访，不支持闲置重载。' }
      try {
        if (record.pending.taskId) {
          const entry = this.persistence?.read(record.pending.taskId)
          if (!this.persistence?.setReloadable || entry?.recovery.kind !== 'web' || !entry.recovery.url) return { success: false, error: '请先重新收纳当前网页。' }
          this.persistence.setReloadable(entry.id, request.enabled ? url : entry.recovery.url, request.enabled)
        }
      } catch (error) { return { success: false, error: error instanceof Error ? error.message : '保存重载策略失败' } }
      record.pending.reloadableMode = request.enabled
      record.pending.reloadableUrl = request.enabled ? url : undefined
      record.reloadEvidence = undefined
      record.keepaliveReason = undefined
      this.hostBoundary()
      return { success: true, reloadableMode: request.enabled, deepSleepSupported: request.enabled }
    }
    if (request.kind === 'permit') {
      const sleeping = this.sleeping.get(this.key(init))
      const before = this.lifecycle.inspect(init)
      if (sleeping && !this.wake.has(this.key(init)) && !(before.ok && before.view.hasMainDemand)) return { success: false, error: 'explicit-demand-required' }
      if (sleeping && [...this.permits.values()].some(item => item.restoring)) return { success: false, error: 'restore-busy' }
      const saved = request.taskId ? this.persistence?.read(request.taskId) : undefined
      const restore = sleeping?.restore ?? (saved?.recovery.kind === 'web' ? saved.recovery.sleep : undefined)
      const readonlyMode = sleeping?.readonlyMode ?? (request.readonlyMode === true || (saved?.recovery.kind === 'web' && saved.recovery.readonlyMode === true))
      const reloadableMode = !readonlyMode && (sleeping?.reloadableMode ?? (saved?.recovery.kind === 'web' && saved.recovery.reloadableMode === true))
      const url = restore?.url ?? request.url
      if (reloadableMode && (!this.reloadableSession || !shelfWebUrl(url))) return { success: false, error: '当前重载契约不可用，请保留记录并稍后重试。' }
      if (readonlyMode && (!shelfWebUrl(url) || new URL(url).search || new URL(url).hash)) return { success: false, error: '只读副本不支持含查询参数、片段或敏感信息的网址。' }
      const demand = this.lifecycle.setDemand({ ...init, source: request.source, requestId: `create:${request.resourceId}` })
      if (!demand.ok) return { success: false, error: demand.code }
      const existing = this.lifecycle.inspect(init)
      if (existing.ok && existing.view.permitState === 'pending' && existing.view.permitId) {
        const pending = this.permits.get(existing.view.permitId)
        if (pending?.url === url) return { success: true, permitId: pending.permitId, url, partition: pending.partition, readonlyMode: pending.readonlyMode, reloadableMode: pending.reloadableMode, deepSleepSupported: !!(pending.readonlyMode || pending.reloadableMode) }
      }
      const partition = readonlyMode ? restore?.partition ?? `${READONLY_PARTITION}:${randomUUID()}` : WEBBAR_PARTITION
      if (readonlyMode && [...this.permits.values()].some(pending => pending.partition === partition)) return { success: false, error: 'readonly-partition-held' }
      if (!readonlyMode && [...this.permits.values()].some(pending => !pending.readonlyMode && !pending.attached && pending.owner === owner && pending.url === url)) return { success: false, error: '相同网址正在附着，请稍后重试。' }
      if (readonlyMode && !this.readonlyPartitions.has(partition) && this.readonlyPartitions.size >= 100) return { success: false, error: '只读分区预算已满，请重启应用后再打开新的只读副本。' }
      const created = this.lifecycle.createPermit(init)
      if (!created.ok) return { success: false, error: `网页实例仍被占用（${created.code}），请使用已有页签。` }
      const permitId = created.permit.permitId
      const timer = setTimeout(() => { this.lifecycle.expirePermit(permitId) }, 30000)
      timer.unref?.()
      if (readonlyMode) this.readonlyPartitions.add(partition)
      this.permits.set(permitId, { init, owner, url, permitId, timer, readonlyMode, reloadableMode, reloadableUrl: reloadableMode ? url : undefined, partition, taskId: sleeping?.taskId ?? request.taskId, restore, restoring: !!sleeping })
      this.sleeping.delete(this.key(init))
      this.wake.delete(this.key(init))
      return { success: true, permitId, url, partition, readonlyMode, reloadableMode, deepSleepSupported: !!(readonlyMode || reloadableMode) }
    }
    if (request.kind === 'demand') {
      for (const source of ['explicitMain', 'explicitShelf'] as const) {
        const enabled = source === 'explicitMain' ? request.main : request.shelf
        if (enabled) this.lifecycle.setDemand({ ...init, source, requestId: `display:${source}` })
        else this.lifecycle.clearDemand({ ...init, source })
      }
      if (!request.shelf) this.lifecycle.clearDemand({ ...init, source: 'bulkVisible' })
      if (!request.main && !request.shelf) this.wake.delete(this.key(init))
    }
    if (request.kind === 'wake') {
      const found = this.lifecycle.inspect(init)
      if (!found.ok) return { success: false, error: found.code }
      this.wake.add(this.key(init))
      this.lifecycle.setDemand({ ...init, source: request.source, requestId: `wake:${request.source}` })
    }
    let result = this.lifecycle.inspect(init)
    if (!result.ok) return { success: false, error: result.code }
    if (request.kind === 'presented') {
      if (request.token.scopeId !== init.scopeId || request.token.resourceId !== init.resourceId) return { success: false, error: 'owner-mismatch' }
      const geometry = this.lifecycle.recordGeometry(request.token, request)
      if (!geometry.ok) return { success: false, error: geometry.code }
      const owner = result.view.presentationOwner
      if (owner === 'none') return { success: false, error: 'demand-required' }
      const presented = this.lifecycle.recordPresentationReady(request.token, owner)
      if (!presented.ok) return { success: false, error: presented.code }
      result = this.lifecycle.inspect(init)
      if (!result.ok) return { success: false, error: result.code }
    }
    const record = this.guests.get(this.key(init))
    const readonlyMode = record?.pending.readonlyMode ?? this.sleeping.get(this.key(init))?.readonlyMode
    const reloadableMode = record?.pending.reloadableMode ?? this.sleeping.get(this.key(init))?.reloadableMode
    return { success: true, url: record?.guest.isDestroyed() === false ? record.guest.getURL() : undefined, state: result.view.state, restoreStatus: result.view.restoreStatus, presentationOwner: result.view.presentationOwner, presentationReady: request.kind === 'presented' || result.view.presentationReady, token: result.view.token, geometryRevision: result.view.geometryRevision, idleLabel: result.view.idleLabel, deepSleepSupported: !!(readonlyMode || reloadableMode), readonlyMode, reloadableMode, canRestore: result.view.hasMainDemand || this.wake.has(this.key(init)), sleepReason: result.view.suspend?.closeTimedOut ? 'close-unconfirmed' : (reloadableMode ? record?.keepaliveReason : undefined) ?? result.view.protection?.decision ?? 'unknown' }
  }
  willAttach(owner: WebContents, preferences: WebPreferences, src: string, nativeSession?: Session): boolean {
    const custom = preferences as WebPreferences & Record<string, unknown>
    const id = custom[PREF]
    delete custom[PREF]
    // 原有浏览小窗没有 resourceId，不由保存区接管其生命周期。
    preferences.additionalArguments = (preferences.additionalArguments ?? []).filter(arg => !arg.startsWith(MARKER))
    if (!this.enabled) return true
    if (id === undefined) return !(nativeSession && hasReadonlySession(nativeSession))
    if (typeof id !== 'string') return false
    const pending = this.permits.get(id)
    if (!pending || pending.owner !== owner || pending.url !== src) return false
    if (pending.readonlyMode && (!nativeSession || !hasReadonlySession(nativeSession) || preferences.partition !== pending.partition)) return false
    if (!this.lifecycle.beginAttach(id).ok) return false
    pending.attaching = true
    if (pending.readonlyMode) applyReadonlyPreferences(preferences)
    pending.session = nativeSession
    preferences.additionalArguments.push(`${MARKER}${id}`)
    return true
  }
  didAttach(owner: WebContents, guest: WebContents): void {
    if (!this.enabled) return
    if (guest.hostWebContents !== owner) return
    if (this.reloadableSession && guest.session === this.reloadableSession && !this.reloadableGuards.has(guest)) this.reloadableGuards.set(guest, new ReloadablePageGuard(guest, this.reloadableSession))
    // argv 属于 renderer 进程；Electron 复用进程时可能仍带旧 permit。
    // 只读资源用独立、原样恢复的 Session 绑定本次原生附着，再向隔离 preload 发挑战。
    const nativePending = [...this.permits.values()].find(pending => pending.readonlyMode && pending.owner === owner && pending.session === guest.session)
    // 导航错误可能早于 preload 握手；先订阅，不能把 Chromium 错误文档的握手当作成功。
    const load: { ready: boolean; finished: boolean; stopped: boolean; failed?: string } = { ready: false, finished: false, stopped: false }
    guest.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => { if (isMainFrame && !inPlace) { load.ready = false; load.finished = false; load.stopped = false; load.failed = undefined } })
    guest.on('did-fail-load', (_event, code, description, _url, isMainFrame) => { if (isMainFrame && code !== -3) load.failed = description })
    guest.on('dom-ready', () => { load.ready = true; if (nativePending) guest.send('shelf-browser:challenge', nativePending.permitId) })
    guest.on('did-finish-load', () => { load.finished = true })
    guest.on('did-stop-loading', () => { load.stopped = true })
    // nonce 只经 main 强制的 sandbox preload 回传，与原生 did-attach 的 guest 配对。
    // 不依赖 Electron 私有方法，也不接受宿主提供的裸 guest ID。
    const handshake = (event: Electron.IpcMainEvent, channel: string, ...args: unknown[]) => {
      if (channel !== 'shelf-browser:attach' || typeof args[0] !== 'string') return
      const id = args[0]
      if (nativePending && id !== nativePending.permitId) return
      const pending = this.permits.get(id)
      if (!pending || pending.owner !== owner) return
      // 正常浏览 Session 复用 renderer 时 argv 可能过代；生产环境由原生首航 URL 配对。
      if (!pending.readonlyMode && this.reloadableSession) return
      if (pending.readonlyMode && (event.senderFrame !== guest.mainFrame || typeof args[1] !== 'string' || !/^[a-f0-9]{32}$/.test(args[1]))) return
      guest.removeListener('ipc-message', handshake)
      this.attached(owner, guest, id, load, pending.readonlyMode ? args[1] as string : undefined)
    }
    guest.on('ipc-message', handshake)
    const bindNormal = (url: string) => {
      if (!this.reloadableSession || guest.session !== this.reloadableSession) return
      const matches = [...this.permits.values()].filter(item => !item.readonlyMode && item.attaching && !item.attached && item.owner === owner && item.session === guest.session && item.url === url)
      if (matches.length !== 1) return
      guest.removeListener('ipc-message', handshake)
      guest.removeListener('did-start-navigation', firstNavigation)
      guest.removeListener('dom-ready', bindLoaded)
      this.attached(owner, guest, matches[0].permitId, load)
    }
    const firstNavigation = (_event: unknown, url: string, _inPlace: boolean, main: boolean) => { if (main) bindNormal(url) }
    const bindLoaded = () => bindNormal(guest.getURL())
    guest.on('did-start-navigation', firstNavigation)
    guest.on('dom-ready', bindLoaded)
    try {
      if (!guest.isLoadingMainFrame() && guest.getURL() !== 'about:blank') load.ready = true
      const initialUrl = this.initialGuestUrls.get(guest)
      if (initialUrl) bindNormal(initialUrl)
      else bindLoaded()
    } catch { /* 首航尚无原生 URL，等其导航事件；不能猜测配对。 */ }
  }
  private attached(owner: WebContents, guest: WebContents, id: string, load: { ready: boolean; finished: boolean; stopped: boolean; failed?: string }, documentNonce?: string): void {
    const pending = this.permits.get(id)
    if (!pending || pending.owner !== owner || guest.hostWebContents !== owner) return
    const current = this.lifecycle.inspect(pending.init)
    if (!current.ok) return
    const evidence: NativeAttachEvidence = { kind: 'native-did-attach', permitId: id, guestId: String(guest.id), ...pending.init, instanceGeneration: current.view.token.instanceGeneration, navigationGeneration: current.view.token.navigationGeneration }
    this.trusted.add(evidence)
    const attached = this.lifecycle.recordAttached(evidence)
    if (!attached.ok) return
    pending.attached = true
    clearTimeout(pending.timer)
    let token = attached.token
    const record: ManagedGuest = { pending, guest, token, revision: 0, blocked: false, scrollY: 0, documentNonce, guard: this.reloadableGuards.get(guest) }
    const key = this.key(pending.init)
    this.guests.set(key, record)
    const currentUrl = guest.getURL()
    if (currentUrl && currentUrl !== 'about:blank' && currentUrl !== pending.url) {
      const navigated = this.lifecycle.recordNavigation(token, currentUrl)
      if (navigated.ok) { token = navigated.token; record.token = token }
      pending.reloadableMode = false; pending.reloadableUrl = undefined; pending.restore = undefined
    }
    if (!this.options.manualTick && !this.timer) { this.timer = setInterval(() => { void this.tick() }, 1000); this.timer.unref?.() }
    if (load.failed) this.lifecycle.recordRestoreFailed(token, load.failed)
    else if (load.ready) this.lifecycle.recordReady(token)
    const freshToken = () => { const result = this.lifecycle.inspect(pending.init); return result.ok && result.view.token.instanceGeneration === token.instanceGeneration ? result.view.token : token }
    const withdrawClose = () => {
      if (!record.operation) return
      this.lifecycle.failClose(record.operation, 'close-refused')
      record.operation = undefined
      clearTimeout(record.closeTimer)
    }
    guest.on('did-start-navigation', (_event, url, inPlace, isMainFrame) => {
      if (!isMainFrame) return
      // 自己发出的空白卸载属于已经持久保存的关闭事务，不冒充用户导航。
      if (record.operation && pending.reloadableMode && url === 'about:blank') return
      // 新导航取代卸载导航：旧 Promise/关闭回执不能再作用于新文档。
      withdrawClose()
      const beforeNavigation = this.lifecycle.inspect(pending.init)
      const result = this.lifecycle.recordNavigation(freshToken(), url)
      if (result.ok) {
        token = result.token; record.token = token
        if (!inPlace) { record.scrollY = 0; record.blocked = false }
      }
      // history/锚点只换地址，不会再触发 dom-ready；不能把现有文档永久留在 loading。
      if (result.ok && inPlace && beforeNavigation.ok && beforeNavigation.view.restoreStatus === 'ready' && !guest.isLoadingMainFrame()) this.lifecycle.recordReady(token)
      record.reloadEvidence = undefined
      if (pending.reloadableMode && url !== pending.reloadableUrl) { pending.reloadableMode = false; pending.reloadableUrl = undefined }
      if (!inPlace) record.keepaliveReason = undefined
      if (!inPlace) record.documentNonce = undefined
      if (!inPlace && pending.restore?.url !== url) pending.restore = undefined
    })
    guest.on('dom-ready', () => { if (!load.failed) this.lifecycle.recordReady(freshToken()) })
    guest.on('did-navigate', (_event, url) => {
      if (record.operation && url === 'about:blank') return
      withdrawClose()
      // HTTP 重定向不保证另发 did-start-navigation，提交后的网址仍须撤销旧许可。
      if (pending.reloadableMode && url !== pending.reloadableUrl) {
        pending.reloadableMode = false; pending.reloadableUrl = undefined
        record.reloadEvidence = undefined; record.keepaliveReason = undefined; pending.restore = undefined
      }
    })
    guest.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) this.lifecycle.recordRestoreFailed(freshToken(), description)
    })
    guest.on('render-process-gone', () => { this.lifecycle.recordRestoreFailed(freshToken(), 'renderer-gone') })
    guest.on('did-stop-loading', () => { pending.restoring = false })
    if (load.stopped) pending.restoring = false
    // DevTools 可能改写文档；关闭检查器并不证明这些修改已经撤销。
    guest.on('devtools-opened', () => { record.blocked = true; record.keepaliveReason = 'devtools-open' })
    guest.debugger?.on('detach', () => { record.blocked = true; record.keepaliveReason = 'devtools-open' })
    const restoreView = () => {
      const restore = pending.restore
      if (!restore || guest.getURL() !== restore.url) return
      if (pending.reloadableMode && record.guard) {
        if (record.restoringView) return
        record.restoringView = true
        guest.setZoomFactor(restore.zoom)
        const deadline = Date.now() + 2000
        void (async () => {
          for (const delay of [0, 150, 450]) {
            if (delay) await new Promise(resolve => setTimeout(resolve, delay))
            if (guest.isDestroyed() || pending.restore !== restore || guest.getURL() !== restore.url || Date.now() >= deadline) return
            const state = await record.guard!.snapshot()
            if (Date.now() >= deadline) return
            if (state.documentNonce && state.url === restore.url) { await record.guard!.restoreScroll(state.documentNonce, restore.scrollY); return }
          }
        })().catch(() => undefined).finally(() => { if (pending.restore === restore) pending.restore = undefined; record.restoringView = false })
        return
      }
      if (!pending.readonlyMode || !isReadonlyGuest(guest)) return
      guest.setZoomFactor(restore.zoom)
      if (record.documentNonce) guest.send('shelf-browser:scroll', { navigationNonce: record.documentNonce, y: restore.scrollY })
      pending.restore = undefined
    }
    guest.on('did-finish-load', restoreView)
    if (load.finished) restoreView()
    guest.on('will-prevent-unload', () => {
      // 不 preventDefault（Electron 中这意味着放行卸载）。意外拒绝永久撤销本导航的契约。
      record.blocked = true
      record.keepaliveReason = 'unload-prevented'
      if (record.operation) { this.lifecycle.failClose(record.operation, 'close-refused'); record.operation = undefined; clearTimeout(record.closeTimer) }
    })
    guest.on('ipc-message', (event, channel, ...args: unknown[]) => {
      if (!pending.readonlyMode || !isReadonlyGuest(guest) || event.senderFrame !== guest.mainFrame) return
      if (channel === 'shelf-browser:attach' && args[0] === id && typeof args[1] === 'string' && /^[a-f0-9]{32}$/.test(args[1])) record.documentNonce = args[1]
      if (channel === 'shelf-browser:readonly-blocked') record.blocked = true
      if (channel === 'shelf-browser:readonly-scroll' && args[0] && typeof args[0] === 'object') {
        const { y, documentNonce } = args[0] as { y?: unknown; documentNonce?: unknown }
        if (documentNonce === record.documentNonce && typeof y === 'number' && Number.isFinite(y) && y >= 0 && y <= 10_000_000) record.scrollY = y
      }
    })
    guest.once('destroyed', () => {
      clearTimeout(record.closeTimer)
      this.guests.delete(key)
      if (record.operation) {
        const confirmed = this.lifecycle.confirmSuspendDestroyed(record.operation, { resourceId: pending.init.resourceId, guestId: String(guest.id), instanceGeneration: token.instanceGeneration })
        if (confirmed.ok) { this.permits.delete(id); pending.restoring = false; this.sleeping.set(key, pending); return }
      }
      this.lifecycle.recordDestroyed({ ...pending.init, guestId: String(guest.id), instanceGeneration: token.instanceGeneration })
      this.lifecycle.closeResource(pending.init)
      this.lifecycle.forgetClosed(pending.init)
      this.wake.delete(key)
      this.permits.delete(id)
      for (const [alias, resource] of this.aliases) if (resource === pending.init.resourceId && alias.startsWith(`${owner.id}:`)) this.aliases.delete(alias)
    })
  }

  /** 五分钟仅进入候选检查；仅 main 核验的两类显式可丢弃契约可放行。 */
  async tick(): Promise<void> {
    if (this.paused || !this.enabled) return
    await Promise.all([...this.guests.values()].map(async record => {
      const { guest, pending } = record
      const readonly = pending.readonlyMode && process.env.LYSHELL_SHELF_READONLY_SLEEP !== '0'
      const reloadable = pending.reloadableMode && process.env.LYSHELL_SHELF_RELOADABLE_SLEEP !== '0' && record.guard
      if (!(readonly || reloadable) || record.busy || record.operation || !pending.taskId || !this.persistence || guest.isDestroyed()) return
      const current = this.lifecycle.inspect(pending.init)
      if (!current.ok || current.view.state !== 'live' || current.view.restoreStatus !== 'ready' || current.view.hasMainDemand || current.view.hasShelfDemand || (current.view.idleForMs ?? 0) < (this.options.deepSleepAfterMs ?? 300_000)) return
      record.busy = true
      const epoch = this.epoch
      let savingOperation: string | undefined
      try {
        record.token = current.view.token
        const protection = reloadable ? await record.guard!.snapshot() : readonlyProtection(guest)
        if (reloadable) {
          const state = protection as Awaited<ReturnType<ReloadablePageGuard['snapshot']>>
          record.reloadEvidence = state.decision === 'safe' && state.documentNonce && typeof state.url === 'string' && state.url === pending.reloadableUrl ? { documentNonce: state.documentNonce, url: state.url, checkedAt: this.clock() } : undefined
          if (typeof state.scrollY === 'number') record.scrollY = state.scrollY
        }
        const keepalive = record.blocked || !!(reloadable && this.reloadableKeepalive(guest.id))
        if (reloadable && !record.blocked) record.keepaliveReason = keepalive ? 'permission-activity' : protection.decision === 'safe' ? undefined : protection.reasonCodes[0]
        const reported = this.lifecycle.reportProtection({ ...pending.init, ...record.token, providerId: reloadable ? RELOADABLE_PROVIDER : READONLY_PROVIDER, revision: ++record.revision, decision: keepalive ? 'blocked' : protection.decision, reasonCodes: keepalive || protection.decision !== 'safe' ? ['owner-keepalive'] : [] })
        if (!reported.ok) return
        const entry = this.persistence.read(pending.taskId)
        const url = guest.getURL()
        if (!entry || entry.recovery.kind !== 'web' || !(readonly && entry.recovery.readonlyMode || reloadable && entry.recovery.reloadableMode && entry.recovery.url === url && pending.reloadableUrl === url && record.reloadEvidence) || entry.capability !== 'web' || !shelfWebUrl(url)) return
        const restore: RestoreMetadata = { taskId: entry.id, resourceId: pending.init.resourceId, url, method: 'GET', partition: pending.partition!, zoom: guest.getZoomFactor(), scrollY: record.scrollY, formatVersion: 1, recordedAt: this.clock() }
        const began = this.lifecycle.beginSuspend({ ...pending.init, policyAllowed: !this.paused && epoch === this.epoch, restore })
        if (!began.ok) return
        const operation = began.operation.operationId
        savingOperation = operation
        const metadata: ShelfWebSleep = { ...restore, formatVersion: 1, suspendOperationId: operation }
        try { await this.persistence.save(entry.id, entry.revision, metadata) }
        catch { this.lifecycle.abortSuspend(operation, 'save-failed'); return }
        const saved = this.persistence.read(entry.id)
        const rechecked = reloadable ? await record.guard!.snapshot() : readonlyProtection(guest)
        const reloadCheck = rechecked as Awaited<ReturnType<ReloadablePageGuard['snapshot']>>
        const contractValid = reloadable
          ? pending.reloadableMode && pending.reloadableUrl === url && guest.session === this.reloadableSession && !this.reloadableKeepalive(guest.id) && reloadCheck.url === url && reloadCheck.documentNonce === record.reloadEvidence?.documentNonce
          : pending.readonlyMode && isReadonlyGuest(guest)
        if (epoch !== this.epoch || this.paused || guest.isDestroyed() || !contractValid || rechecked.decision !== 'safe' || record.blocked || guest.getURL() !== url || saved?.recovery.kind !== 'web' || !(readonly && saved.recovery.readonlyMode || reloadable && saved.recovery.reloadableMode) || saved.recovery.sleep?.suspendOperationId !== operation) { this.lifecycle.abortSuspend(operation, 'cancelled'); return }
        // 保护版本不刷新；保存期间的导航/新需求由 token/epoch 复检拒绝。
        const close = this.lifecycle.commitSuspendSaved(operation)
        if (!close.ok) return
        pending.restore = metadata
        record.operation = operation
        record.closeTimer = setTimeout(() => { this.lifecycle.failClose(operation, 'close-timeout') }, this.options.closeTimeoutMs ?? 5000)
        record.closeTimer.unref?.()
        try {
          if (reloadable) requestCancellableGuestClose(guest, {
            isCurrent: () => record.operation === operation && this.guests.get(this.key(pending.init)) === record,
            refused: () => { if (record.operation !== operation) return; record.blocked = true; this.lifecycle.failClose(operation, 'close-refused'); record.operation = undefined; clearTimeout(record.closeTimer) },
            unconfirmed: () => { if (record.operation === operation) this.lifecycle.failClose(operation, 'close-timeout') },
          })
          else guest.close({ waitForBeforeUnload: true })
        }
        catch { this.lifecycle.failClose(operation, 'close-timeout') }
      } catch { if (savingOperation) this.lifecycle.abortSuspend(savingOperation, 'save-failed') }
      finally { record.busy = false }
    }))
  }
}
export const shelfBrowserRuntime = new ShelfBrowserRuntime()
