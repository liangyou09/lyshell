import { app, BrowserWindow, ipcMain, dialog, shell, screen, session, webContents } from 'electron'
import { join, resolve, isAbsolute } from 'path'
import log from 'electron-log'
import * as fs from 'fs'
import { randomUUID } from 'crypto'

// 必须是首个本地 import：dev userData 分离要在任何 getPath('userData') 之前生效，
// 挪后静默失效。播种本身不在 import 期跑，见下方 seedDevConfigFromProd 调用点
import { seedDevConfigFromProd } from './dev-user-data'

// 导入模块
import { registerIPCHandlers } from './ipc/handlers'
import { validateWebTabPostLoadRequest } from './ipc/validation'
import { downloadHistory } from './storage'
import { preferencesRepository } from './storage/repository'
import { sessionManager } from './terminal/session-manager'
import { setMainWindow, setMainWindowForUpload, cleanupAllWorkers, cleanupAllUploadWorkers } from './file'
import { reachabilityProber } from './reachability/reachability-prober'
import { mcpAuditRepository } from './storage/mcp-audit-repository'
import { pluginHostManager } from './plugin/host-mgr'
import { cleanupDownloadsDir } from './plugin/install-zip'
import { pluginRepository, getPluginsDir } from './storage/plugin-repository'
import {
  registerPluginViewSchemePrivileged,
  installProtocolHandlersForEnabledPlugins,
  pluginViewPartition,
  PLUGIN_VIEW_SCHEME
} from './plugin/view-protocol'
import { PLUGIN_VIEW_PARTITION_PREFIX } from './plugin/view-protocol-core'
import { initPluginViewRegistry, getPluginViewRegistry } from './plugin/view-registry'
import { refreshAllPluginUiTokens } from './plugin/view-tokens'
import { handlePluginGuestDestroyed, handlePluginViewWindowClosed, pluginDialogManager } from './plugin/view-bridge'
import { pluginGuestRegistry } from './plugin/view-guests'
import { validateManifest } from '@shared/plugin-types'
import { dshWebManager } from './dsh/web'
import { KILL_STEP_TIMEOUT_FLOOR_MS, sweepOrphanDshWeb } from './dsh/proc'
import { IPC_CHANNELS, WEBBAR_DEEPLINK_SCHEMES, WEBBAR_PARTITION } from '@shared/constants'
import { matchWebTabShortcut } from '@shared/webtab-shortcut'
import { createLogTap } from '@shared/log-throttle'
import { decideWebviewFrameNavigation, gateWebviewSubframeNavigation } from './webview-frame-navigation'
import { PendingWebbarPostStore, webbarPostLoadOptions, webbarPostRawBytesWithinLimit } from './webbar-post'

// 日志配置
log.transports.file.level = 'info'
log.transports.console.level = 'debug'

// 插件视图 lyshell-plugin:// 的 privileged scheme 登记 —— 必须在 app ready 之前
// （standard/secure/supportFetchAPI/stream 特权仅 ready 前注册生效）
registerPluginViewSchemePrivileged()

// 开发环境标志（app.isPackaged 在 app.ready 前即可同步读取，供早期错误处理使用）
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

// 全局错误处理 - 避免SSH超时等错误弹出对话框
process.on('uncaughtException', (error) => {
  // SSH 认证失败 / handshake timeout / PTY pipe 断裂 等连接相关错误，只记录日志不弹出
  const msg = error.message || error.toString()
  if (msg.includes('handshake') || msg.includes('SSH') || msg.includes('connection') || msg.includes('timeout')
      || msg.includes('EPIPE') || msg.includes('EOF') || msg.includes('ECONNRESET')
      || msg.includes('authentication')) {
    log.error('Connection/PTY/SSH auth error (suppressed dialog):', msg)
    return
  }
  // 其他错误：开发环境下快速失败（崩溃退出）以暴露 bug；生产环境只记日志避免影响用户
  log.error('Uncaught exception:', error)
  if (isDev) {
    process.exit(1)
  }
})

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection:', reason)
  // 开发环境下快速失败，避免 Promise 异常被静默吞掉
  if (isDev) {
    process.exit(1)
  }
})

let mainWindow: BrowserWindow | null = null
let stopMcpHttpServerImpl: (() => Promise<void>) | undefined

// 网页访问栏 webview 的会话 partition（插件面板 URL 栏打开的通用网页，完整页签
// 与写轮眼小窗共用）。与 dsh web（persist:dshweb）隔离：通用浏览可保留自己的
// cookie/登录态，互不污染。小窗与完整页签同 partition —— cookie/localStorage
// 同仓，登录态互通（页签里登过小窗即登录态，反之亦然；旧 persist:webbar-mini
// 仓里已登录的站点带不过来，需重登一次）。

// 写轮眼小窗（左列 Web 面板栏底迷你浏览器）的 webContentsId —— 小窗并入 webbar
// partition 后 session 身份不再能区分小窗与完整页签，而 webbar 挂的快捷键转发
// 一律指向「活动完整页签」，小窗若同样被转发会出现「焦点在小窗内按 Ctrl+R 却
// 刷新了别的页签」的错位。渲染层在小窗 dom-ready 后经 WEBBAR_REGISTER_MINI 把
// webContentsId 报上来（getWebContentsId 等 webview 方法面 dom-ready 前一律抛错，
// 登记只能在那时），before-input-event 转发在事件拍核对这份登记、跳过小窗 ——
// 页面级按键原样进页面，reload/后退由 guest 原生处理（工具条按钮仍可用）。
// 登记前的小窗按键会按完整页签路由：竞态窗极小（小窗需先被点击聚焦，点击必然
// 晚于 dom-ready）；小窗重挂（关再开/切回 Web 面板）产生新 id、dom-ready 重报，
// 槽位后者覆盖前者；登记 handler 里挂 destroyed 自清，小窗销毁即清空槽位
// （id 单调不复用，残留死 id 本无功能影响，自清免掉长期运行的陈旧状态）。
let webbarMiniWebContentsId: number | null = null
// POST 表单正文只留主进程；渲染层仅持一次性 token，避免把文件路径/表单字段经 IPC 广播。
const WEBBAR_POST_PENDING_MAX = 16
const WEBBAR_POST_PENDING_TTL_MS = 30_000
const WEBBAR_POST_RAW_MAX_BYTES = 8 * 1024 * 1024
const pendingWebbarPosts = new PendingWebbarPostStore(WEBBAR_POST_PENDING_MAX, WEBBAR_POST_PENDING_TTL_MS)
// 仅记录确实注册成功的应用内协议；子框架导航一律取消，仅对已接管的
// bytedance://dispatch_message/ 不重复记警告。注册失败时保留拦截日志。
const webbarHandledDeepLinkSchemes = new Set<string>()

// dsh web 导航白名单：取当前实例规范化 URL 的 origin（127.0.0.1:实际端口）。无实例时返回 null。
function getDshWebAllowedOrigin(): string | null {
  const u = dshWebManager.currentUrl
  if (!u) return null
  try {
    return new URL(u).origin
  } catch {
    return null
  }
}

// 网页访问栏 URL 判定：仅放行 http/https（file:/chrome: 等一律拦，对齐渲染层 normalizeWebBarUrl）
function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

// ── 网页访问栏外部协议的 Edge 式确认交付 ──
// 导航闸把非 http/https 导航 preventDefault 拦下后（页面停在原地，绝不触达 OS），
// 主框架的外部 scheme 再走三档（对齐 Edge/Chromium 的 external protocol 模型）：
//   1. 敏感系统 scheme / 无注册 handler → 静默丢弃。无 handler 的 scheme 触达 OS 会弹
//      Windows「在 Microsoft Store 查找应用」对话框，这正是当初一刀切全拦的原因；
//   2. 有 handler → 确认框亮出完整 URL 与目标应用名 —— 知情同意后才 shell.openExternal
//      交付（不经系统浏览器，URL 只到达用户点名的应用，与「不交系统浏览器避免泄 URL」
//      同一解法）；
//   3. 勾选「记住」→ 本会话内同发起页 origin+scheme 不再询问（记住允许直接交付，
//      记住拒绝静默丢弃）。会话级缓存不持久化：重启重新询问，站点信任不跨会话累积。
// 子框架的外部 scheme 派发（抖音 iframe 的 bytedance://dispatch_message/ 等）
// 仍取消导航；仅对已接管的 dispatch_message 请求不重复记警告，不弹确认或系统对话框。
// 发起页 origin 取 webview 当前已提交 URL（闸拦在导航提交前，正好是用户所在的页）
const externalProtocolChoices = new Map<string, boolean>() // origin|scheme → 是否允许（会话内记住）
const externalProtocolPending = new Set<string>() // 确认框进行中的键：连发派发（重定向链/连点）直接丢，不排队刷屏
const externalProtocolLastOpened = new Map<string, number>() // 记住允许路径的秒级冷却时间戳：防恶意页循环派发刷起外部应用
const externalProtocolLastAsked = new Map<string, number>() // 询问路径的秒级冷却：用户刚点掉确认框，不给同一来源立刻再弹
// 永不交付的系统敏感 scheme：确认框会退化成「打开系统敏感面」的入口，
// 与「网站想打开应用」的知情同意语义无关。
const EXTERNAL_PROTOCOL_DENY_SCHEMES = new Set([
  'file', 'smb', 'chrome', 'electron', 'javascript', 'data', 'about', 'blob',
  // Windows：只拒绝已注册且通向系统敏感面的 scheme（!appName 分支已挡掉未注册 scheme 触达
  // OS 弹 Store 对话框的路径），不做 ms-* 前缀全拒 —— ms-outlook / ms-teams / msteams /
  // ms-photos 等是合法 App 深链，应走到确认框。
  'ms-settings', 'ms-windows-store', 'ms-appinstaller', 'ms-msdt', 'ms-search', 'ms-appx', 'search-ms'
])

/** webbar 主框架外部 scheme 的确认交付。调用前提：该导航已在闸内被 preventDefault。 */
function offerWebbarExternalProtocol(url: string, pageUrl: string): void {
  let scheme: string
  try {
    scheme = new URL(url).protocol.replace(/:$/, '').toLowerCase()
  } catch {
    return // 畸形地址：导航已被闸拦下，无需交付
  }
  if (EXTERNAL_PROTOCOL_DENY_SCHEMES.has(scheme)) return
  let appName = ''
  try {
    appName = app.getApplicationNameForProtocol(url)
  } catch {
    return // 查询 handler 失败（如平台不支持）按无 handler 处理：静默丢弃
  }
  if (!appName) {
    log.info('Dropped external scheme without OS handler:', url)
    return
  }
  let pageOrigin = ''
  try { pageOrigin = new URL(pageUrl).origin } catch { /* about:blank 等无 origin 落空键 */ }
  const key = `${pageOrigin}|${scheme}`
  const remembered = externalProtocolChoices.get(key)
  if (remembered !== undefined) {
    if (remembered) {
      // 秒级冷却：记住允许后恶意页仍可循环派发主框架深链，逐次 openExternal 会连环拉起
      // 外部应用；正常用户 1 秒内重复点「打开APP」本就无意义（首开后焦点已去外部应用）
      const last = externalProtocolLastOpened.get(key) ?? 0
      if (Date.now() - last < 1000) return
      externalProtocolLastOpened.set(key, Date.now())
      shell.openExternal(url).catch(err => log.warn('Failed to open external protocol:', err))
    }
    return
  }
  if (externalProtocolPending.has(key)) return
  // 询问路径的秒级冷却：用户刚点掉确认框（或点取消），不给同一来源立刻再弹。
  // 与记住允许路径的冷却共用同一个 1s 阈值 —— 正常用户不会在 1s 内连点两个触发外部协议的操作。
  const lastAsk = externalProtocolLastAsked.get(key) ?? 0
  if (Date.now() - lastAsk < 1000) return
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
  if (!win) return
  externalProtocolPending.add(key)
  dialog.showMessageBox(win, {
    type: 'question',
    title: '打开外部应用',
    message: `此网站想打开 ${appName}`,
    detail: url,
    buttons: ['打开', '取消'],
    // 默认「取消」：恶意页派发深链后，一次 Enter 不能直接放行 openExternal
    defaultId: 1,
    cancelId: 1,
    checkboxLabel: '记住此网站的选择（本会话内不再询问）',
    noLink: true
  }).then(({ response, checkboxChecked }) => {
    const allow = response === 0
    if (checkboxChecked) externalProtocolChoices.set(key, allow)
    if (allow) {
      log.info(`External protocol handoff allowed (${appName}):`, url)
      externalProtocolLastOpened.set(key, Date.now())
      shell.openExternal(url).catch(err => log.warn('Failed to open external protocol:', err))
    }
  }).catch(() => { /* 对话框异常静默：导航已被闸拦下 */ }).finally(() => {
    externalProtocolPending.delete(key)
    externalProtocolLastAsked.set(key, Date.now())
  })
}

// ── 插件视图 guest 挂载闸（docs/plugin-ui-views-plan.md §三/§四）──
// will-attach-webview 校验通过的 guest 记录排队，did-attach-webview 按 session
// 身份对号入座（同窗口多个 webview 并发挂载按创建序完成，FIFO 消费）。身份
// 信任锚是 main 侧状态（partition 前缀 + 注册表视图表 + 一次性 dialogId），
// renderer 自报的属性一概不信。
interface PendingPluginGuestAttach {
  pluginId: string
  viewId: string
  kind: 'panel' | 'dialog'
  dialogId?: string
  entryPath: string
  createdAt: number
}
const pendingPluginAttaches: PendingPluginGuestAttach[] = []
const PENDING_ATTACH_TTL_MS = 30_000

/**
 * will-attach 校验：partition 归属、插件启用、src 是本插件已注册视图的入口 URL。
 * panel：入口 URL 不带查询串；dialog：仅带一次性 dialogId 并当场消费（窗口/
 * pluginId/viewId/入口逐项匹配，第二个 webview 复用同一 dialogId 一律拒绝）。
 * 通过返回待登记记录；任何不符返回 null（调用方 preventDefault）。
 */
function validatePluginViewAttach(partition: string, src: string, ownerWindowId: number): PendingPluginGuestAttach | null {
  const pluginId = partition.slice(PLUGIN_VIEW_PARTITION_PREFIX.length)
  if (!pluginId || partition !== pluginViewPartition(pluginId)) return null
  // 过期排队记录顺带清扫（attach 中断的残项不影响后续挂载）
  const now = Date.now()
  for (let i = pendingPluginAttaches.length - 1; i >= 0; i--) {
    if (now - pendingPluginAttaches[i].createdAt > PENDING_ATTACH_TTL_MS) pendingPluginAttaches.splice(i, 1)
  }
  let viewRegistry
  try {
    viewRegistry = getPluginViewRegistry()
  } catch {
    return null
  }
  if (!viewRegistry.isPluginEnabled(pluginId)) {
    log.warn('[plugin-view] Blocked webview attach: plugin not enabled:', pluginId)
    return null
  }
  let url: URL
  try {
    url = new URL(src)
  } catch {
    log.warn('[plugin-view] Blocked webview attach: malformed src:', src)
    return null
  }
  if (url.protocol !== `${PLUGIN_VIEW_SCHEME}:` || url.hostname !== pluginId) {
    log.warn('[plugin-view] Blocked webview attach: src does not match plugin partition:', src)
    return null
  }
  const views = viewRegistry.listViewsForPlugin(pluginId)
  let target: { id: string; entry: string } | null = null
  try {
    const rel = decodeURIComponent(url.pathname)
    const relPath = rel.startsWith('/') ? rel.slice(1) : rel
    target = views.find((v) => v.entry.replace(/^views\//, '') === relPath) ?? null
  } catch {
    return null
  }
  if (!target) {
    log.warn('[plugin-view] Blocked webview attach: src is not a registered view entry:', src)
    return null
  }
  const entryPath = target.entry.replace(/^views\//, '')
  if (url.search === '') {
    // 常挂面板：无查询串
    return { pluginId, viewId: target.id, kind: 'panel', entryPath, createdAt: now }
  }
  // 弹窗：仅允许单一 dialogId 参数，且必须匹配一张未过期的待挂载弹窗记录
  const q = new URLSearchParams(url.search)
  if (q.size !== 1 || !q.has('dialogId')) {
    log.warn('[plugin-view] Blocked webview attach: unexpected query:', src)
    return null
  }
  const dialogId = q.get('dialogId') ?? ''
  const consumed = pluginDialogManager.consumeForAttach(dialogId, {
    pluginId,
    viewId: target.id,
    entryPath,
    ownerWindowId
  })
  if (!consumed) {
    log.warn('[plugin-view] Blocked dialog attach: invalid or consumed dialogId')
    return null
  }
  return { pluginId, viewId: target.id, kind: 'dialog', dialogId, entryPath, createdAt: now }
}

/** did-attach 后的 guest 装配：登记身份 + 弹窗补记 + 销毁清理 + 导航/开窗闸 */
function setupPluginGuest(guestContents: Electron.WebContents, pending: PendingPluginGuestAttach): void {
  const winId = mainWindow && !mainWindow.isDestroyed() ? mainWindow.id : 0
  pluginGuestRegistry.attach({
    webContentsId: guestContents.id,
    pluginId: pending.pluginId,
    viewId: pending.viewId,
    kind: pending.kind,
    ownerWindowId: winId,
    dialogId: pending.dialogId
  })
  if (pending.kind === 'dialog' && pending.dialogId) {
    pluginDialogManager.completeAttach(pending.dialogId, guestContents.id)
  }
  // 销毁清理：面板销毁联动其发起弹窗取消；弹窗销毁联动发起 guest 收到取消
  guestContents.once('destroyed', () => {
    handlePluginGuestDestroyed(guestContents.id)
  })
  // guest 一律不开新窗
  guestContents.setWindowOpenHandler(({ url }) => {
    log.warn('[plugin-view] Blocked guest window.open:', url)
    return { action: 'deny' }
  })
  // 导航闸：主框架只允许本插件 lyshell-plugin:// 资源（插件页面内部跳转）；
  // 子框架一律取消；外站/他插件/外部协议全部拦下
  const isSamePluginUrl = (raw: string): boolean => {
    try {
      const u = new URL(raw)
      return u.protocol === `${PLUGIN_VIEW_SCHEME}:` && u.hostname === pending.pluginId
    } catch {
      return false
    }
  }
  const denyNav = (label: string, url: string): void => {
    log.warn(`[plugin-view] Blocked guest ${label} (${pending.pluginId}/${pending.viewId}):`, url)
  }
  guestContents.on('will-navigate', (event, url) => {
    if (!isSamePluginUrl(url)) {
      event.preventDefault()
      denyNav('navigation', url)
    }
  })
  guestContents.on('will-redirect', (event, url) => {
    if (!isSamePluginUrl(url)) {
      event.preventDefault()
      denyNav('redirect', url)
    }
  })
  guestContents.on('will-frame-navigate', (e) => {
    if (!e.isMainFrame || !isSamePluginUrl(e.url)) {
      e.preventDefault()
      denyNav('frame navigation', e.url)
    }
  })
  // guest console 转发（取证通道，与 webbar 一致；warn 及以上）。经限速 tap:
  // 插件页可以按管线速度 console.error,不设闸会冲掉 main.log 里有用内容。
  const consoleTap = createLogTap((line) => log.warn(line), { maxLines: 20 })
  guestContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level < 2) return
    const text = message.length > 500 ? `${message.slice(0, 500)}…` : message
    consoleTap(`[plugin-view console] ${pending.pluginId}/${pending.viewId} (${sourceId}:${line}) ${text}`)
  })
}

// 创建主窗口
function createMainWindow(): void {
  // 启动恢复:读取持久化的窗口尺寸,无则回退默认 1200×800;clamp 到当前屏幕工作区防换小屏超界
  const saved = preferencesRepository.get('window') as { width?: number; height?: number } | undefined
  const workArea = screen.getPrimaryDisplay().workAreaSize
  const initWidth = saved && typeof saved.width === 'number'
    ? Math.max(800, Math.min(saved.width, workArea.width))
    : 1200
  const initHeight = saved && typeof saved.height === 'number'
    ? Math.max(600, Math.min(saved.height, workArea.height))
    : 800

  mainWindow = new BrowserWindow({
    width: initWidth,
    height: initHeight,
    minWidth: 800,
    minHeight: 600,
    show: false,
    title: 'LyShell',
    icon: isDev
      ? join(__dirname, '../../resources/icons/icon.png')
      : join(process.resourcesPath, 'icons', 'icon.png'),
    autoHideMenuBar: true,
    frame: false, // 无边框窗口，自定义标题栏
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: true,
      allowRunningInsecureContent: false
    }
  })

  // 设置主窗口引用给 Worker 管理器
  setMainWindow(mainWindow)
  setMainWindowForUpload(mainWindow)

  // 页面缩放钉死 100%:Chromium 默认 Ctrl+滚轮/Ctrl+加减 会缩放页面且按 origin 持久化,
  // 渲染层已有 window capture 兜底(见 MainWindow),这里双保险 ——
  //   - did-finish-load 归一:治愈历史版本误触后跨重启残留的缩放(dev 下 HMR 整页重载也会走到,同样该归零);
  //   - zoom-changed 钳回:拦住漏网的用户缩放请求(如键盘 Ctrl+/-),持续压回 100%。
  // 界面内的 Ctrl+滚轮语义(终端字号/文档缩放)由各组件自行处理,与此互不冲突。
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.webContents.setZoomLevel(0)
  })
  mainWindow.webContents.on('zoom-changed', () => {
    // 在事件的同步回调里直接 setZoomLevel 会与触发源(Chromium 缩放变更管线)同步
    // 重入 —— 退出当前事件回调、排到微任务里再钳回,Electron 事件语义随版本变化
    // 也留了缓冲;窗口可能已销毁则跳过(setZoomLevel 对已销毁 webContents 会抛)
    queueMicrotask(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.setZoomLevel(0)
    })
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  // 记住手动拖拽/边框缩放后的窗口尺寸(debounce 500ms;最大化期间不记,避免记成最大化尺寸;只记尺寸不记位置)
  let resizePersistTimer: NodeJS.Timeout | undefined
  mainWindow.on('resize', () => {
    if (!mainWindow || mainWindow.isMaximized()) return
    clearTimeout(resizePersistTimer)
    resizePersistTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isMaximized()) return
      const [width, height] = mainWindow.getSize()
      preferencesRepository.set('window', { width, height })
    }, 500)
  })

  mainWindow.on('closed', () => {
    clearTimeout(resizePersistTimer)
    setMainWindow(null)  // 清除窗口引用
    setMainWindowForUpload(null)
    // 插件视图联动：该窗口的 guest 登记/在途动作/弹窗全部清理（面板 webview 已随窗口销毁）
    if (mainWindow) {
      handlePluginViewWindowClosed(mainWindow.id)
    }
    pendingPluginAttaches.length = 0
    mainWindow = null
    // macOS 上关窗不退出应用：webview 已随窗口销毁，但 dsh web 子进程仍在，这里主动回收。
    // will-quit 里的 close() 是兜底；此处保证「关窗即停」（幂等，重复调用无害）。
    // 窗口关闭不是 app 退出，不需要等树杀完成；失败仅告警。
    dshWebManager.close().catch((err) => log.warn('dsh web close on window closed failed:', err))
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const target = new URL(url)
      const allowed = isDev && process.env['ELECTRON_RENDERER_URL']
        ? target.origin === new URL(process.env['ELECTRON_RENDERER_URL']).origin
        : target.href === new URL(`file://${resolve(__dirname, '../renderer/index.html')}`).href
      if (!allowed) {
        event.preventDefault()
        log.warn('Blocked unexpected navigation:', url)
      }
    } catch (error) {
      event.preventDefault()
      log.warn('Blocked malformed navigation URL:', url, error)
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url).catch(err => log.warn('Failed to open external URL:', err))
    }
    return { action: 'deny' }
  })

  // 锁定 <webview> 客体，按 partition 分流：
  //   - dsh web 面板（默认）：初始 src 与后续导航都只放行 dshWebManager 当前实例的
  //     origin（127.0.0.1:实际端口），弹窗一律 deny —— 杜绝 webview 逃逸到外站或本机其它服务。
  //   - 网页访问栏（persist:webbar，完整页签与写轮眼小窗共用）：src 要求 http/https
  //     （用户在插件面板输入任意网址）；about:blank 仅作 POST 页签首航引导页，
  //     空 src 放行 —— 小窗首航经渲染层 loadURL 起航
  //     （无 src 挂载不产生导航，起航时走 will-navigate 同口径校验），后续导航同策略，
  //     弹窗仍 deny。
  //   注意：persist:webbar 专属通用浏览，后续若新增外部网页拖拽/插件注入等入口，
  //   请另开独立 partition（如 persist:pluginweb），不要复用本通道 —— 该 partition 的
  //   导航策略是「放行任意 http/https」，复用等于把放宽后的策略扩散到所有新入口。
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    const src = params?.src || ''
    if (params?.partition === WEBBAR_PARTITION) {
      // 网页访问栏（完整页签 + 小窗）：只校验协议（渲染层 normalizeWebBarUrl 已做
      // 同样归一化，这里是服务端兜底）；空 src 例外放行（小窗 loadURL 起航路径）
      // POST 页签先挂 about:blank，待 dom-ready 后凭一次性 token 在主进程发出原 POST。
      if (src !== '' && src !== 'about:blank' && !isHttpUrl(src)) {
        log.warn('Blocked webbar webview attach with non-http(s) src:', src)
        event.preventDefault()
        return
      }
    } else if (
      typeof params?.partition === 'string' &&
      params.partition.startsWith(PLUGIN_VIEW_PARTITION_PREFIX)
    ) {
      // 插件视图 guest（panel/dialog）：partition 前缀归属 + 插件启用 + src 必须是
      // 本插件已注册视图的入口 URL（dialog 还须消费一张有效一次性 dialogId）。
      // renderer 永远无权自带 preload —— 强制换成本仓库打包的 pluginView.js。
      const ownerWindowId = mainWindow && !mainWindow.isDestroyed() ? mainWindow.id : 0
      const pending = validatePluginViewAttach(params.partition, src, ownerWindowId)
      if (!pending) {
        event.preventDefault()
        return
      }
      pendingPluginAttaches.push(pending)
    } else {
      const allowed = (() => {
        const origin = getDshWebAllowedOrigin()
        if (!origin) return false
        try {
          return new URL(src).origin === origin
        } catch {
          return false
        }
      })()
      if (!allowed) {
        log.warn('Blocked webview attach with unexpected src:', src)
        event.preventDefault()
        return
      }
    }
    // 显式锁定 webview 的 webPreferences（防注入；主窗口已 sandbox/contextIsolation）。
    // 插件 guest 的 preload 一律是打包内 pluginView.js（页面无法注入自己的 preload，
    // 也无 Node 能力；bridge IPC 在 main 侧按登记身份核对）。
    if (
      typeof params?.partition === 'string' &&
      params.partition.startsWith(PLUGIN_VIEW_PARTITION_PREFIX)
    ) {
      webPreferences.preload = join(__dirname, '../preload/pluginView.js')
    }
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.webSecurity = true
  })

  mainWindow.webContents.on('did-attach-webview', (_event, webContents) => {
    // 插件视图 guest 优先：queue 首条记录的 partition session 与本 guest 一致即对号
    // 入座（不匹配不动队列 —— dsh/webbar 的 attach 不产生排队记录）。
    const pending = pendingPluginAttaches[0]
    if (
      pending &&
      webContents.session === session.fromPartition(pluginViewPartition(pending.pluginId))
    ) {
      pendingPluginAttaches.shift()
      setupPluginGuest(webContents, pending)
      return
    }
    // 按 session partition 分流：网页访问栏（完整页签与写轮眼小窗共用）放行任意
    // http/https 导航（自由浏览），其余（dsh web）维持 origin 锁定。fromPartition
    // 返回同 partition 的 session 单例，webview 挂载的 session 与之身份相等即
    // 网页访问栏。
    const isWebbar = webContents.session === session.fromPartition(WEBBAR_PARTITION)
    webContents.setWindowOpenHandler(({ url, disposition, postBody, referrer }) => {
      // webview 一律不开新窗口/弹窗（deny，也不交系统浏览器避免泄 URL）。网页访问栏
      // （完整页签 + 小窗）的 http/https 开窗请求按 disposition 分流。先摆映射实证
      // （Electron 28 源码 electron_api_web_contents.cc 的 Converter<WindowOpenDisposition>
      // 特化，d.ts 联合类型与之对齐；'new-popup' 这个字符串 Electron 不产出 —— Chrome
      // 日志层的同名值不是本 API 的取值）：
      //   CURRENT_TAB → 'default'；NEW_FOREGROUND_TAB → 'foreground-tab'；
      //   NEW_BACKGROUND_TAB → 'background-tab'；NEW_POPUP 与 NEW_WINDOW → 'new-window'；
      //   UNKNOWN / OFF_THE_RECORD / IGNORE_ACTION 等 → 'other'（兜底）。
      // 小窗三路：
      //   - background-tab（中键/Ctrl+点击）：转发渲染层后台开完整页签（payload 带
      //     background=true 挂载不激活），用户不被拽走；完整页签同请求同语义。
      //   - foreground-tab 与 default 原地跳转（deny 真窗口后 loadURL 到小窗自己）：
      //     foreground-tab 是普通点击 target=_blank 的取值；default = CURRENT_TAB，
      //     Chromium 自己的「当前视图内打开」语义，原地跳即忠实执行。原地跳的后退/
      //     前进/地址栏跟随/历史栈工具条全部现成，与升格钮（当前页开成完整页签）
      //     互补。loadURL 是主进程发起的导航，不触发 will-navigate 闸，url 已过
      //     isHttpUrl 同口径校验，跳转产生历史条目 goBack 可回。已知取舍：无 features
      //     的 window.open（JS 起的新「标签页」）同样落 foreground-tab，handler details
      //     没有手势标志分不开 —— 它也原地跳。可接受：跳转可见、goBack 可回，而 deny
      //     之下它无论转发还是原地都拿不到 opener（见下），原地至少不打断浏览。
      //   - new-window 与 other 转发渲染层前台开完整页签：new-window 覆盖 NEW_POPUP
      //     （window.open 带 features 的 OAuth/分享弹窗）—— JS 弹窗期望全新上下文，
      //     原地 loadURL 会顶掉小窗当前页、流程腰斩；other 是 UNKNOWN / OFF_THE_RECORD
      //     / IGNORE_ACTION 的兜底，来源不可知，不当普通点击信任 —— 宁可开成可见
      //     页签，也不无声替换小窗页面。
      // 完整页签除 background-tab 外一律前台转发（照旧）。
      // 已知边界 —— opener 链路不可保留：deny + 转发到另一 webContents 后，弹出页与
      // 原页面既非父子窗口也无 window.opener，靠 window.open 返回值 / opener
      // postMessage 通信的弹窗式流程（老式 OAuth 弹窗等）在完整页签与小窗里都完不成
      // —— 这是「不开真弹窗」设计的固有代价（真弹窗方案已被明确否决），此类流程在
      // 纯 deny 的旧版同样不通。现代 OAuth 走整页重定向（provider 302 回跳 callback），
      // 经导航闸放行（webbar 只拦非 http/https，见 onNavGate 注），不依赖 opener，
      // 小窗/页签里都可用。
      // 转发地址经渲染层 openWebTab 的 normalizeWebBarUrl 再校验；转发闸（同键去重 +
      // 短窗频控）防「无限开新页签」的资源型刷屏 —— 原地跳不需要闸：页面本就有权
      // 导航自己（location.href），弹窗原地跳不比这更糟。小窗身份凭
      // webbarMiniWebContentsId 登记（同快捷键转发的排除机制，见其注释）；登记未到
      // （竞态窗）按完整页签转发，无害。dsh web 维持纯 deny（origin 锁定无浏览语义）。
      // 非 http/https 开窗直接 deny：此事件没有可靠的用户手势和发起 iframe 信息，
      // 不能按顶层页面 origin 复用外部协议的「记住允许」选择。
      if (isWebbar && isHttpUrl(url)) {
        const miniInPlace = webContents.id === webbarMiniWebContentsId
          && (disposition === 'foreground-tab' || disposition === 'default')
        if (miniInPlace) {
          const options = postBody ? webbarPostLoadOptions(postBody, referrer) : undefined
          void webContents.loadURL(url, options).catch(err => {
            log.warn('Webbar mini in-place navigate failed:', url, err)
          })
        } else {
          const postToken = postBody ? randomUUID() : undefined
          if (postToken && postBody) {
            if (!webbarPostRawBytesWithinLimit(postBody, WEBBAR_POST_RAW_MAX_BYTES)) {
              log.warn('Blocked webbar POST popup: raw body exceeds 8 MiB')
              return { action: 'deny' }
            }
            // guest 可连续提交表单；渲染层弹窗闸尚未来得及裁决前先限制主进程保留量。
            // 未认领令牌由 store 在 30 秒到期时主动释放，不依赖下一次弹窗。
            if (!pendingWebbarPosts.enqueue(postToken, { url, body: postBody, referrer })) {
              log.warn('Blocked webbar POST popup: pending request limit reached')
              return { action: 'deny' }
            }
          }
          mainWindow?.webContents.send(IPC_CHANNELS.WEB_TAB_POPUP, {
            url,
            background: disposition === 'background-tab',
            postToken
          })
        }
      } else {
        log.warn('Blocked webview window.open:', url)
      }
      return { action: 'deny' }
    })
    // 网页页签快捷键：焦点进 webview 后键盘全被 guest 吃掉，宿主 keydown 收不到。
    // 在 guest 事件分发前拦截浏览器手势（Ctrl+R/Alt+←→/Ctrl+L 等），掐掉
    // guest 的默认动作后转发渲染层路由到「活动网页页签」—— 与宿主侧快捷键
    // 走同一控制层。仅网页访问栏挂（dsh web 保持锁定，无浏览语义）；写轮眼小窗
    // 与完整页签同 session，凭 webbarMiniWebContentsId 在事件拍排除（登记细节
    // 见其注释）—— 小窗内的按键原样进页面。
    if (isWebbar) {
      webContents.on('before-input-event', (event, input) => {
        if (webContents.id === webbarMiniWebContentsId) return
        const action = matchWebTabShortcut(input)
        if (!action) return
        event.preventDefault()
        mainWindow?.webContents.send(IPC_CHANNELS.WEB_TAB_SHORTCUT, action)
      })
    }
    // guest 页面 console 转发（取证通道）：webview 客体里页面脚本的报错（Uncaught
    // TypeError 等）默认只进不可见的 guest devtools，主进程日志毫无痕迹 —— 排查
    // 「页面没冻结但按钮点不动」类问题（抖音保存登录信息弹窗的保存/取消按钮）时
    // 无从下手。warn 及以上转发进主日志（info 级心跳噪音大不转），消息截长防单条
    // 刷屏 + 限速 tap 防速率刷屏
    const consoleTap = createLogTap((line) => log.warn(line), { maxLines: 20 })
    webContents.on('console-message', (_event, level, message, line, sourceId) => {
      if (level < 2) return
      const text = message.length > 500 ? `${message.slice(0, 500)}…` : message
      consoleTap(`[guest console] ${webContents.getURL()} (${sourceId}:${line}) ${text}`)
    })
    // 导航闸 —— will-navigate（锚点点击 / JS location 赋值）与 will-redirect（302/
    // meta refresh 的服务端落点）两条事件共用同一策略：实证（Electron 28 探针）锚点与
    // JS 路径只走 will-navigate、重定向落点只走 will-redirect，webRequest 网络层对外
    // 部 scheme 全程不可见 —— 少挂任一条都会漏。will-redirect 原先未挂：外部协议深链
    // （bytedance:// 等，抖音页反复重定向触发「打开APP」）经重定向直达 OS 协议处理
    // 器，Windows 弹「在 Microsoft Store 查找应用」对话框且反复刷 —— preventDefault
    // 掐的是整个导航，闸内拦下即免于触达系统
    const onNavGate = (event: { url: string; isMainFrame: boolean; preventDefault(): void }, url: string): void => {
      // will-redirect 也覆盖子框架：先走子框架闸，不能把 iframe 的外部协议
      // 当主框架深链送进「打开外部应用」确认流程。
      if (gateWebviewSubframeNavigation(event, isWebbar, webbarHandledDeepLinkSchemes,
        blockedUrl => log.warn('Blocked webview frame navigation:', blockedUrl))) return
      try {
        const target = new URL(url)
        if (isWebbar) {
          // 网页访问栏（完整页签 + 写轮眼小窗）：仅拦非 http/https（file://、chrome://、
          // 外部协议深链等 —— 未注册 scheme 触达 OS 即弹系统对话框）
          if (target.protocol === 'http:' || target.protocol === 'https:' || url === 'about:blank') return
          event.preventDefault()
          // 拦下后走 Edge 式确认交付：无 handler 静默、有 handler 确认后交付。直接导航
          // （锚点/JS 赋值）经此闸；重定向落点只走 will-redirect 也进此闸 —— 两条路共用
          // 同一缓存与在途防重入
          offerWebbarExternalProtocol(url, webContents.getURL())
          log.warn('Blocked webbar webview navigation:', url)
          return
        }
        const origin = getDshWebAllowedOrigin()
        if (origin && target.origin === origin) return
        event.preventDefault()
        log.warn('Blocked webview navigation:', url)
      } catch {
        event.preventDefault()
        log.warn('Blocked malformed webview navigation URL:', url)
      }
    }
    webContents.on('will-navigate', onNavGate)
    webContents.on('will-redirect', onNavGate)
    // 子框架闸（will-frame-navigate 先于 will-navigate 触发且覆盖子框架）：
    // http/https 子框架（广告 iframe 常态）照常放行；dsh 的 origin 锁维持
    // 主框架语义不外溢到子框架。实证（探针）：子框架/按钮 onclick 的外部 scheme
    // 导航只在此事件露头。webbar 的主框架外部 scheme 拦下后转确认交付闸（此处
    // preventDefault 后 will-navigate 不再触发，不会双重处理；直接导航走本闸、
    // 主框架重定向落点走 onNavGate，两路共用同一缓存与在途防重入）；子框架的
    // 直航与重定向共用同一闸，外部协议均取消导航，仅静音已接管的抖音心跳深链。
    webContents.on('will-frame-navigate', (e) => {
      if (isWebbar && e.isMainFrame && e.url === 'about:blank') return
      if (gateWebviewSubframeNavigation(e, isWebbar, webbarHandledDeepLinkSchemes,
        blockedUrl => log.warn('Blocked webview frame navigation:', blockedUrl))) return
      const decision = decideWebviewFrameNavigation(e.url, e.isMainFrame, isWebbar, webbarHandledDeepLinkSchemes)
      if (decision === 'allow') return
      e.preventDefault()
      if (isWebbar && e.isMainFrame) {
        offerWebbarExternalProtocol(e.url, webContents.getURL())
      }
      if (decision === 'cancel') log.warn('Blocked webview frame navigation:', e.url)
    })
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// 注册窗口级快捷键 —— 走 before-input-event,只在 LyShell 获得焦点时拦截,失焦不劫持系统其他 app
// 之前用 globalShortcut.register('CommandOrControl+Alt+F') 是错的:那是 OS 级别拦截,LyShell 在后台时
// 用户在别的 app 按 Ctrl+Alt+F 也会被吞掉
function registerWindowShortcuts(): void {
  if (!mainWindow) return
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    // Ctrl+`(backquote)切换浮窗。键码用 `Backquote` 比 input.key 更稳:不同键盘布局上 `` ` `` 的 key 值可能不同
    const isCtrl = input.control || input.meta  // mac 上 Cmd 等价
    if (input.type === 'keyDown' && isCtrl && !input.shift && !input.alt && input.code === 'Backquote') {
      log.info('Float toggle shortcut triggered (Ctrl+`)')
      mainWindow?.webContents.send('float:toggle')
      _event.preventDefault()
    }
  })
}

// 单实例锁 —— 同一 userData 同时跑两个实例会互抢 partition 的 LevelDB 存储：
// 后到者打不开且重置失败（quota_database 报错），页面同步存储写入随之挂死
// （抖音「保存登录信息」弹窗卡死即此症状，详见 dev-user-data.ts 注释）。二实例
// 直接退出；已跑实例收到 second-instance 通知后还原/聚焦主窗口。锁按 userData
// 目录隔离 —— dev 分离目录后 dev 与正式版各自持锁、可并存
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  // dev 档案播种等锁到手再跑：两个 dev 实例同时启动（清掉标记后的第一次）会并发
  // seed，共用固定 .tmp 互相踩。锁按 userData 隔离，dev 自己也持锁 —— 只有持有方播。
  // 位置须早于 whenReady 里任何仓储的首次读盘（它们延迟初始化，最早是
  // downloadHistory.init()），否则那边先 load 到空档案。详见 dev-user-data.ts
  seedDevConfigFromProd()
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

// 应用启动
app.whenReady().then(async () => {
  // 单实例竞争失败方：quit 已排队，ready 在部分版本仍会触发，这里不再往下引导
  // （锁的持有方才有资格创建窗口/起服务器）
  if (!gotSingleInstanceLock) return
  // 设置应用ID
  app.setAppUserModelId('com.lyshell.app')

  // 通用网页会话使用与内核版本一致的 Chrome UA。抖音实测会按 lyshell/Electron
  // 标识切到另一套页面布局；仅去掉应用标识，不伪报更高的 Chromium 版本。
  // 必须在首个 webbar webview 创建前设置，完整页签与写轮眼小窗共用此 session。
  const webbarSession = session.fromPartition(WEBBAR_PARTITION)
  const browserUserAgent = webbarSession.getUserAgent().replace(/\s+(?:lyshell|Electron)\/\S+/gi, '')
  webbarSession.setUserAgent(browserUserAgent)

  // 清扫上次崩溃/强杀遗留的孤儿 dsh web（会占着 DSH 会话写锁 → 「当前会话已被占用」）。
  // 两条互补路径，覆盖面对齐 proc.ts 的三层防护：
  //   - 签名清扫：要 WMI 枚举，抓「父进程链已断」的（含 root pid 已丢的）；
  //   - record 恢复：用留档定位旧 pid，核对镜像名、命令行和父链；WMI 不可用时保留记录。
  // 只杀「签名命中 + 孤儿」与「本 app spawn 过且仍在档」的；后台跑，不挡启动。
  sweepOrphanDshWeb().catch((err) => log.warn('orphan dsh web sweep failed:', err))
  dshWebManager.recoverFromRecord().catch((err) => log.warn('dsh web record recovery failed:', err))

  // 初始化下载历史存储
  await downloadHistory.init()
  log.info('Download history initialized')

  // 启动 MCP HTTP 服务器（必须在创建任何会话/窗口前完成，
  // 否则用户在窗口中开本地终端时端口尚未就绪，session-token env 无法注入）
  try {
    const { startMcpHttpServer, stopMcpHttpServer } = await import('@main/mcp/http-server')
    await startMcpHttpServer()
    stopMcpHttpServerImpl = stopMcpHttpServer
  } catch (err) {
    log.error('Failed to start MCP HTTP server:', err)
  }

  // 插件视图：装配注册表（真实 deps）→ 首扫 manifest → UI token 对账 → 协议
  // handler 安装。须在窗口创建前完成，renderer 启动时的 plugin:list 才带得上视图。
  try {
    initPluginViewRegistry({
      getEnabledEntries: () => pluginRepository.getEnabled(),
      pluginDirOf: (entry) =>
        isAbsolute(entry.path) ? entry.path : join(getPluginsDir(), entry.path),
      readManifestViews: (entry) => {
        try {
          const dir = isAbsolute(entry.path) ? entry.path : join(getPluginsDir(), entry.path)
          const manifestPath = join(dir, 'lyshell-plugin.json')
          if (!fs.existsSync(manifestPath)) return []
          const result = validateManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf-8')))
          if (!result.ok || !result.manifest) return []
          return result.manifest.contributes?.views ?? []
        } catch {
          return []
        }
      },
      broadcast: () => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.PLUGIN_VIEWS_CHANGED)
        }
      },
      logWarn: (msg, ...rest) => log.warn(msg, ...rest)
    })
    getPluginViewRegistry().refreshAll()
    refreshAllPluginUiTokens(getPluginViewRegistry())
    installProtocolHandlersForEnabledPlugins()
  } catch (err) {
    log.error('Failed to init plugin view registry:', err)
  }

  // 启动 plugin host（依赖 MCP HTTP server 已就绪；无 enabled 插件时为 no-op）
  try {
    pluginHostManager.start()
  } catch (err) {
    log.error('Failed to start plugin host:', err)
  }

  // 注册 IPC 处理器 —— 必须先于 createMainWindow：renderer 启动即发起
  // plugin:list 等 invoke，handler 未就绪时首批调用会被「No handler registered」拒绝
  registerIPCHandlers()

  // 创建主窗口
  createMainWindow()

  // 抖音系深链 scheme 的应用内接管 —— 系统弹「在 Microsoft Store 查找应用」对话框的
  // 最后防线。下面的拦截链描述是本仓库 Electron 28（win32）的探针实测结论，不是
  // Electron 的普适规范 —— 外部协议的拦截路径随版本与调用场景（手势/入口）变化，
  // 升级 Electron 后应以同款探针复测再修订注释。实测路径上：带手势的 window.open
  // 到未注册 scheme 不经 setWindowOpenHandler、不产生导航事件、不触发 webRequest
  // —— 应用层无任何可拦点，直达 OS 协议处理器。把 scheme 经 protocol.handle 注册
  // 进 webbar 会话后，它对应用不再是「外部协议」—— 各入口（window.open/锚点/子
  // 框架/重定向）回到可拦截的导航与开窗机械里（did-attach-webview 各闸照常拦），
  // 本 handler 只是兜底：真有漏网导航落进来时回 204 空响应而非触达系统。列表是
  // 抖音网页端已知的深链家族（WEBBAR_DEEPLINK_SCHEMES，@shared/constants），
  // 遇到新 scheme 弹对话框时往那里加。fromPartition 返回会话单例，与
  // did-attach-webview 里的判定共享同一 session，挂载顺序无涉
  for (const scheme of WEBBAR_DEEPLINK_SCHEMES) {
    try {
      webbarSession.protocol.handle(scheme, () => new Response(null, { status: 204 }))
      webbarHandledDeepLinkSchemes.add(scheme)
      log.info(`Registered webbar deep-link scheme handler: ${scheme}://`)
    } catch (err) {
      log.warn(`Failed to register deep-link scheme handler (${scheme}):`, err)
    }
  }

  // 注册窗口级快捷键(必须在 createMainWindow 之后,因为依赖 mainWindow.webContents)
  registerWindowShortcuts()

  // 注册窗口相关 IPC 处理器
  ipcMain.handle('window:get-bounds', async () => {
    return mainWindow?.getBounds() || null
  })

  // 写轮眼小窗登记（渲染层 dom-ready 后自报 webContentsId）：小窗与完整页签共用
  // webbar partition 后 session 身份不再可判，did-attach-webview 的快捷键转发凭这份
  // 登记把小窗排除在外（见 webbarMiniWebContentsId 注释）。id 是渲染层自报的不可信
  // 输入，整数校验收窄
  ipcMain.handle(IPC_CHANNELS.WEBBAR_REGISTER_MINI, (_event, webContentsId: unknown) => {
    if (typeof webContentsId !== 'number' || !Number.isInteger(webContentsId) || webContentsId < 0) {
      log.warn('Rejected invalid webbar-mini webContentsId registration:', webContentsId)
      return { success: false }
    }
    webbarMiniWebContentsId = webContentsId
    // 陈旧登记自清：小窗关闭/摘树销毁 webContents 时清空槽位。守卫比对防误清 ——
    // 重挂竞态下旧 id 的 destroyed 可能晚于新登记到达（once 监听器存活的只是旧
    // webContents）。fromId 查无此 id（极端竞态：登记到达前小窗就关了）则不挂，
    // 槽位留给下次登记覆盖，无害
    webContents.fromId(webContentsId)?.once('destroyed', () => {
      if (webbarMiniWebContentsId === webContentsId) webbarMiniWebContentsId = null
    })
    return { success: true }
  })

  // 新页签的 POST 首航：正文始终在主进程，仅接收宿主渲染层交回的一次性 token。
  // webview 必须处于 about:blank 引导页且属于 webbar partition，避免重放或把表单
  // 数据送到其它 guest。令牌取出即销毁，加载失败也不重试 POST —— 重放已提交的
  // 请求有二次提交风险（付款/创建类动作重复执行），已明确否决；网页页签挂常驻层
  // （WebTabLayer）不随拖动重挂，正常流程不存在需要重放的场景。
  ipcMain.handle(IPC_CHANNELS.WEB_TAB_POST_LOAD, (event, token: unknown, webContentsId: unknown) => {
    const request = validateWebTabPostLoadRequest(token, webContentsId)
    if (event.sender !== mainWindow?.webContents || !request) return { success: false }
    const target = webContents.fromId(request.webContentsId)
    if (!target || target.session !== session.fromPartition(WEBBAR_PARTITION) ||
        target.id === webbarMiniWebContentsId || target.getURL() !== 'about:blank') return { success: false }
    const pending = pendingWebbarPosts.take(request.token)
    if (!pending) return { success: false }
    void target.loadURL(pending.url, webbarPostLoadOptions(pending.body, pending.referrer))
      .catch(err => log.warn('Webbar POST tab navigation failed:', pending.url, err))
    return { success: true }
  })

  // 设定主窗口尺寸(像素) -- 先退出最大化,按窗口所在显示器的工作区 clamp 尺寸 + 夹紧位置,最后持久化
  ipcMain.handle('window:set-size', async (_event, width: number, height: number) => {
    if (!mainWindow) return { success: false }
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize()
    }
    // 用 getDisplayMatching 取窗口当前所在显示器(多屏下不误拽到主屏);workArea 含 x/y 且排除任务栏
    const workArea = screen.getDisplayMatching(mainWindow.getBounds()).workArea
    // 宽高不允许超过该屏工作区
    const w = Math.max(800, Math.min(Math.round(width), workArea.width))
    const h = Math.max(600, Math.min(Math.round(height), workArea.height))
    mainWindow.setSize(w, h)
    // setSize 不移动左上角,窗口贴边时右下角会超出屏幕 -- 把左上角夹进工作区,保证整窗在屏内
    const bounds = mainWindow.getBounds()
    const x = Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - w)
    const y = Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - h)
    mainWindow.setPosition(Math.round(x), Math.round(y))
    preferencesRepository.set('window', { width: w, height: h })
    return { success: true, width: w, height: h }
  })

  // 窗口控制
  ipcMain.handle('window:minimize', async () => {
    mainWindow?.minimize()
    return true
  })

  ipcMain.handle('window:maximize', async () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize()
      return false
    } else {
      mainWindow?.maximize()
      return true
    }
  })

  ipcMain.handle('window:close', async () => {
    mainWindow?.close()
    return true
  })

  ipcMain.handle('window:is-maximized', async () => {
    return mainWindow?.isMaximized() || false
  })

  // 选择目录
  ipcMain.handle('window:select-directory', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: '选择下载目录'
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })

  // 列出本地目录的子目录
  ipcMain.handle('window:list-local-directories', async (_event, path: string) => {
    try {
      const entries = fs.readdirSync(path, { withFileTypes: true })
      const directories = entries
        .filter(entry => entry.isDirectory())
        .map(entry => join(path, entry.name))
      return { success: true, data: directories }
    } catch (e) {
      log.warn('Failed to list directories:', e)
      return { success: false, error: (e as Error).message }
    }
  })

  log.info('LyShell started successfully')
})

// 应用退出前清理资源 —— 窗口级快捷键随 webContents 一起销毁,不用单独 unregister
app.on('will-quit', (event) => {
  // dsh web 子进程必须等树杀真正完成再退出。此前 dshWebManager.close() 里 fire-and-forget
  // 的 spawn('taskkill') 会被 app 退出截断：实测只杀掉 shell 包裹层（cmd.exe）、漏掉真正的
  // node 孙进程，孤儿占着 DSH 会话写锁（不过期），下次开 dsh 报「当前会话已被占用」。
  // 故先拦住默认退出，同步清理照旧执行，最后等 close() 落定再 app.exit。
  // app.exit() 不再触发 will-quit，无重入；重复 quit 会让同步清理跑第二遍，各调用均幂等。
  event.preventDefault()

  cleanupAllWorkers()  // 清理所有下载 Worker
  cleanupAllUploadWorkers()  // 清理所有上传 Worker
  if (stopMcpHttpServerImpl) {
    stopMcpHttpServerImpl()  // 停止 MCP HTTP 服务器
  }
  pluginHostManager.stop()  // 停止 plugin host 子进程 + 撤销 plugin token
  // 弹窗全量清理（guest 随窗口销毁，这里只是把 pending/attached 表清空并给发起方补取消事件）
  pluginDialogManager.clearAll()
  cleanupDownloadsDir(getPluginsDir())  // 清理 URL 安装临时下载(.downloads/),防累积
  mcpAuditRepository.flushSync()  // 同步落盘 MCP 审计日志，防丢最近事件
  reachabilityProber.stop()  // 停止可达性探测定时器
  // 断开所有本地终端 PTY 进程
  for (const session of sessionManager.getAllSessions()) {
    if (session.connector && session.status === 'connected') {
      session.connector.disconnect().catch(() => {})
    }
  }

  // 关闭 dsh web 子进程（webview 随窗口一起销毁，这里只回收进程）—— 完成后才真正退出。
  // 走 closeForQuit（抢跑、不排队）：关窗时可能已经起了一轮树杀（交互路径的预算是 15s，
  // 仍远长于退出预算，且可能正卡在 8s 的进程表枚举里），排队等它落定等于没设 deadline；
  // 抢跑的这一轮优先终止 Windows Job；若 Job 绑定失败，则在预算内核对身份后树杀。
  // 身份无法确认时保留留档，由下次启动恢复，不能凭裸 PID 强杀。
  // 等待余量必须**严格大于** proc.ts 的单步下限：killPidTree 最多比 deadline 多花一步
  // （把已经发出的 taskkill 跑完），之后还要把未确认的 pid 写进留档 —— 余量不够，
  // app.exit() 就会赶在「最后一步 + 写留档」之前触发，孤儿连兜底记录都没有。
  // （closeForQuit 绝不 reject；.catch 只是保险丝。app.exit 不再触发 will-quit，无重入。）
  const QUIT_DSH_CLOSE_BUDGET_MS = 2500
  const QUIT_DSH_EXIT_GRACE_MS = KILL_STEP_TIMEOUT_FLOOR_MS + 500
  const closeBudget = new Promise<void>((resolveBudget) => {
    setTimeout(resolveBudget, QUIT_DSH_CLOSE_BUDGET_MS + QUIT_DSH_EXIT_GRACE_MS).unref?.()
  })
  Promise.race([
    dshWebManager
      .closeForQuit(Date.now() + QUIT_DSH_CLOSE_BUDGET_MS)
      .catch((err) => log.warn('dsh web close on quit failed:', err)),
    closeBudget
  ]).then(() => app.exit(0))
})

// 所有窗口关闭时退出（Windows/Linux）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// macOS 激活应用时重新创建窗口
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow()
  }
})
