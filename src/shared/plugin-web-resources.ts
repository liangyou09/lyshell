import { PLUGIN_VIEW_CONNECT_ORIGIN_PATTERN, type PluginViewMeta } from './plugin-types'
import type { OverlayPayload } from './types'

function normalizePluginWebOrigin(origin: string): string | undefined {
  if (!/^https?:/.test(origin) || !PLUGIN_VIEW_CONNECT_ORIGIN_PATTERN.test(origin)) return undefined
  try { return new URL(origin).origin } catch { return undefined }
}

/** 只识别插件声明的本机 HTTP 服务，不按路径、标题或端口子串猜归属。 */
export function matchesPluginWebOrigin(rawUrl: string, origins: readonly string[]): boolean {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return origins.some(origin => normalizePluginWebOrigin(origin) === url.origin)
  } catch { return false }
}

/** 共用服务来源不自动认领；显式 ownerPluginId 不受此限制。 */
export function uniquePluginWebOrigins(views: readonly PluginViewMeta[], pluginId: string): string[] {
  const normalize = (origins: readonly string[]): string[] => origins
    .map(normalizePluginWebOrigin).filter((origin): origin is string => origin !== undefined)
  const own = new Set(normalize(views.filter(v => v.pluginId === pluginId).flatMap(v => v.connectOrigins ?? [])))
  for (const view of views) {
    if (view.pluginId === pluginId) continue
    for (const origin of normalize(view.connectOrigins ?? [])) own.delete(origin)
  }
  return [...own]
}

export function pluginWebOwner(rawUrl: string, views: readonly PluginViewMeta[]): string | undefined {
  const ids = new Set(views.filter(view => matchesPluginWebOrigin(rawUrl, view.connectOrigins ?? [])).map(view => view.pluginId))
  return ids.size === 1 ? [...ids][0] : undefined
}

/** 兼容热更新前已经打开、尚无归属字段的聊天页签。 */
export function pluginOverlayIds(payloads: Record<string, OverlayPayload>, pluginId: string, origins: readonly string[] = []): string[] {
  return Object.entries(payloads).filter(([, payload]) => {
    if (payload.ownerPluginId) return payload.ownerPluginId === pluginId
    return payload.kind === 'web' && [payload.url, payload.nav?.url ?? ''].some(url => matchesPluginWebOrigin(url, origins))
  }).map(([id]) => id)
}
