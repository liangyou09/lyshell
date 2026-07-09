import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'

// IPC 通道定义
const IPC_CHANNELS = {
  // 连接管理
  CONNECTION_CONNECT: 'connection:connect',
  CONNECTION_DISCONNECT: 'connection:disconnect',
  CONNECTION_RECONNECT: 'connection:reconnect',
  CONNECTION_STATUS: 'connection:status',
  CONNECTION_REACHABLE: 'connection:reachable',
  REACHABILITY_PROBE_NOW: 'reachability:probe-now',
  CONNECTION_CLONE_CHANNEL: 'connection:clone-channel',  // 克隆渠道

  // 会话管理
  SESSION_CREATE: 'session:create',
  SESSION_UPDATE: 'session:update',
  SESSION_DELETE: 'session:delete',
  SESSION_LIST: 'session:list',
  SESSION_GET: 'session:get',
  SESSIONS_CHANGED: 'sessions:changed',  // 外部路径（MCP）改动会话列表后的推送

  // 串口
  SERIAL_LIST_PORTS: 'serial:list-ports',

  // 终端操作
  TERMINAL_WRITE: 'terminal:write',
  TERMINAL_RESIZE: 'terminal:resize',
  TERMINAL_DATA: 'terminal:data',
  TERMINAL_OPEN_SESSIONS_SYNC: 'terminal:open-sessions-sync',
  MCP_SESSION_LOCKED: 'mcp:session-locked',
  MCP_SESSION_UNLOCKED: 'mcp:session-unlocked',

  // 配置管理
  CONFIG_GET: 'config:get',
  CONFIG_SET: 'config:set',

  // MCP 注册命令
  MCP_GET_ADD_COMMAND: 'mcp:get-add-command',

  // MCP 审计日志
  MCP_AUDIT_LIST: 'mcp-audit:list',
  MCP_AUDIT_CLEAR: 'mcp-audit:clear',

  // MCP 触发渲染层打开"新建连接"对话框（C4：凭据交还用户）
  MCP_OPEN_CONNECTION_DIALOG: 'mcp:open-connection-dialog',

  // 浮窗
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
  onConnectionStatus: (callback: (status: unknown) => void) => {
    const listener = (_event: IpcRendererEvent, status: unknown) => callback(status)
    ipcRenderer.on(IPC_CHANNELS.CONNECTION_STATUS, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.CONNECTION_STATUS, listener)
  },
  onSessionReachable: (callback: (payload: { key: string; reachable: boolean; reason?: string }) => void) => {
    const listener = (_event: IpcRendererEvent, payload: { key: string; reachable: boolean; reason?: string }) => callback(payload)
    ipcRenderer.on(IPC_CHANNELS.CONNECTION_REACHABLE, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.CONNECTION_REACHABLE, listener)
  },
  onSessionsChanged: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on(IPC_CHANNELS.SESSIONS_CHANGED, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SESSIONS_CHANGED, listener)
  },
  probeReachabilityNow: (): Promise<{ success: true }> => ipcRenderer.invoke(IPC_CHANNELS.REACHABILITY_PROBE_NOW),

  // 会话管理
  createSession: (session: unknown) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_CREATE, session),
  updateSession: (session: unknown) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_UPDATE, session),
  deleteSession: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_DELETE, sessionId),
  listSessions: () => ipcRenderer.invoke(IPC_CHANNELS.SESSION_LIST),
  getSession: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_GET, sessionId),

  // 串口枚举
  listSerialPorts: () => ipcRenderer.invoke(IPC_CHANNELS.SERIAL_LIST_PORTS),

  // 终端操作
  terminalWrite: (sessionId: string, data: string) =>
    ipcRenderer.send(IPC_CHANNELS.TERMINAL_WRITE, sessionId, data),
  terminalResize: (sessionId: string, cols: number, rows: number) =>
    ipcRenderer.send(IPC_CHANNELS.TERMINAL_RESIZE, sessionId, cols, rows),
  onTerminalData: (callback: (sessionId: string, data: string) => void) => {
    const listener = (_event: IpcRendererEvent, sessionId: string, data: string) => callback(sessionId, data)
    ipcRenderer.on(IPC_CHANNELS.TERMINAL_DATA, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_DATA, listener)
  },
  syncTerminalOpenSessions: (sessionIds: string[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_OPEN_SESSIONS_SYNC, sessionIds),
  // MCP 占用/释放共享 PTY 通知
  onMcpSessionLocked: (callback: (payload: { sessionId: string }) => void) => {
    const listener = (_event: IpcRendererEvent, payload: unknown) => callback(payload as { sessionId: string })
    ipcRenderer.on(IPC_CHANNELS.MCP_SESSION_LOCKED, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MCP_SESSION_LOCKED, listener)
  },
  onMcpSessionUnlocked: (callback: (payload: { sessionId: string }) => void) => {
    const listener = (_event: IpcRendererEvent, payload: unknown) => callback(payload as { sessionId: string })
    ipcRenderer.on(IPC_CHANNELS.MCP_SESSION_UNLOCKED, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MCP_SESSION_UNLOCKED, listener)
  },

  // 配置管理
  getConfig: (key: string) => ipcRenderer.invoke(IPC_CHANNELS.CONFIG_GET, key),
  setConfig: (key: string, value: unknown) => ipcRenderer.invoke(IPC_CHANNELS.CONFIG_SET, key, value),
  getMcpAddCommand: () => ipcRenderer.invoke(IPC_CHANNELS.MCP_GET_ADD_COMMAND),
  getMcpAudit: (filter?: unknown) => ipcRenderer.invoke(IPC_CHANNELS.MCP_AUDIT_LIST, filter),
  clearMcpAudit: () => ipcRenderer.invoke(IPC_CHANNELS.MCP_AUDIT_CLEAR),

  // MCP 打开"新建连接"对话框（C4）—— 供 agent 把凭据填写交还给用户
  onMcpOpenConnectionDialog: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on(IPC_CHANNELS.MCP_OPEN_CONNECTION_DIALOG, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MCP_OPEN_CONNECTION_DIALOG, listener)
  },

  // 浮窗
  onFloatToggle: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on(IPC_CHANNELS.FLOAT_TOGGLE, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.FLOAT_TOGGLE, listener)
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
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  selectDirectory: () => ipcRenderer.invoke('window:select-directory'),

  // 数据导出导入
  exportData: (data: unknown, encryptPassword?: string) => ipcRenderer.invoke(IPC_CHANNELS.EXPORT_DATA, data, encryptPassword),
  importData: (decryptPassword?: string, filePath?: string) => ipcRenderer.invoke(IPC_CHANNELS.IMPORT_DATA, decryptPassword, filePath),

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
  onFileProgress: (callback: (progress: unknown) => void) => {
    const listener = (_event: IpcRendererEvent, progress: unknown) => callback(progress)
    ipcRenderer.on(IPC_CHANNELS.FILE_PROGRESS, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.FILE_PROGRESS, listener)
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