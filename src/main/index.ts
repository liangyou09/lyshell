import { app, BrowserWindow, ipcMain, dialog, shell, screen } from 'electron'
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
      allowRunningInsecureContent: false
    }
  })

  // 设置主窗口引用给 Worker 管理器
  setMainWindow(mainWindow)
  setMainWindowForUpload(mainWindow)

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
  if (!__DISABLE_MCP__) {
    try {
      const { startMcpHttpServer, stopMcpHttpServer } = await import('@main/mcp/http-server')
      await startMcpHttpServer()
      stopMcpHttpServerImpl = stopMcpHttpServer
    } catch (err) {
      log.error('Failed to start MCP HTTP server:', err)
    }
  }

  // 启动 plugin host（依赖 MCP HTTP server 已就绪；无 enabled 插件时为 no-op）
  try {
    pluginHostManager.start()
  } catch (err) {
    log.error('Failed to start plugin host:', err)
  }

  // 创建主窗口
  createMainWindow()

  // 注册窗口级快捷键(必须在 createMainWindow 之后,因为依赖 mainWindow.webContents)
  registerWindowShortcuts()

  // 注册 IPC 处理器
  registerIPCHandlers()

  // 注册窗口相关 IPC 处理器
  ipcMain.handle('window:get-bounds', async () => {
    return mainWindow?.getBounds() || null
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