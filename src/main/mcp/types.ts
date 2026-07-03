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
 */
export interface SessionInfo {
  id: string
  name: string
  type: 'ssh' | 'telnet' | 'serial' | 'local'
  status: string
  host?: string
  port?: number
  group?: string
  tags: string[]
  capabilities: SessionCapabilities
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
 * 文件操作请求（sessionId + path）
 */
export interface FileOperationRequest {
  sessionId: string
  path: string
}

/**
 * 发送输入请求（向交互式终端写入数据）
 */
export interface SendInputRequest {
  sessionId: string
  text: string
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
}

/**
 * 创建会话响应
 */
export interface CreateSessionResponse {
  sessionId: string
  name: string
  type: string
  notes: SessionNotes
}
