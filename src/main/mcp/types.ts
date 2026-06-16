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
 * 重命名文件请求
 */
export interface RenameFileRequest {
  sessionId: string
  oldPath: string
  newPath: string
}

/**
 * 计算远程文件 MD5 请求
 */
export interface FileMd5Request {
  sessionId: string
  path: string
}

/**
 * MCP 端口信息文件格式
 */
export interface McpPortInfo {
  port: number
  token: string
  pid: number
  version: number
}
