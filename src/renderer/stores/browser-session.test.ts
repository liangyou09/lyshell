// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePaneStore, normalizeWebBarUrl } from './pane-store'
import { useBrowserSettingsStore } from './browser-settings-store'
import { DEFAULT_BROWSER_SETTINGS } from '@shared/browser-settings'

beforeEach(() => {
  vi.resetModules()
  vi.doMock('./pane-store', () => ({ usePaneStore, normalizeWebBarUrl }))
  vi.doMock('./browser-settings-store', () => ({ useBrowserSettingsStore }))
  localStorage.clear()
  usePaneStore.setState({ layout: { root: { type: 'leaf', id: 'pane', sessions: [], activeSessionId: null, overlays: [] }, activePaneId: 'pane' }, overlayPayloads: {}, webTabHistory: [], webTabFavicons: {} })
  useBrowserSettingsStore.setState({ settings: { ...structuredClone(DEFAULT_BROWSER_SETTINGS), restoreTabs: true }, loaded: true, error: null })
})

describe('浏览器恢复与隐私选项', () => {
  it('首次读取失败不删恢复清单，重试成功后恢复并持续保存，卸载后停止订阅', async () => {
    const { initializeBrowserSession } = await import('./browser-session')
    const api = vi.fn().mockResolvedValueOnce({ success: false, error: 'browserOperationFailed' })
      .mockResolvedValueOnce({ success: true, settings: { ...DEFAULT_BROWSER_SETTINGS, restoreTabs: true } })
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { browserRequest: api } })
    useBrowserSettingsStore.setState({ loaded: false })
    const key = 'lyshell.browser.tabs.v1'
    localStorage.setItem(key, JSON.stringify(['https://restored.example/']))
    const dispose = initializeBrowserSession()
    try {
      await useBrowserSettingsStore.getState().load()
      expect(useBrowserSettingsStore.getState().error).toBe('browserOperationFailed')
      expect(localStorage.getItem(key)).toBe(JSON.stringify(['https://restored.example/']))
      expect(Object.keys(usePaneStore.getState().overlayPayloads)).toHaveLength(0)
      await useBrowserSettingsStore.getState().load()
      expect(Object.values(usePaneStore.getState().overlayPayloads)).toContainEqual(expect.objectContaining({ url: 'https://restored.example/' }))
      usePaneStore.getState().openWebTab('https://new.example/')
      expect(JSON.parse(localStorage.getItem(key)!)).toEqual(['https://restored.example/', 'https://new.example/'])
      dispose()
      usePaneStore.getState().openWebTab('https://after-dispose.example/')
      expect(JSON.parse(localStorage.getItem(key)!)).toEqual(['https://restored.example/', 'https://new.example/'])
    } finally {
      dispose()
      Object.defineProperty(window, 'electronAPI', { configurable: true, value: undefined })
    }
  })
  it('只恢复 HTTP 地址，首个激活，后续后台挂载，重调用不重复恢复', async () => {
    const { restoreBrowserTabs } = await import('./browser-session')
    localStorage.setItem('lyshell.browser.tabs.v1', JSON.stringify(['https://first.example', 'file:///a', 'https://u:p@example.com', 'https://second.example']))
    restoreBrowserTabs(); restoreBrowserTabs()
    expect(Object.values(usePaneStore.getState().overlayPayloads).filter(p => p.kind === 'web').map(p => p.kind === 'web' && p.url)).toEqual(['https://first.example/', 'https://second.example/'])
    const root = usePaneStore.getState().layout.root
    expect(root.type === 'leaf' && root.overlays.filter(ref => ref.active).length).toBe(1)
  })
  it('持久化跳过插件及待处理 POST，关闭恢复时删除清单', async () => {
    const { persistBrowserTabs, restoreBrowserTabs } = await import('./browser-session')
    restoreBrowserTabs()
    usePaneStore.getState().openWebTab('https://normal.example')
    usePaneStore.getState().openWebTab('https://post.example', undefined, { postToken: 'pending' })
    usePaneStore.getState().openWebTab('https://plugin.example', undefined, { ownerPluginId: 'fixture-plugin' })
    persistBrowserTabs()
    const saved = JSON.parse(localStorage.getItem('lyshell.browser.tabs.v1') ?? '[]')
    expect(saved).toContain('https://normal.example/')
    expect(saved).not.toContain('https://post.example/')
    expect(saved).not.toContain('https://plugin.example/')
    useBrowserSettingsStore.setState({ settings: { ...DEFAULT_BROWSER_SETTINGS, restoreTabs: false } })
    persistBrowserTabs()
    expect(localStorage.getItem('lyshell.browser.tabs.v1')).toBeNull()
  })
  it('关闭历史后不新增，不改变已保存的历史', () => {
    usePaneStore.getState().recordWebTabVisit('https://before.example/')
    useBrowserSettingsStore.setState({ settings: { ...DEFAULT_BROWSER_SETTINGS, rememberHistory: false } })
    usePaneStore.getState().recordWebTabVisit('https://after.example/')
    usePaneStore.getState().openWebTab('https://after.example/')
    const id = Object.keys(usePaneStore.getState().overlayPayloads)[0]
    usePaneStore.getState().setWebTabFavicon(id, 'data:image/png;base64,fixture')
    expect(usePaneStore.getState().webTabHistory).toEqual(['https://before.example/'])
    expect(usePaneStore.getState().webTabFavicons).toEqual({})
  })
})
