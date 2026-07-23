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
}

/**
 * host 侧钩子（createPluginApi 第三参数，host 内部用，不暴露给插件）。
 * onSpawn：spawnControlled 拉起子进程后回调，host 据此登记子进程，退出时兜底 kill
 * （防插件 deactivate 漏杀 / 超时 / Windows 不级联孙进程）。
 */
export interface PluginApiHooks {
  onSpawn?: (child: ChildProcess) => void
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
