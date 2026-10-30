/**
 * MCP 审计日志仓库（B5）。
 *
 * 把 authorizeMcpOperation / confirmDestructiveIfNeeded 产生的审计事件持久化，
 * 供设置页"MCP 活动"面板查询。用户能回看 agent 这段时间做了什么——
 * 对一个能在生产服务器上跑命令的工具，可见性即信任。
 *
 * 实现：内存有界缓冲（用户可设置保留上限）+ 防抖落盘（2s），避免每次 append 都写盘。
 * 退出前由生命周期协调器捕获 revision 并 await flush()；绝不另启同步写入者。
 * 查询走内存，倒序返回（最新在前）。
 */
import { app } from 'electron'
import { join } from 'path'
import { existsSync, unlinkSync } from 'fs'
import { unlink } from 'fs/promises'
import log from 'electron-log'
import { v4 as uuidv4 } from 'uuid'
import { DEFAULT_MCP_AUDIT_RETENTION, isMcpAuditRetentionLimit, type McpAuditRetentionLimit, type McpAuditPersistenceState, type McpAuditQuery } from '@shared/mcp-audit'
export type { McpAuditQuery } from '@shared/mcp-audit'
import {
  atomicWriteFileSync,
  cloneJsonValue,
  JsonStoreLoadError,
  loadJsonFileSync,
  readJsonFileSync,
} from './atomic-json'
import { SerializedJsonWriter } from './serialized-json-writer'

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

export interface McpAuditFacets {
  /** 去重后的操作名（按字母序） */
  operations: string[]
  /** 去重后的会话（按会话名排序），供下拉选择 */
  sessions: { sessionId: string; sessionName?: string; sessionType?: string }[]
}

export class McpAuditRepository {
  private filePath: string | null = null
  private records: McpAuditRecord[] = []
  private loaded = false
  private writer: SerializedJsonWriter | null = null
  private draining = false
  private migratedFrom: string | null = null
  private retentionLimit: McpAuditRetentionLimit = DEFAULT_MCP_AUDIT_RETENTION
  private loadError: JsonStoreLoadError | null = null

  private ensureInitialized(): void {
    if (this.loaded) return
    this.loadRetention()
    this.filePath = join(app.getPath('logs'), 'mcp-audit.json')
    this.writer = new SerializedJsonWriter(this.filePath, () => {
      if (this.loadError) throw new Error('Audit log is read-only after load failure')
      return JSON.stringify(this.records, null, 2)
    }, {
      onFailure: failure => log.error('[MCP] Audit persistence failed:', failure)
    })
    this.load(join(app.getPath('userData'), 'mcp-audit.json'))
    this.loaded = true
  }

  private get settingsPath(): string {
    return join(app.getPath('userData'), 'config', 'mcp-audit-settings.json')
  }

  private loadRetention(): void {
    const result = readJsonFileSync<unknown>(this.settingsPath)
    if (result.status === 'missing') return
    if (result.status !== 'ok') {
      log.warn('[MCP] Failed to load audit retention settings, using default:', result.error)
      return
    }
    const settings = result.value
    if (settings && typeof settings === 'object' && 'retentionLimit' in settings
        && isMcpAuditRetentionLimit((settings as { retentionLimit?: unknown }).retentionLimit)) {
      this.retentionLimit = (settings as { retentionLimit: McpAuditRetentionLimit }).retentionLimit
    }
  }

  getRetentionLimit(): McpAuditRetentionLimit {
    this.ensureInitialized()
    return this.retentionLimit
  }

  setRetentionLimit(limit: McpAuditRetentionLimit): void {
    if (!isMcpAuditRetentionLimit(limit)) throw new Error('Invalid MCP audit retention limit')
    this.ensureInitialized()
    this.assertAcceptingWrites()
    // 先确认设置已保存，再裁剪记录；保存失败时不改当前上限和记录。
    atomicWriteFileSync(this.settingsPath, JSON.stringify({ retentionLimit: limit }, null, 2))
    this.retentionLimit = limit
    if (this.records.length > limit) {
      this.records = this.records.slice(-limit)
      this.scheduleSave()
    }
  }

  private load(legacyPath: string): void {
    if (!this.filePath) return
    // 清理旧版固定 .tmp 残留；新版临时文件名唯一，失败会自行清理，不读取。
    const tmp = `${this.filePath}.tmp`
    if (existsSync(tmp)) {
      try { unlinkSync(tmp) } catch { /* 被占用等:忽略,下次再清 */ }
    }
    // 新目录已有记录时以它为准，避免清空后又导入旧记录。
    const sourcePath = existsSync(this.filePath) ? this.filePath : legacyPath
    const result = loadJsonFileSync<unknown[]>(sourcePath, {
      validate: raw => {
        if (!Array.isArray(raw)) throw new Error('MCP audit log must be a JSON array')
        return raw
      }
    })
    if (result.status === 'missing') return
    if (result.status === 'failed') {
      // 线上文件损坏：保留原件并拒绝后续写盘，绝不拿空数组覆盖；旧位置损坏只告警，不迁移。
      if (sourcePath === this.filePath) {
        this.loadError = result.error
        log.error('[MCP] Failed to load audit log, keeping damaged file untouched:', result.error)
      } else {
        log.error('[MCP] Failed to load legacy audit log, keeping it untouched:', result.error)
      }
      return
    }
    const data = result.value as McpAuditRecord[]
    this.records = data.slice(-this.retentionLimit)
    if (data.length > this.retentionLimit) this.scheduleSave()
    if (result.status === 'recovered') {
      log.warn(`[MCP] Audit log was corrupt; restored from backup (damaged copy: ${result.preservedPath ?? 'unavailable'})`)
    }
    log.info(`[MCP] Loaded ${this.records.length} audit records`)
    // 异步迁移：新位置主文件提交确认后才删除旧文件；失败保留原件供显式重试。
    if (sourcePath !== this.filePath) {
      this.migratedFrom = legacyPath
      this.scheduleSave()
    }
  }

  private scheduleSave(): void {
    this.writer?.markDirty()
  }

  private assertAcceptingWrites(): void {
    if (this.draining) throw new Error('Audit repository is draining')
  }

  append(record: Omit<McpAuditRecord, 'id' | 'timestamp'>): void {
    this.ensureInitialized()
    this.assertAcceptingWrites()
    this.records.push({ id: uuidv4(), timestamp: new Date().toISOString(), ...record })
    if (this.records.length > this.retentionLimit) {
      this.records = this.records.slice(-this.retentionLimit)
    }
    this.scheduleSave()
  }

  query(filter: McpAuditQuery): { records: McpAuditRecord[]; total: number; persistence: McpAuditPersistenceState } {
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
    return { records: reversed.slice(offset, offset + limit).map(record => cloneJsonValue(record)), total, persistence: this.getPersistenceState() }
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

  async clear(): Promise<void> {
    this.ensureInitialized()
    this.assertAcceptingWrites()
    this.records = []
    this.scheduleSave()
    await this.flush()
  }

  getPersistenceState(): McpAuditPersistenceState {
    this.ensureInitialized()
    const state = this.writer!.getState()
    if (this.loadError && !state.lastFailure) {
      state.lastFailure = { revision: state.currentRevision, phase: 'primary', code: 'PERSISTENCE_FAILED' }
    }
    return state
  }

  /** 停止新变更并捕获退出屏障；flush 必须放入正常退出的总期限。 */
  stopAcceptingWrites(): number {
    this.ensureInitialized()
    this.draining = true
    return this.writer!.stopAcceptingWrites()
  }

  async flush(targetRevision?: number): Promise<void> {
    this.ensureInitialized()
    if (this.loadError) throw new Error('Persistence commit failed')
    await this.writer!.flush(targetRevision)
    if (this.migratedFrom && this.writer!.getState().committedRevision > 0) {
      const legacyPath = this.migratedFrom
      this.migratedFrom = null
      try { await unlink(legacyPath) } catch {
        log.warn('[MCP] New audit log committed; legacy cleanup was not confirmed')
      }
    }
  }
}

export const mcpAuditRepository = new McpAuditRepository()
