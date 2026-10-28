import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { shelfWebUrl, DEFAULT_TASK_SHELF_PREFERENCES, parseShelfPreferences, type TaskShelfPreferences, type ShelfRecovery, type TaskShelfEntry } from '@shared/task-shelf'
import { ConnectionType } from '@shared/types/session'
import { atomicWriteFileSync, getConfigDir } from './repository'
import { captureSshContext, SSH_CONTEXT_LIMIT } from '../terminal/shelf-ssh-context'

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
    return { kind: 'web', url }
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
        ? ['web', recovery.url ?? '']
        : ['harness', recovery.sessionId ?? '', recovery.taskId ?? '', recovery.identity?.instanceId ?? '', recovery.identity?.instanceEpoch ?? '', recovery.lastState ?? '']
  return JSON.stringify([entry.resourceKey, entry.title, entry.workspace ?? '', entry.capability, parts, entry.context?.text ?? ''])
}

function clone(entry: TaskShelfEntry): TaskShelfEntry {
  return structuredClone(entry)
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

/**
 * 任务保存区仓储：单文件 version 1 归档，原子替换写入。
 * 全部校验通过后才替换内存；写入失败回滚内存并保留上次有效文件。
 */
export class TaskShelfRepository {
  private entries: TaskShelfEntry[] = []
  private loaded = false
  private preferences: TaskShelfPreferences = { ...DEFAULT_TASK_SHELF_PREFERENCES }

  constructor(private readonly file = join(getConfigDir(), 'task-shelf.json')) {}

  list(): TaskShelfEntry[] {
    this.ensureLoaded()
    return this.entries.map(clone)
  }

  get(id: string): TaskShelfEntry | undefined {
    this.ensureLoaded()
    const entry = this.entries.find(item => item.id === id)
    return entry ? clone(entry) : undefined
  }

  getPreferences(): TaskShelfPreferences { this.ensureLoaded(); return { ...this.preferences } }
  setPreferences(raw: TaskShelfPreferences): TaskShelfPreferences {
    this.ensureLoaded()
    const next = parseShelfPreferences(raw), previous = this.preferences
    this.preferences = next
    try { this.commit(this.entries) } catch (error) { this.preferences = previous; throw error }
    return { ...next }
  }
  archive(id: string, archived: boolean, now = Date.now()): TaskShelfEntry {
    this.ensureLoaded()
    const entry = this.entries.find(item => item.id === id)
    if (!entry) throw new Error('保存记录不存在')
    if (!!entry.archivedAt === archived) return clone(entry)
    const next = { ...entry, revision: entry.revision + 1, updatedAt: Math.max(now, entry.updatedAt + 1) }
    if (archived) next.archivedAt = now; else delete next.archivedAt
    this.commit(this.entries.map(item => item.id === id ? next : item))
    return clone(next)
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

  remove(id: string): boolean {
    this.ensureLoaded()
    const next = this.entries.filter(item => item.id !== id)
    if (next.length === this.entries.length) return false
    this.commit(next)
    return true
  }

  rename(id: string, rawTitle: string, now = Date.now()): TaskShelfEntry {
    this.ensureLoaded()
    const entry = this.entries.find(item => item.id === id)
    if (!entry) throw new Error('保存记录不存在')
    const title = requiredText(rawTitle, MAX_TITLE)
    if (title === entry.title) return clone(entry)
    const next: TaskShelfEntry = { ...entry, title, revision: entry.revision + 1, updatedAt: Math.max(now, entry.updatedAt + 1) }
    this.commit(this.entries.map(item => (item.id === id ? next : item)))
    return clone(next)
  }

  /** 先换内存再落盘；写失败回滚内存，磁盘上仍是上一次的有效文件。 */
  private commit(next: TaskShelfEntry[]): void {
    const previous = this.entries
    this.entries = next
    try {
      atomicWriteFileSync(this.file, JSON.stringify({ version: 1, entries: next, preferences: this.preferences }, null, 2))
    } catch (error) {
      this.entries = previous
      throw new Error(`保存区写入失败，保留上次有效文件：${(error as Error).message}`)
    }
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    const entries: TaskShelfEntry[] = []
    let preferences = { ...DEFAULT_TASK_SHELF_PREFERENCES }
    if (existsSync(this.file)) {
      let archive: Raw
      try {
        archive = asRecord(JSON.parse(readFileSync(this.file, 'utf8')) as unknown)
      } catch {
        damaged()
      }
      if (archive.version !== 1 || !Array.isArray(archive.entries)) damaged()
      if (archive.preferences !== undefined) { try { preferences = parseShelfPreferences(archive.preferences) } catch { damaged() } }
      if (archive.entries.length > TASK_SHELF_LIMIT) damaged()
      for (const item of archive.entries) entries.push(parseEntry(item))
      const ids = new Set<string>()
      const keys = new Set<string>()
      for (const entry of entries) {
        if (ids.has(entry.id) || keys.has(entry.resourceKey)) damaged()
        ids.add(entry.id)
        keys.add(entry.resourceKey)
      }
    }
    this.entries = entries
    this.preferences = preferences
    this.loaded = true
  }
}

export const taskShelfRepository = new TaskShelfRepository()
