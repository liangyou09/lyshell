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
}

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
  /** 延迟激活事件。空数组 = 不自动激活（纯声明式贡献）。 */
  activationEvents: ActivationEvent[]
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
  'sessionMetadataWrite'
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
