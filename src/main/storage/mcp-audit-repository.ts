/**
 * MCP 审计日志仓库（B5）。
 *
 * 把 authorizeMcpOperation / confirmDestructiveIfNeeded 产生的审计事件持久化，
 * 供设置页"MCP 活动"面板查询。用户能回看 agent 这段时间做了什么——
 * 对一个能在生产服务器上跑命令的工具，可见性即信任。
 *
 * 实现：内存有界缓冲（用户可设置保留上限）+ 防抖落盘（2s），避免每次 append 都写盘。
 * 退出前由 main/index.ts 的 will-quit 调 flushSync() 同步落盘，防丢最近事件。
 * 查询走内存，倒序返回（最新在前）。
 */
import { app } from 'electron'
import { dirname, join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs'
import log from 'electron-log'
import { v4 as uuidv4 } from 'uuid'
import { DEFAULT_MCP_AUDIT_RETENTION, isMcpAuditRetentionLimit, type McpAuditRetentionLimit } from '@shared/mcp-audit'

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
  /** ISO：仅返回此时间之前的记录 */
  until?: string
  limit?: number
  offset?: number
}

export interface McpAuditFacets {
  /** 去重后的操作名（按字母序） */
  operations: string[]
  /** 去重后的会话（按会话名排序），供下拉选择 */
  sessions: { sessionId: string; sessionName?: string; sessionType?: string }[]
}

const SAVE_DEBOUNCE_MS = 2000

export class McpAuditRepository {
  private filePath: string | null = null
  private records: McpAuditRecord[] = []
  private loaded = false
  private saveTimer: NodeJS.Timeout | null = null
  private retentionLimit: McpAuditRetentionLimit = DEFAULT_MCP_AUDIT_RETENTION

  private ensureInitialized(): void {
    if (this.loaded) return
    this.loadRetention()
    this.filePath = join(app.getPath('logs'), 'mcp-audit.json')
    this.load(join(app.getPath('userData'), 'mcp-audit.json'))
    this.loaded = true
  }

  private get settingsPath(): string {
    return join(app.getPath('userData'), 'config', 'mcp-audit-settings.json')
  }

  private loadRetention(): void {
    if (!existsSync(this.settingsPath)) return
    try {
      const settings: unknown = JSON.parse(readFileSync(this.settingsPath, 'utf-8'))
      if (settings && typeof settings === 'object' && 'retentionLimit' in settings
          && isMcpAuditRetentionLimit(settings.retentionLimit)) {
        this.retentionLimit = settings.retentionLimit
      }
    } catch (error) {
      log.warn('[MCP] Failed to load audit retention settings, using default:', error)
    }
  }

  getRetentionLimit(): McpAuditRetentionLimit {
    this.ensureInitialized()
    return this.retentionLimit
  }

  setRetentionLimit(limit: McpAuditRetentionLimit): void {
    if (!isMcpAuditRetentionLimit(limit)) throw new Error('Invalid MCP audit retention limit')
    this.ensureInitialized()
    const tmp = `${this.settingsPath}.tmp`
    // 先确认设置已保存，再裁剪记录；保存失败时不改当前上限和记录。
    try {
      mkdirSync(dirname(this.settingsPath), { recursive: true })
      writeFileSync(tmp, JSON.stringify({ retentionLimit: limit }, null, 2), 'utf-8')
      renameSync(tmp, this.settingsPath)
    } catch (error) {
      try { unlinkSync(tmp) } catch { /* 保留原设置，临时文件不参与读取 */ }
      throw error
    }
    this.retentionLimit = limit
    if (this.records.length > limit) {
      this.records = this.records.slice(-limit)
      this.scheduleSave()
    }
  }

  private load(legacyPath: string): void {
    if (!this.filePath) return
    // 清理上次崩溃可能残留的 .tmp(saveNow 先写 .tmp 再 rename,中途崩溃会留下)。
    // 不读取它——内容可能不完整,下次 saveNow 会重写;这里只删遗留。
    const tmp = `${this.filePath}.tmp`
    if (existsSync(tmp)) {
      try { unlinkSync(tmp) } catch { /* 被占用等:忽略,下次再清 */ }
    }
    // 新目录已有记录时以它为准，避免清空后又导入旧记录。
    const sourcePath = existsSync(this.filePath) ? this.filePath : legacyPath
    if (!existsSync(sourcePath)) return
    try {
      const content = readFileSync(sourcePath, 'utf-8')
      const data = JSON.parse(content)
      if (!Array.isArray(data)) return
      this.records = (data as McpAuditRecord[]).slice(-this.retentionLimit)
      if (data.length > this.retentionLimit) this.scheduleSave()
      log.info(`[MCP] Loaded ${this.records.length} audit records`)
      // 先在 logs 中成功落盘，再删除旧文件；跨盘安装、便携目录也可迁移。
      if (sourcePath !== this.filePath && this.saveNow()) {
        try { unlinkSync(legacyPath) } catch (e) {
          log.warn('[MCP] Failed to remove migrated audit log:', e)
        }
      }
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

  private saveNow(): boolean {
    if (!this.filePath) return false
    // 原子落盘：先写临时文件再 rename。替换失败时保留原文件，不能直写覆盖，
    // 否则磁盘写满或进程退出可能留下半份日志，旧记录迁移也会失去可靠的目标。
    const tmp = `${this.filePath}.tmp`
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileSync(tmp, JSON.stringify(this.records, null, 2), 'utf-8')
      renameSync(tmp, this.filePath)
      return true
    } catch (e) {
      log.error('[MCP] Failed to save audit log:', e)
      return false
    }
  }

  append(record: Omit<McpAuditRecord, 'id' | 'timestamp'>): void {
    this.ensureInitialized()
    this.records.push({ id: uuidv4(), timestamp: new Date().toISOString(), ...record })
    if (this.records.length > this.retentionLimit) {
      this.records = this.records.slice(-this.retentionLimit)
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
    if (filter.until) filtered = filtered.filter(r => r.timestamp <= filter.until!)
    // 倒序：最新在前
    const reversed = [...filtered].reverse()
    const total = reversed.length
    const offset = Math.max(0, filter.offset ?? 0)
    const limit = Math.max(1, filter.limit ?? 200)
    return { records: reversed.slice(offset, offset + limit), total }
  }

  /** 全量去重操作名/会话，供面板下拉选项。不随当前过滤变化--展示全集，便于用户任选。 */
  facets(): McpAuditFacets {
    this.ensureInitialized()
    const opSet = new Set<string>()
    const sessionMap = new Map<string, { sessionId: string; sessionName?: string; sessionType?: string }>()
    for (const r of this.records) {
      if (r.operation) opSet.add(r.operation)
      if (r.sessionId && !sessionMap.has(r.sessionId)) {
        sessionMap.set(r.sessionId, {
          sessionId: r.sessionId,
          sessionName: r.sessionName,
          sessionType: r.sessionType
        })
      }
    }
    return {
      operations: Array.from(opSet).sort(),
      sessions: Array.from(sessionMap.values()).sort((a, b) =>
        (a.sessionName || a.sessionId).localeCompare(b.sessionName || b.sessionId)
      )
    }
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
