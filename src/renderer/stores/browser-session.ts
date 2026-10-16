import { usePaneStore, normalizeWebBarUrl } from './pane-store'
import { useBrowserSettingsStore } from './browser-settings-store'

const TABS_KEY = 'lyshell.browser.tabs.v1'
let restored = false

/** 设置读取失败后仍继续监听，后续重试成功时补建恢复和持久化订阅。 */
export function initializeBrowserSession(): () => void {
  let disposed = false
  let offPanes: (() => void) | undefined
  const sync = () => {
    const config = useBrowserSettingsStore.getState()
    if (disposed || !config.loaded || config.error) return
    if (!offPanes) {
      restoreBrowserTabs()
      offPanes = usePaneStore.subscribe(persistBrowserTabs)
    }
    persistBrowserTabs()
  }
  const offSettings = useBrowserSettingsStore.subscribe(sync)
  void useBrowserSettingsStore.getState().load().then(sync)
  return () => { disposed = true; offPanes?.(); offSettings() }
}

/** 仅恢复普通 GET 地址。POST 表单、插件资源和登录凭据不进入恢复清单。 */
export function restoreBrowserTabs(): void {
  if (restored) return
  restored = true
  if (!useBrowserSettingsStore.getState().settings.restoreTabs) {
    try { localStorage.removeItem(TABS_KEY) } catch { /* 存储不可用 */ }
    return
  }
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(TABS_KEY) ?? '[]')
    if (!Array.isArray(raw)) return
    let opened = false
    for (const url of raw.slice(0, 30)) {
      if (typeof url !== 'string' || url.length > 4096 || !/^https?:\/\//i.test(url)) continue
      const normalized = normalizeWebBarUrl(url)
      if (normalized && !new URL(normalized).username && !new URL(normalized).password) {
        const result = usePaneStore.getState().openWebTab(normalized, undefined, { background: opened })
        if (result.ok) opened = true
      }
    }
  } catch { /* 恢复文件损坏不阻断启动 */ }
}

export function persistBrowserTabs(): void {
  const config = useBrowserSettingsStore.getState()
  if (!restored || !config.loaded || config.error) return
  try {
    if (!config.settings.restoreTabs) { localStorage.removeItem(TABS_KEY); return }
    const state = usePaneStore.getState()
    const urls = Object.values(state.overlayPayloads).flatMap(item => {
      if (item.kind !== 'web' || item.ownerPluginId || item.postToken) return []
      const url = item.nav?.url || item.url
      try {
        const parsed = new URL(url)
        return /^https?:$/.test(parsed.protocol) && !parsed.username && !parsed.password ? [url] : []
      } catch { return [] }
    }).slice(0, 30)
    localStorage.setItem(TABS_KEY, JSON.stringify(urls))
  } catch { /* 存储已满时保留运行中页面 */ }
}
