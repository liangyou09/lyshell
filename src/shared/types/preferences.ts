/**
 * 用户偏好设置
 */
export interface UserPreferences {
  // 外观
  appearance: AppearanceSettings

  // 浮窗
  floatWindow: FloatWindowSettings

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
  allowFileDelete: boolean
  requireConfirmation: boolean
  allowedSessionIds: string[]
  deniedSessionIds: string[]
  /**
   * 是否允许 LyShell 进程外的 MCP 客户端通过端口文件接入。
   * 默认 false：MCP 仅对 LyShell 自身孵化的本地 PTY 开放（per-session token 经
   * 环境变量注入），LyShell 关闭或 PTY 退出后 token 自动失效。
   * 开启后端口文件含全局 token，任何能读到该文件的本机进程都可接入，仍受 allow* 策略约束。
   */
  allowExternalMcpClients?: boolean
}