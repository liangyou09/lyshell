/**
 * LyShellPluginApi 实现（plugin host 子进程侧）
 *
 * createPluginApi 为每个插件构造独立 API 实例，绑定该插件的 token +
 * grantedCapabilities。call() 前置 capability gate（候选级宽松），http-server
 * 兜底严格鉴权（运行时按会话类型选实际 capability）。
 *
 * path 含 :id 时（如 /api/sessions/:id/notes）把 args.sessionId 移入路径，
 * 与 mcp-server/index.ts 的特殊分支保持一致。
 */
import { API_ROUTES } from '@shared/api-routes'
import type { LyShellPluginApi } from '@shared/plugin-api'
import type { PluginSpec } from '@shared/plugin-types'

/** createPluginApi 依赖的最小 HTTP 客户端形状（LyShellHttpClient 满足；便于测试注入） */
export interface PluginHttpClient {
  get(path: string): Promise<{ data: unknown }>
  post(path: string, body?: unknown): Promise<{ data: unknown }>
}

export function createPluginApi(spec: PluginSpec, client: PluginHttpClient): LyShellPluginApi {
  const granted = new Set(spec.grantedCapabilities)
  return {
    pluginId: spec.pluginId,
    grantedCapabilities: spec.grantedCapabilities,
    async call(toolName, args) {
      const route = API_ROUTES.find((r) => r.name === toolName)
      if (!route) {
        throw new Error(`[plugin ${spec.pluginId}] unknown tool: ${toolName}`)
      }
      // 前置 capability gate（候选级宽松）：持候选集中任一即放行。
      // http-server 兜底严格鉴权（运行时按会话类型选实际 capability）。
      if (!route.capabilities.some((c) => granted.has(c))) {
        throw new Error(
          `[plugin ${spec.pluginId}] lacks capability for ${toolName} ` +
            `(needs one of [${route.capabilities.join(', ')}], has [${spec.grantedCapabilities.join(', ')}])`
        )
      }
      // :id 路径参数（如 /api/sessions/:id/notes）：把 sessionId 移入路径
      let path = route.path
      let body = args
      if (path.includes(':id')) {
        const sessionId = args?.sessionId
        if (typeof sessionId !== 'string') {
          throw new Error(`[plugin ${spec.pluginId}] ${toolName} requires string sessionId for :id path`)
        }
        path = path.replace(':id', encodeURIComponent(sessionId))
        const rest: Record<string, unknown> = { ...(args ?? {}) }
        delete rest.sessionId
        body = rest
      }
      if (route.method === 'GET') {
        // GET 不带 body:把剩余参数(:id 路由已剥离 sessionId)拼成 query string。
        // 当前唯一 GET 路由 read_session_notes 无额外参数 -> rest 空 -> 无 query;此分支为未来 GET 路由预留。
        // 仅展平原始值(string/number/boolean),undefined/null 与对象/数组跳过(GET 不宜携复合结构)。
        const query = buildQuery(body)
        const getResult = await client.get(query ? `${path}?${query}` : path)
        return getResult.data
      }
      const postResult = await client.post(path, body)
      return postResult.data
    }
  }
}

/**
 * 把扁平参数对象编成 query string(用于 GET 路由)。
 * 仅取 string/number/boolean 原始值;undefined/null 跳过;对象/数组不进 query。
 * 空则返回 ''(调用方据此决定是否拼 '?')。
 */
function buildQuery(params: unknown): string {
  if (!params || typeof params !== 'object') return ''
  const parts: string[] = []
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    if (v === undefined || v === null) continue
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    }
  }
  return parts.join('&')
}
