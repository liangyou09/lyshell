/**
 * 插件界面视图注册表（main 侧单一事实来源）
 *
 * 合并两路视图来源（docs/plugin-ui-views-plan.md §二）：
 *   - 声明式：已启用插件 manifest 的 contributes.views（缓存于显式刷新点 —— 安装/
 *     启用/宿主重启，dev 插件磁盘外部编辑不做实时监听，以重新启用/重装为刷新点）。
 *   - 运行时：Node persistent activate(api).registerView() / Python persistent 经
 *     HTTP 路由注册，仅在本插件进程期间有效；宿主（共享 node host / 单个 python
 *     persistent 进程）退出（含异常退出）即清除对应插件的运行时视图。
 *
 * 排序稳定：插件安装顺序（deps.getEnabledEntries 顺序）→ manifest 声明顺序 →
 * 运行时注册顺序。listViews() 仅返回 enabled 插件的视图。
 *
 * 本模块不引入 electron（广播与插件目录解析经 deps 注入），便于 vitest 直接测；
 * 真实 deps 在 main 启动时经 initPluginViewRegistry() 装配。
 */
import { existsSync, realpathSync, statSync } from 'fs'
import { isAbsolute, join, relative } from 'path'
import {
  PLUGIN_MAX_VIEWS,
  validateViewDefinition,
  type PluginRegistryEntry,
  type PluginViewDefinition,
  type PluginViewMeta
} from '@shared/plugin-types'

/** 注册/FS 校验失败原因（4xx 语义，直接回给插件/HTTP 调用方） */
export class ViewRegistrationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ViewRegistrationError'
  }
}

/** 依赖注入：保持本模块无 electron 依赖。 */
export interface ViewRegistryDeps {
  /** 已启用插件条目（顺序即安装顺序 = 展示顺序） */
  getEnabledEntries(): PluginRegistryEntry[]
  /** 插件根目录（dev 绝对路径 / {pluginsDir}/{id}） */
  pluginDirOf(entry: PluginRegistryEntry): string
  /** 读单条 entry 的 manifest contributes.views（读失败/校验失败降级 []，wiring 层实现） */
  readManifestViews(entry: PluginRegistryEntry): PluginViewDefinition[]
  /** 广播 PLUGIN_VIEWS_CHANGED 给所有窗口（负载为空，renderer 收到后重拉 plugin:list） */
  broadcast(): void
  /** 声明式视图被 FS 闸拒绝时的告警出口（可缺省；index.ts 接 log.warn） */
  logWarn?(msg: string, ...rest: unknown[]): void
}

/** win32 大小写不敏感的路径比较（realpath 已归一大小写，但防御性统一） */
function pathsEqual(a: string, b: string): boolean {
  return process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b
}

/** child 是否严格位于 parent 目录内（relative 语义，win32 下 path.relative 已大小写不敏感） */
export function isPathStrictlyInside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * 核实 entry/icon 文件实际存在且通过真实路径包围（realpath 防 dev 插件的
 * symlink/junction 指向插件根外）：
 *   - 真实 views/ 目录必须位于真实插件根内；
 *   - entry 真实路径必须位于真实 views/ 内且是文件；
 *   - icon 真实路径必须位于真实插件根内且是文件；
 *   - 拒绝 basename 以 . 开头（隐藏/凭据文件不进视图资源面）。
 * 返回首个失败的错误消息，全部通过返回 null。
 */
export function verifyViewFiles(pluginRoot: string, def: PluginViewDefinition): string | null {
  const rejectBase = (p: string): boolean => {
    const base = p.replace(/\\/g, '/').split('/').pop() ?? ''
    return base.startsWith('.')
  }
  let realRoot: string
  try {
    realRoot = realpathSync(pluginRoot)
  } catch {
    return 'plugin directory does not exist'
  }
  const viewsDir = join(pluginRoot, 'views')
  if (!existsSync(viewsDir)) return 'plugin "views/" directory does not exist'
  let realViews: string
  try {
    realViews = realpathSync(viewsDir)
  } catch {
    return 'plugin "views/" directory is not resolvable'
  }
  if (!isPathStrictlyInside(realViews, realRoot)) {
    return '"views/" directory must be inside the plugin root'
  }
  // entry：真实路径必须落在真实 views/ 内
  const entryPath = join(realViews, def.entry.replace(/^views\//, ''))
  let realEntry: string
  try {
    realEntry = realpathSync(entryPath)
  } catch {
    return `view entry file not found: ${def.entry}`
  }
  if (!isPathStrictlyInside(realEntry, realViews)) {
    return 'view entry must resolve inside the plugin "views/" directory'
  }
  try {
    if (!statSync(realEntry).isFile()) return 'view entry must be a file'
  } catch {
    return `view entry file not found: ${def.entry}`
  }
  if (rejectBase(realEntry)) return 'view entry must not be a hidden file'
  // icon：真实路径必须落在真实插件根内
  if (def.icon !== undefined) {
    const iconPath = join(realRoot, def.icon)
    let realIcon: string
    try {
      realIcon = realpathSync(iconPath)
    } catch {
      return `view icon file not found: ${def.icon}`
    }
    if (!isPathStrictlyInside(realIcon, realRoot) && !pathsEqual(realIcon, realRoot)) {
      return 'view icon must resolve inside the plugin root'
    }
    try {
      if (!statSync(realIcon).isFile()) return 'view icon must be a file'
    } catch {
      return `view icon file not found: ${def.icon}`
    }
    if (rejectBase(realIcon)) return 'view icon must not be a hidden file'
  }
  return null
}

export class PluginViewRegistry {
  /** 声明式缓存：pluginId -> manifest 顺序的视图定义（显式刷新点更新） */
  private declarative = new Map<string, PluginViewDefinition[]>()
  /** 运行时：pluginId -> (viewId -> 定义，Map 迭代序即注册序) */
  private runtime = new Map<string, Map<string, PluginViewDefinition>>()

  constructor(private deps: ViewRegistryDeps) {}

  // ---------- 声明式（缓存刷新点） ----------

  /**
   * 重扫全部 enabled 插件 manifest，重建声明式缓存；顺带丢弃已禁用/已卸载插件的
   * 运行时视图（禁用/卸载/宿主重启后由 handlers/host-mgr 调用）。缓存变化时广播。
   *
   * 声明式视图逐项过 verifyViewFiles（与运行时注册同一 FS 闸）：entry/icon 缺失
   * 或真实路径越界的定义不进缓存 —— 否则轨道先出槽位、点击才加载失败。启动首扫、
   * 安装/启用后的 syncPluginViews 都走这里，一处闸覆盖全部刷新点。
   */
  refreshAll(): void {
    const enabled = this.deps.getEnabledEntries()
    const enabledIds = new Set(enabled.map((e) => e.id))
    let changed = false
    const next = new Map<string, PluginViewDefinition[]>()
    for (const entry of enabled) {
      const dir = this.deps.pluginDirOf(entry)
      const valid: PluginViewDefinition[] = []
      for (const v of this.deps.readManifestViews(entry)) {
        const err = verifyViewFiles(dir, v)
        if (err) {
          this.deps.logWarn?.(`[plugin-view] declarative view rejected (${entry.id}/${v.id}):`, err)
          continue
        }
        valid.push(v)
      }
      next.set(entry.id, valid)
      const prev = this.declarative.get(entry.id)
      if (JSON.stringify(prev ?? []) !== JSON.stringify(valid)) changed = true
    }
    // 禁用/卸载的插件：声明缓存与运行时一并清除
    for (const id of [...this.declarative.keys()]) {
      if (!enabledIds.has(id)) {
        next.delete(id)
        changed = true
      }
    }
    for (const id of [...this.runtime.keys()]) {
      if (!enabledIds.has(id) && this.runtime.delete(id)) changed = true
    }
    this.declarative = next
    if (changed) this.deps.broadcast()
  }

  // ---------- 查询 ----------

  /** 合并后的全部视图（仅 enabled 插件；安装序 → manifest 序 → 注册序） */
  listViews(): PluginViewMeta[] {
    const out: PluginViewMeta[] = []
    for (const entry of this.deps.getEnabledEntries()) {
      const manifestViews = this.declarative.get(entry.id) ?? []
      for (const v of manifestViews) {
        out.push({ ...v, pluginId: entry.id, source: 'manifest' })
      }
      const runtimeViews = this.runtime.get(entry.id)
      if (runtimeViews) {
        for (const v of runtimeViews.values()) {
          out.push({ ...v, pluginId: entry.id, source: 'runtime' })
        }
      }
    }
    return out
  }

  /** 单插件视图（顺序同 listViews；禁用/未知插件返回 []） */
  listViewsForPlugin(pluginId: string): PluginViewMeta[] {
    return this.listViews().filter((v) => v.pluginId === pluginId)
  }

  /** 精确查找一个视图（协议/图标/弹窗/动作校验共用） */
  getView(pluginId: string, viewId: string): PluginViewMeta | null {
    for (const v of this.listViewsForPlugin(pluginId)) {
      if (v.id === viewId) return v
    }
    return null
  }

  /**
   * 按入口相对路径查找视图（协议 CSP 组装用）：URL 路径已剥 views/ 前缀，
   * 与 entry 去 views/ 前缀后精确比对（协议只给入口 HTML 附加 connectOrigins CSP）。
   */
  getViewByEntry(pluginId: string, entryRelPath: string): PluginViewMeta | null {
    for (const v of this.listViewsForPlugin(pluginId)) {
      if (v.entry.replace(/^views\//, '') === entryRelPath) return v
    }
    return null
  }

  /** 插件当前是否 enabled（registerView / 协议 / 动作的前置核对） */
  isPluginEnabled(pluginId: string): boolean {
    return this.deps.getEnabledEntries().some((e) => e.id === pluginId)
  }

  /** 插件根目录（协议 realpath 包围用；未知插件返回 null） */
  getPluginDir(pluginId: string): string | null {
    const entry = this.deps.getEnabledEntries().find((e) => e.id === pluginId)
    return entry ? this.deps.pluginDirOf(entry) : null
  }

  // ---------- 运行时注册/注销 ----------

  /**
   * 运行时注册（Node SDK registerView / Python HTTP POST）。与声明式共用同一校验器；
   * 运行时 + 声明式合计 ≤ 8；与声明式/既有运行时的 ID 或 entry 冲突直接拒绝，不做覆盖
   * （entry 是请求期视图身份：共用入口会让协议层按 entry 反查 CSP 时取错 connectOrigins）；
   * entry/icon 必须实际存在且通过真实路径包围。
   */
  registerRuntimeView(pluginId: string, raw: unknown): PluginViewMeta {
    if (!this.isPluginEnabled(pluginId)) {
      throw new ViewRegistrationError('plugin is not enabled')
    }
    const r = validateViewDefinition(raw)
    if (!r.ok || !r.view) {
      throw new ViewRegistrationError(`invalid view definition: ${r.errors.join('; ')}`)
    }
    const def = r.view
    const existing = this.listViewsForPlugin(pluginId)
    if (existing.some((v) => v.id === def.id)) {
      throw new ViewRegistrationError(`view id already registered: ${def.id}`)
    }
    // 入口冲突同样拒绝（含与声明式视图冲突；小写比对对齐 Windows 文件系统）。
    // 校验器只保证单个定义合法，跨定义的 entry 唯一性只能在注册时对现有视图核对。
    if (existing.some((v) => v.entry.toLowerCase() === def.entry.toLowerCase())) {
      throw new ViewRegistrationError(
        `view entry already registered: ${def.entry} (view URL identity is the entry path; each view must use its own HTML entry)`
      )
    }
    if (existing.length + 1 > PLUGIN_MAX_VIEWS) {
      throw new ViewRegistrationError(`at most ${PLUGIN_MAX_VIEWS} views per plugin`)
    }
    const entry = this.deps.getEnabledEntries().find((e) => e.id === pluginId)
    if (!entry) throw new ViewRegistrationError('plugin is not enabled')
    const fsError = verifyViewFiles(this.deps.pluginDirOf(entry), def)
    if (fsError) throw new ViewRegistrationError(fsError)
    let bucket = this.runtime.get(pluginId)
    if (!bucket) {
      bucket = new Map()
      this.runtime.set(pluginId, bucket)
    }
    bucket.set(def.id, def)
    const meta: PluginViewMeta = { ...def, pluginId, source: 'runtime' }
    this.deps.broadcast()
    return meta
  }

  /**
   * 注销运行时视图（幂等：不存在的 ID 也成功返回 false；声明式视图不能经此注销）。
   * 返回是否真的移除了一个运行时视图（调用方据此决定是否撤销 UI token）。
   */
  unregisterRuntimeView(pluginId: string, viewId: string): boolean {
    const bucket = this.runtime.get(pluginId)
    if (!bucket || !bucket.delete(viewId)) return false
    if (bucket.size === 0) this.runtime.delete(pluginId)
    this.deps.broadcast()
    return true
  }

  /** 插件是否还有运行时视图（注销最后一个视图时撤销 UI token 用） */
  hasRuntimeViews(pluginId: string): boolean {
    return (this.runtime.get(pluginId)?.size ?? 0) > 0
  }

  // ---------- 生命周期清理 ----------

  /**
   * 清除单个插件的运行时视图（禁用/卸载/单 python persistent 进程退出）。
   * 返回被清除的运行时视图 ID 列表（调用方据此关面板/撤 token）。
   */
  clearRuntimeForPlugin(pluginId: string): string[] {
    const bucket = this.runtime.get(pluginId)
    if (!bucket) return []
    const ids = [...bucket.keys()]
    this.runtime.delete(pluginId)
    this.deps.broadcast()
    return ids
  }

  /**
   * 清除一组插件的运行时视图（共享 node host 退出/异常退出：其中所有插件的
   * 运行时视图一并清除；声明式视图保持可用）。广播一次。
   */
  clearRuntimeForPlugins(pluginIds: string[]): string[][] {
    const removed: string[][] = []
    let changed = false
    for (const id of pluginIds) {
      const bucket = this.runtime.get(id)
      if (bucket) {
        removed.push([...bucket.keys()])
        this.runtime.delete(id)
        changed = true
      } else {
        removed.push([])
      }
    }
    if (changed) this.deps.broadcast()
    return removed
  }

  /** 清空全部运行时视图（main 退出/全面重置用） */
  clearAllRuntime(): void {
    if (this.runtime.size > 0) {
      this.runtime.clear()
      this.deps.broadcast()
    }
  }
}

// ====================== 单例装配 ======================

let instance: PluginViewRegistry | null = null

/** main 启动时装配真实 deps（electron 广播 + pluginRepository + getPluginsDir） */
export function initPluginViewRegistry(deps: ViewRegistryDeps): PluginViewRegistry {
  instance = new PluginViewRegistry(deps)
  return instance
}

/** 取已装配的单例（未装配即抛错 —— 暴露启动顺序问题而不是静默空表） */
export function getPluginViewRegistry(): PluginViewRegistry {
  if (!instance) throw new Error('plugin view registry not initialized')
  return instance
}
