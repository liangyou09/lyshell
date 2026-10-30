import { TERMINAL_ENCODINGS } from '../constants'

/**
 * 会话配置
 */
export interface SessionConfig {
  /** 插件创建资源的持久归属；禁用/卸载时回收，复用用户配置不写入。 */
  ownerPluginId?: string
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
 * 秘密字段的公开状态：只表达存在性与本次运行能否解密，绝不含真实值。
 */
export interface SessionSecretState {
  present: boolean
  /** 存储里仍有密文，但本次运行无法解密（安全存储不可用/解密失败）——使用前必须重新输入。 */
  locked?: boolean
}

/**
 * SSH 三个秘密字段的公开状态（getPublic/getAllPublic 的 sshSecrets）。
 */
export interface SessionSshSecretState {
  password?: SessionSecretState
  privateKey?: SessionSecretState
  passphrase?: SessionSecretState
}

/**
 * 供 UI/IPC 使用的安全会话形态：
 * ssh.password/privateKey/passphrase 与 local.env 的秘密值都被替换为
 * SECRET_PLACEHOLDER（``__LYSHELL_SECRET_UNCHANGED__``），真实值只在 main 运行期 get/getAll。
 */
export interface SessionPublicConfig extends SessionConfig {
  sshSecrets?: SessionSshSecretState
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
  // 可续接终端：交互 shell 在远端 tmux 里运行，断线后可附着回原会话。
  // 仅在用户显式开启时生效；关闭时行为与旧版本完全一致。远端没有 tmux 会在连接时明确报错。
  keepSessionAlive?: boolean
  // 仅运行期注入：要附着回来的原 tmux 会话名（保存区恢复用）。
  // 普通配置编辑不暴露、不保存；带该名时只 attach 已有会话，不会新建同名会话冒充恢复成功。
  resumeSessionName?: string
  // 仅本次普通 SSH 重连尽力回到的目录；不写入保存的连接配置。
  resumeDirectory?: string
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
  /** 仅运行期：当前档案下已鉴权的独立 PTY 宿主引用；普通保存配置不写入。 */
  terminalHostId?: string
  shell?: string
  /** 启动 shell 的附加参数（如 agent 宿主 pwsh 的 -NoProfile）；缺省无参 */
  shellArgs?: string[]
  cwd?: string
  env?: Record<string, string>
  /**
   * 秘密 env 的 SecretStore 引用（KEY → sec_…）。env 中同名键不落明文；
   * 仅由 main 的 SessionRepository 维护，外部输入不可信。
   */
  envSecretRefs?: Record<string, string>
  /** 业务显式声明的秘密 env 键（键名本身不像秘密时补充 isSecretEnvKey 判定）。 */
  secretEnvKeys?: string[]
}

/**
 * 终端字符编码 —— 读方向(connector 解码流)/写方向(write 编码)共用。
 * 从 TERMINAL_ENCODINGS 白名单派生(typeof [number]):加编码只改常量一处,
 * 类型自动跟随,不会与手写的联合漂移。
 * local 会话不适用(ConPTY 恒为 UTF-8)
 */
export type TerminalEncoding = typeof TERMINAL_ENCODINGS[number]

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
  encoding: TerminalEncoding
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
