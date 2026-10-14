/** 插件 host HTTP → 宿主界面请求；不携带 URL 或凭据。 */
export interface PluginHostUiRequest {
  pluginId: string
  target: 'chat2' | 'settings'
}

export function validatePluginHostUiRequest(raw: unknown): PluginHostUiRequest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const data = raw as Record<string, unknown>
  if (Object.keys(data).some(key => key !== 'pluginId' && key !== 'target')) return null
  if (typeof data.pluginId !== 'string' || !/^[a-z0-9-]{1,64}$/.test(data.pluginId)) return null
  if (data.target !== 'chat2' && data.target !== 'settings') return null
  return { pluginId: data.pluginId, target: data.target }
}
