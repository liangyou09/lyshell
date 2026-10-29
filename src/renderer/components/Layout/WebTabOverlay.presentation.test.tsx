// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { WebTabOverlay } from './WebTabLayer'
import { usePaneStore } from '../../stores/pane-store'
import '../../i18n'

vi.mock('./task-shelf-web-frame', () => ({
  openShelfWebPreview: () => ({ release: vi.fn() }),
  refreshShelfWebPreview: async () => ({ image: 'data:image/png;base64,fixture', width: 800, height: 600 })
}))
vi.mock('../Search/SearchableTab', () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('保存网页首帧输入门槛', () => {
  it('重载契约的内部空白提交不覆盖保存地址，真实 HTTP 导航仍同步', async () => {
    const previous = usePaneStore.getState().setWebTabNav
    const update = vi.fn()
    usePaneStore.setState({ setWebTabNav: update })
    try {
      await act(async () => { render(<WebTabOverlay id="internal-unload" url="https://fixture.test/read" unmanaged reloadableMode />) })
      const page = document.querySelector('webview')!
      act(() => { page.dispatchEvent(Object.assign(new Event('did-navigate'), { url: 'about:blank', isMainFrame: true })) })
      expect(update).not.toHaveBeenCalled()
      act(() => { page.dispatchEvent(Object.assign(new Event('did-navigate'), { url: 'https://fixture.test/next', isMainFrame: true })) })
      expect(update).toHaveBeenCalledWith('internal-unload', { url: 'https://fixture.test/next' })
    } finally { usePaneStore.setState({ setWebTabNav: previous }) }
  })
  it.each([
    { name: '未附着', guestId: 0, url: 'https://fixture.test/', loading: false },
    { name: '仍在加载', guestId: 7, url: 'https://fixture.test/', loading: true },
    { name: '空白引导页', guestId: 7, url: 'about:blank', loading: false },
  ])('$name 不能补认首帧或放行输入', async ({ guestId, url, loading }) => {
    vi.useFakeTimers()
    const previous = window.electronAPI
    const createElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation(tag => {
      const element = createElement(tag)
      if (tag === 'webview') Object.assign(element, {
        getWebContentsId: () => guestId, getURL: () => url, isLoading: () => loading,
      })
      return element
    })
    const request = vi.fn().mockResolvedValue({ success: true, permitId: 'fixture-permit', deepSleepSupported: false })
    window.electronAPI = { ...previous, shelfBrowserRequest: request }
    try {
      await act(async () => { render(<WebTabOverlay id="not-ready" url="https://fixture.test/" shelfTaskId="saved-fixture" />) })
      await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
      expect(document.querySelector('webview')!.hasAttribute('inert')).toBe(true)
      expect(request.mock.calls.some(([input]) => input.kind === 'presented')).toBe(false)
    } finally { window.electronAPI = previous }
  })
  it.each([false, true])('错过 dom-ready 时补认首帧（监听安装时仍加载=%s）', async loadingAtInstall => {
    vi.useFakeTimers()
    let loading = loadingAtInstall
    const previous = window.electronAPI
    const createElement = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation(tag => {
      const element = createElement(tag)
      if (tag === 'webview') Object.assign(element, {
        getWebContentsId: () => 7,
        getURL: () => 'https://fixture.test/',
        isLoading: () => loading,
      })
      return element
    })
    const request = vi.fn().mockImplementation(async input => input.kind === 'permit'
      ? { success: true, permitId: 'fixture-permit', deepSleepSupported: false }
      : { success: true, state: 'live', token: { bootId: 'boot', resourceId: 'saved:saved-fixture', instanceGeneration: 1, navigationGeneration: 1 }, geometryRevision: 0 })
    window.electronAPI = { ...previous, shelfBrowserRequest: request }
    try {
      await act(async () => { render(<WebTabOverlay id="already-loaded" url="https://fixture.test/" shelfTaskId="saved-fixture" />) })
      if (loadingAtInstall) {
        loading = false
        act(() => { document.querySelector('webview')!.dispatchEvent(new Event('did-stop-loading')) })
      }
      await act(async () => { await vi.advanceTimersByTimeAsync(200) })
      expect(request.mock.calls.some(([input]) => input.kind === 'presented')).toBe(true)
      expect(document.querySelector('webview')!.hasAttribute('inert')).toBe(false)
    } finally { window.electronAPI = previous }
  })
  it('截图成功但原生实例核验失败时保持禁用，用户可显式显示当前页面', async () => {
    vi.useFakeTimers()
    const previous = window.electronAPI
    const request = vi.fn().mockImplementation(async input => input.kind === 'permit'
      ? { success: true, permitId: 'fixture-permit', deepSleepSupported: false }
      : { success: false, error: 'not-found' })
    window.electronAPI = { ...previous, shelfBrowserRequest: request }
    try {
      await act(async () => { render(<WebTabOverlay id="presentation-unconfirmed" url="https://fixture.test/" shelfTaskId="saved-fixture" />) })
      const page = document.querySelector<HTMLElement>('webview')!
      expect(page.hasAttribute('inert')).toBe(true)
      act(() => { page.dispatchEvent(new Event('dom-ready')) })
      await act(async () => { await vi.advanceTimersByTimeAsync(200) })
      expect(page.hasAttribute('inert')).toBe(true)
      expect(page.style.pointerEvents).toBe('none')
      fireEvent.click(screen.getByRole('button', { name: 'Show current page' }))
      expect(page.hasAttribute('inert')).toBe(false)
      expect(request.mock.calls.some(([input]) => input.kind === 'presented')).toBe(false)
    } finally { window.electronAPI = previous }
  })
})
