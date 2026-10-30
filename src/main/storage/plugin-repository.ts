/**
 * 插件注册表仓库。
 *
 * 管理 {userData}/plugins/registry.json —— 已安装插件的状态真相源。
 * 与插件文件夹分离（§8.2）：启用/禁用只翻转 enabled，卸载才删文件夹 + 移记录。
 *
 * 原子落盘（同目录唯一临时文件 + fsync + rename，见 atomic-json.ts），避免卸载/启用
 * 频繁写盘时中途崩溃损坏整份注册表；rename 失败不再直写目标（直写会截断旧文件）。
 * 损坏的注册表保留原件、内存为空且拒绝写入，等待人工恢复或显式从 .bak 恢复。
 * 延迟初始化（ensureInitialized），避免 app.ready 前调 app.getPath。
 */
import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, unlinkSync } from 'fs'
import log from 'electron-log'
import type { PluginRegistryEntry } from '@shared/plugin-types'
import type { McpCapability } from '@shared/api-routes'
import {
  atomicWriteFileSync,
  cloneJsonValue,
  JsonStoreLoadError,
  loadJsonFileSync,
  RevisionConflictError,
  writeBackupSync
} from './atomic-json'

/** {userData}/plugins/ —— registry.json 与插件资产同根。 */
export function getPluginsDir(): string {
  const dir = join(app.getPath('userData'), 'plugins')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export interface RevisionOptions {
  expectedRevision?: number
}

const validateRegistryFile = (raw: unknown): unknown[] => {
  if (!Array.isArray(raw)) throw new Error('plugin registry must be a JSON array')
  return raw
}

export class PluginRepository {
  private filePath: string | null = null
  private entries: Map<string, PluginRegistryEntry> = new Map()
  private loaded = false
  private revision = 0
  private loadError: JsonStoreLoadError | null = null

  private ensureInitialized(): void {
    if (this.loaded) return
    this.filePath = join(getPluginsDir(), 'registry.json')
    this.load()
    this.loaded = true
  }

  private load(): void {
    if (!this.filePath) return
    // 清理旧版固定 .tmp（历史 saveNow 的残留）；新版临时文件名唯一，失败会自行清理。
    const legacyTmp = `${this.filePath}.tmp`
    if (existsSync(legacyTmp)) {
      try {
        unlinkSync(legacyTmp)
      } catch {
        /* 被占用等：忽略，下次再清 */
      }
    }

    const result = loadJsonFileSync<unknown[]>(this.filePath, { validate: validateRegistryFile })
    if (result.status === 'missing') return
    if (result.status === 'failed') {
      this.loadError = result.error
      log.error('[plugin] Failed to load registry, keeping damaged file untouched:', result.error)
      return
    }
    for (const e of result.value) {
      if (e && typeof (e as PluginRegistryEntry).id === 'string') {
        this.entries.set((e as PluginRegistryEntry).id, e as PluginRegistryEntry)
      }
    }
    if (result.status === 'recovered') {
      log.warn(
        `[plugin] registry.json was corrupt; restored from backup (damaged copy: ${result.preservedPath ?? 'unavailable'})`
      )
    }
    log.info(`[plugin] Loaded ${this.entries.size} plugin entries`)
  }

  /** 写入失败向上抛：调用方据此回滚内存并向用户报错（不再吞掉直写失败） */
  private saveNow(): void {
    if (!this.filePath) throw new Error('plugin registry is not initialized')
    if (this.loadError) throw this.loadError

    const json = JSON.stringify(Array.from(this.entries.values()), null, 2)
    atomicWriteFileSync(this.filePath, json)
    if (!writeBackupSync(this.filePath, json)) {
      log.warn('[plugin] Failed to refresh registry backup; primary commit succeeded')
    }
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

  private assertRevision(expectedRevision: number | undefined): void {
    if (expectedRevision === undefined) return
    if (expectedRevision !== this.revision) {
      throw new RevisionConflictError(this.filePath ?? 'registry.json', expectedRevision, this.revision)
    }
  }

  /** 全部安装记录（含禁用） */
  getAll(): PluginRegistryEntry[] {
    this.ensureInitialized()
    return Array.from(this.entries.values()).map(entry => cloneJsonValue(entry))
  }

  get(id: string): PluginRegistryEntry | undefined {
    this.ensureInitialized()
    const found = this.entries.get(id)
    return found ? cloneJsonValue(found) : undefined
  }

  /** 仅已启用的记录（plugin host 启动时加载这些） */
  getEnabled(): PluginRegistryEntry[] {
    this.ensureInitialized()
    return Array.from(this.entries.values())
      .filter((e) => e.enabled)
      .map(entry => cloneJsonValue(entry))
  }

  /** 新增或覆盖（安装 / 更新）。落盘失败恢复原记录并抛出。 */
  upsert(entry: PluginRegistryEntry, options: RevisionOptions = {}): void {
    this.ensureInitialized()
    this.assertRevision(options.expectedRevision)
    const previous = this.entries.get(entry.id)
    this.entries.set(entry.id, cloneJsonValue(entry))
    try {
      this.saveNow()
    } catch (error) {
      if (previous === undefined) this.entries.delete(entry.id)
      else this.entries.set(entry.id, previous)
      log.error('[plugin] Failed to save registry after upsert:', error)
      throw error
    }
  }

  setEnabled(id: string, enabled: boolean, options: RevisionOptions = {}): boolean {
    this.ensureInitialized()
    this.assertRevision(options.expectedRevision)
    const e = this.entries.get(id)
    if (!e) return false
    const previous = e.enabled
    e.enabled = enabled
    try {
      this.saveNow()
      return true
    } catch (error) {
      e.enabled = previous
      log.error('[plugin] Failed to save registry after setEnabled:', error)
      return false
    }
  }

  /** 更新用户批准的 capability（安装/更新时权限变更） */
  setGrantedCapabilities(id: string, capabilities: McpCapability[], options: RevisionOptions = {}): boolean {
    this.ensureInitialized()
    this.assertRevision(options.expectedRevision)
    const e = this.entries.get(id)
    if (!e) return false
    const previous = e.grantedCapabilities
    e.grantedCapabilities = [...capabilities]
    try {
      this.saveNow()
      return true
    } catch (error) {
      e.grantedCapabilities = previous
      log.error('[plugin] Failed to save registry after capability update:', error)
      return false
    }
  }

  /** 从注册表移除记录（卸载流程的第 3 步，删文件夹由调用方负责） */
  remove(id: string, options: RevisionOptions = {}): boolean {
    this.ensureInitialized()
    this.assertRevision(options.expectedRevision)
    const previous = this.entries.get(id)
    if (previous === undefined) return false
    this.entries.delete(id)
    try {
      this.saveNow()
      return true
    } catch (error) {
      this.entries.set(id, previous)
      log.error('[plugin] Failed to save registry after remove:', error)
      return false
    }
  }
}

export const pluginRepository = new PluginRepository()
