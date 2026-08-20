/**
 * 插件注册表仓库。
 *
 * 管理 {userData}/plugins/registry.json —— 已安装插件的状态真相源。
 * 与插件文件夹分离（§8.2）：启用/禁用只翻转 enabled，卸载才删文件夹 + 移记录。
 *
 * 原子落盘（先写 .tmp 再 rename），避免卸载/启用频繁写盘时中途崩溃损坏整份注册表。
 * 模式对齐 mcp-audit-repository.ts。延迟初始化（ensureInitialized），避免 app.ready
 * 前调 app.getPath。
 */
import { app } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'fs'
import log from 'electron-log'
import type { PluginRegistryEntry } from '@shared/plugin-types'
import type { McpCapability } from '@shared/api-routes'

/** {userData}/plugins/ —— registry.json 与插件资产同根。 */
export function getPluginsDir(): string {
  const dir = join(app.getPath('userData'), 'plugins')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

class PluginRepository {
  private filePath: string | null = null
  private entries: Map<string, PluginRegistryEntry> = new Map()
  private loaded = false

  private ensureInitialized(): void {
    if (this.loaded) return
    this.filePath = join(getPluginsDir(), 'registry.json')
    this.load()
    this.loaded = true
  }

  private load(): void {
    if (!this.filePath) return
    // 清理上次崩溃可能残留的 .tmp（saveNow 先写 .tmp 再 rename，中途崩溃会留下）。
    const tmp = `${this.filePath}.tmp`
    if (existsSync(tmp)) {
      try {
        unlinkSync(tmp)
      } catch {
        /* 被占用等：忽略，下次再清 */
      }
    }
    if (!existsSync(this.filePath)) return
    try {
      const content = readFileSync(this.filePath, 'utf-8')
      const data = JSON.parse(content)
      if (Array.isArray(data)) {
        for (const e of data) {
          if (e && typeof e.id === 'string') {
            this.entries.set(e.id, e as PluginRegistryEntry)
          }
        }
        log.info(`[plugin] Loaded ${this.entries.size} plugin entries`)
      }
    } catch (e) {
      log.error('[plugin] Failed to load registry:', e)
    }
  }

  private saveNow(): void {
    if (!this.filePath) return
    // 原子落盘：先写临时文件再 rename，避免写盘中途崩溃损坏整份注册表。
    // rename 在同分区上是原子的；Windows 上若目标文件被占用会抛错，此时回退到直写。
    const tmp = `${this.filePath}.tmp`
    const data = JSON.stringify(Array.from(this.entries.values()), null, 2)
    try {
      writeFileSync(tmp, data, 'utf-8')
      try {
        renameSync(tmp, this.filePath)
      } catch (e) {
        log.warn('[plugin] Atomic rename failed, falling back to direct write:', e)
        writeFileSync(this.filePath, data, 'utf-8')
      }
    } catch (e) {
      log.error('[plugin] Failed to save registry:', e)
    }
  }

  /** 全部安装记录（含禁用） */
  getAll(): PluginRegistryEntry[] {
    this.ensureInitialized()
    return Array.from(this.entries.values())
  }

  get(id: string): PluginRegistryEntry | undefined {
    this.ensureInitialized()
    return this.entries.get(id)
  }

  /** 仅已启用的记录（plugin host 启动时加载这些） */
  getEnabled(): PluginRegistryEntry[] {
    this.ensureInitialized()
    return Array.from(this.entries.values()).filter((e) => e.enabled)
  }

  /** 新增或覆盖（安装 / 更新） */
  upsert(entry: PluginRegistryEntry): void {
    this.ensureInitialized()
    this.entries.set(entry.id, entry)
    this.saveNow()
  }

  setEnabled(id: string, enabled: boolean): boolean {
    this.ensureInitialized()
    const e = this.entries.get(id)
    if (!e) return false
    e.enabled = enabled
    this.saveNow()
    return true
  }

  /** 更新用户批准的 capability（安装/更新时权限变更） */
  setGrantedCapabilities(id: string, capabilities: McpCapability[]): boolean {
    this.ensureInitialized()
    const e = this.entries.get(id)
    if (!e) return false
    e.grantedCapabilities = capabilities
    this.saveNow()
    return true
  }

  /** 从注册表移除记录（卸载流程的第 3 步，删文件夹由调用方负责） */
  remove(id: string): boolean {
    this.ensureInitialized()
    if (!this.entries.delete(id)) return false
    this.saveNow()
    return true
  }
}

export const pluginRepository = new PluginRepository()
