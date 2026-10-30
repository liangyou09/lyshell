/**
 * SSH 主机公钥身份（主机密钥指纹）的纯函数层。
 *
 * 职责：endpoint 规范化、SHA256 指纹、可信记录数据结构与校验、固定错误码、
 * 以及 ssh2 `hostVerifier` 适配。终端连接器、主进程 SFTP 客户端、上传/下载 Worker
 * 与单测共用同一套语义。
 *
 * 本模块刻意不 import electron / fs / worker_threads：文件 Worker 与纯单测可以在
 * 不加载 Electron 的前提下使用它。
 */
import { createHash } from 'crypto'

/** 可信记录文件与单条记录的 schema 版本（升级时必须显式迁移，不猜旧格式） */
export const SSH_HOST_KEY_SCHEMA_VERSION = 1

export const SSH_DEFAULT_PORT = 22

/** 人工确认指纹的最长等待时间；连接器据此放宽 readyTimeout */
export const SSH_HOST_KEY_CONFIRM_TIMEOUT_MS = 120_000

/** OpenSSH 风格的 SHA256 指纹：SHA256: + 43 字符 base64（去掉尾部 =） */
export const SSH_FINGERPRINT_PATTERN = /^SHA256:[A-Za-z0-9+/]{43}$/

export type SshHostKeyErrorCode =
  /** 首次连接且没有可信记录，也没有人工确认 */
  | 'SSH_HOST_KEY_UNKNOWN'
  /** 与可信记录不一致 */
  | 'SSH_HOST_KEY_CHANGED'
  /** 人工确认被拒绝 / 超时 / 确认期间连接已关闭 */
  | 'SSH_HOST_KEY_REJECTED'
  /** 缺少可信指纹（Worker 未注入、配置目录不可用等），fail closed */
  | 'SSH_HOST_KEY_UNAVAILABLE'
  /** 保存可信记录失败：本次连接不得被视为「已永久信任」 */
  | 'SSH_HOST_KEY_SAVE_FAILED'
  /** 可信记录文件损坏或记录不合法：拒绝继续，绝不自动信任 */
  | 'SSH_HOST_KEY_STORE_CORRUPT'
  /** 收到的主机公钥或 endpoint 参数不合法 */
  | 'SSH_HOST_KEY_INVALID'

export interface SshHostKeyErrorDetails {
  host?: string
  port?: number
  endpoint?: string
  fingerprint?: string
  previousFingerprint?: string
}

/**
 * 主机密钥相关的固定错误。
 * message 只包含 host/port/指纹这类公开信息，绝不写入密码、私钥、口令或 token。
 */
export class SshHostKeyError extends Error {
  readonly code: SshHostKeyErrorCode
  readonly host?: string
  readonly port?: number
  readonly endpoint?: string
  readonly fingerprint?: string
  readonly previousFingerprint?: string

  constructor(code: SshHostKeyErrorCode, message: string, details: SshHostKeyErrorDetails = {}) {
    super(message)
    this.name = 'SshHostKeyError'
    this.code = code
    this.host = details.host
    this.port = details.port
    this.endpoint = details.endpoint
    this.fingerprint = details.fingerprint
    this.previousFingerprint = details.previousFingerprint
  }
}

/** 跨 bundle / 重复加载时也成立的类型判断（instanceof 可能失效） */
export function isSshHostKeyError(error: unknown): error is SshHostKeyError {
  if (error instanceof SshHostKeyError) return true
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { name?: unknown; code?: unknown }
  return candidate.name === 'SshHostKeyError' &&
    typeof candidate.code === 'string' &&
    candidate.code.startsWith('SSH_HOST_KEY_')
}

export interface SshHostKeyInfo {
  /** 主机公钥算法名，取自 SSH 公钥 blob 的首个字符串（如 ssh-ed25519 / ssh-rsa） */
  algorithm: string
  /** OpenSSH 风格 SHA256 指纹 */
  fingerprint: string
}

/** 一条可信主机记录。只放身份信息，不放任何凭据。 */
export interface SshTrustRecord {
  schemaVersion: number
  /** 规范化后的 `host:port`（IPv6 带方括号） */
  endpoint: string
  host: string
  port: number
  algorithm: string
  fingerprint: string
  trustedAt: string
  updatedAt: string
}

export interface SshTrustFile {
  schemaVersion: number
  records: SshTrustRecord[]
}

/** 传给人工确认回调的挑战（纯数据，可跨 IPC 结构化克隆） */
export interface SshHostKeyChallenge extends SshHostKeyInfo {
  host: string
  port: number
  endpoint: string
  /** 是否与既有可信记录不同（此时 previousFingerprint 必有值） */
  changed: boolean
  previousFingerprint?: string
}

/** 文件 Worker 内部使用的固定匹配目标（由主进程在 dispatch 前读取可信记录注入） */
export interface TransferHostKeyExpectation {
  endpoint: string
  fingerprint: string
}

const invalid = (message: string, details: SshHostKeyErrorDetails = {}): SshHostKeyError =>
  new SshHostKeyError('SSH_HOST_KEY_INVALID', message, details)

/**
 * 主机名规范化：去空白、去 IPv6 方括号、统一小写。
 * 不做 DNS 解析——信任必须绑定用户实际连接的那个地址。
 */
export function normalizeSshHost(host: string): string {
  const trimmed = typeof host === 'string' ? host.trim() : ''
  if (!trimmed) throw invalid('主机地址为空')
  let value = trimmed
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1)
  return value.toLowerCase()
}

export function normalizeSshPort(port?: number | null): number {
  if (port === undefined || port === null) return SSH_DEFAULT_PORT
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw invalid(`端口不合法：${String(port)}`)
  }
  return port
}

/** 规范化 endpoint：`host:port`，IPv6 用 `[host]:port` */
export function normalizeSshEndpoint(host: string, port?: number | null): string {
  const normalizedHost = normalizeSshHost(host)
  const normalizedPort = normalizeSshPort(port)
  return normalizedHost.includes(':') ? `[${normalizedHost}]:${normalizedPort}` : `${normalizedHost}:${normalizedPort}`
}

/** 读取 SSH wire format 的前缀字符串（uint32 长度 + 字节） */
function readSshString(buffer: Buffer, offset: number): string | null {
  if (offset + 4 > buffer.length) return null
  const length = buffer.readUInt32BE(offset)
  if (length <= 0 || length > 64 || offset + 4 + length > buffer.length) return null
  const text = buffer.subarray(offset + 4, offset + 4 + length).toString('latin1')
  return /^[A-Za-z0-9@._+-]+$/.test(text) ? text : null
}

/**
 * 解析 ssh2 `hostVerifier` 收到的原始主机公钥（SSH wire format blob）。
 *
 * 注意：没有配置 `hostHash` 时 ssh2 传的是**原始公钥字节**；指纹必须由这里算一次，
 * 不能拿算法名或已 hash 的十六进制再 hash 一遍。
 */
export function describeSshHostKey(rawKey: Buffer): SshHostKeyInfo {
  if (!Buffer.isBuffer(rawKey) || rawKey.length < 8) throw invalid('主机公钥内容为空或格式不合法')
  const algorithm = readSshString(rawKey, 0)
  if (!algorithm) throw invalid('无法从主机公钥中解析算法名')
  const digest = createHash('sha256').update(rawKey).digest('base64').replace(/=+$/, '')
  return { algorithm, fingerprint: `SHA256:${digest}` }
}

export function computeSshHostKeyFingerprint(rawKey: Buffer): string {
  return describeSshHostKey(rawKey).fingerprint
}

/**
 * 固定匹配：Worker / 无人工确认的通道用这个断言。
 * 缺少期望指纹一律 fail closed（不会退化成「首次即信任」）。
 */
export function assertHostKeyMatches(
  rawKey: Buffer,
  host: string,
  port: number | null | undefined,
  expectedFingerprint: string | null | undefined
): SshHostKeyInfo {
  const endpoint = normalizeSshEndpoint(host, port)
  if (!expectedFingerprint || !SSH_FINGERPRINT_PATTERN.test(expectedFingerprint)) {
    throw new SshHostKeyError('SSH_HOST_KEY_UNAVAILABLE', `缺少可信主机密钥指纹，已拒绝连接（${endpoint}）`, {
      host: normalizeSshHost(host),
      port: normalizeSshPort(port),
      endpoint
    })
  }
  const actual = describeSshHostKey(rawKey)
  if (actual.fingerprint !== expectedFingerprint) {
    throw new SshHostKeyError(
      'SSH_HOST_KEY_CHANGED',
      `SSH 主机密钥与可信记录不一致（${endpoint}）：可信 ${expectedFingerprint}，实际 ${actual.fingerprint}；已拒绝连接`,
      {
        host: normalizeSshHost(host),
        port: normalizeSshPort(port),
        endpoint,
        fingerprint: actual.fingerprint,
        previousFingerprint: expectedFingerprint
      }
    )
  }
  return actual
}

/**
 * 校验一条可信记录（用于加载与写入前的自检）。
 * 任何不合法都视为「记录损坏」——宁可拒绝连接，也不静默丢弃后重新信任。
 */
export function validateSshTrustRecord(value: unknown): SshTrustRecord {
  const fail = (reason: string): never => {
    throw new SshHostKeyError('SSH_HOST_KEY_STORE_CORRUPT', `SSH 主机密钥信任记录不合法：${reason}`)
  }
  if (typeof value !== 'object' || value === null) return fail('记录不是对象')
  const raw = value as Record<string, unknown>
  if (raw.schemaVersion !== SSH_HOST_KEY_SCHEMA_VERSION) return fail(`schemaVersion 不支持：${String(raw.schemaVersion)}`)
  if (typeof raw.host !== 'string' || !raw.host.trim()) return fail('host 缺失')
  if (typeof raw.port !== 'number' || !Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535) return fail('port 不合法')
  if (typeof raw.fingerprint !== 'string' || !SSH_FINGERPRINT_PATTERN.test(raw.fingerprint)) return fail('fingerprint 不合法')
  if (typeof raw.algorithm !== 'string' || !raw.algorithm.trim()) return fail('algorithm 缺失')
  if (typeof raw.trustedAt !== 'string' || !raw.trustedAt) return fail('trustedAt 缺失')
  if (typeof raw.updatedAt !== 'string' || !raw.updatedAt) return fail('updatedAt 缺失')

  const host = normalizeSshHost(raw.host)
  const port = normalizeSshPort(raw.port)
  const endpoint = normalizeSshEndpoint(host, port)
  if (raw.endpoint !== endpoint) return fail(`endpoint 与 host/port 不一致：${String(raw.endpoint)}`)

  return {
    schemaVersion: SSH_HOST_KEY_SCHEMA_VERSION,
    endpoint,
    host,
    port,
    algorithm: raw.algorithm,
    fingerprint: raw.fingerprint,
    trustedAt: raw.trustedAt,
    updatedAt: raw.updatedAt
  }
}

/** 校验整个可信记录文件；重复 endpoint 同样按损坏处理 */
export function validateSshTrustFile(value: unknown): SshTrustFile {
  if (typeof value !== 'object' || value === null) {
    throw new SshHostKeyError('SSH_HOST_KEY_STORE_CORRUPT', 'SSH 主机密钥信任记录不是对象')
  }
  const raw = value as Record<string, unknown>
  if (raw.schemaVersion !== SSH_HOST_KEY_SCHEMA_VERSION) {
    throw new SshHostKeyError('SSH_HOST_KEY_STORE_CORRUPT', `SSH 主机密钥信任记录 schemaVersion 不支持：${String(raw.schemaVersion)}`)
  }
  if (!Array.isArray(raw.records)) {
    throw new SshHostKeyError('SSH_HOST_KEY_STORE_CORRUPT', 'SSH 主机密钥信任记录缺少 records 数组')
  }
  if (raw.records.length > 4096) throw new SshHostKeyError('SSH_HOST_KEY_STORE_CORRUPT', 'SSH trust record limit exceeded')
  const seen = new Set<string>()
  const records = raw.records.map((item) => {
    const record = validateSshTrustRecord(item)
    if (seen.has(record.endpoint)) {
      throw new SshHostKeyError('SSH_HOST_KEY_STORE_CORRUPT', `SSH 主机密钥信任记录 endpoint 重复：${record.endpoint}`)
    }
    seen.add(record.endpoint)
    return record
  })
  return { schemaVersion: SSH_HOST_KEY_SCHEMA_VERSION, records }
}

export type Ssh2VerifyCallback = (permitted: boolean) => void
/** 与 ssh2 ConnectConfig.hostVerifier 相同的形状（本地声明，避免依赖其类型定义） */
export type Ssh2HostVerifier = (key: Buffer, verify: Ssh2VerifyCallback) => void

export interface Ssh2HostVerifierOptions {
  host: string
  port: number
  /** 断言实际收到的公钥；reject 即拒绝握手（SshHostKeyError 会被原样交给调用方） */
  decide: (key: Buffer) => Promise<void>
  /** 连接/实例是否仍然有效：关闭或取消后不得再推进握手 */
  isActive?: () => boolean
  /** 拒绝原因回传（用于把 ssh2 的「Host denied」替换成明确错误） */
  onReject?: (error: unknown) => void
}

/**
 * 把异步校验包装成 ssh2 的 hostVerifier。
 *
 * 关键语义（见 ssh2 lib/client.js 与 lib/protocol/kex.js）：
 * - hostVerifier 必须**同步返回 undefined**，ssh2 才会暂停 kex 状态机等异步结论；
 *   返回 Promise / 任何非 undefined 值都会被当作布尔结论直接放行。
 * - `verify(true)` 之后握手才继续；`verify(false)` 会让 ssh2 以
 *   「Host denied (verification failed)」结束握手。
 * - 连接已关闭/取消时不再调用 verify（此时推进已销毁的协议状态机没有意义）。
 */
export function createSsh2HostVerifier(options: Ssh2HostVerifierOptions): Ssh2HostVerifier {
  return (key, verify) => {
    let settled = false
    const settle = (permitted: boolean): void => {
      if (settled) return
      settled = true
      if (options.isActive && !options.isActive()) return
      verify(permitted)
    }

    void Promise.resolve()
      .then(() => options.decide(key))
      .then(
        () => settle(true),
        (error: unknown) => {
          try {
            options.onReject?.(error)
          } catch {
            // 记录失败不能反过来放行握手
          }
          settle(false)
        }
      )

    return undefined
  }
}
