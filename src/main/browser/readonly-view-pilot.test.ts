import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { WebPreferences } from 'electron'
const mocks = vi.hoisted(() => ({
  views: [] as Array<{ webContents: { emit: (event: string, ...args: unknown[]) => boolean; capturePage: Mock<[], Promise<{ toDataURL: () => string }>> }; visible: boolean }>,
  preferences: undefined as WebPreferences | undefined,
  partitions: [] as string[],
  owner: {} as object,
  children: [] as object[]
}))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('events')
  class Page extends EventEmitter {
    session: unknown
    private destroyed = false
    private url = ''
    debugger = { isAttached: () => false }
    navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack: () => {}, goForward: () => {} }
    constructor(private preferences: WebPreferences) { super(); this.session = preferences.session }
    isDestroyed() { return this.destroyed }
    getLastWebPreferences() { return this.preferences }
    getURL() { return this.url }
    isLoading() { return false }
    isLoadingMainFrame() { return false }
    isCurrentlyAudible() { return false }
    isCrashed() { return false }
    isDevToolsOpened() { return false }
    setWindowOpenHandler() {}
    async loadURL(url: string) { this.url = url }
    reload() {}
    reloadIgnoringCache() {}
    stop() {}
    focus() {}
    capturePage = vi.fn<[], Promise<{ toDataURL: () => string }>>(async () => ({ toDataURL: () => 'data:image/png;base64,AA==' }))
    close() { this.destroyed = true; this.emit('destroyed') }
  }
  class NativeView {
    webContents: Page
    visible = false
    bounds = { x: 0, y: 0, width: 0, height: 0 }
    constructor({ webPreferences }: { webPreferences: WebPreferences }) { mocks.preferences = webPreferences; this.webContents = new Page(webPreferences); mocks.views.push(this) }
    setVisible(visible: boolean) { this.visible = visible }
    getVisible() { return this.visible }
    setBounds(bounds: typeof this.bounds) { this.bounds = bounds }
    getBounds() { return this.bounds }
  }
  return {
    WebContentsView: NativeView,
    BrowserWindow: { fromWebContents: (sender: object) => ({ webContents: mocks.owner, isDestroyed: () => false, getContentSize: () => [400, 300], contentView: { get children() { return mocks.children }, addChildView: (view: object) => { mocks.children.push(view) }, removeChildView: (view: object) => { mocks.children = mocks.children.filter(item => item !== view) } }, sender }) },
    session: { fromPartition: (partition: string) => {
      mocks.partitions.push(partition)
      return { webRequest: { onBeforeRequest: vi.fn(), onHeadersReceived: vi.fn() }, isPersistent: () => false, setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), setDevicePermissionHandler: vi.fn(), setDisplayMediaRequestHandler: vi.fn(), setSpellCheckerEnabled: vi.fn(), on: vi.fn() }
    } }
  }
})
import { createReadonlyViewPilotPort } from './readonly-view-pilot'
afterEach(() => { vi.useRealTimers() })
describe('readonly WebContentsView pilot native adapter', () => {
  beforeEach(() => { mocks.views = []; mocks.partitions = []; mocks.children = []; mocks.owner = {} })
  it('uses a fresh hardened memory session and only the bundled readonly preload', async () => {
    const port = createReadonlyViewPilotPort({ sender: mocks.owner, document: {} })
    expect(mocks.partitions[0]).toMatch(/^shelf-readonly-v1:[a-f0-9-]{36}$/)
    expect(mocks.preferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, webSecurity: true, allowRunningInsecureContent: false })
    expect(mocks.preferences?.preload).toMatch(/[\\/]preload[\\/]shelfReadonly\.js$/)
    expect(port.verified()).toBe(true)
    await port.navigate('https://page.test/')
    expect(port.state().protection).toBe('safe')
    const blocked = { preventDefault: vi.fn() }
    mocks.views[0].webContents.emit('will-navigate', blocked, 'https://page.test/?secret=value')
    expect(blocked.preventDefault).toHaveBeenCalledOnce()
    port.attach(); port.setBounds({ x: 350, y: 250, width: 100, height: 100 }); port.setVisible(true)
    expect(port.state()).toMatchObject({ visible: true, bounds: { x: 350, y: 250, width: 50, height: 50 } })
    expect(port.detached()).toBe(false)
    const events: string[] = [], unsubscribe = port.subscribe(event => events.push(event))
    mocks.views[0].webContents.emit('preload-error')
    expect(events).toContain('crashed'); expect(port.state().visible).toBe(false)
    port.detach(); expect(port.detached()).toBe(true)
    port.close(); expect(port.destroyed()).toBe(true); expect(events).toContain('destroyed')
    unsubscribe()
  })

  it('retries an initial native surface failure once after 150ms and returns the next capture', async () => {
    vi.useFakeTimers()
    const port = createReadonlyViewPilotPort({ sender: mocks.owner, document: {} })
    const page = mocks.views[0].webContents
    page.capturePage.mockRejectedValueOnce(new Error('UnknownVizError'))
    const capture = port.capture()
    const completed = expect(capture).resolves.toBe('data:image/png;base64,AA==')
    await vi.advanceTimersByTimeAsync(149)
    expect(page.capturePage).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    await completed
    expect(page.capturePage).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('caps a persistently failing capture at two attempts with a fixed public retryable error', async () => {
    vi.useFakeTimers()
    const port = createReadonlyViewPilotPort({ sender: mocks.owner, document: {} })
    const page = mocks.views[0].webContents
    page.capturePage.mockRejectedValue(new Error('UnknownVizError with internal fixture details'))
    const completed = expect(port.capture()).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT', message: 'The browser preview is not ready', retryDisposition: 'safe'
    })
    await vi.advanceTimersByTimeAsync(1000)
    await completed
    expect(page.capturePage).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does not call capturePage again if the host is destroyed during the retry delay', async () => {
    vi.useFakeTimers()
    const port = createReadonlyViewPilotPort({ sender: mocks.owner, document: {} })
    const page = mocks.views[0].webContents
    page.capturePage.mockRejectedValueOnce(new Error('UnknownVizError'))
    const completed = expect(port.capture()).rejects.toMatchObject({ code: 'STALE_GENERATION' })
    await vi.advanceTimersByTimeAsync(0)
    expect(page.capturePage).toHaveBeenCalledOnce()
    port.close()
    await vi.advanceTimersByTimeAsync(150)
    await completed
    expect(page.capturePage).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects a caller whose native window does not own the sender', () => {
    expect(() => createReadonlyViewPilotPort({ sender: {}, document: {} })).toThrow('application window')
    expect(mocks.views).toHaveLength(0)
  })
})
