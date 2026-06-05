import { app } from 'electron'
import { join } from 'path'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import log from 'electron-log'

/**
 * 下载记录
 */
export interface DownloadRecord {
  id: string
  // 服务器信息
  sessionId: string
  sessionName: string
  host: string
  port: number
  // 文件信息
  remotePath: string
  localPath: string
  fileName: string
  fileSize: number
  // 下载信息
  startTime: Date
  endTime?: Date
  status: 'success' | 'failed' | 'cancelled'
  error?: string
  md5?: string
  // 目录配置（下载时使用的目录）
  downloadDir: string
}

/**
 * 下载目录配置
 */
export interface DownloadDirConfig {
  // 全局默认下载目录
  defaultDir: string
  // 按服务器配置的下载目录（key: sessionId 或 host:port）
  serverDirs: Record<string, string>
  // 是否按服务器自动创建子目录
  autoCreateServerSubdir: boolean
}

/**
 * 下载历史存储
 */
class DownloadHistoryStorage {
  private dataDir: string
  private historyFile: string
  private configFile: string
  private records: DownloadRecord[] = []
  private config: DownloadDirConfig

  constructor() {
    this.dataDir = join(app.getPath('userData'), 'data')
    this.historyFile = join(this.dataDir, 'download-history.json')
    this.configFile = join(this.dataDir, 'download-config.json')

    // 默认配置
    this.config = {
      defaultDir: join(app.getPath('downloads'), 'NovaShell'),
      serverDirs: {},
      autoCreateServerSubdir: true
    }
  }

  /**
   * 初始化（加载数据）
   */
  async init(): Promise<void> {
    // 确保数据目录存在
    if (!existsSync(this.dataDir)) {
      await mkdir(this.dataDir, { recursive: true })
    }

    // 加载历史记录
    try {
      if (existsSync(this.historyFile)) {
        const data = await readFile(this.historyFile, 'utf-8')
        this.records = JSON.parse(data)
        // 转换日期字段
        this.records = this.records.map(r => ({
          ...r,
          startTime: new Date(r.startTime),
          endTime: r.endTime ? new Date(r.endTime) : undefined
        }))
        log.info(`Loaded ${this.records.length} download records`)
      }
    } catch (error) {
      log.warn('Failed to load download history:', error)
      this.records = []
    }

    // 加载配置
    try {
      if (existsSync(this.configFile)) {
        const data = await readFile(this.configFile, 'utf-8')
        this.config = { ...this.config, ...JSON.parse(data) }
        log.info('Loaded download config')
      }
    } catch (error) {
      log.warn('Failed to load download config:', error)
    }

    // 确保默认下载目录存在
    if (!existsSync(this.config.defaultDir)) {
      await mkdir(this.config.defaultDir, { recursive: true })
      log.info(`Created default download dir: ${this.config.defaultDir}`)
    }
  }

  /**
   * 保存数据
   */
  private async save(): Promise<void> {
    try {
      await writeFile(this.historyFile, JSON.stringify(this.records, null, 2), 'utf-8')
    } catch (error) {
      log.error('Failed to save download history:', error)
    }
  }

  /**
   * 保存配置
   */
  private async saveConfig(): Promise<void> {
    try {
      await writeFile(this.configFile, JSON.stringify(this.config, null, 2), 'utf-8')
    } catch (error) {
      log.error('Failed to save download config:', error)
    }
  }

  /**
   * 添加下载记录
   */
  async addRecord(record: DownloadRecord): Promise<DownloadRecord> {
    this.records.unshift(record)  // 新记录放在前面
    await this.save()
    return record
  }

  /**
   * 更新下载记录
   */
  async updateRecord(id: string, updates: Partial<DownloadRecord>): Promise<DownloadRecord | null> {
    const index = this.records.findIndex(r => r.id === id)
    if (index === -1) return null

    this.records[index] = { ...this.records[index], ...updates }
    await this.save()
    return this.records[index]
  }

  /**
   * 根据 taskId 更新记录（用于 MD5 更新）
   */
  async updateRecordByTaskId(taskId: string, updates: Partial<DownloadRecord>): Promise<DownloadRecord | null> {
    // taskId 保存在 startTime 中（作为 Date 对象），需要转换查找
    const record = this.records.find(r => {
      const recordTaskId = r.startTime.getTime().toString()
      return recordTaskId === taskId
    })
    if (!record) return null

    const index = this.records.indexOf(record)
    this.records[index] = { ...record, ...updates }
    await this.save()
    return this.records[index]
  }

  /**
   * 获取所有记录
   */
  getAllRecords(): DownloadRecord[] {
    return this.records
  }

  /**
   * 按服务器获取记录
   */
  getRecordsByServer(sessionId: string): DownloadRecord[] {
    return this.records.filter(r => r.sessionId === sessionId)
  }

  /**
   * 按服务器地址获取记录
   */
  getRecordsByHost(host: string, port: number): DownloadRecord[] {
    return this.records.filter(r => r.host === host && r.port === port)
  }

  /**
   * 删除记录
   */
  async deleteRecord(id: string): Promise<boolean> {
    const index = this.records.findIndex(r => r.id === id)
    if (index === -1) return false

    this.records.splice(index, 1)
    await this.save()
    return true
  }

  /**
   * 清空所有记录
   */
  async clearAll(): Promise<void> {
    this.records = []
    await this.save()
  }

  /**
   * 获取下载目录配置
   */
  getConfig(): DownloadDirConfig {
    return this.config
  }

  /**
   * 更新下载目录配置
   */
  async updateConfig(updates: Partial<DownloadDirConfig>): Promise<void> {
    this.config = { ...this.config, ...updates }
    await this.saveConfig()
  }

  /**
   * 获取指定会话的下载目录
   * 优先级：服务器配置 > 全局默认 + 服务器子目录 > 全局默认
   */
  getDownloadDir(sessionId: string, sessionName: string, host: string, port: number): string {
    // 1. 检查是否有服务器特定配置
    const serverKey = sessionId
    if (this.config.serverDirs[serverKey]) {
      return this.config.serverDirs[serverKey]
    }

    // 2. 检查 host:port 配置
    const hostKey = `${host}:${port}`
    if (this.config.serverDirs[hostKey]) {
      return this.config.serverDirs[hostKey]
    }

    // 3. 如果启用自动子目录，使用服务器名称创建子目录
    if (this.config.autoCreateServerSubdir && sessionName) {
      // 清理服务器名称，移除特殊字符
      const safeName = sessionName.replace(/[<>:"/\\|?*]/g, '_').trim()
      return join(this.config.defaultDir, safeName)
    }

    // 4. 使用全局默认目录
    return this.config.defaultDir
  }

  /**
   * 设置服务器下载目录
   */
  async setServerDownloadDir(sessionId: string, dir: string): Promise<void> {
    this.config.serverDirs[sessionId] = dir
    await this.saveConfig()
  }

  /**
   * 删除服务器下载目录配置
   */
  async removeServerDownloadDir(sessionId: string): Promise<void> {
    delete this.config.serverDirs[sessionId]
    await this.saveConfig()
  }
}

// 单例
export const downloadHistory = new DownloadHistoryStorage()