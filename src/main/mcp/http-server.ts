/**
 * MCP HTTP API 服务�?
 * 运行�?LyShell 主进程中，提�?HTTP API �?MCP Server 进程调用
 * 监听 127.0.0.1:0（随机端口），通过端口文件通知 MCP Server
 */

import * as http from 'http'
import * as net from 'net'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { exec, execSync } from 'child_process'
import { app } from 'electron'
import log from 'electron-log'
import { v4 as uuidv4 } from 'uuid'

import { sessionManager, processInputEscapeSequences } from '../terminal/session-manager'
import { fileManager } from '../file/manager'
import { ConnectionType, ConnectionStatus } from '@shared/types'
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
let authToken: string | null = null
const PORT_FILE_NAME = 'mcp-server.json'

/**
 * 启动 MCP HTTP 服务�?
 */
export async function startMcpHttpServer(): Promise<void> {
  authToken = crypto.randomBytes(32).toString('hex')

  server = http.createServer(handleRequest)

  await new Promise<void>((resolve, reject) => {
    server!.listen(0, '127.0.0.1', () => resolve())
    server!.on('error', reject)
  })

  const address = server!.address() as net.AddressInfo
  const port = address.port

  // 写入端口文件
  const portFilePath = getPortFilePath()
  const portInfo: McpPortInfo = {
    port,
    token: authToken,
    pid: process.pid,
    version: 1
  }
  fs.writeFileSync(portFilePath, JSON.stringify(portInfo, null, 2), 'utf-8')

  // 写入 Claude Code MCP 配置
  await writeClaudeMcpConfig(port)

  log.info(`[MCP] HTTP server started on port ${port}`)
}

/**
 * 停止 MCP HTTP 服务�?
 */
export async function stopMcpHttpServer(): Promise<void> {
  // 关闭 HTTP 服务�?
  if (server) {
    await new Promise<void>(resolve => {
      server!.close(() => resolve())
    })
    server = null
  }

  // 清理端口文件
  const portFilePath = getPortFilePath()
  try {
    fs.unlinkSync(portFilePath)
  } catch {
    // 忽略删除失败
  }

  // 清理 Claude Code MCP 配置
  await removeClaudeMcpConfig()

  log.info('[MCP] HTTP server stopped')
}

/**
 * 获取端口文件路径
 */
function getPortFilePath(): string {
  return path.join(app.getPath('userData'), PORT_FILE_NAME)
}

/**
 * 获取 MCP Server 脚本的绝对路�?
 */
function getMcpServerScriptPath(): string {
  if (app.isPackaged) {
    // 生产环境：asar 包内�?dist/main/mcpServer.js
    return path.join(process.resourcesPath, 'app', 'dist', 'main', 'mcpServer.js')
  }
  // 开发环境：__dirname �?dist/main/，mcpServer.js 也在 dist/main/ �?
  return path.join(__dirname, 'mcpServer.js')
}


/**
 * ���� Node.js ��ִ���ļ�·��
 * Electron ��������� process.execPath ָ�� Electron �����ƣ�����ֱ��������� MCP Server �ӽ���
 * ��Ҫ����ϵͳ��װ�� Node.js
 */
function resolveNodePath(): string {
  // 优先查找系统 Node.js（Electron 的 process.execPath 指向 Electron 二进制，
  // 不能用来启动 MCP Server 子进程）
  try {
    const result = execSync('where node', { encoding: 'utf-8', timeout: 5000 }).trim()
    const candidates = result.split(/\r?\n/).map(p => p.trim()).filter(Boolean)
    if (candidates.length > 0) return candidates[0]
  } catch {
    // where ����ʧ�ܣ����Գ���·��
  }

  // Windows ����·��
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

  // ���ջ��ˣ�ʹ�� Electron ����� Node ����
  log.warn('[MCP] Could not find system Node.js, falling back to process.execPath')
  return process.execPath
}
/**
 * 写入 Claude Code MCP 配置
 */
async function writeClaudeMcpConfig(_port: number): Promise<void> {
  try {
    const mcpConfigPath = await getClaudeMcpConfigPath()
    if (!mcpConfigPath) return

    // 读取现有配置（如果存在）
    let config: any = {}
    try {
      const content = fs.readFileSync(mcpConfigPath, 'utf-8')
      config = JSON.parse(content)
    } catch {
      // 文件不存在或格式错误，使用空配置
    }

    // 确保 mcpServers 对象存在
    if (!config.mcpServers) {
      config.mcpServers = {}
    }

    // ��ȡ node ·����Electron ��������� process.execPath ָ�� Electron ���� Node.js��
    const nodePath = resolveNodePath()

    // 获取 mcpServer.js 路径
    const scriptPath = getMcpServerScriptPath()

    // 写入 lyshell 配置
    config.mcpServers.lyshell = {
      command: nodePath,
      args: [scriptPath],
      env: {
        LYSHELL_USER_DATA: app.getPath('userData')
      }
    }

    // 确保目录存在
    const configDir = path.dirname(mcpConfigPath)
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true })
    }


    // ����ԭ�����ã���ֹд��ʧ�ܵ��������ļ���
    if (fs.existsSync(mcpConfigPath)) {
      const backupPath = mcpConfigPath + '.bak'
      fs.copyFileSync(mcpConfigPath, backupPath)
    }
    fs.writeFileSync(mcpConfigPath, JSON.stringify(config, null, 2), 'utf-8')
    log.info(`[MCP] Claude Code config written to ${mcpConfigPath}`)
  } catch (err) {
    log.warn('[MCP] Failed to write Claude Code MCP config:', err)
  }
}

/**
 * 移除 Claude Code MCP 配置中的 lyshell 条目
 */
async function removeClaudeMcpConfig(): Promise<void> {
  try {
    const mcpConfigPath = await getClaudeMcpConfigPath()
    if (!mcpConfigPath) return

    if (!fs.existsSync(mcpConfigPath)) return

    const content = fs.readFileSync(mcpConfigPath, 'utf-8')
    const config = JSON.parse(content)

    if (config.mcpServers && config.mcpServers.lyshell) {
      delete config.mcpServers.lyshell

      // 如果 mcpServers 为空，删除整个键
      if (Object.keys(config.mcpServers).length === 0) {
        delete config.mcpServers
      }

      fs.writeFileSync(mcpConfigPath, JSON.stringify(config, null, 2), 'utf-8')
      log.info('[MCP] Claude Code config cleaned up')
    }
  } catch (err) {
    log.warn('[MCP] Failed to remove Claude Code MCP config:', err)
  }
}

/**
 * 获取 Claude Code MCP 配置文件路径
 */
async function getClaudeMcpConfigPath(): Promise<string | null> {
  // Windows: %USERPROFILE%\.claude\mcp.json
  // macOS/Linux: ~/.claude/mcp.json
  const homeDir = process.env.USERPROFILE || process.env.HOME
  if (!homeDir) return null
  return path.join(homeDir, '.claude', 'mcp.json')
}

// ========== HTTP 请求处理 ==========

/**
 * 请求处理�?
 */
function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  // CORS 支持
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-LyShell-Token')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  // 鉴权检查（health 端点除外�?
  const url = new URL(req.url || '/', `http://127.0.0.1`)
  if (url.pathname !== '/api/health') {
    const token = req.headers['x-lyshell-token']
    if (token !== authToken) {
      sendJson(res, 401, { success: false, error: 'Unauthorized' })
      return
    }
  }

  // 路由分发
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(res, 200, { success: true, data: { status: 'ok' } })
    }

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
            return handleExecuteCommand(data, res)
          case '/api/send-input':
            return handleSendInput(data, res)
          case '/api/read-output':
            return handleReadOutput(data, res)
          case '/api/send-and-wait':
            return handleSendAndWait(data, res)
          case '/api/files/list':
            return handleListFiles(data, res)
          case '/api/files/read':
            return handleReadFile(data, res)
          case '/api/files/stat':
            return handleStatFile(data, res)
          case '/api/files/download':
            return handleDownloadFile(data, res)
          case '/api/files/upload':
            return handleUploadFile(data, res)
          case '/api/files/delete':
            return handleDeleteFile(data, res)
          case '/api/files/rename':
            return handleRenameFile(data, res)
          case '/api/files/mkdir':
            return handleCreateDirectory(data, res)
          case '/api/files/md5':
            return handleGetFileMd5(data, res)
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
 * GET /api/sessions �?列出所有会�?
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
 * POST /api/execute �?执行命令
 */
async function handleExecuteCommand(data: ExecuteRequest, res: http.ServerResponse): Promise<void> {
  try {
    const { sessionId, command, timeout = 30000 } = data

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

    let result: ExecuteResponse

    if (session.config.type === ConnectionType.SSH) {
      // SSH 会话：使�?fileManager �?connector（独�?SSH exec 通道�?
      const connector = await fileManager.getConnector(sessionId)
      if (!connector.execRaw) {
        sendJson(res, 500, { success: false, error: 'Connector does not support command execution' })
        return
      }
      const output = await connector.execRaw(command, timeout)
      result = { output, exitCode: 0 }
    } else if (session.config.type === ConnectionType.LOCAL) {
      // 本地会话：使�?child_process.exec
      result = await executeLocalCommand(command, session.config.local?.cwd, session.config.local?.env, timeout)
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
function handleSendInput(data: SendInputRequest, res: http.ServerResponse): void {
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
function handleReadOutput(data: ReadOutputRequest, res: http.ServerResponse): void {
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

    const result = sessionManager.readOutput(sessionId, {
      lines: data.lines,
      raw: data.raw
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
async function handleSendAndWait(data: SendAndWaitRequest, res: http.ServerResponse): Promise<void> {
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

    const result: SendAndWaitResult = await sessionManager.sendAndWait(sessionId, {
      text,
      waitMs: data.waitMs,
      idleMs: data.idleMs,
      maxWaitMs: data.maxWaitMs,
      waitForPattern: data.waitForPattern
    })

    log.info(`[MCP] Send-and-wait to session ${sessionId}: settled=${result.settled} elapsed=${result.elapsedMs}ms`)
    sendJson(res, 200, { success: true, data: result })
  } catch (err: any) {
    log.error('[MCP] Send-and-wait error:', err)
    sendJson(res, 500, { success: false, error: err.message })
  }
}

/**
 * POST /api/files/list �?列出目录内容
 */
async function handleListFiles(data: FileOperationRequest, res: http.ServerResponse): Promise<void> {
  try {
    const { sessionId, path: dirPath } = data
    if (!sessionId || !dirPath) {
      sendJson(res, 400, { success: false, error: 'sessionId and path are required' })
      return
    }
    const files = await fileManager.listDir(sessionId, dirPath)
    sendJson(res, 200, { success: true, data: files })
  } catch (err: any) {
    sendJson(res, 500, { success: false, error: err.message })
  }
}

/**
 * POST /api/files/read �?读取远程文件内容
 */
async function handleReadFile(data: ReadFileRequest, res: http.ServerResponse): Promise<void> {
  try {
    const { sessionId, path: filePath, maxSize = 1048576 } = data
    if (!sessionId || !filePath) {
      sendJson(res, 400, { success: false, error: 'sessionId and path are required' })
      return
    }

    const connector = await fileManager.getConnector(sessionId)

    // 先检查文件信�?
    const stat = await connector.stat(filePath)
    if (stat.isDir) {
      sendJson(res, 400, { success: false, error: 'Path is a directory, not a file' })
      return
    }
    if (stat.size > maxSize) {
      sendJson(res, 400, { success: false, error: `File too large (${stat.size} bytes, max ${maxSize} bytes). Use download_file instead.` })
      return
    }

    // 使用 execRaw 执行 cat 读取文件
    if (!connector.execRaw) {
      sendJson(res, 500, { success: false, error: 'Connector does not support command execution' })
      return
    }

    const safePath = filePath.includes("'") ? `"${filePath}"` : `'${filePath}'`
    const content = await connector.execRaw(`cat ${safePath}`)

    const result: ReadFileResponse = { content, size: stat.size }
    sendJson(res, 200, { success: true, data: result })
  } catch (err: any) {
    sendJson(res, 500, { success: false, error: err.message })
  }
}

/**
 * POST /api/files/stat �?获取文件元信�?
 */
async function handleStatFile(data: FileOperationRequest, res: http.ServerResponse): Promise<void> {
  try {
    const { sessionId, path: filePath } = data
    if (!sessionId || !filePath) {
      sendJson(res, 400, { success: false, error: 'sessionId and path are required' })
      return
    }
    const stat = await fileManager.stat(sessionId, filePath)
    sendJson(res, 200, { success: true, data: stat })
  } catch (err: any) {
    sendJson(res, 500, { success: false, error: err.message })
  }
}

/**
 * POST /api/files/download �?下载远程文件
 */
async function handleDownloadFile(data: DownloadFileRequest, res: http.ServerResponse): Promise<void> {
  try {
    const { sessionId, remotePath, localPath } = data
    if (!sessionId || !remotePath || !localPath) {
      sendJson(res, 400, { success: false, error: 'sessionId, remotePath, and localPath are required' })
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
 * POST /api/files/upload �?上传本地文件
 */
async function handleUploadFile(data: UploadFileRequest, res: http.ServerResponse): Promise<void> {
  try {
    const { sessionId, localPath, remotePath } = data
    if (!sessionId || !localPath || !remotePath) {
      sendJson(res, 400, { success: false, error: 'sessionId, localPath, and remotePath are required' })
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
 * POST /api/files/delete �?删除远程文件/目录
 */
async function handleDeleteFile(data: FileOperationRequest, res: http.ServerResponse): Promise<void> {
  try {
    const { sessionId, path: filePath } = data
    if (!sessionId || !filePath) {
      sendJson(res, 400, { success: false, error: 'sessionId and path are required' })
      return
    }
    await fileManager.delete(sessionId, filePath)
    sendJson(res, 200, { success: true, data: {} })
  } catch (err: any) {
    sendJson(res, 500, { success: false, error: err.message })
  }
}

/**
 * POST /api/files/rename �?重命�?移动远程文件
 */
async function handleRenameFile(data: RenameFileRequest, res: http.ServerResponse): Promise<void> {
  try {
    const { sessionId, oldPath, newPath } = data
    if (!sessionId || !oldPath || !newPath) {
      sendJson(res, 400, { success: false, error: 'sessionId, oldPath, and newPath are required' })
      return
    }
    await fileManager.rename(sessionId, oldPath, newPath)
    sendJson(res, 200, { success: true, data: {} })
  } catch (err: any) {
    sendJson(res, 500, { success: false, error: err.message })
  }
}

/**
 * POST /api/files/mkdir �?创建远程目录
 */
async function handleCreateDirectory(data: FileOperationRequest, res: http.ServerResponse): Promise<void> {
  try {
    const { sessionId, path: dirPath } = data
    if (!sessionId || !dirPath) {
      sendJson(res, 400, { success: false, error: 'sessionId and path are required' })
      return
    }
    await fileManager.mkdir(sessionId, dirPath)
    sendJson(res, 200, { success: true, data: {} })
  } catch (err: any) {
    sendJson(res, 500, { success: false, error: err.message })
  }
}

/**
 * POST /api/files/md5 �?计算远程文件 MD5
 */
async function handleGetFileMd5(data: FileMd5Request, res: http.ServerResponse): Promise<void> {
  try {
    const { sessionId, path: filePath } = data
    if (!sessionId || !filePath) {
      sendJson(res, 400, { success: false, error: 'sessionId and path are required' })
      return
    }
    const md5 = await fileManager.calculateRemoteMD5(sessionId, filePath)
    sendJson(res, 200, { success: true, data: { md5 } })
  } catch (err: any) {
    sendJson(res, 500, { success: false, error: err.message })
  }
}

// ========== 工具函数 ==========

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

    // �����־����¼ͨ�� MCP ִ�еı�������
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
 * 发�?JSON 响应
 */
function sendJson(res: http.ServerResponse, statusCode: number, data: ApiResponse): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}
