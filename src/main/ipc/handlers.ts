import { ipcMain, BrowserWindow, dialog, shell } from 'electron'
import type { MessageBoxOptions, OpenDialogOptions, SaveDialogOptions } from 'electron'
import { writeFile, readFile } from 'fs/promises'
import * as path from 'path'
import * as fs from 'fs'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'
import log from 'electron-log'
import { v4 as uuidv4 } from 'uuid'
import { sessionManager, extractErrorMessage } from '../terminal/session-manager'
import { sessionRepository, preferencesRepository, quickCommandsRepository } from '../storage/repository'
import { agentRepository } from '../storage/agent-repository'
import type { AgentConfig } from '../storage/agent-repository'
import { downloadHistory, DownloadRecord } from '../storage'
import { ConnectionStatus } from '../connectors'
import { reachabilityProber, type ReachabilityTarget } from '../reachability/reachability-prober'
import { ConnectionType } from '@shared/types'
import { fileManager, startDownloadWorker, registerTaskMeta, startUploadWorker } from '../file'
import type { SessionConfig } from '@shared/types'
import {
  assertNumber,
  assertObject,
  assertString,
  assertStringArray,
  assertStringRecord,
  validationFailure
} from './validation'
import { getMcpAddCommandForIpc } from '../mcp/http-server'
import { mcpAuditRepository } from '../storage/mcp-audit-repository'
import type { McpAuditQuery } from '../storage/mcp-audit-repository'

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

// 已注册 destroyed 清理监听的窗口，避免每次同步都重复注册
const registeredTerminalSyncWindows = new Set<number>()

/**
 * IPC 通道定义
 */
export const IPC_CHANNELS = {
  // 连接管理
  CONNECTION_CONNECT: 'connection:connect',
  CONNECTION_DISCONNECT: 'connection:disconnect',
  CONNECTION_RECONNECT: 'connection:reconnect',
  CONNECTION_STATUS: 'connection:status',
  CONNECTION_REACHABLE: 'connection:reachable',  // TCP 可达性探测结果推送
  REACHABILITY_PROBE_NOW: 'reachability:probe-now',  // 手动刷新一次探测
  CONNECTION_CLONE_CHANNEL: 'connection:clone-channel',  // 克隆渠道

  // 会话管理
  SESSION_CREATE: 'session:create',
  SESSION_UPDATE: 'session:update',
  SESSION_DELETE: 'session:delete',
  SESSION_LIST: 'session:list',
  SESSION_GET: 'session:get',
  SESSION_FAVORITES: 'session:favorites',
  SESSION_RECENT: 'session:recent',
  // 会话列表被外部路径（MCP 写入/创建）改动后，向所有窗口推送一次，触发渲染层增量同步
  SESSIONS_CHANGED: 'sessions:changed',

  // 串口
  SERIAL_LIST_PORTS: 'serial:list-ports',

  // 终端操作
  TERMINAL_WRITE: 'terminal:write',
  TERMINAL_RESIZE: 'terminal:resize',
  TERMINAL_DATA: 'terminal:data',
  TERMINAL_EXIT: 'terminal:exit',
  TERMINAL_OPEN_SESSIONS_SYNC: 'terminal:open-sessions-sync',  // 渲染层同步当前打开的会话列表

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

  // MCP 注册命令（供设置页"复制注册命令"按钮）
  MCP_GET_ADD_COMMAND: 'mcp:get-add-command',

  // MCP 审计日志（"MCP 活动"面板）
  MCP_AUDIT_LIST: 'mcp-audit:list',
  MCP_AUDIT_CLEAR: 'mcp-audit:clear',

  // MCP 触发渲染层打开"新建连接"对话框（C4：凭据交还用户）
  MCP_OPEN_CONNECTION_DIALOG: 'mcp:open-connection-dialog',

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

  // 快速命令分组
  COMMAND_GROUP_LIST: 'command-group:list',
  COMMAND_GROUP_ADD: 'command-group:add',
  COMMAND_GROUP_UPDATE: 'command-group:update',
  COMMAND_GROUP_DELETE: 'command-group:delete',
  COMMAND_GROUP_REORDER: 'command-group:reorder',

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
 * 会话列表被外部路径（主要是 MCP HTTP API）改动后调用，
 * 通知所有渲染窗口增量拉取最新会话——避免 LLM 经 MCP 创建/改备注后 UI 不同步。
 * 渲染层订阅后做 merge 式同步，不会重置已连接会话的 status。
 */
export function broadcastSessionsChanged(): void {
  sendToAllWindows(IPC_CHANNELS.SESSIONS_CHANGED)
}

/**
 * MCP open_connection_dialog 工具（C4）调用：通知渲染层打开"新建连接"对话框。
 * agent 把凭据填写交还给用户（MCP 通道不接受凭据）。无 payload——只触发打开动作。
 */
export function broadcastMcpOpenConnectionDialog(): void {
  sendToAllWindows(IPC_CHANNELS.MCP_OPEN_CONNECTION_DIALOG)
}

const allowedOpenDialogProperties = new Set<NonNullable<OpenDialogOptions['properties']>[number]>([
  'openFile',
  'openDirectory',
  'multiSelections'
])

function sanitizeDialogFilters(filters: unknown): Electron.FileFilter[] | undefined {
  if (!Array.isArray(filters)) return undefined
  return filters.slice(0, 10).map((filter) => {
    const item = assertObject(filter, 'filter')
    return {
      name: assertString(item.name, 'filter.name', { maxLength: 80 }),
      extensions: assertStringArray(item.extensions, 'filter.extensions', { maxItems: 20, maxItemLength: 20 })
    }
  })
}

function sanitizeOpenDialogOptions(options: unknown): OpenDialogOptions {
  const source = assertObject(options || {}, 'options')
  const sanitized: OpenDialogOptions = {}
  if (source.title !== undefined) sanitized.title = assertString(source.title, 'title', { maxLength: 120 })
  if (source.defaultPath !== undefined) sanitized.defaultPath = assertString(source.defaultPath, 'defaultPath', { maxLength: 4096 })
  if (source.buttonLabel !== undefined) sanitized.buttonLabel = assertString(source.buttonLabel, 'buttonLabel', { maxLength: 80 })
  if (source.properties !== undefined) {
    const properties = assertStringArray(source.properties, 'properties', { maxItems: 8, maxItemLength: 32 })
    sanitized.properties = properties.filter((property): property is NonNullable<OpenDialogOptions['properties']>[number] =>
      allowedOpenDialogProperties.has(property as NonNullable<OpenDialogOptions['properties']>[number])
    )
  }
  const filters = sanitizeDialogFilters(source.filters)
  if (filters) sanitized.filters = filters
  return sanitized
}

function sanitizeSaveDialogOptions(options: unknown): SaveDialogOptions {
  const source = assertObject(options || {}, 'options')
  const sanitized: SaveDialogOptions = {}
  if (source.title !== undefined) sanitized.title = assertString(source.title, 'title', { maxLength: 120 })
  if (source.defaultPath !== undefined) sanitized.defaultPath = assertString(source.defaultPath, 'defaultPath', { maxLength: 4096 })
  if (source.buttonLabel !== undefined) sanitized.buttonLabel = assertString(source.buttonLabel, 'buttonLabel', { maxLength: 80 })
  if (source.nameFieldLabel !== undefined) sanitized.nameFieldLabel = assertString(source.nameFieldLabel, 'nameFieldLabel', { maxLength: 80 })
  const filters = sanitizeDialogFilters(source.filters)
  if (filters) sanitized.filters = filters
  return sanitized
}

function sanitizeMessageBoxOptions(options: unknown): MessageBoxOptions {
  const source = assertObject(options || {}, 'options')
  const sanitized: MessageBoxOptions = {
    type: ['none', 'info', 'error', 'question', 'warning'].includes(String(source.type)) ? source.type as MessageBoxOptions['type'] : 'none',
    message: assertString(source.message || '', 'message', { maxLength: 1000, allowEmpty: true })
  }
  if (source.title !== undefined) sanitized.title = assertString(source.title, 'title', { maxLength: 120 })
  if (source.detail !== undefined) sanitized.detail = assertString(source.detail, 'detail', { maxLength: 2000 })
  if (source.buttons !== undefined) sanitized.buttons = assertStringArray(source.buttons, 'buttons', { maxItems: 4, maxItemLength: 40 })
  if (source.defaultId !== undefined) sanitized.defaultId = assertNumber(source.defaultId, 'defaultId', { min: 0, max: 3, integer: true })
  if (source.cancelId !== undefined) sanitized.cancelId = assertNumber(source.cancelId, 'cancelId', { min: 0, max: 3, integer: true })
  return sanitized
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
      assertObject(config, 'config')
      if (config.id !== undefined) assertString(config.id, 'config.id', { maxLength: 128, allowEmpty: true })
      assertString(config.name, 'config.name', { maxLength: 200 })
      assertString(config.type, 'config.type', { maxLength: 32 })

      // 空 id 表示临时会话，直接创建新连接
      if (!config.id || config.id.trim() === '') {
        // 设置创建时间用于前端排序编号
        config.createdAt = new Date()
        config.updatedAt = new Date()
        const session = await sessionManager.createSession(config)

        // 立即返回会话ID，让前端先显示终端
        // 然后异步执行连接
        const sessionId = session.id

        // 注意：CONNECTING 状态由 connectSession 内部通过 session:status 事件发送
        // 避免重复发送导致前端竞态条件

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
      syncReachabilityTargets()

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

      // 注意：CONNECTING 状态由 connectSession 内部通过 session:status 事件发送
      // 避免重复发送导致前端竞态条件

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
      const validationError = validationFailure(error)
      if (validationError) {
        return {
          id: 'temp',
          status: ConnectionStatus.ERROR,
          error: validationError.error,
          config
        }
      }

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

  ipcMain.handle(IPC_CHANNELS.CONNECTION_DISCONNECT, async (_event, _sessionId: string) => {
    try {
      const sessionId = assertString(_sessionId, 'sessionId', { maxLength: 128 })
      log.debug('Disconnect request:', sessionId)
      await sessionManager.disconnectSession(sessionId)
      return { success: true }
    } catch (error) {
      return validationFailure(error) || { success: false, error: extractErrorMessage(error as Error) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.CONNECTION_RECONNECT, async (_event, _sessionId: string) => {
    try {
      const sessionId = assertString(_sessionId, 'sessionId', { maxLength: 128 })
      log.debug('Reconnect request:', sessionId)
      const session = await sessionManager.reconnectSession(sessionId)
      return {
        id: session.id,
        status: session.status
      }
    } catch (error) {
      return validationFailure(error) || { success: false, error: extractErrorMessage(error as Error) }
    }
  })

  // 克隆渠道（在现有 SSH 连接上创建新 shell channel）
  ipcMain.handle(IPC_CHANNELS.CONNECTION_CLONE_CHANNEL, async (_event, sourceSessionId: string) => {
    try {
      const sessionId = assertString(sourceSessionId, 'sourceSessionId', { maxLength: 128 })
      log.debug('Clone channel request:', sessionId)
      return await sessionManager.cloneChannel(sessionId)
    } catch (error) {
      return validationFailure(error) || { success: false, error: extractErrorMessage(error as Error) }
    }
  })

  // 枚举本机串口（供新建会话对话框使用）
  ipcMain.handle(IPC_CHANNELS.SERIAL_LIST_PORTS, async () => {
    try {
      const { SerialConnector } = await import('../connectors')
      const ports = await SerialConnector.listPorts()
      // 只透出 UI 需要的字段，避免 PortInfo 内的额外信息穿越 IPC
      return ports.map(p => ({
        path: p.path,
        manufacturer: p.manufacturer,
        serialNumber: p.serialNumber,
        pnpId: p.pnpId,
        friendlyName: (p as { friendlyName?: string }).friendlyName,
        vendorId: p.vendorId,
        productId: p.productId
      }))
    } catch (error) {
      // 驱动错误不影响 UI，返回空列表让 UI 仅显示手动输入行
      log.warn('Failed to list serial ports:', (error as Error).message)
      return []
    }
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

  // ===== TCP 可达性探测 =====
  // 把所有保存的 SSH/Telnet 会话作为探测目标，每 30s 跑一遍，结果推到渲染层。
  // 用 config.id 作为 key — 与 saved 行直接对齐，不受 name/host 变更影响，也能区分同 host 不同账号。
  const syncReachabilityTargets = (): void => {
    try {
      const all = sessionRepository.getAll()
      const targets: ReachabilityTarget[] = []
      for (const cfg of all) {
        if (cfg.type === 'ssh' && cfg.ssh) {
          targets.push({ key: cfg.id, host: cfg.ssh.host, port: cfg.ssh.port })
        } else if (cfg.type === 'telnet' && cfg.telnet) {
          targets.push({ key: cfg.id, host: cfg.telnet.host, port: cfg.telnet.port })
        }
      }
      reachabilityProber.setTargets(targets)
    } catch (e) {
      log.warn('Failed to sync reachability targets:', e)
    }
  }
  // 幂等保护：registerIPCHandlers 理论上只调一次，但万一被二次调用，
  // 不要重复挂监听 + 多套定时器。
  reachabilityProber.removeAllListeners('result')
  reachabilityProber.on('result', (data) => {
    sendToAllWindows(IPC_CHANNELS.CONNECTION_REACHABLE, data)
  })
  reachabilityProber.stop()
  syncReachabilityTargets()
  reachabilityProber.start()

  ipcMain.handle(IPC_CHANNELS.REACHABILITY_PROBE_NOW, async () => {
    syncReachabilityTargets()
    await reachabilityProber.probeNow()
    return { success: true }
  })

  // 监听终端数据，批量发送到所有窗口（减少 IPC 频率）
  const dataBuffers = new Map<string, string>()
  let dataFlushTimer: ReturnType<typeof setTimeout> | null = null

  sessionManager.on('terminal:data', (data) => {
    const existing = dataBuffers.get(data.sessionId) || ''
    dataBuffers.set(data.sessionId, existing + data.data)

    if (!dataFlushTimer) {
      dataFlushTimer = setTimeout(() => {
        for (const [sessionId, bufferedData] of dataBuffers) {
          sendToAllWindows(IPC_CHANNELS.TERMINAL_DATA, sessionId, bufferedData)
        }
        dataBuffers.clear()
        dataFlushTimer = null
      }, 16)
    }
  })

  // ========== 会话管理 ==========

  ipcMain.handle(IPC_CHANNELS.SESSION_CREATE, async (_event, config: SessionConfig) => {
    try {
      assertObject(config, 'config')
      assertString(config.name, 'config.name', { maxLength: 200 })
      assertString(config.type, 'config.type', { maxLength: 32 })
      log.debug('Create session:', config.name)
      const saved = sessionRepository.saveSession(config)
      syncReachabilityTargets()
      return saved
    } catch (error) {
      return validationFailure(error) || { success: false, error: extractErrorMessage(error as Error) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_UPDATE, async (_event, config: SessionConfig) => {
    try {
      assertObject(config, 'config')
      assertString(config.id, 'config.id', { maxLength: 128 })
      assertString(config.name, 'config.name', { maxLength: 200 })
      assertString(config.type, 'config.type', { maxLength: 32 })
      log.debug('Update session:', config.id)
      const saved = sessionRepository.saveSession(config)
      syncReachabilityTargets()
      return saved
    } catch (error) {
      return validationFailure(error) || { success: false, error: extractErrorMessage(error as Error) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_DELETE, async (_event, _sessionId: string) => {
    try {
      const sessionId = assertString(_sessionId, 'sessionId', { maxLength: 128 })
      log.debug('Delete session:', sessionId)
      // 先断开连接
      try {
        await sessionManager.disconnectSession(sessionId)
      } catch (e) {
        // 忽略错误
      }
      // 删除存储
      sessionRepository.delete(sessionId)
      syncReachabilityTargets()
      return { success: true }
    } catch (error) {
      return validationFailure(error) || { success: false, error: extractErrorMessage(error as Error) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_LIST, async () => {
    log.debug('List sessions')
    return sessionRepository.getAll()
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_GET, async (_event, _sessionId: string) => {
    try {
      const sessionId = assertString(_sessionId, 'sessionId', { maxLength: 128 })
      log.debug('Get session:', sessionId)
      // 先从存储获取，如果没有则从 sessionManager 获取（临时会话）
      const stored = sessionRepository.get(sessionId)
      if (stored) return stored

      const session = sessionManager.getSession(sessionId)
      return session?.config || null
    } catch (error) {
      return validationFailure(error) || null
    }
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_FAVORITES, async () => {
    log.debug('Get favorite sessions')
    return sessionRepository.getFavorites()
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_RECENT, async (_event, limit?: number) => {
    try {
      log.debug('Get recent sessions')
      const safeLimit = limit === undefined ? 10 : assertNumber(limit, 'limit', { min: 1, max: 100, integer: true })
      return sessionRepository.getRecent(safeLimit)
    } catch (error) {
      return validationFailure(error) || []
    }
  })

  // 会话去重
  ipcMain.handle(IPC_CHANNELS.SESSION_DEDUPLICATE, async () => {
    log.info('Deduplicating sessions...')
    const result = sessionRepository.deduplicate()
    syncReachabilityTargets()
    return result
  })

  // ========== 终端操作 ==========

  ipcMain.on(IPC_CHANNELS.TERMINAL_WRITE, (_event, _sessionId: string, data: string) => {
    try {
      const sessionId = assertString(_sessionId, 'sessionId', { maxLength: 128 })
      const safeData = assertString(data, 'data', { maxLength: 1024 * 1024, allowEmpty: true })
      sessionManager.writeToSession(sessionId, safeData)
    } catch (error) {
      validationFailure(error) || log.warn('Rejected terminal write:', extractErrorMessage(error as Error))
    }
  })

  ipcMain.on(IPC_CHANNELS.TERMINAL_RESIZE, (_event, _sessionId: string, cols: number, rows: number) => {
    try {
      const sessionId = assertString(_sessionId, 'sessionId', { maxLength: 128 })
      const safeCols = assertNumber(cols, 'cols', { min: 1, max: 1000, integer: true })
      const safeRows = assertNumber(rows, 'rows', { min: 1, max: 1000, integer: true })
      sessionManager.resizeSession(sessionId, safeCols, safeRows)
    } catch (error) {
      validationFailure(error) || log.warn('Rejected terminal resize:', extractErrorMessage(error as Error))
    }
  })

  // 渲染层同步当前在终端页签/分屏中打开的会话集合
  ipcMain.handle(IPC_CHANNELS.TERMINAL_OPEN_SESSIONS_SYNC, async (_event, _ids: unknown) => {
    try {
      const ids = assertStringArray(_ids, 'ids', { maxItems: 10000, maxItemLength: 128 })
      const sender = _event.sender
      sessionManager.setTerminalOpenSessionsForWindow(sender.id, ids)
      if (!registeredTerminalSyncWindows.has(sender.id)) {
        registeredTerminalSyncWindows.add(sender.id)
        sender.once('destroyed', () => {
          registeredTerminalSyncWindows.delete(sender.id)
          sessionManager.removeTerminalOpenSessionsForWindow(sender.id)
        })
      }
      return { success: true }
    } catch (error) {
      return validationFailure(error) || { success: false, error: extractErrorMessage(error as Error) }
    }
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
    try {
      if (!Array.isArray(commands) || commands.length > 500) {
        throw new Error('commands must be an array with at most 500 items')
      }
      commands.forEach((command, index) => assertObject(command, `commands[${index}]`))
      quickCommandsRepository.saveAll(commands)
      return { success: true }
    } catch (error) {
      return validationFailure(error) || { success: false, error: extractErrorMessage(error as Error) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.COMMAND_ADD, async (_event, command) => {
    try {
      assertObject(command, 'command')
      return quickCommandsRepository.add(command)
    } catch (error) {
      return validationFailure(error) || { success: false, error: extractErrorMessage(error as Error) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.COMMAND_UPDATE, async (_event, command) => {
    try {
      assertObject(command, 'command')
      const success = quickCommandsRepository.update(command)
      return { success }
    } catch (error) {
      return validationFailure(error) || { success: false, error: extractErrorMessage(error as Error) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.COMMAND_DELETE, async (_event, commandId: string) => {
    try {
      const safeCommandId = assertString(commandId, 'commandId', { maxLength: 128 })
      const success = quickCommandsRepository.delete(safeCommandId)
      return { success }
    } catch (error) {
      return validationFailure(error) || { success: false, error: extractErrorMessage(error as Error) }
    }
  })

  // ========== 快速命令分组 ==========

  ipcMain.handle(IPC_CHANNELS.COMMAND_GROUP_LIST, async () => {
    return quickCommandsRepository.getAllGroups()
  })

  ipcMain.handle(IPC_CHANNELS.COMMAND_GROUP_ADD, async (_event, group) => {
    try {
      assertObject(group, 'group')
      return quickCommandsRepository.addGroup(group)
    } catch (error) {
      return validationFailure(error) || { success: false, error: extractErrorMessage(error as Error) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.COMMAND_GROUP_UPDATE, async (_event, group) => {
    try {
      assertObject(group, 'group')
      const success = quickCommandsRepository.updateGroup(group)
      return { success }
    } catch (error) {
      return validationFailure(error) || { success: false, error: extractErrorMessage(error as Error) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.COMMAND_GROUP_DELETE, async (_event, groupId: string) => {
    try {
      const safeGroupId = assertString(groupId, 'groupId', { maxLength: 128 })
      const success = quickCommandsRepository.deleteGroup(safeGroupId)
      return { success }
    } catch (error) {
      return validationFailure(error) || { success: false, error: extractErrorMessage(error as Error) }
    }
  })

  ipcMain.handle(IPC_CHANNELS.COMMAND_GROUP_REORDER, async (_event, groupIds: string[]) => {
    try {
      const safeGroupIds = assertStringArray(groupIds, 'groupIds', { maxItems: 200, maxItemLength: 128 })
      quickCommandsRepository.reorderGroups(safeGroupIds)
      return { success: true }
    } catch (error) {
      return validationFailure(error) || { success: false, error: extractErrorMessage(error as Error) }
    }
  })

  // ========== Python 执行 ==========

  const pythonExecutionDisabled = { success: false, error: 'Python execution is disabled for security reasons' }

  ipcMain.handle(IPC_CHANNELS.PYTHON_EXECUTE, async () => {
    log.warn('Blocked disabled Python execute IPC request')
    return pythonExecutionDisabled
  })

  ipcMain.handle(IPC_CHANNELS.PYTHON_SCRIPT, async () => {
    log.warn('Blocked disabled Python script IPC request')
    return pythonExecutionDisabled
  })

  ipcMain.handle(IPC_CHANNELS.PYTHON_TERMINATE, async () => {
    log.warn('Blocked disabled Python terminate IPC request')
    return pythonExecutionDisabled
  })

  // ========== AI 功能 ==========

  const aiDisabled = { success: false, error: 'AI agent is not implemented' }

  ipcMain.handle(IPC_CHANNELS.AI_QUERY, async () => aiDisabled)
  ipcMain.handle(IPC_CHANNELS.AI_STREAM, async () => aiDisabled)
  ipcMain.handle(IPC_CHANNELS.AI_CANCEL, async () => aiDisabled)

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

  // MCP 注册命令（只读，无参数）
  ipcMain.handle(IPC_CHANNELS.MCP_GET_ADD_COMMAND, async () => {
    return getMcpAddCommandForIpc()
  })

  // MCP 审计日志查询（带过滤+分页）
  ipcMain.handle(IPC_CHANNELS.MCP_AUDIT_LIST, async (_event, filter: McpAuditQuery = {}) => {
    return mcpAuditRepository.query(filter)
  })

  // MCP 审计日志清空
  ipcMain.handle(IPC_CHANNELS.MCP_AUDIT_CLEAR, async () => {
    mcpAuditRepository.clear()
    return { success: true }
  })

  // ========== 窗口操作 ==========

  ipcMain.handle(IPC_CHANNELS.WINDOW_SEND_TO_SESSION, async (_event, _sessionId: string, data: string) => {
    const sessionId = assertString(_sessionId, 'sessionId', { maxLength: 128 })
    const safeData = assertString(data, 'data', { maxLength: 1024 * 1024, allowEmpty: true })
    log.debug('Send to session:', sessionId)
    sessionManager.writeToSession(sessionId, safeData)
    return { success: true }
  })

  // ========== 数据导出导入 ==========

  // 加密敏感字段（AES-GCM，带完整性校验）
  const encryptField = (text: string, password: string): string => {
    if (!text) return text
    const salt = randomBytes(16)
    const key = scryptSync(password, salt, 32)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    let encrypted = cipher.update(text, 'utf8', 'hex')
    encrypted += cipher.final('hex')
    const tag = cipher.getAuthTag()
    return `enc:v2:${salt.toString('hex')}:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`
  }

  // 解密敏感字段。失败必须抛错，避免错误密码/篡改文件被静默导入。
  const decryptField = (text: string, password: string): string => {
    if (!text || !text.startsWith('enc:')) return text

    const parts = text.split(':')
    if (parts[1] === 'v2') {
      if (parts.length !== 6) throw new Error('加密字段格式无效')
      const salt = Buffer.from(parts[2], 'hex')
      const iv = Buffer.from(parts[3], 'hex')
      const tag = Buffer.from(parts[4], 'hex')
      const encrypted = parts[5]
      const key = scryptSync(password, salt, 32)
      const decipher = createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAuthTag(tag)
      let decrypted = decipher.update(encrypted, 'hex', 'utf8')
      decrypted += decipher.final('utf8')
      return decrypted
    }

    // 兼容旧版 CBC 导出，但不再吞掉解密错误。
    if (parts.length !== 4) throw new Error('加密字段格式无效')
    const salt = Buffer.from(parts[1], 'hex')
    const iv = Buffer.from(parts[2], 'hex')
    const encrypted = parts[3]
    const key = scryptSync(password, salt, 32)
    const decipher = createDecipheriv('aes-256-cbc', key, iv)
    let decrypted = decipher.update(encrypted, 'hex', 'utf8')
    decrypted += decipher.final('utf8')
    return decrypted
  }

  // 加密会话中的敏感字段
  const encryptSession = (session: any, password: string): any => {
    const encrypted = { ...session, ssh: session.ssh ? { ...session.ssh } : undefined }
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
    const decrypted = { ...session, ssh: session.ssh ? { ...session.ssh } : undefined }
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

  ipcMain.handle(IPC_CHANNELS.DATA_EXPORT, async (_event, data: { sessions: any[], quickCommands: any[], encryptPassword?: string }, encryptPasswordArg?: string) => {
    const encryptPassword = data.encryptPassword || encryptPasswordArg
    log.debug('Export data:', data.sessions?.length, 'sessions,', data.quickCommands?.length, 'commands, encrypted:', !!encryptPassword)

    const result = await dialog.showSaveDialog({
      title: '导出配置数据',
      defaultPath: `lyshell-config-${new Date().toISOString().slice(0, 10)}.json`,
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
      const sessions = encryptPassword
        ? data.sessions.map(s => encryptSession(s, encryptPassword))
        : data.sessions

      const exportData = {
        version: '1.0',
        encrypted: !!encryptPassword,
        exportedAt: new Date().toISOString(),
        sessions: sessions || [],
        quickCommands: data.quickCommands || []
      }

      await writeFile(result.filePath, JSON.stringify(exportData, null, 2), 'utf-8')
      log.info('Data exported to:', result.filePath, 'encrypted:', !!encryptPassword)
      return { success: true, path: result.filePath, encrypted: !!encryptPassword }
    } catch (error) {
      log.error('Export failed:', error)
      return { success: false, message: (error as Error).message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.DATA_IMPORT, async (_event, decryptPassword?: string, existingPath?: string) => {
    log.debug('Import data, decrypt password provided:', !!decryptPassword)

    let filePath = existingPath
    if (!filePath) {
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
      filePath = result.filePaths[0]
    }

    if (!filePath) {
      return { success: false, message: '导入文件路径无效' }
    }

    try {
      const content = await readFile(filePath, 'utf-8')
      const importData = JSON.parse(content)

      // 验证格式
      if (!importData.version || !importData.sessions) {
        return { success: false, message: '文件格式无效' }
      }

      // 检查是否需要解密
      if (importData.encrypted && !decryptPassword) {
        return { success: true, needPassword: true, path: filePath }
      }

      // 解密会话数据
      let sessions = importData.sessions
      if (importData.encrypted && decryptPassword) {
        try {
          sessions = sessions.map(s => decryptSession(s, decryptPassword))
        } catch {
          return { success: false, message: '解密失败，密码可能错误或文件已被篡改' }
        }
      }

      log.info('Data imported from:', filePath)
      return {
        success: true,
        path: filePath,
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
    const sshConfig = session.config.ssh || null
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

  ipcMain.handle(IPC_CHANNELS.FILE_LIST, async (_event, _sessionId: string, path: string) => {
    try {
      const sessionId = assertString(_sessionId, 'sessionId', { maxLength: 128 })
      const safePath = assertString(path, 'path', { maxLength: 4096 })
      log.debug('File list:', sessionId, safePath)
      const files = await fileManager.listDir(sessionId, safePath)
      return { success: true, data: files }
    } catch (error) {
      log.error('File list error:', error)
      return validationFailure(error) || { success: false, error: (error as Error).message }
    }
  })

  // 获取当前工作目录（home 目录）
  ipcMain.handle(IPC_CHANNELS.FILE_PWD, async (_event, _sessionId: string) => {
    try {
      const sessionId = assertString(_sessionId, 'sessionId', { maxLength: 128 })
      log.debug('File pwd:', sessionId)
      // 通过获取 connector 来执行 pwd 命令
      const connector = await fileManager.getConnector(sessionId)
      if (connector && connector.execRaw) {
        const pwdRaw = await connector.execRaw('pwd')
        // 清理输出：只保留最后一行以 / 开头的路径
        const lines = pwdRaw.split('\n')
        let pwd = ''
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim()
          if (line.startsWith('/')) {
            pwd = line
            break
          }
        }
        // 如果没找到，尝试匹配路径格式
        if (!pwd) {
          const pathMatch = pwdRaw.match(/\/[\w._/-]+/)
          if (pathMatch) {
            pwd = pathMatch[0].trim()
          }
        }
        return { success: true, data: pwd || pwdRaw.trim() }
      }
      return { success: false, error: 'Cannot execute command' }
    } catch (error) {
      log.error('File pwd error:', error)
      return validationFailure(error) || { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.FILE_STAT, async (_event, _sessionId: string, path: string) => {
    try {
      const sessionId = assertString(_sessionId, 'sessionId', { maxLength: 128 })
      const safePath = assertString(path, 'path', { maxLength: 4096 })
      log.debug('File stat:', sessionId, safePath)
      const info = await fileManager.stat(sessionId, safePath)
      return { success: true, data: info }
    } catch (error) {
      log.error('File stat error:', error)
      return validationFailure(error) || { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.FILE_UPLOAD, async (_event, _sessionId: string, localPath: string, remotePath: string, _taskId: string) => {
    try {
      const sessionId = assertString(_sessionId, 'sessionId', { maxLength: 128 })
      const safeLocalPath = assertString(localPath, 'localPath', { maxLength: 4096 })
      const safeRemotePath = assertString(remotePath, 'remotePath', { maxLength: 4096 })
      const taskId = assertString(_taskId, 'taskId', { maxLength: 128 })
      log.debug('File upload:', sessionId, safeLocalPath, '->', safeRemotePath)

      const session = sessionManager.getSession(sessionId)
      if (!session) {
        sendToAllWindows(IPC_CHANNELS.FILE_PROGRESS, {
          taskId: taskId,
          sessionId: sessionId,
          failed: true,
          error: 'Session not found',
          progress: 0,
          direction: 'upload'
        })
        return { success: false, error: 'Session not found' }
      }

      const sshConfig = session.config.ssh
      if (!sshConfig) {
        sendToAllWindows(IPC_CHANNELS.FILE_PROGRESS, {
          taskId: taskId,
          sessionId: sessionId,
          failed: true,
          error: 'SSH config not found',
          progress: 0,
          direction: 'upload'
        })
        return { success: false, error: 'SSH config not found' }
      }

      let fileSize = 0
      try {
        const stat = fs.statSync(safeLocalPath)
        fileSize = stat.size
      } catch (err) {
        sendToAllWindows(IPC_CHANNELS.FILE_PROGRESS, {
          taskId: taskId,
          sessionId: sessionId,
          failed: true,
          error: 'Local file not found',
          progress: 0,
          direction: 'upload'
        })
        return { success: false, error: 'Local file not found' }
      }

      const connectorType = await fileManager.getConnectorType(sessionId)
      log.debug(`Connector type for upload: ${connectorType}`)

      await startUploadWorker({
        taskId: taskId,
        sessionId: sessionId,
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
        localPath: safeLocalPath,
        remotePath: safeRemotePath,
        fileSize
      })
      log.info(`Upload worker started for ${path.basename(safeLocalPath)} (${connectorType})`)
      return { success: true, started: true, method: connectorType }
    } catch (error) {
      const message = (error as Error).message
      log.error('Failed to start upload:', message)
      return validationFailure(error) || { success: false, error: message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.FILE_DOWNLOAD, async (_event, _sessionId: string, remotePath: string, localPath: string, _taskId: string, fileName: string, fileSize: number) => {
    try {
      const sessionId = assertString(_sessionId, 'sessionId', { maxLength: 128 })
      const safeRemotePath = assertString(remotePath, 'remotePath', { maxLength: 4096 })
      const safeLocalPath = assertString(localPath, 'localPath', { maxLength: 4096 })
      const taskId = assertString(_taskId, 'taskId', { maxLength: 128 })
      const safeFileName = assertString(fileName, 'fileName', { maxLength: 255 })
      const safeFileSize = assertNumber(fileSize, 'fileSize', { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true })
      log.debug('File download:', sessionId, safeRemotePath, '->', safeLocalPath)

      const session = sessionManager.getSession(sessionId)
      if (!session) {
        return { success: false, error: 'Session not found' }
      }

      const sshConfig = session.config.ssh
      if (!sshConfig) {
        return { success: false, error: 'SSH config not found' }
      }

      const connectorType = await fileManager.getConnectorType(sessionId)
      log.debug(`Connector type for session ${sessionId}: ${connectorType}`)

      registerTaskMeta(taskId, {
        taskId: taskId,
        sessionId: sessionId,
        remotePath: safeRemotePath,
        localPath: safeLocalPath,
        fileName: safeFileName,
        fileSize: safeFileSize,
        startTime: new Date(),
        sessionName: session.config.name
      })

      await startDownloadWorker({
        taskId: taskId,
        sessionId: sessionId,
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
        remotePath: safeRemotePath,
        localPath: safeLocalPath,
        fileSize: safeFileSize
      })
      log.info(`Download worker started for ${safeFileName} (${connectorType})`)
      return { success: true, started: true, method: connectorType }
    } catch (error) {
      const message = (error as Error).message
      log.error('Failed to start download:', message)
      return validationFailure(error) || { success: false, error: message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.FILE_DELETE, async (_event, _sessionId: string, path: string) => {
    try {
      const sessionId = assertString(_sessionId, 'sessionId', { maxLength: 128 })
      const safePath = assertString(path, 'path', { maxLength: 4096 })
      log.debug('File delete:', sessionId, safePath)
      await fileManager.delete(sessionId, safePath)
      return { success: true }
    } catch (error) {
      log.error('File delete error:', error)
      return validationFailure(error) || { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.FILE_RENAME, async (_event, _sessionId: string, oldPath: string, newPath: string) => {
    try {
      const sessionId = assertString(_sessionId, 'sessionId', { maxLength: 128 })
      const safeOldPath = assertString(oldPath, 'oldPath', { maxLength: 4096 })
      const safeNewPath = assertString(newPath, 'newPath', { maxLength: 4096 })
      log.debug('File rename:', sessionId, safeOldPath, '->', safeNewPath)
      await fileManager.rename(sessionId, safeOldPath, safeNewPath)
      return { success: true }
    } catch (error) {
      log.error('File rename error:', error)
      return validationFailure(error) || { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.FILE_MKDIR, async (_event, _sessionId: string, path: string) => {
    try {
      const sessionId = assertString(_sessionId, 'sessionId', { maxLength: 128 })
      const safePath = assertString(path, 'path', { maxLength: 4096 })
      log.debug('File mkdir:', sessionId, safePath)
      await fileManager.mkdir(sessionId, safePath)
      return { success: true }
    } catch (error) {
      log.error('File mkdir error:', error)
      return validationFailure(error) || { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.FILE_CONNECTOR_TYPE, async (_event, _sessionId: string) => {
    try {
      const sessionId = assertString(_sessionId, 'sessionId', { maxLength: 128 })
      log.debug('Get file connector type:', sessionId)
      const type = await fileManager.getConnectorType(sessionId)
      return { success: true, data: type }
    } catch (error) {
      log.error('Get connector type error:', error)
      return validationFailure(error) || { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle(IPC_CHANNELS.FILE_MD5, async (_event, _sessionId: string, filePath: string) => {
    try {
      const sessionId = assertString(_sessionId, 'sessionId', { maxLength: 128 })
      const safeFilePath = assertString(filePath, 'filePath', { maxLength: 4096 })
      log.debug('Calculate file MD5:', sessionId, safeFilePath)
      const md5 = await fileManager.calculateRemoteMD5(sessionId, safeFilePath)
      return { success: true, data: md5 }
    } catch (error) {
      log.error('Calculate MD5 error:', error)
      return validationFailure(error) || { success: false, error: (error as Error).message }
    }
  })

  // ========== Dialog API ==========

  ipcMain.handle('dialog:open', async (_event, options: unknown) => {
    try {
      log.debug('Show open dialog')
      return await dialog.showOpenDialog(sanitizeOpenDialogOptions(options))
    } catch (error) {
      return validationFailure(error) || { canceled: true, filePaths: [] }
    }
  })

  ipcMain.handle('dialog:save', async (_event, options: unknown) => {
    try {
      log.debug('Show save dialog')
      return await dialog.showSaveDialog(sanitizeSaveDialogOptions(options))
    } catch (error) {
      return validationFailure(error) || { canceled: true }
    }
  })

  ipcMain.handle('dialog:message', async (_event, options: unknown) => {
    try {
      log.debug('Show message box')
      return await dialog.showMessageBox(sanitizeMessageBoxOptions(options))
    } catch (error) {
      return validationFailure(error) || { response: 0 }
    }
  })

  // 打开路径：目录在资源管理器中打开，文件在资源管理器中定位并选中
  ipcMain.handle(IPC_CHANNELS.FILE_OPEN_FOLDER, async (_event, filePath: string) => {
    log.debug('Open path:', filePath)
    try {
      // 安全校验：仅对目录调用 openPath（在资源管理器中打开）；
      // 对文件改用 showItemInFolder（在资源管理器中定位并选中，不会用默认程序执行，
      // 避免传入 .exe 等可执行文件被直接运行）
      const stat = fs.statSync(filePath)
      if (stat.isDirectory()) {
        const openErr = await shell.openPath(filePath)
        if (openErr) {
          return { success: false, error: openErr }
        }
      } else {
        shell.showItemInFolder(filePath)
      }
      return { success: true }
    } catch (error) {
      log.error('Open path error:', error)
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

  ipcMain.handle(IPC_CHANNELS.DOWNLOAD_DIR_GET, async (_event, _sessionId: string) => {
    const sessionId = assertString(_sessionId, 'sessionId', { maxLength: 128 })
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

  // ========== AI Agent ==========

  ipcMain.handle('agent:list', async () => {
    return agentRepository.getAll()
  })

  ipcMain.handle('agent:add', async (_event, agent) => {
    try {
      const safeAgent = assertObject(agent, 'agent')
      const newAgent: Omit<AgentConfig, 'id'> = {
        name: assertString(safeAgent.name, 'agent.name', { maxLength: 120 }),
        command: assertString(safeAgent.command, 'agent.command', { maxLength: 1000 }),
        order: safeAgent.order === undefined ? 0 : assertNumber(safeAgent.order, 'agent.order', { min: 0, max: 10000, integer: true })
      }
      if (safeAgent.icon !== undefined) newAgent.icon = assertString(safeAgent.icon, 'agent.icon', { maxLength: 20 })
      if (safeAgent.cwd !== undefined) newAgent.cwd = assertString(safeAgent.cwd, 'agent.cwd', { maxLength: 4096 })
      if (safeAgent.env !== undefined) newAgent.env = assertStringRecord(safeAgent.env, 'agent.env', { maxItems: 256, maxKeyLength: 1024, maxValueLength: 32768 })
      return agentRepository.add(newAgent)
    } catch (error) {
      return validationFailure(error) || { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('agent:update', async (_event, agent) => {
    try {
      const safeAgent = assertObject(agent, 'agent')
      const updatedAgent: AgentConfig = {
        id: assertString(safeAgent.id, 'agent.id', { maxLength: 128 }),
        name: assertString(safeAgent.name, 'agent.name', { maxLength: 120 }),
        command: assertString(safeAgent.command, 'agent.command', { maxLength: 1000 }),
        order: safeAgent.order === undefined ? 0 : assertNumber(safeAgent.order, 'agent.order', { min: 0, max: 10000, integer: true })
      }
      if (safeAgent.icon !== undefined) updatedAgent.icon = assertString(safeAgent.icon, 'agent.icon', { maxLength: 20 })
      if (safeAgent.cwd !== undefined) updatedAgent.cwd = assertString(safeAgent.cwd, 'agent.cwd', { maxLength: 4096 })
      if (safeAgent.env !== undefined) updatedAgent.env = assertStringRecord(safeAgent.env, 'agent.env', { maxItems: 256, maxKeyLength: 1024, maxValueLength: 32768 })
      const success = agentRepository.update(updatedAgent)
      return { success }
    } catch (error) {
      return validationFailure(error) || { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('agent:delete', async (_event, agentId: string) => {
    try {
      const safeAgentId = assertString(agentId, 'agentId', { maxLength: 128 })
      const success = agentRepository.delete(safeAgentId)
      return { success }
    } catch (error) {
      return validationFailure(error) || { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('agent:launch', async (_event, agentId: string) => {
    try {
      const safeAgentId = assertString(agentId, 'agentId', { maxLength: 128 })
      const agent = agentRepository.get(safeAgentId)
      if (!agent) return { success: false, error: 'Agent not found' }

      // 创建 LOCAL 会话配置
      const config: SessionConfig = {
        id: '',
        name: agent.name,
        type: ConnectionType.LOCAL,
        local: {
          shell: undefined,
          cwd: agent.cwd,
          env: agent.env
        },
        terminal: {
          fontSize: 14,
          fontFamily: 'Consolas, Monaco, monospace',
          theme: {
            foreground: '#D4D4D4',
            background: '#1E1E1E',
            cursor: '#D4D4D4',
            selectionBackground: '#264F78',
            black: '#000000',
            red: '#CD3131',
            green: '#0DBC79',
            yellow: '#E5E510',
            blue: '#2472C8',
            magenta: '#BC3FBC',
            cyan: '#11A8CD',
            white: '#E5E5E5',
            brightBlack: '#666666',
            brightRed: '#F14C4C',
            brightGreen: '#23D18B',
            brightYellow: '#F5F543',
            brightBlue: '#3B8EEA',
            brightMagenta: '#D670D6',
            brightCyan: '#29B8DB',
            brightWhite: '#E5E5E5'
          },
          cursorStyle: 'bar',
          cursorBlink: true,
          scrollback: 10000,
          encoding: 'utf-8'
        },
        tags: [`agent:${safeAgentId}`],
        startupCommands: [agent.command],
        createdAt: new Date(),
        updatedAt: new Date()
      }

      // 先创建会话并返回 ID，让前端先初始化终端
      const session = await sessionManager.createSession(config)

      // 延迟连接，给前端时间创建 xterm 实例
      setTimeout(() => {
        // 连接前保存会话（同步操作）
        sessionRepository.saveSession(config)
        sessionManager.connectSession(session.id).catch(err => {
          log.error('Agent launch failed:', extractErrorMessage(err))
        })
      }, 100)

      return {
        success: true,
        id: session.id,
        status: ConnectionStatus.CONNECTING,
        config: session.config
      }
    } catch (error) {
      return validationFailure(error) || { success: false, error: (error as Error).message }
    }
  })

  log.info('IPC handlers registered successfully')
}
