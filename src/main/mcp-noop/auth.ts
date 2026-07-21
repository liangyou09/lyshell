/**
 * MCP 鉴权令牌管理 -- 无 MCP 构建的 no-op stub
 *
 * 与 src/main/mcp/auth.ts 保持相同的导出签名，
 * 但在 no-MCP 构建中所有函数均为空实现。
 */
import type { McpCapability } from '@shared/api-routes'

export type TokenKind = 'global' | 'session' | 'plugin'

export interface TokenBinding {
  kind: TokenKind
  /** 当 kind === 'session' 时，发起请求的 PTY 会话 ID（用于审计溯源） */
  originSessionId?: string
  /** 当 kind === 'plugin' 时，绑定的插件 ID */
  pluginId?: string
  /** 当 kind === 'plugin' 时，该插件被批准的 capability 子集 */
  capabilities?: McpCapability[]
}

export function rotateGlobalToken(): string {
  return ''
}

export function getGlobalToken(): string | null {
  return null
}

export function clearGlobalToken(): void {
  // no-op
}

export function bindSessionToken(_sessionId: string): string {
  return ''
}

export function revokeSessionToken(_sessionId: string): void {
  // no-op
}

export function bindPluginToken(_pluginId: string, _capabilities: McpCapability[]): string {
  return ''
}

export function revokePluginToken(_pluginId: string): void {
  // no-op
}

export function clearAllTokens(): void {
  // no-op
}

export function resolveToken(_token: string | string[] | undefined): TokenBinding | null {
  return null
}
