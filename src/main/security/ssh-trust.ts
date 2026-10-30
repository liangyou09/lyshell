/**
 * SSH 主机密钥信任记录（主进程）。
 *
 * 与 `ssh-host-key.ts` 的分工：
 * - 指纹/endpoint/错误码/记录结构是纯函数，放在 ssh-host-key.ts，Worker 也能用；
 * - 本模块负责「落盘、加载校验、损坏保护、人工确认编排、可信记录列表/删除」，
 *   只在主进程使用（文件 Worker 拿不到 Electron，也绝不自行读盘信任）。
 *
 * 安全约束：
 * - 首次连接不自动信任；未知或变化的密钥默认拒绝；
 * - 只有人工确认（由可信 GUI 建连路径注入的回调）才允许写入新指纹；
 * - 保存失败即拒绝本次连接，绝不把「没存下来」说成「已永久信任」；
 * - 记录与错误里只有 host/port/指纹，没有密码、私钥、口令或 token。
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, statSync } from 'fs'
import { dirname, join } from 'path'
import { randomBytes } from 'crypto'
import {
  assertHostKeyMatches,
  isSshHostKeyError,
  normalizeSshEndpoint,
  normalizeSshHost,
  normalizeSshPort,
  describeSshHostKey,
  SSH_FINGERPRINT_PATTERN,
  SSH_HOST_KEY_CONFIRM_TIMEOUT_MS,
  SSH_HOST_KEY_SCHEMA_VERSION,
  SshHostKeyError,
  validateSshTrustFile,
  type SshHostKeyChallenge,
  type SshHostKeyInfo,
  type SshTrustFile,
  type SshTrustRecord,
  type TransferHostKeyExpectation
} from './ssh-host-key'

/** 可信主机记录文件名（位于 Electron userData 目录） */
export const SSH_TRUST_FILE_NAME = 'ssh-trusted-hosts.json'

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** userData 目录下可信记录文件的绝对路径 */
export function sshTrustFilePath(userDataDir: string): string {
  return join(userDataDir, SSH_TRUST_FILE_NAME)
}

/**
 * 同目录随机 tmp + fsync + rename 的原子写。
 * 不直接覆盖目标文件：崩溃时盘上要么是旧文件，要么是新文件，不会出现半个 JSON。
 * 刻意不复用 storage/repository 的 atomicWriteFileSync —— 那是另一个改动面，
 * 且这里需要 fsync 与随机 tmp 名。
 */
function writeJsonAtomic(filePath: string, data: string): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
  const tmpPath = `${filePath}.${randomBytes(6).toString('hex')}.tmp`
  let fd: number | null = null
  try {
    fd = openSync(tmpPath, 'wx', 0o600)
    writeFileSync(fd, data, 'utf-8')
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(tmpPath, filePath)
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // 关闭失败不影响原始错误
      }
    }
    try {
      rmSync(tmpPath, { force: true })
    } catch {
      // 清理失败不影响原始错误
    }
    throw error
  }
}

export interface SshTrustStoreOptions {
  filePath: string
  /** 便于测试注入时钟 */
  now?: () => Date
}

export interface SshTrustStoreStatus {
  corrupt: boolean
  message?: string
}

/**
 * 可信主机记录的仓储。损坏时全部读操作抛 `SSH_HOST_KEY_STORE_CORRUPT`，
 * 写操作也拒绝——不会用空库覆盖用户既有信任，也不会静默重新信任。
 */
export class SshTrustStore {
  private readonly filePath: string
  private readonly now: () => Date
  private loaded = false
  private corruption: string | null = null
  private records = new Map<string, SshTrustRecord>()

  constructor(options: SshTrustStoreOptions) {
    this.filePath = options.filePath
    this.now = options.now ?? (() => new Date())
  }

  get path(): string {
    return this.filePath
  }

  getStatus(): SshTrustStoreStatus {
    this.ensureLoaded()
    return this.corruption ? { corrupt: true, message: this.corruption } : { corrupt: false }
  }

  /** 全部可信记录（按 endpoint 排序）；损坏时抛错 */
  list(): SshTrustRecord[] {
    this.ensureLoaded()
    this.assertHealthy()
    return [...this.records.values()].sort((a, b) => a.endpoint.localeCompare(b.endpoint)).map(record => ({ ...record }))
  }

  /** 按 host/port 查记录；损坏时抛错 */
  get(host: string, port?: number | null): SshTrustRecord | null {
    this.ensureLoaded()
    this.assertHealthy()
    const record = this.records.get(normalizeSshEndpoint(host, port))
    return record ? { ...record } : null
  }

  /**
   * 写入（或替换）一条可信记录：先落盘，成功后才更新内存，
   * 保存失败抛 `SSH_HOST_KEY_SAVE_FAILED`，调用方必须据此拒绝连接。
   */
  trust(input: { host: string; port?: number | null; fingerprint: string; algorithm: string }): SshTrustRecord {
    this.ensureLoaded()
    this.assertHealthy()

    if (typeof input.fingerprint !== 'string' || !SSH_FINGERPRINT_PATTERN.test(input.fingerprint)) {
      throw new SshHostKeyError('SSH_HOST_KEY_INVALID', '可信主机指纹格式不合法，已拒绝写入')
    }
    if (typeof input.algorithm !== 'string' || !input.algorithm.trim()) {
      throw new SshHostKeyError('SSH_HOST_KEY_INVALID', '可信主机算法名为空，已拒绝写入')
    }

    const host = normalizeSshHost(input.host)
    const port = normalizeSshPort(input.port)
    const endpoint = normalizeSshEndpoint(host, port)
    if (!this.records.has(endpoint) && this.records.size >= 4096) throw new SshHostKeyError('SSH_HOST_KEY_SAVE_FAILED', 'SSH trust record limit reached')
    const existing = this.records.get(endpoint)
    const timestamp = this.now().toISOString()
    const record: SshTrustRecord = {
      schemaVersion: SSH_HOST_KEY_SCHEMA_VERSION,
      endpoint,
      host,
      port,
      algorithm: input.algorithm,
      fingerprint: input.fingerprint,
      trustedAt: existing?.trustedAt ?? timestamp,
      updatedAt: timestamp
    }

    const next = new Map(this.records)
    next.set(endpoint, record)
    this.persist(next)
    this.records = next
    return { ...record }
  }

  /** 删除一条可信记录；返回是否确实删掉了 */
  delete(host: string, port?: number | null): boolean {
    this.ensureLoaded()
    this.assertHealthy()

    const endpoint = normalizeSshEndpoint(host, port)
    if (!this.records.has(endpoint)) return false
    const next = new Map(this.records)
    next.delete(endpoint)
    this.persist(next)
    this.records = next
    return true
  }

  /** 丢弃内存缓存（测试/外部改动后重新读盘） */
  reload(): void {
    this.loaded = false
    this.corruption = null
    this.records = new Map()
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true

    let text: string
    try {
      if (!existsSync(this.filePath)) return
      if (statSync(this.filePath).size > 4 * 1024 * 1024) throw new Error('SSH trust store exceeds size limit')
      text = readFileSync(this.filePath, 'utf-8')
    } catch (error) {
      this.corruption = `读取失败：${errorMessage(error)}`
      return
    }

    try {
      const file: SshTrustFile = validateSshTrustFile(JSON.parse(text) as unknown)
      for (const record of file.records) this.records.set(record.endpoint, record)
    } catch (error) {
      this.records.clear()
      this.corruption = errorMessage(error)
    }
  }

  private assertHealthy(): void {
    if (!this.corruption) return
    throw new SshHostKeyError(
      'SSH_HOST_KEY_STORE_CORRUPT',
      `SSH 主机密钥信任记录已损坏，已拒绝继续（不会自动信任任何主机）：${this.filePath}；${this.corruption}`
    )
  }

  private persist(records: Map<string, SshTrustRecord>): void {
    const file: SshTrustFile = {
      schemaVersion: SSH_HOST_KEY_SCHEMA_VERSION,
      records: [...records.values()].sort((a, b) => a.endpoint.localeCompare(b.endpoint))
    }
    try {
      writeJsonAtomic(this.filePath, `${JSON.stringify(file, null, 2)}\n`)
    } catch (error) {
      throw new SshHostKeyError(
        'SSH_HOST_KEY_SAVE_FAILED',
        `保存 SSH 主机密钥信任记录失败（${this.filePath}）：${errorMessage(error)}；本次连接不会被记忆为可信`
      )
    }
  }
}

let injectedStore: SshTrustStore | null = null
let defaultStore: SshTrustStore | null = null

/**
 * 默认存储位置：Electron userData 目录。
 * 这里延迟 require electron —— 本模块被单测（或未来被 Worker）引入时，
 * 模块加载期不能触碰 Electron；测试通过 setSshTrustStoreForTests 注入临时目录。
 */
function resolveUserDataDir(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const electron = require('electron') as { app?: { getPath?: (name: string) => string } } | undefined
  const dir = electron?.app?.getPath?.('userData')
  if (!dir) {
    throw new SshHostKeyError('SSH_HOST_KEY_UNAVAILABLE', '无法定位配置目录，已拒绝建立未经主机密钥核验的 SSH 连接')
  }
  return dir
}

export function getSshTrustStore(): SshTrustStore {
  if (injectedStore) return injectedStore
  if (!defaultStore) defaultStore = new SshTrustStore({ filePath: sshTrustFilePath(resolveUserDataDir()) })
  return defaultStore
}

/** 测试用：注入临时存储；传 null 恢复默认（同时清掉默认实例缓存） */
export function setSshTrustStoreForTests(store: SshTrustStore | null): void {
  injectedStore = store
  defaultStore = null
}

export interface AuthorizeSshHostKeyOptions {
  /**
   * 人工确认回调。只有可信 GUI 建连路径可以注入；缺省表示「无人工确认」，
   * 未知或变化的密钥一律拒绝（自动化/AI/插件不得自报确认）。
   */
  confirm?: (challenge: SshHostKeyChallenge) => Promise<boolean>
  /** 确认最长等待，默认 SSH_HOST_KEY_CONFIRM_TIMEOUT_MS */
  confirmTimeoutMs?: number
  /** 连接是否仍然有效；关闭/取消后晚到的确认必须作废 */
  isActive?: () => boolean
  store?: SshTrustStore
}

function confirmWithTimeout(
  confirm: (challenge: SshHostKeyChallenge) => Promise<boolean>,
  challenge: SshHostKeyChallenge,
  timeoutMs: number
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })
  const pending = Promise.resolve().then(() => confirm(challenge))
  // 迟到的确认/拒绝必须被吞掉：超时后用户再点「允许」不能变成未处理的 rejection
  pending.catch(() => {})
  return Promise.race([pending, timeout]).catch(() => false).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/**
 * 校验实际收到的 SSH 主机公钥。
 *
 * - 与可信记录一致 → 直接放行（不弹窗）；
 * - 未知/变化且没有确认回调 → 抛 `SSH_HOST_KEY_UNKNOWN` / `SSH_HOST_KEY_CHANGED`；
 * - 有确认回调 → 人工确认；确认期间连接已关闭/取消则作废；
 * - 确认通过后**先保存再放行**，保存失败抛 `SSH_HOST_KEY_SAVE_FAILED` 并拒绝。
 */
export async function authorizeSshHostKey(
  rawKey: Buffer,
  host: string,
  port: number,
  options: AuthorizeSshHostKeyOptions = {}
): Promise<SshTrustRecord> {
  const normalizedHost = normalizeSshHost(host)
  const normalizedPort = normalizeSshPort(port)
  const endpoint = normalizeSshEndpoint(normalizedHost, normalizedPort)
  const info: SshHostKeyInfo = describeSshHostKey(rawKey)

  const store = options.store ?? getSshTrustStore()
  // 记录损坏时 store.get 抛 SSH_HOST_KEY_STORE_CORRUPT：这里不能兜成「未知→可确认」，
  // 否则损坏文件会被一次人工确认静默覆盖。
  const existing = store.get(normalizedHost, normalizedPort)
  if (existing && existing.fingerprint === info.fingerprint) return existing

  const challenge: SshHostKeyChallenge = {
    host: normalizedHost,
    port: normalizedPort,
    endpoint,
    algorithm: info.algorithm,
    fingerprint: info.fingerprint,
    changed: !!existing,
    ...(existing ? { previousFingerprint: existing.fingerprint } : {})
  }

  if (!options.confirm) {
    if (existing) {
      throw new SshHostKeyError(
        'SSH_HOST_KEY_CHANGED',
        `SSH 主机密钥已变化（${endpoint}）：可信 ${existing.fingerprint}，实际 ${info.fingerprint}；已拒绝连接，需人工确认后更新可信记录`,
        { host: normalizedHost, port: normalizedPort, endpoint, fingerprint: info.fingerprint, previousFingerprint: existing.fingerprint }
      )
    }
    throw new SshHostKeyError(
      'SSH_HOST_KEY_UNKNOWN',
      `该主机的 SSH 主机密钥尚未受信任（${endpoint}，${info.fingerprint}）；已拒绝连接，需人工确认`,
      { host: normalizedHost, port: normalizedPort, endpoint, fingerprint: info.fingerprint }
    )
  }

  const confirmed = await confirmWithTimeout(
    options.confirm,
    challenge,
    options.confirmTimeoutMs ?? SSH_HOST_KEY_CONFIRM_TIMEOUT_MS
  )
  if (!confirmed) {
    throw new SshHostKeyError(
      'SSH_HOST_KEY_REJECTED',
      `已拒绝该主机的 SSH 主机密钥（${endpoint}，${info.fingerprint}）`,
      { host: normalizedHost, port: normalizedPort, endpoint, fingerprint: info.fingerprint, previousFingerprint: challenge.previousFingerprint }
    )
  }
  if (options.isActive && !options.isActive()) {
    throw new SshHostKeyError(
      'SSH_HOST_KEY_REJECTED',
      `连接已关闭或取消，本次主机密钥确认作废（${endpoint}）`,
      { host: normalizedHost, port: normalizedPort, endpoint, fingerprint: info.fingerprint }
    )
  }

  if (store.get(normalizedHost, normalizedPort)?.fingerprint !== existing?.fingerprint) {
    throw new SshHostKeyError('SSH_HOST_KEY_REJECTED', '主机信任记录在确认期间已变化，请重新连接并核对指纹')
  }

  // 先保存再接受：保存失败必须拒绝，不能让界面显示「已永久信任」而盘上其实没有
  return store.trust({
    host: normalizedHost,
    port: normalizedPort,
    fingerprint: info.fingerprint,
    algorithm: info.algorithm
  })
}

/**
 * 主进程在真正 dispatch 文件 Worker 之前读取可信指纹。
 * 缺失即拒绝（文件传输没有人工确认通道，绝不首次即信任）。
 */
export function resolveTransferHostKey(
  config: { host: string; port: number },
  store: SshTrustStore = getSshTrustStore()
): TransferHostKeyExpectation {
  const host = normalizeSshHost(config.host)
  const port = normalizeSshPort(config.port)
  const endpoint = normalizeSshEndpoint(host, port)
  const record = store.get(host, port)
  if (!record) {
    throw new SshHostKeyError(
      'SSH_HOST_KEY_UNKNOWN',
      `该主机的 SSH 主机密钥尚未受信任（${endpoint}），已拒绝传输；请先在终端连接该主机并确认指纹`,
      { host, port, endpoint }
    )
  }
  return { endpoint: record.endpoint, fingerprint: record.fingerprint }
}

/** Worker 侧固定匹配（同样用于任何无人工确认的通道） */
export function assertTransferHostKey(
  rawKey: Buffer,
  host: string,
  port: number,
  expectedFingerprint: string | null | undefined
): SshHostKeyInfo {
  return assertHostKeyMatches(rawKey, host, port, expectedFingerprint)
}

export interface SshTrustSnapshot {
  records: SshTrustRecord[]
  corrupt: boolean
  message?: string
}

/**
 * 供 IPC 展示的只读快照：损坏时不抛错，而是返回 corrupt 标记 + 原因，
 * 让界面能明确提示「记录损坏，需要人工处理」，而不是显示成「没有可信主机」。
 */
export function getSshTrustSnapshot(): SshTrustSnapshot {
  const store = getSshTrustStore()
  const status = store.getStatus()
  if (status.corrupt) {
    return { records: [], corrupt: true, ...(status.message ? { message: status.message } : {}) }
  }
  try {
    return { records: store.list(), corrupt: false }
  } catch (error) {
    if (isSshHostKeyError(error) && error.code === 'SSH_HOST_KEY_STORE_CORRUPT') {
      return { records: [], corrupt: true, message: error.message }
    }
    throw error
  }
}

/** 供 IPC 删除一条可信记录（用户「忘记此主机」） */
export function deleteTrustedSshHost(host: string, port?: number): boolean {
  return getSshTrustStore().delete(host, port)
}
