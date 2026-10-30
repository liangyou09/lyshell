import { safeStorage } from 'electron'
import { join } from 'path'
import { getConfigDir } from './paths'
import log from 'electron-log'
import { v4 as uuidv4 } from 'uuid'
import type { SessionConfig, SessionPublicConfig } from '@shared/types'
import { sanitizeSessionEncoding } from '@shared/encoding'
import { isSecretPlaceholder } from '@shared/harness'
import { isStrongSecureStorage } from '../security/secure-storage'
import {
  atomicWriteFileSync,
  cloneJsonValue,
  JsonStoreLoadError,
  loadJsonFileSync,
  RevisionConflictError,
  writeBackupSync
} from './atomic-json'
import {
  SENSITIVE_SSH_FIELDS,
  hasSameSshTarget,
  hydrateSessionSecrets,
  publicSessionConfig,
  type SensitiveSshField
} from './session-secrets'
import {
  deleteSecretRefs,
  hasPlaintextSecrets,
  migrateSecretEnv,
  normalizeSecretKeys,
  normalizeSecretRefs,
  planSecretEnv,
  resolveSecretEnv,
  secretStore as defaultSecretStore,
  type SecretVault
} from './secret-store'

// 兼容既有导入面：仓储测试与浏览器服务都从本模块 mock / 引用 atomicWriteFileSync。
export {
  AtomicJsonError,
  JsonStoreLoadError,
  RevisionConflictError,
  atomicWriteFileSync
} from './atomic-json'
export type { AtomicWriteOptions } from './atomic-json'

const SAFE_STORAGE_PREFIX = 'safe:v1:'

/** 可选乐观并发控制：只有显式传 expectedRevision 才校验，旧调用方无需改动。 */
export interface RevisionOptions {
  expectedRevision?: number
}

const cloneSession = (session: SessionConfig): SessionConfig => ({
  ...session,
  // 所有保存入口（含 connect/MCP）都经过盘边界，运行期恢复引用不能进入普通配置。
  ssh: session.ssh ? { ...session.ssh, resumeSessionName: undefined, resumeDirectory: undefined } : undefined,
  telnet: session.telnet ? { ...session.telnet } : undefined,
  serial: session.serial ? { ...session.serial } : undefined,
  local: session.local ? {
    ...session.local,
    terminalHostId: undefined,
    env: session.local.env ? { ...session.local.env } : undefined,
    // 秘密引用/显式键名是盘上元数据，必须跟随副本一起隔离；共享引用会成为跨记录改动后门
    envSecretRefs: session.local.envSecretRefs ? { ...session.local.envSecretRefs } : undefined,
    secretEnvKeys: session.local.secretEnvKeys ? [...session.local.secretEnvKeys] : undefined,
    // shellArgs 同 tags/startupCommands 的逐层拷贝纪律：cloneSession 的立意就是引用
    // 隔离（盘边界两侧互不共享可变结构），数组漏拷会留共享引用的后门
    shellArgs: session.local.shellArgs ? [...session.local.shellArgs] : undefined
  } : undefined,
  terminal: session.terminal ? { ...session.terminal, theme: { ...session.terminal.theme } } : session.terminal,
  tags: [...(session.tags || [])],
  startupCommands: session.startupCommands ? [...session.startupCommands] : undefined
})

const isEncryptedSecret = (value: string): boolean => value.startsWith(SAFE_STORAGE_PREFIX)

const encryptSecretForDisk = (value: string | undefined): string | undefined => {
  if (!value || isEncryptedSecret(value)) return value
  if (!isStrongSecureStorage(safeStorage)) {
    throw new Error('系统安全存储不可用，无法安全保存 SSH 凭据。请启用系统凭据存储后重试，或移除密码/私钥/口令后保存。')
  }
  return `${SAFE_STORAGE_PREFIX}${safeStorage.encryptString(value).toString('base64')}`
}

interface SecretDecryptResult {
  value: string | undefined
  /** 解密不可用/失败时保留的密文，供后续保存原样写回，绝不能擦成 undefined。 */
  ciphertext?: string
  failed: boolean
}

const decryptSecretFromDisk = (value: string | undefined): SecretDecryptResult => {
  if (!value || !isEncryptedSecret(value)) return { value, failed: false }
  if (!isStrongSecureStorage(safeStorage)) {
    log.warn('safeStorage is unavailable, keeping SSH secret ciphertext unchanged on disk')
    return { value: undefined, ciphertext: value, failed: true }
  }
  try {
    const encrypted = Buffer.from(value.slice(SAFE_STORAGE_PREFIX.length), 'base64')
    return { value: safeStorage.decryptString(encrypted), failed: false }
  } catch (error) {
    // 不记录密文本身，避免日志成为凭据副本
    log.error('Failed to decrypt SSH secret from disk, keeping ciphertext for future writes:', error)
    return { value: undefined, ciphertext: value, failed: true }
  }
}

const hasPlaintextSshSecret = (session: SessionConfig): boolean => {
  if (!session.ssh) return false
  return SENSITIVE_SSH_FIELDS.some(field => {
    const value = session.ssh?.[field]
    return !!value && !isEncryptedSecret(value)
  })
}

interface DecryptedSession {
  session: SessionConfig
  protectedSecrets: Partial<Record<SensitiveSshField, string>>
  decryptFailed: boolean
}

const decryptSessionFromDisk = (session: SessionConfig): DecryptedSession => {
  const decrypted = cloneSession(session)
  const protectedSecrets: Partial<Record<SensitiveSshField, string>> = {}
  let decryptFailed = false
  if (decrypted.ssh) {
    for (const field of SENSITIVE_SSH_FIELDS) {
      const result = decryptSecretFromDisk(decrypted.ssh[field])
      decrypted.ssh[field] = result.value
      if (result.failed) {
        decryptFailed = true
        if (result.ciphertext) protectedSecrets[field] = result.ciphertext
      }
    }
  }
  return { session: decrypted, protectedSecrets, decryptFailed }
}

const encryptSessionForDisk = (
  session: SessionConfig,
  protectedSecrets?: Partial<Record<SensitiveSshField, string>>
): SessionConfig => {
  const encrypted = cloneSession(session)
  const hasProtected = !!protectedSecrets && Object.keys(protectedSecrets).length > 0
  if (!encrypted.ssh) {
    if (hasProtected) {
      // ssh 整块消失但密文未解密：很可能是安全存储不可用期间的编辑/默认值路径。
      // 直接落盘会把密文连同凭据一起丢掉，宁可让本次保存失败。
      throw new Error('安全存储不可用，无法安全改写含未解密 SSH 凭据的会话；请启用系统凭据存储后重试。')
    }
    return encrypted
  }
  for (const field of SENSITIVE_SSH_FIELDS) {
    const plaintext = encrypted.ssh[field]
    if (plaintext === undefined && protectedSecrets?.[field]) {
      // 解密失败的字段保持原密文，其他字段照常保存 —— 秘密不因一次失败被擦除
      encrypted.ssh[field] = protectedSecrets[field]
    } else {
      encrypted.ssh[field] = encryptSecretForDisk(plaintext)
    }
  }
  return encrypted
}

/** sessions.json 最低 schema：必须是数组，元素得是可寻址的对象；其余字段保持宽松兼容。 */
const validateSessionsFile = (raw: unknown): SessionConfig[] => {
  if (!Array.isArray(raw)) throw new Error('sessions.json must be an array')
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) throw new Error('session entry must be an object')
    const id = (item as { id?: unknown }).id
    if (typeof id !== 'string' || id.length === 0) throw new Error('session entry requires a string id')
  }
  return raw as SessionConfig[]
}

export { getConfigDir } from './paths'

/**
 * 会话配置存储
 * 使用 JSON 文件存储（SQLite 需要原生模块）
 * 延迟初始化，避免在 app.ready 前调用 app.getPath
 *
 * 可靠性契约：
 * - 单写：同一仓储实例的保存是同步提交，内存只在写盘成功后替换
 * - revision：每次成功提交 +1；显式传 expectedRevision 时旧快照抛 RevisionConflictError
 * - 损坏保护：加载失败进入只读失败态，任何保存都抛错，绝不用默认值覆盖损坏原件
 * - 密文保护：decrypt 失败时保留原密文，后续保存不会把秘密擦成 undefined
 */
export class SessionRepository {
  private filePath: string | null = null
  private sessions: Map<string, SessionConfig> = new Map()
  private loaded: boolean = false
  private revision: number = 0
  private loadError: JsonStoreLoadError | null = null
  private protectedSecrets: Map<string, Partial<Record<SensitiveSshField, string>>> = new Map()
  /** local env 秘密的 vault；测试可注入隔离实例，生产默认共用 secretStore。 */
  private readonly injectedSecretStore?: SecretVault
  private get secretStore(): SecretVault { return this.injectedSecretStore ?? defaultSecretStore }
  /** 加载期明文迁移失败：保留原文件并拒绝任何后续保存，避免把明文重新写盘。 */
  private secretMigrationFailed: Error | null = null

  constructor(secretStore?: SecretVault) {
    // 仅在实际访问时读取默认 vault；默认路径由无仓储依赖的 paths 模块提供。
    this.injectedSecretStore = secretStore
  }

  /**
   * 确保已初始化
   */
  private ensureInitialized(): void {
    if (!this.filePath) {
      this.filePath = join(getConfigDir(), 'sessions.json')
      this.load()
    }
  }

  /** 当前内存快照的提交版本（从 0 开始，每次成功落盘 +1）。 */
  getRevision(): number {
    this.ensureInitialized()
    return this.revision
  }

  /** 加载失败时返回具体错误；调用方可用它区分「空库」与「损坏/不可读」。 */
  getLoadError(): JsonStoreLoadError | null {
    this.ensureInitialized()
    return this.loadError
  }

  private assertRevision(expectedRevision: number | undefined): void {
    if (expectedRevision === undefined) return
    if (expectedRevision !== this.revision) {
      throw new RevisionConflictError(this.filePath ?? 'sessions.json', expectedRevision, this.revision)
    }
  }

  /**
   * 加载所有会话
   */
  private load(): void {
    if (!this.filePath || this.loaded) return

    const result = loadJsonFileSync<SessionConfig[]>(this.filePath, { validate: validateSessionsFile })
    if (result.status === 'missing') {
      log.info('No sessions file found, starting fresh')
      this.loaded = true
      return
    }
    if (result.status === 'failed') {
      // 不写默认值：原件（或已另存的 .corrupt-*）必须保留，交给上层显式恢复
      this.loadError = result.error
      this.loaded = true
      log.error('Failed to load sessions, keeping damaged file untouched:', result.error)
      return
    }

    try {
      let shouldMigrateSecrets = false
      for (const storedSession of result.value) {
        if (hasPlaintextSshSecret(storedSession)) {
          shouldMigrateSecrets = true
        }

        const decrypted = decryptSessionFromDisk(storedSession)
        if (decrypted.decryptFailed && Object.keys(decrypted.protectedSecrets).length > 0) {
          this.protectedSecrets.set(decrypted.session.id, decrypted.protectedSecrets)
        }
        const session = decrypted.session
        // 转换日期
        session.createdAt = new Date(session.createdAt)
        session.updatedAt = new Date(session.updatedAt)
        // 存量净化（收口）：编码白名单是后来才有的，老 sessions.json 可能带非法
        // terminal.encoding —— 在此归位保证内存 map 恒为合法值（SESSION_GET/LIST、
        // MCP list_sessions、复用路径全部只面对干净数据），下次任何落盘顺带带走
        sanitizeSessionEncoding(session)
        this.sessions.set(session.id, session)
      }

      log.info(`Loaded ${this.sessions.size} sessions from storage`)
      if (result.status === 'recovered') {
        log.warn(`sessions.json was corrupt; restored from backup (damaged copy: ${result.preservedPath ?? 'unavailable'})`)
      }

      // 自动去重
      const refsBeforeDedupe = this.collectLocalSecretRefs()
      const dupResult = this.deduplicate(false)
      if (dupResult.removed > 0) {
        log.info(`Auto-deduplicated ${dupResult.removed} sessions on load`)
      }

      this.loaded = true
      // local env 明文秘密：先写 vault + read-back，再原子提交引用；失败由
      // ensureSecretsMigrated 内部回滚内存/新建引用并置 fail-closed 标记
      this.ensureSecretsMigrated()
      if (shouldMigrateSecrets || dupResult.removed > 0) {
        // 迁移落盘失败不能把已成功读入的内存库打成加载失败：旧文件仍然有效
        try {
          this.save()
          if (dupResult.removed > 0) {
            // 去重结果已提交，回收被移除记录独占的引用；仍在使用的保留
            deleteSecretRefs(
              this.secretStore,
              Array.from(refsBeforeDedupe),
              this.collectLocalSecretRefs(),
              'sessions load deduplicate'
            )
          }
        } catch (error) {
          log.warn('Failed to persist session migration/dedup on load; keeping old file:', error)
        }
      }
    } catch (error) {
      this.loadError = new JsonStoreLoadError(this.filePath, 'corrupt', error)
      this.sessions.clear()
      this.protectedSecrets.clear()
      this.loaded = true
      log.error('Failed to parse sessions file, keeping damaged file untouched:', error)
    }
  }

  /**
   * 加载期 local env 秘密迁移：逐条 put 到 vault 并 read-back，成功后一次性原子提交
   * 引用形态 + 备份；任一步失败回滚内存、删除本次新建引用，并置 fail-closed 标记
   * （后续 save 一律拒绝，磁盘保持原字节，不会把明文重新写回）。
   */
  private ensureSecretsMigrated(): void {
    if (this.secretMigrationFailed) return

    const previousSessions = this.sessions
    const migrated = new Map<string, SessionConfig>()
    const created: string[] = []
    let changed = false

    try {
      for (const session of previousSessions.values()) {
        const local = session.local
        if (!local) {
          migrated.set(session.id, session)
          continue
        }

        const rawRefs = local.envSecretRefs
        const rawKeys = local.secretEnvKeys
        const refs = normalizeSecretRefs(rawRefs)
        const explicitKeys = normalizeSecretKeys(rawKeys)
        const normalizedRefs = Object.keys(refs).length > 0 ? refs : undefined
        const normalizedKeys = explicitKeys.length > 0 ? explicitKeys : undefined

        // 引用/键名本身也要归一化（手工改过的 sessions.json 可能带非法引用）
        const metadataChanged =
          JSON.stringify(rawRefs ?? null) !== JSON.stringify(normalizedRefs ?? null) ||
          JSON.stringify(rawKeys ?? null) !== JSON.stringify(normalizedKeys ?? null)
        const needsMigration = hasPlaintextSecrets(local.env, refs, explicitKeys)

        if (!needsMigration) {
          if (!metadataChanged) {
            migrated.set(session.id, session)
            continue
          }
          const normalized = cloneSession(session)
          normalized.local!.envSecretRefs = normalizedRefs
          normalized.local!.secretEnvKeys = normalizedKeys
          migrated.set(session.id, normalized)
          changed = true
          continue
        }

        const result = migrateSecretEnv(this.secretStore, {
          env: local.env,
          refs,
          explicitSecretKeys: explicitKeys
        })
        created.push(...result.created)
        const next = cloneSession(session)
        const nextLocal = next.local!
        nextLocal.env = Object.keys(result.env).length > 0 ? result.env : undefined
        nextLocal.envSecretRefs =
          Object.keys(result.refs).length > 0 ? result.refs : undefined
        nextLocal.secretEnvKeys = explicitKeys.length > 0 ? explicitKeys : undefined
        migrated.set(next.id, next)
        changed = true
        log.info(`Migrated ${result.created.length} local env secret(s) for session ${session.id}`)
      }

      if (!changed) return
      this.sessions = migrated
      this.save()
    } catch (error) {
      this.sessions = previousSessions
      deleteSecretRefs(this.secretStore, created, new Set(), 'sessions migration rollback')
      this.secretMigrationFailed = error instanceof Error ? error : new Error(String(error))
      log.error(
        '[SessionRepository] local env secret migration failed; keeping original file and refusing further saves:',
        this.secretMigrationFailed.message
      )
    }
  }

  /**
   * 保存所有会话到文件。仅在提交成功后更新 revision；失败时内存由调用方回滚。
   */
  private save(): void {
    if (!this.filePath) return
    if (this.loadError) throw this.loadError
    this.assertSecretsWritable()

    try {
      const data = Array.from(this.sessions.values()).map(session =>
        encryptSessionForDisk(session, this.protectedSecrets.get(session.id))
      )
      const json = JSON.stringify(data, null, 2)
      // atomicWriteFileSync 内部完成 0600 + fsync + rename；失败时旧文件保持不变
      atomicWriteFileSync(this.filePath, json)
      if (!writeBackupSync(this.filePath, json)) {
        log.warn('Failed to refresh sessions.json backup; primary commit succeeded')
      }
      this.revision += 1
      log.info(`Saved ${data.length} sessions to storage`)
    } catch (error) {
      log.error('Failed to save sessions:', error)
      throw error
    }
  }

  /** 写盘前兜底：迁移失败的库只读；内存里仍有明文 local 秘密时拒绝落盘。 */
  private assertSecretsWritable(): void {
    if (this.secretMigrationFailed) {
      throw new Error(
        'Local environment secret migration failed; refusing to overwrite sessions.json with plaintext. Restore secure storage and restart.'
      )
    }
    for (const session of this.sessions.values()) {
      const local = session.local
      if (!local) continue
      if (
        hasPlaintextSecrets(
          local.env,
          normalizeSecretRefs(local.envSecretRefs),
          normalizeSecretKeys(local.secretEnvKeys)
        )
      ) {
        throw new Error(
          'Refusing to persist plaintext local environment secrets into sessions.json'
        )
      }
    }
  }

  /**
   * 获取单个会话（运行期形态：local env 秘密已解析回真实值）。返回副本。
   * 解析失败时保留引用、缺该 env 键，供 connect 前 assertResolvedSecrets 阻止启动。
   */
  get(id: string): SessionConfig | null {
    this.ensureInitialized()
    const session = this.sessions.get(id)
    return session ? this.materializeSession(session) : null
  }

  /**
   * 获取所有会话（运行期形态，返回副本）
   */
  getAll(): SessionConfig[] {
    this.ensureInitialized()
    return Array.from(this.sessions.values()).map(session => this.materializeSession(session))
  }

  /**
   * 安全 DTO：SSH 三个秘密字段与 local env 秘密只给占位符/存在状态。
   * renderer / IPC 列表 / 导出预览只能用这个，绝不能用 get/getAll。
   */
  getPublic(id: string): SessionPublicConfig | null {
    const session = this.get(id)
    if (!session) return null
    return publicSessionConfig(session, { lockedSshFields: this.lockedSshFields(id) })
  }

  getAllPublic(): SessionPublicConfig[] {
    this.ensureInitialized()
    return Array.from(this.sessions.values()).map(session =>
      publicSessionConfig(this.materializeSession(session), {
        lockedSshFields: this.lockedSshFields(session.id)
      })
    )
  }

  /** 运行期解析 local env 引用；失败只缺键，引用元数据保留。 */
  private materializeSession(session: SessionConfig): SessionConfig {
    const cloned = cloneSession(session)
    const local = cloned.local
    if (!local) return cloned
    const refs = normalizeSecretRefs(local.envSecretRefs)
    if (Object.keys(refs).length === 0) return cloned

    const resolved = resolveSecretEnv(
      this.secretStore,
      local.env,
      refs,
      `sessions/${session.id}`
    )
    local.env = Object.keys(resolved.env).length > 0 ? resolved.env : undefined
    local.envSecretRefs = refs
    return cloned
  }

  /** 盘上仍有密文、本次无法解密的 SSH 字段。 */
  private lockedSshFields(id: string): SensitiveSshField[] {
    const protectedFields = this.protectedSecrets.get(id)
    if (!protectedFields) return []
    return SENSITIVE_SSH_FIELDS.filter(field => Boolean(protectedFields[field]))
  }

  /** 当前所有记录仍在引用的 local env 秘密；清理旧引用时必须避开这些。 */
  private collectLocalSecretRefs(): Set<string> {
    const used = new Set<string>()
    for (const session of this.sessions.values()) {
      for (const ref of Object.values(normalizeSecretRefs(session.local?.envSecretRefs))) {
        used.add(ref)
      }
    }
    return used
  }

  /**
   * 按连接目标查找已存在的会话（忽略 name / notes / tags，只看连接目标）。
   * 匹配口径与 getHostKey 一致：SSH/Telnet=host:port，Serial=path，Local=null（不参与去重，每次新建）。
   * 多条命中时返回最近更新的那条。供 MCP create_session 复用同目标会话使用。
   */
  findByTarget(session: SessionConfig): SessionConfig | null {
    this.ensureInitialized()
    const key = this.getHostKey(session)
    if (!key) return null
    let best: SessionConfig | null = null
    for (const existing of this.sessions.values()) {
      if (this.getHostKey(existing) !== key) continue
      if (!best || existing.updatedAt > best.updatedAt) best = existing
    }
    return best ? this.materializeSession(best) : null
  }

  /**
   * 检查会话配置是否相同（忽略 ID 和时间戳）
   */
  private isSameConfig(a: SessionConfig, b: SessionConfig): boolean {
    // 比较基本信息
    if (a.name !== b.name || a.type !== b.type || a.ownerPluginId !== b.ownerPluginId) return false

    // 比较 SSH 配置
    if (a.ssh && b.ssh) {
      if (a.ssh.host !== b.ssh.host ||
          a.ssh.port !== b.ssh.port ||
          a.ssh.username !== b.ssh.username) return false
      // 密码和私钥可能不同，但不影响判断是否是同一个目标主机
    } else if (a.ssh || b.ssh) {
      return false
    }

    // 比较 Telnet 配置
    if (a.telnet && b.telnet) {
      if (a.telnet.host !== b.telnet.host ||
          a.telnet.port !== b.telnet.port) return false
    } else if (a.telnet || b.telnet) {
      return false
    }

    // 比较 Serial 配置
    if (a.serial && b.serial) {
      if (a.serial.path !== b.serial.path ||
          a.serial.baudRate !== b.serial.baudRate) return false
    } else if (a.serial || b.serial) {
      return false
    }

    // 比较 Local 配置
    if (a.local && b.local) {
      if (a.local.shell !== b.local.shell ||
          a.local.cwd !== b.local.cwd) return false
      // shellArgs 参与同一性判定：同 shell 不同参数是不同启动目标（如 pwsh
      // -NoProfile 的 agent 宿主 vs 交互 pwsh）；缺省与空数组视为等价
      const argsA = a.local.shellArgs ?? []
      const argsB = b.local.shellArgs ?? []
      if (argsA.length !== argsB.length || argsA.some((v, i) => v !== argsB[i])) return false
    } else if (a.local || b.local) {
      return false
    }

    return true
  }

  /**
   * 保存会话（新建或更新）
   * 如果没有 ID，会检查是否已存在相同配置的会话
   *
   * 提交成功后兼容旧调用方回填新 id；失败不改入参，返回运行期副本。
   */
  saveSession(input: SessionConfig, options: RevisionOptions = {}): SessionConfig {
    this.ensureInitialized()
    this.assertRevision(options.expectedRevision)
    const now = new Date()
    let session = cloneSession(input)

    // 如果没有 id，检查是否已存在相同配置的会话
    if (!session.id) {
      for (const existing of this.sessions.values()) {
        if (this.isSameConfig(session, existing)) {
          // 找到相同配置的会话，更新它而不是创建新的
          log.info(`Found existing session with same config: ${existing.id}, updating instead of creating new`)
          session.id = existing.id
          session.createdAt = existing.createdAt
          // 合并 tags（保留原有的 pinned tag）
          if (existing.tags?.includes('pinned') && !session.tags?.includes('pinned')) {
            session.tags = [...(session.tags || []), 'pinned']
            if (existing.pinOrder !== undefined) {
              session.pinOrder = existing.pinOrder
            }
          }
          break
        }
      }

      // 如果还是没有 id，说明是全新的会话
      if (!session.id) {
        session.id = uuidv4()
        session.createdAt = now
      }
    } else if (!this.sessions.has(session.id)) {
      session.createdAt = now
    }

    // 秘密边界：UI/外部送来的占位符只能保留「本记录自己原来的秘密」。
    // previous 取运行期形态（local env 已解析），伪造占位符/跨记录引用/改目标都会被拒绝。
    const previousRecord = session.id ? this.get(session.id) : null
    const hydrated = hydrateSessionSecrets(session, previousRecord, {
      lockedSshFields: session.id ? this.lockedSshFields(session.id) : []
    })
    session = hydrated.config

    const previousProtected = this.protectedSecrets.get(session.id)
    const nextProtected = { ...previousProtected }
    for (const field of SENSITIVE_SSH_FIELDS) {
      if (!nextProtected[field]) continue
      const value = input.ssh?.[field]
      if (value === '' || (value !== undefined && !isSecretPlaceholder(value))) {
        delete nextProtected[field]
      } else if (!hasSameSshTarget(session.ssh, previousRecord?.ssh)) {
        throw new Error('安全存储不可用：SSH target changed while credentials are locked; clear or replace the stored credentials first')
      }
    }

    const staleRefs: string[] = []
    let createdRefs: string[] = []
    if (session.local) {
      // 引用只认本记录上一条；入参 envSecretRefs 已在 hydrate 中丢弃
      const previousRefs = normalizeSecretRefs(previousRecord?.local?.envSecretRefs)
      const explicitKeys =
        session.local.secretEnvKeys !== undefined
          ? normalizeSecretKeys(session.local.secretEnvKeys)
          : normalizeSecretKeys(previousRecord?.local?.secretEnvKeys)
      const plan = planSecretEnv(this.secretStore, {
        incoming: session.local.env,
        existingRefs: previousRefs,
        explicitSecretKeys: explicitKeys
      })
      createdRefs = plan.created
      staleRefs.push(...plan.stale)
      session.local.env = Object.keys(plan.env).length > 0 ? plan.env : undefined
      session.local.envSecretRefs =
        Object.keys(plan.refs).length > 0 ? plan.refs : undefined
      session.local.secretEnvKeys = explicitKeys.length > 0 ? explicitKeys : undefined
    } else {
      // 整份 local 配置被移除：本记录原引用随记录一起失效
      staleRefs.push(...Object.values(normalizeSecretRefs(previousRecord?.local?.envSecretRefs)))
    }

    // 全新会话且用户没显式填 notes 时，尝试从同主机的已有会话继承 summary/usageNotes/tags
    // —— New session / Copy 到同一台机器不需要再手动补一次。
    // 已存在的会话（更新场景）不触发继承，避免把旧记录覆盖回来。
    const isBrandNew = !this.sessions.has(session.id)
    if (!isBrandNew) {
      // 归属是 main 写入的资源元数据，编辑/去重不能清掉，也不能转移给别的插件。
      session.ownerPluginId = this.sessions.get(session.id)?.ownerPluginId
    }
    if (isBrandNew) {
      this.inheritNotesFromSameHost(session)
    }

    session.updatedAt = now
    // 写入收口：任何来源（渲染层/agent/MCP）的非法 encoding 在进内存 map、落盘前归位
    sanitizeSessionEncoding(session)

    const previousSessions = this.sessions
    this.sessions = new Map(previousSessions)
    this.sessions.set(session.id, session)
    this.protectedSecrets.set(session.id, nextProtected)
    try {
      this.save()
    } catch (error) {
      // 写盘失败：内存恢复到提交前，调用方看到失败后不会留下「内存已改、盘未改」的假状态
      this.sessions = previousSessions
      if (previousProtected) this.protectedSecrets.set(session.id, previousProtected)
      else this.protectedSecrets.delete(session.id)
      // 本次为这条记录新建的引用随回滚一起清理；仍被其它记录引用的不动
      deleteSecretRefs(
        this.secretStore,
        createdRefs,
        this.collectLocalSecretRefs(),
        `sessions/${session.id} save rollback`
      )
      throw error
    }

    // 提交成功后才清理被替换/删除的旧引用；其它记录仍在引用的必须保留
    deleteSecretRefs(
      this.secretStore,
      staleRefs,
      this.collectLocalSecretRefs(),
      `sessions/${session.id} secret cleanup`
    )

    log.info(`Session saved: ${session.id} (${session.name})`)
    if (!input.id) input.id = session.id
    return this.materializeSession(session)
  }

  /** 更新必须命中现存保存项，防迟到写入重建已回收资源。 */
  updateSession(session: SessionConfig, options: RevisionOptions = {}): SessionConfig {
    this.ensureInitialized()
    this.assertRevision(options.expectedRevision)
    if (!this.sessions.has(session.id)) throw new Error(`Session not found: ${session.id}`)
    return this.saveSession(session, options)
  }

  /**
   * 计算某会话的"host key"，用于识别指向同一目标的会话。
   * SSH / Telnet 用 host+port，Serial 用 path，Local 无 host —— 返回 null。
   */
  private getHostKey(session: SessionConfig): string | null {
    if (session.ssh) return `ssh://${session.ssh.host}:${session.ssh.port}`
    if (session.telnet) return `telnet://${session.telnet.host}:${session.telnet.port}`
    if (session.serial) return `serial://${session.serial.path}`
    return null
  }

  /**
   * 用户是否已显式在新会话上填了 notes。tags 里的 'pinned' 是系统标签，不算 user notes。
   */
  private hasUserNotes(session: SessionConfig): boolean {
    if (session.summary && session.summary.trim() !== '') return true
    if (session.usageNotes && session.usageNotes.trim() !== '') return true
    const userTags = (session.tags || []).filter(t => t !== 'pinned')
    return userTags.length > 0
  }

  /**
   * 新建会话时，如用户未填 notes，从同主机（type + host + port）的最近已有会话继承。
   * 只填充空字段；用户已填的字段一律不覆盖。
   */
  private inheritNotesFromSameHost(session: SessionConfig): void {
    if (this.hasUserNotes(session)) return
    const key = this.getHostKey(session)
    if (!key) return

    let source: SessionConfig | null = null
    for (const existing of this.sessions.values()) {
      if (this.getHostKey(existing) !== key) continue
      if (!source || (existing.updatedAt > source.updatedAt)) {
        source = existing
      }
    }
    if (!source) return

    if ((!session.summary || session.summary.trim() === '') && source.summary) {
      session.summary = source.summary
    }
    if ((!session.usageNotes || session.usageNotes.trim() === '') && source.usageNotes) {
      session.usageNotes = source.usageNotes
    }
    // 继承 user tags；保留新会话已有的 pinned 等系统标签
    const existingSystemTags = (session.tags || []).filter(t => t === 'pinned')
    const inheritedUserTags = (source.tags || []).filter(t => t !== 'pinned')
    if (inheritedUserTags.length > 0) {
      const merged = new Set([...existingSystemTags, ...inheritedUserTags])
      session.tags = Array.from(merged)
    }

    log.info(`Session ${session.id} inherited notes from ${source.id} (host key: ${key})`)
  }

  /**
   * 删除会话
   */
  delete(id: string, options: RevisionOptions = {}): boolean {
    this.ensureInitialized()
    this.assertRevision(options.expectedRevision)
    if (!this.sessions.has(id)) return false

    // 落盘失败时恢复完整内存快照（含顺序），下一次回收必须重新尝试删除和写盘。
    const removedRefs = Object.values(
      normalizeSecretRefs(this.sessions.get(id)?.local?.envSecretRefs)
    )
    const previousSessions = this.sessions
    this.sessions = new Map(previousSessions)
    this.sessions.delete(id)
    try {
      this.save()
    } catch (error) {
      this.sessions = previousSessions
      throw error
    }

    // 只有提交成功后才回收该记录独占的 vault 引用；其它记录还在用的必须保留
    deleteSecretRefs(
      this.secretStore,
      removedRefs,
      this.collectLocalSecretRefs(),
      `sessions/${id} delete`
    )
    this.protectedSecrets.delete(id)
    log.info(`Session deleted: ${id}`)
    return true
  }

  /**
   * 查找会话（返回副本）
   */
  find(query: Partial<SessionConfig>): SessionConfig[] {
    this.ensureInitialized()
    const results: SessionConfig[] = []

    for (const session of this.sessions.values()) {
      let match = true

      for (const [key, value] of Object.entries(query)) {
        if (session[key as keyof SessionConfig] !== value) {
          match = false
          break
        }
      }

      if (match) results.push(cloneSession(session))
    }

    return results
  }

  /**
   * 获取常用会话（按连接次数排序）
   */
  getFavorites(): SessionConfig[] {
    this.ensureInitialized()
    return this.getAll()
      .filter(s => s.tags.includes('favorite'))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
  }

  /**
   * 获取最近连接的会话
   */
  getRecent(limit: number = 10): SessionConfig[] {
    this.ensureInitialized()
    return this.getAll()
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, limit)
  }

  /**
   * 清理重复会话（相同名称和主机配置）
   * 保留最近更新的版本，合并 tags
   * @param saveToDisk 是否保存到磁盘，默认 true
   */
  deduplicate(saveToDisk: boolean = true, options: RevisionOptions = {}): { removed: number, kept: SessionConfig[] } {
    this.ensureInitialized()
    this.assertRevision(options.expectedRevision)

    const uniqueSessions = new Map<string, SessionConfig>()
    const duplicates: SessionConfig[] = []
    let removed = 0

    for (const storedSession of this.sessions.values()) {
      // 合并仅修改候选快照；提交失败时旧 map 及其条目仍完整不变。
      const session = cloneSession(storedSession)
      // 生成唯一键（名称 + 类型 + 主机配置）
      const key = this.generateSessionKey(session)

      if (uniqueSessions.has(key)) {
        const existing = uniqueSessions.get(key)!

        // 比较更新时间，保留最新的
        if (session.updatedAt.getTime() > existing.updatedAt.getTime()) {
          // 合并 tags（保留 pinned）
          if (existing.tags?.includes('pinned') && !session.tags?.includes('pinned')) {
            session.tags = [...(session.tags || []), 'pinned']
          }
          if (existing.pinOrder !== undefined && session.pinOrder === undefined) {
            session.pinOrder = existing.pinOrder
          }

          duplicates.push(existing)
          uniqueSessions.set(key, session)
          removed++
        } else {
          // 合并 tags 到保留的会话
          if (session.tags?.includes('pinned') && !existing.tags?.includes('pinned')) {
            existing.tags = [...(existing.tags || []), 'pinned']
          }
          if (session.pinOrder !== undefined && existing.pinOrder === undefined) {
            existing.pinOrder = session.pinOrder
          }

          duplicates.push(session)
          removed++
        }
      } else {
        uniqueSessions.set(key, session)
      }
    }

    // 更新存储；需要落盘时先写成功后替换内存，失败则保留完整旧快照。
    // uniqueSessions 以配置指纹为键用于去重，落回仓储前必须重新按 session.id 建索引。
    const rebuilt = new Map<string, SessionConfig>()
    for (const session of uniqueSessions.values()) rebuilt.set(session.id, session)
    const previousSessions = this.sessions
    this.sessions = rebuilt
    if (saveToDisk) {
      try {
        this.save()
      } catch (error) {
        this.sessions = previousSessions
        throw error
      }
      // 去重已提交：被移除记录的独占引用回收；keep 记录仍在引用的保留
      deleteSecretRefs(
        this.secretStore,
        duplicates.flatMap(session =>
          Object.values(normalizeSecretRefs(session.local?.envSecretRefs))
        ),
        this.collectLocalSecretRefs(),
        'sessions deduplicate'
      )
    }

    log.info(`Deduplicated sessions: removed ${removed} duplicates, kept ${uniqueSessions.size} unique sessions`)
    return { removed, kept: Array.from(rebuilt.values()).map(cloneSession) }
  }

  /**
   * 生成会话唯一键（用于去重）
   */
  private generateSessionKey(session: SessionConfig): string {
    const parts = [session.name, session.type]

    if (session.ssh) {
      parts.push(session.ssh.host, String(session.ssh.port), session.ssh.username)
    } else if (session.telnet) {
      parts.push(session.telnet.host, String(session.telnet.port))
    } else if (session.serial) {
      parts.push(session.serial.path, String(session.serial.baudRate))
    } else if (session.local) {
      // shellArgs 参与 key（JSON 编码，防数组元素里的 '|' 撞键分隔符）：同 shell 不同
      // 参数是不同启动目标 —— isSameConfig 已同口径，这里不跟上会让 session:deduplicate
      // 误删其一
      parts.push(session.local.shell || 'default', session.local.cwd || 'default', JSON.stringify(session.local.shellArgs ?? []))
    }

    // 用户配置和不同插件配置分别去重，不能因目标相同而丢掉原归属的保存项。
    return JSON.stringify([session.ownerPluginId ?? null, ...parts])
  }
}

// 用户偏好设置存储
export class PreferencesRepository {
  private filePath: string | null = null
  private preferences: Record<string, any> = {}
  private loaded: boolean = false
  private revision: number = 0
  private loadError: JsonStoreLoadError | null = null

  private ensureInitialized(): void {
    if (!this.filePath) {
      this.filePath = join(getConfigDir(), 'preferences.json')
      this.load()
    }
  }

  private load(): void {
    if (!this.filePath || this.loaded) return

    const result = loadJsonFileSync<Record<string, unknown>>(this.filePath, {
      validate: raw => {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          throw new Error('preferences.json must be a JSON object')
        }
        return raw as Record<string, unknown>
      }
    })
    this.loaded = true
    if (result.status === 'missing') return
    if (result.status === 'failed') {
      this.loadError = result.error
      log.error('Failed to load preferences, keeping damaged file untouched:', result.error)
      return
    }
    this.preferences = result.value
    if (result.status === 'recovered') {
      log.warn(`preferences.json was corrupt; restored from backup (damaged copy: ${result.preservedPath ?? 'unavailable'})`)
    }
    log.info('Loaded preferences from storage')
  }

  private assertWritable(): void {
    if (this.loadError) throw this.loadError
  }

  private assertRevision(expectedRevision: number | undefined): void {
    if (expectedRevision === undefined) return
    if (expectedRevision !== this.revision) {
      throw new RevisionConflictError(this.filePath ?? 'preferences.json', expectedRevision, this.revision)
    }
  }

  /** 先落盘、后替换内存：写失败时内存保持旧值并向调用方抛错。 */
  private commit(next: Record<string, unknown>): void {
    if (!this.filePath) return
    const json = JSON.stringify(next, null, 2)
    atomicWriteFileSync(this.filePath, json)
    if (!writeBackupSync(this.filePath, json)) {
      log.warn('Failed to refresh preferences.json backup; primary commit succeeded')
    }
    this.preferences = next
    this.revision += 1
  }

  getRevision(): number {
    this.ensureInitialized()
    return this.revision
  }

  getLoadError(): JsonStoreLoadError | null {
    this.ensureInitialized()
    return this.loadError
  }

  get(key: string): any {
    this.ensureInitialized()
    return cloneJsonValue(this.preferences[key])
  }

  set(key: string, value: any, options: RevisionOptions = {}): void {
    this.ensureInitialized()
    this.assertWritable()
    this.assertRevision(options.expectedRevision)
    this.commit({ ...this.preferences, [key]: cloneJsonValue(value) })
  }

  getAll(): Record<string, any> {
    this.ensureInitialized()
    return cloneJsonValue(this.preferences)
  }

  reset(options: RevisionOptions = {}): void {
    this.ensureInitialized()
    this.assertWritable()
    this.assertRevision(options.expectedRevision)
    this.commit({})
  }
}

// 单例 - 可以在模块加载时创建，因为使用了延迟初始化
export const sessionRepository = new SessionRepository()
export const preferencesRepository = new PreferencesRepository()

/**
 * 快速命令分组
 */
export interface QuickCommandGroup {
  id: string
  name: string
  color?: string    // 分组颜色（可选）
  order: number     // 排序顺序
}

/**
 * 快速命令
 */
export interface QuickCommand {
  id: string
  name: string
  content: string
  groupId?: string  // 所属分组ID（可选）
  escapeSequences?: boolean  // 发送时解析转义字符（\n \r \t \xHH）
}

/**
 * 快速命令数据（包含命令和分组）
 */
interface QuickCommandsData {
  commands: QuickCommand[]
  groups: QuickCommandGroup[]
}

const normalizeQuickCommands = (raw: unknown): QuickCommandsData => {
  if (Array.isArray(raw)) {
    // 旧格式：只有命令数组
    return {
      commands: raw.map(cmd => ({ ...(cmd as QuickCommand), groupId: (cmd as QuickCommand).groupId || undefined })),
      groups: []
    }
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('quickCommands.json must be an object or a legacy array')
  }
  const data = raw as { commands?: unknown; groups?: unknown }
  if (data.commands !== undefined && !Array.isArray(data.commands)) {
    throw new Error('quickCommands.commands must be an array')
  }
  if (data.groups !== undefined && !Array.isArray(data.groups)) {
    throw new Error('quickCommands.groups must be an array')
  }
  return {
    commands: ((data.commands ?? []) as QuickCommand[]).map(cmd => ({ ...cmd, groupId: cmd.groupId || undefined })),
    groups: (data.groups ?? []) as QuickCommandGroup[]
  }
}

export class QuickCommandsRepository {
  private filePath: string | null = null
  private commands: QuickCommand[] = []
  private groups: QuickCommandGroup[] = []
  private loaded: boolean = false
  private revision: number = 0
  private loadError: JsonStoreLoadError | null = null

  private ensureInitialized(): void {
    if (!this.filePath) {
      this.filePath = join(getConfigDir(), 'quickCommands.json')
      this.load()
    }
  }

  private load(): void {
    if (!this.filePath || this.loaded) return

    const result = loadJsonFileSync<QuickCommandsData>(this.filePath, { validate: normalizeQuickCommands })
    this.loaded = true
    if (result.status === 'missing') {
      log.info('No quickCommands file found, starting fresh')
      return
    }
    if (result.status === 'failed') {
      this.loadError = result.error
      log.error('Failed to load quick commands, keeping damaged file untouched:', result.error)
      return
    }
    this.commands = result.value.commands
    this.groups = result.value.groups
    if (result.status === 'recovered') {
      log.warn(`quickCommands.json was corrupt; restored from backup (damaged copy: ${result.preservedPath ?? 'unavailable'})`)
    }
    log.info(`Loaded ${this.commands.length} quick commands and ${this.groups.length} groups from storage`)
  }

  private assertWritable(): void {
    if (this.loadError) throw this.loadError
  }

  private assertRevision(expectedRevision: number | undefined): void {
    if (expectedRevision === undefined) return
    if (expectedRevision !== this.revision) {
      throw new RevisionConflictError(this.filePath ?? 'quickCommands.json', expectedRevision, this.revision)
    }
  }

  /** 先写成功、后替换内存：失败时旧状态完整保留，调用方收到异常。 */
  private commit(nextCommands: QuickCommand[], nextGroups: QuickCommandGroup[]): void {
    if (!this.filePath) return
    const data: QuickCommandsData = { commands: nextCommands, groups: nextGroups }
    const json = JSON.stringify(data, null, 2)
    atomicWriteFileSync(this.filePath, json)
    if (!writeBackupSync(this.filePath, json)) {
      log.warn('Failed to refresh quickCommands.json backup; primary commit succeeded')
    }
    this.commands = nextCommands
    this.groups = nextGroups
    this.revision += 1
    log.info(`Saved ${nextCommands.length} quick commands and ${nextGroups.length} groups to storage`)
  }

  getRevision(): number {
    this.ensureInitialized()
    return this.revision
  }

  getLoadError(): JsonStoreLoadError | null {
    this.ensureInitialized()
    return this.loadError
  }

  // ========== 命令操作 ==========

  getAll(): QuickCommand[] {
    this.ensureInitialized()
    return this.commands.map(cmd => cloneJsonValue(cmd))
  }

  saveAll(commands: QuickCommand[], options: RevisionOptions = {}): void {
    this.ensureInitialized()
    this.assertWritable()
    this.assertRevision(options.expectedRevision)
    this.commit(commands.map(cmd => cloneJsonValue(cmd)), this.groups.map(group => cloneJsonValue(group)))
  }

  add(command: QuickCommand, options: RevisionOptions = {}): QuickCommand {
    this.ensureInitialized()
    this.assertWritable()
    this.assertRevision(options.expectedRevision)
    const next = cloneJsonValue(command)
    if (!next.id) {
      next.id = uuidv4()
    }
    this.commit([...this.commands.map(cmd => cloneJsonValue(cmd)), next], this.groups.map(group => cloneJsonValue(group)))
    return cloneJsonValue(next)
  }

  update(command: QuickCommand, options: RevisionOptions = {}): boolean {
    this.ensureInitialized()
    this.assertWritable()
    this.assertRevision(options.expectedRevision)
    const index = this.commands.findIndex(c => c.id === command.id)
    if (index === -1) return false
    const next = this.commands.map(cmd => cloneJsonValue(cmd))
    next[index] = cloneJsonValue(command)
    this.commit(next, this.groups.map(group => cloneJsonValue(group)))
    return true
  }

  delete(id: string, options: RevisionOptions = {}): boolean {
    this.ensureInitialized()
    this.assertWritable()
    this.assertRevision(options.expectedRevision)
    const index = this.commands.findIndex(c => c.id === id)
    if (index === -1) return false
    this.commit(
      this.commands.filter(c => c.id !== id).map(cmd => cloneJsonValue(cmd)),
      this.groups.map(group => cloneJsonValue(group))
    )
    return true
  }

  // ========== 分组操作 ==========

  getAllGroups(): QuickCommandGroup[] {
    this.ensureInitialized()
    return this.groups
      .map(group => cloneJsonValue(group))
      .sort((a, b) => a.order - b.order)
  }

  addGroup(group: QuickCommandGroup, options: RevisionOptions = {}): QuickCommandGroup {
    this.ensureInitialized()
    this.assertWritable()
    this.assertRevision(options.expectedRevision)
    const next = cloneJsonValue(group)
    if (!next.id) {
      next.id = uuidv4()
    }
    if (next.order === undefined) {
      next.order = this.groups.length
    }
    this.commit(
      this.commands.map(cmd => cloneJsonValue(cmd)),
      [...this.groups.map(g => cloneJsonValue(g)), next]
    )
    return cloneJsonValue(next)
  }

  updateGroup(group: QuickCommandGroup, options: RevisionOptions = {}): boolean {
    this.ensureInitialized()
    this.assertWritable()
    this.assertRevision(options.expectedRevision)
    const index = this.groups.findIndex(g => g.id === group.id)
    if (index === -1) return false
    const nextGroups = this.groups.map(g => cloneJsonValue(g))
    nextGroups[index] = cloneJsonValue(group)
    this.commit(this.commands.map(cmd => cloneJsonValue(cmd)), nextGroups)
    return true
  }

  deleteGroup(id: string, options: RevisionOptions = {}): boolean {
    this.ensureInitialized()
    this.assertWritable()
    this.assertRevision(options.expectedRevision)
    const index = this.groups.findIndex(g => g.id === id)
    if (index === -1) return false
    // 分组删除与命令解绑必须同一次提交，不能出现「分组已删、命令仍指向它」的中间态
    this.commit(
      this.commands.map(cmd => (cmd.groupId === id ? { ...cloneJsonValue(cmd), groupId: undefined } : cloneJsonValue(cmd))),
      this.groups.filter(g => g.id !== id).map(g => cloneJsonValue(g))
    )
    return true
  }

  reorderGroups(groupIds: string[], options: RevisionOptions = {}): void {
    this.ensureInitialized()
    this.assertWritable()
    this.assertRevision(options.expectedRevision)
    const nextGroups = this.groups.map(group => cloneJsonValue(group))
    groupIds.forEach((id, order) => {
      const group = nextGroups.find(g => g.id === id)
      if (group) {
        group.order = order
      }
    })
    this.commit(this.commands.map(cmd => cloneJsonValue(cmd)), nextGroups)
  }
}

export const quickCommandsRepository = new QuickCommandsRepository()
