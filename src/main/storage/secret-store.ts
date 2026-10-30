import { join } from 'path'
import { randomBytes } from 'crypto'
import { safeStorage } from 'electron'
import log from 'electron-log'
import {
  atomicWriteFileSync,
  JsonStoreLoadError,
  loadJsonFileSync,
  writeBackupSync
} from './atomic-json'
import { getConfigDir } from './repository'
import { isStrongSecureStorage } from '../security/secure-storage'
import { SECRET_PLACEHOLDER, isSecretEnvKey, isSecretPlaceholder } from '@shared/harness'

/**
 * 秘密存储（Secret Vault）—— 用 Electron safeStorage 加密，普通配置文件只保存随机
 * secretRef。SSH 的 safe:v1 密文由 storage/repository.ts 自己维护，不在本模块范围。
 *
 * 设计纪律：
 * - 值只以密文出现（base64），日志/错误信息里绝不带明文或密文。
 * - 平台不可用（含 Linux basic_text 弱后端）明确失败，不新增明文降级。
 * - 文件损坏 / 未知 schema 时 fail closed：读失败、写拒绝，损坏原件保留。
 * - 写盘复用 atomic-json 的原子写 + 备份；put 在提交前自解密校验。
 */

export const SECRET_REF_PREFIX = 'sec_'

/** 单条秘密明文上限（字符） */
const MAX_SECRET_VALUE_LENGTH = 65536

/** vault 条目上限——兜异常增长，正常使用远达不到 */
const DEFAULT_MAX_ENTRIES = 1024

/** 单条记录显式声明秘密键的上限 */
const MAX_SECRET_KEYS = 128

const SECRET_REF_PATTERN = /^sec_[0-9a-f]{32}$/

/** 引用形态校验；只接受本模块生成的随机引用。 */
export function isSecretRef(value: unknown): value is string {
  return typeof value === 'string' && SECRET_REF_PATTERN.test(value)
}

/** 平台加密后端抽象；默认实现包 electron safeStorage，测试可注入。 */
export interface SecretCipher {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
  getSelectedStorageBackend?(): string
}

export type SecretResolveFailure =
  | 'invalid_ref'
  | 'not_found'
  | 'unavailable'
  | 'corrupt'
  | 'decrypt_failed'

export type SecretResolveResult =
  | { ok: true; value: string }
  | { ok: false; reason: SecretResolveFailure }

export interface SecretStoreStatus {
  /** 当前平台后端是否可用；false 时 put 直接失败（不降级明文） */
  available: boolean
  /** win32: dpapi；darwin: keychain；linux: kwallet / gnome_libsecret / basic_text / unknown */
  backend: string
  /** Linux basic_text 等弱后端：按不可用处理 */
  weak: boolean
  /** vault 条目数（文件损坏时为 0） */
  entries: number
  /** 文件损坏 / schema 不支持：读失败、写拒绝 */
  corrupt: boolean
  reason?: 'unavailable' | 'basic_text' | 'corrupt'
}

export type SecretStoreErrorCode =
  | 'unavailable'
  | 'corrupt'
  | 'invalid_secret'
  | 'too_large'
  | 'capacity'
  | 'encrypt_failed'
  | 'write_failed'

/** 秘密存储错误：message 只描述原因，绝不包含秘密值。 */
export class SecretStoreError extends Error {
  readonly code: SecretStoreErrorCode

  constructor(code: SecretStoreErrorCode, message: string) {
    super(message)
    this.name = 'SecretStoreError'
    this.code = code
  }
}

interface SecretEntry {
  ciphertext: string
  createdAt: number
  updatedAt: number
}

interface SecretFile {
  version: 1
  entries: Record<string, SecretEntry>
}

function createElectronCipher(): SecretCipher {
  return {
    isEncryptionAvailable: () => {
      try {
        return Boolean(safeStorage) && safeStorage.isEncryptionAvailable()
      } catch {
        return false
      }
    },
    encryptString: (plain) => {
      if (!safeStorage) throw new SecretStoreError('unavailable', 'secure storage is not available')
      return safeStorage.encryptString(plain)
    },
    decryptString: (encrypted) => {
      if (!safeStorage) throw new SecretStoreError('unavailable', 'secure storage is not available')
      return safeStorage.decryptString(encrypted)
    },
    getSelectedStorageBackend: () => {
      try {
        return typeof safeStorage?.getSelectedStorageBackend === 'function'
          ? safeStorage.getSelectedStorageBackend()
          : 'unknown'
      } catch {
        return 'unknown'
      }
    }
  }
}

export interface SecretStoreOptions {
  /** 默认 <userData>/config/secrets.json；测试可指向临时文件 */
  filePath?: string
  /** 默认 electron safeStorage */
  cipher?: SecretCipher
  /** 默认 1024 */
  maxEntries?: number
  /** 测试用：覆盖平台判定（basic_text 弱后端） */
  platform?: NodeJS.Platform
}

function emptyEntries(): Record<string, SecretEntry> {
  return Object.create(null) as Record<string, SecretEntry>
}

export class SecretStore {
  private readonly configuredPath: string | null
  private resolvedPath: string | null = null
  private readonly cipher: SecretCipher
  private readonly maxEntries: number
  private readonly platform: NodeJS.Platform
  private loaded = false
  private loadError: JsonStoreLoadError | null = null
  private corrupt = false
  private entries: Record<string, SecretEntry> = emptyEntries()

  constructor(options: SecretStoreOptions = {}) {
    this.configuredPath = options.filePath ?? null
    this.cipher = options.cipher ?? createElectronCipher()
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.platform = options.platform ?? process.platform
  }

  /** vault 文件绝对路径（懒解析，构造时不触碰 electron app） */
  getFilePath(): string {
    this.ensureInitialized()
    return this.resolvedPath ?? ''
  }

  /** 加载失败详情（供诊断；不包含任何秘密） */
  getLoadError(): JsonStoreLoadError | null {
    this.ensureInitialized()
    return this.loadError
  }

  private ensureInitialized(): void {
    if (this.loaded) return
    this.loaded = true
    this.resolvedPath = this.configuredPath ?? join(getConfigDir(), 'secrets.json')
    this.load()
  }

  private load(): void {
    if (!this.resolvedPath) return
    const result = loadJsonFileSync<SecretFile>(this.resolvedPath, {
      validate: (raw) => {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          throw new Error('secrets file must be a JSON object')
        }
        const obj = raw as Record<string, unknown>
        if (obj.version !== 1) throw new Error('unsupported secrets file version')
        if (typeof obj.entries !== 'object' || obj.entries === null || Array.isArray(obj.entries)) {
          throw new Error('secrets entries must be an object')
        }
        const entries = emptyEntries()
        if (Object.keys(obj.entries).length > this.maxEntries) throw new Error('secret vault entry limit exceeded')
        for (const [ref, value] of Object.entries(obj.entries as Record<string, unknown>)) {
          // 不能跳过坏条目后继续保存，否则下一次写入会永久抹掉原密文。
          if (!isSecretRef(ref) || typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid secret vault entry')
          const entry = value as Record<string, unknown>
          if (typeof entry.ciphertext !== 'string' || entry.ciphertext.length === 0 || entry.ciphertext.length > 512 * 1024 ||
            Buffer.from(entry.ciphertext, 'base64').toString('base64') !== entry.ciphertext) throw new Error('invalid secret vault ciphertext')
          const createdAt = typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt)
            ? entry.createdAt
            : 0
          const updatedAt = typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt)
            ? entry.updatedAt
            : createdAt
          entries[ref] = { ciphertext: entry.ciphertext, createdAt, updatedAt }
        }
        return { version: 1, entries }
      }
    })

    if (result.status === 'failed') {
      this.corrupt = true
      this.loadError = result.error
      this.entries = emptyEntries()
      // 只报路径，不报内容
      log.error(`Failed to load secret vault (${this.resolvedPath}), keeping damaged file untouched:`, result.error)
      return
    }
    if (result.status === 'missing') {
      this.entries = emptyEntries()
      return
    }
    this.entries = result.value.entries
    if (result.status === 'recovered') {
      log.warn(`Secret vault was corrupt; restored from backup (${this.resolvedPath})`)
    }
  }

  private encryptionUsable(): boolean {
    return isStrongSecureStorage(this.cipher, this.platform)
  }

  private detectBackend(): string {
    if (this.platform === 'win32') return 'dpapi'
    if (this.platform === 'darwin') return 'keychain'
    try {
      return this.cipher.getSelectedStorageBackend?.() ?? 'unknown'
    } catch {
      return 'unknown'
    }
  }

  private isWeakBackend(): boolean {
    return this.platform === 'linux' && this.detectBackend() === 'basic_text'
  }

  status(): SecretStoreStatus {
    this.ensureInitialized()
    const backend = this.detectBackend()
    const weak = this.isWeakBackend()
    const available = !this.corrupt && !weak && this.encryptionUsable()
    let reason: SecretStoreStatus['reason']
    if (this.corrupt) reason = 'corrupt'
    else if (weak) reason = 'basic_text'
    else if (!available) reason = 'unavailable'
    return {
      available,
      backend,
      weak,
      entries: Object.keys(this.entries).length,
      corrupt: this.corrupt,
      ...(reason ? { reason } : {})
    }
  }

  private assertWritable(): void {
    this.ensureInitialized()
    if (this.corrupt) {
      throw new SecretStoreError('corrupt', 'secret vault is damaged; refusing to write')
    }
    if (this.isWeakBackend()) {
      throw new SecretStoreError('unavailable', 'secure storage backend is not protected (basic_text)')
    }
    if (!this.encryptionUsable()) {
      throw new SecretStoreError('unavailable', 'secure storage is not available')
    }
  }

  /** 保存秘密并返回随机引用；失败抛 SecretStoreError（不写明文）。 */
  put(secret: string): string {
    this.assertWritable()
    if (typeof secret !== 'string' || secret.length === 0) {
      throw new SecretStoreError('invalid_secret', 'secret must be a non-empty string')
    }
    if (secret.length > MAX_SECRET_VALUE_LENGTH) {
      throw new SecretStoreError('too_large', 'secret exceeds the maximum length')
    }
    if (Object.keys(this.entries).length >= this.maxEntries) {
      throw new SecretStoreError('capacity', 'secret vault reached its capacity limit')
    }

    let encrypted: Buffer
    try {
      encrypted = this.cipher.encryptString(secret)
    } catch {
      throw new SecretStoreError('encrypt_failed', 'failed to encrypt secret')
    }
    // 提交前自校验：加密/解密不一致说明后端异常，宁可不写入
    let verified: string
    try {
      verified = this.cipher.decryptString(encrypted)
    } catch {
      throw new SecretStoreError('encrypt_failed', 'failed to verify encrypted secret')
    }
    if (verified !== secret) {
      throw new SecretStoreError('encrypt_failed', 'encrypted secret failed read-back verification')
    }

    const ref = `${SECRET_REF_PREFIX}${randomBytes(16).toString('hex')}`
    const now = Date.now()
    const next: Record<string, SecretEntry> = { ...this.entries }
    next[ref] = { ciphertext: encrypted.toString('base64'), createdAt: now, updatedAt: now }
    this.commit(next)
    return ref
  }

  /** 解析引用；失败返回明确原因，绝不返回 undefined 让调用方误覆盖。 */
  resolve(ref: string): SecretResolveResult {
    this.ensureInitialized()
    if (!isSecretRef(ref)) return { ok: false, reason: 'invalid_ref' }
    if (this.corrupt) return { ok: false, reason: 'corrupt' }
    const entry = this.entries[ref]
    if (!entry) return { ok: false, reason: 'not_found' }
    if (this.isWeakBackend() || !this.encryptionUsable()) return { ok: false, reason: 'unavailable' }
    try {
      const value = this.cipher.decryptString(Buffer.from(entry.ciphertext, 'base64'))
      if (typeof value !== 'string' || value.length === 0) {
        log.warn(`Secret ${ref} decrypted to an empty value`)
        return { ok: false, reason: 'decrypt_failed' }
      }
      return { ok: true, value }
    } catch {
      // 不打印密文/明文
      log.warn(`Failed to decrypt secret ${ref}`)
      return { ok: false, reason: 'decrypt_failed' }
    }
  }

  /** 删除引用；幂等（不存在返回 true）。写入失败返回 false 并保留原状。 */
  delete(ref: string): boolean {
    this.ensureInitialized()
    if (this.corrupt) return false
    if (!isSecretRef(ref)) return false
    if (!this.entries[ref]) return true
    const next: Record<string, SecretEntry> = { ...this.entries }
    delete next[ref]
    try {
      this.commit(next)
      return true
    } catch {
      return false
    }
  }

  private commit(next: Record<string, SecretEntry>): void {
    if (!this.resolvedPath) throw new SecretStoreError('write_failed', 'secret vault path is not resolved')
    const json = JSON.stringify({ version: 1, entries: next }, null, 2)
    try {
      atomicWriteFileSync(this.resolvedPath, json)
    } catch (error) {
      log.error(`Failed to save secret vault (${this.resolvedPath}):`, error)
      throw new SecretStoreError('write_failed', 'failed to write secret vault')
    }
    // 提交成功后才更新内存与备份；备份失败只告警，主文件已生效
    this.entries = next
    if (!writeBackupSync(this.resolvedPath, json)) {
      log.warn(`Failed to refresh secret vault backup (${this.resolvedPath})`)
    }
  }
}

/** 默认 vault；仓储默认使用它，测试通过构造器注入隔离实例。 */
export const secretStore = new SecretStore()

/** 启动边界必须核实全部引用，不能把解密失败当作「未配置」继承其它凭据。 */
export function assertResolvedSecrets(record: {
  envSecretRefs?: Record<string, string>
  apiKeyRef?: string
  env?: Record<string, string>
  apiKey?: string
}): void {
  const missingEnv = Object.keys(record.envSecretRefs ?? {}).some(key => !record.env?.[key] || isSecretPlaceholder(record.env[key]))
  if (missingEnv || (record.apiKeyRef && (!record.apiKey || isSecretPlaceholder(record.apiKey)))) {
    throw new SecretStoreError('unavailable', 'Configured secrets could not be resolved; restore secure storage or replace the credentials before launching')
  }
}

/* ------------------------------------------------------------------ *
 * 仓储共用的纯函数：把「明文请求 / 已有引用」规划成磁盘形态。
 * 所有 put 失败都在内部清理本次新建引用后再抛出，调用方只需处理
 * 「规划成功但普通配置保存失败」的 created 清理。
 * ------------------------------------------------------------------ */

export interface SecretVaultReader {
  resolve(ref: string): SecretResolveResult
}

export interface SecretVaultWriter {
  put(secret: string): string
  delete(ref: string): boolean
}

export type SecretVault = SecretVaultReader & SecretVaultWriter

export interface SecretEnvPlan {
  /** 磁盘形态：只含非秘密值 */
  env: Record<string, string>
  /** 磁盘形态：秘密键 → 引用 */
  refs: Record<string, string>
  /** 本次新建的引用；普通配置保存失败时需回滚删除 */
  created: string[]
  /** 不再被引用的旧引用；普通配置保存成功后删除 */
  stale: string[]
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 归一化引用表：只保留合法 ref 的字符串键值。 */
export function normalizeSecretRefs(raw: unknown): Record<string, string> {
  if (!isStringRecord(raw)) return {}
  const refs: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key !== 'string' || key.length === 0) continue
    if (isSecretRef(value)) refs[key] = value
  }
  return refs
}

/** 归一化显式秘密键：trim、去重、上限。 */
export function normalizeSecretKeys(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const key = item.trim()
    if (!key) continue
    seen.add(key)
    if (seen.size >= MAX_SECRET_KEYS) break
  }
  return [...seen]
}

function mergeSecretKeys(refs: Record<string, string>, explicitKeys: string[] | undefined): Set<string> {
  const keys = new Set<string>()
  for (const key of Object.keys(refs)) keys.add(key)
  for (const key of explicitKeys ?? []) keys.add(key)
  return keys
}

/** 某个 env 键在该记录中是否按秘密处理。 */
export function isSecretRecordKey(
  key: string,
  refs: Record<string, string>,
  explicitKeys: string[] | undefined
): boolean {
  return Boolean(refs[key]) || (explicitKeys ?? []).includes(key) || isSecretEnvKey(key)
}

/** 归一化请求里的 env：丢弃非字符串键值，空串保留（表示删除）。 */
function normalizeIncomingEnv(raw: unknown): Record<string, string> {
  if (!isStringRecord(raw)) return {}
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key !== 'string' || key.length === 0) continue
    if (typeof value !== 'string') continue
    env[key] = value
  }
  return env
}

/**
 * 规划 env 写入（三个仓储共用）：
 * - 秘密键：占位符/未提供 → 保留原引用；空串 → 删除；真实值 → 新建引用替换。
 * - 非秘密键：明文写入。
 * - incoming 未出现的秘密键按删除处理（整份 env 替换语义）。
 */
export function planSecretEnv(
  vault: SecretVault,
  input: {
    incoming: unknown
    existingRefs?: Record<string, string>
    explicitSecretKeys?: string[]
  }
): SecretEnvPlan {
  const incoming = normalizeIncomingEnv(input.incoming)
  const existingRefs = input.existingRefs ?? {}
  const secretKeys = mergeSecretKeys(existingRefs, input.explicitSecretKeys)
  const env: Record<string, string> = {}
  const refs: Record<string, string> = {}
  const created: string[] = []
  const stale: string[] = []

  try {
    for (const [key, value] of Object.entries(incoming)) {
      const secret = secretKeys.has(key) || isSecretEnvKey(key) || isSecretPlaceholder(value)
      if (!secret) {
        env[key] = value
        continue
      }
      const previousRef = existingRefs[key]
      if (value === '') {
        if (previousRef) stale.push(previousRef)
        continue
      }
      if (isSecretPlaceholder(value)) {
        // 占位符只表示「保留原来的秘密」，绝不当作真实值写入
        if (previousRef) refs[key] = previousRef
        continue
      }
      // 运行期 get 的结果回写时值与原秘密相同：保留原引用，避免无意义的重加密
      if (previousRef) {
        const current = vault.resolve(previousRef)
        if (current.ok && current.value === value) {
          refs[key] = previousRef
          continue
        }
      }
      const ref = vault.put(value)
      created.push(ref)
      refs[key] = ref
      if (previousRef) stale.push(previousRef)
    }
    // 原有引用但请求里已无该键 → 删除；但若无法确认原值（解密失败/后端不可用/
    // vault 损坏），保留引用而不是按显式删除处理 —— 运行期 get 在解析失败时
    // 会缺这个键，回写不能把仍可恢复的秘密永久丢掉。
    for (const [key, ref] of Object.entries(existingRefs)) {
      if (Object.prototype.hasOwnProperty.call(incoming, key)) continue
      if (refs[key] === ref) continue
      const current = vault.resolve(ref)
      if (
        !current.ok &&
        (current.reason === 'decrypt_failed' || current.reason === 'unavailable' || current.reason === 'corrupt')
      ) {
        refs[key] = ref
        continue
      }
      stale.push(ref)
    }
  } catch (error) {
    for (const ref of created) {
      try {
        vault.delete(ref)
      } catch {
        log.warn(`Failed to roll back secret ${ref} after planning error`)
      }
    }
    throw error
  }

  return { env, refs, created, stale }
}

export type SecretValueAction = 'keep' | 'clear' | 'replace'

export interface SecretValuePlan {
  ref?: string
  created?: string
  stale?: string
  action: SecretValueAction
}

/**
 * 规划单个秘密值（env-profile 的 apiKey）：
 * undefined / 占位符 → 保留；空串 → 清除；真实值 → 替换。
 * 外部传入的 ref 永远不参与，只看仓库自己记录的 existingRef。
 */
export function planSecretValue(
  vault: SecretVault,
  input: { incoming: unknown; existingRef?: string }
): SecretValuePlan {
  const incoming = input.incoming
  const existingRef = input.existingRef

  if (incoming === undefined) return { ref: existingRef, action: 'keep' }
  if (typeof incoming !== 'string') return { ref: existingRef, action: 'keep' }
  const value = incoming.trim()
  if (isSecretPlaceholder(value)) return { ref: existingRef, action: 'keep' }
  if (value === '') return { stale: existingRef, action: 'clear' }

  if (existingRef) {
    const current = vault.resolve(existingRef)
    if (current.ok && current.value === value) return { ref: existingRef, action: 'keep' }
  }
  const ref = vault.put(value)
  return { ref, created: ref, stale: existingRef, action: 'replace' }
}

/**
 * 加载期迁移：把明文秘密写入 vault 并 read-back 校验，返回引用形态。
 * 已带 ref 的键跳过（幂等）。任一步失败清理本次新建 ref 后抛出，调用方保留明文原件。
 */
export function migrateSecretEnv(
  vault: SecretVault,
  input: {
    env: Record<string, string> | undefined
    refs: Record<string, string> | undefined
    explicitSecretKeys?: string[]
  }
): { env: Record<string, string>; refs: Record<string, string>; created: string[] } {
  const env: Record<string, string> = { ...(input.env ?? {}) }
  const refs: Record<string, string> = { ...(input.refs ?? {}) }
  const secretKeys = mergeSecretKeys(refs, input.explicitSecretKeys)
  const created: string[] = []

  try {
    for (const key of Object.keys(env)) {
      if (refs[key]) {
        if (!vault.resolve(refs[key]).ok) throw new Error('Existing secret reference cannot be verified; plaintext migration was not committed')
        // 已有引用：明文副本一律删除（引用是唯一事实来源），避免两者并存
        delete env[key]
        continue
      }
      if (!secretKeys.has(key) && !isSecretEnvKey(key)) continue
      const value = env[key]
      if (typeof value !== 'string' || value.length === 0) {
        delete env[key]
        continue
      }
      if (isSecretPlaceholder(value)) {
        // 占位符不是真实秘密：没有 ref 可保，删掉避免明文/占位符落盘
        delete env[key]
        continue
      }
      const ref = vault.put(value)
      created.push(ref)
      const readBack = vault.resolve(ref)
      if (!readBack.ok || readBack.value !== value) {
        throw new Error(`secret read-back verification failed for ${key}`)
      }
      refs[key] = ref
      delete env[key]
    }
  } catch (error) {
    for (const ref of created) {
      try {
        vault.delete(ref)
      } catch {
        log.warn(`Failed to roll back secret ${ref} after migration error`)
      }
    }
    throw error
  }

  return { env, refs, created }
}

/**
 * 是否存在需要迁移的明文秘密。
 *
 * 已有 ref 的键**不跳过**：ref 是唯一事实来源，同名明文副本必须由迁移剔除
 * （migrateSecretEnv 会校验 ref；校验失败则整体拒绝保存，绝不用明文兜底）。
 */
export function hasPlaintextSecrets(
  env: Record<string, string> | undefined,
  refs: Record<string, string> | undefined,
  explicitSecretKeys?: string[]
): boolean {
  if (!env) return false
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue
    if (isSecretPlaceholder(value)) continue
    if (isSecretRecordKey(key, refs ?? {}, explicitSecretKeys)) return true
  }
  return false
}

/** 解析 env 中的秘密引用；失败只记缺失键，不抛错、不带值。 */
export function resolveSecretEnv(
  reader: SecretVaultReader,
  env: Record<string, string> | undefined,
  refs: Record<string, string> | undefined,
  context: string
): { env: Record<string, string>; missing: string[] } {
  const resolved: Record<string, string> = { ...(env ?? {}) }
  const missing: string[] = []
  for (const [key, ref] of Object.entries(refs ?? {})) {
    delete resolved[key]
    const result = reader.resolve(ref)
    if (result.ok) {
      resolved[key] = result.value
    } else {
      missing.push(key)
      // 只报上下文/键名/原因，不报值或密文
      log.warn(`Failed to resolve secret env ${context}/${key}: ${result.reason}`)
    }
  }
  return { env: resolved, missing }
}

/** 公共 DTO 形态：秘密键的值换成固定占位符，引用表保留。 */
export function publicizeSecretEnv(
  env: Record<string, string> | undefined,
  refs: Record<string, string> | undefined,
  explicitSecretKeys?: string[]
): { env: Record<string, string>; refs: Record<string, string> } {
  const publicEnv: Record<string, string> = { ...(env ?? {}) }
  const publicRefs: Record<string, string> = { ...(refs ?? {}) }
  const secretKeys = new Set(Object.keys(publicRefs))
  for (const [key, value] of Object.entries(publicEnv)) {
    if (!value || isSecretPlaceholder(value)) continue
    if (isSecretRecordKey(key, publicRefs, explicitSecretKeys)) secretKeys.add(key)
  }
  for (const key of secretKeys) {
    publicEnv[key] = SECRET_PLACEHOLDER
  }
  return { env: publicEnv, refs: publicRefs }
}

/** 删除一组引用；仍被其他记录引用的跳过。失败只告警（留可诊断孤儿）。 */
export function deleteSecretRefs(
  writer: SecretVaultWriter,
  refs: Iterable<string>,
  stillUsed: Set<string>,
  context: string
): void {
  for (const ref of refs) {
    if (!isSecretRef(ref) || stillUsed.has(ref)) continue
    try {
      if (!writer.delete(ref)) log.warn(`Failed to delete stale secret ${ref} (${context})`)
    } catch {
      log.warn(`Failed to delete stale secret ${ref} (${context})`)
    }
  }
}
