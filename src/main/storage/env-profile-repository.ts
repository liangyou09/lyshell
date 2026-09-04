import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import log from 'electron-log'
import { v4 as uuidv4 } from 'uuid'
import { atomicWriteFileSync, getConfigDir } from './repository'
import { normalizeEnv } from './harness-workspace-repository'
import { HARNESS_AGENT_KINDS, liftStructuredFields, type HarnessEnvProfile } from '@shared/harness'

/**
 * 全局环境变量组存储 —— dsh / codex / claude 三个 harness kind 与通用 Agent 共用一份库
 * （单文件 env-profiles.json）。任一组可被任意 Agent / 工作区显式绑定。
 *
 * 文件格式：{ profiles: [...], activeProfileId: string | null }。
 * profile 本身不携带启用态 —— 「启用」是全应用单选一根指针（activeProfileId），
 * 三个 kind 与 dsh Web 共用同一根；指针与库同文件落盘，避免「组删了、指针还指着」的
 * 跨文件错位（delete 时顺手清指针）。加载时防御性读 legacy per-kind 指针
 * （activeByKind：新键缺席才读，按 kind 顺序取首个有效 —— 多根指针不一致时只保留
 * 一根，显式绑定不受影响，仅「跟随」缺省变化），落盘一律写新格式。
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
 * 结构化核心（baseUrl/apiKey）按非空字符串解析，trim 后为空按缺省处理；
 * env（附加变量）走与工作区同一份 normalizeEnv（空 key / NUL / 非字符串一律丢弃），
 * 但允许归一化为空 —— 核心两字段任一存在即合法（纯附加变量或纯凭据的组都有意义）。
 * 旧扁平格式（凭据直接写在 env 里）在此防御性提升回结构化核心：迁移只跑一次且
 * 可能在本仓库加载后才落盘，这一级保证未迁移文件的行为也正确（与 resolveWorkspaceEnv
 * 的 legacy 分支同纪律）。
 * 导出供 migrate-profiles.ts 解析旧 per-kind 文件的记录（旧记录多一个 active 字段，单独读）。
 */
export function normalizeProfile(raw: unknown): HarnessEnvProfile | null {
  if (typeof raw !== 'object' || raw === null) return null
  const p = raw as Record<string, unknown>
  if (typeof p.id !== 'string' || p.id.length === 0) return null
  if (typeof p.name !== 'string' || p.name.length === 0) return null
  if (typeof p.order !== 'number' || !Number.isFinite(p.order)) return null
  const baseUrlRaw = typeof p.baseUrl === 'string' ? p.baseUrl.trim() : ''
  const apiKeyRaw = typeof p.apiKey === 'string' ? p.apiKey.trim() : ''
  // 附加变量允许为空记录；undefined（键缺失/非对象）与 {} 等价处理
  const env = normalizeEnv(p.env) ?? {}
  // 旧扁平记录防御性提升：核心字段缺省但 env 里有已知协议键 → 提回结构化
  let baseUrl = baseUrlRaw || undefined
  let apiKey = apiKeyRaw || undefined
  if (baseUrl === undefined && apiKey === undefined) {
    const lifted = liftStructuredFields(env)
    baseUrl = lifted.baseUrl
    apiKey = lifted.apiKey
    // 提升后 env 换成剩余附加变量
    Object.keys(env).forEach((k) => delete env[k])
    Object.assign(env, lifted.env)
  }
  if (baseUrl === undefined && apiKey === undefined && Object.keys(env).length === 0) return null
  // note 非字符串按缺失处理（不因备注脏数据丢整条记录）
  const note = typeof p.note === 'string' && p.note.length > 0 ? p.note : undefined
  const models = normalizeModels(p.models)
  return {
    id: p.id,
    name: p.name,
    order: p.order,
    env,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(note !== undefined ? { note } : {}),
    ...(models !== undefined ? { models } : {})
  }
}

/** 全局库文件内容的运行期形态 */
interface EnvProfileFile {
  profiles: HarnessEnvProfile[]
  activeProfileId: string | null
}

/**
 * 归一化整份文件：非对象（含旧数组格式）按损坏处理为空库；profiles 走
 * 过滤 → 去重 → 排序 → reindex 流水线；启用指针优先读新键 activeProfileId
 * （非空字符串且指向存在的组才有效，悬空一律按「无启用」丢弃，不落回盘上），
 * 新键缺席/无效时回落读 legacy per-kind 指针（activeByKind：按 dsh → codex →
 * claude 顺序取首个有效，与 liftStructuredFields 的协议判定同一约定）。
 */
function normalizeFile(raw: unknown): EnvProfileFile {
  const empty: EnvProfileFile = { profiles: [], activeProfileId: null }
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

  // 指针校验对截断后的最终组集（seen 里被 MAX_PROFILES 截掉的 id 不算数），保证
  // getActiveProfileId() 非 null 时 getActiveProfile() 必能解析出组 —— 与
  // setActiveProfile / importProfiles 对 this.profiles 的校验同一口径
  const ids = new Set(profiles.map((p) => p.id))
  // 新键有效即用；否则 legacy per-kind 指针按 kind 顺序取首个有效；都无则 null（无启用）
  let activeProfileId: string | null = null
  const rawActive = obj.activeProfileId
  if (typeof rawActive === 'string' && rawActive.length > 0 && ids.has(rawActive)) {
    activeProfileId = rawActive
  } else {
    const rawByKind = obj.activeByKind
    if (typeof rawByKind === 'object' && rawByKind !== null) {
      for (const kind of HARNESS_AGENT_KINDS) {
        const v = (rawByKind as Record<string, unknown>)[kind]
        if (typeof v === 'string' && v.length > 0 && ids.has(v)) {
          activeProfileId = v
          break
        }
      }
    }
  }
  return { profiles, activeProfileId }
}

export class EnvProfileRepository {
  private readonly fileName: string
  private filePath: string | null = null
  private profiles: HarnessEnvProfile[] = []
  private activeProfileId: string | null = null
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
      this.activeProfileId = null
      this.loaded = true
      return
    }

    try {
      const content = readFileSync(this.filePath, 'utf-8')
      const normalized = normalizeFile(JSON.parse(content))
      this.profiles = normalized.profiles
      this.activeProfileId = normalized.activeProfileId
      log.info(`Loaded ${this.profiles.length} env profiles from ${this.fileName}`)
      this.loaded = true
    } catch (error) {
      log.error(`Failed to load env profiles (${this.fileName}):`, error)
      this.profiles = []
      this.activeProfileId = null
      this.loaded = true
    }
  }

  private save(): boolean {
    if (!this.filePath) return false
    try {
      // 原子写：崩溃不留截断 JSON（见 repository.ts 的 atomicWriteFileSync）
      atomicWriteFileSync(this.filePath, JSON.stringify({ profiles: this.profiles, activeProfileId: this.activeProfileId }, null, 2))
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

  /** 全局启用指针 id；无启用返回 null（调用方据此回落系统环境变量） */
  getActiveProfileId(): string | null {
    this.ensureInitialized()
    return this.activeProfileId
  }

  /** 全局启用的变量组；指针悬空（组已删，加载时已清洗）按无启用处理 */
  getActiveProfile(): HarnessEnvProfile | undefined {
    this.ensureInitialized()
    return this.activeProfileId !== null
      ? this.profiles.find((p) => p.id === this.activeProfileId)
      : undefined
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
   * 全局单选启用：传 id 启用该组（原指针被替换 —— dsh / codex / claude 与 dsh Web
   * 共用同一根），传 null 停用（回落系统环境变量）。
   * 落盘失败整体回滚，不留「内存已切、文件没切」的错位。
   */
  setActiveProfile(id: string | null): boolean {
    this.ensureInitialized()
    if (id !== null && !this.profiles.some((p) => p.id === id)) return false
    const previous = this.activeProfileId
    this.activeProfileId = id
    if (!this.save()) {
      this.activeProfileId = previous
      return false
    }
    return true
  }

  /**
   * 迁移用：批量并入外部变量组（保留 id，已存在的 id 跳过保证幂等），并写入全局
   * 启用指针（只补空位 —— 已有指针不覆盖，本库记录优先于旧文件；多个旧文件都带
   * active 时先并入的先到先得）。单次落盘，失败整体回滚。
   * 返回实际并入的条数。
   */
  importProfiles(profiles: HarnessEnvProfile[], activeId?: string): number {
    this.ensureInitialized()
    const existing = new Set(this.profiles.map((p) => p.id))
    const incoming = profiles.filter((p) => !existing.has(p.id))
    const previousProfiles = this.profiles
    const previousActive = this.activeProfileId
    // 并入的接在现有 order 之后重新编号
    let nextOrder = this.profiles.reduce((max, p) => Math.max(max, p.order), -1) + 1
    this.profiles = [...this.profiles, ...incoming.map((p) => ({ ...p, order: nextOrder++ }))]
    // 指针只补空位；指向的组必须在并入结果里存在（悬空不落盘）
    if (
      this.activeProfileId === null &&
      activeId !== undefined &&
      this.profiles.some((p) => p.id === activeId)
    ) {
      this.activeProfileId = activeId
    }
    if (!this.save()) {
      this.profiles = previousProfiles
      this.activeProfileId = previousActive
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
    // 指向被删组的启用指针一并清掉（等价全局停用），不留悬空 id 落盘
    const previousActive = this.activeProfileId
    if (this.activeProfileId === id) this.activeProfileId = null
    if (!this.save()) {
      // 回滚：恢复被删项与原 order / 指针
      this.profiles.splice(index, 0, removed)
      previousOrders.forEach((order, i) => { this.profiles[i].order = order })
      this.activeProfileId = previousActive
      return false
    }
    return true
  }
}

export const envProfileRepository = new EnvProfileRepository('env-profiles.json')
