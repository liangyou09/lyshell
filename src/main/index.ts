import { app, BrowserWindow, ipcMain, globalShortcut, dialog } from 'electron'
import { join } from 'path'
import log from 'electron-log'
import * as fs from 'fs'

// 导入模块
import { registerIPCHandlers } from './ipc/handlers'
import { sessionManager } from './terminal/session-manager'
import { downloadHistory } from './storage'
import { setMainWindow, setMainWindowForUpload, cleanupAllWorkers, cleanupAllUploadWorkers } from './file'

// 日志配置
log.transports.file.level = 'info'
log.transports.console.level = 'debug'

// 全局错误处理 - 避免SSH超时等错误弹出对话框
process.on('uncaughtException', (error) => {
  // SSH handshake timeout 等连接相关错误，只记录日志不弹出
  const msg = error.message || error.toString()
  if (msg.includes('handshake') || msg.includes('SSH') || msg.includes('connection') || msg.includes('timeout')) {
    log.error('Connection error (suppressed dialog):', msg)
    return
  }
  // 其他错误仍然记录但也不弹出对话框
  log.error('Uncaught exception:', error)
})

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection:', reason)
})

let mainWindow: BrowserWindow | null = null
let isDev = false

// 创建主窗口
function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    title: 'NovaShell',
    icon: join(process.resourcesPath, 'icons', 'icon.png'),
    autoHideMenuBar: true,
    frame: false, // 无边框窗口，自定义标题栏
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  })

  // 设置主窗口引用给 Worker 管理器
  setMainWindow(mainWindow)
  setMainWindowForUpload(mainWindow)

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    setMainWindow(null)  // 清除窗口引用
    setMainWindowForUpload(null)
    mainWindow = null
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// 注册全局快捷键
function registerGlobalShortcuts(): void {
  const ret = globalShortcut.register('CommandOrControl+Alt+F', () => {
    log.info('Float toggle shortcut triggered')
    mainWindow?.webContents.send('float:toggle')
  })
  if (ret) {
    log.info('Float toggle shortcut registered successfully')
  } else {
    log.warn('Float toggle shortcut registration failed - key may be in use')
  }
}

// 应用启动
app.whenReady().then(async () => {
  // 设置开发环境标志
  isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

  // 设置应用ID
  app.setAppUserModelId('com.novashell.app')

  // 初始化下载历史存储
  await downloadHistory.init()
  log.info('Download history initialized')

  // 创建主窗口
  createMainWindow()

  // 注册全局快捷键
  registerGlobalShortcuts()

  // 注册 IPC 处理器
  registerIPCHandlers()

  // 注册窗口相关 IPC 处理器
  ipcMain.handle('window:get-bounds', async () => {
    return mainWindow?.getBounds() || null
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

  log.info('NovaShell started successfully')
})

// 应用退出前注销快捷键
app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  cleanupAllWorkers()  // 清理所有下载 Worker
  cleanupAllUploadWorkers()  // 清理所有上传 Worker
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