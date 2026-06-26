import { app, safeStorage } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs'
import log from 'electron-log'
import { v4 as uuidv4 } from 'uuid'
import type { SessionConfig } from '@shared/types'

const SAFE_STORAGE_PREFIX = 'safe:v1:'
const SENSITIVE_SSH_FIELDS = ['password', 'privateKey', 'passphrase'] as const

const cloneSession = (session: SessionConfig): SessionConfig => ({
  ...session,
  ssh: session.ssh ? { ...session.ssh } : undefined,
  telnet: session.telnet ? { ...session.telnet } : undefined,
  serial: session.serial ? { ...session.serial } : undefined,
  local: session.local ? { ...session.local, env: session.local.env ? { ...session.local.env } : undefined } : undefined,
  terminal: session.terminal ? { ...session.terminal, theme: { ...session.terminal.theme } } : session.terminal,
  tags: [...(session.tags || [])],
  startupCommands: session.startupCommands ? [...session.startupCommands] : undefined
})

const isEncryptedSecret = (value: string): boolean => value.startsWith(SAFE_STORAGE_PREFIX)

const encryptSecretForDisk = (value: string | undefined): string | undefined => {
  if (!value || isEncryptedSecret(value)) return value
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统安全存储不可用，无法安全保存 SSH 凭据。请启用系统凭据存储后重试，或移除密码/私钥/口令后保存。')
  }
  return `${SAFE_STORAGE_PREFIX}${safeStorage.encryptString(value).toString('base64')}`
}

const decryptSecretFromDisk = (value: string | undefined): string | undefined => {
  if (!value || !isEncryptedSecret(value)) return value
  if (!safeStorage.isEncryptionAvailable()) {
    log.warn('safeStorage is unavailable, cannot decrypt SSH secret from sessions.json')
    return undefined
  }
  const encrypted = Buffer.from(value.slice(SAFE_STORAGE_PREFIX.length), 'base64')
  return safeStorage.decryptString(encrypted)
}

const hasPlaintextSshSecret = (session: SessionConfig): boolean => {
  if (!session.ssh) return false
  return SENSITIVE_SSH_FIELDS.some(field => {
    const value = session.ssh?.[field]
    return !!value && !isEncryptedSecret(value)
  })
}

const decryptSessionFromDisk = (session: SessionConfig): SessionConfig => {
  const decrypted = cloneSession(session)
  if (decrypted.ssh) {
    for (const field of SENSITIVE_SSH_FIELDS) {
      decrypted.ssh[field] = decryptSecretFromDisk(decrypted.ssh[field])
    }
  }
  return decrypted
}

const encryptSessionForDisk = (session: SessionConfig): SessionConfig => {
  const encrypted = cloneSession(session)
  if (encrypted.ssh) {
    for (const field of SENSITIVE_SSH_FIELDS) {
      encrypted.ssh[field] = encryptSecretForDisk(encrypted.ssh[field])
    }
  }
  return encrypted
}

/**
 * 配置存储路径 - 延迟获取
 */
let configDirCache: string | null = null
export const getConfigDir = (): string => {
  if (!configDirCache) {
    const userDataPath = app.getPath('userData')
    const configDir = join(userDataPath, 'config')

    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true })
    }

    configDirCache = configDir
  }
  return configDirCache
}

/**
 * 会话配置存储
 * 使用JSON文件存储（SQLite需要原生模块）
 * 延迟初始化，避免在 app.ready 前调用 app.getPath
 */
export class SessionRepository {
  private filePath: string | null = null
  private sessions: Map<string, SessionConfig> = new Map()
  private loaded: boolean = false

  /**
   * 确保已初始化
   */
  private ensureInitialized(): void {
    if (!this.filePath) {
      this.filePath = join(getConfigDir(), 'sessions.json')
      this.load()
    }
  }

  /**
   * 加载所有会话
   */
  private load(): void {
    if (!this.filePath || this.loaded) return

    if (!existsSync(this.filePath)) {
      log.info('No sessions file found, starting fresh')
      this.loaded = true
      return
    }

    try {
      const content = readFileSync(this.filePath, 'utf-8')
      const data = JSON.parse(content) as SessionConfig[]

      let shouldMigrateSecrets = false
      for (const storedSession of data) {
        if (hasPlaintextSshSecret(storedSession)) {
          shouldMigrateSecrets = true
        }

        const session = decryptSessionFromDisk(storedSession)
        // 转换日期
        session.createdAt = new Date(session.createdAt)
        session.updatedAt = new Date(session.updatedAt)
        this.sessions.set(session.id, session)
      }

      log.info(`Loaded ${this.sessions.size} sessions from storage`)

      // 自动去重
      const dupResult = this.deduplicate(false)
      if (dupResult.removed > 0) {
        log.info(`Auto-deduplicated ${dupResult.removed} sessions on load`)
      }

      this.loaded = true
      if (shouldMigrateSecrets || dupResult.removed > 0) {
        this.save()
      }

    } catch (error) {
      log.error('Failed to load sessions:', error)
      this.loaded = true
    }
  }

  /**
   * 保存所有会话到文件
   */
  private save(): void {
    if (!this.filePath) return

    try {
      const data = Array.from(this.sessions.values()).map(encryptSessionForDisk)
      writeFileSync(this.filePath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 })
      if (process.platform !== 'win32') {
        chmodSync(this.filePath, 0o600)
      }
      log.info(`Saved ${data.length} sessions to storage`)
    } catch (error) {
      log.error('Failed to save sessions:', error)
      throw error
    }
  }

  /**
   * 获取单个会话
   */
  get(id: string): SessionConfig | null {
    this.ensureInitialized()
    return this.sessions.get(id) || null
  }

  /**
   * 获取所有会话
   */
  getAll(): SessionConfig[] {
    this.ensureInitialized()
    return Array.from(this.sessions.values())
  }

  /**
   * 检查会话配置是否相同（忽略 ID 和时间戳）
   */
  private isSameConfig(a: SessionConfig, b: SessionConfig): boolean {
    // 比较基本信息
    if (a.name !== b.name || a.type !== b.type) return false

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
    } else if (a.local || b.local) {
      return false
    }

    return true
  }

  /**
   * 保存会话（新建或更新）
   * 如果没有 ID，会检查是否已存在相同配置的会话
   */
  saveSession(session: SessionConfig): SessionConfig {
    this.ensureInitialized()
    const now = new Date()

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

    session.updatedAt = now
    this.sessions.set(session.id, session)
    this.save()

    log.info(`Session saved: ${session.id} (${session.name})`)
    return session
  }

  /**
   * 删除会话
   */
  delete(id: string): boolean {
    this.ensureInitialized()
    if (!this.sessions.has(id)) return false

    this.sessions.delete(id)
    this.save()

    log.info(`Session deleted: ${id}`)
    return true
  }

  /**
   * 查找会话
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

      if (match) results.push(session)
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
  deduplicate(saveToDisk: boolean = true): { removed: number, kept: SessionConfig[] } {
    this.ensureInitialized()

    const uniqueSessions = new Map<string, SessionConfig>()
    const duplicates: SessionConfig[] = []
    let removed = 0

    for (const session of this.sessions.values()) {
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

    // 更新存储
    this.sessions.clear()
    for (const session of uniqueSessions.values()) {
      this.sessions.set(session.id, session)
    }

    // 只有需要时才保存到磁盘
    if (saveToDisk) {
      this.save()
    }

    log.info(`Deduplicated sessions: removed ${removed} duplicates, kept ${uniqueSessions.size} unique sessions`)
    return { removed, kept: Array.from(uniqueSessions.values()) }
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
      parts.push(session.local.shell || 'default', session.local.cwd || 'default')
    }

    return parts.join('|')
  }
}

// 用户偏好设置存储
export class PreferencesRepository {
  private filePath: string | null = null
  private preferences: Record<string, any> = {}
  private loaded: boolean = false

  private ensureInitialized(): void {
    if (!this.filePath) {
      this.filePath = join(getConfigDir(), 'preferences.json')
      this.load()
    }
  }

  private load(): void {
    if (!this.filePath || this.loaded) return

    if (!existsSync(this.filePath)) {
      this.loaded = true
      return
    }

    try {
      const content = readFileSync(this.filePath, 'utf-8')
      this.preferences = JSON.parse(content)
      log.info('Loaded preferences from storage')
      this.loaded = true
    } catch (error) {
      log.error('Failed to load preferences:', error)
      this.loaded = true
    }
  }

  private save(): void {
    if (!this.filePath) return

    try {
      writeFileSync(this.filePath, JSON.stringify(this.preferences, null, 2), 'utf-8')
    } catch (error) {
      log.error('Failed to save preferences:', error)
    }
  }

  get(key: string): any {
    this.ensureInitialized()
    return this.preferences[key]
  }

  set(key: string, value: any): void {
    this.ensureInitialized()
    this.preferences[key] = value
    this.save()
  }

  getAll(): Record<string, any> {
    this.ensureInitialized()
    return { ...this.preferences }
  }

  reset(): void {
    this.ensureInitialized()
    this.preferences = {}
    this.save()
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

export class QuickCommandsRepository {
  private filePath: string | null = null
  private commands: QuickCommand[] = []
  private groups: QuickCommandGroup[] = []
  private loaded: boolean = false

  private ensureInitialized(): void {
    if (!this.filePath) {
      this.filePath = join(getConfigDir(), 'quickCommands.json')
      this.load()
    }
  }

  private load(): void {
    if (!this.filePath || this.loaded) return

    if (!existsSync(this.filePath)) {
      log.info('No quickCommands file found, starting fresh')
      this.loaded = true
      return
    }

    try {
      const content = readFileSync(this.filePath, 'utf-8')
      const data = JSON.parse(content) as QuickCommandsData | QuickCommand[]

      // 支持旧格式（只有命令数组）和新格式（包含命令和分组）
      if (Array.isArray(data)) {
        this.commands = data.map(cmd => ({
          ...cmd,
          groupId: cmd.groupId || undefined  // 空字符串转为 undefined
        }))
        this.groups = []
      } else {
        this.commands = (data.commands || []).map(cmd => ({
          ...cmd,
          groupId: cmd.groupId || undefined  // 空字符串转为 undefined
        }))
        this.groups = data.groups || []
      }

      log.info(`Loaded ${this.commands.length} quick commands and ${this.groups.length} groups from storage`)
      this.loaded = true
    } catch (error) {
      log.error('Failed to load quick commands:', error)
      this.commands = []
      this.groups = []
      this.loaded = true
    }
  }

  private save(): void {
    if (!this.filePath) return

    try {
      const data: QuickCommandsData = {
        commands: this.commands,
        groups: this.groups
      }
      writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8')
      log.info(`Saved ${this.commands.length} quick commands and ${this.groups.length} groups to storage`)
    } catch (error) {
      log.error('Failed to save quick commands:', error)
    }
  }

  // ========== 命令操作 ==========

  getAll(): QuickCommand[] {
    this.ensureInitialized()
    return [...this.commands]
  }

  saveAll(commands: QuickCommand[]): void {
    this.ensureInitialized()
    this.commands = commands
    this.save()
  }

  add(command: QuickCommand): QuickCommand {
    this.ensureInitialized()
    if (!command.id) {
      command.id = uuidv4()
    }
    this.commands.push(command)
    this.save()
    return command
  }

  update(command: QuickCommand): boolean {
    this.ensureInitialized()
    const index = this.commands.findIndex(c => c.id === command.id)
    if (index === -1) return false
    this.commands[index] = command
    this.save()
    return true
  }

  delete(id: string): boolean {
    this.ensureInitialized()
    const index = this.commands.findIndex(c => c.id === id)
    if (index === -1) return false
    this.commands.splice(index, 1)
    this.save()
    return true
  }

  // ========== 分组操作 ==========

  getAllGroups(): QuickCommandGroup[] {
    this.ensureInitialized()
    return [...this.groups].sort((a, b) => a.order - b.order)
  }

  addGroup(group: QuickCommandGroup): QuickCommandGroup {
    this.ensureInitialized()
    if (!group.id) {
      group.id = uuidv4()
    }
    if (group.order === undefined) {
      group.order = this.groups.length
    }
    this.groups.push(group)
    this.save()
    return group
  }

  updateGroup(group: QuickCommandGroup): boolean {
    this.ensureInitialized()
    const index = this.groups.findIndex(g => g.id === group.id)
    if (index === -1) return false
    this.groups[index] = group
    this.save()
    return true
  }

  deleteGroup(id: string): boolean {
    this.ensureInitialized()
    const index = this.groups.findIndex(g => g.id === id)
    if (index === -1) return false
    this.groups.splice(index, 1)
    // 同时删除该分组下的命令的 groupId
    this.commands.forEach(c => {
      if (c.groupId === id) {
        c.groupId = undefined
      }
    })
    this.save()
    return true
  }

  reorderGroups(groupIds: string[]): void {
    this.ensureInitialized()
    groupIds.forEach((id, order) => {
      const group = this.groups.find(g => g.id === id)
      if (group) {
        group.order = order
      }
    })
    this.save()
  }
}

export const quickCommandsRepository = new QuickCommandsRepository()