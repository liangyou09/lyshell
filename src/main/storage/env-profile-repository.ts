import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import log from 'electron-log'
import { v4 as uuidv4 } from 'uuid'
import { getConfigDir } from './repository'
import { normalizeEnv } from './harness-workspace-repository'
import { HARNESS_AGENT_KINDS, type HarnessAgentKind, type HarnessEnvProfile } from '@shared/harness'

/**
 * 全局环境变量组存储 —— dsh / codex / claude 三个 harness kind 与通用 Agent 共用一份库
 * （单文件 env-profiles.json）。同组可被多个 kind 各自启用、被任意 Agent 绑定。
 *
 * 文件格式：{ profiles: [...], activeByKind: { dsh?, codex?, claude? } }。
 * profile 本身不携带启用态 —— 「启用」是每个 kind 一根指针（activeByKind），
 * 指针与库同文件落盘，避免「组删了、指针还指着」的跨文件错位（delete 时顺手清指针）。
 * 通用 Agent 无「启用」概念，只有显式绑定（AgentConfig.envProfileId，悬空回落内联 env）。
 *
 * 健壮性纪律照搬 HarnessWorkspaceRepository：
 * load 过滤非法记录 / 首个有效 id 去重 / order 重排 0..n-1 / save 失败回滚内存 / 懒加载。
 * 旧 per-kind 文件（dsh/codex/claude-env-profiles.json）由 harness/migrate-profiles.ts
 * 一次性并入，本仓库只认新格式。
 */

/** 变量组总数上限 —— 兜手工编辑出的病态文件，超出部分丢弃（正常使用远达不到） */
const MAX_PROFILES = 256

/** 单组模型选项上限 —— 与 MAX_PROFILES 同思路，兜手工编辑的病态文件 */
const MAX_MODELS = 64

/**
 * 归一化模型选项：非数组按缺失处理；非字符串/空串项丢弃；trim + 去重 + 截断到上限。
 * 归一化后为空返回 undefined（不写键）。
 */
function normalizeModels(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const model = item.trim()
    if (model) seen.add(model)
    if (seen.size >= MAX_MODELS) break
  }
  return seen.size > 0 ? [...seen] : undefined
}

/**
 * 归一化单条 profile JSON 记录：非法记录返回 null（由 load 过滤）。
 * env 走与工作区同一份 normalizeEnv（空 key / NUL / 非字符串一律丢弃），
 * 归一化后为空的变量组按非法处理 —— 零变量的组没有意义，留着只会在 UI 里当噪声。
 * 导出供 migrate-profiles.ts 解析旧 per-kind 文件的记录（旧记录多一个 active 字段，单独读）。
 */
export function normalizeProfile(raw: unknown): HarnessEnvProfile | null {
  if (typeof raw !== 'object' || raw === null) return null
  const p = raw as Record<string, unknown>
  if (typeof p.id !== 'string' || p.id.length === 0) return null
  if (typeof p.name !== 'string' || p.name.length === 0) return null
  if (typeof p.order !== 'number' || !Number.isFinite(p.order)) return null
  const env = normalizeEnv(p.env)
  if (env === undefined) return null
  // note 非字符串按缺失处理（不因备注脏数据丢整条记录）
  const note = typeof p.note === 'string' && p.note.length > 0 ? p.note : undefined
  const models = normalizeModels(p.models)
  return {
    id: p.id,
    name: p.name,
    order: p.order,
    env,
    ...(note !== undefined ? { note } : {}),
    ...(models !== undefined ? { models } : {})
  }
}

/** 全局库文件内容的运行期形态 */
interface EnvProfileFile {
  profiles: HarnessEnvProfile[]
  activeByKind: Partial<Record<HarnessAgentKind, string>>
}

/**
 * 归一化整份文件：非对象（含旧数组格式）按损坏处理为空库；profiles 走
 * 过滤 → 去重 → 排序 → reindex 流水线；activeByKind 只认已知 kind 的字符串指针，
 * 且指针指向不存在的组时丢弃（等价「无启用」，不把悬空 id 落回盘上）。
 */
function normalizeFile(raw: unknown): EnvProfileFile {
  const empty: EnvProfileFile = { profiles: [], activeByKind: {} }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return empty
  const obj = raw as Record<string, unknown>
  const rawList = Array.isArray(obj.profiles) ? obj.profiles : []

  // 过滤非法记录 → 按首个有效 id 去重 → 按 order 稳定排序 → reindex 为 0..n-1 → 截断到上限
  const seen = new Set<string>()
  const profiles = rawList
    .map(normalizeProfile)
    .filter((p): p is HarnessEnvProfile => p !== null)
    .filter((p) => {
      if (seen.has(p.id)) return false
      seen.add(p.id)
      return true
    })
    .sort((a, b) => a.order - b.order)
    .slice(0, MAX_PROFILES)
    .map((p, i) => ({ ...p, order: i }))

  const activeByKind: Partial<Record<HarnessAgentKind, string>> = {}
  const rawActive = obj.activeByKind
  if (typeof rawActive === 'object' && rawActive !== null) {
    for (const kind of HARNESS_AGENT_KINDS) {
      const v = (rawActive as Record<string, unknown>)[kind]
      if (typeof v === 'string' && v.length > 0 && seen.has(v)) activeByKind[kind] = v
    }
  }
  return { profiles, activeByKind }
}

export class EnvProfileRepository {
  private readonly fileName: string
  private filePath: string | null = null
  private profiles: HarnessEnvProfile[] = []
  private activeByKind: Partial<Record<HarnessAgentKind, string>> = {}
  private loaded: boolean = false

  constructor(fileName: string) {
    this.fileName = fileName
  }

  private ensureInitialized(): void {
    if (!this.filePath) {
      this.filePath = join(getConfigDir(), this.fileName)
      this.load()
    }
  }

  private load(): void {
    if (!this.filePath || this.loaded) return

    if (!existsSync(this.filePath)) {
      this.profiles = []
      this.activeByKind = {}
      this.loaded = true
      return
    }

    try {
      const content = readFileSync(this.filePath, 'utf-8')
      const normalized = normalizeFile(JSON.parse(content))
      this.profiles = normalized.profiles
      this.activeByKind = normalized.activeByKind
      log.info(`Loaded ${this.profiles.length} env profiles from ${this.fileName}`)
      this.loaded = true
    } catch (error) {
      log.error(`Failed to load env profiles (${this.fileName}):`, error)
      this.profiles = []
      this.activeByKind = {}
      this.loaded = true
    }
  }

  private save(): boolean {
    if (!this.filePath) return false
    try {
      writeFileSync(this.filePath, JSON.stringify({ profiles: this.profiles, activeByKind: this.activeByKind }, null, 2), 'utf-8')
      return true
    } catch (error) {
      log.error(`Failed to save env profiles (${this.fileName}):`, error)
      return false
    }
  }

  getAll(): HarnessEnvProfile[] {
    this.ensureInitialized()
    return [...this.profiles].sort((a, b) => a.order - b.order)
  }

  get(id: string): HarnessEnvProfile | undefined {
    this.ensureInitialized()
    return this.profiles.find((p) => p.id === id)
  }

  /** 当前 kind 的启用指针 id；无启用返回 undefined（调用方据此回落系统环境变量） */
  getActiveProfileId(kind: HarnessAgentKind): string | undefined {
    this.ensureInitialized()
    return this.activeByKind[kind]
  }

  /** 当前 kind 启用的变量组；指针悬空（组已删）按无启用处理 */
  getActiveProfile(kind: HarnessAgentKind): HarnessEnvProfile | undefined {
    this.ensureInitialized()
    const id = this.activeByKind[kind]
    return id !== undefined ? this.profiles.find((p) => p.id === id) : undefined
  }

  add(profile: Omit<HarnessEnvProfile, 'id' | 'order'>): HarnessEnvProfile | null {
    this.ensureInitialized()
    if (this.profiles.length >= MAX_PROFILES) return null
    const newProfile: HarnessEnvProfile = {
      ...profile,
      id: uuidv4(),
      // order 由仓库分配递增，避免用 length 在删除后产生重复值
      order: this.profiles.reduce((max, p) => Math.max(max, p.order), -1) + 1
    }
    this.profiles.push(newProfile)
    if (!this.save()) {
      this.profiles.pop()
      return null
    }
    return newProfile
  }

  update(profile: HarnessEnvProfile): boolean {
    this.ensureInitialized()
    const index = this.profiles.findIndex((p) => p.id === profile.id)
    if (index === -1) return false
    const previous = this.profiles[index]
    this.profiles[index] = profile
    if (!this.save()) {
      this.profiles[index] = previous
      return false
    }
    return true
  }

  /**
   * 单选启用某 kind 的指针：传 id 启用该组（该 kind 原指针被替换），传 null 停用
   * （回落系统环境变量）。跨 kind 互不影响 —— 同一组可被多个 kind 同时启用。
   * 落盘失败整体回滚，不留「内存已切、文件没切」的错位。
   */
  setActiveProfile(kind: HarnessAgentKind, id: string | null): boolean {
    this.ensureInitialized()
    if (id !== null && !this.profiles.some((p) => p.id === id)) return false
    const previous = this.activeByKind
    if (id === null) {
      const rest = { ...this.activeByKind }
      delete rest[kind]
      this.activeByKind = rest
    } else {
      this.activeByKind = { ...this.activeByKind, [kind]: id }
    }
    if (!this.save()) {
      this.activeByKind = previous
      return false
    }
    return true
  }

  /**
   * 迁移用：批量并入外部变量组（保留 id，已存在的 id 跳过保证幂等），并写入 per-kind
   * 启用指针（已存在的指针不覆盖 —— 本库记录优先于旧文件）。单次落盘，失败整体回滚。
   * 返回实际并入的条数。
   */
  importProfiles(
    profiles: HarnessEnvProfile[],
    activeByKind: Partial<Record<HarnessAgentKind, string>>
  ): number {
    this.ensureInitialized()
    const existing = new Set(this.profiles.map((p) => p.id))
    const incoming = profiles.filter((p) => !existing.has(p.id))
    const previousProfiles = this.profiles
    const previousActive = this.activeByKind
    // 并入的接在现有 order 之后重新编号
    let nextOrder = this.profiles.reduce((max, p) => Math.max(max, p.order), -1) + 1
    this.profiles = [...this.profiles, ...incoming.map((p) => ({ ...p, order: nextOrder++ }))]
    // 指针只补空位；指向的组必须在并入结果里存在（悬空不落盘）
    const knownIds = new Set(this.profiles.map((p) => p.id))
    for (const kind of HARNESS_AGENT_KINDS) {
      const id = activeByKind[kind]
      if (id !== undefined && this.activeByKind[kind] === undefined && knownIds.has(id)) {
        this.activeByKind = { ...this.activeByKind, [kind]: id }
      }
    }
    if (!this.save()) {
      this.profiles = previousProfiles
      this.activeByKind = previousActive
      return -1
    }
    return incoming.length
  }

  delete(id: string): boolean {
    this.ensureInitialized()
    const index = this.profiles.findIndex((p) => p.id === id)
    if (index === -1) return false
    const previousOrders = this.profiles.map((p) => p.order)
    const [removed] = this.profiles.splice(index, 1)
    // reindex 为 0..n-1，保证运行期 order 恒连续（不留空洞）
    this.profiles.forEach((p, i) => { p.order = i })
    // 指向被删组的启用指针一并清掉（等价该 kind 停用），不留悬空 id 落盘
    const previousActive = this.activeByKind
    for (const kind of HARNESS_AGENT_KINDS) {
      if (this.activeByKind[kind] === id) delete this.activeByKind[kind]
    }
    if (!this.save()) {
      // 回滚：恢复被删项与原 order / 指针
      this.profiles.splice(index, 0, removed)
      previousOrders.forEach((order, i) => { this.profiles[i].order = order })
      this.activeByKind = previousActive
      return false
    }
    return true
  }
}

export const envProfileRepository = new EnvProfileRepository('env-profiles.json')
