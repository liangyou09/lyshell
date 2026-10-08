import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { WorktreeListResult } from '@shared/worktree'
import type { SessionConfig, TerminalEncoding, WebTabPopupRequest } from '@shared/types'

// IPC 通道定义
const IPC_CHANNELS = {
  EXPLORER_LAUNCH_PENDING: 'explorer:launch-pending',
  EXPLORER_LAUNCH_TAKE: 'explorer:launch-take',
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
  SESSION_DELETED: 'session:deleted',
  SESSION_LIST: 'session:list',
  SESSION_GET: 'session:get',
  SESSION_SET_ENCODING: 'session:set-encoding',  // 状态栏点击运行时切换编码
  SESSION_ENCODING_CHANGED: 'session:encoding-changed',  // 运行时编码切换完成后的推送
  SESSION_CWD_CHANGED: 'session:cwd-changed',  // local 会话工作目录推送（spawn 初始值 + OSC 报告实时更新）
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
  MCP_AUDIT_FACETS: 'mcp-audit:facets',
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
  FILE_CANCEL: 'file:cancel',
  FILE_DELETE: 'file:delete',
  FILE_RENAME: 'file:rename',
  FILE_MKDIR: 'file:mkdir',
  FILE_PROGRESS: 'file:progress',
  FILE_CONNECTOR_TYPE: 'file:connector-type',
  FILE_OPEN_FOLDER: 'file:open-folder',
  FILE_MD5: 'file:md5',
  FILE_PWD: 'file:pwd',
  FILE_READ_DOC: 'file:read-doc',  // 读取远端文档（预览用）
  FILE_READ_LOCAL_DOC: 'file:read-local-doc',  // 读取本地文档（预览用）

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
  AGENT_LAUNCH: 'agent:launch',

  // 全局环境变量组库(左列 ENV 面板、Agent 编辑对话框的绑定下拉与 harness 面板共用 list;
  // 启用指针是全应用单选一根,切换走 setActive)
  ENV_PROFILE_LIST: 'env-profile:list',
  ENV_PROFILE_ADD: 'env-profile:add',
  ENV_PROFILE_UPDATE: 'env-profile:update',
  ENV_PROFILE_DELETE: 'env-profile:delete',
  ENV_PROFILE_SET_ACTIVE: 'env-profile:setActive',

  // DeepSeek Harness (dsh)
  DSH_DETECT: 'dsh:detect',
  DSH_WORKSPACE_LIST: 'dsh:workspace:list',
  DSH_WORKSPACE_ADD: 'dsh:workspace:add',
  DSH_WORKSPACE_UPDATE: 'dsh:workspace:update',
  DSH_WORKSPACE_DELETE: 'dsh:workspace:delete',
  DSH_WORKSPACE_LAUNCH: 'dsh:workspace:launch',
  DSH_ENV_DEFAULTS: 'dsh:env:defaults',
  DSH_WEB_OPEN: 'dsh:web:open',
  DSH_WEB_CLOSE: 'dsh:web:close',

  // 网页访问栏（通用网页页签）
  WEBBAR_FETCH_FAVICON: 'webbar:fetch-favicon',
  WEBBAR_REGISTER_MINI: 'webbar:register-mini',  // renderer→main：写轮眼小窗 dom-ready 后自报 webContentsId
  WEB_TAB_SHORTCUT: 'web-tab:shortcut',  // main→renderer：webview 焦点内的浏览器快捷键转发
  WEB_TAB_POPUP: 'web-tab:popup',  // main→renderer：webview 弹窗跳转地址转发（deny + 转页签；小窗普通点击原地跳，不走此通道）
  WEB_TAB_POST_LOAD: 'web-tab:post-load',  // renderer→main：POST 页签 dom-ready 后认领一次性正文

  // Harness worktree 检测（kind 无关：列出仓库已有 worktree 共享名，编辑对话框下拉用）
  HARNESS_WORKTREE_LIST: 'harness:worktree:list',

  // Codex Harness
  CODEX_DETECT: 'codex:detect',
  CODEX_WORKSPACE_LIST: 'codex:workspace:list',
  CODEX_WORKSPACE_ADD: 'codex:workspace:add',
  CODEX_WORKSPACE_UPDATE: 'codex:workspace:update',
  CODEX_WORKSPACE_DELETE: 'codex:workspace:delete',
  CODEX_WORKSPACE_LAUNCH: 'codex:workspace:launch',
  CODEX_ENV_DEFAULTS: 'codex:env:defaults',

  // Claude Harness
  CLAUDE_DETECT: 'claude:detect',
  CLAUDE_WORKSPACE_LIST: 'claude:workspace:list',
  CLAUDE_WORKSPACE_ADD: 'claude:workspace:add',
  CLAUDE_WORKSPACE_UPDATE: 'claude:workspace:update',
  CLAUDE_WORKSPACE_DELETE: 'claude:workspace:delete',
  CLAUDE_WORKSPACE_LAUNCH: 'claude:workspace:launch',
  CLAUDE_ENV_DEFAULTS: 'claude:env:defaults',

  // Plugin 管理(install[dev]/zip/url/enable/disable/uninstall/list)
  PLUGIN_LIST: 'plugin:list',
  PLUGIN_PICK_FOLDER: 'plugin:pick-folder',
  PLUGIN_INSTALL_DEV: 'plugin:install-dev',
  PLUGIN_PICK_FILE: 'plugin:pick-file',
  PLUGIN_FETCH_URL: 'plugin:fetch-url',
  PLUGIN_INSTALL_ZIP: 'plugin:install-zip',
  PLUGIN_CANCEL_DOWNLOAD: 'plugin:cancel-download',
  PLUGIN_ENABLE: 'plugin:enable',
  PLUGIN_DISABLE: 'plugin:disable',
  PLUGIN_RUN_ONESHOT: 'plugin:run-oneshot',
  PLUGIN_UNINSTALL: 'plugin:uninstall',

  // 插件界面视图（机柜轨贡献点；通道语义见 @shared/constants IPC_CHANNELS 同名注释）
  PLUGIN_VIEWS_CHANGED: 'plugin:views-changed',
  PLUGIN_RESOURCES_RELEASED: 'plugin:resources-released',
  PLUGIN_VIEW_ICON: 'plugin:view-icon',
  PLUGIN_VIEW_ACTION_REQUEST: 'plugin:view-action-request',
  PLUGIN_VIEW_ACTION_RESULT: 'plugin:view-action-result',

  // 界面明暗模式推送（renderer→main fire-and-forget；插件视图页主题感知用）
  UI_THEME_MODE: 'ui:theme-mode'
}

// 暴露给渲染进程的 API
const electronAPI = {
  takeExplorerLaunches: (): Promise<SessionConfig[]> => ipcRenderer.invoke(IPC_CHANNELS.EXPLORER_LAUNCH_TAKE),
  onExplorerLaunchPending: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on(IPC_CHANNELS.EXPLORER_LAUNCH_PENDING, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.EXPLORER_LAUNCH_PENDING, listener)
  },
  // 连接管理
  connect: (config: unknown, pluginActionRequestId?: string, sourceSessionId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CONNECTION_CONNECT, config, pluginActionRequestId, sourceSessionId),
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
  onSessionDeleted: (callback: (sessionId: string) => void) => {
    const listener = (_event: IpcRendererEvent, sessionId: string) => callback(sessionId)
    ipcRenderer.on(IPC_CHANNELS.SESSION_DELETED, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SESSION_DELETED, listener)
  },
  onPluginResourcesReleased: (callback: (pluginId: string, webOrigins?: string[]) => void) => {
    const listener = (_event: IpcRendererEvent, pluginId: string, webOrigins?: string[]) => callback(pluginId, webOrigins)
    ipcRenderer.on(IPC_CHANNELS.PLUGIN_RESOURCES_RELEASED, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PLUGIN_RESOURCES_RELEASED, listener)
  },
  listSessions: () => ipcRenderer.invoke(IPC_CHANNELS.SESSION_LIST),
  getSession: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_GET, sessionId),
  // 状态栏点击运行时切换会话编码（只改运行时会话，不写回保存的配置）
  setSessionEncoding: (sessionId: string, encoding: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SESSION_SET_ENCODING, sessionId, encoding),
  // 运行时编码切换完成后的推送（状态栏点击 / MCP create_session 复用落位）
  onSessionEncodingChanged: (callback: (payload: { sessionId: string; encoding: TerminalEncoding }) => void) => {
    const listener = (_event: IpcRendererEvent, payload: { sessionId: string; encoding: TerminalEncoding }) => callback(payload)
    ipcRenderer.on(IPC_CHANNELS.SESSION_ENCODING_CHANGED, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SESSION_ENCODING_CHANGED, listener)
  },
  // local 会话工作目录推送（页签悬停详情卡显示；spawn 初始值 + OSC 报告实时更新）
  onSessionCwdChanged: (callback: (payload: { sessionId: string; cwd: string }) => void) => {
    const listener = (_event: IpcRendererEvent, payload: { sessionId: string; cwd: string }) => callback(payload)
    ipcRenderer.on(IPC_CHANNELS.SESSION_CWD_CHANGED, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SESSION_CWD_CHANGED, listener)
  },

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
  getMcpAuditFacets: () => ipcRenderer.invoke(IPC_CHANNELS.MCP_AUDIT_FACETS),
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

  // 网页页签快捷键（main→renderer）：焦点在 webview 内时宿主收不到 keydown，
  // 主进程 before-input-event 拦截后经此转发，渲染层路由到活动网页页签
  onWebTabShortcut: (callback: (action: string) => void) => {
    const listener = (_e: IpcRendererEvent, action: string): void => callback(action)
    ipcRenderer.on(IPC_CHANNELS.WEB_TAB_SHORTCUT, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.WEB_TAB_SHORTCUT, listener)
  },

  // 网页页签弹窗跳转（main→renderer）：webview 的开窗请求（target=_blank /
  // window.open）在主进程一律 deny，http/https 地址经此转发，渲染层开完整网页页签。
  // background = 修饰键语义（中键/Ctrl+点击，disposition=background-tab）：
  // 页签挂后台不激活，用户不被拽走
  onWebTabPopup: (callback: (req: WebTabPopupRequest) => void) => {
    const listener = (_e: IpcRendererEvent, req: WebTabPopupRequest): void => callback(req)
    ipcRenderer.on(IPC_CHANNELS.WEB_TAB_POPUP, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.WEB_TAB_POPUP, listener)
  },
  loadWebTabPost: (token: string, webContentsId: number): Promise<{ success: boolean }> =>
    ipcRenderer.invoke(IPC_CHANNELS.WEB_TAB_POST_LOAD, token, webContentsId),

  // 写轮眼小窗登记（renderer→main）：小窗与完整页签共用 webbar partition（共享
  // 登录态）后，主进程快捷键转发无法凭 session 区分两者 —— 小窗 dom-ready 后把
  // 自身 webContentsId 报上来，主进程据此把小窗排除在转发之外（按键原样进页面）
  registerWebbarMini: (webContentsId: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.WEBBAR_REGISTER_MINI, webContentsId),

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
  // 全局环境变量组（Agent 编辑对话框的绑定下拉、harness 面板共用 list；
  // 启用指针全局单选一根，setActive 切换）
  listEnvProfiles: () => ipcRenderer.invoke(IPC_CHANNELS.ENV_PROFILE_LIST),
  addEnvProfile: (profile: unknown) => ipcRenderer.invoke(IPC_CHANNELS.ENV_PROFILE_ADD, profile),
  updateEnvProfile: (profile: unknown) => ipcRenderer.invoke(IPC_CHANNELS.ENV_PROFILE_UPDATE, profile),
  deleteEnvProfile: (profileId: string) => ipcRenderer.invoke(IPC_CHANNELS.ENV_PROFILE_DELETE, profileId),
  setEnvProfileActive: (profileId: string | null) => ipcRenderer.invoke(IPC_CHANNELS.ENV_PROFILE_SET_ACTIVE, profileId),

  // DeepSeek Harness (dsh)
  detectDsh: () => ipcRenderer.invoke(IPC_CHANNELS.DSH_DETECT),
  listDshWorkspaces: () => ipcRenderer.invoke(IPC_CHANNELS.DSH_WORKSPACE_LIST),
  addDshWorkspace: (workspace: unknown) => ipcRenderer.invoke(IPC_CHANNELS.DSH_WORKSPACE_ADD, workspace),
  updateDshWorkspace: (workspace: unknown) => ipcRenderer.invoke(IPC_CHANNELS.DSH_WORKSPACE_UPDATE, workspace),
  deleteDshWorkspace: (workspaceId: string) => ipcRenderer.invoke(IPC_CHANNELS.DSH_WORKSPACE_DELETE, workspaceId),
  launchDshWorkspace: (workspaceId: string) => ipcRenderer.invoke(IPC_CHANNELS.DSH_WORKSPACE_LAUNCH, workspaceId),
  getDshEnvDefaults: () => ipcRenderer.invoke(IPC_CHANNELS.DSH_ENV_DEFAULTS),
  openDshWeb: (target: { workspaceId?: string; cwd?: string }) => ipcRenderer.invoke(IPC_CHANNELS.DSH_WEB_OPEN, target),
  closeDshWeb: () => ipcRenderer.invoke(IPC_CHANNELS.DSH_WEB_CLOSE),

  // 网页访问栏 favicon 代取（主进程限制 http/https + 体积，返回 data URI；渲染层 CSP 不放行远程图）
  fetchFavicon: (url: string): Promise<{ success: true; dataUri: string } | { success: false; error: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.WEBBAR_FETCH_FAVICON, { url }),

  // 列出 cwd 所属仓库 .lyshell-worktrees/ 下的共享名（worktree 隔离编辑框的下拉选项），
  // 一并返回 worktree 根目录绝对路径（渲染层预览自动生成 key 的完整路径）。
  // 返回类型是 @shared/worktree 的 WorktreeListResult（success 判别联合，与主进程 handler 对齐）
  listHarnessWorktrees: (cwd: string): Promise<WorktreeListResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.HARNESS_WORKTREE_LIST, cwd),

  // Codex Harness
  detectCodex: () => ipcRenderer.invoke(IPC_CHANNELS.CODEX_DETECT),
  listCodexWorkspaces: () => ipcRenderer.invoke(IPC_CHANNELS.CODEX_WORKSPACE_LIST),
  addCodexWorkspace: (workspace: unknown) => ipcRenderer.invoke(IPC_CHANNELS.CODEX_WORKSPACE_ADD, workspace),
  updateCodexWorkspace: (workspace: unknown) => ipcRenderer.invoke(IPC_CHANNELS.CODEX_WORKSPACE_UPDATE, workspace),
  deleteCodexWorkspace: (workspaceId: string) => ipcRenderer.invoke(IPC_CHANNELS.CODEX_WORKSPACE_DELETE, workspaceId),
  launchCodexWorkspace: (workspaceId: string) => ipcRenderer.invoke(IPC_CHANNELS.CODEX_WORKSPACE_LAUNCH, workspaceId),
  getCodexEnvDefaults: () => ipcRenderer.invoke(IPC_CHANNELS.CODEX_ENV_DEFAULTS),

  // Claude Harness
  detectClaude: () => ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_DETECT),
  listClaudeWorkspaces: () => ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_WORKSPACE_LIST),
  addClaudeWorkspace: (workspace: unknown) => ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_WORKSPACE_ADD, workspace),
  updateClaudeWorkspace: (workspace: unknown) => ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_WORKSPACE_UPDATE, workspace),
  deleteClaudeWorkspace: (workspaceId: string) => ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_WORKSPACE_DELETE, workspaceId),
  launchClaudeWorkspace: (workspaceId: string) => ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_WORKSPACE_LAUNCH, workspaceId),
  getClaudeEnvDefaults: () => ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_ENV_DEFAULTS),

  // Plugin 管理
  listPlugins: () => ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_LIST),
  pickPluginFolder: () => ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_PICK_FOLDER),
  installDevPlugin: (req: unknown) => ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_INSTALL_DEV, req),
  pickPluginFile: () => ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_PICK_FILE),
  fetchPluginUrl: (req: unknown) => ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_FETCH_URL, req),
  installZipPlugin: (req: unknown) => ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_INSTALL_ZIP, req),
  cancelPluginDownload: (filePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_CANCEL_DOWNLOAD, filePath),
  enablePlugin: (pluginId: string) => ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_ENABLE, pluginId),
  disablePlugin: (pluginId: string) => ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_DISABLE, pluginId),
  runOneshotPlugin: (pluginId: string) => ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_RUN_ONESHOT, pluginId),
  uninstallPlugin: (pluginId: string) => ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_UNINSTALL, pluginId),

  // 插件视图页面主题感知：把界面明暗模式推给 main（fire-and-forget；插件 guest
  // 页的 bootstrap().theme / themeChanged 事件以 main 持有的快照为准）
  setThemeMode: (mode: 'dark' | 'light') => ipcRenderer.send(IPC_CHANNELS.UI_THEME_MODE, mode),

  // ====================== 插件界面视图（机柜轨贡献点） ======================
  // 视图列表变化推送（负载为空，收到后调 listPlugins 重拉完整快照）
  onPluginViewsChanged: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on(IPC_CHANNELS.PLUGIN_VIEWS_CHANGED, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PLUGIN_VIEWS_CHANGED, listener)
  },
  // 视图图标：只传 pluginId/viewId，main 在已注册定义中查 icon 并净化后回 data URL
  // （失败 data:null，消费端回退内置图标）。返回信封 { success, data, error? }。
  getPluginViewIcon: (pluginId: string, viewId: string): Promise<{ success: boolean; data: string | null; error?: string }> =>
    ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_VIEW_ICON, { pluginId, viewId }),
  // UI 动作请求（main → renderer 单向推送）：guest 动作经 main 授权后转交本窗口执行
  onPluginViewActionRequest: (
    callback: (request: { requestId: string; action: string; pluginId: string; viewId: string; params: Record<string, unknown> }) => void
  ) => {
    const listener = (_event: IpcRendererEvent, request: { requestId: string; action: string; pluginId: string; viewId: string; params: Record<string, unknown> }) => callback(request)
    ipcRenderer.on(IPC_CHANNELS.PLUGIN_VIEW_ACTION_REQUEST, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PLUGIN_VIEW_ACTION_REQUEST, listener)
  },
  // 动作回执（renderer → main）：requestId 对账，main 只接受目标窗口的首次回执
  sendPluginViewActionResult: (receipt: { requestId: string; ok: boolean; error?: string }) =>
    ipcRenderer.send(IPC_CHANNELS.PLUGIN_VIEW_ACTION_RESULT, receipt),

  // 窗口
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  selectDirectory: () => ipcRenderer.invoke('window:select-directory'),
  setWindowSize: (width: number, height: number) => ipcRenderer.invoke('window:set-size', width, height),

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
  fileCancel: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.FILE_CANCEL, taskId),
  fileDelete: (sessionId: string, path: string) => ipcRenderer.invoke(IPC_CHANNELS.FILE_DELETE, sessionId, path),
  fileRename: (sessionId: string, oldPath: string, newPath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_RENAME, sessionId, oldPath, newPath),
  fileMkdir: (sessionId: string, path: string) => ipcRenderer.invoke(IPC_CHANNELS.FILE_MKDIR, sessionId, path),
  getFileConnectorType: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.FILE_CONNECTOR_TYPE, sessionId),
  openFolder: (filePath: string) => ipcRenderer.invoke(IPC_CHANNELS.FILE_OPEN_FOLDER, filePath),
  fileMd5: (sessionId: string, filePath: string) => ipcRenderer.invoke(IPC_CHANNELS.FILE_MD5, sessionId, filePath),
  filePwd: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.FILE_PWD, sessionId),
  fileReadDoc: (sessionId: string, path: string) => ipcRenderer.invoke(IPC_CHANNELS.FILE_READ_DOC, sessionId, path),
  fileReadLocalDoc: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.FILE_READ_LOCAL_DOC, path),
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
