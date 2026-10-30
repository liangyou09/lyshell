import { app } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { readFile, mkdir, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import log from 'electron-log'
import {
  atomicWriteFile,
  cloneJsonValue,
  JsonStoreLoadError,
  loadJsonFileSync,
  RevisionConflictError
} from './atomic-json'

/**
 * 下载记录
 */
export interface DownloadRecord {
  id: string
  // 传输 taskId（用于 MD5 等后续更新匹配；历史记录可能缺失）
  taskId?: string
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
 * 使用延迟初始化，避免在 app ready 前调用 app.getPath
 */
export const DOWNLOAD_HISTORY_HOT_LIMIT = 1000
const HISTORY_PAGE_LIMIT = 100
interface HistoryArchive { file: string; count: number }

export class DownloadHistoryStorage {
  private dataDir: string | null = null
  private historyFile: string | null = null
  private configFile: string | null = null
  private records: DownloadRecord[] = []
  private config: DownloadDirConfig | null = null
  private initialized: boolean = false
  private archives: HistoryArchive[] = []
  private manifestFile: string | null = null
  private saveTimer?: ReturnType<typeof setTimeout>
  private writes: Promise<void> = Promise.resolve()
  private mutations: Promise<unknown> = Promise.resolve()
  private configMutations: Promise<void> = Promise.resolve()
  private dirty = false
  private retired: string[] = []
  private loadError: Error | null = null
  private configLoadError: JsonStoreLoadError | null = null
  private revision = 0

  private assertRevision(expectedRevision: number | undefined): void {
    if (expectedRevision === undefined) return
    if (expectedRevision !== this.revision) {
      throw new RevisionConflictError(this.manifestFile ?? 'download-history-v2.json', expectedRevision, this.revision)
    }
  }

  private mutate<T>(run: () => Promise<T>, expectedRevision?: number): Promise<T> {
    const result = this.mutations.then(() => {
      this.ensureInitialized()
      if (this.loadError) throw this.loadError
      this.assertRevision(expectedRevision)
      return run()
    })
    this.mutations = result.catch(() => {})
    return result
  }

  private hydrate(records: DownloadRecord[]): DownloadRecord[] {
    return records.map(r => ({ ...r, startTime: new Date(r.startTime), endTime: r.endTime ? new Date(r.endTime) : undefined }))
  }

  private scheduleSave(): void {
    this.dirty = true
    if (!this.saveTimer) this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      void this.flush().catch(error => log.error('Failed to save download history:', error))
    }, 250)
  }

  private save(): Promise<void> {
    this.ensureInitialized()
    if (this.loadError) return Promise.reject(this.loadError)
    if (!this.dirty) return this.writes
    this.dirty = false
    const retired = this.retired.splice(0)
    const snapshot = JSON.stringify({ version: 2, records: this.records, archives: this.archives })
    const write = this.writes.catch(() => {}).then(async () => {
      await mkdir(this.dataDir!, { recursive: true })
      // 同目录唯一临时文件 + fsync + rename；失败保留旧 manifest 并清理临时对象。
      await atomicWriteFile(this.manifestFile!, snapshot)
      for (const file of retired) await unlink(join(this.dataDir!, file)).catch(() => {})
      this.revision += 1
    })
    this.writes = write.catch(error => { this.retired.push(...retired); this.dirty = true; throw error })
    return this.writes
  }

  /** 退出与测试的持久化屏障；正常新增/MD5 更新以 250ms 合并。 */
  async flush(): Promise<void> {
    clearTimeout(this.saveTimer); this.saveTimer = undefined
    await this.configMutations
    await this.mutations
    await this.save()
  }

  private async archive(records: DownloadRecord[]): Promise<HistoryArchive> {
    await mkdir(this.dataDir!, { recursive: true })
    const file = `download-archive-${randomUUID()}.json`
    await atomicWriteFile(join(this.dataDir!, file), JSON.stringify(records))
    return { file, count: records.length }
  }


  /**
   * 确保已初始化（延迟初始化，在 app ready 后调用）
   */
  private ensureInitialized(): void {
    if (this.initialized) return

    this.dataDir = join(app.getPath('userData'), 'data')
    this.historyFile = join(this.dataDir, 'download-history.json')
    this.manifestFile = join(this.dataDir, 'download-history-v2.json')
    this.configFile = join(this.dataDir, 'download-config.json')

    // 默认配置
    this.config = {
      defaultDir: join(app.getPath('downloads'), 'LyShell'),
      serverDirs: {},
      autoCreateServerSubdir: true
    }

    this.initialized = true
  }

  /**
   * 初始化（加载数据）- 在 app ready 后调用
   */
  async init(): Promise<void> {
    this.ensureInitialized()

    // 确保数据目录存在
    if (!existsSync(this.dataDir!)) {
      await mkdir(this.dataDir!, { recursive: true })
    }

    try {
      // v2 只保留最近 1000 条在内存；旧 JSON 只读迁移并原样保留，绝不删用户历史。
      if (existsSync(this.manifestFile!)) {
        const stored = JSON.parse(await readFile(this.manifestFile!, 'utf-8'))
        if (stored.version !== 2 || !Array.isArray(stored.records) || stored.records.length > DOWNLOAD_HISTORY_HOT_LIMIT || !Array.isArray(stored.archives)
          || stored.archives.some((archive: HistoryArchive) => !archive || !/^download-archive-[\da-f-]+\.json$/.test(archive.file) || !Number.isInteger(archive.count) || archive.count < 0 || archive.count > DOWNLOAD_HISTORY_HOT_LIMIT)) throw new Error('Invalid download history manifest')
        this.records = this.hydrate(stored.records)
        this.archives = stored.archives
      } else if (existsSync(this.historyFile!)) {
        const legacy: DownloadRecord[] = JSON.parse(await readFile(this.historyFile!, 'utf-8'))
        if (!Array.isArray(legacy)) throw new Error('Invalid legacy download history')
        this.records = this.hydrate(legacy.slice(0, DOWNLOAD_HISTORY_HOT_LIMIT))
        for (let offset = DOWNLOAD_HISTORY_HOT_LIMIT; offset < legacy.length; offset += DOWNLOAD_HISTORY_HOT_LIMIT) {
          this.archives.push(await this.archive(legacy.slice(offset, offset + DOWNLOAD_HISTORY_HOT_LIMIT)))
        }
        this.dirty = true
        await this.save()
      }
    } catch (error) {
      // 保留损坏/不可读档案，隔离历史功能故障，不使整个应用启动失败或用空库覆盖原数据。
      this.loadError = error instanceof Error ? error : new Error(String(error))
      this.records = []; this.archives = []; this.dirty = false
      log.error('Download history unavailable; original files preserved:', this.loadError.message)
    }

    // 加载配置：损坏的原件保留，尝试 .bak 恢复；无法恢复时标记只读失败，禁止默认值覆盖。
    const configResult = loadJsonFileSync<Record<string, unknown>>(this.configFile!, {
      validate: raw => {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          throw new Error('download-config.json must be a JSON object')
        }
        return raw as Record<string, unknown>
      }
    })
    if (configResult.status === 'failed') {
      this.configLoadError = configResult.error
      log.warn('Failed to load download config, keeping damaged file untouched:', configResult.error)
    } else if (configResult.status !== 'missing') {
      const data = configResult.value
      const config = this.config!
      if (typeof data.defaultDir === 'string' && data.defaultDir.length > 0) {
        config.defaultDir = data.defaultDir
      }
      if (typeof data.serverDirs === 'object' && data.serverDirs !== null && !Array.isArray(data.serverDirs)) {
        for (const [key, value] of Object.entries(data.serverDirs as Record<string, unknown>)) {
          if (typeof value === 'string') config.serverDirs[key] = value
        }
      }
      if (typeof data.autoCreateServerSubdir === 'boolean') {
        config.autoCreateServerSubdir = data.autoCreateServerSubdir
      }
      if (configResult.status === 'recovered') {
        log.warn(
          `download-config.json was corrupt; restored from backup (damaged copy: ${configResult.preservedPath ?? 'unavailable'})`
        )
      }
      log.info('Loaded download config')
    }

    // 确保默认下载目录存在
    if (!existsSync(this.config!.defaultDir)) {
      await mkdir(this.config!.defaultDir, { recursive: true })
      log.info(`Created default download dir: ${this.config!.defaultDir}`)
    }
  }

  /**
   * 保存配置：先原子写盘成功后再替换内存；损坏的旧配置拒绝覆盖。
   */
  private async saveConfig(next: DownloadDirConfig): Promise<void> {
    this.ensureInitialized()
    if (this.configLoadError) throw this.configLoadError
    const json = JSON.stringify(next, null, 2)
    await atomicWriteFile(this.configFile!, json)
    try {
      await atomicWriteFile(`${this.configFile!}.bak`, json)
    } catch (error) {
      log.warn('Failed to refresh download config backup; primary commit succeeded:', error)
    }
    this.config = next
    this.revision += 1
  }

  /** 在同一条串行链中读取最新配置、核对版本并提交，避免并发保存彼此覆盖。 */
  private mutateConfig(update: (current: DownloadDirConfig) => DownloadDirConfig, expectedRevision?: number): Promise<void> {
    const run = this.configMutations.then(async () => {
      this.ensureInitialized()
      this.assertRevision(expectedRevision)
      await this.saveConfig(update(this.config!))
    })
    this.configMutations = run.catch(() => {})
    return run
  }

  getRevision(): number {
    this.ensureInitialized()
    return this.revision
  }

  /**
   * 添加下载记录
   */
  async addRecord(record: DownloadRecord, options: { expectedRevision?: number } = {}): Promise<DownloadRecord> {
    this.ensureInitialized()
    return this.mutate(async () => {
      // 先写不可变归档，再原子切换 manifest。归档失败不移除内存中的旧记录。
      if (this.records.length >= DOWNLOAD_HISTORY_HOT_LIMIT) {
        const archived = await this.archive(this.records)
        this.archives.unshift(archived)
        this.records = []
      }
      const stored = this.hydrate([{ ...record }])[0]
      this.records.unshift(stored)
      this.scheduleSave()
      return this.hydrate([stored])[0]
    }, options.expectedRevision)
  }

  private async updateMatching(matches: (record: DownloadRecord) => boolean, updates: Partial<DownloadRecord>, options: { expectedRevision?: number } = {}): Promise<DownloadRecord | null> {
    return this.mutate(async () => {
      const index = this.records.findIndex(matches)
      if (index !== -1) {
        const stored = { ...this.records[index], ...cloneJsonValue(updates) }
        this.records[index] = stored
        this.scheduleSave()
        return this.hydrate([stored])[0]
      }
      for (let i = 0; i < this.archives.length; i++) {
        const records = this.hydrate(JSON.parse(await readFile(join(this.dataDir!, this.archives[i].file), 'utf-8')))
        const found = records.findIndex(matches)
        if (found === -1) continue
        records[found] = { ...records[found], ...updates }
        const old = this.archives[i].file
        this.archives[i] = await this.archive(records)
        this.retired.push(old)
        this.scheduleSave()
        return this.hydrate([records[found]])[0]
      }
      return null
    }, options.expectedRevision)
  }

  async updateRecord(id: string, updates: Partial<DownloadRecord>, options: { expectedRevision?: number } = {}): Promise<DownloadRecord | null> {
    return this.updateMatching(record => record.id === id, updates, options)
  }

  async updateRecordByTaskId(taskId: string, updates: Partial<DownloadRecord>, options: { expectedRevision?: number } = {}): Promise<DownloadRecord | null> {
    return this.updateMatching(record => record.taskId === taskId, updates, options)
  }

  /** 历史不按年龄删除；旧记录按千条归档，界面每页最多 100 条。 */
  getPage(sessionId?: string, offset = 0, limit = HISTORY_PAGE_LIMIT): Promise<{ records: DownloadRecord[]; hasMore: boolean }> {
    return this.mutate(() => this.readPage(sessionId, offset, limit))
  }

  private async readPage(sessionId: string | undefined, offset: number, limit: number): Promise<{ records: DownloadRecord[]; hasMore: boolean }> {
    const archives = [...this.archives]
    const result: DownloadRecord[] = []
    const size = Math.min(HISTORY_PAGE_LIMIT, Math.max(1, limit))
    let skip = Math.max(0, offset)
    const take = (records: DownloadRecord[]) => {
      for (const record of records) {
        if (sessionId && record.sessionId !== sessionId) continue
        if (skip) { skip--; continue }
        result.push(record)
        if (result.length > size) return true
      }
      return false
    }
    if (!take(this.records)) {
      for (const archive of archives) {
        if (!sessionId && skip >= archive.count) { skip -= archive.count; continue }
        if (take(this.hydrate(JSON.parse(await readFile(join(this.dataDir!, archive.file), 'utf-8'))))) break
      }
    }
    return { records: this.hydrate(result.slice(0, size)), hasMore: result.length > size }
  }

  /**
   * 获取内存中的最近记录（完整历史请用 getPage）
   */
  getAllRecords(): DownloadRecord[] {
    return this.hydrate(this.records.map(record => ({ ...record })))
  }

  /**
   * 按服务器获取内存中的最近记录
   */
  getRecordsByServer(sessionId: string): DownloadRecord[] {
    return this.hydrate(this.records.filter(r => r.sessionId === sessionId).map(record => ({ ...record })))
  }

  /**
   * 按服务器地址获取内存中的最近记录
   */
  getRecordsByHost(host: string, port: number): DownloadRecord[] {
    return this.hydrate(this.records.filter(r => r.host === host && r.port === port).map(record => ({ ...record })))
  }

  /**
   * 删除记录
   */
  async deleteRecord(id: string, options: { expectedRevision?: number } = {}): Promise<boolean> {
    return this.mutate(async () => {
      const index = this.records.findIndex(record => record.id === id)
      if (index !== -1) this.records.splice(index, 1)
      else {
        let found = false
        for (let i = 0; i < this.archives.length; i++) {
          const records: DownloadRecord[] = JSON.parse(await readFile(join(this.dataDir!, this.archives[i].file), 'utf-8'))
          const filtered = records.filter(record => record.id !== id)
          if (filtered.length === records.length) continue
          const old = this.archives[i].file
          this.archives[i] = await this.archive(filtered)
          this.retired.push(old)
          found = true; break
        }
        if (!found) return false
      }
      this.scheduleSave()
      return true
    }, options.expectedRevision)
  }

  async clearAll(options: { expectedRevision?: number } = {}): Promise<void> {
    await this.mutate(async () => { this.records = []; this.retired.push(...this.archives.map(archive => archive.file)); this.archives = []; this.scheduleSave() }, options.expectedRevision)
    await this.flush()
  }

  /**
   * 获取下载目录配置
   */
  getConfig(): DownloadDirConfig {
    this.ensureInitialized()
    return cloneJsonValue(this.config!)
  }

  /**
   * 更新下载目录配置
   */
  async updateConfig(updates: Partial<DownloadDirConfig>, options: { expectedRevision?: number } = {}): Promise<void> {
    const snapshot = cloneJsonValue(updates)
    await this.mutateConfig(current => ({ ...current, ...snapshot }), options.expectedRevision)
  }

  /**
   * 获取指定会话的下载目录
   * 优先级：服务器配置 > 全局默认 + 服务器子目录 > 全局默认
   */
  getDownloadDir(sessionId: string, sessionName: string, host: string, port: number): string {
    this.ensureInitialized()
    // 1. 检查是否有服务器特定配置
    const serverKey = sessionId
    if (this.config!.serverDirs[serverKey]) {
      return this.config!.serverDirs[serverKey]
    }

    // 2. 检查 host:port 配置
    const hostKey = `${host}:${port}`
    if (this.config!.serverDirs[hostKey]) {
      return this.config!.serverDirs[hostKey]
    }

    // 3. 如果启用自动子目录，使用服务器名称创建子目录
    if (this.config!.autoCreateServerSubdir && sessionName) {
      // 清理服务器名称，移除特殊字符
      const safeName = sessionName.replace(/[<>:"/\\|?*]/g, '_').trim()
      return join(this.config!.defaultDir, safeName)
    }

    // 4. 使用全局默认目录
    return this.config!.defaultDir
  }

  /**
   * 设置服务器下载目录
   */
  async setServerDownloadDir(sessionId: string, dir: string, options: { expectedRevision?: number } = {}): Promise<void> {
    await this.mutateConfig(current => ({ ...current,
      serverDirs: { ...current.serverDirs, [sessionId]: dir }
    }), options.expectedRevision)
  }

  /**
   * 删除服务器下载目录配置
   */
  async removeServerDownloadDir(sessionId: string, options: { expectedRevision?: number } = {}): Promise<void> {
    await this.mutateConfig(current => {
      const serverDirs = { ...current.serverDirs }
      delete serverDirs[sessionId]
      return { ...current, serverDirs }
    }, options.expectedRevision)
  }
}

// 单例
export const downloadHistory = new DownloadHistoryStorage()
