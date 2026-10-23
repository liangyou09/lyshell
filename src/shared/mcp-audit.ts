export const MCP_AUDIT_RETENTION_OPTIONS = [1000, 5000, 10000, 20000] as const
export type McpAuditRetentionLimit = typeof MCP_AUDIT_RETENTION_OPTIONS[number]
export const DEFAULT_MCP_AUDIT_RETENTION: McpAuditRetentionLimit = 5000

export function isMcpAuditRetentionLimit(value: unknown): value is McpAuditRetentionLimit {
  return typeof value === 'number' && MCP_AUDIT_RETENTION_OPTIONS.some(option => option === value)
}
