/**
 * LyShellPluginApi 实现（plugin host 子进程侧）
 *
 * createPluginApi 为每个插件构造独立 API 实例，绑定该插件的 token +
 * grantedCapabilities。call() 前置 capability gate（候选级宽松），http-server
 * 兜底严格鉴权（运行时按会话类型选实际 capability）。
 *
 * spawnControlled()（路线2）：host 内部把本插件 token + 连接包注入子进程 env，
 * 插件代码看不到 token。子进程 spawn mcpServer.js 即可像 Claude 一样经 stdio MCP
 * 连 LyShell（持本插件 capability）。详见 @shared/plugin-api 的 spawnControlled 注释。
 *
 * path 含 :id 时（如 /api/sessions/:id/notes）把 args.sessionId 移入路径，
 * 与 mcp-server/index.ts 的特殊分支保持一致。
 */
import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { API_ROUTES } from '@shared/api-routes'
import type { LyShellPluginApi, PluginChildProcess } from '@shared/plugin-api'
import type { PluginSpec } from '@shared/plugin-types'

/** createPluginApi 依赖的最小 HTTP 客户端形状（LyShellHttpClient 满足；便于测试注入） */
export interface PluginHttpClient {
  get(path: string): Promise<{ data: unknown }>
  post(path: string, body?: unknown): Promise<{ data: unknown }>
  del?(path: string): Promise<{ data: unknown }>
}

/**
 * 解析后的 API 调用（路由查找 + :id 替换 + GET query/POST body 规则）。
 * 供 plugin host SDK 的 call() 与插件视图页面 callApi（view-bridge.ts）复用 ——
 * 单一实现防两处规则漂移（docs/plugin-ui-views-plan.md §二「callApi 路由复用」）。
 */
export interface ResolvedApiCall {
  route: (typeof API_ROUTES)[number]
  /** :id 已替换的路径（无 query） */
  path: string
  /** GET query string（'' 表示无）；POST 恒为 '' */
  query: string
  /** POST body；GET 为 undefined */
  body: unknown
}

/**
 * host 侧钩子（createPluginApi 第三参数，host 内部用，不暴露给插件）。
 * onSpawn：spawnControlled 拉起子进程后回调，host 据此登记子进程，退出时兜底 kill
 * （防插件 deactivate 漏杀 / 超时 / Windows 不级联孙进程）。
 */
export interface PluginApiHooks {
  onSpawn?: (child: ChildProcess) => void
}

/**
 * 工具名 → 可执行 HTTP 调用的纯解析。未知工具返回 null；:id 路由缺字符串
 * sessionId 抛错（调用方转成具体错误消息）。
 * @param requireHttpTransport 视图页面 callApi 只允许 http transport 工具（host SDK 不限）
 */
export function resolveApiRouteCall(
  toolName: string,
  args?: Record<string, unknown>,
  opts?: { requireHttpTransport?: boolean; pluginId?: string }
): ResolvedApiCall | null {
  const route = API_ROUTES.find((r) => r.name === toolName)
  if (!route) return null
  if (opts?.requireHttpTransport && !route.transports.includes('http')) {
    throw new Error(
      `[${opts.pluginId ?? 'view'}] tool ${toolName} is not available over HTTP transport`
    )
  }
  // :id 路径参数（如 /api/sessions/:id/notes）：把 sessionId 移入路径
  let path = route.path
  let body = args
  if (path.includes(':id')) {
    const sessionId = args?.sessionId
    if (typeof sessionId !== 'string') {
      throw new Error(`${toolName} requires string sessionId for :id path`)
    }
    path = path.replace(':id', encodeURIComponent(sessionId))
    const rest: Record<string, unknown> = { ...(args ?? {}) }
    delete rest.sessionId
    body = rest
  }
  if (route.method === 'GET') {
    // GET 不带 body:把剩余参数(:id 路由已剥离 sessionId)拼成 query string。
    // 仅展平原始值(string/number/boolean),undefined/null 与对象/数组跳过(GET 不宜携复合结构)。
    const query = buildQuery(body)
    return { route, path, query, body: undefined }
  }
  return { route, path, query: '', body }
}

export function createPluginApi(
  spec: PluginSpec,
  client: PluginHttpClient,
  hooks?: PluginApiHooks
): LyShellPluginApi {
  const granted = new Set(spec.grantedCapabilities)
  return {
    pluginId: spec.pluginId,
    grantedCapabilities: spec.grantedCapabilities,
    /**
     * 运行时视图注册/注销（Node 持久插件用；声明式 views 不许被运行时覆盖，
     * 由 http-server 侧统一校验后落到 view-registry）。HTTP 路由:
     *   POST   /api/plugins/:pluginId/views
     *   DELETE /api/plugins/:pluginId/views/:viewId
     * host token 专有（UI token 走不到这两条路由）。
     */
    async registerView(def) {
      // 在途失败（host 被 kill / 插件被禁用）在 http-server 侧给出具体 4xx；
      // 这里把网络层异常包一层上下文，避免插件看到裸 fetch 错误。
      try {
        await client.post(`/api/plugins/${encodeURIComponent(spec.pluginId)}/views`, def)
      } catch (e) {
        throw new Error(`[plugin ${spec.pluginId}] registerView failed: ${(e as Error).message}`)
      }
    },
    async unregisterView(id) {
      if (!client.del) {
        throw new Error(`[plugin ${spec.pluginId}] unregisterView: http client does not support DELETE`)
      }
      try {
        await client.del(`/api/plugins/${encodeURIComponent(spec.pluginId)}/views/${encodeURIComponent(id)}`)
      } catch (e) {
        throw new Error(`[plugin ${spec.pluginId}] unregisterView(${id}) failed: ${(e as Error).message}`)
      }
    },
    async call(toolName, args) {
      let resolved: ResolvedApiCall | null
      try {
        resolved = resolveApiRouteCall(toolName, args, { pluginId: spec.pluginId })
      } catch (e) {
        throw new Error(`[plugin ${spec.pluginId}] ${(e as Error).message}`)
      }
      if (!resolved) {
        throw new Error(`[plugin ${spec.pluginId}] unknown tool: ${toolName}`)
      }
      const { route, path, query, body } = resolved
      // 前置 capability gate（候选级宽松）：持候选集中任一即放行。
      // http-server 兜底严格鉴权（运行时按会话类型选实际 capability）。
      if (!route.capabilities.some((c) => granted.has(c))) {
        throw new Error(
          `[plugin ${spec.pluginId}] lacks capability for ${toolName} ` +
            `(needs one of [${route.capabilities.join(', ')}], has [${spec.grantedCapabilities.join(', ')}])`
        )
      }
      if (route.method === 'GET') {
        const getResult = await client.get(query ? `${path}?${query}` : path)
        return getResult.data
      }
      const postResult = await client.post(path, body)
      return postResult.data
    },
    spawnControlled(exe, args = [], opts = {}) {
      const port = process.env.LYSHELL_MCP_PORT
      if (!port) {
        throw new Error(
          `[plugin ${spec.pluginId}] spawnControlled: LYSHELL_MCP_PORT unavailable（host 未连上 LyShell API）`
        )
      }
      // mcpServer.js 路径:优先用 main 经 env 下发的权威路径(host-mgr 以 hostPath 目录锚定,
      // 不依赖本文件被 inline 进 pluginHost.js -- 一旦本文件被第二个 entry 引用变 chunk,
      // __dirname 会漂到 chunks/ 导致路径错、静默退化)。env 无时回退 __dirname 兜底。
      const scriptPath = process.env.LYSHELL_MCP_SERVER_SCRIPT || join(__dirname, 'mcpServer.js')
      const scriptExists = existsSync(scriptPath)

      // 子进程 env：继承 host env + 插件自定义，然后 host 注入连接包。
      // token 最后注入 -> 覆盖插件 opts.env 里的同名字段，插件无法篡改/伪造 token。
      const env: Record<string, string | undefined> = { ...process.env, ...(opts.env ?? {}) }
      if (opts.gui !== false) {
        // 默认让 Electron 子进程有 GUI：清掉 host 继承的 ELECTRON_RUN_AS_NODE。
        delete env.ELECTRON_RUN_AS_NODE
      }
      env.LYSHELL_MCP_PORT = port
      env.LYSHELL_MCP_TOKEN = spec.token
      if (scriptExists) {
        env.LYSHELL_MCP_SERVER_SCRIPT = scriptPath
        env.LYSHELL_ELECTRON_EXE = process.execPath
      } else {
        // 脚本缺失(不应发生:host 在则 mcpServer.js 兄弟 entry 在):大声告警,不静默退化。
        // 仍注入 port/token -- 桌宠可独立运行,但连接包不完整 -> 无 LyShell 控制权。
        console.error(
          `[plugin ${spec.pluginId}] spawnControlled: mcpServer.js not found at ${scriptPath}; ` +
            `child will run WITHOUT LyShell control (standalone mode)`
        )
      }

      const child = spawn(exe, args, {
        env,
        cwd: opts.cwd,
        stdio: opts.stdio ?? 'inherit'
      })
      // 默认 'error' 监听:spawn 对 ENOENT(坏 exe)异步发 'error' 而非同步抛;
      // 无监听则升 uncaughtException 崩整个共享 host(连带所有 node 插件)。
      // 插件可再挂自己的 'error' 监听(两者都触发)。
      child.on('error', (e) => {
        console.error(`[plugin ${spec.pluginId}] spawnControlled error:`, e)
      })
      // host 登记子进程做退出兜底 kill(见 index.ts shutdown)。
      hooks?.onSpawn?.(child)
      return child as unknown as PluginChildProcess
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
