import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'

// IPC 通道定义
const IPC_CHANNELS = {
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
  SESSION_RECENT: 'session:recent',
  SESSION_DEDUPLICATE: 'session:deduplicate',

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

  // 浮窗
  FLOAT_SHOW: 'float:show',
  FLOAT_HIDE: 'float:hide',
  FLOAT_TOGGLE: 'float:toggle',

  // 数据导出导入
  EXPORT_DATA: 'data:export',
  IMPORT_DATA: 'data:import',

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
  FILE_OPEN_FOLDER: 'file:open-folder',
  FILE_MD5: 'file:md5',
  FILE_PWD: 'file:pwd',

  // 下载记录
  DOWNLOAD_HISTORY_LIST: 'download-history:list',
  DOWNLOAD_HISTORY_CLEAR: 'download-history:clear',
  DOWNLOAD_HISTORY_DELETE: 'download-history:delete',
  DOWNLOAD_CONFIG_GET: 'download-config:get',
  DOWNLOAD_CONFIG_SET: 'download-config:set',
  DOWNLOAD_DIR_GET: 'download-dir:get',

  // Dialog API
  WINDOW_GET_BOUNDS: 'window:get-bounds',

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

  // AI Agent
  AGENT_LIST: 'agent:list',
  AGENT_ADD: 'agent:add',
  AGENT_UPDATE: 'agent:update',
  AGENT_DELETE: 'agent:delete',
  AGENT_LAUNCH: 'agent:launch'
}

// 暴露给渲染进程的 API
const electronAPI = {
  // 连接管理
  connect: (config: unknown) => ipcRenderer.invoke(IPC_CHANNELS.CONNECTION_CONNECT, config),
  disconnect: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.CONNECTION_DISCONNECT, sessionId),
  reconnect: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.CONNECTION_RECONNECT, sessionId),
  cloneChannel: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.CONNECTION_CLONE_CHANNEL, sessionId),
  onConnectionStatus: (callback: (event: IpcRendererEvent, status: unknown) => void) => {
    ipcRenderer.on(IPC_CHANNELS.CONNECTION_STATUS, callback)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.CONNECTION_STATUS, callback)
  },

  // 会话管理
  createSession: (session: unknown) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_CREATE, session),
  updateSession: (session: unknown) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_UPDATE, session),
  deleteSession: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_DELETE, sessionId),
  listSessions: () => ipcRenderer.invoke(IPC_CHANNELS.SESSION_LIST),
  getSession: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_GET, sessionId),
  getRecentSessions: (limit?: number) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_RECENT, limit),
  deduplicateSessions: () => ipcRenderer.invoke(IPC_CHANNELS.SESSION_DEDUPLICATE),

  // 终端操作
  terminalWrite: (sessionId: string, data: string) =>
    ipcRenderer.send(IPC_CHANNELS.TERMINAL_WRITE, sessionId, data),
  terminalResize: (sessionId: string, cols: number, rows: number) =>
    ipcRenderer.send(IPC_CHANNELS.TERMINAL_RESIZE, sessionId, cols, rows),
  onTerminalData: (callback: (event: IpcRendererEvent, sessionId: string, data: string) => void) => {
    ipcRenderer.on(IPC_CHANNELS.TERMINAL_DATA, callback)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_DATA, callback)
  },
  onTerminalExit: (callback: (event: IpcRendererEvent, sessionId: string) => void) => {
    ipcRenderer.on(IPC_CHANNELS.TERMINAL_EXIT, callback)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_EXIT, callback)
  },

  // Python 执行
  pythonExecute: (code: string, context?: unknown) =>
    ipcRenderer.invoke(IPC_CHANNELS.PYTHON_EXECUTE, code, context),
  pythonScript: (path: string, args?: string[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.PYTHON_SCRIPT, path, args),
  pythonTerminate: (executionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PYTHON_TERMINATE, executionId),
  onPythonOutput: (callback: (event: IpcRendererEvent, output: unknown) => void) => {
    ipcRenderer.on(IPC_CHANNELS.PYTHON_OUTPUT, callback)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PYTHON_OUTPUT, callback)
  },

  // AI 功能
  aiQuery: (request: unknown) => ipcRenderer.invoke(IPC_CHANNELS.AI_QUERY, request),
  aiStream: (request: unknown, onChunk: (chunk: string) => void) => {
    ipcRenderer.on(IPC_CHANNELS.AI_STREAM, (_, chunk) => onChunk(chunk))
    return ipcRenderer.invoke(IPC_CHANNELS.AI_STREAM, request)
  },
  aiCancel: () => ipcRenderer.invoke(IPC_CHANNELS.AI_CANCEL),

  // 配置管理
  getConfig: (key: string) => ipcRenderer.invoke(IPC_CHANNELS.CONFIG_GET, key),
  setConfig: (key: string, value: unknown) => ipcRenderer.invoke(IPC_CHANNELS.CONFIG_SET, key, value),
  resetConfig: () => ipcRenderer.invoke(IPC_CHANNELS.CONFIG_RESET),

  // 浮窗
  floatShow: () => ipcRenderer.invoke(IPC_CHANNELS.FLOAT_SHOW),
  floatHide: () => ipcRenderer.invoke(IPC_CHANNELS.FLOAT_HIDE),
  floatToggle: () => ipcRenderer.invoke(IPC_CHANNELS.FLOAT_TOGGLE),
  onFloatToggle: (callback: (event: IpcRendererEvent) => void) => {
    ipcRenderer.on(IPC_CHANNELS.FLOAT_TOGGLE, callback)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.FLOAT_TOGGLE, callback)
  },

  // 快速命令
  getQuickCommands: () => ipcRenderer.invoke(IPC_CHANNELS.COMMAND_LIST),
  saveQuickCommands: (commands: unknown) => ipcRenderer.invoke(IPC_CHANNELS.COMMAND_SAVE_ALL, commands),
  addQuickCommand: (command: unknown) => ipcRenderer.invoke(IPC_CHANNELS.COMMAND_ADD, command),
  updateQuickCommand: (command: unknown) => ipcRenderer.invoke(IPC_CHANNELS.COMMAND_UPDATE, command),
  deleteQuickCommand: (commandId: string) => ipcRenderer.invoke(IPC_CHANNELS.COMMAND_DELETE, commandId),

  // 快速命令（简化名称）
  commandList: () => ipcRenderer.invoke(IPC_CHANNELS.COMMAND_LIST),
  commandAdd: (command: unknown) => ipcRenderer.invoke(IPC_CHANNELS.COMMAND_ADD, command),
  commandUpdate: (command: unknown) => ipcRenderer.invoke(IPC_CHANNELS.COMMAND_UPDATE, command),
  commandDelete: (commandId: string) => ipcRenderer.invoke(IPC_CHANNELS.COMMAND_DELETE, commandId),

  // 快速命令分组
  commandGroupList: () => ipcRenderer.invoke(IPC_CHANNELS.COMMAND_GROUP_LIST),
  commandGroupAdd: (group: unknown) => ipcRenderer.invoke(IPC_CHANNELS.COMMAND_GROUP_ADD, group),
  commandGroupUpdate: (group: unknown) => ipcRenderer.invoke(IPC_CHANNELS.COMMAND_GROUP_UPDATE, group),
  commandGroupDelete: (groupId: string) => ipcRenderer.invoke(IPC_CHANNELS.COMMAND_GROUP_DELETE, groupId),
  commandGroupReorder: (groupIds: string[]) => ipcRenderer.invoke(IPC_CHANNELS.COMMAND_GROUP_REORDER, groupIds),

  // AI Agent
  listAgents: () => ipcRenderer.invoke(IPC_CHANNELS.AGENT_LIST),
  addAgent: (agent: unknown) => ipcRenderer.invoke(IPC_CHANNELS.AGENT_ADD, agent),
  updateAgent: (agent: unknown) => ipcRenderer.invoke(IPC_CHANNELS.AGENT_UPDATE, agent),
  deleteAgent: (agentId: string) => ipcRenderer.invoke(IPC_CHANNELS.AGENT_DELETE, agentId),
  launchAgent: (agentId: string) => ipcRenderer.invoke(IPC_CHANNELS.AGENT_LAUNCH, agentId),

  // 窗口
  getWindowBounds: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_GET_BOUNDS),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  selectDirectory: () => ipcRenderer.invoke('window:select-directory'),
  listLocalDirectories: (path: string) => ipcRenderer.invoke('window:list-local-directories', path),

  // 数据导出导入
  exportData: (data: unknown, encryptPassword?: string) => ipcRenderer.invoke(IPC_CHANNELS.EXPORT_DATA, data, encryptPassword),
  importData: (decryptPassword?: string) => ipcRenderer.invoke(IPC_CHANNELS.IMPORT_DATA, decryptPassword),

  // 文件操作
  fileList: (sessionId: string, path: string) => ipcRenderer.invoke(IPC_CHANNELS.FILE_LIST, sessionId, path),
  fileStat: (sessionId: string, path: string) => ipcRenderer.invoke(IPC_CHANNELS.FILE_STAT, sessionId, path),
  fileUpload: (sessionId: string, localPath: string, remotePath: string, taskId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_UPLOAD, sessionId, localPath, remotePath, taskId),
  fileDownload: (sessionId: string, remotePath: string, localPath: string, taskId: string, fileName: string, fileSize: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_DOWNLOAD, sessionId, remotePath, localPath, taskId, fileName, fileSize),
  fileDelete: (sessionId: string, path: string) => ipcRenderer.invoke(IPC_CHANNELS.FILE_DELETE, sessionId, path),
  fileRename: (sessionId: string, oldPath: string, newPath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_RENAME, sessionId, oldPath, newPath),
  fileMkdir: (sessionId: string, path: string) => ipcRenderer.invoke(IPC_CHANNELS.FILE_MKDIR, sessionId, path),
  getFileConnectorType: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.FILE_CONNECTOR_TYPE, sessionId),
  openFolder: (filePath: string) => ipcRenderer.invoke(IPC_CHANNELS.FILE_OPEN_FOLDER, filePath),
  fileMd5: (sessionId: string, filePath: string) => ipcRenderer.invoke(IPC_CHANNELS.FILE_MD5, sessionId, filePath),
  filePwd: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.FILE_PWD, sessionId),
  onFileProgress: (callback: (event: IpcRendererEvent, progress: unknown) => void) => {
    ipcRenderer.on(IPC_CHANNELS.FILE_PROGRESS, callback)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.FILE_PROGRESS, callback)
  },

  // 下载记录
  getDownloadHistory: (sessionId?: string) => ipcRenderer.invoke(IPC_CHANNELS.DOWNLOAD_HISTORY_LIST, sessionId),
  clearDownloadHistory: () => ipcRenderer.invoke(IPC_CHANNELS.DOWNLOAD_HISTORY_CLEAR),
  deleteDownloadRecord: (recordId: string) => ipcRenderer.invoke(IPC_CHANNELS.DOWNLOAD_HISTORY_DELETE, recordId),
  getDownloadConfig: () => ipcRenderer.invoke(IPC_CHANNELS.DOWNLOAD_CONFIG_GET),
  setDownloadConfig: (config: unknown) => ipcRenderer.invoke(IPC_CHANNELS.DOWNLOAD_CONFIG_SET, config),
  getDownloadDir: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.DOWNLOAD_DIR_GET, sessionId),

  // Dialog API
  showOpenDialog: (options: unknown) => ipcRenderer.invoke('dialog:open', options),
  showSaveDialog: (options: unknown) => ipcRenderer.invoke('dialog:save', options),
  showMessageBox: (options: unknown) => ipcRenderer.invoke('dialog:message', options),

  // 平台信息
  platform: process.platform,
  isDev: process.env.NODE_ENV === 'development'
}

// 通过 contextBridge 暴露 API
contextBridge.exposeInMainWorld('electronAPI', electronAPI)

// 导出类型定义供渲染进程使用
export type { ElectronAPI }
type ElectronAPI = typeof electronAPI