import { normalizeWebBarUrl, usePaneStore } from '../../stores/pane-store'
import { usePluginStore } from '../../stores/plugin-store'
import { getWebview } from './web-tab-controls'

/** 插件可显式复用自身工作台；普通网页和其他插件的多开语义保持不变。 */
export function openPluginWebTab(pluginId: string, rawUrl: string, reuseExisting = false): { ok: true } | { ok: false; error: string } {
  const url = normalizeWebBarUrl(rawUrl)
  if (!url) return { ok: false, error: 'invalid URL' }
  const plugins = usePluginStore.getState()
  if (plugins.items.some(p => p.id === pluginId && !p.enabled) || (plugins.loaded && !plugins.items.some(p => p.id === pluginId))) {
    return { ok: false, error: 'plugin is disabled' }
  }
  const store = usePaneStore.getState()
  const target = new URL(url)
  const documentUrl = (value: string): string => { const parsed = new URL(value); parsed.hash = ''; return parsed.href }
  if (reuseExisting) {
    // 以当前落点匹配，不夺取用户已经导航去其他页面的页签；查询参数也是身份的一部分。
    const candidates = Object.entries(store.overlayPayloads).filter(([id, payload]) => {
      if (payload.kind !== 'web' || payload.ownerPluginId !== pluginId || payload.postToken || !store.getOverlayPaneId(id)) return false
      try { return documentUrl(payload.nav?.url || payload.url) === documentUrl(url) } catch { return false }
    })
    const existing = candidates.find(([id]) => store.isOverlayActive(id)) || candidates[0]
    if (existing) {
      const [id, payload] = existing
      const webview = getWebview(id)
      // 首航尚未挂载时也不新建第二页；快捷导航失败需要明确回执。
      if (target.hash && !webview) return { ok: false, error: '工作台正在打开，请稍后重试快捷入口' }
      store.activateOverlay(id)
      if (target.hash && payload.kind === 'web' && (payload.nav?.url || payload.url) !== url) {
        try { void webview!.loadURL(url).catch(() => { /* 加载失败由页签自身呈现。 */ }) } catch { return { ok: false, error: '工作台导航失败，请重试' } }
      }
      return { ok: true }
    }
  }
  return store.openWebTab(url, undefined, { ownerPluginId: pluginId })
}
