import { join } from 'path'
import log from 'electron-log'
import { v4 as uuidv4 } from 'uuid'
import { atomicWriteFileSync, getConfigDir } from './repository'
import {
  cloneJsonValue,
  JsonStoreLoadError,
  loadJsonFileSync,
  RevisionConflictError,
  writeBackupSync
} from './atomic-json'
import { normalizeEnv } from './harness-workspace-repository'
import {
  HARNESS_AGENT_KINDS,
  SECRET_PLACEHOLDER,
  isSecretPlaceholder,
  liftStructuredFields,
  type HarnessEnvProfile,
  type PublicHarnessEnvProfile,
  type SecretFieldState
} from '@shared/harness'
import {
  deleteSecretRefs,
  hasPlaintextSecrets,
  isSecretRef,
  migrateSecretEnv,
  normalizeSecretKeys,
  normalizeSecretRefs,
  planSecretEnv,
  planSecretValue,
  publicizeSecretEnv,
  resolveSecretEnv,
  secretStore as defaultSecretStore,
  type SecretVault
} from './secret-store'

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
 * 秘密：apiKey 与秘密 env 值不再明文落盘，磁盘上只有 apiKeyRef / envSecretRefs
 * （storage/secret-store.ts）。get/getAll/getActiveProfile 返回运行期解析值，
 * getPublic/getAllPublic/getActiveProfilePublic 返回占位符形态。
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
  const envSecretRefs = normalizeSecretRefs(p.envSecretRefs)
  const secretEnvKeys = normalizeSecretKeys(p.secretEnvKeys)
  const apiKeyRef = isSecretRef(p.apiKeyRef) ? p.apiKeyRef : undefined
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
  // 占位符不是秘密：磁盘上出现只说明调用方写错了，按缺省处理
  if (apiKey !== undefined && isSecretPlaceholder(apiKey)) apiKey = undefined
  if (
    baseUrl === undefined &&
    apiKey === undefined &&
    apiKeyRef === undefined &&
    Object.keys(env).length === 0 &&
    Object.keys(envSecretRefs).length === 0
  ) {
    return null
  }
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
    ...(apiKeyRef !== undefined ? { apiKeyRef } : {}),
    ...(Object.keys(envSecretRefs).length > 0 ? { envSecretRefs } : {}),
    ...(secretEnvKeys.length > 0 ? { secretEnvKeys } : {}),
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

export interface RevisionOptions {
  expectedRevision?: number
}

/** 公共 DTO 的展示字段（apiKeySecret）不是磁盘 schema 的一部分，落盘前剔除 */
function stripTransientFields<T extends object>(value: T): T {
  delete (value as unknown as Record<string, unknown>).apiKeySecret
  return value
}

function profileHasPlaintextSecret(profile: HarnessEnvProfile): boolean {
  if (typeof profile.apiKey === 'string' && profile.apiKey.length > 0 && !isSecretPlaceholder(profile.apiKey)) {
    return true
  }
  return hasPlaintextSecrets(
    profile.env,
    normalizeSecretRefs(profile.envSecretRefs),
    normalizeSecretKeys(profile.secretEnvKeys)
  )
}

export class EnvProfileRepository {
  private readonly fileName: string
  private filePath: string | null = null
  private profiles: HarnessEnvProfile[] = []
  private activeProfileId: string | null = null
  private loaded: boolean = false
  private revision: number = 0
  private loadError: JsonStoreLoadError | null = null
  private readonly secretStore: SecretVault

  constructor(fileName: string, secretStore: SecretVault = defaultSecretStore) {
    this.fileName = fileName
    this.secretStore = secretStore
  }

  private ensureInitialized(): void {
    if (!this.filePath) {
      this.filePath = join(getConfigDir(), this.fileName)
      this.load()
    }
  }

  private load(): void {
    if (!this.filePath || this.loaded) return

    const result = loadJsonFileSync<EnvProfileFile>(this.filePath, {
      validate: raw => {
        // 旧数组格式或非对象 JSON 属于 schema 不受支持：保留原件、进入只读失败态
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          throw new Error(`${this.fileName} must be a JSON object`)
        }
        return normalizeFile(raw)
      }
    })
    this.loaded = true
    if (result.status === 'missing') {
      this.profiles = []
      this.activeProfileId = null
      return
    }
    if (result.status === 'failed') {
      this.loadError = result.error
      this.profiles = []
      this.activeProfileId = null
      log.error(`Failed to load env profiles (${this.fileName}), keeping damaged file untouched:`, result.error)
      return
    }
    this.profiles = result.value.profiles
    this.activeProfileId = result.value.activeProfileId
    if (result.status === 'recovered') {
      log.warn(
        `${this.fileName} was corrupt; restored from backup (damaged copy: ${result.preservedPath ?? 'unavailable'})`
      )
    }
    log.info(`Loaded ${this.profiles.length} env profiles from ${this.fileName}`)
    this.ensureSecretsMigrated()
  }

  /**
   * 明文秘密迁移：逐条 put + read-back 校验 → 一次性原子保存引用版本（.bak 同步刷新）。
   * 任一步失败恢复内存明文、清理本次新建 ref、后续 save 拒绝；运行期读取仍可用。
   */
  private ensureSecretsMigrated(): boolean {
    if (!this.profiles.some(profileHasPlaintextSecret)) return true
    const previous = this.profiles
    const created: string[] = []
    try {
      const migrated = this.profiles.map((profile) => {
        const refs = normalizeSecretRefs(profile.envSecretRefs)
        const explicitKeys = normalizeSecretKeys(profile.secretEnvKeys)
        let apiKeyRef = isSecretRef(profile.apiKeyRef) ? profile.apiKeyRef : undefined
        const next: HarnessEnvProfile = { ...profile }
        delete next.apiKey
        delete next.apiKeyRef
        delete next.envSecretRefs
        delete next.secretEnvKeys
        stripTransientFields(next)
        if (typeof profile.apiKey === 'string' && profile.apiKey.length > 0 && !isSecretPlaceholder(profile.apiKey)) {
          const ref = this.secretStore.put(profile.apiKey)
          created.push(ref)
          const readBack = this.secretStore.resolve(ref)
          if (!readBack.ok || readBack.value !== profile.apiKey) {
            throw new Error('secret read-back verification failed for apiKey')
          }
          apiKeyRef = ref
        }
        const envResult = migrateSecretEnv(this.secretStore, {
          env: profile.env,
          refs,
          explicitSecretKeys: explicitKeys
        })
        created.push(...envResult.created)
        next.env = envResult.env
        if (apiKeyRef !== undefined) next.apiKeyRef = apiKeyRef
        if (Object.keys(envResult.refs).length > 0) next.envSecretRefs = envResult.refs
        if (explicitKeys.length > 0) next.secretEnvKeys = explicitKeys
        return next
      })
      this.profiles = migrated
      if (!this.save()) {
        this.profiles = previous
        deleteSecretRefs(this.secretStore, created, new Set(), `${this.fileName} migration`)
        log.error(`Failed to commit migrated secrets for ${this.fileName}; keeping original configuration in memory`)
        return false
      }
      log.info(`Migrated inline secrets into the secret vault for ${this.fileName} (${created.length} entries)`)
      return true
    } catch (error) {
      this.profiles = previous
      deleteSecretRefs(this.secretStore, created, new Set(), `${this.fileName} migration`)
      log.error(
        `Failed to migrate inline secrets for ${this.fileName}:`,
        error instanceof Error ? error.name : 'unknown error'
      )
      return false
    }
  }

  private save(): boolean {
    if (!this.filePath) return false
    if (this.loadError) return false
    if (this.profiles.some(profileHasPlaintextSecret)) {
      log.error(`Refusing to save ${this.fileName} while plaintext secrets remain in memory`)
      return false
    }
    try {
      const json = JSON.stringify({ profiles: this.profiles, activeProfileId: this.activeProfileId }, null, 2)
      // 原子写：崩溃不留截断 JSON（见 atomic-json.ts）
      atomicWriteFileSync(this.filePath, json)
      if (!writeBackupSync(this.filePath, json)) {
        log.warn(`Failed to refresh ${this.fileName} backup; primary commit succeeded`)
      }
      this.revision += 1
      return true
    } catch (error) {
      log.error(`Failed to save env profiles (${this.fileName}):`, error)
      return false
    }
  }

  private materialize(profile: HarnessEnvProfile): HarnessEnvProfile {
    const refs = normalizeSecretRefs(profile.envSecretRefs)
    const resolved = resolveSecretEnv(this.secretStore, profile.env, refs, `${this.fileName}/${profile.id}`)
    const next = cloneJsonValue(profile)
    next.env = resolved.env
    if (isSecretRef(profile.apiKeyRef)) {
      delete next.apiKey
      const result = this.secretStore.resolve(profile.apiKeyRef)
      if (result.ok) next.apiKey = result.value
      else log.warn(`Failed to resolve apiKey for env profile ${profile.id}: ${result.reason}`)
    }
    return next
  }

  private publicize(profile: HarnessEnvProfile): PublicHarnessEnvProfile {
    const refs = normalizeSecretRefs(profile.envSecretRefs)
    const explicitKeys = normalizeSecretKeys(profile.secretEnvKeys)
    const { env } = publicizeSecretEnv(profile.env, refs, explicitKeys)
    const next = { ...cloneJsonValue(profile), env } as PublicHarnessEnvProfile
    const ref = isSecretRef(profile.apiKeyRef) ? profile.apiKeyRef : undefined
    const legacyPlaintext = typeof profile.apiKey === 'string' && profile.apiKey.length > 0
    const state: SecretFieldState = ref
      ? { present: true, ref }
      : { present: legacyPlaintext }
    if (state.present) next.apiKey = SECRET_PLACEHOLDER
    else delete next.apiKey
    next.apiKeySecret = state
    return next
  }

  private collectUsedRefs(): Set<string> {
    const used = new Set<string>()
    for (const profile of this.profiles) {
      for (const ref of Object.values(normalizeSecretRefs(profile.envSecretRefs))) used.add(ref)
      if (isSecretRef(profile.apiKeyRef)) used.add(profile.apiKeyRef)
    }
    return used
  }

  getRevision(): number {
    this.ensureInitialized()
    return this.revision
  }

  getLoadError(): JsonStoreLoadError | null {
    this.ensureInitialized()
    return this.loadError
  }

  private assertRevision(expectedRevision: number | undefined): void {
    if (expectedRevision === undefined) return
    if (expectedRevision !== this.revision) {
      throw new RevisionConflictError(this.filePath ?? this.fileName, expectedRevision, this.revision)
    }
  }

  /** 运行期形态（含真实秘密）；只给主进程启动路径用 */
  getAll(): HarnessEnvProfile[] {
    this.ensureInitialized()
    return this.profiles
      .map(profile => this.materialize(profile))
      .sort((a, b) => a.order - b.order)
  }

  /** 运行期形态（含真实秘密）；只给主进程启动路径用 */
  get(id: string): HarnessEnvProfile | undefined {
    this.ensureInitialized()
    const found = this.profiles.find((p) => p.id === id)
    return found ? this.materialize(found) : undefined
  }

  /** 公共形态：秘密值是固定占位符，供 IPC/renderer 使用 */
  getAllPublic(): PublicHarnessEnvProfile[] {
    this.ensureInitialized()
    return this.profiles
      .map(profile => this.publicize(profile))
      .sort((a, b) => a.order - b.order)
  }

  getPublic(id: string): PublicHarnessEnvProfile | undefined {
    this.ensureInitialized()
    const found = this.profiles.find((p) => p.id === id)
    return found ? this.publicize(found) : undefined
  }

  /** 全局启用指针 id；无启用返回 null（调用方据此回落系统环境变量） */
  getActiveProfileId(): string | null {
    this.ensureInitialized()
    return this.activeProfileId
  }

  /** 全局启用的变量组（运行期形态）；指针悬空按无启用处理 */
  getActiveProfile(): HarnessEnvProfile | undefined {
    this.ensureInitialized()
    const found = this.activeProfileId !== null
      ? this.profiles.find((p) => p.id === this.activeProfileId)
      : undefined
    return found ? this.materialize(found) : undefined
  }

  /** 全局启用的变量组（公共形态） */
  getActiveProfilePublic(): PublicHarnessEnvProfile | undefined {
    this.ensureInitialized()
    const found = this.activeProfileId !== null
      ? this.profiles.find((p) => p.id === this.activeProfileId)
      : undefined
    return found ? this.publicize(found) : undefined
  }

  add(profile: Omit<HarnessEnvProfile, 'id' | 'order'>, options: RevisionOptions = {}): HarnessEnvProfile | null {
    this.ensureInitialized()
    this.assertRevision(options.expectedRevision)
    if (!this.ensureSecretsMigrated()) return null
    if (this.profiles.length >= MAX_PROFILES) return null
    const explicitKeys = normalizeSecretKeys(profile.secretEnvKeys)
    let envPlan
    let keyPlan
    try {
      envPlan = planSecretEnv(this.secretStore, {
        incoming: profile.env,
        existingRefs: undefined,
        explicitSecretKeys: explicitKeys
      })
      keyPlan = planSecretValue(this.secretStore, { incoming: profile.apiKey, existingRef: undefined })
    } catch (error) {
      if (envPlan) deleteSecretRefs(this.secretStore, envPlan.created, this.collectUsedRefs(), 'profile secret planning rollback')
      log.warn(`Failed to store secrets for ${this.fileName}:`, error instanceof Error ? error.name : 'unknown error')
      return null
    }
    const newProfile: HarnessEnvProfile = {
      ...profile,
      id: uuidv4(),
      // order 由仓库分配递增，避免用 length 在删除后产生重复值
      order: this.profiles.reduce((max, p) => Math.max(max, p.order), -1) + 1
    }
    delete newProfile.apiKey
    delete newProfile.apiKeyRef
    delete newProfile.envSecretRefs
    delete newProfile.secretEnvKeys
    stripTransientFields(newProfile)
    newProfile.env = envPlan.env
    if (keyPlan.ref !== undefined) newProfile.apiKeyRef = keyPlan.ref
    if (Object.keys(envPlan.refs).length > 0) newProfile.envSecretRefs = envPlan.refs
    if (explicitKeys.length > 0) newProfile.secretEnvKeys = explicitKeys
    this.profiles.push(newProfile)
    if (!this.save()) {
      this.profiles.pop()
      deleteSecretRefs(
        this.secretStore,
        [...envPlan.created, ...(keyPlan.created ? [keyPlan.created] : [])],
        this.collectUsedRefs(),
        `${this.fileName} add rollback`
      )
      return null
    }
    deleteSecretRefs(
      this.secretStore,
      [...envPlan.stale, ...(keyPlan.stale ? [keyPlan.stale] : [])],
      this.collectUsedRefs(),
      `${this.fileName} add`
    )
    return this.materialize(newProfile)
  }

  update(profile: HarnessEnvProfile, options: RevisionOptions = {}): boolean {
    this.ensureInitialized()
    this.assertRevision(options.expectedRevision)
    if (!this.ensureSecretsMigrated()) return false
    const index = this.profiles.findIndex((p) => p.id === profile.id)
    if (index === -1) return false
    const previous = this.profiles[index]
    // 外部传入的 ref 一律不信任，只沿用本仓库该记录自己的引用
    const existingRefs = normalizeSecretRefs(previous.envSecretRefs)
    const existingKeyRef = isSecretRef(previous.apiKeyRef) ? previous.apiKeyRef : undefined
    const explicitKeys = profile.secretEnvKeys !== undefined
      ? normalizeSecretKeys(profile.secretEnvKeys)
      : normalizeSecretKeys(previous.secretEnvKeys)
    let envPlan
    let keyPlan
    try {
      envPlan = planSecretEnv(this.secretStore, {
        incoming: profile.env,
        existingRefs,
        explicitSecretKeys: explicitKeys
      })
      keyPlan = planSecretValue(this.secretStore, {
        incoming: profile.apiKey,
        existingRef: existingKeyRef
      })
    } catch (error) {
      if (envPlan) deleteSecretRefs(this.secretStore, envPlan.created, this.collectUsedRefs(), 'profile secret planning rollback')
      log.warn(`Failed to store secrets for ${this.fileName}:`, error instanceof Error ? error.name : 'unknown error')
      return false
    }
    const next: HarnessEnvProfile = { ...profile }
    delete next.apiKey
    delete next.apiKeyRef
    delete next.envSecretRefs
    delete next.secretEnvKeys
    stripTransientFields(next)
    next.env = envPlan.env
    if (keyPlan.ref !== undefined) next.apiKeyRef = keyPlan.ref
    if (Object.keys(envPlan.refs).length > 0) next.envSecretRefs = envPlan.refs
    if (explicitKeys.length > 0) next.secretEnvKeys = explicitKeys
    this.profiles[index] = next
    if (!this.save()) {
      this.profiles[index] = previous
      deleteSecretRefs(
        this.secretStore,
        [...envPlan.created, ...(keyPlan.created ? [keyPlan.created] : [])],
        this.collectUsedRefs(),
        `${this.fileName} update rollback`
      )
      return false
    }
    deleteSecretRefs(
      this.secretStore,
      [...envPlan.stale, ...(keyPlan.stale ? [keyPlan.stale] : [])],
      this.collectUsedRefs(),
      `${this.fileName} update`
    )
    return true
  }

  /**
   * 全局单选启用：传 id 启用该组（原指针被替换 —— dsh / codex / claude 与 dsh Web
   * 共用同一根），传 null 停用（回落系统环境变量）。
   * 落盘失败整体回滚，不留「内存已切、文件没切」的错位。
   */
  setActiveProfile(id: string | null, options: RevisionOptions = {}): boolean {
    this.ensureInitialized()
    this.assertRevision(options.expectedRevision)
    if (!this.ensureSecretsMigrated()) return false
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
  importProfiles(profiles: HarnessEnvProfile[], activeId?: string, options: RevisionOptions = {}): number {
    this.ensureInitialized()
    this.assertRevision(options.expectedRevision)
    if (!this.ensureSecretsMigrated()) return -1
    const existing = new Set(this.profiles.map((p) => p.id))
    const incoming = profiles.filter((p) => !existing.has(p.id))
    const previousProfiles = this.profiles
    const previousActive = this.activeProfileId
    const created: string[] = []
    // 并入的接在现有 order 之后重新编号
    let nextOrder = this.profiles.reduce((max, p) => Math.max(max, p.order), -1) + 1
    let stored: HarnessEnvProfile[]
    try {
      stored = incoming.map((profile) => {
        const explicitKeys = normalizeSecretKeys(profile.secretEnvKeys)
        const envPlan = planSecretEnv(this.secretStore, {
          incoming: profile.env,
          existingRefs: undefined,
          explicitSecretKeys: explicitKeys
        })
        created.push(...envPlan.created)
        const keyPlan = planSecretValue(this.secretStore, { incoming: profile.apiKey, existingRef: undefined })
        if (keyPlan.created) created.push(keyPlan.created)
        const next: HarnessEnvProfile = { ...cloneJsonValue(profile), order: nextOrder++ }
        delete next.apiKey
        delete next.apiKeyRef
        delete next.envSecretRefs
        delete next.secretEnvKeys
        stripTransientFields(next)
        next.env = envPlan.env
        if (keyPlan.ref !== undefined) next.apiKeyRef = keyPlan.ref
        if (Object.keys(envPlan.refs).length > 0) next.envSecretRefs = envPlan.refs
        if (explicitKeys.length > 0) next.secretEnvKeys = explicitKeys
        return next
      })
    } catch (error) {
      deleteSecretRefs(this.secretStore, created, this.collectUsedRefs(), `${this.fileName} import rollback`)
      log.warn(`Failed to store imported secrets for ${this.fileName}:`, error instanceof Error ? error.name : 'unknown error')
      return -1
    }
    this.profiles = [...this.profiles, ...stored]
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
      deleteSecretRefs(this.secretStore, created, this.collectUsedRefs(), `${this.fileName} import rollback`)
      return -1
    }
    return incoming.length
  }

  delete(id: string, options: RevisionOptions = {}): boolean {
    this.ensureInitialized()
    this.assertRevision(options.expectedRevision)
    if (!this.ensureSecretsMigrated()) return false
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
    const removedRefs = [
      ...Object.values(normalizeSecretRefs(removed.envSecretRefs)),
      ...(isSecretRef(removed.apiKeyRef) ? [removed.apiKeyRef] : [])
    ]
    deleteSecretRefs(this.secretStore, removedRefs, this.collectUsedRefs(), `${this.fileName} delete`)
    return true
  }
}

export const envProfileRepository = new EnvProfileRepository('env-profiles.json')
