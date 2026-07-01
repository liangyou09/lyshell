/**
 * MCP 类型/常量 —— 无 MCP 构建的 no-op stub
 *
 * 仅保留被外部引用的运行时常量 LYSHELL_MCP_ENV。
 */

export const LYSHELL_MCP_ENV = {
  PORT: 'LYSHELL_MCP_PORT',
  TOKEN: 'LYSHELL_MCP_TOKEN',
  SESSION_ID: 'LYSHELL_MCP_SESSION_ID',
  USER_DATA: 'LYSHELL_USER_DATA'
} as const
