/**
 * MCP 审计日志仓库（B5）。
 *
 * 把 authorizeMcpOperation / confirmDestructiveIfNeeded 产生的审计事件持久化，
 * 供设置页"MCP 活动"面板查询。用户能回看 agent 这段时间做了什么——
 * 对一个能在生产服务器上跑命令的工具，可见性即信任。
 *
 * 实现：内存环形缓冲（上限 MAX_RECORDS）+ 防抖落盘（2s），避免每次 append 都写盘。
 * 退出前由 main/index.ts 的 will-quit 调 flushSync() 同步落盘，防丢最近事件。
 * 查询走内存，倒序返回（最新在前）。
 */
import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import log from 'electron-log'
import { v4 as uuidv4 } from 'uuid'

export interface McpAuditRecord {
  id: string
  /** ISO 时间戳 */
  timestamp: string
  operation: string
  capability: string
  sessionId?: string
  sessionName?: string
  sessionType?: string
  allowed: boolean
  reason?: string
  summary?: string
  durationMs?: number
  /** 'global' | 'session' | ''（auth 失败时无 tokenSource） */
  tokenSource: string
  originSessionId?: string
}

export interface McpAuditQuery {
  sessionId?: string
  /** 操作名子串匹配 */
  operation?: string
  allowed?: boolean
  /** ISO：仅返回此时间之后的记录 */
  since?: string
  limit?: number
  offset?: number
}

const MAX_RECORDS = 2000
const SAVE_DEBOUNCE_MS = 2000

class McpAuditRepository {
  private filePath: string | null = null
  private records: McpAuditRecord[] = []
  private loaded = false
  private saveTimer: NodeJS.Timeout | null = null

  private ensureInitialized(): void {
    if (this.loaded) return
    this.filePath = join(app.getPath('userData'), 'mcp-audit.json')
    this.load()
    this.loaded = true
  }

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return
    try {
      const content = readFileSync(this.filePath, 'utf-8')
      const data = JSON.parse(content)
      if (Array.isArray(data)) this.records = data as McpAuditRecord[]
      log.info(`[MCP] Loaded ${this.records.length} audit records`)
    } catch (e) {
      log.error('[MCP] Failed to load audit log:', e)
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.saveNow()
    }, SAVE_DEBOUNCE_MS)
  }

  private saveNow(): void {
    if (!this.filePath) return
    try {
      writeFileSync(this.filePath, JSON.stringify(this.records, null, 2), 'utf-8')
    } catch (e) {
      log.error('[MCP] Failed to save audit log:', e)
    }
  }

  append(record: Omit<McpAuditRecord, 'id' | 'timestamp'>): void {
    this.ensureInitialized()
    this.records.push({ id: uuidv4(), timestamp: new Date().toISOString(), ...record })
    if (this.records.length > MAX_RECORDS) {
      this.records = this.records.slice(-MAX_RECORDS)
    }
    this.scheduleSave()
  }

  query(filter: McpAuditQuery): { records: McpAuditRecord[]; total: number } {
    this.ensureInitialized()
    let filtered = this.records
    if (filter.sessionId) filtered = filtered.filter(r => r.sessionId === filter.sessionId)
    if (filter.operation) filtered = filtered.filter(r => r.operation.includes(filter.operation!))
    if (filter.allowed !== undefined) filtered = filtered.filter(r => r.allowed === filter.allowed)
    if (filter.since) filtered = filtered.filter(r => r.timestamp >= filter.since!)
    // 倒序：最新在前
    const reversed = [...filtered].reverse()
    const total = reversed.length
    const offset = Math.max(0, filter.offset ?? 0)
    const limit = Math.max(1, filter.limit ?? 200)
    return { records: reversed.slice(offset, offset + limit), total }
  }

  clear(): void {
    this.ensureInitialized()
    this.records = []
    this.scheduleSave()
  }

  /** 应用退出前同步落盘（will-quit 钩子调用） */
  flushSync(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.saveNow()
  }
}

export const mcpAuditRepository = new McpAuditRepository()
