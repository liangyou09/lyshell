/**
 * MCP HTTP API 服务端
 * 运行于 LyShell 主进程中，提供 HTTP API 供 MCP Server 进程调用
 * 监听 127.0.0.1:0（随机端口），通过端口文件通知 MCP Server
 */

import * as http from 'http'
import * as net from 'net'
import * as fs from 'fs'
import * as path from 'path'
import { exec, execSync } from 'child_process'
import { app, dialog } from 'electron'
import log from 'electron-log'
import { v4 as uuidv4 } from 'uuid'

import { sessionManager, processInputEscapeSequences } from '../terminal/session-manager'
import { fileManager } from '../file/manager'
import { preferencesRepository } from '../storage/repository'
import { ConnectionType, ConnectionStatus } from '@shared/types'
import * as mcpAuth from './auth'
import type { TokenBinding, TokenKind } from './auth'
import type {
  ApiResponse,
  SessionInfo,
  ExecuteRequest,
  ExecuteResponse,
  ReadFileRequest,
  ReadFileResponse,
  DownloadFileRequest,
  DownloadFileResponse,
  UploadFileRequest,
  FileOperationRequest,
  RenameFileRequest,
  FileMd5Request,
  McpPortInfo,
  SendInputRequest,
  ReadOutputRequest,
  ReadOutputResponse,
  SendAndWaitRequest,
  SendAndWaitResult
} from './types'

let server: http.Server | null = null
let httpPort: number | null = null
const PORT_FILE_NAME = 'mcp-server.json'
const MAX_COMMAND_TIMEOUT_MS = 120000
const MAX_READ_FILE_BYTES = 1048576
const MAX_TEXT_LENGTH = 1024 * 1024

type McpCapability = 'read' | 'interactiveWrite' | 'execute' | 'localExecute' | 'fileWrite' | 'fileDelete'

interface McpSecuritySettings {
  enabled?: boolean
  allowRead?: boolean
  allowInteractiveInput?: boolean
  allowSshExecute?: boolean
  allowLocalExecute?: boolean
  allowFileWrite?: boolean
  allowFileDelete?: boolean
  requireConfirmation?: boolean
  allowedSessionIds?: string[]
  deniedSessionIds?: string[]
  allowExternalMcpClients?: boolean
}

interface McpAuditEvent {
  operation: string
  capability: McpCapability | 'auth'
  sessionId?: string
  sessionName?: string
  sessionType?: string
  allowed: boolean
  reason?: string
  summary?: string
  durationMs?: number
  /** token 来源：global = 端口文件外部接入；session = LyShell 内部 PTY env 注入 */
  tokenSource?: TokenKind
  /** 当 tokenSource === 'session' 时，签发该 token 的 PTY 会话 ID */
  originSessionId?: string
}

const DEFAULT_MCP_SECURITY: Required<McpSecuritySettings> = {
  enabled: true,
  allowRead: true,
  allowInteractiveInput: false,
  allowSshExecute: false,
  allowLocalExecute: false,
  allowFileWrite: false,
  allowFileDelete: false,
  requireConfirmation: true,
  allowedSessionIds: [],
  deniedSessionIds: [],
  // 默认关闭外部接入：只对 LyShell 自身孵化的本地 PTY（per-session token）开放
  allowExternalMcpClients: false
}

/**
 * 返回 MCP HTTP 服务端监听的端口（未启动时为 null）。
 * session-manager 创建本地 PTY 时需要把端口经环境变量注入。
 */
export function getMcpHttpPort(): number | null {
  return httpPort
}

/**
 * 启动 MCP HTTP 服务端
 */
export async function startMcpHttpServer(): Promise<void> {
  // 全局 token 仅在用户开启外部 MCP 接入时才生成；否则 resolveToken 永不命中 'global' 分支。
  // 即使全局 token 已生成，端口文件落盘后再切换 allowExternalMcpClients=false 仍能即时拒绝
  // 外部接入 —— authorizeMcpOperation 在每次请求中实时复查该开关。
  const settings = getMcpSecuritySettings()
  const externalAccess = settings.allowExternalMcpClients === true
  if (externalAccess) {
    mcpAuth.rotateGlobalToken()
  }

  server = http.createServer(handleRequest)

  await new Promise<void>((resolve, reject) => {
    server!.listen(0, '127.0.0.1', () => resolve())
    server!.on('error', reject)
  })

  const address = server!.address() as net.AddressInfo
  httpPort = address.port

  // 写入端口文件（供 MCP Server 进程回连发现端口/token）
  // token 在外部访问关闭时为 null，外部进程读到也无法接入
  const portFilePath = getPortFilePath()
  const portInfo: McpPortInfo = {
    port: httpPort,
    token: externalAccess ? mcpAuth.getGlobalToken() : null,
    pid: process.pid,
    version: 2,
    externalAccess
  }
  const tempPortFilePath = `${portFilePath}.${process.pid}.tmp`
  fs.writeFileSync(tempPortFilePath, JSON.stringify(portInfo, null, 2), { encoding: 'utf-8', mode: 0o600 })
  if (process.platform !== 'win32') {
    fs.chmodSync(tempPortFilePath, 0o600)
  }
  fs.renameSync(tempPortFilePath, portFilePath)

  // 不再自动改写用户外部配置（~/.claude/mcp.json）。
  // 输出 claude mcp add 命令，由用户自行添加。
  logMcpAddCommand(externalAccess)

  log.info(`[MCP] HTTP server started on port ${httpPort} (externalAccess=${externalAccess})`)
}

/**
 * 停止 MCP HTTP 服务端
 */
export async function stopMcpHttpServer(): Promise<void> {
   // 关闭 HTTP 服务端
  if (server) {
    await new Promise<void>(resolve => {
      server!.close(() => resolve())
    })
    server = null
    httpPort = null
  }

  // 清空所有 token（全局 + per-session），防止泄漏的 token 在重启后还能使用
  mcpAuth.clearAllTokens()

  // 清理端口文件
  const portFilePath = getPortFilePath()
  try {
    fs.unlinkSync(portFilePath)
  } catch {
    // 忽略删除失败
  }

  // 不再自动清理用户外部配置；如需移除，用户自行执行 claude mcp remove lyshell

  log.info('[MCP] HTTP server stopped')
}

/**
 * 获取端口文件路径
 */
function getPortFilePath(): string {
  return path.join(app.getPath('userData'), PORT_FILE_NAME)
}

/**
 * 获取 MCP Server 脚本的绝对路径
 */
function getMcpServerScriptPath(): string {
  if (app.isPackaged) {
     // 生产环境：asar 包内含 dist/main/mcpServer.js
    return path.join(process.resourcesPath, 'app', 'dist', 'main', 'mcpServer.js')
  }
   // 开发环境：__dirname 是 dist/main/，mcpServer.js 也在 dist/main/ 中
  return path.join(__dirname, 'mcpServer.js')
}


/**
 * 解析 Node.js 可执行文件路径
 * Electron 的 process.execPath 指向 Electron 二进制，不能直接启动 MCP Server 子进程
 * 需要系统安装的 Node.js
 */
function resolveNodePath(): string {
  // 优先查找系统 Node.js（Electron 的 process.execPath 指向 Electron 二进制，
  // 不能用来启动 MCP Server 子进程）
  try {
    const result = execSync('where node', { encoding: 'utf-8', timeout: 5000 }).trim()
    const candidates = result.split(/\r?\n/).map(p => p.trim()).filter(Boolean)
    if (candidates.length > 0) return candidates[0]
  } catch {
    // where 命令失败，尝试常见路径
  }

  // Windows 常见路径
  if (process.platform === 'win32') {
    const commonPaths = [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs', 'node.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'node.exe'),
    ]
    for (const p of commonPaths) {
      if (fs.existsSync(p)) return p
    }
  }

  // macOS / Linux
  const unixPaths = ['/usr/local/bin/node', '/usr/bin/node', '/opt/homebrew/bin/node']
  for (const p of unixPaths) {
    if (fs.existsSync(p)) return p
  }

  // 找不到系统 Node.js：Electron 的 process.execPath 指向 Electron 二进制，
  // 无法用来启动 MCP Server 子进程。直接报错并提示安装 Node.js，
  // 而非静默写入一个无法工作的配置。
  throw new Error(
    '[MCP] System Node.js not found. The MCP Server requires a standalone Node.js ' +
    'installation to run (Electron\'s bundled binary cannot spawn it). ' +
    'Please install Node.js from https://nodejs.org/ and restart LyShell.'
  )
}
/**
 * 输出 claude mcp add 命令，供用户自行注册 LyShell MCP Server
 * 不再自动改写用户外部配置文件（~/.claude/mcp.json），避免崩溃残留与未授权改写。
 *
 * @param externalAccess 当前是否允许外部 MCP 客户端通过端口文件接入
 */
function logMcpAddCommand(externalAccess: boolean): void {
  let nodePath: string
  try {
    nodePath = resolveNodePath()
  } catch (err) {
    log.error(`[MCP] Cannot generate 'claude mcp add' command: ${(err as Error).message}`)
    return
  }

  const scriptPath = getMcpServerScriptPath()
  const userDataDir = app.getPath('userData')

  // 构造 claude mcp add 命令（带 LYSHELL_USER_DATA 环境变量，路径加双引号）
  const cmd =
    `claude mcp add lyshell -e LYSHELL_USER_DATA="${userDataDir}" -- "${nodePath}" "${scriptPath}"`

  log.info('[MCP] To register LyShell with Claude Code, run the following command:')
  log.info(`[MCP]   ${cmd}`)
  log.info('[MCP] To remove later: claude mcp remove lyshell')
  if (!externalAccess) {
    log.info('[MCP] External access is OFF (default). Run claude inside a LyShell-spawned local terminal,')
    log.info('[MCP]   or enable security.mcp.allowExternalMcpClients in preferences to allow external connections.')
  }
}

// ========== HTTP 请求处理 ==========

/**
 * 请求处理器
 */
function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = req.headers.origin
  if (origin) {
    sendJson(res, 403, { success: false, error: 'Browser origins are not allowed for this local MCP API' })
    return
  }

  if (req.method === 'OPTIONS') {
    sendJson(res, 403, { success: false, error: 'CORS preflight is not allowed for this local MCP API' })
    return
  }

  // 鉴权检查（health 端点除外）
  // 解析 token 同时区分两类：
  //   - global  -> 端口文件外部接入，沿用保守 allow* 策略
  //   - session -> LyShell 自身 PTY 注入，已经过孵化关系信任，享受宽松策略
  const url = new URL(req.url || '/', `http://127.0.0.1`)
  let binding: TokenBinding | null = null
  if (url.pathname !== '/api/health') {
    const token = req.headers['x-lyshell-token']
    binding = mcpAuth.resolveToken(token)
    if (!binding) {
      auditMcpOperation({ operation: 'http', capability: 'auth', allowed: false, reason: 'invalid token' })
      sendJson(res, 401, { success: false, error: 'Unauthorized' })
      return
    }
  }

  // 路由分发
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(res, 200, { success: true, data: { status: 'ok' } })
    }

    // 非 health 端点必有 binding（鉴权已通过）
    const ctxBinding = binding!

    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      return handleListSessions(res)
    }

    if (req.method === 'POST') {
      readBody(req).then(body => {
        let data: any
        try {
          data = body ? JSON.parse(body) : {}
        } catch {
          sendJson(res, 400, { success: false, error: 'Invalid JSON in request body' })
          return
        }
        switch (url.pathname) {
          case '/api/execute':
            return handleExecuteCommand(data, res, ctxBinding)
          case '/api/send-input':
            return handleSendInput(data, res, ctxBinding)
          case '/api/read-output':
            return handleReadOutput(data, res, ctxBinding)
          case '/api/send-and-wait':
            return handleSendAndWait(data, res, ctxBinding)
          case '/api/files/list':
            return handleListFiles(data, res, ctxBinding)
          case '/api/files/read':
            return handleReadFile(data, res, ctxBinding)
          case '/api/files/stat':
            return handleStatFile(data, res, ctxBinding)
          case '/api/files/download':
            return handleDownloadFile(data, res, ctxBinding)
          case '/api/files/upload':
            return handleUploadFile(data, res, ctxBinding)
          case '/api/files/delete':
            return handleDeleteFile(data, res, ctxBinding)
          case '/api/files/rename':
            return handleRenameFile(data, res, ctxBinding)
          case '/api/files/mkdir':
            return handleCreateDirectory(data, res, ctxBinding)
          case '/api/files/md5':
            return handleGetFileMd5(data, res, ctxBinding)
          default:
            sendJson(res, 404, { success: false, error: 'Not found' })
            return
        }
      }).catch(err => {
        sendJson(res, 400, { success: false, error: `Invalid request: ${err.message}` })
      })
      return
    }

    sendJson(res, 405, { success: false, error: 'Method not allowed' })
  } catch (err: any) {
    log.error('[MCP] Request handler error:', err)
    sendJson(res, 500, { success: false, error: err.message || 'Internal server error' })
  }
}

// ========== API 端点实现 ==========

/**
 * GET /api/sessions — 列出所有会话
 */
function handleListSessions(res: http.ServerResponse): void {
  try {
    const sessions = sessionManager.getAllSessions()
    const result: SessionInfo[] = sessions.map(s => ({
      id: s.id,
      name: s.config.name,
      type: s.config.type,
      status: s.status,
      host: s.config.ssh?.host || s.config.telnet?.host,
      port: s.config.ssh?.port || s.config.telnet?.port,
      group: s.config.group,
      tags: s.config.tags,
      capabilities: {
        sendInput: true, // 所有连接类型都支持
        executeCommand: s.config.type === ConnectionType.SSH || s.config.type === ConnectionType.LOCAL,
        fileOperations: s.config.type === ConnectionType.SSH,
        readOutput: s.status === ConnectionStatus.CONNECTED // 已连接会话可读取输出
      }
    }))
    sendJson(res, 200, { success: true, data: result })
  } catch (err: any) {
    sendJson(res, 500, { success: false, error: err.message })
  }
}

/**
 * POST /api/execute — 执行命令
 */
async function handleExecuteCommand(data: ExecuteRequest, res: http.ServerResponse, binding: TokenBinding): Promise<void> {
  try {
    const { sessionId, command, timeout = 30000 } = data

    if (typeof command === 'string' && command.length > MAX_TEXT_LENGTH) {
      sendJson(res, 400, { success: false, error: `Command too large (max ${MAX_TEXT_LENGTH} chars)` })
      return
    }

    if (!sessionId || !command) {
      sendJson(res, 400, { success: false, error: 'sessionId and command are required' })
      return
    }

    const session = sessionManager.getSession(sessionId)
    if (!session) {
      sendJson(res, 404, { success: false, error: `Session not found: ${sessionId}` })
      return
    }

    if (session.status !== ConnectionStatus.CONNECTED) {
      sendJson(res, 400, { success: false, error: `Session not connected (status: ${session.status})` })
      return
    }

    const safeTimeout = clampNumber(timeout, 1, MAX_COMMAND_TIMEOUT_MS, 30000)
    const capability: McpCapability = session.config.type === ConnectionType.LOCAL ? 'localExecute' : 'execute'
    const auth = await authorizeMcpOperation('execute_command', capability, sessionId, summarizeText(command), binding)
    if (!auth.allowed) {
      sendJson(res, 403, { success: false, error: auth.reason })
      return
    }

    let result: ExecuteResponse

    if (session.config.type === ConnectionType.SSH) {
      // SSH 会话：使用 fileManager 的 connector（独立 SSH exec 通道）
      const connector = await fileManager.getConnector(sessionId)
      if (!connector.execRaw) {
        sendJson(res, 500, { success: false, error: 'Connector does not support command execution' })
        return
      }
      const output = await connector.execRaw(command, safeTimeout)
      result = { output, exitCode: 0 }
    } else if (session.config.type === ConnectionType.LOCAL) {
      // 本地会话：使用 child_process.exec
      result = await executeLocalCommand(command, session.config.local?.cwd, session.config.local?.env, safeTimeout)
    } else {
      sendJson(res, 400, { success: false, error: `Command execution not supported for session type: ${session.config.type}` })
      return
    }

    sendJson(res, 200, { success: true, data: result })
  } catch (err: any) {
    log.error('[MCP] Execute command error:', err)
    sendJson(res, 500, { success: false, error: err.message })
  }
}

/**
 * POST /api/send-input - 向交互式终端发送输入
 */
async function handleSendInput(data: SendInputRequest, res: http.ServerResponse, binding: TokenBinding): Promise<void> {
  try {
    const { sessionId, text } = data

    if (!sessionId || text === undefined) {
      sendJson(res, 400, { success: false, error: 'sessionId and text are required' })
      return
    }

    const session = sessionManager.getSession(sessionId)
    if (!session) {
      sendJson(res, 404, { success: false, error: `Session not found: ${sessionId}` })
      return
    }

    if (session.status !== ConnectionStatus.CONNECTED) {
      sendJson(res, 400, { success: false, error: `Session not connected (status: ${session.status})` })
      return
    }

    if (text.length > MAX_TEXT_LENGTH) {
      sendJson(res, 400, { success: false, error: 'text is too large' })
      return
    }

    const auth = await authorizeMcpOperation('send_input', 'interactiveWrite', sessionId, `${text.length} chars`, binding)
    if (!auth.allowed) {
      sendJson(res, 403, { success: false, error: auth.reason })
      return
    }

    // 解析转义字符：\n -> 换行, \r -> 回车, \x03 -> Ctrl+C 等
    const processedText = processInputEscapeSequences(text)

    sessionManager.writeToSession(sessionId, processedText)

    log.info(`[MCP] Send input to session ${sessionId}: ${text.length} chars`)
    sendJson(res, 200, { success: true, data: { sent: true } })
  } catch (err: any) {
    log.error('[MCP] Send input error:', err)
    sendJson(res, 500, { success: false, error: err.message })
  }
}

/**
 * POST /api/read-output — 读取交互式终端的最近输出
 */
async function handleReadOutput(data: ReadOutputRequest, res: http.ServerResponse, binding: TokenBinding): Promise<void> {
  try {
    const { sessionId } = data
    if (!sessionId) {
      sendJson(res, 400, { success: false, error: 'sessionId is required' })
      return
    }

    const session = sessionManager.getSession(sessionId)
    if (!session) {
      sendJson(res, 404, { success: false, error: `Session not found: ${sessionId}` })
      return
    }

    const auth = await authorizeMcpOperation('read_output', 'read', sessionId, undefined, binding)
    if (!auth.allowed) {
      sendJson(res, 403, { success: false, error: auth.reason })
      return
    }

    const result = sessionManager.readOutput(sessionId, {
      lines: clampNumber(data.lines, 1, 1000, 100),
      raw: data.raw === true
    })

    if (!result) {
      sendJson(res, 400, { success: false, error: 'Output buffer not available (session may be disconnected)' })
      return
    }

    const response: ReadOutputResponse = {
      output: result.output,
      lines: result.lines,
      totalBufferSize: result.totalBufferSize
    }
    sendJson(res, 200, { success: true, data: response })
  } catch (err: any) {
    log.error('[MCP] Read output error:', err)
    sendJson(res, 500, { success: false, error: err.message })
  }
}

/**
 * POST /api/send-and-wait — 发送输入并等待响应
 */
async function handleSendAndWait(data: SendAndWaitRequest, res: http.ServerResponse, binding: TokenBinding): Promise<void> {
  try {
    const { sessionId, text } = data
    if (!sessionId || text === undefined) {
      sendJson(res, 400, { success: false, error: 'sessionId and text are required' })
      return
    }

    const session = sessionManager.getSession(sessionId)
    if (!session) {
      sendJson(res, 404, { success: false, error: `Session not found: ${sessionId}` })
      return
    }

    if (session.status !== ConnectionStatus.CONNECTED) {
      sendJson(res, 400, { success: false, error: `Session not connected (status: ${session.status})` })
      return
    }

    if (text.length > MAX_TEXT_LENGTH) {
      sendJson(res, 400, { success: false, error: 'text is too large' })
      return
    }

    const auth = await authorizeMcpOperation('send_and_wait', 'interactiveWrite', sessionId, `${text.length} chars`, binding)
    if (!auth.allowed) {
      sendJson(res, 403, { success: false, error: auth.reason })
      return
    }

    const result: SendAndWaitResult = await sessionManager.sendAndWait(sessionId, {
      text,
      waitMs: clampNumber(data.waitMs, 0, MAX_COMMAND_TIMEOUT_MS, 2000),
      idleMs: clampNumber(data.idleMs, 50, 10000, 300),
      maxWaitMs: clampNumber(data.maxWaitMs, 100, MAX_COMMAND_TIMEOUT_MS, 10000),
      waitForPattern: data.waitForPattern ? summarizeText(data.waitForPattern, 500) : undefined
    })

    log.info(`[MCP] Send-and-wait to session ${sessionId}: settled=${result.settled} elapsed=${result.elapsedMs}ms`)
    sendJson(res, 200, { success: true, data: result })
  } catch (err: any) {
    log.error('[MCP] Send-and-wait error:', err)
    sendJson(res, 500, { success: false, error: err.message })
  }
}

/**
 * POST /api/files/list — 列出目录内容
 */
async function handleListFiles(data: FileOperationRequest, res: http.ServerResponse, binding: TokenBinding): Promise<void> {
  try {
    const { sessionId, path: dirPath } = data
    if (!sessionId || !dirPath) {
      sendJson(res, 400, { success: false, error: 'sessionId and path are required' })
      return
    }
    const auth = await authorizeMcpOperation('list_files', 'read', sessionId, dirPath, binding)
    if (!auth.allowed) {
      sendJson(res, 403, { success: false, error: auth.reason })
      return
    }
    const files = await fileManager.listDir(sessionId, dirPath)
    sendJson(res, 200, { success: true, data: files })
  } catch (err: any) {
    sendJson(res, 500, { success: false, error: err.message })
  }
}

/**
 * POST /api/files/read — 读取远程文件内容
 */
async function handleReadFile(data: ReadFileRequest, res: http.ServerResponse, binding: TokenBinding): Promise<void> {
  try {
    const { sessionId, path: filePath, maxSize = 1048576 } = data
    if (!sessionId || !filePath) {
      sendJson(res, 400, { success: false, error: 'sessionId and path are required' })
      return
    }

    const safeMaxSize = clampNumber(maxSize, 1, MAX_READ_FILE_BYTES, MAX_READ_FILE_BYTES)
    const auth = await authorizeMcpOperation('read_file', 'read', sessionId, filePath, binding)
    if (!auth.allowed) {
      sendJson(res, 403, { success: false, error: auth.reason })
      return
    }

    const connector = await fileManager.getConnector(sessionId)

    // 先检查文件信息
    const stat = await connector.stat(filePath)
    if (stat.isDir) {
      sendJson(res, 400, { success: false, error: 'Path is a directory, not a file' })
      return
    }
    if (stat.size > safeMaxSize) {
      sendJson(res, 400, { success: false, error: `File too large (${stat.size} bytes, max ${safeMaxSize} bytes). Use download_file instead.` })
      return
    }

    // 使用 execRaw 执行 cat 读取文件
    if (!connector.execRaw) {
      sendJson(res, 500, { success: false, error: 'Connector does not support command execution' })
      return
    }

    const content = await connector.execRaw(`cat -- ${quotePosixPath(filePath)}`)

    const result: ReadFileResponse = { content, size: stat.size }
    sendJson(res, 200, { success: true, data: result })
  } catch (err: any) {
    sendJson(res, 500, { success: false, error: err.message })
  }
}

/**
 * POST /api/files/stat — 获取文件元信息
 */
async function handleStatFile(data: FileOperationRequest, res: http.ServerResponse, binding: TokenBinding): Promise<void> {
  try {
    const { sessionId, path: filePath } = data
    if (!sessionId || !filePath) {
      sendJson(res, 400, { success: false, error: 'sessionId and path are required' })
      return
    }
    const auth = await authorizeMcpOperation('stat_file', 'read', sessionId, filePath, binding)
    if (!auth.allowed) {
      sendJson(res, 403, { success: false, error: auth.reason })
      return
    }
    const stat = await fileManager.stat(sessionId, filePath)
    sendJson(res, 200, { success: true, data: stat })
  } catch (err: any) {
    sendJson(res, 500, { success: false, error: err.message })
  }
}

/**
 * POST /api/files/download — 下载远程文件
 */
async function handleDownloadFile(data: DownloadFileRequest, res: http.ServerResponse, binding: TokenBinding): Promise<void> {
  try {
    const { sessionId, remotePath, localPath } = data
    if (!sessionId || !remotePath || !localPath) {
      sendJson(res, 400, { success: false, error: 'sessionId, remotePath, and localPath are required' })
      return
    }
    const auth = await authorizeMcpOperation('download_file', 'fileWrite', sessionId, `${remotePath} -> ${localPath}`, binding)
    if (!auth.allowed) {
      sendJson(res, 403, { success: false, error: auth.reason })
      return
    }
    const taskId = uuidv4()
    const result = await fileManager.download(sessionId, remotePath, localPath, taskId)
    const response: DownloadFileResponse = { md5: result.md5 }
    sendJson(res, 200, { success: true, data: response })
  } catch (err: any) {
    sendJson(res, 500, { success: false, error: err.message })
  }
}

/**
 * POST /api/files/upload — 上传本地文件
 */
async function handleUploadFile(data: UploadFileRequest, res: http.ServerResponse, binding: TokenBinding): Promise<void> {
  try {
    const { sessionId, localPath, remotePath } = data
    if (!sessionId || !localPath || !remotePath) {
      sendJson(res, 400, { success: false, error: 'sessionId, localPath, and remotePath are required' })
      return
    }
    const auth = await authorizeMcpOperation('upload_file', 'fileWrite', sessionId, `${localPath} -> ${remotePath}`, binding)
    if (!auth.allowed) {
      sendJson(res, 403, { success: false, error: auth.reason })
      return
    }
    const taskId = uuidv4()
    await fileManager.upload(sessionId, localPath, remotePath, taskId)
    sendJson(res, 200, { success: true, data: {} })
  } catch (err: any) {
    sendJson(res, 500, { success: false, error: err.message })
  }
}

/**
 * POST /api/files/delete — 删除远程文件/目录
 */
async function handleDeleteFile(data: FileOperationRequest, res: http.ServerResponse, binding: TokenBinding): Promise<void> {
  try {
    const { sessionId, path: filePath } = data
    if (!sessionId || !filePath) {
      sendJson(res, 400, { success: false, error: 'sessionId and path are required' })
      return
    }
    const auth = await authorizeMcpOperation('delete_file', 'fileDelete', sessionId, filePath, binding)
    if (!auth.allowed) {
      sendJson(res, 403, { success: false, error: auth.reason })
      return
    }
    await fileManager.delete(sessionId, filePath)
    sendJson(res, 200, { success: true, data: {} })
  } catch (err: any) {
    sendJson(res, 500, { success: false, error: err.message })
  }
}

/**
 * POST /api/files/rename — 重命名/移动远程文件
 */
async function handleRenameFile(data: RenameFileRequest, res: http.ServerResponse, binding: TokenBinding): Promise<void> {
  try {
    const { sessionId, oldPath, newPath } = data
    if (!sessionId || !oldPath || !newPath) {
      sendJson(res, 400, { success: false, error: 'sessionId, oldPath, and newPath are required' })
      return
    }
    const auth = await authorizeMcpOperation('rename_file', 'fileWrite', sessionId, `${oldPath} -> ${newPath}`, binding)
    if (!auth.allowed) {
      sendJson(res, 403, { success: false, error: auth.reason })
      return
    }
    await fileManager.rename(sessionId, oldPath, newPath)
    sendJson(res, 200, { success: true, data: {} })
  } catch (err: any) {
    sendJson(res, 500, { success: false, error: err.message })
  }
}

/**
 * POST /api/files/mkdir — 创建远程目录
 */
async function handleCreateDirectory(data: FileOperationRequest, res: http.ServerResponse, binding: TokenBinding): Promise<void> {
  try {
    const { sessionId, path: dirPath } = data
    if (!sessionId || !dirPath) {
      sendJson(res, 400, { success: false, error: 'sessionId and path are required' })
      return
    }
    const auth = await authorizeMcpOperation('create_directory', 'fileWrite', sessionId, dirPath, binding)
    if (!auth.allowed) {
      sendJson(res, 403, { success: false, error: auth.reason })
      return
    }
    await fileManager.mkdir(sessionId, dirPath)
    sendJson(res, 200, { success: true, data: {} })
  } catch (err: any) {
    sendJson(res, 500, { success: false, error: err.message })
  }
}

/**
 * POST /api/files/md5 — 计算远程文件 MD5
 */
async function handleGetFileMd5(data: FileMd5Request, res: http.ServerResponse, binding: TokenBinding): Promise<void> {
  try {
    const { sessionId, path: filePath } = data
    if (!sessionId || !filePath) {
      sendJson(res, 400, { success: false, error: 'sessionId and path are required' })
      return
    }
    const auth = await authorizeMcpOperation('get_file_md5', 'read', sessionId, filePath, binding)
    if (!auth.allowed) {
      sendJson(res, 403, { success: false, error: auth.reason })
      return
    }
    const md5 = await fileManager.calculateRemoteMD5(sessionId, filePath)
    sendJson(res, 200, { success: true, data: { md5 } })
  } catch (err: any) {
    sendJson(res, 500, { success: false, error: err.message })
  }
}

// ========== 工具函数 ==========

function getMcpSecuritySettings(): Required<McpSecuritySettings> {
  const security = preferencesRepository.get('security') as { mcp?: McpSecuritySettings } | undefined
  const legacy = preferencesRepository.get('mcpSecurity') as McpSecuritySettings | undefined
  return { ...DEFAULT_MCP_SECURITY, ...(security?.mcp || legacy || {}) }
}

function getSessionSummary(sessionId?: string): Pick<McpAuditEvent, 'sessionId' | 'sessionName' | 'sessionType'> {
  if (!sessionId) return {}
  const session = sessionManager.getSession(sessionId)
  return {
    sessionId,
    sessionName: session?.config.name,
    sessionType: session?.config.type
  }
}

function summarizeText(value: unknown, maxLength: number = 200): string {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ')
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

function auditMcpOperation(event: McpAuditEvent): void {
  log.info('[MCP][audit]', {
    ...event,
    timestamp: new Date().toISOString(),
    summary: event.summary ? summarizeText(event.summary) : undefined
  })
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(value)))
}

function quotePosixPath(filePath: string): string {
  return `'${filePath.replace(/'/g, `'\\''`)}'`
}

async function authorizeMcpOperation(
  operation: string,
  capability: McpCapability,
  sessionId: string | undefined,
  summary: string | undefined,
  binding: TokenBinding
): Promise<{ allowed: boolean; reason?: string }> {
  const settings = getMcpSecuritySettings()
  const session = sessionId ? sessionManager.getSession(sessionId) : undefined
  const sessionSummary = getSessionSummary(sessionId)

  const auditBase: Omit<McpAuditEvent, 'allowed'> = {
    operation,
    capability,
    ...sessionSummary,
    summary,
    tokenSource: binding.kind,
    originSessionId: binding.originSessionId
  }

  const deny = (reason: string) => {
    auditMcpOperation({ ...auditBase, allowed: false, reason })
    return { allowed: false, reason }
  }

  // 全局开关 + sessionId 黑/白名单（两类 token 共同受约束）
  if (!settings.enabled) return deny('MCP access is disabled')
  if (sessionId && settings.deniedSessionIds.includes(sessionId)) return deny('Session is denied for MCP')
  if (sessionId && settings.allowedSessionIds.length > 0 && !settings.allowedSessionIds.includes(sessionId)) {
    return deny('Session is not allowed for MCP')
  }

  // session token 来自 LyShell 自身孵化的 PTY（经 LYSHELL_MCP_TOKEN env 注入），
  // 持有该 token 即等同于"由 LyShell 直接信任"。默认放开非删除类操作并跳过弹窗。
  //
  // 跨会话目标限制：session token 可驱动的目标会话受限，避免 PTY-A 内被 prompt-injection
  // 的 Claude 偷窥/操纵 PTY-B 的用户交互 shell（后者可能持有 sudo 缓存、密钥环境变量等）。
  // 允许目标：
  //   ① 该 token 自身的 originSessionId（自驱）
  //   ② 任意非 LOCAL 会话（SSH / Telnet / Serial）—— agent 终端驱动远程节点是核心用例
  // 禁止目标：
  //   - 其它 LOCAL 会话
  //   - 不带 sessionId 的全局操作（理论上当前路由没有此类，未来扩展防御性处理）
  //
  // 删除类操作对 session token 一律拒绝 —— 即使用户开了 allowFileDelete 也不放行。
  // 删文件是不可逆操作，必须走外部通道（global token + allowFileDelete=true + 弹窗）。
  if (binding.kind === 'session') {
    if (capability === 'fileDelete') {
      return deny('fileDelete is not allowed via session token; use an external MCP client with allowFileDelete enabled')
    }
    if (sessionId && session && session.config.type === ConnectionType.LOCAL && sessionId !== binding.originSessionId) {
      return deny('session token cannot drive other LOCAL terminals; only its own PTY or remote (SSH/Telnet/Serial) sessions are allowed')
    }
    auditMcpOperation({ ...auditBase, allowed: true })
    return { allowed: true }
  }

  // global token：来自端口文件，外部进程也可能持有 → 沿用保守的 allow* 策略。
  // 实时复查 allowExternalMcpClients：用户即使在运行中关闭外部接入，已发出的全局 token
  // 也立即失效；从关→开方向需重启（端口文件不会被回填 token）。
  if (settings.allowExternalMcpClients !== true) {
    return deny('External MCP access is disabled')
  }

  // global token：来自端口文件，外部进程也可能持有 → 沿用保守的 allow* 策略
  const capabilityAllowed =
    capability === 'read' ? settings.allowRead :
      capability === 'interactiveWrite' ? settings.allowInteractiveInput :
        capability === 'execute' ? settings.allowSshExecute :
          capability === 'localExecute' ? settings.allowLocalExecute :
            capability === 'fileWrite' ? settings.allowFileWrite :
              capability === 'fileDelete' ? settings.allowFileDelete : false

  if (!capabilityAllowed) return deny(`MCP capability ${capability} is disabled`)

  if (capability === 'localExecute' && session?.config.type === ConnectionType.LOCAL && !settings.allowLocalExecute) {
    return deny('Local command execution is disabled')
  }

  if (settings.requireConfirmation && capability !== 'read') {
    const result = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['拒绝', '允许一次'],
      defaultId: 0,
      cancelId: 0,
      title: 'MCP 高风险操作确认',
      message: `允许 MCP 执行 ${operation}？`,
      detail: [
        session ? `会话: ${session.config.name} (${session.config.type})` : undefined,
        summary ? `内容: ${summarizeText(summary)}` : undefined
      ].filter(Boolean).join('\n')
    })
    if (result.response !== 1) return deny('User denied MCP operation')
  }

  auditMcpOperation({ ...auditBase, allowed: true })
  return { allowed: true }
}

/**
 * 执行本地命令
 */
function executeLocalCommand(
  command: string,
  cwd?: string,
  env?: Record<string, string>,
  timeout: number = 30000
): Promise<ExecuteResponse> {
  return new Promise((resolve) => {
    const execEnv = { ...process.env, ...env } as Record<string, string>
    const execCwd = cwd || process.env.USERPROFILE || process.env.HOME || ''

    // 记录通过 MCP 执行的本地命令
    log.info(`[MCP] Executing local command: ${command} (cwd: ${execCwd})`)

    exec(command, { cwd: execCwd, env: execEnv, timeout, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        output: stdout + (stderr ? '\n' + stderr : ''),
        exitCode: error ? (error as any).code || 1 : 0
      })
    })
  })
}

/**
 * 读取请求 body
 */
function readBody(req: http.IncomingMessage, maxSize: number = 10 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bodySize = 0
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      bodySize += chunk.length
      if (bodySize > maxSize) {
        reject(new Error(`Request body too large (max ${maxSize} bytes)`))
        req.destroy()
        return
      }
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

/**
 * 发送 JSON 响应
 */
function sendJson(res: http.ServerResponse, statusCode: number, data: ApiResponse): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}
