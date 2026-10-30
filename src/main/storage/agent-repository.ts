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
import { materializeProfileEnv } from '@shared/harness'
import {
  assertResolvedSecrets,
  deleteSecretRefs,
  hasPlaintextSecrets,
  migrateSecretEnv,
  normalizeSecretKeys,
  normalizeSecretRefs,
  planSecretEnv,
  publicizeSecretEnv,
  resolveSecretEnv,
  secretStore as defaultSecretStore,
  type SecretVault
} from './secret-store'

/**
 * AI Agent 配置
 *
 * 秘密字段：`env` 只落非秘密值，秘密键的值在 secret vault 里，本记录用
 * `envSecretRefs`（KEY → 随机 ref）引用。`get`/`getAll` 返回运行期解析值，
 * `getPublic`/`getAllPublic` 返回占位符形态，renderer 只应拿后者。
 */
export interface AgentConfig {
  id: string
  /** 统一设置工作区的稳定关联；cwd/isolation 仅为兼容快照。 */
  workspacePresetId?: string
  name: string           // 显示名称，如 "Claude Code"
  command: string        // Shell 命令，如 "claude"
  icon?: string          // 图标（emoji），如 "🤖"
  cwd?: string           // 工作目录
  env?: Record<string, string>
  /** 秘密 env 的加密引用；env 中同名键不落明文 */
  envSecretRefs?: Record<string, string>
  /** 业务显式声明的秘密键（键名本身不像秘密时补充默认判定） */
  secretEnvKeys?: string[]
  /** 绑定的全局变量组 id（storage/env-profile-repository.ts）；缺省 = 未绑定 */
  envProfileId?: string
  /**
   * 绑定变量组时结构化核心（baseUrl/apiKey）的注入变量名 —— 命令是任意的，只有
   * agent 作者知道读哪些变量名，故映射跟 agent 走而非跟协议走（harness kind 的
   * 固定映射见 @shared/harness 的 HARNESS_ENV_KEY_MAP）。缺省 = 两个维度都不注入，
   * 绑定的组只透传附加变量。
   */
  envKeyMap?: { baseUrl?: string; apiKey?: string }
  /** 工作目录隔离模式（与 harness 工作区 / Codex·Claude 预设同语义）：'worktree' 在专属 git worktree 中启动 */
  isolation?: 'shared' | 'worktree'
  /** worktree 共享名：isolation = 'worktree' 时生效（取值约束见 @shared/worktree 的 validateWorktreeKey） */
  worktreeKey?: string
  order: number
}

/** IPC/renderer 用的安全形态：秘密值只以固定占位符出现，引用元数据保留。 */
export interface AgentConfigPublic extends Omit<AgentConfig, 'env' | 'envSecretRefs'> {
  env: Record<string, string>
  envSecretRefs?: Record<string, string>
  secretEnvKeys?: string[]
}

/**
 * 解析通用 Agent 启动时实际注入的环境变量 —— 与 harness 的 resolveWorkspaceEnv 同构
 * （命中即用、不合并）：
 *
 *   agent.envProfileId 绑定的变量组 → agent.env（内联 legacy）→ undefined（系统环境变量）
 *
 * 绑定命中后经 materializeProfileEnv 物化：附加变量原样透传，结构化核心按本 agent 的
 * envKeyMap 注入（未声明的维度不注入）。绑定悬空（组已被删）时等同「没绑」，回落内联
 * env —— 删组不该让 agent 变成「无 env」。
 */
export function resolveAgentLaunchEnv(
  agent: Pick<AgentConfig, 'envProfileId' | 'envKeyMap' | 'env' | 'envSecretRefs'>,
  store: { get(id: string): { baseUrl?: string; apiKey?: string; apiKeyRef?: string; envSecretRefs?: Record<string, string>; env: Record<string, string> } | undefined }
): Record<string, string> | undefined {
  assertResolvedSecrets(agent)
  if (agent.envProfileId !== undefined) {
    const profile = store.get(agent.envProfileId)
    if (profile) {
      assertResolvedSecrets(profile)
      return materializeProfileEnv(profile, agent.envKeyMap?.baseUrl ?? null, agent.envKeyMap?.apiKey ?? null)
    }
  }
  return agent.env
}

const validateAgentsFile = (raw: unknown): AgentConfig[] => {
  if (!Array.isArray(raw)) throw new Error('agents.json must be an array')
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) throw new Error('agent entry must be an object')
    const id = (item as { id?: unknown }).id
    if (typeof id !== 'string' || id.length === 0) throw new Error('agent entry requires a string id')
  }
  return raw as AgentConfig[]
}

export interface RevisionOptions {
  expectedRevision?: number
}

/**
 * AI Agent 配置存储
 *
 * 可靠性约定：损坏文件只读失败（不覆盖）、提交先写盘后改内存、可选 revision 冲突检测。
 * 秘密约定：内存 canonical 形态只含引用；明文秘密在加载时迁入 vault，迁移/保存失败时
 * 回滚内存并拒绝把明文写盘（fail closed），运行期读取仍可用。
 */
export class AgentRepository {
  private filePath: string | null = null
  private agents: AgentConfig[] = []
  private loaded: boolean = false
  private revision: number = 0
  private loadError: JsonStoreLoadError | null = null
  private readonly secretStore: SecretVault
  private readonly fileName: string

  constructor(secretStore: SecretVault = defaultSecretStore, options: { fileName?: string } = {}) {
    this.secretStore = secretStore
    this.fileName = options.fileName ?? 'agents.json'
  }

  private ensureInitialized(): void {
    if (!this.filePath) {
      this.filePath = join(getConfigDir(), this.fileName)
      this.load()
    }
  }

  private load(): void {
    if (!this.filePath || this.loaded) return

    const result = loadJsonFileSync<AgentConfig[]>(this.filePath, { validate: validateAgentsFile })
    this.loaded = true
    if (result.status === 'missing') {
      // 启动项只由用户添加；首次使用不预置任何命令。
      this.agents = []
      this.save()
      log.info('Initialized empty agent library')
      return
    }
    if (result.status === 'failed') {
      // 损坏配置保留原文件，内存回落空列表，且后续 save 拒绝写，避免默认值覆盖原件
      this.loadError = result.error
      this.agents = []
      log.error('Failed to load agents, keeping damaged file untouched:', result.error)
      return
    }
    // 每条记录的 env 走与 harness 同一份清洗（空 key / NUL / 非字符串丢弃）——
    // 手工编辑的脏数据直通 node-pty spawn 会拿到 EINVAL
    this.agents = result.value.map((a) => ({
      ...a,
      env: normalizeEnv(a.env),
      envSecretRefs: normalizeSecretRefs(a.envSecretRefs),
      secretEnvKeys: normalizeSecretKeys(a.secretEnvKeys)
    }))
    log.info(`Loaded ${this.agents.length} agents from storage`)
    if (result.status === 'recovered') {
      log.warn(`agents.json was corrupt; restored from backup (damaged copy: ${result.preservedPath ?? 'unavailable'})`)
    }
    this.ensureSecretsMigrated()
  }

  /** 落盘结果向上透传：add/update/delete 据此回滚内存并向调用方报失败 */
  private save(): boolean {
    if (!this.filePath) return false
    if (this.loadError) return false
    // 兜底：任何形态的明文秘密都不允许写进普通配置
    if (this.hasPlaintextInMemory(this.agents)) {
      log.error(`Refusing to save ${this.fileName} while plaintext secrets remain in memory`)
      return false
    }

    try {
      const json = JSON.stringify(this.agents, null, 2)
      // 原子写：崩溃不留截断 JSON（见 atomic-json.ts）
      atomicWriteFileSync(this.filePath, json)
      if (!writeBackupSync(this.filePath, json)) {
        log.warn('Failed to refresh agents.json backup; primary commit succeeded')
      }
      this.revision += 1
      log.info(`Saved ${this.agents.length} agents to storage`)
      return true
    } catch (error) {
      log.error('Failed to save agents:', error)
      return false
    }
  }

  private hasPlaintextInMemory(agents: AgentConfig[]): boolean {
    return agents.some((agent) => this.needsMigration(agent))
  }

  private needsMigration(agent: AgentConfig): boolean {
    return hasPlaintextSecrets(
      agent.env,
      normalizeSecretRefs(agent.envSecretRefs),
      normalizeSecretKeys(agent.secretEnvKeys)
    )
  }

  /**
   * 加载期/写前迁移：明文秘密 → vault（put + read-back）→ 一次性原子保存引用形态。
   * 失败时内存恢复明文、清理本次新建 ref、后续 save 拒绝；运行期读取仍返回明文。
   */
  private ensureSecretsMigrated(): boolean {
    if (!this.agents.some((agent) => this.needsMigration(agent))) return true
    const previous = this.agents
    const created: string[] = []
    try {
      const migrated = this.agents.map((agent) => {
        const refs = normalizeSecretRefs(agent.envSecretRefs)
        const explicitKeys = normalizeSecretKeys(agent.secretEnvKeys)
        const result = migrateSecretEnv(this.secretStore, {
          env: agent.env,
          refs,
          explicitSecretKeys: explicitKeys
        })
        created.push(...result.created)
        const next: AgentConfig = { ...agent }
        next.env = Object.keys(result.env).length > 0 ? result.env : undefined
        delete next.envSecretRefs
        delete next.secretEnvKeys
        if (Object.keys(result.refs).length > 0) next.envSecretRefs = result.refs
        if (explicitKeys.length > 0) next.secretEnvKeys = explicitKeys
        return next
      })
      this.agents = migrated
      if (!this.save()) {
        this.agents = previous
        deleteSecretRefs(this.secretStore, created, new Set(), 'agents migration')
        log.error('Failed to commit migrated agent secrets; keeping original configuration in memory')
        return false
      }
      log.info(`Migrated inline agent secrets into the secret vault (${created.length} entries)`)
      return true
    } catch (error) {
      this.agents = previous
      deleteSecretRefs(this.secretStore, created, new Set(), 'agents migration')
      // 只报错误类别，不带值
      log.error('Failed to migrate inline agent secrets into the secret vault:', error instanceof Error ? error.name : 'unknown error')
      return false
    }
  }

  private materialize(agent: AgentConfig): AgentConfig {
    const refs = normalizeSecretRefs(agent.envSecretRefs)
    const resolved = resolveSecretEnv(this.secretStore, agent.env, refs, `agents/${agent.id}`)
    const next = cloneJsonValue(agent)
    next.env = Object.keys(resolved.env).length > 0 ? resolved.env : undefined
    return next
  }

  private publicize(agent: AgentConfig): AgentConfigPublic {
    const refs = normalizeSecretRefs(agent.envSecretRefs)
    const explicitKeys = normalizeSecretKeys(agent.secretEnvKeys)
    const { env } = publicizeSecretEnv(agent.env, refs, explicitKeys)
    const next: AgentConfigPublic = {
      ...cloneJsonValue(agent),
      env
    }
    return next
  }

  private collectUsedRefs(): Set<string> {
    const used = new Set<string>()
    for (const agent of this.agents) {
      for (const ref of Object.values(normalizeSecretRefs(agent.envSecretRefs))) used.add(ref)
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
      throw new RevisionConflictError(this.filePath ?? 'agents.json', expectedRevision, this.revision)
    }
  }

  /** 运行期形态（含真实秘密）；只给主进程启动路径用 */
  getAll(): AgentConfig[] {
    this.ensureInitialized()
    return this.agents
      .map(agent => this.materialize(agent))
      .sort((a, b) => a.order - b.order)
  }

  /** 运行期形态（含真实秘密）；只给主进程启动路径用 */
  get(id: string): AgentConfig | undefined {
    this.ensureInitialized()
    const found = this.agents.find(a => a.id === id)
    return found ? this.materialize(found) : undefined
  }

  /** 公共形态：秘密值是固定占位符，供 IPC/renderer 使用 */
  getAllPublic(): AgentConfigPublic[] {
    this.ensureInitialized()
    return this.agents
      .map(agent => this.publicize(agent))
      .sort((a, b) => a.order - b.order)
  }

  getPublic(id: string): AgentConfigPublic | undefined {
    this.ensureInitialized()
    const found = this.agents.find(a => a.id === id)
    return found ? this.publicize(found) : undefined
  }

  /** 落盘失败返回 null 并回滚内存（与 EnvProfileRepository.add 同纪律：内存不领先盘） */
  add(agent: Omit<AgentConfig, 'id'>, options: RevisionOptions = {}): AgentConfig | null {
    this.ensureInitialized()
    this.assertRevision(options.expectedRevision)
    if (!this.ensureSecretsMigrated()) return null
    const explicitKeys = normalizeSecretKeys(agent.secretEnvKeys)
    let plan
    try {
      plan = planSecretEnv(this.secretStore, {
        incoming: agent.env,
        existingRefs: undefined,
        explicitSecretKeys: explicitKeys
      })
    } catch (error) {
      log.warn('Failed to store agent secrets:', error instanceof Error ? error.name : 'unknown error')
      return null
    }
    const newAgent: AgentConfig = {
      ...agent,
      id: uuidv4(),
      order: agent.order ?? this.agents.length
    }
    delete newAgent.envSecretRefs
    delete newAgent.secretEnvKeys
    newAgent.env = Object.keys(plan.env).length > 0 ? plan.env : undefined
    if (Object.keys(plan.refs).length > 0) newAgent.envSecretRefs = plan.refs
    if (explicitKeys.length > 0) newAgent.secretEnvKeys = explicitKeys
    this.agents.push(newAgent)
    if (!this.save()) {
      this.agents.pop()
      deleteSecretRefs(this.secretStore, plan.created, this.collectUsedRefs(), 'agents add rollback')
      return null
    }
    deleteSecretRefs(this.secretStore, plan.stale, this.collectUsedRefs(), 'agents add')
    return this.materialize(newAgent)
  }

  update(agent: AgentConfig, options: RevisionOptions = {}): boolean {
    this.ensureInitialized()
    this.assertRevision(options.expectedRevision)
    if (!this.ensureSecretsMigrated()) return false
    const index = this.agents.findIndex(a => a.id === agent.id)
    if (index === -1) return false
    const previous = this.agents[index]
    // 外部传入的 ref 一律不信任，只沿用本仓库该记录自己的引用
    const existingRefs = normalizeSecretRefs(previous.envSecretRefs)
    const explicitKeys = agent.secretEnvKeys !== undefined
      ? normalizeSecretKeys(agent.secretEnvKeys)
      : normalizeSecretKeys(previous.secretEnvKeys)
    let plan
    try {
      plan = planSecretEnv(this.secretStore, {
        incoming: agent.env,
        existingRefs,
        explicitSecretKeys: explicitKeys
      })
    } catch (error) {
      log.warn('Failed to store agent secrets:', error instanceof Error ? error.name : 'unknown error')
      return false
    }
    const next: AgentConfig = { ...agent }
    delete next.envSecretRefs
    delete next.secretEnvKeys
    next.env = Object.keys(plan.env).length > 0 ? plan.env : undefined
    if (Object.keys(plan.refs).length > 0) next.envSecretRefs = plan.refs
    if (explicitKeys.length > 0) next.secretEnvKeys = explicitKeys
    this.agents[index] = next
    if (!this.save()) {
      this.agents[index] = previous
      deleteSecretRefs(this.secretStore, plan.created, this.collectUsedRefs(), 'agents update rollback')
      return false
    }
    deleteSecretRefs(this.secretStore, plan.stale, this.collectUsedRefs(), 'agents update')
    return true
  }

  delete(id: string, options: RevisionOptions = {}): boolean {
    this.ensureInitialized()
    this.assertRevision(options.expectedRevision)
    if (!this.ensureSecretsMigrated()) return false
    const index = this.agents.findIndex(a => a.id === id)
    if (index === -1) return false
    const [removed] = this.agents.splice(index, 1)
    if (!this.save()) {
      this.agents.splice(index, 0, removed)
      return false
    }
    const removedRefs = Object.values(normalizeSecretRefs(removed.envSecretRefs))
    deleteSecretRefs(this.secretStore, removedRefs, this.collectUsedRefs(), 'agents delete')
    return true
  }

  /**
   * 内部批量改写：整库原子保存，失败恢复原内存 —— 删除变量组/设置项时统一解除引用，
   * 避免写到一半留下部分清空的启动器。order 原样保留（调用方按 getAll() 顺序传入）。
   */
  replaceAll(agents: AgentConfig[], options: RevisionOptions = {}): boolean {
    this.ensureInitialized()
    this.assertRevision(options.expectedRevision)
    if (!this.ensureSecretsMigrated()) return false
    const previous = this.agents
    const byId = new Map(previous.map((agent) => [agent.id, agent]))
    const created: string[] = []
    let next: AgentConfig[]
    try {
      next = agents.map((agent) => {
        const existing = byId.get(agent.id)
        const explicitKeys = agent.secretEnvKeys !== undefined
          ? normalizeSecretKeys(agent.secretEnvKeys)
          : normalizeSecretKeys(existing?.secretEnvKeys)
        const plan = planSecretEnv(this.secretStore, {
          incoming: agent.env,
          existingRefs: normalizeSecretRefs(existing?.envSecretRefs),
          explicitSecretKeys: explicitKeys
        })
        created.push(...plan.created)
        const stored: AgentConfig = { ...agent }
        delete stored.envSecretRefs
        delete stored.secretEnvKeys
        stored.env = Object.keys(plan.env).length > 0 ? plan.env : undefined
        if (Object.keys(plan.refs).length > 0) stored.envSecretRefs = plan.refs
        if (explicitKeys.length > 0) stored.secretEnvKeys = explicitKeys
        return stored
      })
    } catch (error) {
      deleteSecretRefs(this.secretStore, created, this.collectUsedRefs(), 'agents replaceAll rollback')
      log.warn('Failed to store agent secrets during batch replace:', error instanceof Error ? error.name : 'unknown error')
      return false
    }
    this.agents = next.map(agent => cloneJsonValue(agent))
    if (this.save()) {
      // 批量替换后旧引用统一清理（逐个 agent 的 stale 已在 plan 中，但被删 agent 的引用也要清）
      const used = this.collectUsedRefs()
      const stale: string[] = []
      for (const agent of previous) {
        for (const ref of Object.values(normalizeSecretRefs(agent.envSecretRefs))) {
          if (!used.has(ref)) stale.push(ref)
        }
      }
      deleteSecretRefs(this.secretStore, stale, used, 'agents replaceAll')
      return true
    }
    this.agents = previous
    deleteSecretRefs(this.secretStore, created, this.collectUsedRefs(), 'agents replaceAll rollback')
    return false
  }
}

export const agentRepository = new AgentRepository()
