/**
 * 插件受控 API 契约（共享层）
 *
 * plugin host 加载插件 main 后，调其 activate(api) 注入本接口的实现。
 * 插件通过 api.call(toolName, args) 调 LyShell 工具 -- host 前置 capability gate，
 * http-server 兜底真正鉴权（不信任插件）。
 *
 * 放 @shared 供未来插件 SDK 复用类型（docs/plugin-system-design.md §5）。
 */
import type { McpCapability } from './api-routes'

/**
 * 注入插件的受控 API。
 * 每插件持独立实例，绑定自己的 plugin token + grantedCapabilities。
 */
export interface LyShellPluginApi {
  readonly pluginId: string
  /** 该插件被批准的 capability（安装时用户批准的 manifest.capabilities 子集） */
  readonly grantedCapabilities: readonly McpCapability[]
  /**
   * 通用工具调用（lyshell_ 前缀名，如 'lyshell_list_sessions'）。
   * 前置 capability gate（候选级宽松：持 route 候选 capability 之一即放行）；
   * 实际鉴权由 http-server 兜底（运行时按会话类型选实际 capability）。
   * @returns HTTP 响应的 data 字段
   */
  call(toolName: string, args?: Record<string, unknown>): Promise<unknown>

  /**
   * spawn 一个受控子进程，把「连接 LyShell MCP 的连接包」注入其 env：
   *   - LYSHELL_MCP_PORT / LYSHELL_MCP_TOKEN（= 本插件 token，**插件代码看不到**）
   *   - LYSHELL_MCP_SERVER_SCRIPT（mcpServer.js 绝对路径）/ LYSHELL_ELECTRON_EXE（运行它的 electron）
   *
   * 子进程用这些 env spawn mcpServer.js（MCP SDK StdioClientTransport）即可像 Claude 一样
   * 经 stdio MCP 连 LyShell，持本插件 capability（grantedCapabilities），动态 tools/list。
   * 路线2（见 examples/plugins/my-pet-plugin）：插件只当启动器，桌宠作为 MCP 客户端连入。
   *
   * 安全：token 经 host 内部注入，不暴露给插件代码（api 对象无 token 访问器）；
   *       token 落入子进程 env（同用户可读，直到插件禁用 revokePluginToken 失效）。
   *       独立启动的子进程（未经本方法）拿不到 token；allowExternalMcpClients 关时
   *       端口文件 token 为 null，独立子进程 discoverLyshell 失败 -> 连不上。
   *
   *       host 默认挂 'error' 监听（spawn 对坏 exe 异步发 'error' 而非同步抛，
   *       无监听则 uncaughtException 崩整个共享 host），插件可再挂自己的 'error' 监听。
   *       不加 capability gate：子进程只拿本插件自己的 token，无提权；每工具调用仍由
   *       http-server 兜底鉴权。
   *
   * @returns 受控子进程句柄（deactivate 时 kill；host 退出时也会兜底 kill）
   */
  spawnControlled(exe: string, args?: string[], opts?: PluginSpawnOptions): PluginChildProcess
}

/** spawnControlled 的子进程选项（child_process.spawn 的受控子集）。 */
export interface PluginSpawnOptions {
  /** 合并入子进程 env；host 注入的 token/port 优先（插件无法覆盖 token）。 */
  env?: Record<string, string | undefined>
  cwd?: string
  /** 子进程 stdio，默认 'inherit'。 */
  stdio?: 'inherit' | 'pipe' | 'ignore' | Array<'inherit' | 'pipe' | 'ignore'>
  /**
   * 默认 true：删掉从 host 继承的 ELECTRON_RUN_AS_NODE，让 Electron 子进程有 GUI。
   * 设 false 保持 headless（子进程是纯 Node 工具时）。
   */
  gui?: boolean
}

/** spawnControlled 返回的受控子进程句柄（ChildProcess 的最小结构）。 */
export interface PluginChildProcess {
  readonly pid: number
  kill(signal?: string): boolean
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): this
  /** spawn 对坏 exe 异步发 'error'（非同步抛）；host 默认已挂一个,插件可再挂。 */
  on(event: 'error', listener: (err: Error) => void): this
  on(event: string, listener: (...args: unknown[]) => void): this
}

/**
 * 插件 main 模块契约（VS Code 式）。
 * 入口需导出 activate；deactivate 可选（host 退出时 best-effort 调用）。
 */
export interface PluginModule {
  activate(api: LyShellPluginApi): void | Promise<void>
  deactivate?(): void | Promise<void>
}
