export const MCP_AUDIT_RETENTION_OPTIONS = [1000, 5000, 10000, 20000] as const
export type McpAuditRetentionLimit = typeof MCP_AUDIT_RETENTION_OPTIONS[number]
export const DEFAULT_MCP_AUDIT_RETENTION: McpAuditRetentionLimit = 5000

export interface McpAuditPersistenceFailure {
  revision: number
  phase: 'serialize' | 'primary' | 'backup'
  code: 'PERSISTENCE_FAILED'
}

export interface McpAuditPersistenceState {
  currentRevision: number
  committedRevision: number
  /** 单调时钟上的首次未提交变更时间；只用于诊断，不能与墙钟比较。 */
  dirtySince: number | null
  activeWrite: boolean
  lastFailure: McpAuditPersistenceFailure | null
  serializationMs: number
  writeMs: number
}

export interface McpAuditQuery {
  sessionId?: string
  operation?: string
  allowed?: boolean
  since?: string
  until?: string
  limit?: number
  offset?: number
}

export function isMcpAuditRetentionLimit(value: unknown): value is McpAuditRetentionLimit {
  return typeof value === 'number' && MCP_AUDIT_RETENTION_OPTIONS.some(option => option === value)
}
