import type { PluginViewMeta } from '@shared/plugin-types'
import { normalizePluginWebOrigin } from '@shared/plugin-web-resources'
import { usePaneStore } from '../../stores/pane-store'

/** 聊天在终端主区域打开，来源只取已注册插件清单，不接受请求携带任意 URL。 */
export function openPluginChatTab(view: PluginViewMeta): { ok: boolean; error?: string } {
  const origin = view.connectOrigins?.map(normalizePluginWebOrigin).find(Boolean)
  if (!origin) return { ok: false, error: 'plugin chat origin is not registered' }
  const url = `${origin}/ui/chat/`
  const panes = usePaneStore.getState()
  const existing = Object.entries(panes.overlayPayloads).find(([id, payload]) =>
    payload.kind === 'web' && payload.ownerPluginId === view.pluginId && payload.url === url
      && panes.getOverlayPaneId(id) !== null)
  if (existing) {
    panes.activateOverlay(existing[0])
    return { ok: true }
  }
  return panes.openWebTab(url, undefined, { ownerPluginId: view.pluginId })
}
