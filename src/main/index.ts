import { app, BrowserWindow, ipcMain, dialog, shell, screen, session, webContents } from 'electron'
import { join, resolve } from 'path'
import log from 'electron-log'
import * as fs from 'fs'

// 导入模块
import { registerIPCHandlers } from './ipc/handlers'
import { downloadHistory } from './storage'
import { preferencesRepository } from './storage/repository'
import { sessionManager } from './terminal/session-manager'
import { setMainWindow, setMainWindowForUpload, cleanupAllWorkers, cleanupAllUploadWorkers } from './file'
import { reachabilityProber } from './reachability/reachability-prober'
import { mcpAuditRepository } from './storage/mcp-audit-repository'
import { pluginHostManager } from './plugin/host-mgr'
import { cleanupDownloadsDir } from './plugin/install-zip'
import { getPluginsDir } from './storage/plugin-repository'
import { dshWebManager } from './dsh/web'
import { IPC_CHANNELS, WEBBAR_DEEPLINK_SCHEMES } from '@shared/constants'
import { matchWebTabShortcut } from '@shared/webtab-shortcut'

// 日志配置
log.transports.file.level = 'info'
log.transports.console.level = 'debug'

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
const WEBBAR_PARTITION = 'persist:webbar'

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
    mainWindow = null
    // macOS 上关窗不退出应用：webview 已随窗口销毁，但 dsh web 子进程仍在，这里主动回收。
    // will-quit 里的 close() 是兜底；此处保证「关窗即停」（幂等，重复调用无害）。
    dshWebManager.close()
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
  //     （用户在插件面板输入任意网址）；空 src 放行 —— 小窗首航经渲染层 loadURL 起航
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
      if (src !== '' && !isHttpUrl(src)) {
        log.warn('Blocked webbar webview attach with non-http(s) src:', src)
        event.preventDefault()
        return
      }
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
    // 显式锁定 webview 的 webPreferences（防注入；主窗口已 sandbox/contextIsolation）
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.webSecurity = true
  })

  mainWindow.webContents.on('did-attach-webview', (_event, webContents) => {
    // 按 session partition 分流：网页访问栏（完整页签与写轮眼小窗共用）放行任意
    // http/https 导航（自由浏览），其余（dsh web）维持 origin 锁定。fromPartition
    // 返回同 partition 的 session 单例，webview 挂载的 session 与之身份相等即
    // 网页访问栏。
    const isWebbar = webContents.session === session.fromPartition(WEBBAR_PARTITION)
    webContents.setWindowOpenHandler(({ url }) => {
      // webview 一律不开新窗口/弹窗（deny，也不交系统浏览器避免泄 URL）。网页访问栏
      // （完整页签 + 小窗）的 http/https 开窗请求转发渲染层开完整网页页签（Chrome
      // 「在新标签页打开」同语义）—— target=_blank / window.open 是现代站点的主流
      // 跳转形态，纯 deny 时这些按钮表现为点了没反应；dsh web 维持纯 deny（origin
      // 锁定无浏览语义）。转发地址经渲染层 openWebTab 的 normalizeWebBarUrl 再校验
      //（IPC 边界即不可信输入），非 http/https（about:blank 等）纯拦
      if (isWebbar && isHttpUrl(url)) {
        mainWindow?.webContents.send(IPC_CHANNELS.WEB_TAB_POPUP, url)
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
    // 导航闸 —— will-navigate（锚点点击 / JS location 赋值）与 will-redirect（302/
    // meta refresh 的服务端落点）两条事件共用同一策略：实证（Electron 28 探针）锚点与
    // JS 路径只走 will-navigate、重定向落点只走 will-redirect，webRequest 网络层对外
    // 部 scheme 全程不可见 —— 少挂任一条都会漏。will-redirect 原先未挂：外部协议深链
    // （bytedance:// 等，抖音页反复重定向触发「打开APP」）经重定向直达 OS 协议处理
    // 器，Windows 弹「在 Microsoft Store 查找应用」对话框且反复刷 —— preventDefault
    // 掐的是整个导航，闸内拦下即免于触达系统
    const onNavGate = (event: { preventDefault(): void }, url: string): void => {
      try {
        const target = new URL(url)
        if (isWebbar) {
          // 网页访问栏（完整页签 + 写轮眼小窗）：仅拦非 http/https（file://、chrome://、
          // 外部协议深链等 —— 未注册 scheme 触达 OS 即弹系统对话框）
          if (target.protocol === 'http:' || target.protocol === 'https:') return
          event.preventDefault()
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
    // 子框架闸（will-frame-navigate 先于 will-navigate 触发且覆盖子框架）：只掐外部
    // 协议 —— http/https 子框架（广告 iframe 常态）照常放行；dsh 的 origin 锁维持
    // 主框架语义不外溢到子框架。实证（探针）：子框架/按钮 onclick 的外部 scheme
    // 导航只在此事件露头
    webContents.on('will-frame-navigate', (e) => {
      try {
        if (new URL(e.url).protocol === 'http:' || new URL(e.url).protocol === 'https:') return
      } catch { /* 畸形地址落到下面拦 */ }
      e.preventDefault()
      log.warn('Blocked webview frame navigation:', e.url)
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

// 应用启动
app.whenReady().then(async () => {
  // 设置应用ID
  app.setAppUserModelId('com.lyshell.app')

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

  // 启动 plugin host（依赖 MCP HTTP server 已就绪；无 enabled 插件时为 no-op）
  try {
    pluginHostManager.start()
  } catch (err) {
    log.error('Failed to start plugin host:', err)
  }

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
  const webbarSession = session.fromPartition(WEBBAR_PARTITION)
  for (const scheme of WEBBAR_DEEPLINK_SCHEMES) {
    try {
      webbarSession.protocol.handle(scheme, () => new Response(null, { status: 204 }))
      log.info(`Registered webbar deep-link scheme handler: ${scheme}://`)
    } catch (err) {
      log.warn(`Failed to register deep-link scheme handler (${scheme}):`, err)
    }
  }

  // 注册窗口级快捷键(必须在 createMainWindow 之后,因为依赖 mainWindow.webContents)
  registerWindowShortcuts()

  // 注册 IPC 处理器
  registerIPCHandlers()

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
app.on('will-quit', () => {
  cleanupAllWorkers()  // 清理所有下载 Worker
  cleanupAllUploadWorkers()  // 清理所有上传 Worker
  dshWebManager.close()  // 关闭 dsh web 子进程（webview 随窗口一起销毁，这里只回收进程）
  if (stopMcpHttpServerImpl) {
    stopMcpHttpServerImpl()  // 停止 MCP HTTP 服务器
  }
  pluginHostManager.stop()  // 停止 plugin host 子进程 + 撤销 plugin token
  cleanupDownloadsDir(getPluginsDir())  // 清理 URL 安装临时下载(.downloads/),防累积
  mcpAuditRepository.flushSync()  // 同步落盘 MCP 审计日志，防丢最近事件
  reachabilityProber.stop()  // 停止可达性探测定时器
  // 断开所有本地终端 PTY 进程
  for (const session of sessionManager.getAllSessions()) {
    if (session.connector && session.status === 'connected') {
      session.connector.disconnect().catch(() => {})
    }
  }
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
