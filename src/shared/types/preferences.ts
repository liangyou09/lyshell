/**
 * 用户偏好设置
 */
export interface UserPreferences {
  // 外观
  appearance: AppearanceSettings

  // 浮窗
  floatWindow: FloatWindowSettings

  // 主窗口尺寸(像素) -- 持久化到 preferences.json 的 'window' 键,启动时由主进程读取恢复
  window?: WindowSettings

  // 终端
  terminal: TerminalSettings

  // Python
  python: PythonSettings

  // AI
  ai: AISettings

  // 安全
  security: SecuritySettings
}

/**
 * 外观设置
 */
export interface AppearanceSettings {
  theme: 'light' | 'dark' | 'system'
  accentColor: string
  fontSize: number
  fontFamily: string
}

/**
 * 浮窗设置
 */
export interface FloatWindowSettings {
  enabled: boolean
  position: FloatWindowPosition
  opacity: number
  sizeStrategy: 'auto' | 'fixed'
  fixedSize?: { width: number; height: number }
  hotkey: string
  showOnStartup: boolean
  autoCloseOnExecute: boolean
  autoCloseOnConnect: boolean
  autoCloseOnBlur: boolean
  blurDelay: number
  defaultTab: 'sessions' | 'commands' | 'history'
  hoverTrigger: boolean
  hoverDelay: number
}

/**
 * 浮窗位置
 */
export enum FloatWindowPosition {
  TOP_RIGHT = 'top-right',
  TOP_LEFT = 'top-left',
  BOTTOM_RIGHT = 'bottom-right',
  BOTTOM_LEFT = 'bottom-left',
  CUSTOM = 'custom'
}

/**
 * 主窗口尺寸设置(像素)
 * 运行时以扁平 key 'window' 存入 preferences.json,与 sidebarWidth/security 等一致;
 * 主进程 createMainWindow 读取并据此调整 BrowserWindow 初始尺寸。
 */
export interface WindowSettings {
  width: number
  height: number
}

/**
 * 终端设置
 */
export interface TerminalSettings {
  defaultProfile: string
  closeOnExit: boolean
  confirmClose: boolean
  autoReconnect: boolean
  reconnectAttempts: number
  reconnectDelay: number
}

/**
 * Python 设置
 */
export interface PythonSettings {
  enabled: boolean
  pythonPath: string
  defaultTimeout: number
  sandboxEnabled: boolean
  allowedModules: string[]
}

/**
 * AI 设置
 */
export interface AISettings {
  enabled: boolean
  provider: 'openai' | 'anthropic' | 'local' | 'custom'
  apiKey?: string
  endpoint?: string
  model?: string
  maxTokens: number
  temperature: number
}

/**
 * 安全设置
 */
export interface SecuritySettings {
  masterPassword?: string
  autoLock: boolean
  lockTimeout: number
  clearClipboard: boolean
  clearClipboardDelay: number
  mcp?: McpSecuritySettings
}

export interface McpSecuritySettings {
  enabled: boolean
  allowRead: boolean
  allowInteractiveInput: boolean
  allowSshExecute: boolean
  allowLocalExecute: boolean
  allowFileWrite: boolean
  requireConfirmation: boolean
  allowedSessionIds: string[]
  deniedSessionIds: string[]
  /**
   * 是否允许 MCP 客户端执行会话控制操作（目前仅 reconnect_session）。
   * 默认对 session token 始终放行（属于"自驱"语义）；
   * 对 global token (外部 MCP 客户端) 默认 false —— 需用户在此显式开启。
   * undefined 视为 false（前向兼容旧偏好文件）。
   */
  allowSessionControl?: boolean
  /**
   * 是否允许 MCP 客户端读写会话摘要、使用说明及标签等元数据。
   * 默认 false：防止外部 MCP 客户端未经提示修改会话备注。
   * undefined 视为 false（前向兼容旧偏好文件）。
   */
  allowSessionMetadataWrite?: boolean
  /**
   * 是否对疑似破坏性的命令（rm -rf /、dd 到块设备、mkfs、fork bomb、关机重启、
   * chmod 根目录等）在执行前弹窗确认。
   *
   * 关键：对 session token（LyShell 自身孵化的 PTY）同样生效——session token 在
   * authorizeMcpOperation 中跳过 requireConfirmation 弹窗，破坏性命令确认是它
   * 之外的内容级防御层，用于阻断 prompt-injection 触发的灾难性操作。
   * 默认 true。undefined 视为 true（前向兼容：老偏好文件缺该键时也开启）。
   */
  confirmDestructiveCommands?: boolean
  /**
   * 是否对"首次"向一个空白的会话写入 summary/usageNotes/tags 时弹窗确认（C6）。
   *
   * 防御 prompt-injection 静默打标签：被注入的 agent 可能把生产会话标成 test-env、
   * 或写入误导性 summary，污染后续 agent 的会话识别与路由。仅对 session token 生效——
   * session token 跳过 requireConfirmation，本层是其写入元数据的唯一人工闸门；
   * global token 已由 requireConfirmation 弹窗覆盖，不重复弹。
   * 仅当目标会话当前为空（无 summary/usageNotes/tags）且本次将写入非空内容时触发，
   * 后续覆写仍走既有 overwrite 校验。默认 true。
   */
  confirmFirstNotesWrite?: boolean
  /**
   * 是否允许 LyShell 进程外的 MCP 客户端通过端口文件接入。
   * 默认 false：MCP 仅对 LyShell 自身孵化的本地 PTY 开放（per-session token 经
   * 环境变量注入），LyShell 关闭或 PTY 退出后 token 自动失效。
   * 开启后端口文件含全局 token，任何能读到该文件的本机进程都可接入，仍受 allow* 策略约束。
   */
  allowExternalMcpClients?: boolean
}