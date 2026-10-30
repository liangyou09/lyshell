// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebviewTag } from 'electron'
import type { BrowserHostSnapshot } from '@shared/browser-host'
import { applyBrowserHostPresentation, createReadonlyViewPilot, ReadonlyViewBrowserHost, releaseWebviewBrowserHost, webviewBrowserHost } from './browser-host'
function page() {
  const element = document.createElement('webview') as WebviewTag
  Object.assign(element, { loadURL: vi.fn(async () => {}), goBack: vi.fn(), goForward: vi.fn(), reload: vi.fn(), reloadIgnoringCache: vi.fn(), stop: vi.fn(), focus: vi.fn(), getURL: () => 'https://page.test/', isLoading: () => false, canGoBack: () => true, canGoForward: () => false, getWebContentsId: () => 5 })
  return element
}
const state = (revision = 1): BrowserHostSnapshot => ({ handle: { hostId: '8f06a56e-cfe4-45a1-ad09-7e1fce31a005', generation: 1, kind: 'web-contents-view' }, phase: 'created', revision, url: 'https://page.test/', loading: false, canGoBack: false, canGoForward: false, visible: false, bounds: { x: 0, y: 0, width: 0, height: 0 }, readonly: true, protection: 'safe' })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); document.body.innerHTML = '' })
describe('browser host renderer adapters', () => {
  it('reuses one proxy per live element and preserves synchronous command dispatch', async () => {
    const el = page(), host = webviewBrowserHost(el)
    expect(webviewBrowserHost(el)).toBe(host)
    const navigation = host.navigate('https://other.test/')
    expect(el.loadURL).toHaveBeenCalledWith('https://other.test/')
    await navigation; await host.back(); await host.reload(true)
    expect(el.goBack).toHaveBeenCalledOnce(); expect(el.reloadIgnoringCache).toHaveBeenCalledOnce()
    expect(host.canGoBack()).toBe(true)
    releaseWebviewBrowserHost(el)
    expect(() => host.focus()).toThrow('detached')
    expect(webviewBrowserHost(el).handle).not.toEqual(host.handle)
  })
  it('does not accept a delayed result from an unregistered element or claim DOM removal confirms native destruction', async () => {
    const el = page(), host = webviewBrowserHost(el)
    let finish!: () => void
    vi.mocked(el.loadURL).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    const navigation = host.navigate('https://other.test/')
    releaseWebviewBrowserHost(el); finish()
    await expect(navigation).rejects.toThrow('detached')
    const fresh = webviewBrowserHost(el)
    expect((await fresh.close()).phase).toBe('close-unconfirmed')
    expect((await fresh.close()).phase).toBe('close-unconfirmed')
    expect(() => fresh.focus()).toThrow('detached')
  })
  it('observes bounds and hidden state through the existing DOM layout owner', () => {
    const wrapper = document.createElement('div'), el = page()
    wrapper.append(el); document.body.append(wrapper)
    applyBrowserHostPresentation(wrapper, { visibility: 'hidden', width: '120px', height: '60px' })
    expect(webviewBrowserHost(el).snapshot().visible).toBe(false)
    expect(wrapper.style.width).toBe('120px')
    applyBrowserHostPresentation(wrapper, { visibility: 'visible' })
    expect(webviewBrowserHost(el).snapshot().visible).toBe(true)
  })
  it('does not create a native host when the internal pilot is unavailable', async () => {
    const request = vi.fn(async () => ({ success: true, pilotEnabled: false }))
    Object.defineProperty(window, 'electronAPI', { value: { browserHostRequest: request }, configurable: true })
    expect(await createReadonlyViewPilot('https://page.test/')).toBeUndefined()
    expect(request.mock.calls).toEqual([[{ kind: 'capabilities' }]])
  })
  it('rejects stale generations and ignores out-of-order snapshots within one host', async () => {
    const request = vi.fn()
    Object.defineProperty(window, 'electronAPI', { value: { browserHostRequest: request }, configurable: true })
    const host = new ReadonlyViewBrowserHost(state(10))
    request.mockResolvedValueOnce({ success: true, snapshot: { ...state(8), url: 'https://old.test/' } })
    await host.inspect(); expect(host.snapshot().url).toBe('https://page.test/')
    request.mockResolvedValueOnce({ success: true, snapshot: { ...state(11), handle: { ...state().handle, generation: 2 } } })
    await expect(host.inspect()).rejects.toThrow('generation')
    host.dispose()
  })
  it('keeps only one inspect in flight and cleans polling listeners on disposal', async () => {
    vi.useFakeTimers()
    let finish!: (result: unknown) => void
    const request = vi.fn(() => new Promise(resolve => { finish = resolve }))
    Object.defineProperty(window, 'electronAPI', { value: { browserHostRequest: request }, configurable: true })
    const host = new ReadonlyViewBrowserHost(state()), listener = vi.fn()
    host.subscribe(listener)
    await vi.advanceTimersByTimeAsync(2000)
    expect(request).toHaveBeenCalledOnce()
    host.dispose(); finish({ success: true, snapshot: state(2) })
    await vi.advanceTimersByTimeAsync(2000)
    expect(request).toHaveBeenCalledOnce(); expect(listener).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(() => host.subscribe(listener)).toThrow('detached')
    expect(vi.getTimerCount()).toBe(0)
  })
  it('shares concurrent close, releases subscriptions and rejects late polls or new operations after closed', async () => {
    vi.useFakeTimers()
    let finishPoll!: (result: unknown) => void, finishClose!: (result: unknown) => void
    const request = vi.fn((value: { kind: string }) => new Promise(resolve => {
      if (value.kind === 'close') finishClose = resolve
      else finishPoll = resolve
    }))
    Object.defineProperty(window, 'electronAPI', { value: { browserHostRequest: request }, configurable: true })
    const host = new ReadonlyViewBrowserHost(state()), listener = vi.fn()
    host.subscribe(listener)
    await vi.advanceTimersByTimeAsync(500)
    const first = host.close(), repeated = host.close()
    expect(first).toBe(repeated)
    expect(vi.getTimerCount()).toBe(0)
    finishClose({ success: true, snapshot: { ...state(3), phase: 'closed' } })
    expect((await first).phase).toBe('closed')
    finishPoll({ success: true, snapshot: { ...state(100), url: 'https://late.test/' } })
    await vi.advanceTimersByTimeAsync(2000)
    expect(listener).not.toHaveBeenCalled()
    expect(host.snapshot()).toMatchObject({ phase: 'closed', url: 'https://page.test/' })
    expect(host.close()).toBe(first)
    await expect(host.inspect()).rejects.toThrow('detached')
    await expect(host.navigate('https://other.test/')).rejects.toThrow('detached')
    expect(() => host.subscribe(listener)).toThrow('detached')
    expect(request).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
    const alreadyClosed = new ReadonlyViewBrowserHost({ ...state(4), phase: 'closed' })
    const cached = alreadyClosed.close()
    expect(alreadyClosed.close()).toBe(cached)
    expect((await cached).phase).toBe('closed')
    expect(request).toHaveBeenCalledTimes(2)
  })
  it('keeps closed evidence but suppresses all notification when dispose occurs during close', async () => {
    let finishClose!: (result: unknown) => void
    const request = vi.fn(() => new Promise(resolve => { finishClose = resolve }))
    Object.defineProperty(window, 'electronAPI', { value: { browserHostRequest: request }, configurable: true })
    const host = new ReadonlyViewBrowserHost(state()), listener = vi.fn()
    host.subscribe(listener)
    const closed = host.close()
    host.dispose()
    finishClose({ success: true, snapshot: { ...state(2), phase: 'closed' } })
    expect((await closed).phase).toBe('closed')
    expect((await host.close()).phase).toBe('closed')
    expect(listener).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledOnce()
  })
  it('allows an explicit close reconciliation after an unconfirmed result', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ success: true, snapshot: { ...state(2), phase: 'close-unconfirmed' } })
      .mockResolvedValueOnce({ success: true, snapshot: { ...state(3), phase: 'closed' } })
    Object.defineProperty(window, 'electronAPI', { value: { browserHostRequest: request }, configurable: true })
    const host = new ReadonlyViewBrowserHost(state())
    expect((await host.close()).phase).toBe('close-unconfirmed')
    expect((await host.close()).phase).toBe('closed')
    expect((await host.close()).phase).toBe('closed')
    expect(request).toHaveBeenCalledTimes(2)
  })

})

it('rejects an old capture reply delivered after a newer navigation snapshot', async () => {
  let finishCapture!: (result: unknown) => void
  const request = vi.fn((value: { kind: string }) => value.kind === 'capture'
    ? new Promise(resolve => { finishCapture = resolve })
    : Promise.resolve({ success: true, snapshot: { ...state(3), url: 'https://new.test/' } }))
  Object.defineProperty(window, 'electronAPI', { value: { browserHostRequest: request }, configurable: true })
  const host = new ReadonlyViewBrowserHost(state())
  const captured = host.capture()
  await host.navigate('https://new.test/')
  finishCapture({ success: true, snapshot: state(2), image: 'data:image/png;base64,old-document' })
  try {
    await expect(captured).rejects.toThrow('changed')
    expect(host.snapshot().url).toBe('https://new.test/')
  } finally { host.dispose() }
})
