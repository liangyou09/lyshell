/**
 * LyShell HTTP API 客户端
 * MCP Server 进程通过此客户端调用 LyShell 主进程的 HTTP API
 * 使用 Node.js 内置 http 模块，无外部依赖
 */

import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'
import type { McpPortInfo } from '../mcp/types'

/**
 * 发现 LyShell HTTP API 的连接信息
 *
 * 优先级：
 *   1. LYSHELL_MCP_PORT + LYSHELL_MCP_TOKEN 环境变量
 *      —— LyShell 启动本地 PTY 时直接注入，进程在该 PTY 子树内继承。
 *      这是默认且推荐路径："只对 LyShell 内部终端开放"。
 *      env 存在但格式无效一律视为致命错误：调用方明显期望走 env 通道，
 *      此时回退到端口文件只会让用户看到误导性的"外部访问已禁用"提示。
 *   2. 端口文件 mcp-server.json
 *      —— 仅当用户开启 security.mcp.allowExternalMcpClients 时端口文件含 token，
 *      否则 token 为 null，本路径接入失败。
 */
export function discoverLyshell(): { port: number; token: string } | null {
  // 1. env 注入（PTY 内运行）
  const envPortRaw = process.env.LYSHELL_MCP_PORT
  const envToken = process.env.LYSHELL_MCP_TOKEN
  const envProvided = envPortRaw !== undefined || envToken !== undefined
  if (envProvided) {
    if (envPortRaw === undefined || envToken === undefined) {
      console.error('LYSHELL_MCP_PORT/LYSHELL_MCP_TOKEN env vars must be set together; saw only one')
      return null
    }
    const envPort = parseInt(envPortRaw, 10)
    if (!(Number.isInteger(envPort) && envPort > 0 && envPort <= 65535)) {
      console.error(`Invalid LYSHELL_MCP_PORT="${envPortRaw}" (expected integer 1-65535)`)
      return null
    }
    if (!/^[a-f0-9]{64}$/i.test(envToken)) {
      console.error('Invalid LYSHELL_MCP_TOKEN format (expected 64 hex chars)')
      return null
    }
    return { port: envPort, token: envToken }
  }

  // 2. 端口文件兜底（无 env 时）
  const info = readPortFile()
  if (!info) return null
  if (!info.token) {
    console.error('LyShell external MCP access is disabled (port file token is null).')
    console.error('Either run `claude` inside a LyShell-spawned local terminal,')
    console.error('or enable security.mcp.allowExternalMcpClients in LyShell preferences.')
    return null
  }
  return { port: info.port, token: info.token }
}

/**
 * 读取端口文件，获取 LyShell HTTP API 的连接信息
 * 返回的 token 可能为 null（外部访问已关闭）—— 调用方需通过 discoverLyshell() 处理。
 */
export function readPortFile(): McpPortInfo | null {
  const userDataDir = getUserDataDir()
  if (!userDataDir) {
    console.error('Cannot determine LyShell user data directory')
    return null
  }

  const portFilePath = path.join(userDataDir, 'mcp-server.json')

  if (!fs.existsSync(portFilePath)) {
    console.error(`Port file not found: ${portFilePath}`)
    console.error('Make sure LyShell is running.')
    return null
  }

  try {
    const content = fs.readFileSync(portFilePath, 'utf-8')
    const info = JSON.parse(content) as McpPortInfo

    if (!isValidPortInfo(info)) {
      console.error('Invalid LyShell MCP port file format')
      return null
    }

    if (!isPortFilePermissionSafe(portFilePath)) {
      console.error('LyShell MCP port file permissions are too broad')
      return null
    }

    // 检查 PID 是否仍在运行
    if (!isProcessRunning(info.pid)) {
      console.error(`LyShell process (PID ${info.pid}) is not running`)
      return null
    }

    return info
  } catch (err: any) {
    console.error(`Failed to read port file: ${err.message}`)
    return null
  }
}

/**
 * 端口文件格式校验。token 可为 null —— v2 表示外部访问关闭。
 */
function isValidPortInfo(info: McpPortInfo): boolean {
  const tokenOk = info.token === null
    || (typeof info.token === 'string' && /^[a-f0-9]{64}$/i.test(info.token))
  return Number.isInteger(info.port) &&
    info.port > 0 &&
    info.port <= 65535 &&
    Number.isInteger(info.pid) &&
    info.pid > 0 &&
    (info.version === 1 || info.version === 2) &&
    tokenOk
}

function isPortFilePermissionSafe(portFilePath: string): boolean {
  if (process.platform === 'win32') {
    return isPortFileAclSafeWindows(portFilePath)
  }
  const mode = fs.statSync(portFilePath).mode & 0o777
  return (mode & 0o077) === 0
}

/**
 * Windows 下 best-effort 校验端口文件 ACL 不含广域 principal（B3）。
 *
 * 限制：built-in 组名（Users / Everyone 等）在非英文 Windows 上会被本地化，
 * 本扫描可能漏判（false-accept），但绝不会误拒（false-reject）——
 * 写入侧 hardenPortFilePermissionsWindows 是硬保证。
 * 任何 icacls 调用异常都视为通过（graceful），不阻塞发现流程。
 */
function isPortFileAclSafeWindows(portFilePath: string): boolean {
  try {
    const output = execSync(`icacls "${portFilePath}"`, { encoding: 'utf-8', timeout: 5000 })
    // 命中任一广域 principal 即视为不安全（SYSTEM/Administrators 当前用户不在此列）
    const broadPrincipals = [
      'Everyone',
      'Authenticated Users',
      'BUILTIN\\Users',
      'BUILTIN\\Power Users',
      'Guest',
      'ANONYMOUS LOGON'
    ]
    return !broadPrincipals.some(p => output.includes(p))
  } catch {
    // icacls 不可用或失败：不阻塞，写入侧 hardening 仍生效
    return true
  }
}

function getUserDataDir(): string | null {
  // 优先使用环境变量（由 MCP 配置注入）
  const envDir = process.env.LYSHELL_USER_DATA
  if (envDir) return envDir

  // 回退到平台默认路径
  const platform = process.platform
  const homeDir = process.env.USERPROFILE || process.env.HOME
  if (!homeDir) return null

  if (platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'LyShell')
  } else if (platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Application Support', 'LyShell')
  } else {
    return path.join(homeDir, '.config', 'LyShell')
  }
}

/**
 * 检查进程是否在运行
 * Windows 上 process.kill(pid, 0) 行为与 POSIX 不同，
 * 改用 tasklist (Windows) 或 kill -0 (POSIX) 来可靠检测
 */
function isProcessRunning(pid: number): boolean {
  try {
    if (process.platform === 'win32') {
      // Windows: 使用 tasklist 命令检查进程
      const output = execSync(`tasklist /NH /FI "PID eq ${pid}"`, { encoding: 'utf-8', timeout: 5000 })
      return output.includes(String(pid))
    }
    // POSIX: 向进程发送信号0（不实际杀死，只检查是否存在）
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * LyShell HTTP API 客户端
 */
export class LyShellHttpClient {
  private port: number
  private token: string

  constructor(port: number, token: string) {
    this.port = port
    this.token = token
  }

  /**
   * 健康检查
   */
  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.get('/api/health')
      return result.success === true
    } catch {
      return false
    }
  }

  /**
   * GET 请求
   */
  async get(apiPath: string): Promise<any> {
    return this.request('GET', apiPath)
  }

  /**
   * POST 请求
   * 文件操作（download/upload）使用较长超时
   * send_and_wait 等待响应可能耗时较长，使用 60s 超时
   * 其他操作使用较短超时
   */
  async post(apiPath: string, body?: any): Promise<any> {
    const isFileTransfer = apiPath.includes('/files/download') || apiPath.includes('/files/upload')
    // send_and_wait / wait_for_prompt 都可能等待较久（长命令、慢 prompt），统一 60s；
    // wait_for_prompt 若走默认 30s 档，等待 >30s 会被客户端先超时。
    const isLongWait = apiPath.includes('/send-and-wait') || apiPath.includes('/wait-for-prompt')
    // 文件传输含 SFTP 传输 + 同步 MD5 校验，大文件易超 120s；放宽到 600s（异步任务化前的过渡方案）。
    const timeout = isFileTransfer ? 600000 : isLongWait ? 60000 : 30000
    return this.request('POST', apiPath, body, timeout)
  }

  /**
   * 流式 POST：消费 SSE 事件（execute_command stream 模式）。
   *
   * 每个 `data: {...}` 事件解析后回调 onEvent（chunk 事件）；
   * done 事件 resolve { output, exitCode }，error 事件 reject。
   * 非 200 响应（鉴权失败等）累积 body 后 reject。
   * 超时略大于服务端 MAX_COMMAND_TIMEOUT_MS，避免客户端先超时。
   */
  async postStream(
    apiPath: string,
    body: any,
    onEvent: (evt: { type: string; chunk?: string; output?: string; exitCode?: number; error?: string }) => void
  ): Promise<{ output: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const options: http.RequestOptions = {
        hostname: '127.0.0.1',
        port: this.port,
        path: apiPath,
        method: 'POST',
        headers: {
          'X-LyShell-Token': this.token,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream'
        },
        timeout: 130000
      }

      const req = http.request(options, (res) => {
        if (res.statusCode !== 200) {
          let data = ''
          res.on('data', (c: Buffer) => { data += c.toString() })
          res.on('end', () => {
            let msg = data
            try { const j = JSON.parse(data); msg = j.error || data } catch { /* 非 JSON */ }
            reject(new Error(msg || `HTTP ${res.statusCode}`))
          })
          return
        }

        let buffer = ''
        let resolved = false

        const handleEvent = (raw: string) => {
          const line = raw.trim()
          if (!line.startsWith('data:')) return
          const payload = line.slice(5).trim()
          if (!payload) return
          let evt: any
          try { evt = JSON.parse(payload) } catch { return }
          if (evt.type === 'done' && !resolved) {
            resolved = true
            resolve({ output: evt.output ?? '', exitCode: evt.exitCode ?? 0 })
          } else if (evt.type === 'error' && !resolved) {
            resolved = true
            reject(new Error(evt.error || 'Stream error'))
          } else if (evt.type === 'chunk') {
            onEvent(evt)
          }
        }

        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString().replace(/\r\n/g, '\n')
          let idx: number
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const raw = buffer.slice(0, idx)
            buffer = buffer.slice(idx + 2)
            handleEvent(raw)
          }
        })
        res.on('end', () => {
          if (!resolved) {
            if (buffer.trim()) handleEvent(buffer)
            if (!resolved) reject(new Error('Stream ended without done event'))
          }
        })
        res.on('error', (err) => {
          if (!resolved) { resolved = true; reject(new Error(`Stream error: ${err.message}`)) }
        })
      })

      req.on('error', (err) => reject(new Error(`HTTP request failed: ${err.message}`)))
      req.on('timeout', () => { req.destroy(); reject(new Error('HTTP stream request timeout')) })

      if (body !== undefined) req.write(JSON.stringify(body))
      req.end()
    })
  }

  /**
   * 发送 HTTP 请求
   */
  private request(method: string, apiPath: string, body?: any, timeout: number = 30000): Promise<any> {
    return new Promise((resolve, reject) => {
      const options: http.RequestOptions = {
        hostname: '127.0.0.1',
        port: this.port,
        path: apiPath,
        method,
        headers: {
          'X-LyShell-Token': this.token,
          'Content-Type': 'application/json'
        },
        timeout
      }

      const req = http.request(options, (res) => {
        let data = ''
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString()
        })
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data)
            if (parsed.success) {
              resolve(parsed)
            } else {
              reject(new Error(parsed.error || 'Unknown error'))
            }
          } catch {
            reject(new Error(`Invalid JSON response: ${data.substring(0, 200)}`))
          }
        })
      })

      req.on('error', (err) => {
        reject(new Error(`HTTP request failed: ${err.message}`))
      })

      req.on('timeout', () => {
        req.destroy()
        reject(new Error('HTTP request timeout'))
      })

      if (body !== undefined) {
        req.write(JSON.stringify(body))
      }

      req.end()
    })
  }
}