import { preferencesRepository } from '../storage/repository'
import { sessionManager, type Session } from '../terminal/session-manager'
import { ConnectionStatus } from '@shared/types'

export interface McpSecuritySettings {
  enabled?: boolean
  allowRead?: boolean
  allowInteractiveInput?: boolean
  allowSshExecute?: boolean
  allowLocalExecute?: boolean
  allowFileWrite?: boolean
  allowSessionControl?: boolean
  allowSessionMetadataWrite?: boolean
  requireConfirmation?: boolean
  allowedSessionIds?: string[]
  deniedSessionIds?: string[]
  allowExternalMcpClients?: boolean
  confirmDestructiveCommands?: boolean
  confirmFirstNotesWrite?: boolean
}

export const DEFAULT_MCP_SECURITY: Required<McpSecuritySettings> = {
  enabled: true,
  allowRead: true,
  allowInteractiveInput: false,
  allowSshExecute: false,
  allowLocalExecute: false,
  allowFileWrite: false,
  allowSessionControl: false,
  allowSessionMetadataWrite: false,
  requireConfirmation: true,
  allowedSessionIds: [],
  deniedSessionIds: [],
  // 默认关闭外部接入：只对 LyShell 自身孵化的本地 PTY（per-session token）开放
  allowExternalMcpClients: false,
  // 默认开启破坏性命令确认：对 session/global token 一视同仁的内容级防御层
  confirmDestructiveCommands: true,
  // 默认开启首次写入会话备注确认（C6）：session token 写元数据的唯一人工闸门
  confirmFirstNotesWrite: true
}

export function getMcpSecuritySettings(): Required<McpSecuritySettings> {
  const security = preferencesRepository.get('security') as { mcp?: McpSecuritySettings } | undefined
  const legacy = preferencesRepository.get('mcpSecurity') as McpSecuritySettings | undefined
  return { ...DEFAULT_MCP_SECURITY, ...(security?.mcp || legacy || {}) }
}

export function resolveRuntimeSessionId(sessionId: string): string {
  // 本身是 live session，直接返回
  if (sessionManager.getSession(sessionId)) {
    return sessionId
  }

  // 反查 originSavedSessionId 匹配的 runtime 会话；无则原样返回
  const best = pickBestRuntimeSession(sessionId)
  return best ? best.id : sessionId
}

export const STATUS_RANK: Record<string, number> = {
  [ConnectionStatus.CONNECTED]: 5,
  [ConnectionStatus.CONNECTING]: 4,
  [ConnectionStatus.RECONNECTING]: 3,
  [ConnectionStatus.ERROR]: 2,
  [ConnectionStatus.DISCONNECTED]: 1
}

/**
 * 按 saved session ID 反查最优 runtime 会话（通过 originSavedSessionId）。
 * 优先 connected，其次按最近活跃时间倒序。供 buildSessionInfo 与 resolveRuntimeSessionId 复用。
 */
export function pickBestRuntimeSession(savedId: string): Session | undefined {
  const candidates = sessionManager.getAllSessions().filter(s => s.config.originSavedSessionId === savedId)
  if (candidates.length === 0) return undefined
  return candidates.sort((a, b) => {
    const rankA = STATUS_RANK[a.status] ?? 0
    const rankB = STATUS_RANK[b.status] ?? 0
    if (rankB !== rankA) return rankB - rankA
    return b.lastActiveAt.getTime() - a.lastActiveAt.getTime()
  })[0]
}

export function isSessionAllowedForMcp(sessionId: string): boolean {
  const settings = getMcpSecuritySettings()
  if (!settings.enabled) return false
  const resolvedSessionId = sessionId ? resolveRuntimeSessionId(sessionId) : undefined
  const isDenied = (sid?: string) => sid !== undefined && settings.deniedSessionIds.includes(sid)
  if (isDenied(sessionId) || isDenied(resolvedSessionId)) return false
  if (settings.allowedSessionIds.length > 0) {
    const isAllowed = (sid?: string) => sid !== undefined && settings.allowedSessionIds.includes(sid)
    if (!isAllowed(sessionId) && !isAllowed(resolvedSessionId)) return false
  }
  return true
}
