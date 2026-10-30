import { isSecretEnvKey, isSecretPlaceholder, SECRET_PLACEHOLDER } from '@shared/harness'
import type {
  LocalConfig,
  SessionConfig,
  SessionPublicConfig,
  SessionSecretState,
  SessionSshSecretState,
  SSHConfig
} from '@shared/types'

/**
 * 会话秘密边界的纯 helper。
 *
 * 刻意不 import electron / secret-store / repository：本模块只做
 * 「配置 → 安全 DTO」与「UI 占位符 → 运行期配置」的纯变换，任何进程/单测都可直接用。
 * vault 读写、safeStorage 加解密、原子落盘都在 repository.ts。
 */

export const SENSITIVE_SSH_FIELDS = ['password', 'privateKey', 'passphrase'] as const
export type SensitiveSshField = (typeof SENSITIVE_SSH_FIELDS)[number]

/** 与 repository.ts 的 SAFE_STORAGE_PREFIX 保持一致（只读判定，不解密）。 */
const SAFE_STORAGE_PREFIX = 'safe:v1:'
/** 与 secret-store.ts 的 SECRET_REF_PREFIX/isSecretRef 保持一致（只做形状校验）。 */
const SECRET_REF_PATTERN = /^sec_[0-9a-f]{32}$/

export type SessionSecretErrorCode =
  /** 伪造占位符 / 目标记录没有可沿用的秘密 / 跨记录复制引用 */
  | 'placeholder_without_secret'
  /** SSH host/port/username 变了却仍沿用旧秘密 */
  | 'target_changed'
  /** 仍残留占位符：不能连接、不能导出 */
  | 'secret_unavailable'

export class SessionSecretError extends Error {
  readonly code: SessionSecretErrorCode

  constructor(code: SessionSecretErrorCode, message: string) {
    super(message)
    this.name = 'SessionSecretError'
    this.code = code
  }
}

const isCiphertext = (value: unknown): boolean =>
  typeof value === 'string' && value.startsWith(SAFE_STORAGE_PREFIX)

const isSecretRef = (value: unknown): value is string =>
  typeof value === 'string' && SECRET_REF_PATTERN.test(value)

const normalizeRefs = (raw: unknown): Record<string, string> => {
  const refs: Record<string, string> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return refs
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || !isSecretRef(value)) continue
    refs[key] = value
  }
  return refs
}

const normalizeKeys = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) return []
  const keys: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const key = entry.trim()
    if (key && !keys.includes(key)) keys.push(key)
  }
  return keys
}

const isSecretRecordKey = (
  key: string,
  refs: Record<string, string>,
  explicitKeys: string[]
): boolean => Boolean(refs[key]) || explicitKeys.includes(key) || isSecretEnvKey(key)

const sameRefs = (a: Record<string, string>, b: Record<string, string>): boolean => {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every(key => a[key] === b[key])
}

/**
 * 与 repository.cloneSession 同口径的深拷贝：剥离运行期字段，复制数组/记录/主题。
 * helper 不依赖仓储，这里保留一份最小的形状拷贝。
 */
const cloneSessionShape = (session: SessionConfig): SessionConfig => ({
  ...session,
  ssh: session.ssh
    ? { ...session.ssh, resumeSessionName: undefined, resumeDirectory: undefined }
    : undefined,
  telnet: session.telnet ? { ...session.telnet } : undefined,
  serial: session.serial ? { ...session.serial } : undefined,
  local: session.local
    ? {
        ...session.local,
        terminalHostId: undefined,
        env: session.local.env ? { ...session.local.env } : undefined,
        envSecretRefs: session.local.envSecretRefs
          ? { ...session.local.envSecretRefs }
          : undefined,
        secretEnvKeys: session.local.secretEnvKeys ? [...session.local.secretEnvKeys] : undefined,
        shellArgs: session.local.shellArgs ? [...session.local.shellArgs] : undefined
      }
    : undefined,
  terminal: session.terminal
    ? { ...session.terminal, theme: { ...session.terminal.theme } }
    : session.terminal,
  tags: [...(session.tags || [])],
  startupCommands: session.startupCommands ? [...session.startupCommands] : undefined
})

export interface PublicSessionOptions {
  /** 盘上仍有密文、本次无法解密的 SSH 字段（repository.protectedSecrets 提供）。 */
  lockedSshFields?: Iterable<SensitiveSshField>
}

/**
 * 安全 DTO：SSH 三个秘密字段与 local.env 的秘密值都替换为 SECRET_PLACEHOLDER，
 * 并通过 sshSecrets 暴露存在性/锁定状态。真实值永不离开 main。
 */
export function publicSessionConfig(
  config: SessionConfig,
  options: PublicSessionOptions = {}
): SessionPublicConfig {
  const cloned = cloneSessionShape(config)
  const locked = new Set<SensitiveSshField>(options.lockedSshFields ?? [])

  let sshSecrets: SessionSshSecretState | undefined
  if (cloned.ssh) {
    const ssh: SSHConfig = { ...cloned.ssh }
    const state: SessionSshSecretState = {}
    for (const field of SENSITIVE_SSH_FIELDS) {
      const value = ssh[field]
      if (typeof value === 'string' && value.length > 0) {
        const entry: SessionSecretState = { present: true }
        if (locked.has(field) || isCiphertext(value)) entry.locked = true
        state[field] = entry
        ssh[field] = SECRET_PLACEHOLDER
      } else if (locked.has(field)) {
        // 密文仍在但本次连字段都没解出来：至少把「存在但锁定」告诉 UI
        state[field] = { present: true, locked: true }
        delete ssh[field]
      } else {
        delete ssh[field]
      }
    }
    cloned.ssh = ssh
    if (Object.keys(state).length > 0) sshSecrets = state
  }

  const local: LocalConfig | undefined = cloned.local
  if (local && (local.env || local.envSecretRefs)) {
    const refs = normalizeRefs(local.envSecretRefs)
    const explicitKeys = normalizeKeys(local.secretEnvKeys)
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(local.env ?? {})) {
      const shouldMask =
        typeof value === 'string' &&
        value.length > 0 &&
        !isSecretPlaceholder(value) &&
        isSecretRecordKey(key, refs, explicitKeys)
      env[key] = shouldMask ? SECRET_PLACEHOLDER : value
    }
    // 本次解析失败的引用在运行期 env 里是缺键的：DTO 仍要告诉 UI「这里有个秘密」，
    // 否则编辑器会把该行当成已删除，回写时反而把引用清掉。
    for (const key of Object.keys(refs)) {
      if (!(key in env)) env[key] = SECRET_PLACEHOLDER
    }
    local.env = env
  }

  const dto: SessionPublicConfig = { ...cloned }
  if (sshSecrets) dto.sshSecrets = sshSecrets
  return dto
}

export interface HydrateSessionSecretContext {
  /** 本次运行无法解密的 SSH 字段：不返回明文，交给 repository 用 protectedSecrets 写回密文。 */
  lockedSshFields?: Iterable<SensitiveSshField>
}

export interface HydratedSessionSecrets {
  config: SessionConfig
  /** 仍以密文保留、本次无法解密的 SSH 字段：连接/导出前必须让用户重新输入。 */
  lockedSshFields: SensitiveSshField[]
}

/** 同一 SSH 目标（host/port/username）判定；用于拒绝「改目标却沿用占位符」。 */
export function hasSameSshTarget(a?: SSHConfig, b?: SSHConfig): boolean {
  if (!a || !b) return false
  if (a.host !== b.host || a.username !== b.username) return false
  const portA = typeof a.port === 'number' ? a.port : Number(a.port)
  const portB = typeof b.port === 'number' ? b.port : Number(b.port)
  return Number.isFinite(portA) && Number.isFinite(portB) && portA === portB
}

/**
 * 把 UI/外部输入里的占位符还原成同一条记录自己的运行期秘密。
 *
 * - 占位符只允许出现在「同 id 的上一条记录」上；新记录/别人的占位符 → placeholder_without_secret。
 * - SSH 目标必须与上一条一致，否则 → target_changed。
 * - locked 字段不返回明文，只在 lockedSshFields 里报告（写盘时由 protectedSecrets 写回原密文）。
 * - local.env 占位符用上一条的运行期值回填；上一条有引用但本次解析失败时保留占位符，
 *   交给 planSecretEnv 保留引用。上一条既无值又无引用 → placeholder_without_secret。
 * - 入参 local.envSecretRefs 只能与本记录原有引用完全一致（否则拒绝）；返回值中已清空，
 *   由仓储按本记录重新规划引用。
 */
export function hydrateSessionSecrets(
  incoming: SessionConfig,
  previous: SessionConfig | null | undefined,
  context: HydrateSessionSecretContext = {}
): HydratedSessionSecrets {
  const config = cloneSessionShape(incoming)
  delete (config as { sshSecrets?: unknown }).sshSecrets

  const locked = new Set<SensitiveSshField>(context.lockedSshFields ?? [])
  const lockedFields: SensitiveSshField[] = []
  const previousForRecord = previous && previous.id === config.id ? previous : null

  // local：先校验引用归属，再逐键回填占位符
  if (config.local) {
    const rawRefs = config.local.envSecretRefs
    const incomingRefs = normalizeRefs(rawRefs)
    const previousRefs = normalizeRefs(previousForRecord?.local?.envSecretRefs)
    if (rawRefs && !sameRefs(incomingRefs, previousRefs)) {
      throw new SessionSecretError(
        'placeholder_without_secret',
        'Secret references cannot be copied between sessions; re-enter the value'
      )
    }

    const local = config.local
    if (local.env) {
      const env: Record<string, string> = { ...local.env }
      for (const [key, value] of Object.entries(env)) {
        if (!isSecretPlaceholder(value)) continue
        const previousValue = previousForRecord?.local?.env?.[key]
        if (typeof previousValue === 'string' && previousValue.length > 0) {
          env[key] = previousValue
        } else if (previousRefs[key]) {
          // 引用仍在但本次解析失败：保留占位符，planSecretEnv 会保留原引用
        } else {
          throw new SessionSecretError(
            'placeholder_without_secret',
            `Secret placeholder for local.env.${key} has no saved value to preserve`
          )
        }
      }
      local.env = env
    }
    // 外部引用参与写盘规划是不可信的：一律丢弃，仓储只认上一条记录自己的引用
    delete local.envSecretRefs
  }

  // SSH：占位符必须继承同记录、同目标的旧秘密
  if (config.ssh) {
    const ssh = { ...config.ssh }
    if (SENSITIVE_SSH_FIELDS.some(field => isCiphertext(ssh[field]))) {
      throw new SessionSecretError('secret_unavailable', 'Stored SSH ciphertext cannot be supplied as a credential')
    }
    // 空串 = 明确删除（与 SessionDialog 的「空输入→undefined」语义一致），
    // 绝不能把空串当密码加密写盘
    for (const field of SENSITIVE_SSH_FIELDS) {
      if (ssh[field] === '') delete ssh[field]
    }
    const placeholderFields = SENSITIVE_SSH_FIELDS.filter(field =>
      isSecretPlaceholder(ssh[field])
    )
    if (placeholderFields.length > 0) {
      if (!previousForRecord?.ssh) {
        throw new SessionSecretError(
          'placeholder_without_secret',
          'Secret placeholder requires the original saved SSH credentials; re-enter them'
        )
      }
      if (!hasSameSshTarget(ssh, previousForRecord.ssh)) {
        throw new SessionSecretError(
          'target_changed',
          'SSH target changed; re-enter the password, private key or passphrase for the new host'
        )
      }
      for (const field of placeholderFields) {
        if (locked.has(field)) {
          delete ssh[field]
          lockedFields.push(field)
          continue
        }
        const previousValue = previousForRecord.ssh[field]
        if (
          typeof previousValue !== 'string' ||
          previousValue.length === 0 ||
          isSecretPlaceholder(previousValue)
        ) {
          throw new SessionSecretError(
            'placeholder_without_secret',
            `Secret placeholder for ssh.${field} has no saved value to preserve`
          )
        }
        ssh[field] = previousValue
      }
    }

    // 未解密密文原样传给仓储（幂等），同时报告为 locked
    for (const field of SENSITIVE_SSH_FIELDS) {
      if (isCiphertext(ssh[field]) && locked.has(field)) {
        lockedFields.push(field)
      }
    }
    config.ssh = ssh
  }

  return { config, lockedSshFields: Array.from(new Set(lockedFields)) }
}

/** 连接/加密导出前最后一道：任何残留占位符都拒绝，避免把占位符当密码发出去。 */
export function assertNoSecretPlaceholders(config: SessionConfig): void {
  const found: string[] = []
  if (config.ssh) {
    for (const field of SENSITIVE_SSH_FIELDS) {
      if (isSecretPlaceholder(config.ssh[field]) || isCiphertext(config.ssh[field])) found.push(`ssh.${field}`)
    }
  }
  if (config.local?.env) {
    for (const [key, value] of Object.entries(config.local.env)) {
      if (isSecretPlaceholder(value)) found.push(`local.env.${key}`)
    }
  }
  if (found.length > 0) {
    throw new SessionSecretError(
      'secret_unavailable',
      `Unresolved secret placeholders: ${found.join(', ')}`
    )
  }
}
