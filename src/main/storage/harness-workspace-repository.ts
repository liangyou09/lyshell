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
import { validateWorktreeKey } from '../harness/worktree'
import {
  isClaudePermissionMode,
  isCodexPermissionProfile,
  type HarnessWorkspace,
  type PublicHarnessWorkspace
} from '@shared/harness'
import {
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
 * AI Harness 工作区存储 —— dsh / codex / claude 三份共用（按文件名区分落盘位置）。
 * 每个工作区 = 名称 + 工作目录，单击在对应目录内启动对应 CLI。
 * 泛化自原 DshWorkspaceRepository（逻辑不变，DshWorkspace → HarnessWorkspace）。
 *
 * 秘密：工作区内联 env 中的秘密键不再明文落盘，磁盘上只有 envSecretRefs
 * （storage/secret-store.ts）。get/getAll 返回运行期解析值；getPublic/getAllPublic
 * 返回占位符形态。
 */

/**
 * 归一化 env 记录：过滤非字符串值，空记录按缺失处理（缺省时启动即用系统环境变量）。
 * 导出供变量组仓库（harness-env-profile-repository）复用，两处脏数据规则必须一致。
 */
export function normalizeEnv(raw: unknown): Record<string, string> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    // 丢弃脏数据（手工编辑/历史 JSON 可能残留）：空 key / 含 NUL 的 key / 含 NUL 的 value
    // 会让 node-pty spawn 返回 EINVAL 或截断环境变量（对齐 validation.assertStringRecord 的拒绝）。
    if (key.length === 0) continue
    if (key.includes('\0')) continue
    if (typeof value !== 'string') continue
    if (value.includes('\0')) continue
    result[key] = value
  }
  return Object.keys(result).length > 0 ? result : undefined
}

/**
 * 归一化单条 JSON 记录：非法记录返回 null（由 load 过滤），合法记录补齐 note 默认值。
 *
 * allowEmptyCwd：codex/claude 的启动器可以停留在「未引用工作目录」状态 —— 删除设置项后记录
 * 被清成 cwd=''，下次加载必须还能读回来（否则启动器会"丢"，再被一次性迁移重新导入设置项）。
 * dsh 工作区与设置项目录本身仍要求非空 cwd（独立目录模式语义不变）。
 */
function normalizeWorkspace(raw: unknown, allowEmptyCwd = false): HarnessWorkspace | null {
  if (typeof raw !== 'object' || raw === null) return null
  const w = raw as Record<string, unknown>
  if (typeof w.id !== 'string' || w.id.length === 0) return null
  if (typeof w.name !== 'string' || w.name.length === 0) return null
  if (typeof w.cwd !== 'string') return null
  if (!allowEmptyCwd && w.cwd.length === 0) return null
  if (typeof w.order !== 'number' || !Number.isFinite(w.order)) return null
  // note 非字符串时按缺失处理（不因备注脏数据丢整条记录）
  const note = typeof w.note === 'string' && w.note.length > 0 ? w.note : undefined
  // model 非字符串/空串按缺失处理（缺省时用各 CLI 默认模型）
  const model = typeof w.model === 'string' && w.model.length > 0 ? w.model : undefined
  // env 非对象/空记录按缺失处理（不因脏数据丢整条记录）
  // 注意：这是 legacy 字段，但迁移要靠它读到旧数据，删掉这行等于静默丢弃用户的 API key
  const env = normalizeEnv(w.env)
  // 秘密引用：只接受形如 sec_<32hex> 的字符串；非法 ref 丢弃（读不到就按缺失，绝不回退明文）
  const envSecretRefs = normalizeSecretRefs(w.envSecretRefs)
  const secretEnvKeys = normalizeSecretKeys(w.secretEnvKeys)
  // envProfileId 非字符串/空串按缺失处理（缺省即「跟随已启用的变量组」）
  const envProfileId = typeof w.envProfileId === 'string' && w.envProfileId.length > 0 ? w.envProfileId : undefined
  // isolation 仅接受字面量 'worktree'；'shared'/其它脏数据一律按缺省（shared）处理，不丢整条记录
  const isolation = w.isolation === 'worktree' ? 'worktree' as const : undefined
  // worktreeKey 非字符串/空白按缺失处理；值复用 validateWorktreeKey 兜底 —— 手工编辑 JSON
  // 可绕过 add/update 的保存校验，这里不过滤的话非法 key 会在启动时被 ensureWorktree fail-fast 拒绝
  const worktreeKeyRaw = typeof w.worktreeKey === 'string' ? w.worktreeKey.trim() : ''
  const keyCheck = worktreeKeyRaw.length > 0 ? validateWorktreeKey(worktreeKeyRaw) : undefined
  const worktreeKey = keyCheck && keyCheck.ok ? keyCheck.value : undefined
  // claudePermissions 仅接受四档枚举字面量；legacy skipPermissions===true 在此折叠成
  // bypassPermissions（读取即迁移：列表/启动拿到的都已是新字段，下次落盘旧键自然消失）
  const claudePermissions = isClaudePermissionMode(w.claudePermissions)
    ? w.claudePermissions
    : w.skipPermissions === true ? 'bypassPermissions' as const : undefined
  // codexPermissions 仅接受三档枚举字面量（其余按缺省 = 不追加参数，跟随 Codex 默认链）
  const codexPermissions = isCodexPermissionProfile(w.codexPermissions) ? w.codexPermissions : undefined
  const workspacePresetId = typeof w.workspacePresetId === 'string' && w.workspacePresetId.length > 0 ? w.workspacePresetId : undefined
  return { id: w.id, name: w.name, cwd: w.cwd, order: w.order, ...(workspacePresetId ? { workspacePresetId } : {}), ...(note !== undefined ? { note } : {}), ...(model !== undefined ? { model } : {}), ...(env !== undefined ? { env } : {}), ...(Object.keys(envSecretRefs).length > 0 ? { envSecretRefs } : {}), ...(secretEnvKeys.length > 0 ? { secretEnvKeys } : {}), ...(envProfileId !== undefined ? { envProfileId } : {}), ...(isolation !== undefined ? { isolation } : {}), ...(worktreeKey !== undefined ? { worktreeKey } : {}), ...(claudePermissions !== undefined ? { claudePermissions } : {}), ...(codexPermissions !== undefined ? { codexPermissions } : {}) }
}

export interface RevisionOptions {
  expectedRevision?: number
}

export interface ReplaceOptions extends RevisionOptions {
  preserveOrder?: boolean
}

export interface HarnessWorkspaceOptions {
  allowEmptyCwd?: boolean
  /** 测试可注入隔离的 vault；缺省用全局单例（共享 <userData>/secrets.json） */
  secretStore?: SecretVault
}

const validateWorkspacesFile = (raw: unknown): unknown[] => {
  if (!Array.isArray(raw)) throw new Error('harness workspace file must be a JSON array')
  return raw
}

function workspaceHasPlaintextSecret(workspace: HarnessWorkspace): boolean {
  return hasPlaintextSecrets(
    workspace.env,
    normalizeSecretRefs(workspace.envSecretRefs),
    normalizeSecretKeys(workspace.secretEnvKeys)
  )
}

/**
 * 通用工作区仓库。健壮性：load 过滤/归一化非法记录、按首个有效 id 去重、按 order 重排为 0..n-1；
 * delete 后 reindex 保持运行期 order 恒连续；add 分配 maxOrder+1；save 失败返回 false 并回滚内存。
 */
export class HarnessWorkspaceRepository {
  private readonly fileName: string
  /** 是否允许 cwd 为空串（未引用工作目录的 codex/claude 启动器）；dsh 与设置项恒为 false */
  private readonly allowEmptyCwd: boolean
  private readonly secretStore: SecretVault
  private filePath: string | null = null
  private workspaces: HarnessWorkspace[] = []
  private loaded = false
  private revision = 0
  private loadError: JsonStoreLoadError | null = null

  constructor(fileName: string, options: HarnessWorkspaceOptions = {}) {
    this.fileName = fileName
    this.allowEmptyCwd = options.allowEmptyCwd === true
    this.secretStore = options.secretStore ?? defaultSecretStore
  }

  private ensureInitialized(): void {
    if (!this.filePath) {
      this.filePath = join(getConfigDir(), this.fileName)
      this.load()
    }
  }

  private load(): void {
    if (!this.filePath || this.loaded) return

    const result = loadJsonFileSync<unknown[]>(this.filePath, { validate: validateWorkspacesFile })
    this.loaded = true
    if (result.status === 'missing') {
      this.workspaces = []
      return
    }
    if (result.status === 'failed') {
      // 损坏文件保留原件，内存为空且后续 save 拒绝写，避免默认值覆盖用户数据
      this.loadError = result.error
      this.workspaces = []
      log.error(`Failed to load harness workspaces (${this.fileName}), keeping damaged file untouched:`, result.error)
      return
    }
    const rawList = result.value as unknown[]
    // 过滤非法记录 → 按首个有效 id 去重 → 按 order 稳定排序 → reindex 为 0..n-1 连续值
    const seen = new Set<string>()
    this.workspaces = rawList
      .map((raw) => normalizeWorkspace(raw, this.allowEmptyCwd))
      .filter((w): w is HarnessWorkspace => w !== null)
      .filter((w) => {
        if (seen.has(w.id)) return false
        seen.add(w.id)
        return true
      })
      .sort((a, b) => a.order - b.order)
      .map((w, i) => ({ ...w, order: i }))
    if (result.status === 'recovered') {
      log.warn(
        `${this.fileName} was corrupt; restored from backup (damaged copy: ${result.preservedPath ?? 'unavailable'})`
      )
    }
    log.info(`Loaded ${this.workspaces.length} harness workspaces from ${this.fileName}`)
    this.ensureSecretsMigrated()
  }

  /**
   * 明文秘密迁移：逐条 put + read-back 校验 → 一次性原子保存引用版本（.bak 同步刷新）。
   * 任一步失败恢复内存明文、清理本次新建 ref、后续 save 拒绝；运行期读取仍可用。
   */
  private ensureSecretsMigrated(): boolean {
    if (!this.workspaces.some(workspaceHasPlaintextSecret)) return true
    const previous = this.workspaces
    const created: string[] = []
    try {
      const migrated = this.workspaces.map((workspace) => {
        const refs = normalizeSecretRefs(workspace.envSecretRefs)
        const explicitKeys = normalizeSecretKeys(workspace.secretEnvKeys)
        const result = migrateSecretEnv(this.secretStore, {
          env: workspace.env,
          refs,
          explicitSecretKeys: explicitKeys
        })
        created.push(...result.created)
        const next: HarnessWorkspace = { ...workspace, env: result.env }
        delete next.envSecretRefs
        delete next.secretEnvKeys
        if (Object.keys(result.refs).length > 0) next.envSecretRefs = result.refs
        if (explicitKeys.length > 0) next.secretEnvKeys = explicitKeys
        return next
      })
      this.workspaces = migrated
      if (!this.save()) {
        this.workspaces = previous
        deleteSecretRefs(this.secretStore, created, new Set(), `${this.fileName} migration`)
        log.error(`Failed to commit migrated secrets for ${this.fileName}; keeping original configuration in memory`)
        return false
      }
      log.info(`Migrated inline secrets into the secret vault for ${this.fileName} (${created.length} entries)`)
      return true
    } catch (error) {
      this.workspaces = previous
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
    if (this.workspaces.some(workspaceHasPlaintextSecret)) {
      log.error(`Refusing to save ${this.fileName} while plaintext secrets remain in memory`)
      return false
    }
    try {
      const json = JSON.stringify(this.workspaces, null, 2)
      // 原子写：崩溃不留截断 JSON（见 atomic-json.ts）
      atomicWriteFileSync(this.filePath, json)
      if (!writeBackupSync(this.filePath, json)) {
        log.warn(`Failed to refresh ${this.fileName} backup; primary commit succeeded`)
      }
      this.revision += 1
      return true
    } catch (error) {
      log.error(`Failed to save harness workspaces (${this.fileName}):`, error)
      return false
    }
  }

  private materialize(workspace: HarnessWorkspace): HarnessWorkspace {
    const refs = normalizeSecretRefs(workspace.envSecretRefs)
    const resolved = resolveSecretEnv(this.secretStore, workspace.env, refs, `${this.fileName}/${workspace.id}`)
    const next = cloneJsonValue(workspace)
    // 空 env 保持「字段缺失」而不是 {}，与既有加载/迁移语义一致
    next.env = Object.keys(resolved.env).length > 0 ? resolved.env : undefined
    return next
  }

  private publicize(workspace: HarnessWorkspace): PublicHarnessWorkspace {
    const refs = normalizeSecretRefs(workspace.envSecretRefs)
    const explicitKeys = normalizeSecretKeys(workspace.secretEnvKeys)
    const { env } = publicizeSecretEnv(workspace.env, refs, explicitKeys)
    return { ...cloneJsonValue(workspace), env }
  }

  private collectUsedRefs(): Set<string> {
    const used = new Set<string>()
    for (const workspace of this.workspaces) {
      for (const ref of Object.values(normalizeSecretRefs(workspace.envSecretRefs))) used.add(ref)
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
  getAll(): HarnessWorkspace[] {
    this.ensureInitialized()
    // 按 order 升序返回（load 已 reindex 为 0..n-1 连续值）
    return this.workspaces.map(workspace => this.materialize(workspace)).sort((a, b) => a.order - b.order)
  }

  /** 运行期形态（含真实秘密）；只给主进程启动路径用 */
  get(id: string): HarnessWorkspace | undefined {
    this.ensureInitialized()
    const found = this.workspaces.find((w) => w.id === id)
    return found ? this.materialize(found) : undefined
  }

  /** 公共形态：秘密环境变量值是固定占位符，供 IPC/renderer 使用 */
  getAllPublic(): PublicHarnessWorkspace[] {
    this.ensureInitialized()
    return this.workspaces.map(workspace => this.publicize(workspace)).sort((a, b) => a.order - b.order)
  }

  getPublic(id: string): PublicHarnessWorkspace | undefined {
    this.ensureInitialized()
    const found = this.workspaces.find((w) => w.id === id)
    return found ? this.publicize(found) : undefined
  }

  /** 内部批量迁移：整库原子保存，失败恢复原内存，避免合并到一半留下部分结果。 */
  replaceAll(workspaces: HarnessWorkspace[], options: ReplaceOptions = {}): boolean {
    this.ensureInitialized()
    this.assertRevision(options.expectedRevision)
    if (!this.ensureSecretsMigrated()) return false
    const previous = this.workspaces
    const previousRefs = this.collectUsedRefs()
    const created: string[] = []
    const stale = new Set<string>()
    let next: HarnessWorkspace[]
    try {
      next = workspaces.map((workspace, order) => {
        const prior = previous.find((w) => w.id === workspace.id)
        const refs = normalizeSecretRefs(prior?.envSecretRefs)
        const explicitKeys = workspace.secretEnvKeys !== undefined
          ? normalizeSecretKeys(workspace.secretEnvKeys)
          : normalizeSecretKeys(prior?.secretEnvKeys)
        const plan = planSecretEnv(this.secretStore, {
          incoming: workspace.env,
          existingRefs: refs,
          explicitSecretKeys: explicitKeys
        })
        created.push(...plan.created)
        plan.stale.forEach((ref) => stale.add(ref))
        const stored: HarnessWorkspace = {
          ...cloneJsonValue(workspace),
          order: options.preserveOrder ? workspace.order : order
        }
        delete stored.envSecretRefs
        delete stored.secretEnvKeys
        stored.env = plan.env
        if (Object.keys(plan.refs).length > 0) stored.envSecretRefs = plan.refs
        if (explicitKeys.length > 0) stored.secretEnvKeys = explicitKeys
        return stored
      })
    } catch (error) {
      deleteSecretRefs(this.secretStore, created, previousRefs, `${this.fileName} replace rollback`)
      log.warn(`Failed to store secrets for ${this.fileName}:`, error instanceof Error ? error.name : 'unknown error')
      return false
    }
    this.workspaces = next
    if (this.save()) {
      const staleRefs = new Set([...stale, ...previousRefs])
      this.collectUsedRefs().forEach((ref) => staleRefs.delete(ref))
      deleteSecretRefs(this.secretStore, [...staleRefs], this.collectUsedRefs(), `${this.fileName} replace`)
      return true
    }
    this.workspaces = previous
    deleteSecretRefs(this.secretStore, created, this.collectUsedRefs(), `${this.fileName} replace rollback`)
    return false
  }

  add(workspace: Omit<HarnessWorkspace, 'id' | 'order'>, options: RevisionOptions = {}): HarnessWorkspace | null {
    this.ensureInitialized()
    this.assertRevision(options.expectedRevision)
    if (!this.ensureSecretsMigrated()) return null
    const explicitKeys = normalizeSecretKeys(workspace.secretEnvKeys)
    let plan
    try {
      plan = planSecretEnv(this.secretStore, {
        incoming: workspace.env,
        existingRefs: undefined,
        explicitSecretKeys: explicitKeys
      })
    } catch (error) {
      log.warn(`Failed to store secrets for ${this.fileName}:`, error instanceof Error ? error.name : 'unknown error')
      return null
    }
    const newWorkspace: HarnessWorkspace = {
      ...workspace,
      id: uuidv4(),
      // order 由仓库分配递增，避免用 workspaces.length 在删除后产生重复值
      order: this.workspaces.reduce((max, w) => Math.max(max, w.order), -1) + 1
    }
    delete newWorkspace.envSecretRefs
    delete newWorkspace.secretEnvKeys
    newWorkspace.env = plan.env
    if (Object.keys(plan.refs).length > 0) newWorkspace.envSecretRefs = plan.refs
    if (explicitKeys.length > 0) newWorkspace.secretEnvKeys = explicitKeys
    this.workspaces.push(newWorkspace)
    if (!this.save()) {
      this.workspaces.pop()
      deleteSecretRefs(this.secretStore, plan.created, this.collectUsedRefs(), `${this.fileName} add rollback`)
      return null
    }
    deleteSecretRefs(this.secretStore, plan.stale, this.collectUsedRefs(), `${this.fileName} add`)
    return this.materialize(newWorkspace)
  }

  update(workspace: HarnessWorkspace, options: RevisionOptions = {}): boolean {
    this.ensureInitialized()
    this.assertRevision(options.expectedRevision)
    if (!this.ensureSecretsMigrated()) return false
    const index = this.workspaces.findIndex((w) => w.id === workspace.id)
    if (index === -1) return false
    const previous = this.workspaces[index]
    // 外部传入的 ref 一律不信任，只沿用本仓库该记录自己的引用
    const refs = normalizeSecretRefs(previous.envSecretRefs)
    const explicitKeys = workspace.secretEnvKeys !== undefined
      ? normalizeSecretKeys(workspace.secretEnvKeys)
      : normalizeSecretKeys(previous.secretEnvKeys)
    let plan
    try {
      plan = planSecretEnv(this.secretStore, {
        incoming: workspace.env,
        existingRefs: refs,
        explicitSecretKeys: explicitKeys
      })
    } catch (error) {
      log.warn(`Failed to store secrets for ${this.fileName}:`, error instanceof Error ? error.name : 'unknown error')
      return false
    }
    const next: HarnessWorkspace = { ...workspace }
    delete next.envSecretRefs
    delete next.secretEnvKeys
    next.env = plan.env
    if (Object.keys(plan.refs).length > 0) next.envSecretRefs = plan.refs
    if (explicitKeys.length > 0) next.secretEnvKeys = explicitKeys
    this.workspaces[index] = next
    if (!this.save()) {
      this.workspaces[index] = previous
      deleteSecretRefs(this.secretStore, plan.created, this.collectUsedRefs(), `${this.fileName} update rollback`)
      return false
    }
    deleteSecretRefs(this.secretStore, plan.stale, this.collectUsedRefs(), `${this.fileName} update`)
    return true
  }

  delete(id: string, options: RevisionOptions = {}): boolean {
    this.ensureInitialized()
    this.assertRevision(options.expectedRevision)
    if (!this.ensureSecretsMigrated()) return false
    const index = this.workspaces.findIndex((w) => w.id === id)
    if (index === -1) return false
    const previousOrders = this.workspaces.map((w) => w.order)
    const [removed] = this.workspaces.splice(index, 1)
    // reindex 为 0..n-1，保证运行期 order 恒连续（不留空洞）
    this.workspaces.forEach((w, i) => { w.order = i })
    if (!this.save()) {
      // 回滚：恢复被删项与原 order
      this.workspaces.splice(index, 0, removed)
      previousOrders.forEach((order, i) => { this.workspaces[i].order = order })
      return false
    }
    deleteSecretRefs(
      this.secretStore,
      Object.values(normalizeSecretRefs(removed.envSecretRefs)),
      this.collectUsedRefs(),
      `${this.fileName} delete`
    )
    return true
  }
}

export const dshWorkspaceRepository = new HarnessWorkspaceRepository('dsh-workspaces.json')
// codex/claude 允许 cwd='' —— 删除设置项后启动器保留为「未引用工作目录」项，不能因为加载即丢。
export const codexWorkspaceRepository = new HarnessWorkspaceRepository('codex-workspaces.json', { allowEmptyCwd: true })
export const claudeWorkspaceRepository = new HarnessWorkspaceRepository('claude-workspaces.json', { allowEmptyCwd: true })

export const codeWorkspacePresetRepository = new HarnessWorkspaceRepository('code-workspace-presets.json')
