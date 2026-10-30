import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import log from 'electron-log'
import { shelfWebUrl, DEFAULT_TASK_SHELF_PREFERENCES, LEGACY_TASK_SHELF_TOGGLE_SHORTCUT, parseShelfPreferences, type TaskShelfPreferences, type ShelfRecovery, type TaskShelfEntry } from '@shared/task-shelf'
import { ConnectionType } from '@shared/types/session'
import { atomicWriteFileSync, getConfigDir } from './repository'
import { JsonStoreLoadError, loadJsonFileSync, RevisionConflictError, writeBackupSync } from './atomic-json'
import { captureSshContext, SSH_CONTEXT_LIMIT } from '../terminal/shelf-ssh-context'
import type { ShelfWebSleep } from '@shared/task-shelf'

/** 保存区上限：满了只拒绝新增，绝不悄悄驱逐用户已经保存的任务。 */
export const TASK_SHELF_LIMIT = 100
const MAX_TITLE = 200
const MAX_WORKSPACE = 4096
const MAX_ID = 128
const MAX_RECOVERY_TEXT = 4096
const DAMAGED = 'Unsupported or damaged task shelf archive; original file retained'

const CAPABILITIES: readonly TaskShelfEntry['capability'][] = [
  'live-only',
  'local-live',
  'reconnect',
  'ssh-resume',
  'directory',
  'cli-resume',
  'cli-history',
  'web',
  'harness-history'
]
const AGENT_KINDS: readonly NonNullable<Extract<ShelfRecovery, { kind: 'terminal' }>['agentKind']>[] = [
  'codex',
  'claude',
  'dsh',
  'agent'
]
const CONNECTION_TYPES: readonly ConnectionType[] = [
  ConnectionType.SSH,
  ConnectionType.TELNET,
  ConnectionType.SERIAL,
  ConnectionType.LOCAL
]
const RESOURCE_KINDS = ['terminal', 'web', 'harness'] as const

type Raw = Record<string, unknown>

/** 归档格式不对时永不覆盖原文件：保留原文件让用户自己决定怎么处理。 */
function damaged(): never {
  throw new Error(DAMAGED)
}

function requiredText(value: unknown, max: number): string {
  if (typeof value !== 'string') damaged()
  const text = value.trim()
  if (!text || text.length > max) damaged()
  return text
}

function optionalText(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  return requiredText(value, max)
}

function asRecord(value: unknown): Raw {
  if (!value || typeof value !== 'object' || Array.isArray(value)) damaged()
  return value as Raw
}

function parseRecovery(raw: unknown): ShelfRecovery {
  const value = asRecord(raw)
  if (value.kind === 'harness') {
    const recovery: Extract<ShelfRecovery, { kind: 'harness' }> = { kind: 'harness' }
    if (value.sessionId !== undefined) recovery.sessionId = requiredText(value.sessionId, MAX_ID)
    if (value.taskId !== undefined) recovery.taskId = requiredText(value.taskId, MAX_ID)
    if (value.lastState !== undefined) recovery.lastState = requiredText(value.lastState, 64)
    if (value.identity !== undefined) {
      const identity = asRecord(value.identity)
      if (!Number.isSafeInteger(identity.instanceEpoch) || (identity.instanceEpoch as number) < 1) damaged()
      recovery.identity = { instanceId: requiredText(identity.instanceId, MAX_ID), instanceEpoch: identity.instanceEpoch as number }
    }
    return recovery
  }
  if (value.kind === 'web') {
    if (value.url === undefined || value.url === null) return { kind: 'web' }
    // 落盘地址必须仍然过一遍共享脱敏判据：手工改回敏感地址不会复活。
    const url = shelfWebUrl(requiredText(value.url, MAX_RECOVERY_TEXT))
    if (!url) damaged()
    const recovery: Extract<ShelfRecovery, { kind: 'web' }> = { kind: 'web', url }
    if (value.readonlyMode === true) recovery.readonlyMode = true
    if (value.reloadableMode === true) recovery.reloadableMode = true
    if (recovery.readonlyMode && recovery.reloadableMode) damaged()
    if (value.sleep !== undefined) {
      const sleep = asRecord(value.sleep)
      const validPartition = recovery.readonlyMode ? typeof sleep.partition === 'string' && /^shelf-readonly-v1:[a-f0-9-]{36}$/.test(sleep.partition) : recovery.reloadableMode && sleep.partition === 'persist:webbar'
      if (!validPartition || typeof sleep.partition !== 'string' || sleep.formatVersion !== 1 || sleep.url !== url ||
        !Number.isSafeInteger(sleep.recordedAt) || (sleep.recordedAt as number) < 1 ||
        typeof sleep.zoom !== 'number' || !Number.isFinite(sleep.zoom) || sleep.zoom < 0.25 || sleep.zoom > 5 ||
        typeof sleep.scrollY !== 'number' || !Number.isFinite(sleep.scrollY) || sleep.scrollY < 0 || sleep.scrollY > 10_000_000) damaged()
      recovery.sleep = { formatVersion: 1, url, partition: sleep.partition, taskId: requiredText(sleep.taskId, MAX_ID), resourceId: requiredText(sleep.resourceId, 512), suspendOperationId: requiredText(sleep.suspendOperationId, MAX_ID), recordedAt: sleep.recordedAt as number, zoom: sleep.zoom, scrollY: sleep.scrollY }
    }
    return recovery
  }
  if (value.kind !== 'terminal') damaged()
  const type = value.type
  if (typeof type !== 'string' || !CONNECTION_TYPES.includes(type as ConnectionType)) damaged()
  const recovery: Extract<ShelfRecovery, { kind: 'terminal' }> = {
    kind: 'terminal',
    sessionId: requiredText(value.sessionId, MAX_ID),
    type: type as ConnectionType
  }
  const sessionConfigId = optionalText(value.sessionConfigId, MAX_ID)
  // POSIX 目录中的尾部空格属于名称，不能按标题规则 trim 后恢复到另一个目录。
  const cwd = value.cwd === undefined || value.cwd === null ? undefined : (() => {
    requiredText(value.cwd, MAX_RECOVERY_TEXT)
    return value.cwd as string
  })()
  const agentId = optionalText(value.agentId, MAX_ID)
  const cliSessionId = optionalText(value.cliSessionId, MAX_ID)
  const agentKind =
    value.agentKind === undefined || value.agentKind === null
      ? undefined
      : (() => {
          const kind = value.agentKind
          if (typeof kind !== 'string' || !AGENT_KINDS.includes(kind as (typeof AGENT_KINDS)[number])) damaged()
          return kind as (typeof AGENT_KINDS)[number]
        })()
  if (sessionConfigId) recovery.sessionConfigId = sessionConfigId
  if (cwd) recovery.cwd = cwd
  if (agentKind) recovery.agentKind = agentKind
  if (agentId) recovery.agentId = agentId
  if (cliSessionId) recovery.cliSessionId = cliSessionId
  if (value.cliObservationLost !== undefined) {
    if (typeof value.cliObservationLost !== 'boolean') damaged()
    recovery.cliObservationLost = value.cliObservationLost
  }
  if (value.connectionKey !== undefined) {
    if (typeof value.connectionKey !== 'string' || !/^[a-f0-9]{64}$/.test(value.connectionKey)) damaged()
    recovery.connectionKey = value.connectionKey
  }
  if (value.tmuxSession !== undefined) {
    if (typeof value.tmuxSession !== 'string' || !/^lyshell[-_][a-zA-Z0-9_-]{1,56}$/.test(value.tmuxSession)) damaged()
    recovery.tmuxSession = value.tmuxSession
  }
  if (value.localHostId !== undefined) {
    if (typeof value.localHostId !== 'string' || !/^[a-f0-9-]{36}$/i.test(value.localHostId)) damaged()
    recovery.localHostId = value.localHostId
  }
  return recovery
}

/**
 * 旧版默认展开键（Ctrl+Shift+J）迁移成新默认（Ctrl+`）。
 * 只认没有版本标记的旧归档里的这一个历史默认值：其余自定义组合和空字符串
 * （禁用）都原样保留；新归档带 preferencesVersion，用户显式存下的任何值不再迁移。
 */
function migrateShelfPreferences(preferences: TaskShelfPreferences): TaskShelfPreferences {
  if (preferences.toggleShortcut !== LEGACY_TASK_SHELF_TOGGLE_SHORTCUT) return preferences
  return { ...preferences, toggleShortcut: DEFAULT_TASK_SHELF_PREFERENCES.toggleShortcut }
}

/** 只重建白名单字段：旧版本遗留或手工塞入的 command/env/password/cookie 一律丢弃。 */
function parseEntry(raw: unknown): TaskShelfEntry {
  const value = asRecord(raw)
  const recovery = parseRecovery(value.recovery)
  const resourceKey = requiredText(value.resourceKey, MAX_ID + 16)
  const separator = resourceKey.indexOf(':')
  if (separator <= 0) damaged()
  const keyKind = resourceKey.slice(0, separator)
  if (!(RESOURCE_KINDS as readonly string[]).includes(keyKind)) damaged()
  if (keyKind !== recovery.kind) damaged()
  if (!resourceKey.slice(separator + 1)) damaged()
  const capability = value.capability
  if (typeof capability !== 'string' || !CAPABILITIES.includes(capability as TaskShelfEntry['capability'])) damaged()
  const createdAt = value.createdAt
  const updatedAt = value.updatedAt
  const revision = value.revision
  if (typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt < 1) damaged()
  if (typeof updatedAt !== 'number' || !Number.isSafeInteger(updatedAt) || updatedAt < 1) damaged()
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) damaged()
  const workspace = optionalText(value.workspace, MAX_WORKSPACE)
  const entry: TaskShelfEntry = {
    id: requiredText(value.id, MAX_ID),
    resourceKey,
    title: requiredText(value.title, MAX_TITLE),
    createdAt,
    updatedAt,
    revision,
    recovery,
    capability: capability as TaskShelfEntry['capability']
  }
  if (recovery.kind === 'web' && recovery.sleep && recovery.sleep.taskId !== entry.id) damaged()
  if (workspace) entry.workspace = workspace
  if (value.context !== undefined) {
    const context = asRecord(value.context)
    if (recovery.kind !== 'terminal' || recovery.type !== ConnectionType.SSH || typeof context.text !== 'string' || context.text.length > SSH_CONTEXT_LIMIT || !Number.isSafeInteger(context.capturedAt) || (context.capturedAt as number) < 1) damaged()
    const text = captureSshContext(context.text)
    if (text) entry.context = { text, capturedAt: context.capturedAt as number }
  }
  if (value.archivedAt !== undefined) {
    if (!Number.isSafeInteger(value.archivedAt) || (value.archivedAt as number) < 1) damaged()
    entry.archivedAt = value.archivedAt as number
  }
  return entry
}

/** 显式字段序列化：不受对象键顺序影响，用来判断「有效内容是否真的变了」。 */
function fingerprint(entry: TaskShelfEntry): string {
  const recovery = entry.recovery
  const parts =
    recovery.kind === 'terminal'
      ? [
          'terminal',
          recovery.sessionId,
          recovery.type,
          recovery.sessionConfigId ?? '',
          recovery.cwd ?? '',
          recovery.agentKind ?? '',
          recovery.agentId ?? '',
          recovery.cliSessionId ?? '', recovery.cliObservationLost ?? false, recovery.connectionKey ?? '', recovery.tmuxSession ?? '', recovery.localHostId ?? ''
        ]
      : recovery.kind === 'web'
        ? ['web', recovery.url ?? '', recovery.readonlyMode ?? false, recovery.reloadableMode ?? false, recovery.sleep ?? null]
        : ['harness', recovery.sessionId ?? '', recovery.taskId ?? '', recovery.identity?.instanceId ?? '', recovery.identity?.instanceEpoch ?? '', recovery.lastState ?? '']
  return JSON.stringify([entry.resourceKey, entry.title, entry.workspace ?? '', entry.capability, parts, entry.context?.text ?? ''])
}

function clone(entry: TaskShelfEntry): TaskShelfEntry {
  return structuredClone(entry)
}

/**
 * 校验整份归档。任何未知 schema / 版本不符 / 重复键都视为损坏：调用方保留原文件，
 * 绝不用默认值或空列表覆盖（项目场景归档同纪律）。
 */
function parseArchive(raw: unknown): { entries: TaskShelfEntry[]; preferences: TaskShelfPreferences } {
  const archive = asRecord(raw)
  if (archive.version !== 1 || !Array.isArray(archive.entries)) damaged()
  let preferences: TaskShelfPreferences = { ...DEFAULT_TASK_SHELF_PREFERENCES }
  if (archive.preferences !== undefined) {
    try {
      const saved = parseShelfPreferences(archive.preferences)
      // 旧归档没有版本标记：只在这时把历史默认展开键换成新默认。
      preferences = archive.preferencesVersion === 2 ? saved : migrateShelfPreferences(saved)
    } catch {
      damaged()
    }
  }
  if (archive.entries.length > TASK_SHELF_LIMIT) damaged()
  const entries = archive.entries.map(parseEntry)
  const ids = new Set<string>()
  const keys = new Set<string>()
  for (const entry of entries) {
    if (ids.has(entry.id) || keys.has(entry.resourceKey)) damaged()
    ids.add(entry.id)
    keys.add(entry.resourceKey)
  }
  return { entries, preferences }
}

export interface ShelfCaptureInput {
  resourceKey: string
  title: string
  workspace?: string
  recovery: ShelfRecovery
  capability: TaskShelfEntry['capability']
  context?: TaskShelfEntry['context']
  /** 恢复出的新实例重新收纳时，用它把老记录改绑到新 resourceKey。 */
  entryId?: string
}

export interface ShelfCaptureResult {
  entry: TaskShelfEntry
  created: boolean
  changed: boolean
}

/** 分类结果：moved 表示本次改成了目标分类；already* 表示无需变更；conflict/missing 不写；failed 由原子写入失败统一标记。 */
export type ShelfArchiveStatus = 'moved' | 'alreadyArchived' | 'alreadyTasks' | 'conflict' | 'missing' | 'failed'

export interface ShelfArchiveBatchResult {
  items: Array<{ id: string; status: ShelfArchiveStatus }>
  committed: boolean
  error?: string
}

/**
 * 任务保存区仓储：单文件 version 1 归档，原子替换写入。
 * 全部校验通过后才替换内存；写入失败回滚内存并保留上次有效文件。
 */
export class TaskShelfRepository {
  private entries: TaskShelfEntry[] = []
  private loaded = false
  private preferences: TaskShelfPreferences = { ...DEFAULT_TASK_SHELF_PREFERENCES }
  private revision = 0
  private loadError: JsonStoreLoadError | null = null

  constructor(private readonly file = join(getConfigDir(), 'task-shelf.json')) {}

  getRevision(): number {
    this.ensureLoaded()
    return this.revision
  }

  getLoadError(): JsonStoreLoadError | null {
    try { this.ensureLoaded() } catch { /* 健康查询返回保存的错误，业务读写仍抛错。 */ }
    return this.loadError
  }

  private assertRevision(expectedRevision: number | undefined): void {
    if (expectedRevision === undefined) return
    if (expectedRevision !== this.revision) {
      throw new RevisionConflictError(this.file, expectedRevision, this.revision)
    }
  }

  list(): TaskShelfEntry[] {
    this.ensureLoaded()
    return this.entries.map(clone)
  }

  get(id: string): TaskShelfEntry | undefined {
    this.ensureLoaded()
    const entry = this.entries.find(item => item.id === id)
    return entry ? clone(entry) : undefined
  }

  /** 归档文件的绝对路径：scopeId 由它派生，测试也用它检查落盘内容。 */
  get filePath(): string { return this.file }

  /** 仅 main 的可丢弃契约接入层调用；与分类共用同步原子提交点。 */
  saveWebSleep(id: string, expectedRevision: number, sleep: ShelfWebSleep): TaskShelfEntry {
    const entry = this.get(id)
    if (!entry || entry.revision !== expectedRevision || entry.recovery.kind !== 'web' || !(entry.recovery.readonlyMode || entry.recovery.reloadableMode) || entry.capability !== 'web' || sleep.taskId !== id) throw new Error('网页保存记录已变化')
    const recovery = parseRecovery({ kind: 'web', url: sleep.url, ...(entry.recovery.readonlyMode ? { readonlyMode: true } : { reloadableMode: true }), sleep })
    const next = { ...entry, recovery, revision: entry.revision + 1, updatedAt: Math.max(Date.now(), entry.updatedAt + 1) }
    this.commit(this.entries.map(item => item.id === id ? next : item))
    return clone(next)
  }

  /** 宿主显式同意仅对当前保存的 URL 生效；撤销时移除旧睡眠快照。 */
  setWebReloadable(id: string, url: string, enabled: boolean): TaskShelfEntry {
    const entry = this.get(id)
    if (!entry || entry.capability !== 'web' || entry.recovery.kind !== 'web' || entry.recovery.readonlyMode || entry.recovery.url !== url || !shelfWebUrl(url)) throw new Error('网页保存记录已变化，请重新收纳当前页面')
    const recovery = parseRecovery({ kind: 'web', url, ...(enabled ? { reloadableMode: true } : {}) })
    const next = { ...entry, recovery, revision: entry.revision + 1, updatedAt: Math.max(Date.now(), entry.updatedAt + 1) }
    this.commit(this.entries.map(item => item.id === id ? next : item))
    return clone(next)
  }

  /**
   * 当前文件内容摘要；启动重试据此识别「合法外部更新」，不覆盖别人的写入。
   * 只有「文件确实不存在」(ENOENT) 才返回 undefined；其余读取异常一律抛出，
   * 否则会被当成「没有变化」从而绕过外部更新检查。
   */
  diskDigest(): string | undefined {
    let data: Buffer
    try {
      data = readFileSync(this.file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new Error(`读取任务保存区失败：${(error as Error).message}`)
    }
    return createHash('sha256').update(data).digest('hex')
  }

  getPreferences(): TaskShelfPreferences { this.ensureLoaded(); return { ...this.preferences } }
  setPreferences(raw: TaskShelfPreferences, options: { expectedRevision?: number } = {}): TaskShelfPreferences {
    this.ensureLoaded()
    const next = parseShelfPreferences(raw), previous = this.preferences
    this.preferences = next
    try { this.commit(this.entries, options.expectedRevision) } catch (error) { this.preferences = previous; throw error }
    return { ...next }
  }
  archive(id: string, archived: boolean, now = Date.now(), options: { expectedRevision?: number } = {}): TaskShelfEntry {
    this.ensureLoaded()
    const entry = this.entries.find(item => item.id === id)
    if (!entry) throw new Error('保存记录不存在')
    if (!!entry.archivedAt === archived) return clone(entry)
    const next = { ...entry, revision: entry.revision + 1, updatedAt: Math.max(now, entry.updatedAt + 1) }
    if (archived) next.archivedAt = now; else delete next.archivedAt
    this.commit(this.entries.map(item => item.id === id ? next : item), options.expectedRevision)
    return clone(next)
  }

  /**
   * 批量归档：退出或启动补归档时一次收起全部未归档记录。
   * 每条与单项 archive 语义一致（archivedAt=now、revision+1、updatedAt 只前进），
   * 整批一次 commit 原子落盘；没有待归档项时不写盘；写失败整体回滚内存。
   * 生命周期调用（何时退出/补归档）由上层负责，这里不隐式执行。
   */
  archiveAll(now = Date.now(), options: { expectedRevision?: number } = {}): TaskShelfEntry[] {
    this.ensureLoaded()
    let pending = false
    const next = this.entries.map(entry => {
      if (entry.archivedAt !== undefined) return entry
      pending = true
      return { ...entry, archivedAt: now, revision: entry.revision + 1, updatedAt: Math.max(now, entry.updatedAt + 1) }
    })
    if (!pending) return this.entries.map(clone)
    this.commit(next, options.expectedRevision)
    return this.entries.map(clone)
  }

  /**
   * 归档区「全部移回 Tasks」：只摘掉已归档记录的 archivedAt，改的是列表归属，不是运行态。
   * 每条与单项 archive(id, false) 语义一致（revision+1、updatedAt 只前进），
   * 恢复元数据、工作区、SSH 上下文与偏好全部原样保留；整批一次 commit 原子落盘，
   * 没有可移回项时不写盘，写失败整体回滚内存并保留上次有效文件。
   * 恢复/启动由上层显式指令负责，这里绝不触发任何运行资源行为。
   */
  unarchiveAll(now = Date.now(), options: { expectedRevision?: number } = {}): TaskShelfEntry[] {
    this.ensureLoaded()
    let pending = false
    const next = this.entries.map(entry => {
      if (entry.archivedAt === undefined) return entry
      pending = true
      const unarchived: TaskShelfEntry = { ...entry, revision: entry.revision + 1, updatedAt: Math.max(now, entry.updatedAt + 1) }
      delete unarchived.archivedAt
      return unarchived
    })
    if (!pending) return this.entries.map(clone)
    this.commit(next, options.expectedRevision)
    return this.entries.map(clone)
  }

  capture(input: ShelfCaptureInput, now = Date.now()): ShelfCaptureResult {
    this.ensureLoaded()
    const title = requiredText(input.title, MAX_TITLE)
    const workspace = optionalText(input.workspace, MAX_WORKSPACE)
    const resourceKey = requiredText(input.resourceKey, MAX_ID + 16)

    const rebound = input.entryId ? this.entries.find(item => item.id === input.entryId) : undefined
    if (input.entryId && !rebound) throw new Error('保存记录不存在')
    // 正常收纳按 resourceKey 去重；entryId 只在「恢复后重新收纳」时把老记录改绑到新实例。
    const existing = rebound ?? this.entries.find(item => item.resourceKey === resourceKey)
    if (rebound && rebound.recovery.kind !== input.recovery.kind) throw new Error('不能把保存任务改绑到不同的资源类型')
    if (rebound && this.entries.some(item => item.id !== rebound.id && item.resourceKey === resourceKey)) throw new Error('该页签已经属于另一条保存记录')

    if (!existing) {
      if (this.entries.length >= TASK_SHELF_LIMIT) {
        throw new Error(`保存区已满（最多 ${TASK_SHELF_LIMIT} 项）；请先移除不再需要的任务`)
      }
      const created: TaskShelfEntry = {
        id: randomUUID(),
        resourceKey,
        title,
        createdAt: now,
        updatedAt: now,
        revision: 1,
        recovery: input.recovery,
        capability: input.capability
      }
      if (workspace) created.workspace = workspace
      if (input.context) created.context = input.context
      this.commit([...this.entries, created])
      return { entry: clone(created), created: true, changed: true }
    }

    const next: TaskShelfEntry = {
      ...existing,
      resourceKey,
      title,
      recovery: input.recovery,
      capability: input.capability
    }
    if (workspace) next.workspace = workspace
    else delete next.workspace
    if (input.context) next.context = input.context
    else delete next.context

    if (fingerprint(existing) === fingerprint(next)) {
      // 重复收纳同一份有效内容：不算变更，不动 updatedAt/revision，也不写盘。
      return { entry: clone(existing), created: false, changed: false }
    }
    next.revision = existing.revision + 1
    next.updatedAt = Math.max(now, existing.updatedAt + 1)
    this.commit(this.entries.map(item => (item.id === existing.id ? next : item)))
    return { entry: clone(next), created: false, changed: true }
  }

  /**
   * 分类命令唯一写入点：在串行执行区内按版本判定每项状态，成功项按请求顺序追加到 Tasks 末尾；
   * 单次原子写入失败时全部待改项记 failed，内存与磁盘都保持原分类。
   */
  archiveBatch(items: ReadonlyArray<{ id: string; expectedRevision: number }>, now = Date.now()): ShelfArchiveBatchResult {
    this.ensureLoaded()
    const moved = new Map<string, TaskShelfEntry>()
    const statuses = items.map(item => {
      if (moved.has(item.id)) return { id: item.id, status: 'conflict' as const }
      const entry = this.entries.find(candidate => candidate.id === item.id)
      if (!entry) return { id: item.id, status: 'missing' as const }
      // 先校验版本再判定分类：旧快照不能覆盖别人之后的修改。
      if (entry.revision !== item.expectedRevision) return { id: item.id, status: 'conflict' as const }
      if (!entry.archivedAt) return { id: item.id, status: 'alreadyTasks' as const }
      const next: TaskShelfEntry = { ...entry, revision: entry.revision + 1, updatedAt: Math.max(now, entry.updatedAt + 1) }
      delete next.archivedAt
      moved.set(entry.id, next)
      return { id: item.id, status: 'moved' as const }
    })
    if (moved.size === 0) return { items: statuses, committed: false }
    // 尚未移动的记录保持原相对顺序，成功项按请求顺序追加到 Tasks 末尾。
    // 只能按 moved 的唯一键迭代：重复 id 在 items 里只能出现一次，否则会把同一记录重复持久化。
    const next = [...this.entries.filter(entry => !moved.has(entry.id)), ...moved.values()]
    try {
      this.commit(next)
      return { items: statuses, committed: true }
    } catch (error) {
      return {
        items: statuses.map(item => item.status === 'moved' ? { id: item.id, status: 'failed' as const } : item),
        committed: false,
        error: (error as Error).message
      }
    }
  }

  /**
   * 启动归档唯一写入点：把固定快照里的记录标为 Archive（archivedAt），保持既有顺序。
   * 单次原子写入失败时全部待改项记 failed，内存与磁盘都保持原分类。
   */
  archiveSnapshot(items: ReadonlyArray<{ id: string; expectedRevision: number }>, now = Date.now()): ShelfArchiveBatchResult {
    this.ensureLoaded()
    const changed = new Map<string, TaskShelfEntry>()
    const statuses = items.map(item => {
      if (changed.has(item.id)) return { id: item.id, status: 'conflict' as const }
      const entry = this.entries.find(candidate => candidate.id === item.id)
      if (!entry) return { id: item.id, status: 'missing' as const }
      // 先校验版本再判定分类：旧快照不能覆盖别人之后的修改。
      if (entry.revision !== item.expectedRevision) return { id: item.id, status: 'conflict' as const }
      if (entry.archivedAt) return { id: item.id, status: 'alreadyArchived' as const }
      const next: TaskShelfEntry = { ...entry, archivedAt: now, revision: entry.revision + 1, updatedAt: Math.max(now, entry.updatedAt + 1) }
      changed.set(entry.id, next)
      return { id: item.id, status: 'moved' as const }
    })
    if (changed.size === 0) return { items: statuses, committed: false }
    try {
      this.commit(this.entries.map(entry => changed.get(entry.id) ?? entry))
      return { items: statuses, committed: true }
    } catch (error) {
      return {
        items: statuses.map(item => item.status === 'moved' ? { id: item.id, status: 'failed' as const } : item),
        committed: false,
        error: (error as Error).message
      }
    }
  }

  remove(id: string, options: { expectedRevision?: number } = {}): boolean {
    this.ensureLoaded()
    const next = this.entries.filter(item => item.id !== id)
    if (next.length === this.entries.length) return false
    this.commit(next, options.expectedRevision)
    return true
  }

  rename(id: string, rawTitle: string, now = Date.now(), options: { expectedRevision?: number } = {}): TaskShelfEntry {
    this.ensureLoaded()
    const entry = this.entries.find(item => item.id === id)
    if (!entry) throw new Error('保存记录不存在')
    const title = requiredText(rawTitle, MAX_TITLE)
    if (title === entry.title) return clone(entry)
    const next: TaskShelfEntry = { ...entry, title, revision: entry.revision + 1, updatedAt: Math.max(now, entry.updatedAt + 1) }
    this.commit(this.entries.map(item => (item.id === id ? next : item)), options.expectedRevision)
    return clone(next)
  }

  /** 先校验 revision，再换内存写盘；写失败回滚内存，磁盘上仍是上一次的有效文件。 */
  private commit(next: TaskShelfEntry[], expectedRevision?: number): void {
    this.assertRevision(expectedRevision)
    const previous = this.entries
    this.entries = next
    try {
      const json = JSON.stringify({ version: 1, preferencesVersion: 2, entries: next, preferences: this.preferences }, null, 2)
      atomicWriteFileSync(this.file, json)
      if (!writeBackupSync(this.file, json)) {
        log.warn('Failed to refresh task shelf backup; primary commit succeeded')
      }
      this.revision += 1
    } catch (error) {
      this.entries = previous
      throw new Error(`保存区写入失败，保留上次有效文件：${(error as Error).message}`)
    }
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    // 任务保存区是用户手工整理过的归档：损坏时优先保留原件并显式报错，不自动回滚到
    // 旧备份（备份仍会在每次成功提交后刷新，供人工恢复）。
    const result = loadJsonFileSync<{ entries: TaskShelfEntry[]; preferences: TaskShelfPreferences }>(this.file, {
      validate: parseArchive,
      backup: false
    })
    if (result.status === 'missing') {
      this.entries = []
      this.preferences = { ...DEFAULT_TASK_SHELF_PREFERENCES }
      this.loadError = null
      this.loaded = true
      return
    }
    if (result.status === 'failed') {
      this.loadError = result.error
      // 保留统一的对外文案（上层按它提示「原件已保留」），细节写入日志便于定位。
      log.error('Failed to load task shelf archive, keeping damaged file untouched:', result.error)
      throw new Error(`${DAMAGED}: ${result.error.message}`)
    }
    this.entries = result.value.entries
    this.preferences = result.value.preferences
    this.loadError = null
    this.loaded = true
  }
}

export const taskShelfRepository = new TaskShelfRepository()
