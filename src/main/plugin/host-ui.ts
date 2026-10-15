import type { TokenBinding } from '../mcp/auth'
import type { McpCapability } from '@shared/api-routes'
import type { PluginViewMeta } from '@shared/plugin-types'
import { validatePluginHostUiRequest, type PluginHostUiRequest } from '@shared/plugin-host-ui'

interface HostUiDeps {
  plugin(id: string): { enabled: boolean; grantedCapabilities: McpCapability[] } | undefined
  views(id: string): PluginViewMeta[]
  open(request: PluginHostUiRequest, viewId: string): Promise<{ ok: boolean; error?: string }>
}

export interface HostUiResult {
  status: number
  body: { success: boolean; error?: string; data?: PluginHostUiRequest }
}

/** 每次读取当前授权；UI/global/session 凭据不能触发宿主前台动作。 */
export async function openPluginHostUi(raw: unknown, binding: TokenBinding, deps: HostUiDeps): Promise<HostUiResult> {
  const fail = (status: number, error: string): HostUiResult => ({ status, body: { success: false, error } })
  const request = validatePluginHostUiRequest(raw)
  if (!request) return fail(400, 'invalid host UI request')
  if (binding.kind !== 'plugin' || binding.tokenSource !== 'host' || binding.pluginId !== request.pluginId) {
    return fail(403, 'host UI requires this plugin host token')
  }
  const plugin = deps.plugin(request.pluginId)
  if (!plugin?.enabled) return fail(403, 'plugin is not enabled')
  if (!binding.capabilities?.includes('uiControl') || !plugin.grantedCapabilities.includes('uiControl')) {
    return fail(403, 'plugin lacks the uiControl capability')
  }
  const view = deps.views(request.pluginId).find(view => request.target === 'settings'
    ? view.surface === 'settings'
    : view.id === 'pets' && view.surface !== 'settings')
  if (!view) return fail(404, 'host UI target is not registered')
  const result = await deps.open(request, view.id)
  if (!result.ok) return fail(503, result.error ?? 'host UI is unavailable')
  // 等待 renderer 时禁用/卸载不得被报告为成功。
  const current = deps.plugin(request.pluginId)
  if (!current?.enabled || !current.grantedCapabilities.includes('uiControl')) return fail(403, 'plugin authorization changed')
  return { status: 200, body: { success: true, data: request } }
}

let opener: HostUiDeps['open'] = async () => ({ ok: false, error: 'main window is unavailable' })
export function setPluginHostUiOpener(open: HostUiDeps['open']): void { opener = open }
export function dispatchPluginHostUi(request: PluginHostUiRequest, viewId: string): ReturnType<HostUiDeps['open']> {
  return opener(request, viewId)
}
