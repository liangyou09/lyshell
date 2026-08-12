/**
 * MCP HTTP API 服务端
 * 运行于 LyShell 主进程中，提供 HTTP API 供 MCP Server 进程调用
 * 监听 127.0.0.1:0（随机端口），通过端口文件通知 MCP Server
 */

import * as http from 'http'
import * as net from 'net'
import * as fs from 'fs'
import * as path from 'path'
import { exec, execSync, spawn } from 'child_process'
import { app, dialog } from 'electron'
import log from 'electron-log'
import { v4 as uuidv4 } from 'uuid'

import { sessionManager, type Session } from '../terminal/session-manager'
import { broadcastSessionsChanged, broadcastMcpOpenConnectionDialog } from '../ipc/handlers'
import { processInputEscapeSequences, appendAutoNewline } from '@shared/escape-sequences'
import { fileManager, runUploadWorkerAndWait, runDownloadWorkerAndWait, assertSafeLocalPath } from '../file'
import { downloadHistory } from '../storage'
import { preferencesRepository, quickCommandsRepository, sessionRepository } from '../storage/repository'
import { agentRepository } from '../storage/agent-repository'
import { mcpAuditRepository } from '../storage/mcp-audit-repository'
import { ConnectionType, ConnectionStatus, SessionConfig } from '@shared/types'
import type { FileInfo } from '@shared/types'
import { DEFAULT_THEME_DARK } from '@shared/constants'
import { type McpCapability } from '@shared/api-routes'
import * as mcpAuth from './auth'
import type { TokenBinding, TokenKind } from './auth'
import { scanDestructiveCommand } from './destructive-check'
import { compileGlob, relPath } from './glob'
import { t } from '../i18n'
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
  UploadFileResponse,
  FileOperationRequest,
  McpPortInfo,
  SendInputRequest,
  ReadOutputRequest,
  ReadOutputResponse,
  SendAndWaitRequest,
  SendAndWaitResult,
  ReconnectSessionRequest,
  ReconnectSessionResponse,
  CloseSessionRequest,
  CloseSessionResponse,
  OpenConnectionDialogRequest,
  OpenConnectionDialogResponse,
  SessionNotes,
  WriteSessionNotesRequest,
  CreateSessionRequest,
  CreateSessionResponse
} from './types'

let server: http.Server | null = null
let httpPort: number | null = null
const PORT_FILE_NAME = 'mcp-server.json'
const MAX_COMMAND_TIMEOUT_MS = 120000
const MAX_READ_FILE_BYTES = 1048576
const MAX_TEXT_LENGTH = 1024 * 1024

interface McpSecuritySettings {
  enabled?: boolean
  allowRead?: boolean
  allowInteractiveInput?: boolean
  allowSshExecute?: boolean
  allowLocalExecute?: boolean
  allowFileWrite?: boolean
  allowSessionControl?: boolean
  allowSessionMetadataWrite?: boolean
  requireConfirmation?: boolean
  allowedSessionIds?: string[]
  deniedSessionIds?: string[]
  allowExternalMcpClients?: boolean
  confirmDestructiveCommands?: boolean
  confirmFirstNotesWrite?: boolean
}

interface McpAuditEvent {
  operation: string
  capability: McpCapability | 'auth' | 'destructiveConfirm'
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
  allowSessionControl: false,
  allowSessionMetadataWrite: false,
  requireConfirmation: true,
  allowedSessionIds: [],
  deniedSessionIds: [],
  // 默认关闭外部接入：只对 LyShell 自身孵化的本地 PTY（per-session token）开放
  allowExternalMcpClients: false,
  // 默认开启破坏性命令确认：对 session/global token 一视同仁的内容级防御层
  confirmDestructiveCommands: true,
  // 默认开启首次写入会话备注确认（C6）：session token 写元数据的唯一人工闸门
  confirmFirstNotesWrite: true
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

  // Windows 下显式收紧端口文件 ACL 到 owner-only（POSIX 已在写入时 chmod 0o600）
  hardenPortFilePermissionsWindows(portFilePath)

  // 不再自动改写用户外部配置（~/.claude/mcp.json）。
  // 输出 claude mcp add 命令，由用户自行添加。
  logMcpAddCommand(externalAccess)

  log.info(`[MCP] HTTP server started on port ${httpPort} (externalAccess=${externalAccess})`)
}

/**
 * 停止 MCP HTTP 服务端
 */
export async function stopMcpHttpServer(): Promise<void> {
  // 先做同步清理（端口文件 + token），确保即使调用方不 await（如 will-quit 同步钩子），
  // 这些关键清理也在挂起前完成——避免残留 mcp-server.json 误导下次启动、或泄漏 token。
  const portFilePath = getPortFilePath()
  try {
    fs.unlinkSync(portFilePath)
  } catch {
    // 忽略删除失败
  }

  // 清空所有 token（全局 + per-session），防止泄漏的 token 在重启后还能使用
  mcpAuth.clearAllTokens()

  // 关闭 HTTP 服务端（await 可能挂起；进程退出时由 OS 回收监听端口）
  if (server) {
    await new Promise<void>(resolve => {
      server!.close(() => resolve())
    })
    server = null
    httpPort = null
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
 * 获取 MCP Server 脚本的绝对路径。
 * dev 用 __dirname(dist/main);打包用 resources/app.asar/dist/main/(asar 内)。
 *
 * 注:打包后 app 在 resources/app.asar(无 app/ 目录),曾用 'app' 致 ENOENT -- 打包版 MCP server
 * 静默起不来。改 'app.asar' 修复(dist:win + asar 探针实测 ELECTRON_RUN_AS_NODE 可读 asar 内脚本)。
 */
function getMcpServerScriptPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar', 'dist', 'main', 'mcpServer.js')
  }
  return path.join(__dirname, 'mcpServer.js')
}

/**
 * Windows 下显式收紧端口文件 ACL 到 owner-only（B3）。
 *
 * 威胁模型澄清：文件 ACL 无法阻止同用户其它进程读取——同用户进程可 take ownership，
 * 这与 POSIX 的 0o600 同理。同用户威胁由 allowExternalMcpClients=false（默认）兜底。
 * 本函数的价值是 defense-in-depth：不依赖 %APPDATA% 目录的继承 ACL，显式移除继承的
 * ACE，仅保留当前用户；并让 isPortFilePermissionSafe 的读取侧校验不再是 no-op。
 *
 * 失败仅 log.warn，不阻塞启动——此时端口文件仍受目录 ACL 保护，等价于改动前状态。
 */
function hardenPortFilePermissionsWindows(filePath: string): void {
  if (process.platform !== 'win32') return
  try {
    const user = process.env.USERDOMAIN && process.env.USERNAME
      ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
      : process.env.USERNAME
    if (!user) {
      log.warn('[MCP] Cannot harden port file ACL on Windows: USERNAME env not set')
      return
    }
    // /inheritance:r 移除继承的 ACE；/grant:r 仅授予当前用户完全控制（替换而非追加）
    execSync(`icacls "${filePath}" /inheritance:r /grant:r "${user}:F"`, {
      stdio: 'ignore',
      timeout: 5000
    })
    log.info(`[MCP] Hardened port file ACL on Windows for ${user}`)
  } catch (err) {
    log.warn(`[MCP] Failed to harden port file ACL on Windows: ${(err as Error).message}`)
  }
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
  const info = buildMcpAddCommand(externalAccess)
  log.info('[MCP] To register LyShell with Claude Code, run the following command:')
  log.info(`[MCP]   ${info.command}`)
  if (info.systemNodeCommand) {
    log.info('[MCP] Fallback (system Node.js, if the command above fails):')
    log.info(`[MCP]   ${info.systemNodeCommand}`)
  }
  log.info('[MCP] To remove later: claude mcp remove lyshell')
  if (!externalAccess) {
    log.info('[MCP] External access is OFF (default). Run claude inside a LyShell-spawned local terminal,')
    log.info('[MCP]   or enable security.mcp.allowExternalMcpClients in preferences to allow external connections.')
  }
}

export interface McpAddCommand {
  /** 主命令：用 LyShell 自带 Electron 二进制 + ELECTRON_RUN_AS_NODE=1，无需系统 Node */
  command: string
  /** 备选命令：用系统 Node.js（若检测到），主命令失效时回退 */
  systemNodeCommand?: string
  /** 当前是否允许外部 MCP 客户端接入 */
  externalAccess: boolean
}

/**
 * 构造 `claude mcp add lyshell ...` 注册命令（B6）。
 *
 * 主命令用 process.execPath + ELECTRON_RUN_AS_NODE=1：LyShell 自带的 Electron 二进制
 * 在该 env 下作为纯 Node.js 运行，直接跑打包好的 mcpServer.js，无需用户另装系统 Node.js。
 * （历史注释误以为 Electron 二进制不能跑 MCP Server——ELECTRON_RUN_AS_NODE 正是为此。）
 *
 * 备选命令仍用系统 Node.js（若能检测到），供主命令在异常环境（如 env 被剥离）下回退。
 */
export function buildMcpAddCommand(externalAccess: boolean): McpAddCommand {
  const scriptPath = getMcpServerScriptPath()
  const userDataDir = app.getPath('userData')
  const execPath = process.execPath

  const command =
    `claude mcp add lyshell -e LYSHELL_USER_DATA="${userDataDir}" -e ELECTRON_RUN_AS_NODE=1 -- "${execPath}" "${scriptPath}"`

  let systemNodeCommand: string | undefined
  try {
    const nodePath = resolveNodePath()
    systemNodeCommand =
      `claude mcp add lyshell -e LYSHELL_USER_DATA="${userDataDir}" -- "${nodePath}" "${scriptPath}"`
  } catch {
    // 系统未装 Node.js —— 主命令不依赖它，忽略
  }

  return { command, systemNodeCommand, externalAccess }
}

/**
 * IPC 入口：读取当前外部接入开关并构造注册命令，供设置页"复制注册命令"按钮使用。
 */
export function getMcpAddCommandForIpc(): McpAddCommand {
  const externalAccess = getMcpSecuritySettings().allowExternalMcpClients === true
  return buildMcpAddCommand(externalAccess)
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
      const includeAll = url.searchParams.get('includeAll') === 'true'
      handleListSessions(res, ctxBinding, includeAll).catch(err => sendJson(res, 500, { success: false, error: err.message }))
      return
    }

    // P1: 资源端点（read capability，纯只读，无副作用）
    if (req.method === 'GET' && url.pathname === '/api/quick-commands') {
      handleListQuickCommands(res, ctxBinding).catch(err => sendJson(res, 500, { success: false, error: err.message }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/agents') {
      handleListAgents(res, ctxBinding).catch(err => sendJson(res, 500, { success: false, error: err.message }))
      return
    }
    // GET /api/sessions/{id}/output?lines=200
    {
      const m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/output$/)
      if (req.method === 'GET' && m) {
        handleSessionOutputResource(m[1], url, res, ctxBinding).catch(err => sendJson(res, 500, { success: false, error: err.message }))
        return
      }
    }

    // GET /api/sessions/{id}/notes
    {
      const m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/notes$/)
      if (req.method === 'GET' && m) {
        handleReadSessionNotes(m[1], res, ctxBinding).catch(err => sendJson(res, 500, { success: false, error: err.message }))
        return
      }
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
        // POST /api/sessions/{id}/notes
        {
          const m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/notes$/)
          if (m) {
            return handleWriteSessionNotes({ ...data, sessionId: m[1] }, res, ctxBinding)
          }
        }

        switch (url.pathname) {
          case '/api/sessions':
            return handleListSessionsFiltered(data, res, ctxBinding)
          case '/api/sessions/create':
            return handleCreateSession(data, res, ctxBinding)
          case '/api/execute':
            return handleExecuteCommand(data, res, ctxBinding)
          case '/api/execute-stream':
            return handleExecuteCommandStream(data, res, ctxBinding)
          case '/api/send-input':
            return handleSendInput(data, res, ctxBinding)
          case '/api/read-output':
            return handleReadOutput(data, res, ctxBinding)
          case '/api/send-and-wait':
            return handleSendAndWait(data, res, ctxBinding)
          case '/api/sessions/reconnect':
            return handleReconnectSession(data, res, ctxBinding)
          case '/api/sessions/close':
            return handleCloseSession(data, res, ctxBinding)
          case '/api/sessions/open-dialog':
            return handleOpenConnectionDialog(data, res, ctxBinding)
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
          // P1: 高层 workflow 工具
          case '/api/wait-for-prompt':
            return handleWaitForPrompt(data, res, ctxBinding)
          case '/api/run-on-sessions':
            return handleRunOnSessions(data, res, ctxBinding)
          case '/api/tail-until':
            return handleTailUntil(data, res, ctxBinding)
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
/**
 * 把 SessionConfig 转换成侧边栏视角的 SessionInfo。
 *
 * 主源：sessionRepository（所有已保存会话，含未连接的）。
 * live 状态：从 sessionManager.getSession(config.id) 叠加，无则 disconnected。
 * 所有敏感字段（password / privateKey / passphrase）均不输出。
 */
function buildSessionInfo(config: SessionConfig, terminalOpenIds: Set<string>): SessionInfo {
  // saved session 可能正以 runtime 实例打开（前端会清空 config.id 并记 originSavedSessionId）
  const live = sessionManager.getSession(config.id) ?? (config.id ? pickBestRuntimeSession(config.id) : undefined)

  const status = live ? live.status : ConnectionStatus.DISCONNECTED
  const pinned = config.tags?.includes('pinned') ?? false
  // saved id 或 runtime id 任一在终端中打开即视为已打开
  const isInTerminal = terminalOpenIds.has(config.id) || (live ? terminalOpenIds.has(live.id) : false)

  return {
    id: config.id,
    name: config.name,
    type: config.type,
    status,
    host: config.ssh?.host || config.telnet?.host,
    port: config.ssh?.port || config.telnet?.port,
    group: config.group,
    tags: config.tags,
    capabilities: {
      sendInput: true, // 所有连接类型都支持
      executeCommand: config.type === ConnectionType.SSH || config.type === ConnectionType.LOCAL,
      fileOperations: config.type === ConnectionType.SSH,
      readOutput: status === ConnectionStatus.CONNECTED // 已连接会话可读取输出
    },
    // 协议专属字段（脱敏）
    username: config.ssh?.username,
    path: config.serial?.path,
    baudRate: config.serial?.baudRate,
    shell: config.local?.shell,
    cwd: config.local?.cwd,
    // 辅助 agent 选会话
    summary: config.summary || undefined,
    pinned,
    connectCount: config.connectCount,
    updatedAt: config.updatedAt.toISOString(),
    inTerminal: isInTerminal
  }
}

/**
 * 把 saved session ID 解析为当前正在运行的 runtime session ID。
 *
 * 前端打开 saved session 时会清空 config.id 并生成新的 runtime UUID，
 * 因此直接用 saved id 调用工具会找不到 session。此函数通过 originSavedSessionId
 * 反查对应的 runtime 会话；如果 sessionId 本身就是 live id 或没有关联 runtime，则原样返回。
 */
function resolveRuntimeSessionId(sessionId: string): string {
  // 本身是 live session，直接返回
  if (sessionManager.getSession(sessionId)) {
    return sessionId
  }

  // 反查 originSavedSessionId 匹配的 runtime 会话；无则原样返回
  const best = pickBestRuntimeSession(sessionId)
  return best ? best.id : sessionId
}

const STATUS_RANK: Record<string, number> = {
  [ConnectionStatus.CONNECTED]: 5,
  [ConnectionStatus.CONNECTING]: 4,
  [ConnectionStatus.RECONNECTING]: 3,
  [ConnectionStatus.ERROR]: 2,
  [ConnectionStatus.DISCONNECTED]: 1
}

/**
 * 按 saved session ID 反查最优 runtime 会话（通过 originSavedSessionId）。
 * 优先 connected，其次按最近活跃时间倒序。供 buildSessionInfo 与 resolveRuntimeSessionId 复用。
 */
function pickBestRuntimeSession(savedId: string): Session | undefined {
  const candidates = sessionManager.getAllSessions().filter(s => s.config.originSavedSessionId === savedId)
  if (candidates.length === 0) return undefined
  return candidates.sort((a, b) => {
    const rankA = STATUS_RANK[a.status] ?? 0
    const rankB = STATUS_RANK[b.status] ?? 0
    if (rankB !== rankA) return rankB - rankA
    return b.lastActiveAt.getTime() - a.lastActiveAt.getTime()
  })[0]
}

function sortSessionInfos(infos: SessionInfo[]): SessionInfo[] {
  return infos.sort((a, b) => {
    const rankA = STATUS_RANK[a.status] ?? 0
    const rankB = STATUS_RANK[b.status] ?? 0
    if (rankB !== rankA) return rankB - rankA
    if (a.pinned !== b.pinned) return (a.pinned ? 1 : 0) - (b.pinned ? 1 : 0)
    const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0
    const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0
    return tb - ta
  })
}

/**
 * 默认可见性过滤：为避免 agent 上下文被大量离线会话淹没，
 * 未传 includeAll=true 时只保留 connected 或 pinned 的会话。
 */
function applyDefaultVisibilityFilter(infos: SessionInfo[], includeAll?: boolean): SessionInfo[] {
  if (includeAll) return infos
  return infos.filter(i => i.status === ConnectionStatus.CONNECTED || i.pinned)
}

async function handleListSessions(res: http.ServerResponse, binding: TokenBinding, includeAll = false): Promise<void> {
  try {
    const auth = await authorizeMcpOperation('list_sessions', 'read', undefined, undefined, binding)
    if (!auth.allowed) {
      sendJson(res, 403, { success: false, error: auth.reason })
      return
    }

    const saved = sessionRepository.getAll()
    const terminalIds = sessionManager.getAllTerminalOpenSessionIds()
    const result = sortSessionInfos(applyDefaultVisibilityFilter(saved.map(c => buildSessionInfo(c, terminalIds)), includeAll))
    sendJson(res, 200, { success: true, data: result })
  } catch (err: any) {
    log.error('[MCP] List sessions error:', err)
    sendJson(res, 500, { success: false, error: err.message })
  }
}

/**
 * POST /api/sessions — 列出会话（带过滤/分页）
 * 数据源为 sessionRepository 全部已保存会话，叠加 live 状态。
 * 默认仅返回 connected 或 pinned 的会话；传 includeAll=true 可列出全部保存项。
 * 返回 { sessions, total, offset, limit }。
 */
async function handleListSessionsFiltered(
  filter: { status?: string; type?: string; tag?: string; search?: string; pinned?: boolean; includeAll?: boolean; terminalStatus?: boolean; limit?: number; offset?: number } | undefined,
  res: http.ServerResponse,
  binding: TokenBinding
): Promise<void> {
  try {
    const auth = await authorizeMcpOperation('list_sessions', 'read', undefined, undefined, binding)
    if (!auth.allowed) {
      sendJson(res, 403, { success: false, error: auth.reason })
      return
    }

    const f = filter || {}

    let infos: SessionInfo[]
    if (f.terminalStatus === true) {
      // 返回当前在终端页签/分屏中打开的会话（不区分连接状态）
      const terminalIds = sessionManager.getAllTerminalOpenSessionIds()
      infos = []
      for (const id of terminalIds) {
        const live = sessionManager.getSession(id)
        if (live) {
          infos.push(buildSessionInfo(live.config, terminalIds))
        } else {
          const saved = sessionRepository.get(id)
          if (saved) {
            infos.push(buildSessionInfo(saved, terminalIds))
          }
        }
      }
    } else {
      const saved = sessionRepository.getAll()
      const terminalIds = sessionManager.getAllTerminalOpenSessionIds()
      infos = saved.map(c => buildSessionInfo(c, terminalIds))
    }

    if (f.status) infos = infos.filter(i => i.status === f.status)
    if (f.type) infos = infos.filter(i => i.type === f.type)
    if (f.tag) infos = infos.filter(i => i.tags.includes(f.tag!))
    if (typeof f.pinned === 'boolean') {
      infos = infos.filter(i => i.pinned === f.pinned)
    }
    if (f.search) {
      const q = String(f.search).toLowerCase()
      infos = infos.filter(i =>
        i.name.toLowerCase().includes(q) ||
        (i.host || '').toLowerCase().includes(q) ||
        (i.summary || '').toLowerCase().includes(q) ||
        i.tags.some(t => t.toLowerCase().includes(q))
      )
    }

    // terminalStatus=true 时不再应用默认可见性过滤，否则离线打开会话会被隐藏
    infos = sortSessionInfos(f.terminalStatus === true ? infos : applyDefaultVisibilityFilter(infos, f.includeAll))

    const total = infos.length
    const offset = clampNumber(f.offset, 0, total, 0)
    const limit = clampNumber(f.limit, 1, 500, 50)
    const sliced = infos.slice(offset, offset + limit)

    sendJson(res, 200, { success: true, data: { sessions: sliced, total, offset, limit } })
  } catch (err: any) {
    log.error('[MCP] List sessions error:', err)
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

    const resolvedSessionId = resolveRuntimeSessionId(sessionId)
    const targetSession = sessionManager.getSession(resolvedSessionId)
    if (!targetSession) {
      sendJson(res, 404, { success: false, error: `Session not found: ${sessionId}` })
      return
    }

    const safeTimeout = clampNumber(timeout, 1, MAX_COMMAND_TIMEOUT_MS, 30000)
    const capability: McpCapability = targetSession.config.type === ConnectionType.LOCAL ? 'localExecute' : 'execute'
    const auth = await authorizeMcpOperation('execute_command', capability, resolvedSessionId, summarizeText(command), binding)
    if (!auth.allowed) {
      sendJson(res, 403, { success: false, error: auth.reason })
      return
    }

    const destructive = await confirmDestructiveIfNeeded('execute_command', command, resolvedSessionId, binding)
    if (!destructive.allowed) {
      sendJson(res, 403, { success: false, error: destructive.reason })
      return
    }

    // execute_command 走独立 exec 通道，不需要占用 PTY，也不创建 Agent 页签。
    const session = sessionManager.getSession(resolvedSessionId)
    if (!session || session.status !== ConnectionStatus.CONNECTED) {
      sendJson(res, 400, { success: false, error: `Session not connected (status: ${session?.status ?? 'unknown'})` })
      return
    }

    let result: ExecuteResponse

    if (session.config.type === ConnectionType.SSH) {
      // SSH 会话：使用 fileManager 的 connector（独立 SSH exec 通道）
      const connector = await fileManager.getConnector(resolvedSessionId)
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
 * POST /api/execute-stream — 流式执行命令，输出以 SSE 增量推送（A1）。
 *
 * 鉴权与破坏性确认通过后才切换到 text/event-stream：
 *   data: {"type":"chunk","chunk":"..."}            —— 增量输出（stdout+stderr）
 *   data: {"type":"done","exitCode":0,"output":"..."} —— 完成（output 为完整输出）
 *   data: {"type":"error","error":"..."}            —— 出错
 * 客户端断开时通过 AbortSignal 中止底层执行（best-effort）。
 */
async function handleExecuteCommandStream(data: ExecuteRequest, res: http.ServerResponse, binding: TokenBinding): Promise<void> {
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

    const resolvedSessionId = resolveRuntimeSessionId(sessionId)
    const targetSession = sessionManager.getSession(resolvedSessionId)
    if (!targetSession) {
      sendJson(res, 404, { success: false, error: `Session not found: ${sessionId}` })
      return
    }

    const safeTimeout = clampNumber(timeout, 1, MAX_COMMAND_TIMEOUT_MS, 30000)
    const capability: McpCapability = targetSession.config.type === ConnectionType.LOCAL ? 'localExecute' : 'execute'
    const auth = await authorizeMcpOperation('execute_command', capability, resolvedSessionId, summarizeText(command), binding)
    if (!auth.allowed) {
      sendJson(res, 403, { success: false, error: auth.reason })
      return
    }

    const destructive = await confirmDestructiveIfNeeded('execute_command', command, resolvedSessionId, binding)
    if (!destructive.allowed) {
      sendJson(res, 403, { success: false, error: destructive.reason })
      return
    }

    // execute-stream 同样走独立 exec 通道，不创建 Agent 页签。
    const session = sessionManager.getSession(resolvedSessionId)
    if (!session || session.status !== ConnectionStatus.CONNECTED) {
      sendJson(res, 400, { success: false, error: `Session not connected (status: ${session?.status ?? 'unknown'})` })
      return
    }

    // 鉴权通过，切换到 SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })

    const writeEvent = (obj: Record<string, unknown>): void => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`)
    }

    const abortController = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) abortController.abort()
    })

    try {
      let result: { output: string; exitCode: number }
      if (session.config.type === ConnectionType.SSH) {
        const connector = await fileManager.getConnector(resolvedSessionId)
        if (!connector.execStream) {
          writeEvent({ type: 'error', error: 'Connector does not support streaming execution' })
          res.end()
          return
        }
        result = await connector.execStream(
          command,
          safeTimeout,
          (chunk) => writeEvent({ type: 'chunk', chunk }),
          abortController.signal
        )
      } else if (session.config.type === ConnectionType.LOCAL) {
        result = await executeLocalCommandStream(
          command,
          session.config.local?.cwd,
          session.config.local?.env,
          safeTimeout,
          (chunk) => writeEvent({ type: 'chunk', chunk }),
          abortController.signal
        )
      } else {
        writeEvent({ type: 'error', error: `Command execution not supported for session type: ${session.config.type}` })
        res.end()
        return
      }
      writeEvent({ type: 'done', exitCode: result.exitCode, output: result.output })
    } catch (err: any) {
      writeEvent({ type: 'error', error: err.message || 'Execution failed' })
    }
    if (!res.writableEnded) res.end()
  } catch (err: any) {
    log.error('[MCP] Execute stream command error:', err)
    if (!res.headersSent) {
      sendJson(res, 500, { success: false, error: err.message })
    } else if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`)
      res.end()
    }
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

    const resolvedSessionId = resolveRuntimeSessionId(sessionId)
    const targetSession = sessionManager.getSession(resolvedSessionId)
    if (!targetSession) {
      sendJson(res, 404, { success: false, error: `Session not found: ${sessionId}` })
      return
    }

    if (text.length > MAX_TEXT_LENGTH) {
      sendJson(res, 400, { success: false, error: 'text is too large' })
      return
    }

    const auth = await authorizeMcpOperation('send_input', 'interactiveWrite', resolvedSessionId, `${text.length} chars · ${summarizeText(text, 512)}`, binding)
    if (!auth.allowed) {
      sendJson(res, 403, { success: false, error: auth.reason })
      return
    }

    // 内容级破坏性确认：在 escape 处理之前扫描原始 text，破坏性子串此时已存在
    const destructive = await confirmDestructiveIfNeeded('send_input', text, resolvedSessionId, binding)
    if (!destructive.allowed) {
      sendJson(res, 403, { success: false, error: destructive.reason })
      return
    }

    const session = sessionManager.getSession(resolvedSessionId)
    if (!session || session.status !== ConnectionStatus.CONNECTED) {
      sendJson(res, 400, { success: false, error: `Session not connected (status: ${session?.status ?? 'unknown'})` })
      return
    }

    // 解析转义字符（\n -> 换行, \r -> 回车, \x03 -> Ctrl+C 等），并按 autoNewline 决定是否补末尾换行：
    // 末尾是普通可见字符时自动补一个 \n，避免命令只回显不执行；末尾已是 \n/\r 或控制序列时不补。
    // MCP 边界层默认 true（data.autoNewline !== false）。
    const processedText = appendAutoNewline(processInputEscapeSequences(text), data.autoNewline !== false)

    // 临时锁定 PTY，避免用户输入与 MCP 输入冲突
    sessionManager.lockSessionForMcp(resolvedSessionId)
    try {
      sessionManager.writeToSession(resolvedSessionId, processedText)
      log.info(`[MCP] Send input to session ${resolvedSessionId} (origin ${sessionId}): ${text.length} chars`)
      sendJson(res, 200, { success: true, data: { sent: true, bytes: processedText.length } })
    } finally {
      sessionManager.unlockSessionForMcp(resolvedSessionId)
    }
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

    const resolvedSessionId = resolveRuntimeSessionId(sessionId)
    const session = sessionManager.getSession(resolvedSessionId)
    if (!session) {
      sendJson(res, 404, { success: false, error: `Session not found: ${sessionId}` })
      return
    }

    const auth = await authorizeMcpOperation('read_output', 'read', resolvedSessionId, undefined, binding)
    if (!auth.allowed) {
      sendJson(res, 403, { success: false, error: auth.reason })
      return
    }

    const result = sessionManager.readOutput(resolvedSessionId, {
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

    const resolvedSessionId = resolveRuntimeSessionId(sessionId)
    const targetSession = sessionManager.getSession(resolvedSessionId)
    if (!targetSession) {
      sendJson(res, 404, { success: false, error: `Session not found: ${sessionId}` })
      return
    }

    if (text.length > MAX_TEXT_LENGTH) {
      sendJson(res, 400, { success: false, error: 'text is too large' })
      return
    }

    const auth = await authorizeMcpOperation('send_and_wait', 'interactiveWrite', resolvedSessionId, `${text.length} chars · ${summarizeText(text, 512)}`, binding)
    if (!auth.allowed) {
      sendJson(res, 403, { success: false, error: auth.reason })
      return
    }

    const destructive = await confirmDestructiveIfNeeded('send_and_wait', text, resolvedSessionId, binding)
    if (!destructive.allowed) {
      sendJson(res, 403, { success: false, error: destructive.reason })
      return
    }

    const session = sessionManager.getSession(resolvedSessionId)
    if (!session || session.status !== ConnectionStatus.CONNECTED) {
      sendJson(res, 400, { success: false, error: `Session not connected (status: ${session?.status ?? 'unknown'})` })
      return
    }

    // 在 sendAndWait 期间锁定 PTY，避免用户输入与 MCP 输入冲突
    sessionManager.lockSessionForMcp(resolvedSessionId)
    try {
      const result: SendAndWaitResult = await sessionManager.sendAndWait(resolvedSessionId, {
        text,
        waitMs: clampNumber(data.waitMs, 0, MAX_COMMAND_TIMEOUT_MS, 2000),
        idleMs: clampNumber(data.idleMs, 50, 10000, 300),
        maxWaitMs: clampNumber(data.maxWaitMs, 100, MAX_COMMAND_TIMEOUT_MS, 10000),
        // 注意：waitForPattern 是正则，不能过 summarizeText——后者会截断追加 '...'（被 RegExp 当成三个 .）
        // 并把 CR/LF/Tab 换成空格，悄悄改变正则语义。原样透传。
        waitForPattern: data.waitForPattern,
        autoNewline: data.autoNewline !== false,
        captureExitCode: data.captureExitCode === true
      })

      log.info(`[MCP] Send-and-wait to session ${resolvedSessionId} (origin ${sessionId}): settled=${result.settled} elapsed=${result.elapsedMs}ms`)
      sendJson(res, 200, { success: true, data: result })
    } finally {
      sessionManager.unlockSessionForMcp(resolvedSessionId)
    }
  } catch (err: any) {
    log.error('[MCP] Send-and-wait error:', err)
    sendJson(res, 500, { success: false, error: err.message })
  }
}

/**
 * POST /api/sessions/reconnect — 重连指定会话
 *
 * session token：自驱（target == originSessionId）总是允许；
 *               跨会话目标受 authorizeMcpOperation 的 LOCAL 限制；
 *               session token 触发 reconnect 不弹窗（已经过孵化关系信任）。
 * global token：需用户在偏好中开启 allowSessionControl。
 */
async function handleReconnectSession(
  data: ReconnectSessionRequest,
  res: http.ServerResponse,
  binding: TokenBinding
): Promise<void> {
  try {
    const { sessionId } = data
    if (!sessionId) {
      sendJson(res, 400, { success: false, error: 'sessionId is required' })
      return
    }

    const resolvedSessionId = resolveRuntimeSessionId(sessionId)
    const session = sessionManager.getSession(resolvedSessionId)
    if (!session) {
      sendJson(res, 404, { success: false, error: `Session not found: ${sessionId}` })
      return
    }

    const auth = await authorizeMcpOperation('reconnect_session', 'sessionControl', resolvedSessionId, undefined, binding)
    if (!auth.allowed) {
      sendJson(res, 403, { success: false, error: auth.reason })
      return
    }

    const result = await sessionManager.reconnectSession(resolvedSessionId)
    const response: ReconnectSessionResponse = {
      sessionId: result.id,
      status: result.status
    }
    log.info(`[MCP] Reconnected session ${resolvedSessionId}: status=${result.status}`)
    sendJson(res, 200, { success: true, data: response })
  } catch (err: any) {
    log.error('[MCP] Reconnect session error:', err)
    sendJson(res, 500, { success: false, error: err.message })
  }
}

/**
 * POST /api/sessions/close — 关闭会话的 live 连接（A8，scope-limited）
 *
 * 仅断开 live 连接，不从仓库删除保存项；后续可 reconnect 恢复。
 * 鉴权走 sessionControl：session token 受既有 scope 约束（自身 origin 或远端，
 * 不得操纵其它 LOCAL 终端；C5 进一步禁止 resurrect 其它已断开会话——但 close 目标
 * 通常是已连接会话，C5 不拦截）。global token 走 requireConfirmation 弹窗。
 */
async function handleCloseSession(
  data: CloseSessionRequest,
  res: http.ServerResponse,
  binding: TokenBinding
): Promise<void> {
  try {
    const { sessionId } = data
    if (!sessionId) {
      sendJson(res, 400, { success: false, error: 'sessionId is required' })
      return
    }

    const resolvedSessionId = resolveRuntimeSessionId(sessionId)
    const session = sessionManager.getSession(resolvedSessionId)
    if (!session) {
      // 无 live 对象（仅保存项）——视为本就未连接
      const response: CloseSessionResponse = { sessionId, status: 'not_connected' }
      sendJson(res, 200, { success: true, data: response })
      return
    }

    const auth = await authorizeMcpOperation('close_session', 'sessionControl', resolvedSessionId, undefined, binding)
    if (!auth.allowed) {
      sendJson(res, 403, { success: false, error: auth.reason })
      return
    }

    if (session.status !== ConnectionStatus.CONNECTED && session.status !== ConnectionStatus.CONNECTING) {
      const response: CloseSessionResponse = { sessionId, status: 'not_connected' }
      sendJson(res, 200, { success: true, data: response })
      return
    }

    await sessionManager.disconnectSession(resolvedSessionId)
    broadcastSessionsChanged()
    const response: CloseSessionResponse = { sessionId, status: 'disconnected' }
    log.info(`[MCP] Closed session ${resolvedSessionId}`)
    sendJson(res, 200, { success: true, data: response })
  } catch (err: any) {
    log.error('[MCP] Close session error:', err)
    sendJson(res, 500, { success: false, error: err.message })
  }
}

/**
 * POST /api/sessions/open-dialog — 触发渲染层打开"新建连接"对话框（C4）
 *
 * MCP 通道不接受凭据；agent 需要凭据（如新建 SSH）时把球交还给用户。
 * 鉴权用 sessionControl（与 create_session 对齐，控制类操作）。仅向渲染层派发打开指令，
 * 用户是否真的填写不可知——返回 opened=true 与下一步提示。
 */
async function handleOpenConnectionDialog(
  data: OpenConnectionDialogRequest,
  res: http.ServerResponse,
  binding: TokenBinding
): Promise<void> {
  try {
    if (data?.userConfirmed !== true) {
      sendJson(res, 400, {
        success: false,
        error: 'userConfirmed must be true. Tell the user the connection dialog is about to open before calling.'
      })
      return
    }

    const auth = await authorizeMcpOperation('open_connection_dialog', 'sessionControl', undefined, undefined, binding)
    if (!auth.allowed) {
      sendJson(res, 403, { success: false, error: auth.reason })
      return
    }

    broadcastMcpOpenConnectionDialog()
    const response: OpenConnectionDialogResponse = {
      opened: true,
      message: 'Connection dialog opened in LyShell. After the user fills details and connects, call lyshell_list_sessions to find the new session.'
    }
    log.info(`[MCP] Opened connection dialog (triggered by ${binding.kind} token)`)
    sendJson(res, 200, { success: true, data: response })
  } catch (err: any) {
    log.error('[MCP] Open connection dialog error:', err)
    sendJson(res, 500, { success: false, error: err.message })
  }
}

/**
 * 把 SessionConfig 转换为 SessionNotes 响应
 */
function toSessionNotes(sessionId: string, config: SessionConfig): SessionNotes {
  const summary = config.summary?.trim() || undefined
  const usageNotes = config.usageNotes?.trim() || undefined
  const tags = (config.tags || []).map(t => t.trim()).filter(t => t !== '')
  return {
    sessionId,
    summary,
    usageNotes,
    tags,
    hasTags: tags.length > 0,
    updatedAt: config.updatedAt.toISOString(),
    isEmpty: !summary && !usageNotes
  }
}

/**
 * 标签规范化与校验（write_session_notes 与 create_session 共用）。
 * trim、去空、去重、长度/数量上限。
 *
 * @returns ok:true 时 tags 为规范化后的数组；输入为 undefined 时 tags 为 null，
 *          由调用方决定语义（write 路径=保持不变，create 路径=空数组）。
 *          ok:false 时 error 适合直接回给客户端。
 */
function normalizeAndValidateTags(tags: string[] | undefined): { ok: true; tags: string[] | null } | { ok: false; error: string } {
  if (tags === undefined) return { ok: true, tags: null }
  const trimmed = tags.map(t => t.trim()).filter(t => t.length > 0)
  const MAX_TAGS = 20
  const MAX_TAG_LENGTH = 50
  if (trimmed.length > MAX_TAGS) return { ok: false, error: `Too many tags (max ${MAX_TAGS})` }
  const seen = new Set<string>()
  for (const tag of trimmed) {
    if (tag.length > MAX_TAG_LENGTH) return { ok: false, error: `Tag too long (max ${MAX_TAG_LENGTH} chars): ${tag}` }
    if (seen.has(tag)) return { ok: false, error: `Duplicate tag: ${tag}` }
    seen.add(tag)
  }
  return { ok: true, tags: trimmed }
}

/**
 * GET /api/sessions/{id}/notes — 读取会话摘要和使用说明
 * 支持未连接的离线会话：以 sessionRepository 为主源
 */
async function handleReadSessionNotes(
  sessionId: string,
  res: http.ServerResponse,
  binding: TokenBinding
): Promise<void> {
  try {
    if (!sessionId) {
      sendJson(res, 400, { success: false, error: 'sessionId is required' })
      return
    }

    // 先授权（含审计），再查存在性 —— 避免未授权客户端通过 404 vs 403 探测 sessionId 是否存在，
    // 并保证未授权访问进入审计日志。
    const auth = await authorizeMcpOperation('read_session_notes', 'read', sessionId, undefined, binding)
    if (!auth.allowed) {
      sendJson(res, 403, { success: false, error: auth.reason })
      return
    }

    const config = sessionRepository.get(sessionId)
    if (!config) {
      sendJson(res, 404, { success: false, error: `Session not found: ${sessionId}` })
      return
    }

    sendJson(res, 200, { success: true, data: toSessionNotes(sessionId, config) })
  } catch (err: any) {
    log.error('[MCP] Read session notes error:', err)
    sendJson(res, 500, { success: false, error: err.message })
  }
}

/**
 * POST /api/sessions/{id}/notes — 写入会话摘要和使用说明
 * 支持未连接的离线会话：以 sessionRepository 为主源，活跃会话额外走 sessionManager 触发事件
 */
async function handleWriteSessionNotes(
  data: WriteSessionNotesRequest,
  res: http.ServerResponse,
  binding: TokenBinding
): Promise<void> {
  try {
    const { sessionId } = data
    if (!sessionId) {
      sendJson(res, 400, { success: false, error: 'sessionId is required' })
      return
    }

    // 强校验：确保 LLM 已在调用前询问用户关键信息
    if (data.userConfirmed !== true) {
      sendJson(res, 400, {
        success: false,
        error: 'userConfirmed must be true. Ask the user for summary, usage notes, tags, and overwrite policy before writing.'
      })
      return
    }

    const summary = data.summary
    const usageNotes = data.usageNotes
    const tags = data.tags
    const overwrite = data.overwrite === true

    // 标签校验与规范化（trim/去空/去重/长度）—— 纯输入校验，先于授权，不泄露 sessionId 存在性
    const tagResult = normalizeAndValidateTags(tags)
    if (!tagResult.ok) {
      sendJson(res, 400, { success: false, error: tagResult.error })
      return
    }
    const normalizedTags = tagResult.tags  // null = 未传 tags = 保持不变

    // 审计摘要覆盖所有变更字段
    const auditParts: string[] = []
    if (summary !== undefined) auditParts.push('summary')
    if (usageNotes !== undefined) auditParts.push('usageNotes')
    if (tags !== undefined) auditParts.push(`tags[${tags.length}]`)
    const auth = await authorizeMcpOperation(
      'write_session_notes',
      'sessionMetadataWrite',
      sessionId,
      summarizeText(auditParts.join(', ') || 'no changes', 200),
      binding
    )
    if (!auth.allowed) {
      sendJson(res, 403, { success: false, error: auth.reason })
      return
    }

    // 授权通过后再查存在性 —— 避免未授权客户端探测 sessionId 是否存在
    const config = sessionRepository.get(sessionId)
    if (!config) {
      sendJson(res, 404, { success: false, error: `Session not found: ${sessionId}` })
      return
    }

    // C6：首次写入会话备注的内容级确认（prompt-injection 防御）。
    // session token 跳过 requireConfirmation，本层是其写入元数据的唯一人工闸门——
    // 阻断被注入的 agent 静默给一个"空白"会话打上误导性 summary/notes/tags
    // （如把 prod 标成 test-env），污染后续 agent 的判断与路由决策。
    // global token 已由 requireConfirmation 弹窗覆盖，不重复弹。
    // 仅当目标会话当前为空（无 summary/usageNotes/tags）且本次将写入非空内容时触发。
    if (binding.kind === 'session' && getMcpSecuritySettings().confirmFirstNotesWrite !== false) {
      const existingTags = (config.tags || []).filter(t => t.trim())
      const currentlyEmpty = !(config.summary || '').trim() && !(config.usageNotes || '').trim() && existingTags.length === 0
      const writingContent =
        (normalizedTags !== null && normalizedTags.length > 0) ||
        (summary !== undefined && summary.trim() !== '') ||
        (usageNotes !== undefined && usageNotes.trim() !== '')
      if (currentlyEmpty && writingContent) {
        const result = await dialog.showMessageBox({
          type: 'warning',
          buttons: [t('mcp.dialog.reject'), t('mcp.dialog.allowOnce')],
          defaultId: 0,
          cancelId: 0,
          title: t('mcp.dialog.firstNotesTitle'),
          message: t('mcp.dialog.firstNotesMessage'),
          detail: [
            `${t('mcp.dialog.session')}: ${config.name} (${config.type})`,
            `${t('mcp.dialog.content')}: ${summarizeText(auditParts.join(', ') || 'no changes', 200)}`
          ].filter(Boolean).join('\n')
        })
        if (result.response !== 1) {
          const c6AuditBase: Omit<McpAuditEvent, 'allowed'> = {
            operation: 'write_session_notes',
            capability: 'sessionMetadataWrite',
            ...getSessionSummary(sessionId),
            summary: summarizeText('first notes write denied', 200),
            tokenSource: binding.kind,
            originSessionId: binding.originSessionId
          }
          auditMcpOperation({ ...c6AuditBase, allowed: false, reason: 'user denied first session-notes write' })
          sendJson(res, 403, { success: false, error: 'User denied first session-notes write' })
          return
        }
      }
    }

    // 冲突检测：未开启 overwrite 且目标字段已有非空值，错误中只给出短预览
    if (!overwrite) {
      if (summary !== undefined && (config.summary || '').trim() !== '') {
        sendJson(res, 409, {
          success: false,
          error: `Summary already exists. Set overwrite=true to replace. Current preview: ${summarizeText(config.summary, 80)}`
        })
        return
      }
      if (usageNotes !== undefined && (config.usageNotes || '').trim() !== '') {
        sendJson(res, 409, {
          success: false,
          error: `Usage notes already exist. Set overwrite=true to replace. Current preview: ${summarizeText(config.usageNotes, 80)}`
        })
        return
      }
    }

    // 应用变更：先持久化，再同步活跃会话，避免 updateSession 刷新 lastActiveAt 影响"最近会话"排序
    const updates: Partial<SessionConfig> = {}
    if (normalizedTags !== null) {
      updates.tags = normalizedTags
    }
    if (summary !== undefined) {
      updates.summary = summary.trim() || undefined
    }
    if (usageNotes !== undefined) {
      updates.usageNotes = usageNotes.trim() || undefined
    }

    const activeSession = sessionManager.getSession(sessionId)
    const currentConfig = activeSession ? activeSession.config : config

    // 无实际变更 —— 不落盘、不刷新 updatedAt（避免空写扰动"最近会话"排序）、不广播，直接回当前 notes
    if (Object.keys(updates).length === 0) {
      const notes = toSessionNotes(sessionId, currentConfig)
      log.info(`[MCP] Write session notes ${sessionId}: no changes (empty update)`)
      sendJson(res, 200, { success: true, data: notes })
      return
    }

    const candidateConfig: SessionConfig = { ...currentConfig, ...updates, updatedAt: new Date() }
    const saved = sessionRepository.saveSession(candidateConfig)

    if (activeSession) {
      // 用 repository 的 updatedAt 回填内存对象，消除两次 Date 写入的毫秒偏差；
      // touchLastActive=false，因为修改备注不属于用户终端活动。
      sessionManager.updateSession(
        sessionId,
        { ...updates, updatedAt: saved.updatedAt },
        { touchLastActive: false, timestamp: saved.updatedAt }
      )
    }

    // 外部路径改动会话列表 —— 通知渲染层增量同步，避免 UI 看不到 MCP 写入的备注
    broadcastSessionsChanged()

    const notes = toSessionNotes(sessionId, saved)
    log.info(`[MCP] Updated session notes ${sessionId}: summary=${!!notes.summary}, usageNotes=${!!notes.usageNotes}, tags=${notes.tags.length}`)
    sendJson(res, 200, { success: true, data: notes })
  } catch (err: any) {
    log.error('[MCP] Write session notes error:', err)
    sendJson(res, 500, { success: false, error: err.message })
  }
}

/**
 * POST /api/sessions/create — 通过 MCP 创建/复用会话并按需打开终端
 *
 * 安全约束：
 *  - 不接受任何凭据字段（password/privateKey/passphrase），凭据由用户在 dialog 中手动补充。
 *  - 强制 userConfirmed=true，防止 LLM 静默创建。
 *  - capability=sessionControl（与 reconnect 对齐；不引入新开关）。
 *
 * 行为：按连接目标（SSH/Telnet=host:port，Serial=path）复用已存在的保存项；找不到才新建。
 * 默认自动连接打开终端——SSH 需该会话已存凭据，新建 SSH 无凭据则不连（留给用户手动补）。
 * Telnet/Serial/Local 无需凭据，始终自动连。渲染层经 sessions:changed 增量同步。
 */
async function handleCreateSession(
  data: CreateSessionRequest,
  res: http.ServerResponse,
  binding: TokenBinding
): Promise<void> {
  try {
    // 强校验：确保 LLM 已在调用前询问用户
    if (data.userConfirmed !== true) {
      sendJson(res, 400, {
        success: false,
        error: 'userConfirmed must be true. Ask the user for connection type, host/port, and notes before creating a session.'
      })
      return
    }

    const type = data.type
    if (type !== 'ssh' && type !== 'telnet' && type !== 'serial' && type !== 'local') {
      sendJson(res, 400, { success: false, error: `Invalid session type: ${type}` })
      return
    }

    // 安全契约：create_session 永不接受凭据。显式 400 拒绝（而非静默丢弃），
    // 让 agent 清楚凭据未生效——需走 lyshell_open_connection_dialog 或 LyShell UI 由用户手动补充。
    // 检查根级与 ssh 子对象两处，避免 agent 把凭据放错位置后被静默忽略。
    const rootInput = data as unknown as Record<string, unknown>
    const sshInput = data.ssh as unknown as Record<string, unknown> | undefined
    if (
      rootInput.password !== undefined || rootInput.privateKey !== undefined || rootInput.passphrase !== undefined ||
      (sshInput !== undefined && (sshInput.password !== undefined || sshInput.privateKey !== undefined || sshInput.passphrase !== undefined))
    ) {
      sendJson(res, 400, {
        success: false,
        error: 'Credentials (password/privateKey/passphrase) are not accepted by create_session. Use lyshell_open_connection_dialog so the user can fill them in the LyShell UI.'
      })
      return
    }

    // 派生 name
    let name = (data.name || '').trim()
    if (!name) {
      if (type === 'ssh') name = (data.ssh?.host || '').trim()
      else if (type === 'telnet') name = (data.telnet?.host || '').trim()
      else if (type === 'serial') name = (data.serial?.path || '').trim()
      else if (type === 'local') name = 'Local Terminal'
    }
    if (!name) {
      sendJson(res, 400, { success: false, error: 'name is required (or provide host/path so it can be derived)' })
      return
    }
    if (name.length > 200) {
      sendJson(res, 400, { success: false, error: 'name too long (max 200 chars)' })
      return
    }

    // 协议字段校验
    if (type === 'ssh' && !data.ssh?.host?.trim()) {
      sendJson(res, 400, { success: false, error: 'ssh.host is required' })
      return
    }
    if (type === 'telnet' && !data.telnet?.host?.trim()) {
      sendJson(res, 400, { success: false, error: 'telnet.host is required' })
      return
    }
    if (type === 'serial' && !data.serial?.path?.trim()) {
      sendJson(res, 400, { success: false, error: 'serial.path is required' })
      return
    }

    // 授权（capability = sessionControl，与 reconnect 对齐）
    const auditParts: string[] = [type, name]
    if (data.ssh?.host) auditParts.push(`${data.ssh.host}:${data.ssh.port ?? 22}`)
    if (data.telnet?.host) auditParts.push(`${data.telnet.host}:${data.telnet.port ?? 23}`)
    if (data.serial?.path) auditParts.push(data.serial.path)
    const auth = await authorizeMcpOperation(
      'create_session',
      'sessionControl',
      undefined,
      summarizeText(auditParts.join(' | '), 200),
      binding
    )
    if (!auth.allowed) {
      sendJson(res, 403, { success: false, error: auth.reason })
      return
    }

    // 标签校验与规范化（trim/去空/去重/长度）
    const tagResult = normalizeAndValidateTags(data.tags)
    if (!tagResult.ok) {
      sendJson(res, 400, { success: false, error: tagResult.error })
      return
    }
    const normalizedTags = tagResult.tags ?? []

    // 装配 SessionConfig
    const now = new Date()
    const config: SessionConfig = {
      id: '',  // 交给 repository 生成 uuid
      name,
      type: type as ConnectionType,
      tags: normalizedTags,
      summary: data.summary?.trim() || undefined,
      usageNotes: data.usageNotes?.trim() || undefined,
      startupCommands: (data.startupCommands || []).map(s => s || '').filter(Boolean),
      terminal: {
        fontSize: 14,
        fontFamily: 'Consolas, Monaco, monospace',
        theme: DEFAULT_THEME_DARK,
        cursorStyle: 'block',
        cursorBlink: true,
        scrollback: 10000,
        encoding: data.encoding || 'utf-8'
      },
      createdAt: now,
      updatedAt: now
    }

    if (type === 'ssh' && data.ssh) {
      config.ssh = {
        host: data.ssh.host.trim(),
        port: data.ssh.port || 22,
        username: (data.ssh.username || '').trim(),
        // 凭据字段一律不接受；用户在 dialog 内自行补充
        shellEnterCommands: data.ssh.shellEnterCommands || undefined,
        shellEnterWait: data.ssh.shellEnterWait
      }
    } else if (type === 'telnet' && data.telnet) {
      config.telnet = {
        host: data.telnet.host.trim(),
        port: data.telnet.port || 23
      }
    } else if (type === 'serial' && data.serial) {
      config.serial = {
        path: data.serial.path.trim(),
        baudRate: data.serial.baudRate || 9600,
        dataBits: 8,
        stopBits: 1,
        parity: 'none'
      }
    } else if (type === 'local' && data.local) {
      config.local = {
        shell: data.local.shell || undefined,
        cwd: data.local.cwd || undefined
      }
    } else if (type === 'local') {
      config.local = {}
    }

    // 按连接目标查找已存在的保存项——命中则复用，避免对同一台机器重复建项。
    // 复用时使用已有会话自身的配置（含其已存凭据/备注），调用方传入的 notes/username 等被忽略；
    // 若需更新备注请另调 write_session_notes。
    const existing = sessionRepository.findByTarget(config)
    let saved: SessionConfig
    let created: boolean
    if (existing) {
      saved = existing
      created = false
      log.info(`[MCP] create_session reused existing ${saved.id} (${saved.name}) for same target`)
    } else {
      saved = sessionRepository.saveSession(config)
      created = true
      log.info(`[MCP] Created session ${saved.id} (${saved.name}, ${saved.type})`)
    }

    // 新建/复用都可能影响 sidebar 列表 —— 通知渲染层增量同步
    broadcastSessionsChanged()

    // 是否自动连接打开终端：connect 默认 true。
    // SSH 需已存凭据（password/privateKey）；Telnet/Serial/Local 无需凭据，始终可连。
    // 新建的 SSH 会话无凭据（工具不接受凭据），即便 connect=true 也不连，留给用户手动补凭据。
    const wantConnect = data.connect !== false
    const hasCreds = saved.type === ConnectionType.SSH
      ? (!!(saved.ssh?.password) || !!(saved.ssh?.privateKey))
      : true

    let status: 'connecting' | 'connected' | 'disconnected' | 'error' = 'disconnected'
    let message: string | undefined

    if (wantConnect && hasCreds) {
      const live = sessionManager.getSession(saved.id)
      if (live && live.status === ConnectionStatus.CONNECTED) {
        // 已有 live 且已连上——直接复用，不重连
        status = 'connected'
      } else {
        // 没有 live 就注册一个（用 saved 配置，含已存凭据），再连接
        if (!live) {
          await sessionManager.createSession(saved)
        }
        const liveId = saved.id
        if (data.waitForReady === true) {
          // A7：阻塞等待握手完成。成功 connected；失败 error 并回填 message。
          try {
            await sessionManager.connectSession(liveId)
            status = 'connected'
          } catch (err: any) {
            status = 'error'
            message = `Connection failed: ${err?.message || err}`
            log.error(`[MCP] create_session waitForReady connect failed for ${liveId}:`, err?.message || err)
          }
        } else {
          // 异步连接，立即返回 connecting
          sessionManager.connectSession(liveId).catch((err: any) => {
            log.error(`[MCP] create_session auto-connect failed for ${liveId}:`, err?.message || err)
          })
          status = 'connecting'
        }
      }
    } else if (!hasCreds) {
      message = 'Session saved but not connected: no saved credentials. Fill password/key in the LyShell dialog and connect manually.'
      status = 'disconnected'
    } else {
      message = 'Session saved but not connected (connect=false).'
      status = 'disconnected'
    }

    const notes = toSessionNotes(saved.id, saved)
    const response: CreateSessionResponse = {
      sessionId: saved.id,
      name: saved.name,
      type: saved.type,
      notes,
      created,
      status,
      message
    }
    sendJson(res, 200, { success: true, data: response })
  } catch (err: any) {
    log.error('[MCP] Create session error:', err)
    sendJson(res, 500, { success: false, error: err.message })
  }
}

/**
 * POST /api/files/list — 列出目录内容（A5：支持 recursive / glob / maxEntries）
 *
 * 非递归且无 glob 时走原路径单次 listDir；否则广度优先遍历子目录（symlink 不跟随），
 * 对每个条目的相对路径（及文件名）做 glob 匹配，maxEntries 截断防巨目录打爆响应。
 */
async function handleListFiles(data: FileOperationRequest, res: http.ServerResponse, binding: TokenBinding): Promise<void> {
  try {
    const { sessionId, path: dirPath } = data
    if (!sessionId || !dirPath) {
      sendJson(res, 400, { success: false, error: 'sessionId and path are required' })
      return
    }
    const resolvedSessionId = resolveRuntimeSessionId(sessionId)
    const auth = await authorizeMcpOperation('list_files', 'read', resolvedSessionId, dirPath, binding)
    if (!auth.allowed) {
      sendJson(res, 403, { success: false, error: auth.reason })
      return
    }

    const recursive = data.recursive === true
    const glob = typeof data.glob === 'string' && data.glob.trim() ? data.glob.trim() : undefined
    const maxEntries = clampNumber(data.maxEntries, 1, 50000, 5000)

    // 快速路径：单目录、无过滤
    if (!recursive && !glob) {
      const files = await fileManager.listDir(resolvedSessionId, dirPath)
      sendJson(res, 200, { success: true, data: { entries: files, truncated: false } })
      return
    }

    // 递归 / glob 遍历
    const matcher = glob ? compileGlob(glob) : undefined
    const root = dirPath.replace(/\/+$/, '') || '/'
    const out: FileInfo[] = []
    let truncated = false
    const queue: string[] = [root]
    const seen = new Set<string>()
    while (queue.length > 0) {
      const dir = queue.shift()!
      if (seen.has(dir)) continue
      seen.add(dir)
      let entries: FileInfo[]
      try {
        entries = await fileManager.listDir(resolvedSessionId, dir)
      } catch {
        // 无权限/不存在的子目录跳过，继续遍历兄弟节点
        continue
      }
      for (const e of entries) {
        if (out.length >= maxEntries) { truncated = true; break }
        const rel = relPath(root, e.path)
        if (!matcher || matcher(rel) || matcher(e.name)) {
          out.push(e)
        }
        if (recursive && e.isDir) {
          queue.push(e.path)
        }
      }
      if (truncated) break
    }
    // 包成 { entries, truncated } —— MCP structuredContent 必须是对象，裸数组会触发客户端 schema 校验错误。
    sendJson(res, 200, { success: true, data: { entries: out, truncated } })
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

    const resolvedSessionId = resolveRuntimeSessionId(sessionId)
    const safeMaxSize = clampNumber(maxSize, 1, MAX_READ_FILE_BYTES, MAX_READ_FILE_BYTES)
    const auth = await authorizeMcpOperation('read_file', 'read', resolvedSessionId, filePath, binding)
    if (!auth.allowed) {
      sendJson(res, 403, { success: false, error: auth.reason })
      return
    }

    const connector = await fileManager.getConnector(resolvedSessionId)

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
    const resolvedSessionId = resolveRuntimeSessionId(sessionId)
    const auth = await authorizeMcpOperation('stat_file', 'read', resolvedSessionId, filePath, binding)
    if (!auth.allowed) {
      sendJson(res, 403, { success: false, error: auth.reason })
      return
    }
    const stat = await fileManager.stat(resolvedSessionId, filePath)
    sendJson(res, 200, { success: true, data: stat })
  } catch (err: any) {
    sendJson(res, 500, { success: false, error: err.message })
  }
}

/**
 * POST /api/files/download — 下载远程文件
 */
/**
 * POST /api/files/download — 下载远程文件
 *
 * 使用 Worker 路径（与 UI 文件管理一致），避免主进程 shell channel 的
 * 60s/chunk ACK 超时对大文件不友好。传输完成后本地计算 MD5 返回给调用方。
 */
async function handleDownloadFile(data: DownloadFileRequest, res: http.ServerResponse, binding: TokenBinding): Promise<void> {
  try {
    const { sessionId, remotePath, localPath } = data
    if (!sessionId || !remotePath || !localPath) {
      sendJson(res, 400, { success: false, error: 'sessionId, remotePath, and localPath are required' })
      return
    }
    const resolvedSessionId = resolveRuntimeSessionId(sessionId)
    const session = sessionManager.getSession(resolvedSessionId)
    const sshConfig = session?.config.ssh
    // 限定 localPath 必须落在该会话的下载目录内，防止写到 Startup 等敏感位置（RCE/持久化）
    let safeLocalPath: string
    try {
      const downloadRoot = downloadHistory.getDownloadDir(
        resolvedSessionId,
        session?.config.name || '',
        sshConfig?.host || '',
        sshConfig?.port || 22
      )
      // 外部 agent 无从得知下载目录绝对路径：相对 localPath（文件名或子路径）解析进下载目录，
      // 传 "report.log" 即落到 <downloadRoot>/report.log；绝对路径仍按 containment 校验（目录外 400）。
      const resolvedLocal = path.isAbsolute(localPath) ? localPath : path.join(downloadRoot, localPath)
      safeLocalPath = assertSafeLocalPath(resolvedLocal, { write: true, containmentRoot: downloadRoot })
    } catch (pathErr: any) {
      sendJson(res, 400, { success: false, error: pathErr.message })
      return
    }
    const auth = await authorizeMcpOperation('download_file', 'fileWrite', resolvedSessionId, `${remotePath} -> ${safeLocalPath}`, binding)
    if (!auth.allowed) {
      sendJson(res, 403, { success: false, error: auth.reason })
      return
    }

    if (!session || session.config.type !== ConnectionType.SSH) {
      sendJson(res, 400, { success: false, error: 'download_file only supports SSH sessions' })
      return
    }
    if (session.status !== ConnectionStatus.CONNECTED) {
      sendJson(res, 409, { success: false, error: 'Session is not connected' })
      return
    }

    if (!sshConfig) {
      sendJson(res, 400, { success: false, error: 'SSH config not found' })
      return
    }

    const fileStat = await fileManager.stat(resolvedSessionId, remotePath)
    const fileSize = fileStat.size

    const connectorType = await fileManager.getConnectorType(resolvedSessionId)
    const taskId = uuidv4()

    // 最后一个 await 之后、入队前再校验连接状态：早期 CONNECTED 检查与入队之间存在 await 窗口，
    // 会话可能在期间断开（disconnectSession 已同步标记 DISCONNECTED 并取消排队任务）。
    if (session.status !== ConnectionStatus.CONNECTED) {
      sendJson(res, 409, { success: false, error: 'Session is not connected' })
      return
    }

    await runDownloadWorkerAndWait({
      taskId,
      sessionId: resolvedSessionId,
      method: connectorType === 'sftp' ? 'sftp' : 'exec',
      sshConfig: {
        host: sshConfig.host,
        port: sshConfig.port,
        username: sshConfig.username,
        password: sshConfig.password,
        privateKey: sshConfig.privateKey,
        passphrase: sshConfig.passphrase,
        readyTimeout: sshConfig.readyTimeout,
        keepaliveInterval: sshConfig.keepaliveInterval,
        shellEnterCommands: sshConfig.shellEnterCommands,
        shellEnterWait: sshConfig.shellEnterWait
      },
      remotePath,
      localPath: safeLocalPath,
      fileSize
    })

    // 传输完成后本地计算 MD5，供 MCP 调用方校验完整性
    let md5: string | undefined
    try {
      md5 = await fileManager.calculateMD5(safeLocalPath)
    } catch (md5Err: any) {
      log.warn(`[MCP] Failed to calculate MD5 for ${safeLocalPath}:`, md5Err.message)
    }

    const response: DownloadFileResponse = { md5, remotePath, localPath: safeLocalPath }
    sendJson(res, 200, { success: true, data: response })
  } catch (err: any) {
    sendJson(res, 500, { success: false, error: err.message })
  }
}

/**
 * POST /api/files/upload — 上传本地文件
 *
 * 使用 Worker 路径（与 UI 文件管理一致），避免主进程 shell channel 的
 * 15s/chunk ACK 超时对大文件不友好。
 */
async function handleUploadFile(data: UploadFileRequest, res: http.ServerResponse, binding: TokenBinding): Promise<void> {
  try {
    const { sessionId, localPath, remotePath } = data
    if (!sessionId || !localPath || !remotePath) {
      sendJson(res, 400, { success: false, error: 'sessionId, localPath, and remotePath are required' })
      return
    }
    let safeLocalPath: string
    try {
      safeLocalPath = assertSafeLocalPath(localPath, { write: false })
    } catch (pathErr: any) {
      sendJson(res, 400, { success: false, error: pathErr.message })
      return
    }
    const resolvedSessionId = resolveRuntimeSessionId(sessionId)
    const auth = await authorizeMcpOperation('upload_file', 'fileWrite', resolvedSessionId, `${safeLocalPath} -> ${remotePath}`, binding)
    if (!auth.allowed) {
      sendJson(res, 403, { success: false, error: auth.reason })
      return
    }

    const session = sessionManager.getSession(resolvedSessionId)
    if (!session || session.config.type !== ConnectionType.SSH) {
      sendJson(res, 400, { success: false, error: 'upload_file only supports SSH sessions' })
      return
    }
    if (session.status !== ConnectionStatus.CONNECTED) {
      sendJson(res, 409, { success: false, error: 'Session is not connected' })
      return
    }

    const sshConfig = session.config.ssh
    if (!sshConfig) {
      sendJson(res, 400, { success: false, error: 'SSH config not found' })
      return
    }

    let fileSize = 0
    try {
      const stat = fs.statSync(safeLocalPath)
      fileSize = stat.size
    } catch (err: any) {
      sendJson(res, 400, { success: false, error: `Local file not found: ${err.message}` })
      return
    }

    const connectorType = await fileManager.getConnectorType(resolvedSessionId)
    const taskId = uuidv4()

    // 最后一个 await 之后、入队前再校验连接状态：早期 CONNECTED 检查与入队之间存在 await 窗口，
    // 会话可能在期间断开（disconnectSession 已同步标记 DISCONNECTED 并取消排队任务）。
    if (session.status !== ConnectionStatus.CONNECTED) {
      sendJson(res, 409, { success: false, error: 'Session is not connected' })
      return
    }

    await runUploadWorkerAndWait({
      taskId,
      sessionId: resolvedSessionId,
      method: connectorType === 'sftp' ? 'sftp' : 'exec',
      sshConfig: {
        host: sshConfig.host,
        port: sshConfig.port,
        username: sshConfig.username,
        password: sshConfig.password,
        privateKey: sshConfig.privateKey,
        passphrase: sshConfig.passphrase,
        readyTimeout: sshConfig.readyTimeout,
        keepaliveInterval: sshConfig.keepaliveInterval,
        shellEnterCommands: sshConfig.shellEnterCommands,
        shellEnterWait: sshConfig.shellEnterWait
      },
      localPath: safeLocalPath,
      remotePath,
      fileSize
    })

    // 上传完成后计算远程文件 MD5，供 MCP 调用方校验完整性
    let md5: string | undefined
    try {
      md5 = await fileManager.calculateRemoteMD5(resolvedSessionId, remotePath)
    } catch (md5Err: any) {
      log.warn(`[MCP] Failed to calculate remote MD5 for ${remotePath}:`, md5Err.message)
    }

    const response: UploadFileResponse = { remotePath, localPath: safeLocalPath, md5 }
    sendJson(res, 200, { success: true, data: response })
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
  const resolvedId = resolveRuntimeSessionId(sessionId)
  const session = sessionManager.getSession(resolvedId)
  return {
    sessionId: resolvedId,
    sessionName: session?.config.name,
    sessionType: session?.config.type
  }
}

function summarizeText(value: unknown, maxLength: number = 200): string {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ')
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

function auditMcpOperation(event: McpAuditEvent): void {
  const timestamp = new Date().toISOString()
  const summary = event.summary ? summarizeText(event.summary, 512) : undefined
  log.info('[MCP][audit]', { ...event, timestamp, summary })
  // 同步入库供"MCP 活动"面板查询（内存环形缓冲 + 防抖落盘）
  mcpAuditRepository.append({
    operation: event.operation,
    capability: event.capability,
    sessionId: event.sessionId,
    sessionName: event.sessionName,
    sessionType: event.sessionType,
    allowed: event.allowed,
    reason: event.reason,
    summary,
    durationMs: event.durationMs,
    tokenSource: event.tokenSource ?? '',
    originSessionId: event.originSessionId
  })
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(value)))
}

function quotePosixPath(filePath: string): string {
  return `'${filePath.replace(/'/g, `'\\''`)}'`
}

/**
 * 校验本地路径安全：禁止路径穿越（含 .. 分量）
 */
async function authorizeMcpOperation(
  operation: string,
  capability: McpCapability,
  sessionId: string | undefined,
  summary: string | undefined,
  binding: TokenBinding
): Promise<{ allowed: boolean; reason?: string }> {
  const settings = getMcpSecuritySettings()
  // 把 saved id 解析为 runtime id，使 MCP 工具既可以用保存项 ID 也可以用 live session ID 调用。
  const resolvedSessionId = sessionId ? resolveRuntimeSessionId(sessionId) : undefined
  const session = resolvedSessionId ? sessionManager.getSession(resolvedSessionId) : undefined
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

  // 全局开关 + sessionId 黑/白名单（两类 token 共同受约束）。
  // 同时检查原始 id 与解析后的 runtime id：用户配置黑白名单时可能使用保存项 ID。
  if (!settings.enabled) return deny('MCP access is disabled')
  const isDenied = (sid?: string) => sid !== undefined && settings.deniedSessionIds.includes(sid)
  if (isDenied(sessionId) || isDenied(resolvedSessionId)) return deny('Session is denied for MCP')
  if (settings.allowedSessionIds.length > 0) {
    const isAllowed = (sid?: string) => sid !== undefined && settings.allowedSessionIds.includes(sid)
    if (!isAllowed(sessionId) && !isAllowed(resolvedSessionId)) {
      return deny('Session is not allowed for MCP')
    }
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
  // 注：MCP 本身已不暴露 delete_file 工具。需要删除的请走 execute_command + rm，
  //     由 allowSshExecute / allowLocalExecute 控制，并继承 SSH/PTY 自身的权限模型。
  if (binding.kind === 'session') {
    if (resolvedSessionId && session && session.config.type === ConnectionType.LOCAL && resolvedSessionId !== binding.originSessionId) {
      return deny('session token cannot drive other LOCAL terminals; only its own PTY or remote (SSH/Telnet/Serial) sessions are allowed')
    }
    // C5：session token 不得 resurrect 其它已断开的保存会话（可能持有已存凭据）——
    // 防止 PTY 内被注入的 agent 唤醒另一台带凭据的 SSH 会话再驱动它（横向移动 / 凭据重用）。
    // 自身 origin 的重连（自愈）与对已连接远端会话的控制（如刷新、关闭）仍允许。
    if (
      capability === 'sessionControl' &&
      resolvedSessionId && resolvedSessionId !== binding.originSessionId &&
      session && session.status === ConnectionStatus.DISCONNECTED
    ) {
      return deny('session token cannot reconnect other disconnected sessions (potential credential reuse); only its own session or already-connected remotes are allowed')
    }
    auditMcpOperation({ ...auditBase, allowed: true })
    return { allowed: true }
  }

  // plugin token：来自 plugin host（contributor 插件），绑定 pluginId + 用户安装时批准的
  // capability 子集（grantedCapabilities）。不要求 allowExternalMcpClients（plugin 是内部
  // host，非外部 client），不受 settings.allow* 控制（grantedCapabilities 是独立授权）。
  // 跨会话：plugin 可驱动任意会话（在其 grantedCapabilities 范围内），不受 session token 的
  // origin 限制；但仍受上方 deniedSessionIds/allowedSessionIds 约束。
  // requireConfirmation 跳过（plugin 已由用户安装批准），但 confirmDestructiveIfNeeded 仍生效。
  if (binding.kind === 'plugin') {
    if (!binding.capabilities?.includes(capability)) {
      // execute_command / run_on_sessions 按 session 类型选 execute(远端)或 localExecute(LOCAL):
      // 候选级 gate(plugin-host/api.ts)用 some() 放行任一,故插件可能持 execute 却在 LOCAL 会话被拒
      // (反之亦然)。给出可操作提示,避免「明明声明了 execute 却 403」的困惑。
      const pid = binding.pluginId ?? '<unknown>'
      const has = binding.capabilities ?? []
      let reason = `plugin ${pid} lacks capability '${capability}' for this operation`
      if (capability === 'localExecute' && has.includes('execute')) {
        reason +=
          " (LOCAL 会话的 execute_command / lyshell_run_on_sessions 要求 'localExecute' 而非 'execute';在 manifest 同时声明 'execute' 与 'localExecute' 以覆盖所有会话类型)"
      } else if (capability === 'execute' && has.includes('localExecute')) {
        reason +=
          " (远端会话的 execute_command / lyshell_run_on_sessions 要求 'execute' 而非 'localExecute';在 manifest 同时声明两者以覆盖所有会话类型)"
      }
      return deny(reason)
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
              capability === 'sessionControl' ? (settings.allowSessionControl === true) :
                capability === 'sessionMetadataWrite' ? (settings.allowSessionMetadataWrite === true) : false

  if (!capabilityAllowed) return deny(`MCP capability ${capability} is disabled`)

  if (capability === 'localExecute' && session?.config.type === ConnectionType.LOCAL && !settings.allowLocalExecute) {
    return deny('Local command execution is disabled')
  }

  if (settings.requireConfirmation && capability !== 'read') {
    const result = await dialog.showMessageBox({
      type: 'warning',
      buttons: [t('mcp.dialog.reject'), t('mcp.dialog.allowOnce')],
      defaultId: 0,
      cancelId: 0,
      title: t('mcp.dialog.highRiskTitle'),
      message: t('mcp.dialog.highRiskMessage', { operation }),
      detail: [
        session ? `${t('mcp.dialog.session')}: ${session.config.name} (${session.config.type})` : undefined,
        summary ? `${t('mcp.dialog.content')}: ${summarizeText(summary)}` : undefined
      ].filter(Boolean).join('\n')
    })
    if (result.response !== 1) return deny('User denied MCP operation')
  }

  auditMcpOperation({ ...auditBase, allowed: true })
  return { allowed: true }
}

/**
 * 破坏性命令内容级确认（B1）。
 *
 * 独立于 authorizeMcpOperation：capability 闸门通过后，再扫描命令内容是否命中
 * 灾难性 pattern。命中且 settings.confirmDestructiveCommands !== false 时弹窗确认。
 *
 * 关键：对 session token 和 global token 一视同仁——session token 在 authorize 中
 * 跳过 requireConfirmation 弹窗，本层是其唯一的"人工确认"机会，用于阻断
 * prompt-injection 触发的灾难性操作（如被注入的 agent 在 SSH 会话上跑 rm -rf /）。
 *
 * 已知限制：无法捕获跨多次 send_input 拼装的命令（见 destructive-check.ts）。
 */
async function confirmDestructiveIfNeeded(
  operation: string,
  content: string,
  sessionId: string | undefined,
  binding: TokenBinding
): Promise<{ allowed: boolean; reason?: string }> {
  const settings = getMcpSecuritySettings()
  // 默认 true；仅在用户显式关闭时跳过
  if (settings.confirmDestructiveCommands === false) return { allowed: true }

  const matches = scanDestructiveCommand(content)
  if (matches.length === 0) return { allowed: true }

  const sessionSummary = getSessionSummary(sessionId)
  const auditBase: Omit<McpAuditEvent, 'allowed'> = {
    operation,
    capability: 'destructiveConfirm',
    ...sessionSummary,
    summary: summarizeText(content),
    tokenSource: binding.kind,
    originSessionId: binding.originSessionId
  }

  const result = await dialog.showMessageBox({
    type: 'warning',
    buttons: [t('mcp.dialog.reject'), t('mcp.dialog.allowOnce')],
    defaultId: 0,
    cancelId: 0,
    title: t('mcp.dialog.destructiveTitle'),
    message: t('mcp.dialog.destructiveMessage'),
    detail: [
      sessionSummary.sessionName
        ? `${t('mcp.dialog.session')}: ${sessionSummary.sessionName} (${sessionSummary.sessionType})`
        : undefined,
      `${t('mcp.dialog.matchedRules')}: ${matches.map(m => m.name).join(', ')}`,
      `${t('mcp.dialog.explanation')}: ${matches.map(m => m.description).join('; ')}`,
      `${t('mcp.dialog.commandPreview')}: ${summarizeText(content, 300)}`
    ].filter(Boolean).join('\n')
  })

  if (result.response !== 1) {
    auditMcpOperation({ ...auditBase, allowed: false, reason: 'user denied destructive command' })
    return { allowed: false, reason: 'User denied destructive command' }
  }

  auditMcpOperation({ ...auditBase, allowed: true })
  return { allowed: true }
}

// ========== P1 资源端点 ==========

/**
 * GET /api/quick-commands — 返回快速命令列表（用于 MCP resource: lyshell://quick-commands）
 */
async function handleListQuickCommands(res: http.ServerResponse, binding: TokenBinding): Promise<void> {
  try {
    const auth = await authorizeMcpOperation('list_quick_commands', 'read', undefined, undefined, binding)
    if (!auth.allowed) {
      sendJson(res, 403, { success: false, error: auth.reason })
      return
    }
    const commands = quickCommandsRepository.getAll()
    const groups = quickCommandsRepository.getAllGroups()
    sendJson(res, 200, { success: true, data: { commands, groups } })
  } catch (err: any) {
    sendJson(res, 500, { success: false, error: err.message })
  }
}

/**
 * GET /api/agents — 返回 AI Agent 配置（脱敏：env 中疑似密钥的字段以 [REDACTED] 替换）
 */
async function handleListAgents(res: http.ServerResponse, binding: TokenBinding): Promise<void> {
  try {
    const auth = await authorizeMcpOperation('list_agents', 'read', undefined, undefined, binding)
    if (!auth.allowed) {
      sendJson(res, 403, { success: false, error: auth.reason })
      return
    }
    const agents = agentRepository.getAll().map(a => ({
      id: a.id,
      name: a.name,
      command: a.command,
      icon: a.icon,
      cwd: a.cwd,
      order: a.order,
      env: a.env ? redactSecretEnv(a.env) : undefined
    }))
    sendJson(res, 200, { success: true, data: agents })
  } catch (err: any) {
    sendJson(res, 500, { success: false, error: err.message })
  }
}

/**
 * GET /api/sessions/{id}/output?lines=200 — 返回指定会话的最近输出（resource: lyshell://sessions/{id}/output）
 */
async function handleSessionOutputResource(
  sessionId: string,
  url: URL,
  res: http.ServerResponse,
  binding: TokenBinding
): Promise<void> {
  try {
    const resolvedSessionId = resolveRuntimeSessionId(sessionId)
    const auth = await authorizeMcpOperation('read_output_resource', 'read', resolvedSessionId, undefined, binding)
    if (!auth.allowed) {
      sendJson(res, 403, { success: false, error: auth.reason })
      return
    }
    const session = sessionManager.getSession(resolvedSessionId)
    if (!session) {
      sendJson(res, 404, { success: false, error: `Session not found: ${sessionId}` })
      return
    }
    const rawLines = url.searchParams.get('lines')
    const linesNum = rawLines ? Number(rawLines) : 200
    const out = sessionManager.readOutput(resolvedSessionId, {
      lines: clampNumber(linesNum, 1, 1000, 200),
      raw: false
    })
    if (!out) {
      sendJson(res, 400, { success: false, error: 'Output buffer not available (session may be disconnected)' })
      return
    }
    sendJson(res, 200, { success: true, data: out })
  } catch (err: any) {
    sendJson(res, 500, { success: false, error: err.message })
  }
}

/**
 * 简单脱敏：env 中 key 含 token/secret/key/password 等关键字的值替换为 [REDACTED]。
 * 列表大小写不敏感。
 */
function redactSecretEnv(env: Record<string, string>): Record<string, string> {
  const SECRET_PATTERNS = /(token|secret|password|passwd|key|api[_-]?key)/i
  const result: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    result[k] = SECRET_PATTERNS.test(k) ? '[REDACTED]' : v
  }
  return result
}

// ========== P1 高层 workflow 工具 ==========

/**
 * POST /api/wait-for-prompt — 等待某模式在终端输出中出现（不发送任何输入）
 */
async function handleWaitForPrompt(
  data: { sessionId: string; pattern?: string; timeoutMs?: number; idleMs?: number },
  res: http.ServerResponse,
  binding: TokenBinding
): Promise<void> {
  try {
    const { sessionId, pattern } = data
    if (!sessionId) {
      sendJson(res, 400, { success: false, error: 'sessionId is required' })
      return
    }
    const resolvedSessionId = resolveRuntimeSessionId(sessionId)
    // pattern 可选：缺省匹配常见 shell 提示符（$ / # / > / % 之一结尾，允许尾随空白）
    const patternStr = pattern && pattern.trim() ? pattern : '[$#>%]\\s*$'

    const session = sessionManager.getSession(resolvedSessionId)
    if (!session) {
      sendJson(res, 404, { success: false, error: `Session not found: ${sessionId}` })
      return
    }
    if (session.status !== ConnectionStatus.CONNECTED) {
      sendJson(res, 400, { success: false, error: `Session not connected (status: ${session.status})` })
      return
    }

    const auth = await authorizeMcpOperation('wait_for_prompt', 'read', resolvedSessionId, summarizeText(patternStr, 200), binding)
    if (!auth.allowed) {
      sendJson(res, 403, { success: false, error: auth.reason })
      return
    }

    // 先编译正则（提前 400，避免进入等待后才发现非法）
    let regex: RegExp
    try {
      regex = new RegExp(patternStr)
    } catch (e: any) {
      sendJson(res, 400, { success: false, error: `Invalid pattern regex: ${e.message}` })
      return
    }

    // 先查"已在缓冲区里"的近期输出：典型场景是 prompt 已就绪（reconnect 后、命令刚返回），
    // 此时没有新输出产生，纯等新输出会超时。命中即立即返回。
    // 同时在 raw 与 ANSI 清洗后两种基底上匹配：默认 prompt 正则依赖清洗后的 $ 锚定，
    // 而带 ANSI 码的自定义正则只在 raw 上命中。
    const existingRaw = sessionManager.readOutput(resolvedSessionId, { lines: 1000, raw: true })
    const existingClean = sessionManager.readOutput(resolvedSessionId, { lines: 1000, raw: false })
    if (existingRaw && existingClean && (regex.test(existingRaw.output) || regex.test(existingClean.output))) {
      sendJson(res, 200, {
        success: true,
        data: { output: existingClean.output, cleanOutput: existingClean.output, settled: true, patternMatched: true, elapsedMs: 0 }
      })
      return
    }

    // 未在现有缓冲区命中 → 等待新输出。复用 sendAndWait({text:''})：
    //  - 持有 pendingWaitLock，与 send_and_wait 互斥（避免并发对同一会话输出产生误判）；
    //  - 在 raw 与清洗后两种基底上匹配（见 sendAndWait 实现）；
    //  - 用 idleMs 做 settle 早返回（终端静默 idleMs 后即返回 settled:true）。
    // 仅匹配"调用后新产生"的输出，避免对历史 scrollback 误命中（自定义 pattern 等待新出现时尤为关键）。
    const result: SendAndWaitResult = await sessionManager.sendAndWait(resolvedSessionId, {
      text: '',
      waitMs: 0,
      idleMs: clampNumber(data.idleMs, 50, 10000, 500),
      maxWaitMs: clampNumber(data.timeoutMs, 100, MAX_COMMAND_TIMEOUT_MS, 30000),
      waitForPattern: patternStr,
      autoNewline: false
    })

    sendJson(res, 200, { success: true, data: result })
  } catch (err: any) {
    sendJson(res, 500, { success: false, error: err.message })
  }
}

/**
 * POST /api/run-on-sessions — 并发在多个会话上执行同一命令
 * 单会话失败不影响其他会话；每个会话独立鉴权。
 * 最大并发 = min(sessionIds.length, 10)
 */
async function handleRunOnSessions(
  data: { sessionIds: string[]; command: string; timeout?: number; dryRun?: boolean },
  res: http.ServerResponse,
  binding: TokenBinding
): Promise<void> {
  try {
    const { sessionIds, command, timeout = 30000 } = data
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
      sendJson(res, 400, { success: false, error: 'sessionIds must be a non-empty array' })
      return
    }
    if (sessionIds.length > 50) {
      sendJson(res, 400, { success: false, error: 'sessionIds limited to 50 per call' })
      return
    }
    if (typeof command !== 'string' || command.length === 0) {
      sendJson(res, 400, { success: false, error: 'command is required' })
      return
    }
    if (command.length > MAX_TEXT_LENGTH) {
      sendJson(res, 400, { success: false, error: `Command too large (max ${MAX_TEXT_LENGTH} chars)` })
      return
    }

    // dryRun：仅预览将受影响的会话，不执行、不触发破坏性确认
    if (data.dryRun === true) {
      const targets = sessionIds.map(sid => {
        const s = sessionManager.getSession(sid)
        const connected = !!s && s.status === ConnectionStatus.CONNECTED
        const supported = !!s && (s.config.type === ConnectionType.SSH || s.config.type === ConnectionType.LOCAL)
        return {
          sessionId: sid,
          sessionName: s?.config.name,
          sessionType: s?.config.type,
          status: s?.status,
          wouldExecute: connected && supported
        }
      })
      sendJson(res, 200, { success: true, data: { dryRun: true, command, targets } })
      return
    }

    const safeTimeout = clampNumber(timeout, 100, MAX_COMMAND_TIMEOUT_MS, 30000)

    // 命令对所有目标会话相同，破坏性确认只做一次；拒绝则整单 403，避免 50 次弹窗
    const destructive = await confirmDestructiveIfNeeded('run_on_sessions', command, undefined, binding)
    if (!destructive.allowed) {
      sendJson(res, 403, { success: false, error: destructive.reason })
      return
    }

    // 单 session 的执行（含鉴权 + 类型路由），失败转为 result entry 而非抛出
    const runOne = async (sid: string): Promise<{ sessionId: string; output?: string; exitCode?: number; error?: string }> => {
      const session = sessionManager.getSession(sid)
      if (!session) return { sessionId: sid, error: `Session not found: ${sid}` }
      if (session.status !== ConnectionStatus.CONNECTED) {
        return { sessionId: sid, error: `Session not connected (status: ${session.status})` }
      }
      const cap: McpCapability = session.config.type === ConnectionType.LOCAL ? 'localExecute' : 'execute'
      const auth = await authorizeMcpOperation('run_on_sessions', cap, sid, summarizeText(command), binding)
      if (!auth.allowed) return { sessionId: sid, error: auth.reason }

      try {
        if (session.config.type === ConnectionType.SSH) {
          const connector = await fileManager.getConnector(sid)
          if (!connector.execRaw) {
            return { sessionId: sid, error: 'Connector does not support execution' }
          }
          const output = await connector.execRaw(command, safeTimeout)
          return { sessionId: sid, output, exitCode: 0 }
        }
        if (session.config.type === ConnectionType.LOCAL) {
          const r = await executeLocalCommand(command, session.config.local?.cwd, session.config.local?.env, safeTimeout)
          return { sessionId: sid, output: r.output, exitCode: r.exitCode }
        }
        return { sessionId: sid, error: `Command execution not supported for session type: ${session.config.type}` }
      } catch (e: any) {
        return { sessionId: sid, error: e.message || 'Unknown error' }
      }
    }

    // 简单并发池：每次同时跑 min(remaining, 10)
    const CONCURRENCY = Math.min(sessionIds.length, 10)
    const queue = [...sessionIds]
    const results: Array<{ sessionId: string; output?: string; exitCode?: number; error?: string }> = []
    const workers: Promise<void>[] = []
    for (let i = 0; i < CONCURRENCY; i++) {
      workers.push((async () => {
        while (queue.length > 0) {
          const sid = queue.shift()!
          results.push(await runOne(sid))
        }
      })())
    }
    await Promise.all(workers)

    sendJson(res, 200, { success: true, data: { results } })
  } catch (err: any) {
    sendJson(res, 500, { success: false, error: err.message })
  }
}

/**
 * POST /api/tail-until — 循环检查会话输出，直到正则匹配或超时
 * 比 wait_for_prompt 更适合"看着日志直到 X 出现"的语义；
 * 内部按 idleMs 间隔轮询 readOutput 缓冲，避免和实时 send_and_wait 共享数据流冲突。
 */
async function handleTailUntil(
  data: { sessionId: string; pattern: string; timeoutMs?: number; pollMs?: number },
  res: http.ServerResponse,
  binding: TokenBinding
): Promise<void> {
  try {
    const { sessionId, pattern } = data
    if (!sessionId || !pattern) {
      sendJson(res, 400, { success: false, error: 'sessionId and pattern are required' })
      return
    }

    const resolvedSessionId = resolveRuntimeSessionId(sessionId)
    const session = sessionManager.getSession(resolvedSessionId)
    if (!session) {
      sendJson(res, 404, { success: false, error: `Session not found: ${sessionId}` })
      return
    }
    if (session.status !== ConnectionStatus.CONNECTED) {
      sendJson(res, 400, { success: false, error: `Session not connected (status: ${session.status})` })
      return
    }

    const auth = await authorizeMcpOperation('tail_until', 'read', resolvedSessionId, summarizeText(pattern, 200), binding)
    if (!auth.allowed) {
      sendJson(res, 403, { success: false, error: auth.reason })
      return
    }

    let regex: RegExp
    try {
      regex = new RegExp(pattern)
    } catch (e: any) {
      sendJson(res, 400, { success: false, error: `Invalid pattern regex: ${e.message}` })
      return
    }

    const timeoutMs = clampNumber(data.timeoutMs, 500, MAX_COMMAND_TIMEOUT_MS, 30000)
    const pollMs = clampNumber(data.pollMs, 100, 5000, 500)
    const start = Date.now()
    let matched = false
    let lastOutput = ''

    while (Date.now() - start < timeoutMs) {
      const out = sessionManager.readOutput(resolvedSessionId, { lines: 500, raw: false })
      if (out) {
        lastOutput = out.output
        if (regex.test(lastOutput)) {
          matched = true
          break
        }
      }
      // 注意：会话中途断开则放弃
      const fresh = sessionManager.getSession(resolvedSessionId)
      if (!fresh || fresh.status !== ConnectionStatus.CONNECTED) {
        sendJson(res, 200, {
          success: true,
          data: { matched: false, elapsedMs: Date.now() - start, output: lastOutput, reason: 'session disconnected' }
        })
        return
      }
      await new Promise(r => setTimeout(r, pollMs))
    }

    sendJson(res, 200, {
      success: true,
      data: { matched, elapsedMs: Date.now() - start, output: lastOutput }
    })
  } catch (err: any) {
    sendJson(res, 500, { success: false, error: err.message })
  }
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
 * 本地命令流式执行（spawn），与 executeLocalCommand 的 cwd/env 处理一致，
 * 但 stdout/stderr 增量推送且捕获真实 exitCode。
 *
 * 超时与 SSH execStream 对齐：超时 kill 子进程后 reject('Command timeout')，
 * 由 SSE 层发 error 事件（部分输出已通过增量 chunk 实时推给客户端，agent 不会丢）。
 * abort（客户端断开 SSE）kill 后仍 resolve——响应已关闭，结果被丢弃，无需报错。
 */
function executeLocalCommandStream(
  command: string,
  cwd: string | undefined,
  env: Record<string, string> | undefined,
  timeout: number,
  onData: (chunk: string) => void,
  signal?: AbortSignal
): Promise<{ output: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const execEnv = { ...process.env, ...env } as Record<string, string>
    const execCwd = cwd || process.env.USERPROFILE || process.env.HOME || ''

    log.info(`[MCP] Executing local command (stream): ${command} (cwd: ${execCwd})`)

    const child = spawn(command, { cwd: execCwd, env: execEnv, shell: true, windowsHide: true })
    let output = ''
    let settled = false
    let timedOut = false  // 区分超时 kill 与正常 close，超时需 reject 以发 SSE error

    const finish = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); fn() } }

    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, timeout)
    const onAbort = () => { child.kill('SIGTERM') }  // abort 不置 timedOut：客户端断开，结果丢弃，不报错
    if (signal) {
      if (signal.aborted) child.kill('SIGTERM')
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout?.on('data', (d: Buffer) => { const c = d.toString(); output += c; onData(c) })
    child.stderr?.on('data', (d: Buffer) => { const c = d.toString(); output += c; onData(c) })
    child.on('error', (e) => finish(() => reject(e)))
    child.on('close', (code: number | null) => finish(() => {
      if (timedOut) reject(new Error('Command timeout'))
      else resolve({ output, exitCode: code ?? 0 })
    }))
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
