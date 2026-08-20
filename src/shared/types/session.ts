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

  // 会话摘要（一句话描述用途）
  summary?: string

  // 使用说明（操作提示、注意事项、常用命令等）
  usageNotes?: string

  // 置顶排序顺序（数字越小排在前面）
  pinOrder?: number

  // 连接后自动执行的命令/文本
  startupCommands?: string[]

  // 连接统计
  connectCount?: number

  // 创建和修改时间
  createdAt: Date
  updatedAt: Date

  // 运行时会话关联的已保存会话 ID。
  // 前端打开 saved session 时会清空 id 并生成新的 runtime UUID，
  // 通过此字段可把 runtime 会话与原始保存项关联起来（如 MCP list_sessions 状态同步）。
  originSavedSessionId?: string
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
 * 串口设备扫描信息（main 进程 SerialPort.list() 的渲染层投影）
 * 不直接复用 @serialport/bindings-interface 的 PortInfo，避免 shared 类型依赖 Node 包
 */
export interface SerialPortInfo {
  path: string
  manufacturer?: string
  serialNumber?: string
  pnpId?: string
  friendlyName?: string
  vendorId?: string
  productId?: string
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