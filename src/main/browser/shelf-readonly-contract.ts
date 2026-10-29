import type { Session, WebContents, WebPreferences } from 'electron'

/**
 * 只读 webview 契约（可丢弃的只读网页模式）。
 *
 * 设计约束：
 * - 本模块只依赖 Electron 的 **类型**，全部行为通过入参注入，因此可以在纯 Node 环境
 *   （vitest）下完整测试；运行时绝不 import electron 的 `session`/`app`。
 * - 只操作调用方显式传入的 Session，不产生任何全局副作用。
 * - 只读模式使用**内存态**专用分区：不写磁盘、不继承历史 SW / CacheStorage / IndexedDB，
 *   进程退出即丢弃，因此“可丢弃”由分区本身保证，而不是靠运行时清理。
 * - 任何校验失败一律 fail closed（拒绝 / blocked / unknown），绝不采信网页自报的“安全”状态。
 */

/**
 * 只读 webview 专用隔离分区：内存态（非 `persist:`），应用退出即随进程丢弃。
 * 不使用 `persist:shelf-readonly-v1`：持久分区会把上一次运行的 Service Worker、
 * CacheStorage、IndexedDB 带到下一次，与“显式可丢弃”的目标冲突。
 */
export const READONLY_PARTITION = 'shelf-readonly-v1'
export const isReadonlyPartition = (value: unknown): boolean => typeof value === 'string' && (value === READONLY_PARTITION || /^shelf-readonly-v1:[a-f0-9-]{36}$/.test(value))

/** 资源生命周期里登记的 provider 标识（`-v1` 为只读契约版本，随契约升级而升级）。 */
export const READONLY_PROVIDER = 'app:readonly-v1'

/** 只读链路使用的 IPC 通道（preload 侧为独立 bundle，字符串保持一致）。 */
export const READONLY_CHANNELS = {
  attach: 'shelf-browser:attach',
  blocked: 'shelf-browser:readonly-blocked',
  scrollCommand: 'shelf-browser:scroll',
  scrollTelemetry: 'shelf-browser:readonly-scroll',
} as const

/** 保护判定：safe 仅表示“契约已核实且当前没有已知风险”，绝不是网页自报的结论。 */
export type ReadonlyProtectionDecision = 'safe' | 'blocked' | 'unknown'

/**
 * 只读保护原因码。与生命周期模块的 `BlockReason` 是**不同的集合**：
 * 后者描述“网页侧阻止销毁的原因”，这里是主进程原生状态检查结果。
 * 若要并入 `reportProtection`，需要先扩展其 `BlockReason` / `BLOCK_REASON_KEYS`。
 */
export type ReadonlyBlockReason =
  | 'contract-unverified'
  | 'preferences-missing'
  | 'devtools-open'
  | 'page-loading'
  | 'page-audible'
  | 'renderer-crashed'
  | 'guest-destroyed'
  | 'inspection-failed'

export interface ReadonlyProtection {
  readonly decision: ReadonlyProtectionDecision
  readonly reasonCodes: ReadonlyBlockReason[]
}

/** preload 只允许上报“被阻断”信号；主进程始终以 event.sender 身份为准。 */
export type ReadonlyBlockedKind = 'input' | 'change' | 'init-failed'

// ---------------------------------------------------------------------------
// 请求闸门
// ---------------------------------------------------------------------------

export type ReadonlyRequestReason =
  | 'method'
  | 'resource-type'
  | 'scheme'
  | 'credentials'
  | 'query-sensitive'
  | 'hash-sensitive'
  | 'malformed-url'

export interface ReadonlyRequestCheck {
  readonly url: string
  readonly method: string
  readonly resourceType: string
}

export interface ReadonlyRequestDecision {
  readonly allowed: boolean
  readonly reason?: ReadonlyRequestReason
}

/** 只放行文档骨架类资源；脚本 / 连接 / 媒体 / 子框架 / 对象一律拒绝。 */
const ALLOWED_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  'mainFrame',
  'stylesheet',
  'image',
  'font',
])

/**
 * 纯函数请求闸门：只允许 http(s)、GET、mainFrame/stylesheet/image/font，
 * 且 mainFrame 不得携带凭据或任何 query/hash。
 */
export function classifyReadonlyRequest(check: ReadonlyRequestCheck): ReadonlyRequestDecision {
  if (check.method !== 'GET') return { allowed: false, reason: 'method' }
  if (!ALLOWED_RESOURCE_TYPES.has(check.resourceType)) {
    return { allowed: false, reason: 'resource-type' }
  }

  let parsed: URL
  try {
    parsed = new URL(check.url)
  } catch {
    return { allowed: false, reason: 'malformed-url' }
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { allowed: false, reason: 'scheme' }
  }
  // 所有被拦截的请求都不允许 URL 内嵌凭据（UserInfo），比只查 mainFrame 更严格。
  if (parsed.username !== '' || parsed.password !== '') {
    return { allowed: false, reason: 'credentials' }
  }
  if (check.resourceType === 'mainFrame') {
    if (parsed.search) {
      return { allowed: false, reason: 'query-sensitive' }
    }
    if (parsed.hash) {
      return { allowed: false, reason: 'hash-sensitive' }
    }
  }
  return { allowed: true }
}

// ---------------------------------------------------------------------------
// 响应头加固
// ---------------------------------------------------------------------------

/**
 * 独立追加的第二条 CSP：与站点自身 CSP 并存（浏览器对多条 CSP 取交集），
 * 因此绝不删除 / 拼接站点已有策略。script-src 禁止页面脚本；sandbox 的
 * allow-scripts 保留应用隔离 preload。其他指令禁止表单、子框架、worker、连接与媒体。
 */
export const READONLY_CSP =
  "sandbox allow-same-origin allow-scripts; script-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; connect-src 'none'; media-src 'none'; form-action 'none'; base-uri 'none'"

export const READONLY_PERMISSIONS_POLICY =
  'camera=(), microphone=(), geolocation=(), display-capture=()'

const CSP_HEADER = 'content-security-policy'
const PERMISSIONS_POLICY_HEADER = 'permissions-policy'

export type ResponseHeaders = Record<string, string | string[]>

function appendHeader(headers: ResponseHeaders, name: string, value: string): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== name) continue
    const current = headers[key]
    const values = Array.isArray(current) ? current.slice() : typeof current === 'string' ? [current] : []
    values.push(value)
    headers[key] = values
    return
  }
  headers[name] = [value]
}

/**
 * 为任意响应追加只读 CSP 与 Permissions-Policy。
 * 站点原有同名头原样保留（仅在其后追加一条独立的值），未提供响应头时新建对象。
 */
export function withReadonlyHeaders(headers: ResponseHeaders | undefined): ResponseHeaders {
  const next: ResponseHeaders = headers ? { ...headers } : {}
  appendHeader(next, CSP_HEADER, READONLY_CSP)
  appendHeader(next, PERMISSIONS_POLICY_HEADER, READONLY_PERMISSIONS_POLICY)
  return next
}

// ---------------------------------------------------------------------------
// 会话初始化（请求闸门 + 权限 + 下载）
// ---------------------------------------------------------------------------

const initializedSessions = new WeakSet<Session>()

const DOWNLOAD_EVENT = 'will-download'

export function hasReadonlySession(ses: Session): boolean {
  return initializedSessions.has(ses)
}

/**
 * 在专用隔离分区上安装只读闸门：每个 Session 只安装一次（WeakSet 去重），
 * 不触碰 app、默认 session 或其他分区，因此没有全局副作用。
 *
 * 注意：必须传入一次性（非持久化）分区，例如 `session.fromPartition(READONLY_PARTITION)`；
 * 传持久化分区会直接抛错，避免把只读闸门装到共享分区上。
 */
export function initializeReadonlySession(ses: Session): void {
  if (!ses || !ses.webRequest) {
    throw new TypeError('initializeReadonlySession 需要有效的 Electron.Session')
  }
  if (initializedSessions.has(ses)) return
  if (typeof ses.isPersistent === 'function' && ses.isPersistent()) {
    throw new Error(
      `initializeReadonlySession 只接受一次性隔离分区（${READONLY_PARTITION}），拒绝持久化分区`
    )
  }

  ses.webRequest.onBeforeRequest((details, callback) => {
    const decision = classifyReadonlyRequest({
      url: details.url,
      method: details.method,
      resourceType: details.resourceType,
    })
    callback(decision.allowed ? {} : { cancel: true })
  })

  ses.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType === 'mainFrame' && details.statusCode >= 200 && details.statusCode < 300) {
      const header = Object.entries(details.responseHeaders ?? {}).find(([name]) => name.toLowerCase() === 'content-type')?.[1]
      const mime = (Array.isArray(header) ? header[0] : header ?? '').split(';')[0].trim().toLowerCase()
      // PDF/媒体/内置查看器不是本契约，不能因 GET 文档也被放行。
      if (!['text/html', 'text/plain', 'application/xhtml+xml'].includes(mime)) { callback({ cancel: true }); return }
    }
    callback({ responseHeaders: withReadonlyHeaders(details.responseHeaders) })
  })

  // 全部权限一律拒绝：通知、摄像头、麦克风、地理位置、剪贴板、全屏、MIME 等。
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
  ses.setPermissionCheckHandler(() => false)
  ses.setDevicePermissionHandler(() => false)
  ses.setDisplayMediaRequestHandler((_request, callback) => {
    callback({})
  })
  ses.setSpellCheckerEnabled(false)

  // 只读模式绝不产生下载。
  ses.on(DOWNLOAD_EVENT, (event: { preventDefault: () => void }) => {
    event.preventDefault()
  })
  initializedSessions.add(ses)
}

// ---------------------------------------------------------------------------
// WebPreferences 加固
// ---------------------------------------------------------------------------

/**
 * 强制只读 webview 的 WebPreferences。保留调用方已经设置的 preload /
 * additionalArguments 等字段（只覆盖安全相关键），因此可以在
 * `will-attach-webview` 里安全地二次加固。
 */
export function applyReadonlyPreferences(preferences: WebPreferences): void {
  // Electron 43 的 javascript:false / sandbox 无 allow-scripts 会同时阻断隔离 preload。
  // 页面脚本由专用分区响应头 script-src 'none' 强制禁止；允许应用隔离世界运行。
  preferences.javascript = true
  preferences.plugins = false
  preferences.disableDialogs = true
  preferences.spellcheck = false
  preferences.sandbox = true
  preferences.contextIsolation = true
  preferences.nodeIntegration = false
  preferences.nodeIntegrationInSubFrames = false
  preferences.nodeIntegrationInWorker = false
  preferences.webviewTag = false
  preferences.webSecurity = true
  preferences.allowRunningInsecureContent = false
  preferences.navigateOnDragDrop = false
  preferences.experimentalFeatures = false
  if (!isReadonlyPartition(preferences.partition)) preferences.partition = READONLY_PARTITION
}

interface ReadonlyGuestPreferences {
  partition?: unknown
  javascript?: unknown
  sandbox?: unknown
  contextIsolation?: unknown
  nodeIntegration?: unknown
  nodeIntegrationInSubFrames?: unknown
  webviewTag?: unknown
}

type PreferencesCapableGuest = WebContents & {
  getLastWebPreferences?: () => unknown
}

function readLastPreferences(guest: WebContents): ReadonlyGuestPreferences | null {
  const candidate = guest as PreferencesCapableGuest
  if (typeof candidate.getLastWebPreferences !== 'function') return null
  try {
    const value = candidate.getLastWebPreferences()
    return value && typeof value === 'object' ? (value as ReadonlyGuestPreferences) : null
  } catch {
    return null
  }
}

function preferencesAreReadonly(preferences: ReadonlyGuestPreferences): boolean {
  // partition 允许缺失（身份已由 Session 对象核实），但一旦存在就必须完全一致。
  if (typeof preferences.partition === 'string' && !isReadonlyPartition(preferences.partition)) {
    return false
  }
  return (
    preferences.javascript === true &&
    preferences.sandbox === true &&
    preferences.contextIsolation === true &&
    preferences.nodeIntegration === false &&
    preferences.nodeIntegrationInSubFrames !== true &&
    preferences.webviewTag !== true
  )
}

/**
 * 校验 guest 是否真的处于“已初始化的只读分区 + 只读 WebPreferences”中。
 * Session 对象必须在 WeakSet 内：单纯比对分区字符串无法证明请求闸门 / 响应头
 * 已经安装，因此这里用身份比对，任何异常都返回 false（fail closed）。
 */
export function isReadonlyGuest(guest: WebContents): boolean {
  if (!guest || guest.isDestroyed()) return false
  const session = guest.session
  if (!session || !initializedSessions.has(session)) return false
  const preferences = readLastPreferences(guest)
  return preferences !== null && preferencesAreReadonly(preferences)
}

/**
 * 同步检查原生状态，得出只读保护结论。只采信主进程原生条件 + 契约校验，
 * 不执行网页脚本、也不接受网页上报的任何“安全”声明。
 *
 * 语义：
 * - `unknown`：webContents 已销毁或原生探针抛错，无法判定（调用方不得当作 safe）；
 * - `blocked`：契约未核实，或存在 devtools / 加载中 / 发声 / 渲染进程崩溃等风险；
 * - `safe`：只有契约核实通过且上述原生条件全部干净时才返回。
 */
export function readonlyProtection(guest: WebContents): ReadonlyProtection {
  if (!guest || guest.isDestroyed()) {
    return { decision: 'unknown', reasonCodes: ['guest-destroyed'] }
  }

  const reasonCodes: ReadonlyBlockReason[] = []
  try {
    const session = guest.session
    const preferences = readLastPreferences(guest)
    if (!session || !initializedSessions.has(session)) {
      reasonCodes.push('contract-unverified')
    } else if (preferences === null) {
      reasonCodes.push('preferences-missing')
    } else if (!preferencesAreReadonly(preferences)) {
      reasonCodes.push('contract-unverified')
    }

    if (guest.isDevToolsOpened() || guest.debugger?.isAttached()) reasonCodes.push('devtools-open')
    // 用 mainFrame 的加载状态而不是 isLoading()：子资源懒加载不应让文档长期“加载中”。
    if (guest.isLoadingMainFrame()) reasonCodes.push('page-loading')
    if (guest.isCurrentlyAudible()) reasonCodes.push('page-audible')
    if (guest.isCrashed()) reasonCodes.push('renderer-crashed')
  } catch {
    return {
      decision: 'unknown',
      reasonCodes: [...reasonCodes, 'inspection-failed'],
    }
  }

  return {
    decision: reasonCodes.length === 0 ? 'safe' : 'blocked',
    reasonCodes,
  }
}
