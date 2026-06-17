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
 * 读取端口文件，获取 LyShell HTTP API 的连接信息
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
 * 获取 LyShell 用户数据目录
 */
function isValidPortInfo(info: McpPortInfo): boolean {
  return Number.isInteger(info.port) &&
    info.port > 0 &&
    info.port <= 65535 &&
    Number.isInteger(info.pid) &&
    info.pid > 0 &&
    info.version === 1 &&
    typeof info.token === 'string' &&
    /^[a-f0-9]{64}$/i.test(info.token)
}

function isPortFilePermissionSafe(portFilePath: string): boolean {
  if (process.platform === 'win32') return true
  const mode = fs.statSync(portFilePath).mode & 0o777
  return (mode & 0o077) === 0
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
    const isLongWait = apiPath.includes('/send-and-wait')
    const timeout = isFileTransfer ? 120000 : isLongWait ? 60000 : 30000
    return this.request('POST', apiPath, body, timeout)
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