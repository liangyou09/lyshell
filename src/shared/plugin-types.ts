/**
 * LyShell 插件契约（共享层）
 *
 * 定义 lyshell-plugin.json 清单结构 + registry.json 注册条目 + 校验。
 * 放 @shared 供 main（plugin host / repository）与 renderer（插件管理 UI）共用。
 *
 * 详见 docs/plugin-system-design.md §6（清单）与 §8（生命周期）。
 */
import type { McpCapability } from './api-routes'

/** 插件运行时 */
export type PluginRuntime = 'node' | 'python'

/** 插件生命周期：单次运行（跑完即退出）或长期运行（常驻至 LyShell 退出/禁用） */
export type PluginLifecycle = 'oneshot' | 'persistent'

/** 插件安装来源 */
export type PluginSource = 'local-file' | 'url' | 'builtin' | 'dev'

/**
 * 激活事件（VS Code 式：延迟激活）。
 *   - `onCommand:<id>`      用户触发某命令时激活
 *   - `onConnectionType:<t>` 选中某连接协议时激活
 *   - `onStartup`           LyShell 启动即激活
 *   - `*`                   立即激活（慎用）
 */
export type ActivationEvent = `onCommand:${string}` | `onConnectionType:${string}` | 'onStartup' | '*'

/** 声明式贡献点（VS Code contributes）：零激活即可出现在 UI 上 */
export interface PluginContributes {
  commands?: Array<{ id: string; title: string; icon?: string }>
  connectionTypes?: Array<{ type: string; label: string }>
  /** 贡献的 MCP/HTTP 工具，激活后经 registry.register() 进路由表（见 §9/§10） */
  tools?: Array<{ name: string; description?: string }>
  /**
   * 贡献的左侧机柜栏界面视图（最多 8 个，每视图独占轨道槽位）。
   * 声明式视图不要求 main 入口：entry 为插件 views/ 目录下的 .html，
   * 页面引用的 CSS/JS/图片/字体也放在该目录；icon 可在插件根目录内。
   */
  views?: PluginViewDefinition[]
}

// ====================== 插件界面视图（机柜轨视图贡献点） ======================

/** 视图 id 规则：小写字母开头，仅小写字母/数字/连字符（单插件内唯一） */
export const PLUGIN_VIEW_ID_PATTERN = /^[a-z][a-z0-9-]*$/

/** 单插件最多贡献的视图数（声明式 + 运行时合计） */
export const PLUGIN_MAX_VIEWS = 8

/** 视图标题 / 路径长度上限 */
export const PLUGIN_VIEW_TITLE_MAX = 64
export const PLUGIN_VIEW_PATH_MAX = 256

/**
 * 一个插件界面视图定义。manifest contributes.views 与运行时注册（registerView）
 * 共用同一形状与校验规则（validateViewDefinition）。
 */
export interface PluginViewDefinition {
  /** ^[a-z][a-z0-9-]*$，单插件内唯一 */
  id: string
  /** 非空，≤64 字符 */
  title: string
  /** 插件根目录内的 .svg 或 .png（相对路径，可选） */
  icon?: string
  /** 插件 views/ 目录内的 .html（相对插件根，必须以 views/ 开头） */
  entry: string
}

/** 视图运行时元数据：plugin:list 返回的展开形态（禁用插件 views 为空数组） */
export interface PluginViewMeta extends PluginViewDefinition {
  pluginId: string
  source: 'manifest' | 'runtime'
}

/**
 * 机柜轨插件视图页签的复合键 —— 全链路（NavTab/保活 Map/localStorage）统一用它
 * 标识视图，不能仅以 pluginId 作页签或保活键（同插件多视图会串槽）。
 * 构造/解析只经这两个纯函数，禁止各组件自行拼接。
 * pluginId（^[a-z0-9-]+$）与 viewId（^[a-z][a-z0-9-]*$）都不含 ':'，解析无歧义。
 */
export const PLUGIN_VIEW_KEY_PREFIX = 'plugin:'

/** 插件视图页签的复合键形态（ActivityRail 的 NavTab 插件分支同款模板字面量类型） */
export type PluginViewNavTab = `plugin:${string}:${string}`

export function makePluginViewKey(pluginId: string, viewId: string): PluginViewNavTab {
  return `${PLUGIN_VIEW_KEY_PREFIX}${pluginId}:${viewId}`
}

/** 复合键判定（类型谓词：调用点据此把保存的字符串收窄回 NavTab 插件分支） */
export function isPluginViewKey(key: string): key is PluginViewNavTab {
  return parsePluginViewKey(key) !== null
}

export function parsePluginViewKey(key: string): { pluginId: string; viewId: string } | null {
  if (typeof key !== 'string' || !key.startsWith(PLUGIN_VIEW_KEY_PREFIX)) return null
  const rest = key.slice(PLUGIN_VIEW_KEY_PREFIX.length)
  const sep = rest.indexOf(':')
  if (sep <= 0) return null
  const pluginId = rest.slice(0, sep)
  const viewId = rest.slice(sep + 1)
  // pluginId 走插件 id 同款规则（kebab），viewId 走视图 id 规则
  if (!/^[a-z0-9-]+$/.test(pluginId) || !PLUGIN_VIEW_ID_PATTERN.test(viewId)) return null
  return { pluginId, viewId }
}

// ====================== 插件 guest 资源协议（main ↔ renderer 跨端契约） ======================

/**
 * lyshell-plugin:// 自定义协议名。main 在 app.ready 前注册 privileged scheme 并
 * 在各插件 partition 上安装资源 handler；renderer 拼面板/弹窗 webview 的入口 src。
 */
export const PLUGIN_VIEW_SCHEME = 'lyshell-plugin'

/**
 * 插件 guest 专属 partition 前缀（每插件一个内存 partition）。main 的 webview
 * attach 闸按它分流，renderer 的 <webview partition> 用同名拼法 —— 两端漂移会
 * 导致 attach 闸认不出 guest。拼法只经 pluginViewPartitionName，禁止自行拼接。
 */
export const PLUGIN_VIEW_PARTITION_PREFIX = 'pluginviews:'

export function pluginViewPartitionName(pluginId: string): string {
  return `${PLUGIN_VIEW_PARTITION_PREFIX}${pluginId}`
}

/** 由视图定义 entry（views/xxx.html）构造 guest 入口 URL（renderer 挂载 webview 用） */
export function makeViewEntryUrl(pluginId: string, entry: string): string {
  const rel = entry.replace(/^views\//, '')
  return `${PLUGIN_VIEW_SCHEME}://${pluginId}/${rel}`
}

/**
 * 弹窗入口 URL：入口 + 单一一次性 dialogId 查询参数。attach 闸（main/index.ts）
 * 与协议层（view-protocol-core checkUrlSearch）都按「仅一个 dialogId 参数」识别
 * 弹窗 —— 不带查询串的入口一律按常驻面板挂载，closeDialog 会被拒。
 */
export function makeViewDialogEntryUrl(pluginId: string, entry: string, dialogId: string): string {
  return `${makeViewEntryUrl(pluginId, entry)}?dialogId=${encodeURIComponent(dialogId)}`
}

// ====================== 插件弹窗尺寸（main 校验与 renderer 挂载同一钳制） ======================

export const PLUGIN_DIALOG_MIN_SIZE = 200
export const PLUGIN_DIALOG_MAX_SIZE = 1024

/** 弹窗尺寸钳制（像素取整夹取；main 清洗与 renderer 挂载共用，防两端各说各话） */
export function clampPluginDialogSize(size: number | undefined): number | undefined {
  if (typeof size !== 'number' || !Number.isFinite(size)) return undefined
  return Math.min(PLUGIN_DIALOG_MAX_SIZE, Math.max(PLUGIN_DIALOG_MIN_SIZE, Math.round(size)))
}

/**
 * 校验单个视图定义（纯函数）。manifest 与运行时注册使用同一规则：
 * 校验字段类型、长度、扩展名和相对路径；拒绝空路径、盘符、绝对路径、`..`、
 * NUL、URL 查询串/fragment。entry 必须位于插件的 views/ 目录下。
 * 文件实际存在性与真实路径包围（symlink/junction）不在此处 —— 属安装确认后
 * 与运行时注册时的文件系统检查（见 main 侧调用方）。
 */
export function validateViewDefinition(raw: unknown): { ok: boolean; errors: string[]; view?: PluginViewDefinition } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['view definition must be an object'] }
  }
  const v = raw as Record<string, unknown>
  const errors: string[] = []

  if (typeof v.id !== 'string' || !PLUGIN_VIEW_ID_PATTERN.test(v.id) || v.id.length > 64) {
    errors.push('view.id must match ^[a-z][a-z0-9-]*$ (max 64 chars)')
  }
  if (typeof v.title !== 'string' || v.title.trim().length === 0 || v.title.length > PLUGIN_VIEW_TITLE_MAX) {
    errors.push(`view.title must be a non-empty string (max ${PLUGIN_VIEW_TITLE_MAX} chars)`)
  }
  // 路径字段通用拒绝项：查询串/fragment/NUL/不安全相对路径（含 ..、盘符、绝对路径、空）。
  // 另显式拒绝反斜杠与 % ：协议 URL 路径只认 /，定义里不允许存编码或 Windows 分隔形态。
  const rejectPath = (field: string, value: unknown): string | null => {
    if (typeof value !== 'string') {
      errors.push(`${field} must be a string if present`)
      return null
    }
    if (value.length === 0 || value.length > PLUGIN_VIEW_PATH_MAX) {
      errors.push(`${field} must be 1-${PLUGIN_VIEW_PATH_MAX} chars`)
      return null
    }
    if (value.includes('\0') || value.includes('?') || value.includes('#')) {
      errors.push(`${field} must not contain NUL, query string or fragment`)
      return null
    }
    if (value.includes('\\') || value.includes('%')) {
      errors.push(`${field} must use forward slashes only (no backslashes or percent-encoding)`)
      return null
    }
    if (isUnsafeRelativePath(value)) {
      errors.push(`${field} must be a relative path inside the plugin directory`)
      return null
    }
    return value
  }

  let entry: string | undefined
  if (typeof v.entry !== 'string') {
    errors.push('view.entry must be a string')
  } else {
    entry = rejectPath('view.entry', v.entry) ?? undefined
    if (entry !== undefined) {
      const norm = entry.replace(/\\/g, '/')
      // entry 必须位于 views/ 目录下（页面资源同目录，协议只服务该目录）
      if (!norm.startsWith('views/') || norm.split('/').some((s) => s.length === 0)) {
        errors.push('view.entry must be a .html file inside the plugin "views/" directory')
        entry = undefined
      } else if (!/\.html$/i.test(norm)) {
        errors.push('view.entry must end with .html')
        entry = undefined
      }
    }
  }

  let icon: string | undefined
  if (v.icon !== undefined) {
    icon = rejectPath('view.icon', v.icon) ?? undefined
    if (icon !== undefined && !/\.(svg|png)$/i.test(icon.replace(/\\/g, '/'))) {
      errors.push('view.icon must be a .svg or .png file')
      icon = undefined
    }
  }

  if (errors.length > 0 || entry === undefined) {
    return { ok: false, errors: errors.length > 0 ? errors : ['view.entry must be a string'] }
  }
  const view: PluginViewDefinition = { id: v.id as string, title: v.title as string, entry }
  if (icon !== undefined) view.icon = icon
  return { ok: true, errors: [], view }
}

/**
 * 校验视图定义数组（manifest contributes.views 与运行时注册共用）：
 * 最多 8 项、禁止重复 ID、逐项过 validateViewDefinition。
 */
export function validateViewDefinitionList(
  raw: unknown
): { ok: boolean; errors: string[]; views: PluginViewDefinition[] } {
  if (!Array.isArray(raw)) {
    return { ok: false, errors: ['views must be an array if present'], views: [] }
  }
  if (raw.length > PLUGIN_MAX_VIEWS) {
    return { ok: false, errors: [`at most ${PLUGIN_MAX_VIEWS} views per plugin`], views: [] }
  }
  const errors: string[] = []
  const views: PluginViewDefinition[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const r = validateViewDefinition(item)
    if (!r.ok || !r.view) {
      errors.push(...r.errors)
      continue
    }
    if (seen.has(r.view.id)) {
      errors.push(`duplicate view id: ${r.view.id}`)
      continue
    }
    seen.add(r.view.id)
    views.push(r.view)
  }
  return { ok: errors.length === 0, errors, views }
}

/** Plugin view key helpers are consumed by renderer rail & keep-alive maps (single source). */



/**
 * lyshell-plugin.json 清单结构。对齐 docs/plugin-system-design.md §6。
 */
export interface LyShellPluginManifest {
  id: string
  name: string
  version: string
  /** 引擎兼容性，如 "^1.0" */
  engines: { lyshell: string }
  /** contributor 入口（相对插件根）。consumer 插件可省略。 */
  main?: string
  /** 运行时。node 走 plugin host 子进程；python 走 engine.ts。 */
  runtime: PluginRuntime
  /**
   * 生命周期。未指定时按 runtime 取默认值：node -> persistent，python -> oneshot。
   * 与 runtime 解耦后，node 插件也可以是 oneshot，python 插件也可以是 persistent（需对应运行时支持）。
   */
  lifecycle?: PluginLifecycle
  /**
   * python oneshot 进程超时（ms）。仅 runtime='python' 且 lifecycle='oneshot' 生效；默认 120000，上限 600000。
   * python oneshot 脚本模型（main.py 运行至结束即退出），onStartup/* 指「启动跑一次」而非常驻。
   * 超时到则子进程被杀，在途 HTTP 调用因 token 撤销而 401 退出。
   */
  pythonTimeoutMs?: number
  /**
   * 延迟激活事件。空数组/缺省 = 不自动激活（纯声明式贡献）。
   * 缺省合法：零贡献、无 main 的纯声明式清单不必声明激活事件。
   */
  activationEvents?: ActivationEvent[]
  /** 声明需要的 capability；安装时由用户批准 -> grantedCapabilities。 */
  capabilities: McpCapability[]
  /** 声明式贡献（零激活即可出现在 UI）。 */
  contributes?: PluginContributes
}

/**
 * registry.json 单条安装记录。
 * 与插件文件夹分离（见 §8.2）：启用/禁用只翻转 enabled，卸载才删文件夹。
 */
export interface PluginRegistryEntry {
  id: string
  version: string
  /** 相对 {userData}/plugins/ 的子路径，或绝对路径（dev） */
  path: string
  dev: boolean
  enabled: boolean
  /** 安装时用户批准的 capability 子集（⊆ manifest.capabilities） */
  grantedCapabilities: McpCapability[]
  /** ISO 时间戳 */
  installedAt: string
  source: PluginSource
}

/**
 * main -> plugin host 子进程的 per-plugin 描述。
 * 经 env LYSHELL_PLUGIN_SPECS(JSON 数组)传递给 host 子进程。
 */
export interface PluginSpec {
  pluginId: string
  /** bindPluginToken 颁发的 plugin token;鉴权按 pluginId 路由到 grantedCapabilities */
  token: string
  /** 用户批准的 capability 子集(api call 的前置 gate 用) */
  grantedCapabilities: McpCapability[]
  /** lyshell-plugin.json 绝对路径 */
  manifestPath: string
  /** 插件根目录绝对路径 */
  pluginDir: string
  /** contributor 入口相对路径;consumer 插件省略 */
  main?: string
  runtime: PluginRuntime
  /** 归一化后的生命周期（host 按此路由） */
  lifecycle: PluginLifecycle
}

/** manifest 校验结果 */
export interface ManifestValidation {
  ok: boolean
  errors: string[]
  manifest?: LyShellPluginManifest
}

/**
 * plugin:list 返回的列表项:registry 记录 + manifest 展示字段。
 * manifest 读失败时展示字段降级(name=id、runtime='node'、capabilities=grantedCapabilities)。
 */
export interface PluginListItem extends PluginRegistryEntry {
  /** manifest.name(manifest 读失败降级为 id) */
  name: string
  /** manifest 运行时(manifest 读失败为 'node') */
  runtime: PluginRuntime
  /** manifest 生命周期(manifest 读失败按 runtime 取默认值) */
  lifecycle: PluginLifecycle
  /** contributor 入口(相对插件根);consumer 插件无 */
  main?: string
  /** manifest 声明的激活事件 */
  activationEvents: ActivationEvent[]
  /** manifest 声明的全部 capability(grantedCapabilities 是其经用户批准的子集) */
  capabilities: McpCapability[]
  /**
   * 贡献的界面视图（来自 view-registry，manifest + 运行时合并）。
   * 禁用插件返回空数组，避免误入轨道；管理卡展示禁用前声明时另用展示字段。
   */
  views: PluginViewMeta[]
}

/**
 * plugin:install-dev 请求。path 为本地插件文件夹绝对路径(dev 插件,不复制)。
 * 详见 docs/plugin-system-design.md §8.1(dev 插件)+ §8.3(安装流程)。
 */
export interface PluginInstallDevRequest {
  path: string
  /** 用户批准的 capability;服务端强制取 ∩ manifest.capabilities,防 renderer 传入未声明 capability 越权 */
  grantedCapabilities?: McpCapability[]
  /** 安装即启用;默认 false(§8.3 enabled 默认 false,按 activationEvents 延迟激活) */
  enabled?: boolean
}

/** plugin:pick-folder 结果:选目录 -> 读 manifest -> 校验。取消/失败 success=false。 */
export interface PluginPickResult {
  success: boolean
  /** 选中的文件夹绝对路径(success=true 时有) */
  path?: string
  /** 解析出的 manifest(success=true 时有) */
  manifest?: LyShellPluginManifest
  /** 失败/取消原因(success=false 时有) */
  error?: string
}

/**
 * plugin:pick-file 结果:选 .lyshell-plugin/.zip -> 读**根** manifest(不解压)-> 校验。
 * 形态与 PluginPickResult 一致(path 为 zip 文件绝对路径);复用同构便于 UI 复用权限确认卡。
 * 取消/失败 success=false。
 */
export interface PluginPickFileResult {
  success: boolean
  /** 选中的 zip 文件绝对路径(success=true 时有) */
  path?: string
  /** 从 zip 根 lyshell-plugin.json 解析出的 manifest(success=true 时有) */
  manifest?: LyShellPluginManifest
  /** 失败/取消原因(success=false 时有) */
  error?: string
}

/** plugin:fetch-url 请求:下载 URL -> 读 manifest 预览(不解压到插件目录)。 */
export interface PluginFetchUrlRequest {
  url: string
}

/**
 * plugin:fetch-url 结果:下载到临时文件 -> 读**根** manifest -> 校验。
 * path 为临时下载文件绝对路径(由 main 持有,install-zip 时消费,取消/退出时清理)。
 * 取消/失败 success=false。
 */
export interface PluginFetchUrlResult {
  success: boolean
  /** 临时下载文件绝对路径(success=true 时有;install-zip 消费后由 main 删除) */
  path?: string
  /** 从 zip 根 lyshell-plugin.json 解析出的 manifest(success=true 时有) */
  manifest?: LyShellPluginManifest
  /** 失败/取消原因(success=false 时有) */
  error?: string
}

/**
 * plugin:install-zip 请求。把 zip(path)解压到 {userData}/plugins/{id}/。
 * path 为 pick-file 选中文件或 fetch-url 临时下载文件;source 仅区分 registry 记录与审计。
 * 详见 docs/plugin-system-design.md §8.3(zip/URL 安装)+ §8.4(卸载三步撤销)。
 */
export interface PluginInstallZipRequest {
  /** zip 文件绝对路径(pick-file 选中或 fetch-url 临时下载) */
  path: string
  /** 安装来源:local-file(pick-file)/ url(fetch-url)。仅写 registry.source + 审计,不影响解压 */
  source: 'local-file' | 'url'
  /** 用户批准的 capability;服务端强制取 ∩ manifest.capabilities,防 renderer 传入未声明 capability 越权 */
  grantedCapabilities?: McpCapability[]
  /** 安装即启用;默认 false(§8.3 enabled 默认 false,按 activationEvents 延迟激活) */
  enabled?: boolean
}

const VALID_CAPABILITIES: ReadonlySet<string> = new Set<McpCapability>([
  'read',
  'interactiveWrite',
  'execute',
  'localExecute',
  'fileWrite',
  'sessionControl',
  'sessionMetadataWrite',
  // 插件界面视图专用：控制视图/UI 动作（含运行时视图注册），不作为 MCP 工具暴露
  'uiControl'
])

const VALID_RUNTIMES: ReadonlySet<string> = new Set(['node', 'python'])

const VALID_LIFECYCLES: ReadonlySet<string> = new Set(['oneshot', 'persistent'])

/** 按 runtime 取默认生命周期。node 默认长期运行，python 默认单次运行。 */
export function getDefaultLifecycle(runtime: PluginRuntime): PluginLifecycle {
  return runtime === 'python' ? 'oneshot' : 'persistent'
}

/** 归一化生命周期：显式值优先，缺失时按 runtime 取默认值。 */
export function normalizeLifecycle(
  runtime: PluginRuntime,
  lifecycle?: PluginLifecycle
): PluginLifecycle {
  return lifecycle ?? getDefaultLifecycle(runtime)
}

/**
 * 旧版 Python manifest 未声明 lifecycle 时，保持「LyShell 启动时运行一次」的兼容行为。
 * 显式 lifecycle='oneshot' 属新语义：仅用户手动「运行」，不随启动自跑。
 */
export function isLegacyPythonStartup(runtime: PluginRuntime, lifecycle?: PluginLifecycle): boolean {
  return runtime === 'python' && lifecycle === undefined
}

/**
 * activationEvents 含 onStartup 或 * -> host 启动即激活。
 * 空数组或仅 onCommand/onConnectionType -> 不自动激活（纯声明式贡献 / 待事件触发）。
 * Node 与 Python persistent 共用此判定，确保两者对 activationEvents 语义一致。
 */
export function shouldActivateOnStartup(events: ActivationEvent[]): boolean {
  return events.includes('onStartup') || events.includes('*')
}

function isValidActivationEvent(e: unknown): boolean {
  if (typeof e !== 'string') return false
  return e === 'onStartup' || e === '*' || e.startsWith('onCommand:') || e.startsWith('onConnectionType:')
}

/**
 * 校验原始 manifest 对象。安装流程（§8.3）的第一道闸门。
 *
 * engines.lyshell 版本兼容解析不在此做（需 app 版本，且 §12 把完整版本化列为后续）--
 * 安装时由 handlers.ts 调本文件导出的 checkEngines 做 warn-only 检查（不兼容不阻断，仅告警 + 回显）。
 * TODO(§12)：升级为硬拒 + prerelease/build 解析 + deprecation 机制。
 */
export function validateManifest(raw: unknown): ManifestValidation {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, errors: ['manifest must be a JSON object'] }
  }
  const m = raw as Record<string, unknown>
  const errors: string[] = []

  if (typeof m.id !== 'string' || !/^[a-z0-9-]+$/.test(m.id)) {
    errors.push('id must be a lowercase kebab-case string (a-z0-9-)')
  }
  if (typeof m.name !== 'string' || m.name.length === 0) {
    errors.push('name must be a non-empty string')
  }
  if (typeof m.version !== 'string' || !/^\d+\.\d+\.\d+/.test(m.version)) {
    errors.push('version must be semver-like (x.y.z)')
  }
  if (
    typeof m.engines !== 'object' ||
    m.engines === null ||
    typeof (m.engines as Record<string, unknown>).lyshell !== 'string'
  ) {
    errors.push('engines.lyshell must be a string (e.g. "^1.0")')
  }
  if (typeof m.runtime !== 'string' || !VALID_RUNTIMES.has(m.runtime)) {
    errors.push('runtime must be "node" or "python"')
  }
  if (m.lifecycle !== undefined && (typeof m.lifecycle !== 'string' || !VALID_LIFECYCLES.has(m.lifecycle))) {
    errors.push('lifecycle must be "oneshot" or "persistent"')
  }
  if (m.pythonTimeoutMs !== undefined) {
    const t = m.pythonTimeoutMs
    if (typeof t !== 'number' || !Number.isFinite(t) || !Number.isInteger(t) || t < 1000 || t > 600000) {
      errors.push('pythonTimeoutMs must be an integer between 1000 and 600000 (ms)')
    }
  }
  // activationEvents 缺省合法（纯声明式清单无需声明）；给了就必须是合法事件数组
  if (m.activationEvents !== undefined) {
    if (!Array.isArray(m.activationEvents)) {
      errors.push('activationEvents must be an array')
    } else {
      for (const e of m.activationEvents) {
        if (!isValidActivationEvent(e)) {
          errors.push(`invalid activationEvent: ${String(e)}`)
          break
        }
      }
    }
  }
  if (!Array.isArray(m.capabilities)) {
    errors.push('capabilities must be an array')
  } else {
    for (const c of m.capabilities) {
      if (typeof c !== 'string' || !VALID_CAPABILITIES.has(c)) {
        errors.push(`invalid capability: ${String(c)}`)
        break
      }
    }
  }
  if (m.main !== undefined && typeof m.main !== 'string') {
    errors.push('main must be a string if present')
  } else if (typeof m.main === 'string' && m.main.length > 0 && isUnsafeRelativePath(m.main)) {
    // 入口路径包围(评审 containment):禁 .. 段/绝对路径/盘符,防 main 指向插件目录外绕过 zip-slip 包围。
    // 空 main 不拒(host 视为 consumer 无入口);仅非空 main 校验。
    errors.push('main must be a relative path inside the plugin directory (no "..", absolute paths, or drive letters)')
  }
  if (m.contributes !== undefined && (typeof m.contributes !== 'object' || m.contributes === null)) {
    errors.push('contributes must be an object if present')
  } else if (m.contributes !== undefined) {
    // contributes.views：声明式界面视图，走与运行时注册同一校验器（最多 8 项、
    // 禁重复 ID、entry 限 views/ 下 .html）。文件存在性与真实路径包围在
    // 安装确认/运行时注册时由 main 侧文件系统检查补齐。
    const contributes = m.contributes as Record<string, unknown>
    if (contributes.views !== undefined) {
      const vr = validateViewDefinitionList(contributes.views)
      if (!vr.ok) errors.push(...vr.errors)
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, errors: [], manifest: m as unknown as LyShellPluginManifest }
}

// ====================== engines.lyshell 版本兼容（warn-only） ======================
//
// 安装流程（§8.3）的 engines 版本兼容检查。当前为告警而非硬拒（§12 把完整版本化列为后续）：
// 调用方据此 log.warn + 回显给用户，不阻断安装。支持常见 range 语法，不实现完整 semver 规范
// （prerelease/build 等）—— 无法解析时返回 { ok: false, warning }，同样不阻断。

/** 解析版本字面量 "1.2.3" -> { v:[1,2,3], wild:[false,false,false] }。x、X、* 与空缺位记为通配。 */
function parseVersionTuple(rest: string): { v: number[]; wild: boolean[] } | null {
  const parts = rest.split('.')
  const wild: boolean[] = []
  const nums: number[] = []
  for (let i = 0; i < 3; i++) {
    const p = (parts[i] ?? '').trim()
    if (p === 'x' || p === 'X' || p === '*' || p === '') {
      wild.push(true)
      nums.push(0)
    } else {
      const n = Number.parseInt(p, 10)
      if (!Number.isFinite(n) || n < 0) return null
      wild.push(false)
      nums.push(n)
    }
  }
  return { v: nums, wild }
}

function compareParts(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return 0
}

type BoundOp = '>=' | '<' | '>' | '<=' | '='
interface Bound {
  op: BoundOp
  v: number[]
}

/**
 * 把单个 comparator（如 `^1.2`、`>=1.0`、`1.x`、`*`）展开为 >= / < 上下界原语。
 * 返回 null 表示无法解析；空数组表示无约束（`*` / 空）。
 */
function expandComparator(token: string): Bound[] | null {
  const t = token.trim()
  if (t === '' || t === '*') return []
  const m = t.match(/^(\^|~|>=|<=|>|<|=)?\s*(.+)$/)
  if (!m) return null
  const op = (m[1] ?? '=') as '^' | '~' | BoundOp
  const parsed = parseVersionTuple(m[2].trim())
  if (!parsed) return null
  const { v, wild } = parsed
  // w1 = minor 位通配(如 1.x),w2 = patch 位通配(如 1.2.x);major 位通配无意义(版本必含 major)
  const [, w1, w2] = wild

  if (op === '^') {
    // ^M.m.p：M>0 -> <(M+1).0.0；M=0 且 m>0 -> <0.(m+1).0；M=m=0 -> <0.0.(p+1)
    const lower: Bound = { op: '>=', v }
    let upper: number[]
    if (v[0] !== 0) upper = [v[0] + 1, 0, 0]
    else if (v[1] !== 0) upper = [0, v[1] + 1, 0]
    else upper = [0, 0, v[2] + 1]
    return [lower, { op: '<', v: upper }]
  }
  if (op === '~') {
    // ~1.2.3 / ~1.2 -> <1.(minor+1).0；~1 -> <(major+1).0.0（minor 缺位才算）
    const lower: Bound = { op: '>=', v }
    const upper = w1 ? [v[0] + 1, 0, 0] : [v[0], v[1] + 1, 0]
    return [lower, { op: '<', v: upper }]
  }
  if (op === '=') {
    // 通配：1.x -> >=1.0.0 <2.0.0；1.2.x -> >=1.2.0 <1.3.0
    if (w1) return [{ op: '>=', v: [v[0], 0, 0] }, { op: '<', v: [v[0] + 1, 0, 0] }]
    if (w2) return [{ op: '>=', v: [v[0], v[1], 0] }, { op: '<', v: [v[0], v[1] + 1, 0] }]
    return [{ op: '=', v }]
  }
  // 范围算子 + 通配：通配位归零
  if (w1) return [{ op, v: [v[0], 0, 0] }]
  if (w2) return [{ op, v: [v[0], v[1], 0] }]
  return [{ op, v }]
}

function satisfiesBound(app: number[], b: Bound): boolean {
  const c = compareParts(app, b.v)
  switch (b.op) {
    case '>=':
      return c >= 0
    case '<':
      return c < 0
    case '>':
      return c > 0
    case '<=':
      return c <= 0
    case '=':
      return c === 0
  }
}

/**
 * engines.lyshell 兼容性检查（warn-only，不阻断安装）。
 *
 * 支持 range 语法：`^1.0` `~1.2` `>=1.0` `>1.0` `<2.0` `<=1.9` `=1.2.3` `1.x` `1.2.x` `*`，
 * 空格分隔为 AND（同组全满足）、`||` 分隔为 OR（任一组满足）。不实现 prerelease/build（§12 后续）。
 *
 * 返回 { ok: true } 兼容；{ ok: false, warning } 不兼容或无法解析 —— 调用方 log.warn + 回显，
 * 不阻断安装（与 §8.3「engines 版本兼容」校验项对齐，当前为告警而非硬拒）。
 */
export function checkEngines(enginesLyshell: string, appVersion: string): { ok: boolean; warning?: string } {
  const app = parseVersionTuple(appVersion)
  if (!app) {
    return { ok: false, warning: `无法解析当前 LyShell 版本 "${appVersion}"，已跳过 engines.lyshell 兼容检查` }
  }
  const range = (enginesLyshell ?? '').trim()
  if (range === '' || range === '*') return { ok: true }

  const groups = range.split('||').map((g) => g.trim()).filter((g) => g.length > 0)
  if (groups.length === 0) return { ok: true }

  for (const group of groups) {
    const tokens = group.split(/\s+/).filter((t) => t.length > 0)
    const bounds: Bound[] = []
    let hasConstraint = false
    for (const tok of tokens) {
      const expanded = expandComparator(tok)
      if (expanded === null) {
        return { ok: false, warning: `无法解析 engines.lyshell "${range}"，已跳过兼容检查` }
      }
      if (expanded.length > 0) {
        hasConstraint = true
        bounds.push(...expanded)
      }
    }
    if (!hasConstraint) return { ok: true } // 整组为 `*`：无约束
    if (bounds.every((b) => satisfiesBound(app.v, b))) return { ok: true }
  }
  return {
    ok: false,
    warning: `engines.lyshell "${enginesLyshell}" 与当前 LyShell 版本 ${appVersion} 不兼容（插件可能无法正常工作）`
  }
}

/**
 * 判定相对路径是否"不安全"(可逃逸出基目录):空、含 NUL、绝对路径(/开头)、Windows 盘符(X:)、.. 段。
 * 共享给 validateManifest(校验 manifest.main,防 entry point 指向插件目录外绕过 zip-slip 包围)
 * 与 install-zip 的 assertSafeEntryName(zip 条目名)。归一化反斜杠;空串视为不安全。
 */
export function isUnsafeRelativePath(name: string): boolean {
  if (typeof name !== 'string') return true
  const n = name.replace(/\\/g, '/')
  if (n === '' || n.includes('\0')) return true
  if (n.startsWith('/') || /^[a-zA-Z]:/.test(n)) return true
  if (n.split('/').some((s) => s === '..')) return true
  return false
}
