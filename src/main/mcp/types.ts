/**
 * MCP HTTP API 相关类型定义
 * 主进程 HTTP 服务器与 MCP Server 进程之间共享
 */

/**
 * API 统一响应格式
 */
export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

/**
 * 会话信息（脱敏，不包含密码/私钥等敏感数据）
 *
 * 数据源为 sessionRepository（全部已保存会话），叠加 sessionManager 的 live 状态，
 * 与左侧会话栏列表一致——含未连接的离线会话，便于 agent 发现并选择目标。
 */
export interface SessionInfo {
  id: string
  name: string
  type: 'ssh' | 'telnet' | 'serial' | 'local'
  /** live 状态叠加：connected / connecting / reconnecting / error / disconnected */
  status: string
  /** ssh / telnet 主机；serial 为路径、local 为 cwd 的便捷别名（详见 path/shell） */
  host?: string
  /** ssh / telnet 端口 */
  port?: number
  group?: string
  tags: string[]
  capabilities: SessionCapabilities

  // —— 侧边栏展示元信息（按协议填充，全部脱敏）——
  /** ssh 登录用户名 */
  username?: string
  /** serial 设备路径 */
  path?: string
  /** serial 波特率 */
  baudRate?: number
  /** local shell 可执行文件 */
  shell?: string
  /** local 工作目录 */
  cwd?: string

  // —— 供 agent 选择目标会话用的辅助字段 ——
  /** 一句话用途摘要（与 read_session_notes 同源） */
  summary?: string
  /** 是否置顶（由 tags 含 'pinned' 派生） */
  pinned?: boolean
  /** 历史连接次数，衡量使用频率 */
  connectCount?: number
  /** 最近修改时间（ISO 字符串） */
  updatedAt?: string
  /** 当前是否在终端页签/分屏中打开 */
  inTerminal?: boolean
}

/**
 * 会话能力（该会话支持哪些操作）
 */
export interface SessionCapabilities {
  /** 支持向交互式终端发送输入（所有类型） */
  sendInput: boolean
  /** 支持非交互式命令执行并获取输出（SSH/Local） */
  executeCommand: boolean
  /** 支持文件操作（SSH only） */
  fileOperations: boolean
  /** 支持读取终端输出（所有已连接会话） */
  readOutput: boolean
}

/**
 * 执行命令请求
 */
export interface ExecuteRequest {
  sessionId: string
  command: string
  timeout?: number
}

/**
 * 执行命令响应
 */
export interface ExecuteResponse {
  output: string
  exitCode: number
}

/**
 * 读取文件请求
 */
export interface ReadFileRequest {
  sessionId: string
  path: string
  maxSize?: number
}

/**
 * 读取文件响应
 */
export interface ReadFileResponse {
  content: string
  size: number
}

/**
 * 下载文件请求
 */
export interface DownloadFileRequest {
  sessionId: string
  remotePath: string
  localPath: string
}

/**
 * 下载文件响应
 */
export interface DownloadFileResponse {
  md5?: string
  remotePath?: string
  localPath?: string
}

/**
 * 上传文件请求
 */
export interface UploadFileRequest {
  sessionId: string
  localPath: string
  remotePath: string
}

/**
 * 上传文件响应
 */
export interface UploadFileResponse {
  remotePath?: string
  localPath?: string
  md5?: string
}

/**
 * 文件操作请求（sessionId + path）
 */
export interface FileOperationRequest {
  sessionId: string
  path: string
  /** list_files 专用：递归列出子目录（stat 忽略） */
  recursive?: boolean
  /** list_files 专用：glob 过滤模式，对收集到的每个条目的 path 匹配（* / ** / ?）；stat 忽略 */
  glob?: string
  /** list_files 专用：递归/glob 模式下返回条目上限，防止巨目录打爆响应（默认 5000） */
  maxEntries?: number
}

/**
 * 发送输入请求（向交互式终端写入数据）
 */
export interface SendInputRequest {
  sessionId: string
  text: string
  autoNewline?: boolean
}

/**
 * 重连会话请求
 */
export interface ReconnectSessionRequest {
  sessionId: string
}

/**
 * 重连会话响应
 */
export interface ReconnectSessionResponse {
  sessionId: string
  /** 重连后的连接状态字符串 (ConnectionStatus enum 值) */
  status: string
}

/**
 * 读取终端输出请求
 */
export interface ReadOutputRequest {
  sessionId: string
  /** 返回最近 N 行（默认 100，最大 1000） */
  lines?: number
  /** 是否返回原始 ANSI 数据（默认 false，返回清洗后文本） */
  raw?: boolean
}

/**
 * 读取终端输出响应
 */
export interface ReadOutputResponse {
  output: string
  lines: number
  totalBufferSize: number
}

/**
 * 发送输入并等待响应请求
 */
export interface SendAndWaitRequest {
  sessionId: string
  /** 发送文本（支持 \n \r \xHH \t 转义） */
  text: string
  /** 最少等待时间 ms（默认 2000） */
  waitMs?: number
  /** 空闲检测阈值 ms（默认 300），无新输出即认为完成 */
  idleMs?: number
  /** 最大等待时间 ms（默认 10000） */
  maxWaitMs?: number
  /** 正则表达式，匹配后立即返回 */
  waitForPattern?: string
  /** 末尾非换行/控制字符时自动补 \n（默认 true） */
  autoNewline?: boolean
  /** best-effort 捕获退出码（POSIX shell only，会追加探针到命令后） */
  captureExitCode?: boolean
}

/**
 * 发送输入并等待响应结果
 */
export interface SendAndWaitResult {
  output: string
  /** 裁掉前端回显输入行后的输出 */
  cleanOutput: string
  settled: boolean
  patternMatched: boolean
  elapsedMs: number
  /** best-effort 退出码；仅在 captureExitCode=true 且解析成功时有值，否则 null */
  exitCode?: number | null
}

/**
 * MCP 端口信息文件格式
 *
 * v1: 单一全局 token，外部 MCP 客户端读取该文件即可接入。
 * v2: token 字段可为 null —— 表示外部访问已关闭，
 *     仅 LyShell 自身 PTY 通过 LYSHELL_MCP_TOKEN 环境变量注入的 per-session token 可接入。
 */
export interface McpPortInfo {
  port: number
  /** 全局 token；为 null 时表示禁用外部接入（仅 PTY 内 env 注入的 session token 有效）。 */
  token: string | null
  pid: number
  version: number
  /** v2 字段，标记当前是否允许外部 MCP 客户端通过端口文件接入。 */
  externalAccess?: boolean
}

/**
 * 注入到 LyShell 本地 PTY 的环境变量名。
 *
 * LyShell 启动 LOCAL 类型会话时，会为该 PTY 生成一个仅在该会话生命周期内有效的 token，
 * 经下列环境变量注入。运行在该 PTY 内的 Claude Code / MCP Server 子进程会继承这些变量
 * 并据此连接 LyShell HTTP API —— 进程不在该 PTY 子树中即拿不到 token。
 */
export const LYSHELL_MCP_ENV = {
  PORT: 'LYSHELL_MCP_PORT',
  TOKEN: 'LYSHELL_MCP_TOKEN',
  SESSION_ID: 'LYSHELL_MCP_SESSION_ID',
  USER_DATA: 'LYSHELL_USER_DATA',
} as const

/**
 * 会话摘要、使用说明及标签
 */
export interface SessionNotes {
  sessionId: string
  summary?: string
  usageNotes?: string
  tags: string[]
  /** 是否存在非空标签 */
  hasTags: boolean
  updatedAt: string
  /** 当 summary 和 usageNotes 同时为空/缺失时为 true；与 tags 无关 */
  isEmpty: boolean
}

/**
 * 读取会话笔记请求
 */
export interface ReadSessionNotesRequest {
  sessionId: string
}

/**
 * 写入会话笔记请求
 */
export interface WriteSessionNotesRequest {
  sessionId: string
  /** undefined=不变, ""=清空, string=写入 */
  summary?: string
  /** undefined=不变, ""=清空, string=写入 */
  usageNotes?: string
  /** 提供则完整替换标签列表 */
  tags?: string[]
  /** 是否允许覆盖已有非空内容，默认 false */
  overwrite?: boolean
  /** 必须设为 true；服务端会强校验，确保 LLM 已在调用前询问用户 */
  userConfirmed: boolean
}

/**
 * 创建会话请求（MCP 专用，脱敏 —— 不接受任何凭据）
 *
 * MCP 客户端只允许创建 host/port/username 等元数据；password / privateKey / passphrase
 * 一律不接受，用户需在 LyShell dialog 中手动补充。
 */
export interface CreateSessionRequest {
  /** 会话名称；留空时服务端根据 host/path 派生 */
  name?: string
  type: 'ssh' | 'telnet' | 'serial' | 'local'
  ssh?: {
    host: string
    port?: number
    username?: string
    shellEnterCommands?: string
    shellEnterWait?: number
  }
  telnet?: {
    host: string
    port?: number
  }
  serial?: {
    path: string
    baudRate?: number
  }
  local?: {
    shell?: string
    cwd?: string
  }
  /** 会话摘要（可选） */
  summary?: string
  /** 使用说明（可选） */
  usageNotes?: string
  /** 标签列表（可选，全量替换） */
  tags?: string[]
  /** 启动命令行（可选，每行一条） */
  startupCommands?: string[]
  /** 终端字符集 */
  encoding?: 'utf-8' | 'gbk' | 'gb2312'
  /** 必须设为 true；服务端强校验，确保 LLM 已在调用前询问用户 */
  userConfirmed: boolean
  /**
   * 是否在创建/复用后自动连接并打开终端。默认 true。
   * 自动连接前提：SSH 需已保存凭据（password/privateKey）；Telnet/Serial/Local 无需凭据。
   * 新建的 SSH 会话无凭据，即便 connect=true 也不会连接，需用户在 LyShell 补凭据后手动连接。
   */
  connect?: boolean
  /**
   * 是否阻塞等待连接就绪后再返回（A7）。默认 false（与 connect 一同发起即返回 status=connecting）。
   * 设为 true 时，仅在 connect=true 且有凭据可连的前提下生效：服务端 await 完整握手，
   * 成功返回 status=connected，失败返回 status=error 并附 message。
   * 对无凭据的 SSH（不连）或 connect=false 无意义——直接返回 disconnected。
   */
  waitForReady?: boolean
}

/**
 * 创建会话响应
 */
export interface CreateSessionResponse {
  sessionId: string
  name: string
  type: string
  notes: SessionNotes
  /** true = 新建了保存项；false = 复用了同目标的已存在会话 */
  created: boolean
  /** 当前连接状态：connecting=已发起连接（握手异步进行中），connected=已连上，disconnected=未连接，error=连接失败 */
  status: 'connecting' | 'connected' | 'disconnected' | 'error'
  /** 未自动连接时的原因（如缺少凭据、connect=false、waitForReady 连接失败） */
  message?: string
}

/**
 * 关闭会话请求（A8，scope-limited）
 *
 * 仅断开/移除 live 会话连接，不从仓库删除保存项。
 * session token 只能关闭自身 origin 的会话（见 authorizeMcpOperation 的 sessionControl 收窄）。
 */
export interface CloseSessionRequest {
  sessionId: string
}

export interface CloseSessionResponse {
  sessionId: string
  /** 关闭后的状态：disconnected=已断开（保存项仍在），not_connected=原本就没有 live 连接 */
  status: 'disconnected' | 'not_connected'
}

/**
 * 打开连接对话框请求（C4）
 *
 * 触发渲染层打开"新建连接"对话框，供用户手动补凭据/细节——MCP 通道不接受凭据，
 * 当 agent 需要凭据（如新建 SSH）时用它把球交还给用户。无凭据经 MCP 流转。
 */
export interface OpenConnectionDialogRequest {
  /** 必须设为 true；服务端强校验，确保 LLM 已在调用前询问/告知用户 */
  userConfirmed: boolean
}

export interface OpenConnectionDialogResponse {
  /** true=已向渲染层派发打开指令（用户是否真的填了对话框不在此可知） */
  opened: boolean
  /** 给 agent 的下一步提示 */
  message: string
}
