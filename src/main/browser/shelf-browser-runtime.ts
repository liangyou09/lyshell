import type { WebContents, WebPreferences } from 'electron'
import { ShelfResourceLifecycle, type NativeAttachEvidence, type ResourceInit } from './shelf-resource-lifecycle'
import type { ShelfBrowserRequest, ShelfBrowserResult } from '@shared/shelf-browser'

const MARKER = '--lyshell-shelf-permit='
const PREF = 'lyshellCreatePermit'
interface Pending {
  init: ResourceInit
  owner: WebContents
  url: string
  permitId: string
  timer: ReturnType<typeof setTimeout>
}
/** 原生附着事件是实例身份的唯一来源；不接受 renderer 上报的 webContents ID。 */
export class ShelfBrowserRuntime {
  constructor(private readonly enabled = process.env.LYSHELL_SHELF_BROWSER_LIFECYCLE !== '0') {}
  private readonly trusted = new WeakSet<object>()
  readonly lifecycle = new ShelfResourceLifecycle({
    safeCloseSupported: false,
    verifyNativeAttach: evidence => typeof evidence === 'object' && evidence !== null && this.trusted.has(evidence) ? evidence as NativeAttachEvidence : null
  })
  private readonly permits = new Map<string, Pending>()
  private readonly aliases = new Map<string, string>()
  private readonly hosts = new Set<number>()
  private init(owner: WebContents, resourceId: string): ResourceInit {
    return { scopeId: `window:${owner.id}`, resourceId: this.aliases.get(`${owner.id}:${resourceId}`) ?? resourceId, ownerId: String(owner.id) }
  }
  bindTask(owner: WebContents, taskId: string, overlayId: string): void {
    const init = this.init(owner, `tab:${overlayId}`)
    if (this.lifecycle.inspect(init).ok) this.aliases.set(`${owner.id}:saved:${taskId}`, init.resourceId)
  }
  unbindTask(owner: WebContents, taskId: string): void { this.aliases.delete(`${owner.id}:saved:${taskId}`) }
  request(owner: WebContents, request: ShelfBrowserRequest): ShelfBrowserResult {
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
      })
    }
    if (request.kind === 'permit') {
      const demand = this.lifecycle.setDemand({ ...init, source: request.source, requestId: `create:${request.resourceId}` })
      if (!demand.ok) return { success: false, error: demand.code }
      const existing = this.lifecycle.inspect(init)
      if (existing.ok && existing.view.permitState === 'pending' && existing.view.permitId) {
        const pending = this.permits.get(existing.view.permitId)
        if (pending?.url === request.url) return { success: true, permitId: pending.permitId, deepSleepSupported: false }
      }
      const created = this.lifecycle.createPermit(init)
      if (!created.ok) return { success: false, error: `网页实例仍被占用（${created.code}），请使用已有页签。` }
      const permitId = created.permit.permitId
      const timer = setTimeout(() => { this.lifecycle.expirePermit(permitId) }, 30000)
      timer.unref?.()
      this.permits.set(permitId, { init, owner, url: request.url, permitId, timer })
      return { success: true, permitId, deepSleepSupported: false }
    }
    if (request.kind === 'demand') {
      for (const source of ['explicitMain', 'explicitShelf'] as const) {
        const enabled = source === 'explicitMain' ? request.main : request.shelf
        if (enabled) this.lifecycle.setDemand({ ...init, source, requestId: `display:${source}` })
        else this.lifecycle.clearDemand({ ...init, source })
      }
      if (!request.shelf) this.lifecycle.clearDemand({ ...init, source: 'bulkVisible' })
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
    return { success: true, state: result.view.state, restoreStatus: result.view.restoreStatus, presentationOwner: result.view.presentationOwner, presentationReady: request.kind === 'presented' || result.view.presentationReady, token: result.view.token, geometryRevision: result.view.geometryRevision, idleLabel: result.view.idleLabel, deepSleepSupported: false }
  }
  willAttach(owner: WebContents, preferences: WebPreferences, src: string): boolean {
    const custom = preferences as WebPreferences & Record<string, unknown>
    const id = custom[PREF]
    delete custom[PREF]
    // 原有浏览小窗没有 resourceId，不由保存区接管其生命周期。
    preferences.additionalArguments = (preferences.additionalArguments ?? []).filter(arg => !arg.startsWith(MARKER))
    if (!this.enabled) return true
    if (id === undefined) return true
    if (typeof id !== 'string') return false
    const pending = this.permits.get(id)
    if (!pending || pending.owner !== owner || pending.url !== src) return false
    if (!this.lifecycle.beginAttach(id).ok) return false
    preferences.additionalArguments.push(`${MARKER}${id}`)
    return true
  }
  didAttach(owner: WebContents, guest: WebContents): void {
    if (!this.enabled) return
    if (guest.hostWebContents !== owner) return
    // 导航错误可能早于 preload 握手；先订阅，不能把 Chromium 错误文档的握手当作成功。
    const load: { ready: boolean; failed?: string } = { ready: false }
    guest.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => { if (isMainFrame && !inPlace) { load.ready = false; load.failed = undefined } })
    guest.on('did-fail-load', (_event, code, description, _url, isMainFrame) => { if (isMainFrame && code !== -3) load.failed = description })
    guest.on('dom-ready', () => { load.ready = true })
    // nonce 只经 main 强制的 sandbox preload 回传，与原生 did-attach 的 guest 配对。
    // 不依赖 Electron 私有方法，也不接受宿主提供的裸 guest ID。
    const handshake = (_event: Electron.Event, channel: string, ...args: unknown[]) => {
      if (channel !== 'shelf-browser:attach' || typeof args[0] !== 'string') return
      const id = args[0]
      const pending = this.permits.get(id)
      if (!pending || pending.owner !== owner) return
      guest.removeListener('ipc-message', handshake)
      this.attached(owner, guest, id, load)
    }
    guest.on('ipc-message', handshake)
  }
  private attached(owner: WebContents, guest: WebContents, id: string, load: { ready: boolean; failed?: string }): void {
    const pending = this.permits.get(id)
    if (!pending || pending.owner !== owner || guest.hostWebContents !== owner) return
    const current = this.lifecycle.inspect(pending.init)
    if (!current.ok) return
    const evidence: NativeAttachEvidence = { kind: 'native-did-attach', permitId: id, guestId: String(guest.id), ...pending.init, instanceGeneration: current.view.token.instanceGeneration, navigationGeneration: current.view.token.navigationGeneration }
    this.trusted.add(evidence)
    const attached = this.lifecycle.recordAttached(evidence)
    if (!attached.ok) return
    clearTimeout(pending.timer)
    let token = attached.token
    if (load.failed) this.lifecycle.recordRestoreFailed(token, load.failed)
    else if (load.ready) this.lifecycle.recordReady(token)
    const freshToken = () => { const result = this.lifecycle.inspect(pending.init); return result.ok ? result.view.token : token }
    guest.on('did-start-navigation', (_event, url, inPlace, isMainFrame) => {
      if (!isMainFrame || inPlace) return
      const result = this.lifecycle.recordNavigation(freshToken(), url)
      if (result.ok) token = result.token
    })
    guest.on('dom-ready', () => { if (!load.failed) this.lifecycle.recordReady(freshToken()) })
    guest.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) this.lifecycle.recordRestoreFailed(freshToken(), description)
    })
    guest.on('render-process-gone', () => { this.lifecycle.recordRestoreFailed(freshToken(), 'renderer-gone') })
    guest.once('destroyed', () => {
      this.lifecycle.recordDestroyed({ ...pending.init, guestId: String(guest.id), instanceGeneration: token.instanceGeneration })
      this.lifecycle.closeResource(pending.init)
      this.lifecycle.forgetClosed(pending.init)
      this.permits.delete(id)
      for (const [alias, resource] of this.aliases) if (resource === pending.init.resourceId && alias.startsWith(`${owner.id}:`)) this.aliases.delete(alias)
    })
  }
}
export const shelfBrowserRuntime = new ShelfBrowserRuntime()
