/**
 * MCP 工具定义 —— 投影层
 *
 * Step 1.5 起，工具真相源迁至 @shared/api-routes.ts（API_ROUTES）。本文件仅：
 *   - 从 API_ROUTES 投影出 MCP 工具（TOOL_DEFINITIONS = MCP_TOOL_DEFINITIONS）
 *   - 保留 MCP 专属的旧名别名机制（ALIAS_DEFINITIONS / ALIAS_TO_NEW / HIDDEN_FROM_LIST_TOOLS）
 *
 * 「MCP 是一种传输」的体现：stdio MCP server 的工具列表不再是本文件自带的静态数组，
 * 而是 API_ROUTES.filter(transports ∋ 'stdio-mcp') 的投影（见 api-routes.ts）。
 * 新增/收窄传输只需改 API_ROUTES 的 transports 字段，MCP 工具列表随之自动变化。
 *
 * 工具名统一以 lyshell_ 为前缀。旧名作为 ALIAS_DEFINITIONS 数组在 ListTools 中一起返回，
 * 但 description 以 [DEPRECATED, use lyshell_<x>] 为前缀，引导 agent 自动选新名。
 */

import { MCP_TOOL_DEFINITIONS, type McpToolDefinition } from '@shared/api-routes'

/**
 * MCP 工具定义 = @shared/api-routes 的 stdio-mcp 传输投影。
 * 详见 api-routes.ts 的 MCP_TOOL_DEFINITIONS 注释。
 */
export const TOOL_DEFINITIONS = MCP_TOOL_DEFINITIONS

// ====================== 旧名别名（DEPRECATED） ======================
// 同时返回新旧两套工具名，旧名 description 前缀 [DEPRECATED, use lyshell_<x>]。
// agent 会自动选新名；调旧名时 CallTool 处理器会打印 deprecation warning。

const deprecate = (oldName: string, newName: string, tool: McpToolDefinition): McpToolDefinition => ({
  ...tool,
  name: oldName,
  description: `[DEPRECATED, use ${newName}] ${tool.description}`,
  title: `${tool.title} (deprecated)`
})

// 新名 -> 旧名映射（供 CallTool 处理器的名称转换使用）
export const ALIAS_TO_NEW: Record<string, string> = {}

/** 旧名别名定义列表（用于 ListTools 一起返回） */
export const ALIAS_DEFINITIONS = (() => {
  const oldNew: Array<[string, string]> = [
    ['list_sessions', 'lyshell_list_sessions'],
    ['reconnect_session', 'lyshell_reconnect_session'],
    ['send_input', 'lyshell_send_input'],
    ['execute_command', 'lyshell_execute_command'],
    ['read_output', 'lyshell_read_output'],
    ['send_and_wait', 'lyshell_send_and_wait'],
    ['list_files', 'lyshell_list_files'],
    ['read_file', 'lyshell_read_file'],
    ['download_file', 'lyshell_download_file'],
    ['upload_file', 'lyshell_upload_file'],
    ['stat_file', 'lyshell_stat_file'],
    ['wait_for_prompt', 'lyshell_wait_for_prompt'],
    ['run_on_sessions', 'lyshell_run_on_sessions'],
    ['tail_until', 'lyshell_tail_until']
  ]

  const mainNames = new Map(TOOL_DEFINITIONS.map(t => [t.name, t]))

  const aliases: McpToolDefinition[] = []
  for (const [old, newName] of oldNew) {
    const tool = mainNames.get(newName)
    if (tool) {
      ALIAS_TO_NEW[old] = newName
      aliases.push(deprecate(old, newName, tool))
    }
  }
  return aliases
})()

/**
 * 可从 tools/list 中隐藏的工具名（新名 + 旧别名）。
 * 被隐藏后 Claude Code 等客户端不会自动选用，但 CallTool 仍兼容旧调用。
 */
export const HIDDEN_FROM_LIST_TOOLS = new Set<string>([
  'lyshell_execute_command',
  'lyshell_execute_stream',
  'execute_command',
  'execute_stream'
])
