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
}

/**
 * 插件 main 模块契约（VS Code 式）。
 * 入口需导出 activate；deactivate 可选（host 退出时 best-effort 调用）。
 */
export interface PluginModule {
  activate(api: LyShellPluginApi): void | Promise<void>
  deactivate?(): void | Promise<void>
}
