/**
 * 会话配置
 */
export interface SessionConfig {
  id: string
  name: string
  group?: string

  // 连接类型
  type: ConnectionType

  // 连接配置
  ssh?: SSHConfig
  telnet?: TelnetConfig
  serial?: SerialConfig
  local?: LocalConfig

  // 终端配置
  terminal: TerminalConfig

  // 标签
  tags: string[]

  // 置顶排序顺序（数字越小排在前面）
  pinOrder?: number

  // 连接后自动执行的命令/文本
  startupCommands?: string[]

  // 连接统计
  connectCount?: number

  // 创建和修改时间
  createdAt: Date
  updatedAt: Date
}

/**
 * 连接类型
 */
export enum ConnectionType {
  SSH = 'ssh',
  TELNET = 'telnet',
  SERIAL = 'serial',
  LOCAL = 'local'
}

/**
 * SSH 配置
 */
export interface SSHConfig {
  host: string
  port: number
  username: string
  password?: string
  privateKey?: string
  passphrase?: string
  keepaliveInterval?: number
  readyTimeout?: number
  // 进入 shell 的命令（多行，每行一个命令，按顺序执行）
  // 例如: "shell\nenable\n" 或直接 "bash"
  shellEnterCommands?: string
  // 进入 shell 后的等待时间（毫秒），默认 1000
  shellEnterWait?: number
}

/**
 * Telnet 配置
 */
export interface TelnetConfig {
  host: string
  port: number
  timeout?: number
}

/**
 * 串口配置
 */
export interface SerialConfig {
  path: string
  baudRate: number
  dataBits?: 5 | 6 | 7 | 8
  stopBits?: 1 | 2
  parity?: 'none' | 'even' | 'odd' | 'mark' | 'space'
}

/**
 * 本地终端配置
 */
export interface LocalConfig {
  shell?: string
  cwd?: string
  env?: Record<string, string>
}

/**
 * 终端配置
 */
export interface TerminalConfig {
  fontFamily: string
  fontSize: number
  lineHeight?: number
  theme: TerminalTheme
  cursorStyle: 'block' | 'underline' | 'bar'
  cursorBlink: boolean
  scrollback: number
  encoding: 'utf-8' | 'gbk' | 'gb2312'
}

/**
 * 终端主题
 */
export interface TerminalTheme {
  foreground: string
  background: string
  cursor: string
  cursorAccent?: string
  selectionBackground: string
  selectionInactiveBackground?: string
  selectionForeground?: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

/**
 * 连接状态
 */
export enum ConnectionStatus {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting',
  ERROR = 'error'
}

/**
 * 会话统计
 */
export interface SessionStats {
  lastConnected?: Date
  connectCount: number
  isFavorite: boolean
}