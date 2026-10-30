import type { WebviewTag } from 'electron'
import type { BrowserHostBounds, BrowserHostClient, BrowserHostHandle, BrowserHostResult, BrowserHostSnapshot } from '@shared/browser-host'

let localSequence = 0
const webviewHosts = new WeakMap<WebviewTag, WebviewBrowserHost>()
/** 现有 DOM webview 的代理；保留 guest，不因注册/页签移动重建实例。 */
export class WebviewBrowserHost implements BrowserHostClient {
  readonly handle: BrowserHostHandle = { hostId: 'webview:' + ++localSequence, generation: 1, kind: 'webview' }
  private disposed = false
  private closeSnapshot?: BrowserHostSnapshot
  private phase: BrowserHostSnapshot['phase'] = 'attached'
  private revision = 1
  private presentation?: { bounds: BrowserHostBounds; visible: boolean }
  constructor(readonly page: WebviewTag) {}
  private assertCurrent(): void { if (this.disposed || this.closeSnapshot) throw new Error('The browser host proxy is detached') }
  private call(task: () => unknown): Promise<void> {
    this.assertCurrent()
    // 先调用原方法，保留现有按钮/快捷键的同步派发顺序。
    const result = task()
    return Promise.resolve(result).then(() => { this.assertCurrent(); this.revision++ })
  }
  navigate(url: string): Promise<void> { return this.call(() => this.page.loadURL(url)) }
  back(): Promise<void> { return this.call(() => this.page.goBack()) }
  forward(): Promise<void> { return this.call(() => this.page.goForward()) }
  reload(ignoreCache = false): Promise<void> { return this.call(() => ignoreCache ? this.page.reloadIgnoringCache() : this.page.reload()) }
  stop(): Promise<void> { return this.call(() => this.page.stop()) }
  focus(): void { this.assertCurrent(); this.page.focus() }
  getURL(): string { this.assertCurrent(); return this.page.getURL() }
  isLoading(): boolean { this.assertCurrent(); return this.page.isLoading() }
  canGoBack(): boolean { this.assertCurrent(); return this.page.canGoBack() }
  canGoForward(): boolean { this.assertCurrent(); return this.page.canGoForward() }
  contentsId(): number { this.assertCurrent(); return this.page.getWebContentsId() }
  observePresentation(target: HTMLElement): void {
    this.assertCurrent()
    const rect = target.getBoundingClientRect()
    this.presentation = { bounds: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }, visible: target.style.visibility !== 'hidden' && !target.hidden }
    this.revision++
  }
  snapshot(): BrowserHostSnapshot {
    if (this.closeSnapshot) return { ...this.closeSnapshot, handle: { ...this.closeSnapshot.handle }, bounds: { ...this.closeSnapshot.bounds } }
    this.assertCurrent()
    const rect = this.page.getBoundingClientRect()
    return { handle: { ...this.handle }, phase: this.phase, revision: this.revision, url: this.getURL(), loading: this.isLoading(), canGoBack: this.canGoBack(), canGoForward: this.canGoForward(), bounds: this.presentation?.bounds ?? { x: rect.left, y: rect.top, width: rect.width, height: rect.height }, visible: this.presentation?.visible ?? this.page.style.visibility !== 'hidden', readonly: false, protection: 'unknown' }
  }
  async capture(): Promise<string> { this.assertCurrent(); const result = await this.page.capturePage(); this.assertCurrent(); return result.toDataURL() }
  /** renderer 移除元素不等于获得主进程 destroyed 证据，绝不报告关闭已确认。 */
  async close(): Promise<BrowserHostSnapshot> {
    if (this.closeSnapshot) return this.snapshot()
    const before = this.snapshot()
    this.page.remove(); this.phase = 'close-unconfirmed'; this.revision++
    this.closeSnapshot = { ...before, phase: this.phase, revision: this.revision, visible: false }
    return this.snapshot()
  }
  dispose(): void { this.disposed = true; this.phase = 'detached'; this.revision++ }
  get active(): boolean { return !this.disposed }
}
export function webviewBrowserHost(page: WebviewTag): WebviewBrowserHost {
  let host = webviewHosts.get(page)
  if (!host?.active) { host = new WebviewBrowserHost(page); webviewHosts.set(page, host) }
  return host
}
export function releaseWebviewBrowserHost(page: WebviewTag): void { webviewHosts.get(page)?.dispose(); webviewHosts.delete(page) }
/** 保持原 DOM/CSS 布局操作，同时将 bounds/visibility 观测归入宿主代理。 */
export function applyBrowserHostPresentation(target: HTMLElement, style: object): void {
  Object.assign(target.style, style)
  const page = target.querySelector('webview') as WebviewTag | null
  if (page) webviewBrowserHost(page).observePresentation(target)
}

function unwrap(result: BrowserHostResult): { snapshot?: BrowserHostSnapshot; image?: string } {
  if (!result.success) throw new Error(result.error)
  return result
}
/** 专用只读试点代理。原生对象、分区、preload 路径从不进入 renderer。 */
export class ReadonlyViewBrowserHost implements BrowserHostClient {
  private snapshotValue: BrowserHostSnapshot
  private disposed = false
  private closing = false
  private closePromise?: Promise<BrowserHostSnapshot>
  private operationEpoch = 0
  private listeners = new Set<(snapshot: BrowserHostSnapshot) => void>()
  private timer?: ReturnType<typeof setInterval>
  private polling = false
  constructor(snapshot: BrowserHostSnapshot) { this.snapshotValue = snapshot }
  get handle(): BrowserHostHandle { return { ...this.snapshotValue.handle } }
  snapshot(): BrowserHostSnapshot { return { ...this.snapshotValue, bounds: { ...this.snapshotValue.bounds }, handle: this.handle } }
  private stopObserving(): void { clearInterval(this.timer); this.timer = undefined; this.listeners.clear() }
  private assertAvailable(): void {
    if (this.disposed || this.closing || this.snapshotValue.phase === 'closed') throw new Error('The browser host proxy is detached')
  }
  private async request(request: Exclude<Parameters<typeof window.electronAPI.browserHostRequest>[0], { kind: 'capabilities' | 'create-readonly-pilot' }>, closingRequest = false): Promise<{ snapshot?: BrowserHostSnapshot; image?: string }> {
    if (!closingRequest) this.assertAvailable()
    const epoch = this.operationEpoch
    const result = unwrap(await window.electronAPI.browserHostRequest(request))
    // close/dispose 使旧观察回合失效；迟到的 poll/动作结果不能重新推送或覆盖终态。
    if (!closingRequest && (this.disposed || this.closing || epoch !== this.operationEpoch)) throw new Error('The browser host proxy is detached')
    const snapshot = result.snapshot
    if (snapshot && (snapshot.handle.hostId !== this.handle.hostId || snapshot.handle.generation !== this.handle.generation || snapshot.handle.kind !== this.handle.kind)) throw new Error('The browser host generation has changed')
    // 快照本身可忽略旧 revision，但截图内容不能以新文档的状态返回。
    if (request.kind === 'capture' && snapshot && snapshot.revision < this.snapshotValue.revision) throw new Error('The browser changed before preview capture was delivered')
    if (snapshot && snapshot.revision >= this.snapshotValue.revision) {
      this.snapshotValue = snapshot
      if (snapshot.phase === 'closed') { this.operationEpoch++; this.stopObserving() }
      else if (!this.disposed && !this.closing) for (const listener of this.listeners) listener(this.snapshot())
    }
    return result
  }
  async inspect(): Promise<BrowserHostSnapshot> { await this.request({ kind: 'inspect', host: this.handle }); return this.snapshot() }
  async attach(): Promise<void> { await this.request({ kind: 'attach', host: this.handle }) }
  async detach(): Promise<void> { await this.request({ kind: 'detach', host: this.handle }) }
  async navigate(url: string): Promise<void> { await this.request({ kind: 'navigate', host: this.handle, url }) }
  async back(): Promise<void> { await this.request({ kind: 'back', host: this.handle }) }
  async forward(): Promise<void> { await this.request({ kind: 'forward', host: this.handle }) }
  async reload(ignoreCache = false): Promise<void> { await this.request({ kind: 'reload', host: this.handle, ignoreCache }) }
  async stop(): Promise<void> { await this.request({ kind: 'stop', host: this.handle }) }
  async focus(): Promise<void> { await this.request({ kind: 'focus', host: this.handle }) }
  async setBounds(bounds: BrowserHostBounds): Promise<void> { await this.request({ kind: 'bounds', host: this.handle, bounds }) }
  async setVisible(visible: boolean): Promise<void> { await this.request({ kind: 'visibility', host: this.handle, visible }) }
  async capture(): Promise<string | undefined> { return (await this.request({ kind: 'capture', host: this.handle })).image }
  close(): Promise<BrowserHostSnapshot> {
    if (this.closePromise) return this.closePromise
    if (this.snapshotValue.phase === 'closed') { this.closePromise = Promise.resolve(this.snapshot()); return this.closePromise }
    if (this.disposed) return Promise.reject(new Error('The browser host proxy is detached'))
    this.closing = true; this.operationEpoch++; this.stopObserving()
    this.closePromise = this.request({ kind: 'close', host: this.handle }, true).then(() => this.snapshot()).finally(() => {
      this.closing = false
      // 未确认关闭或请求失败允许显式再次核对；确认 closed 后保留同一完成回执。
      if (this.snapshotValue.phase !== 'closed') this.closePromise = undefined
    })
    return this.closePromise
  }
  subscribe(listener: (snapshot: BrowserHostSnapshot) => void): () => void {
    this.assertAvailable()
    this.listeners.add(listener)
    if (!this.timer) this.timer = setInterval(() => {
      if (this.polling || this.disposed || this.closing || this.snapshotValue.phase === 'closed') return
      this.polling = true
      void this.inspect().catch(() => undefined).finally(() => { this.polling = false })
    }, 500)
    return () => { this.listeners.delete(listener); if (!this.listeners.size) { clearInterval(this.timer); this.timer = undefined } }
  }
  dispose(): void { this.disposed = true; this.operationEpoch++; this.stopObserving() }
}
/** 只有显式调用才创建；capabilities=false 时不会发出创建请求或改变既有网页宿主。 */
export async function createReadonlyViewPilot(url: string): Promise<ReadonlyViewBrowserHost | undefined> {
  if (!window.electronAPI?.browserHostRequest) return undefined
  const capability = await window.electronAPI.browserHostRequest({ kind: 'capabilities' })
  if (!capability.success || !capability.pilotEnabled) return undefined
  const result = unwrap(await window.electronAPI.browserHostRequest({ kind: 'create-readonly-pilot', url }))
  if (!result.snapshot) throw new Error('The browser host did not return its identity')
  return new ReadonlyViewBrowserHost(result.snapshot)
}
