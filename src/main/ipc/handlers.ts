import { ipcMain, BrowserWindow, dialog, shell } from 'electron'
import { writeFile, readFile } from 'fs/promises'
import * as path from 'path'
import * as fs from 'fs'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'
import log from 'electron-log'
import { v4 as uuidv4 } from 'uuid'
import { sessionManager, extractErrorMessage } from '../terminal/session-manager'
import { sessionRepository, preferencesRepository, quickCommandsRepository } from '../storage/repository'
import { downloadHistory, DownloadRecord } from '../storage'
import { pythonEngine } from '../python/engine'
import { ConnectionStatus, SSHConnector } from '../connectors'
import { ConnectionType } from '@shared/types'
import { fileManager, downloadQueue, startDownloadWorker, registerTaskMeta, startUploadWorker } from '../file'
import type { SessionConfig } from '@shared/types'

/**
 * 任务元信息（用于保存下载记录）
 */
interface TaskMeta {
  taskId: string
  sessionId: string
  direction: 'upload' | 'download'
  remotePath: string
  localPath: string
  fileName: string
  fileSize: number
  startTime: Date
}

// 任务元信息存储
const taskMetaStore: Map<string, TaskMeta> = new Map()

/**
 * IPC 通道定义
 */
export const IPC_CHANNELS = {
  // 连接管理
  CONNECTION_CONNECT: 'connection:connect',
  CONNECTION_DISCONNECT: 'connection:disconnect',
  CONNECTION_RECONNECT: 'connection:reconnect',
  CONNECTION_STATUS: 'connection:status',
  CONNECTION_CLONE_CHANNEL: 'connection:clone-channel',  // 克隆渠道

  // 会话管理
  SESSION_CREATE: 'session:create',
  SESSION_UPDATE: 'session:update',
  SESSION_DELETE: 'session:delete',
  SESSION_LIST: 'session:list',
  SESSION_GET: 'session:get',
  SESSION_FAVORITES: 'session:favorites',
  SESSION_RECENT: 'session:recent',

  // 终端操作
  TERMINAL_WRITE: 'terminal:write',
  TERMINAL_RESIZE: 'terminal:resize',
  TERMINAL_DATA: 'terminal:data',
  TERMINAL_EXIT: 'terminal:exit',

  // Python 执行
  PYTHON_EXECUTE: 'python:execute',
  PYTHON_SCRIPT: 'python:script',
  PYTHON_TERMINATE: 'python:terminate',
  PYTHON_OUTPUT: 'python:output',

  // AI 功能
  AI_QUERY: 'ai:query',
  AI_STREAM: 'ai:stream',
  AI_CANCEL: 'ai:cancel',

  // 配置管理
  CONFIG_GET: 'config:get',
  CONFIG_SET: 'config:set',
  CONFIG_RESET: 'config:reset',

  // 命令历史
  HISTORY_LIST: 'history:list',
  HISTORY_ADD: 'history:add',
  HISTORY_FAVORITE: 'history:favorite',
  HISTORY_DELETE: 'history:delete',
  HISTORY_CLEAR: 'history:clear',

  // 快速命令
  COMMAND_LIST: 'command:list',
  COMMAND_SAVE_ALL: 'command:save-all',
  COMMAND_ADD: 'command:add',
  COMMAND_UPDATE: 'command:update',
  COMMAND_DELETE: 'command:delete',

  // 浮窗
  FLOAT_SHOW: 'float:show',
  FLOAT_HIDE: 'float:hide',
  FLOAT_TOGGLE: 'float:toggle',

  // 数据导出导入
  DATA_EXPORT: 'data:export',
  DATA_IMPORT: 'data:import',

  // 会话去重
  SESSION_DEDUPLICATE: 'session:deduplicate',

  // 文件操作
  FILE_LIST: 'file:list',
  FILE_STAT: 'file:stat',
  FILE_UPLOAD: 'file:upload',
  FILE_DOWNLOAD: 'file:download',
  FILE_DELETE: 'file:delete',
  FILE_RENAME: 'file:rename',
  FILE_MKDIR: 'file:mkdir',
  FILE_PROGRESS: 'file:progress',
  FILE_CONNECTOR_TYPE: 'file:connector-type',
  FILE_OPEN_FOLDER: 'file:open-folder',  // 打开文件夹
  FILE_MD5: 'file:md5',  // 计算远程文件MD5
  FILE_PWD: 'file:pwd',  // 获取当前工作目录

  // 下载记录
  DOWNLOAD_HISTORY_LIST: 'download-history:list',
  DOWNLOAD_HISTORY_CLEAR: 'download-history:clear',
  DOWNLOAD_HISTORY_DELETE: 'download-history:delete',
  DOWNLOAD_CONFIG_GET: 'download-config:get',
  DOWNLOAD_CONFIG_SET: 'download-config:set',
  DOWNLOAD_DIR_GET: 'download-dir:get',

  // 窗口
  WINDOW_GET_BOUNDS: 'window:get-bounds',
  WINDOW_SEND_TO_SESSION: 'window:send-to-session',
  SELECT_DIRECTORY: 'window:select-directory',  // 选择目录
  LIST_LOCAL_DIRECTORIES: 'window:list-local-directories'  // 列出本地目录
}

/**
 * 获取所有窗口
 */
function getAllWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows()
}

/**
 * 向所有窗口发送事件
 */
function sendToAllWindows(channel: string, ...args: any[]): void {
  for (const win of getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, ...args)
    }
  }
}

/**
 * 注册所有 IPC 处理器
 */
export function registerIPCHandlers(): void {
  log.info('Registering IPC handlers...')

  // ========== 连接管理 ==========

  ipcMain.handle(IPC_CHANNELS.CONNECTION_CONNECT, async (_event, config: SessionConfig) => {
    log.debug('Connection request:', config.id, 'name:', config.name)

    try {
      // 空 id 表示临时会话，直接创建新连接
      if (!config.id || config.id.trim() === '') {
        // 设置创建时间用于前端排序编号
        config.createdAt = new Date()
        config.updatedAt = new Date()
        const session = await sessionManager.createSession(config)

        // 立即返回会话ID，让前端先显示终端
        // 然后异步执行连接
        const sessionId = session.id

        // 发送连接开始状态（前端收到后立即显示终端）
        sendToAllWindows(IPC_CHANNELS.CONNECTION_STATUS, { id: sessionId, status: ConnectionStatus.CONNECTING })

        // 异步连接，不阻塞返回
        sessionManager.connectSession(sessionId).catch(err => {
          log.error('Async connection failed:', extractErrorMessage(err))
        })

        return {
          id: sessionId,
          status: ConnectionStatus.CONNECTING,
          config: session.config
        }
      }

      // 有有效 id，保存并连接
      const savedConfig = sessionRepository.saveSession(config)

      const existingSession = sessionManager.getSession(config.id)
      if (existingSession && existingSession.status === ConnectionStatus.CONNECTED) {
        log.debug('Session already connected:', config.id)
        return {
          id: existingSession.id,
          status: existingSession.status,
          config: existingSession.config
        }
      }

      const session = await sessionManager.createSession(savedConfig)
      const sessionId = session.id

      // 立即返回会话ID，让前端先显示终端
      sendToAllWindows(IPC_CHANNELS.CONNECTION_STATUS, { id: sessionId, status: ConnectionStatus.CONNECTING })

      // 异步连接，不阻塞返回
      sessionManager.connectSession(sessionId).catch(err => {
        log.error('Async connection failed:', extractErrorMessage(err))
      })

      return {
        id: sessionId,
        status: ConnectionStatus.CONNECTING,
        config: session.config
      }
    } catch (error) {
      log.error('Connection failed:', extractErrorMessage(error as Error))
      // 返回错误状态，让前端处理
      return {
        id: config.id || 'temp',
        status: ConnectionStatus.ERROR,
        error: extractErrorMessage(error as Error),
        config
      }
    }
  })

  ipcMain.handle(IPC_CHANNELS.CONNECTION_DISCONNECT, async (_event, sessionId: string) => {
    log.debug('Disconnect request:', sessionId)
    await sessionManager.disconnectSession(sessionId)
    return { success: true }
  })

  ipcMain.handle(IPC_CHANNELS.CONNECTION_RECONNECT, async (_event, sessionId: string) => {
    log.debug('Reconnect request:', sessionId)
    const session = await sessionManager.reconnectSession(sessionId)
    return {
      id: session.id,
      status: session.status
    }
  })

  // 克隆渠道（在现有 SSH 连接上创建新 shell channel）
  ipcMain.handle(IPC_CHANNELS.CONNECTION_CLONE_CHANNEL, async (_event, sourceSessionId: string) => {
    log.debug('Clone channel request:', sourceSessionId)
    const result = await sessionManager.cloneChannel(sourceSessionId)
    return result
  })

  // 监听会话状态变化，发送到所有窗口
  sessionManager.on('session:status', (data) => {
    sendToAllWindows(IPC_CHANNELS.CONNECTION_STATUS, data)

    // 当会话连接成功时，立即预初始化文件传输连接
    // 尽早开始，让下载时连接已准备好
    if (data.status === 'connected') {
      setTimeout(() => {
        fileManager.getConnector(data.id).then(() => {
          log.info(`File connector pre-initialized for session: ${data.id}`)
        }).catch(err => {
          log.warn(`Failed to pre-init file connector for ${data.id}:`, err.message)
        })
      }, 200)  // 延迟 200ms，让终端先处理几帧数据后立即初始化连接
    }
  })

  // 监听终端数据，发送到所有窗口
  sessionManager.on('terminal:data', (data) => {
    log.debug(`Sending terminal data to windows: ${data.sessionId}, ${data.data.length} bytes`)
    sendToAllWindows(IPC_CHANNELS.TERMINAL_DATA, data.sessionId, data.data)
  })

  // ========== 会话管理 ==========

  ipcMain.handle(IPC_CHANNELS.SESSION_CREATE, async (_event, config: SessionConfig) => {
    log.debug('Create session:', config.name)
    const saved = sessionRepository.saveSession(config)
    return saved
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_UPDATE, async (_event, config: SessionConfig) => {
    log.debug('Update session:', config.id)
    const saved = sessionRepository.saveSession(config)
    return saved
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_DELETE, async (_event, sessionId: string) => {
    log.debug('Delete session:', sessionId)
    // 先断开连接
    try {
      await sessionManager.disconnectSession(sessionId)
    } catch (e) {
      // 忽略错误
    }
    // 删除存储
    sessionRepository.delete(sessionId)
    return { success: true }
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_LIST, async () => {
    log.debug('List sessions')
    return sessionRepository.getAll()
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_GET, async (_event, sessionId: string) => {
    log.debug('Get session:', sessionId)
    // 先从存储获取，如果没有则从 sessionManager 获取（临时会话）
    const stored = sessionRepository.get(sessionId)
    if (stored) return stored

    const session = sessionManager.getSession(sessionId)
    return session?.config || null
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_FAVORITES, async () => {
    log.debug('Get favorite sessions')
    return sessionRepository.getFavorites()
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_RECENT, async (_event, limit?: number) => {
    log.debug('Get recent sessions')
    return sessionRepository.getRecent(limit || 10)
  })

  // 会话去重
  ipcMain.handle(IPC_CHANNELS.SESSION_DEDUPLICATE, async () => {
    log.info('Deduplicating sessions...')
    const result = sessionRepository.deduplicate()
    return result
  })

  // ========== 终端操作 ==========

  ipcMain.on(IPC_CHANNELS.TERMINAL_WRITE, (event, sessionId: string, data: string) => {
    log.debug('Terminal write:', sessionId, data.length)
    sessionManager.writeToSession(sessionId, data)
  })

  ipcMain.on(IPC_CHANNELS.TERMINAL_RESIZE, (event, sessionId: string, cols: number, rows: number) => {
    log.debug('Terminal resize:', sessionId, cols, rows)
    sessionManager.resizeSession(sessionId, cols, rows)
  })

  // ========== 命令历史 ==========

  // 使用简单数组存储（暂时）
  let commandHistory: any[] = []

  ipcMain.handle(IPC_CHANNELS.HISTORY_LIST, async () => {
    return commandHistory
  })

  ipcMain.handle(IPC_CHANNELS.HISTORY_ADD, async (_event, entry) => {
    entry.id = Date.now().toString()
    entry.executedAt = new Date()
    commandHistory.unshift(entry)
    // 限制历史数量
    if (commandHistory.length > 200) {
      commandHistory = commandHistory.slice(0, 200)
    }
    return entry
  })

  ipcMain.handle(IPC_CHANNELS.HISTORY_FAVORITE, async (_event, historyId: string) => {
    const entry = commandHistory.find(h => h.id === historyId)
    if (entry) {
      entry.isFavorite = !entry.isFavorite
    }
    return entry
  })

  ipcMain.handle(IPC_CHANNELS.HISTORY_DELETE, async (_event, historyId: string) => {
    commandHistory = commandHistory.filter(h => h.id !== historyId)
    return { success: true }
  })

  ipcMain.handle(IPC_CHANNELS.HISTORY_CLEAR, async () => {
    commandHistory = []
    return { success: true }
  })

  // ========== 快速命令 ==========

  // ========== 快速命令 ==========

  ipcMain.handle(IPC_CHANNELS.COMMAND_LIST, async () => {
    return quickCommandsRepository.getAll()
  })

  ipcMain.handle(IPC_CHANNELS.COMMAND_SAVE_ALL, async (_event, commands: any[]) => {
    quickCommandsRepository.saveAll(commands)
    return { success: true }
  })

  ipcMain.handle(IPC_CHANNELS.COMMAND_ADD, async (_event, command) => {
    const saved = quickCommandsRepository.add(command)
    return saved
  })

  ipcMain.handle(IPC_CHANNELS.COMMAND_UPDATE, async (_event, command) => {
    const success = quickCommandsRepository.update(command)
    return { success }
  })

  ipcMain.handle(IPC_CHANNELS.COMMAND_DELETE, async (_event, commandId: string) => {
    const success = quickCommandsRepository.delete(commandId)
    return { success }
  })

  // ========== Python 执行 ==========

  ipcMain.handle(IPC_CHANNELS.PYTHON_EXECUTE, async (_event, code: string, context?: any) => {
    log.debug('Python execute:', code.substring(0, 50))

    const result = await pythonEngine.execute(code, context)

    // 发送输出事件
    if (result.stdout) {
      sendToAllWindows(IPC_CHANNELS.PYTHON_OUTPUT, {
        type: 'stdout',
        data: result.stdout
      })
    }

    return result
  })

  ipcMain.handle(IPC_CHANNELS.PYTHON_SCRIPT, async (_event, path: string, args?: string[]) => {
    log.debug('Python script:', path, args)

    const result = await pythonEngine.runScript(path, args)
    return result
  })

  ipcMain.handle(IPC_CHANNELS.PYTHON_TERMINATE, async (_event, executionId: string) => {
    log.debug('Python terminate:', executionId)
    pythonEngine.terminate(executionId)
    return { success: true }
  })

  // ========== AI 功能 ==========

  ipcMain.handle(IPC_CHANNELS.AI_QUERY, async (_event, request: any) => {
    log.debug('AI query:', request)
    // TODO: 实现 AI 查询
    throw new Error('AI agent not implemented yet')
  })

  ipcMain.handle(IPC_CHANNELS.AI_STREAM, async (event, request: any) => {
    log.debug('AI stream:', request)
    // TODO: 实现流式响应
    throw new Error('AI agent not implemented yet')
  })

  ipcMain.handle(IPC_CHANNELS.AI_CANCEL, async () => {
    log.debug('AI cancel')
    // TODO: 实现取消
  })

  // ========== 配置管理 ==========

  ipcMain.handle(IPC_CHANNELS.CONFIG_GET, async (_event, key: string) => {
    log.debug('Get config:', key)
    return preferencesRepository.get(key)
  })

  ipcMain.handle(IPC_CHANNELS.CONFIG_SET, async (_event, key: string, value: any) => {
    log.debug('Set config:', key, value)
    preferencesRepository.set(key, value)
    return { success: true }
  })

  ipcMain.handle(IPC_CHANNELS.CONFIG_RESET, async () => {
    log.debug('Reset config')
    preferencesRepository.reset()
    return { success: true }
  })

  // ========== 窗口操作 ==========

  ipcMain.handle(IPC_CHANNELS.WINDOW_SEND_TO_SESSION, async (_event, sessionId: string, data: string) => {
    log.debug('Send to session:', sessionId)
    sessionManager.writeToSession(sessionId, data)
    return { success: true }
  })

  // ========== 数据导出导入 ==========

  // 加密敏感字段
  const encryptField = (text: string, password: string): string => {
    if (!text) return text
    const salt = randomBytes(16)
    const key = scryptSync(password, salt, 32)
    const iv = randomBytes(16)
    const cipher = createCipheriv('aes-256-cbc', key, iv)
    let encrypted = cipher.update(text, 'utf8', 'hex')
    encrypted += cipher.final('hex')
    return `enc:${salt.toString('hex')}:${iv.toString('hex')}:${encrypted}`
  }

  // 解密敏感字段
  const decryptField = (text: string, password: string): string => {
    if (!text || !text.startsWith('enc:')) return text
    try {
      const parts = text.split(':')
      if (parts.length !== 4) return text
      const salt = Buffer.from(parts[1], 'hex')
      const iv = Buffer.from(parts[2], 'hex')
      const encrypted = parts[3]
      const key = scryptSync(password, salt, 32)
      const decipher = createDecipheriv('aes-256-cbc', key, iv)
      let decrypted = decipher.update(encrypted, 'hex', 'utf8')
      decrypted += decipher.final('utf8')
      return decrypted
    } catch {
      return text // 解密失败返回原文
    }
  }

  // 加密会话中的敏感字段
  const encryptSession = (session: any, password: string): any => {
    const encrypted = { ...session }
    if (encrypted.ssh?.password) {
      encrypted.ssh.password = encryptField(encrypted.ssh.password, password)
    }
    if (encrypted.ssh?.privateKey) {
      encrypted.ssh.privateKey = encryptField(encrypted.ssh.privateKey, password)
    }
    if (encrypted.ssh?.passphrase) {
      encrypted.ssh.passphrase = encryptField(encrypted.ssh.passphrase, password)
    }
    return encrypted
  }

  // 解密会话中的敏感字段
  const decryptSession = (session: any, password: string): any => {
    const decrypted = { ...session }
    if (decrypted.ssh?.password) {
      decrypted.ssh.password = decryptField(decrypted.ssh.password, password)
    }
    if (decrypted.ssh?.privateKey) {
      decrypted.ssh.privateKey = decryptField(decrypted.ssh.privateKey, password)
    }
    if (decrypted.ssh?.passphrase) {
      decrypted.ssh.passphrase = decryptField(decrypted.ssh.passphrase, password)
    }
    return decrypted
  }

  ipcMain.handle(IPC_CHANNELS.DATA_EXPORT, async (_event, data: { sessions: any[], quickCommands: any[], encryptPassword?: string }) => {
    log.debug('Export data:', data.sessions?.length, 'sessions,', data.quickCommands?.length, 'commands, encrypted:', !!data.encryptPassword)

    const result = await dialog.showSaveDialog({
      title: '导出配置数据',
      defaultPath: `novashell-config-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [
        { name: 'JSON 文件', extensions: ['json'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })

    if (result.canceled || !result.filePath) {
      return { success: false, message: '用户取消导出' }
    }

    try {
      // 如果有加密密码，加密敏感字段
      const sessions = data.encryptPassword
        ? data.sessions.map(s => encryptSession(s, data.encryptPassword!))
        : data.sessions

      const exportData = {
        version: '1.0',
        encrypted: !!data.encryptPassword,
        exportedAt: new Date().toISOString(),
        sessions: sessions || [],
        quickCommands: data.quickCommands || []
      }

      await writeFile(result.filePath, JSON.stringify(exportData, null, 2), 'utf-8')
      log.info('Data exported to:', result.filePath, 'encrypted:', !!data.encryptPassword)
      return { success: true, path: result.filePath, encrypted: !!data.encryptPassword }
    } catch (error) {
      log.error('Export failed:', error)
      return { success: false, message: (error as Error).message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.DATA_IMPORT, async (_event, decryptPassword?: string) => {
    log.debug('Import data, decrypt password provided:', !!decryptPassword)

    const result = await dialog.showOpenDialog({
      title: '导入配置数据',
      filters: [
        { name: 'JSON 文件', extensions: ['json'] },
        { name: '所有文件', extensions: ['*'] }
      ],
      properties: ['openFile']
    })

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, message: '用户取消导入' }
    }

    try {
      const content = await readFile(result.filePaths[0], 'utf-8')
      const importData = JSON.parse(content)

      // 验证格式
      if (!importData.version || !importData.sessions) {
        return { success: false, message: '文件格式无效' }
      }

      // 检查是否需要解密
      if (importData.encrypted && !decryptPassword) {
        return { success: true, needPassword: true, path: result.filePaths[0] }
      }

      // 解密会话数据
      let sessions = importData.sessions
      if (importData.encrypted && decryptPassword) {
        sessions = sessions.map(s => decryptSession(s, decryptPassword))
      }

      log.info('Data imported from:', result.filePaths[0])
      return {
        success: true,
        path: result.filePaths[0],
        encrypted: importData.encrypted,
        data: {
          sessions: sessions,
          quickCommands: importData.quickCommands || []
        }
      }
    } catch (error) {
      log.error('Import failed:', error)
      return { success: false, message: (error as Error).message }
    }
  })

  // 设置 fileManager 的获取 SSH 配置回调
  // FileManager 会使用独立的 SSH 连接进行文件传输
  fileManager.setGetSSHConfigFn((sessionId: string) => {
    const session = sessionManager.getSession(sessionId)
    log.debug(`getSSHConfig for session ${sessionId}, session:`, session ? 'found' : 'not found')
    if (!session) {
      log.debug(`No session for ${sessionId}`)
      return null
    }
    // 只有 SSH 连接支持文件操作
    if (session.config.type !== ConnectionType.SSH) {
      log.debug(`Session ${sessionId} is not SSH type: ${session.config.type}`)
      return null
    }

    // 检查连接状态是否就绪
    if (session.status !== ConnectionStatus.CONNECTED) {
      log.debug(`Session ${sessionId} is not connected (status: ${session.status})`)
      return null
    }

    // 返回 SSH 配置，FileManager 会建立独立的 SSH 连接
    const sshConfig = session.config.ssh
    log.debug(`Got SSH config for ${sessionId}:`, sshConfig ? 'found' : 'not found')
    return sshConfig
  })

  // 监听文件传输进度，发送到所有窗口
  fileManager.on('transfer:progress', (progress) => {
    sendToAllWindows(IPC_CHANNELS.FILE_PROGRESS, {
      taskId: progress.taskId,
      sessionId: progress.sessionId,
      progress: progress.progress,
      transferredSize: progress.transferredSize,
      fileSize: progress.fileSize,
      speed: progress.speed,
      direction: progress.direction || 'download'
    })
  })

  fileManager.on('transfer:completed', (info) => {
    // 发送完成事件到所有窗口
    sendToAllWindows(IPC_CHANNELS.FILE_PROGRESS, {
      taskId: info.taskId,
      sessionId: info.sessionId,
      progress: 100,
      completed: true,
      direction: info.direction,
      md5: info.md5  // 可能是 undefined，后续通过 md5 事件更新
    })

    // 如果是下载，异步保存下载记录
    if (info.direction === 'download') {
      const taskMeta = taskMetaStore.get(info.taskId)
      if (taskMeta) {
        const session = sessionManager.getSession(info.sessionId)
        const sshConfig = session?.config.ssh

        const record: DownloadRecord = {
          id: uuidv4(),
          sessionId: info.sessionId,
          sessionName: session?.config.name || 'Unknown',
          host: sshConfig?.host || '',
          port: sshConfig?.port || 22,
          remotePath: taskMeta.remotePath,
          localPath: taskMeta.localPath,
          fileName: taskMeta.fileName,
          fileSize: taskMeta.fileSize,
          startTime: taskMeta.startTime,
          endTime: new Date(),
          status: 'success',
          md5: info.md5,  // 可能是 undefined
          downloadDir: downloadHistory.getDownloadDir(
            info.sessionId,
            session?.config.name || '',
            sshConfig?.host || '',
            sshConfig?.port || 22
          )
        }

        // 异步保存记录，不等待
        downloadHistory.addRecord(record).then(() => {
          log.info(`Download record saved: ${record.fileName}`)
        }).catch(err => {
          log.error('Failed to save download record:', err)
        })

        // 清理任务元信息
        taskMetaStore.delete(info.taskId)
      }
    } else {
      // 上传完成，清理任务元信息
      taskMetaStore.delete(info.taskId)
    }
  })

  // 监听 MD5 计算完成事件
  fileManager.on('transfer:md5', (info) => {
    // 发送 MD5 更新到所有窗口
    sendToAllWindows(IPC_CHANNELS.FILE_PROGRESS, {
      taskId: info.taskId,
      sessionId: info.sessionId,
      md5: info.md5,
      md5Update: true  // 标记这是 MD5 更新
    })

    // 异步更新下载记录中的 MD5
    downloadHistory.updateRecordByTaskId?.(info.taskId, { md5: info.md5 }).catch(err => {
      log.warn('Failed to update MD5 in record:', err)
    })
  })

  // ========== 文件操作 ==========

  ipcMain.handle(IPC_CHANNELS.FILE_LIST, async (_event, sessionId: string, path: string) => {
    log.debug('File list:', sessionId, path)
    try {
      const files = await fileManager.listDir(sessionId, path)
      return { success: true, data: files }
    } catch (error) {
      log.error('File list error:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // 获取当前工作目录（home 目录）
  ipcMain.handle(IPC_CHANNELS.FILE_PWD, async (_event, sessionId: string) => {
    log.debug('File pwd:', sessionId)
    try {
      // 通过获取 connector 来执行 pwd 命令
      const connector = await fileManager.getConnector(sessionId)
      if (connector && connector.execRaw) {
        const pwd = await connector.execRaw('pwd')
        return { success: true, data: pwd.trim() }
      }
      return { success: false, error: 'Cannot execute command' }
    } catch (error) {
      log.error('File pwd error:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.FILE_STAT, async (_event, sessionId: string, path: string) => {
    log.debug('File stat:', sessionId, path)
    try {
      const info = await fileManager.stat(sessionId, path)
      return { success: true, data: info }
    } catch (error) {
      log.error('File stat error:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.FILE_UPLOAD, async (_event, sessionId: string, localPath: string, remotePath: string, taskId: string) => {
    log.debug('File upload:', sessionId, localPath, '->', remotePath)

    // 获取会话
    const session = sessionManager.getSession(sessionId)
    if (!session) {
      log.error('Session not found:', sessionId)
      // 发送错误进度消息
      sendToAllWindows(IPC_CHANNELS.FILE_PROGRESS, {
        taskId,
        sessionId,
        failed: true,
        error: 'Session not found',
        progress: 0,
        direction: 'upload'
      })
      return { success: false, error: 'Session not found' }
    }

    const sshConfig = session.config.ssh
    if (!sshConfig) {
      log.error('SSH config not found:', sessionId)
      // 发送错误进度消息
      sendToAllWindows(IPC_CHANNELS.FILE_PROGRESS, {
        taskId,
        sessionId,
        failed: true,
        error: 'SSH config not found',
        progress: 0,
        direction: 'upload'
      })
      return { success: false, error: 'SSH config not found' }
    }

    // 获取本地文件大小
    let fileSize = 0
    try {
      const stat = fs.statSync(localPath)
      fileSize = stat.size
    } catch (err) {
      log.error('Local file not found:', localPath)
      // 发送错误进度消息
      sendToAllWindows(IPC_CHANNELS.FILE_PROGRESS, {
        taskId,
        sessionId,
        failed: true,
        error: 'Local file not found',
        progress: 0,
        direction: 'upload'
      })
      return { success: false, error: 'Local file not found' }
    }

    // 获取 connector 类型
    try {
      const connectorType = await fileManager.getConnectorType(sessionId)
      log.debug(`Connector type for upload: ${connectorType}`)

      // 使用 Worker 线程上传（不阻塞主进程）
      await startUploadWorker({
        taskId,
        sessionId,
        method: connectorType === 'sftp' ? 'sftp' : 'exec',
        sshConfig: {
          host: sshConfig.host,
          port: sshConfig.port,
          username: sshConfig.username,
          password: sshConfig.password,
          privateKey: sshConfig.privateKey,
          passphrase: sshConfig.passphrase,
          readyTimeout: sshConfig.readyTimeout,
          keepaliveInterval: sshConfig.keepaliveInterval,
          shellEnterCommands: sshConfig.shellEnterCommands,
          shellEnterWait: sshConfig.shellEnterWait
        },
        localPath,
        remotePath,
        fileSize
      })
      log.info(`Upload worker started for ${path.basename(localPath)} (${connectorType})`)
      return { success: true, started: true, method: connectorType }
    } catch (err) {
      const error = err as Error
      log.error('Failed to start upload:', error.message)
      // 发送错误进度消息
      sendToAllWindows(IPC_CHANNELS.FILE_PROGRESS, {
        taskId,
        sessionId,
        failed: true,
        error: error.message,
        progress: 0,
        direction: 'upload'
      })
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.FILE_DOWNLOAD, async (_event, sessionId: string, remotePath: string, localPath: string, taskId: string, fileName: string, fileSize: number) => {
    log.debug('File download:', sessionId, remotePath, '->', localPath)

    // 获取会话
    const session = sessionManager.getSession(sessionId)
    if (!session) {
      log.error('Session not found:', sessionId)
      return { success: false, error: 'Session not found' }
    }

    const sshConfig = session.config.ssh
    if (!sshConfig) {
      log.error('SSH config not found:', sessionId)
      return { success: false, error: 'SSH config not found' }
    }

    // 获取 connector 类型
    try {
      const connectorType = await fileManager.getConnectorType(sessionId)
      log.debug(`Connector type for session ${sessionId}: ${connectorType}`)

      // 注册任务元信息（用于保存下载记录）
      registerTaskMeta(taskId, {
        taskId,
        sessionId,
        remotePath,
        localPath,
        fileName,
        fileSize,
        startTime: new Date(),
        sessionName: session.config.name
      })

      // SFTP 和 EXEC 都使用 Worker 线程（不阻塞主进程）
      await startDownloadWorker({
        taskId,
        sessionId,
        method: connectorType === 'sftp' ? 'sftp' : 'exec',
        sshConfig: {
          host: sshConfig.host,
          port: sshConfig.port,
          username: sshConfig.username,
          password: sshConfig.password,
          privateKey: sshConfig.privateKey,
          passphrase: sshConfig.passphrase,
          readyTimeout: sshConfig.readyTimeout,
          keepaliveInterval: sshConfig.keepaliveInterval,
          shellEnterCommands: sshConfig.shellEnterCommands,
          shellEnterWait: sshConfig.shellEnterWait
        },
        remotePath,
        localPath,
        fileSize
      })
      log.info(`Download worker started for ${fileName} (${connectorType})`)
      return { success: true, started: true, method: connectorType }
    } catch (err) {
      const error = err as Error
      log.error('Failed to start download:', error.message)
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.FILE_DELETE, async (_event, sessionId: string, path: string) => {
    log.debug('File delete:', sessionId, path)
    try {
      await fileManager.delete(sessionId, path)
      return { success: true }
    } catch (error) {
      log.error('File delete error:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.FILE_RENAME, async (_event, sessionId: string, oldPath: string, newPath: string) => {
    log.debug('File rename:', sessionId, oldPath, '->', newPath)
    try {
      await fileManager.rename(sessionId, oldPath, newPath)
      return { success: true }
    } catch (error) {
      log.error('File rename error:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.FILE_MKDIR, async (_event, sessionId: string, path: string) => {
    log.debug('File mkdir:', sessionId, path)
    try {
      await fileManager.mkdir(sessionId, path)
      return { success: true }
    } catch (error) {
      log.error('File mkdir error:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.FILE_CONNECTOR_TYPE, async (_event, sessionId: string) => {
    log.debug('Get file connector type:', sessionId)
    try {
      const type = await fileManager.getConnectorType(sessionId)
      return { success: true, data: type }
    } catch (error) {
      log.error('Get connector type error:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.FILE_MD5, async (_event, sessionId: string, filePath: string) => {
    log.debug('Calculate file MD5:', sessionId, filePath)
    try {
      const md5 = await fileManager.calculateRemoteMD5(sessionId, filePath)
      return { success: true, data: md5 }
    } catch (error) {
      log.error('Calculate MD5 error:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // ========== Dialog API ==========

  ipcMain.handle('dialog:open', async (_event, options: any) => {
    log.debug('Show open dialog')
    const result = await dialog.showOpenDialog(options)
    return result
  })

  ipcMain.handle('dialog:save', async (_event, options: any) => {
    log.debug('Show save dialog')
    const result = await dialog.showSaveDialog(options)
    return result
  })

  ipcMain.handle('dialog:message', async (_event, options: any) => {
    log.debug('Show message box')
    const result = await dialog.showMessageBox(options)
    return result
  })

  // 打开文件夹（直接打开目录，而不是打开父目录并选中）
  ipcMain.handle(IPC_CHANNELS.FILE_OPEN_FOLDER, async (_event, filePath: string) => {
    log.debug('Open folder:', filePath)
    try {
      // shell.openPath 直接打开目录/文件
      shell.openPath(filePath)
      return { success: true }
    } catch (error) {
      log.error('Open folder error:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // ========== 下载记录 ==========

  ipcMain.handle(IPC_CHANNELS.DOWNLOAD_HISTORY_LIST, async (_event, sessionId?: string) => {
    log.debug('Get download history:', sessionId)
    try {
      const records = sessionId
        ? downloadHistory.getRecordsByServer(sessionId)
        : downloadHistory.getAllRecords()
      return { success: true, data: records }
    } catch (error) {
      log.error('Get download history error:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.DOWNLOAD_HISTORY_CLEAR, async () => {
    log.debug('Clear download history')
    try {
      await downloadHistory.clearAll()
      return { success: true }
    } catch (error) {
      log.error('Clear download history error:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.DOWNLOAD_HISTORY_DELETE, async (_event, recordId: string) => {
    log.debug('Delete download record:', recordId)
    try {
      await downloadHistory.deleteRecord(recordId)
      return { success: true }
    } catch (error) {
      log.error('Delete download record error:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.DOWNLOAD_CONFIG_GET, async () => {
    log.debug('Get download config')
    try {
      const config = downloadHistory.getConfig()
      return { success: true, data: config }
    } catch (error) {
      log.error('Get download config error:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.DOWNLOAD_CONFIG_SET, async (_event, updates: any) => {
    log.debug('Set download config:', updates)
    try {
      await downloadHistory.updateConfig(updates)
      return { success: true }
    } catch (error) {
      log.error('Set download config error:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.DOWNLOAD_DIR_GET, async (_event, sessionId: string) => {
    log.debug('Get download dir for session:', sessionId)
    try {
      const session = sessionManager.getSession(sessionId)
      if (!session) {
        return { success: false, error: 'Session not found' }
      }

      const sshConfig = session.config.ssh
      if (!sshConfig) {
        return { success: false, error: 'SSH config not found' }
      }

      const dir = downloadHistory.getDownloadDir(
        sessionId,
        session.config.name,
        sshConfig.host,
        sshConfig.port
      )
      return { success: true, data: dir }
    } catch (error) {
      log.error('Get download dir error:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  log.info('IPC handlers registered successfully')
}