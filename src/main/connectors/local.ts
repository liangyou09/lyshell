import { spawn, IPty } from 'node-pty'
import log from 'electron-log'
import { existsSync } from 'fs'
import { delimiter, join } from 'path'
import { BaseConnector } from './base'
import { readSystemPath } from '../env/refresh'

/**
 * 本地终端配置
 */
export interface LocalConfig {
  shell?: string
  cwd?: string
  env?: Record<string, string>
  encoding?: 'utf-8' | 'gbk' | 'gb2312'
}

/**
 * 定位 PowerShell 7（pwsh）的完整可执行路径，未安装返回 null。
 * agent / harness 启动（spawnLocalCommandSession）的默认 shell 首选 pwsh ——
 * 命中则显式传 shell，未命中留 undefined 走 getDefaultShell（Windows: COMSPEC/cmd，
 * POSIX: $SHELL），即「有 ps7 用 ps7，没有按现状」；用户自建的本地会话不受影响。
 * 先扫传入 PATH（覆盖自定义安装位置与 WindowsApps 执行别名），再兜底常规安装位置
 * （MSI 的 Program Files、Store 的 WindowsApps —— PATH 被改坏时仍能找到）。
 * 纯文件系统探测、不 spawn 子进程，与 harness/detect.ts 的纪律一致。
 */
export function findPwshPath(path: string = process.env.PATH || ''): string | null {
  if (process.platform !== 'win32') return null
  const dirs = (path || '').split(delimiter).filter(Boolean)
  for (const dir of dirs) {
    const candidate = join(dir, 'pwsh.exe')
    if (existsSync(candidate)) return candidate
  }
  const fallbacks = [
    join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'pwsh.exe') : null
  ]
  for (const candidate of fallbacks) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return null
}

/**
 * 本地终端连接器
 * 使用 node-pty 启动本地 shell 进程
 */
export class LocalConnector extends BaseConnector {
  private config: LocalConfig
  /**
   * 由调用方注入、不持久化到用户配置的额外环境变量。
   * 用于 MCP per-session token 等会话生命周期内有效的运行时变量。
   * 优先级高于 config.env，避免被持久化配置遮蔽。
   */
  private extraEnv: Record<string, string>
  private ptyProcess: IPty | null = null
  private _cols: number = 80
  private _rows: number = 24

  constructor(sessionId: string, config: LocalConfig, extraEnv: Record<string, string> = {}) {
    super(sessionId)
    this.config = config
    this.extraEnv = extraEnv
  }

  /**
   * 连接（启动本地 PTY 进程）
   */
  async connect(config?: LocalConfig): Promise<void> {
    if (config) {
      this.config = config
    }

    const shell = this.resolveShell(this.config.shell || this.getDefaultShell())
    log.info(`Local terminal spawning: ${shell}`)

    // 即时读取系统 PATH 注入子进程（用户改环境变量后无需重启 app 生效）。
    // 优先级：即时系统 PATH < config.env < extraEnv（工作区/env 显式覆盖仍生效）。
    const systemPath = readSystemPath()

    this.ptyProcess = spawn(shell, [], {
      name: 'xterm-256color',
      cols: this._cols,
      rows: this._rows,
      cwd: this.config.cwd || process.env.USERPROFILE || process.env.HOME,
      env: {
        ...process.env,
        ...(systemPath ? { PATH: systemPath } : {}),
        ...this.config.env,
        ...this.extraEnv
      } as Record<string, string>
    })

    this.ptyProcess.onData((data: string) => {
      this.emitData(data)
    })

    this.ptyProcess.onExit(({ exitCode }) => {
      log.info(`Local terminal exited: code ${exitCode}`)
      this.connected = false
      this.emitClose()
    })

    // node-pty 底层是 net.Socket；进程被 kill 或子进程崩溃时 pipe 断裂会触发 'error'。
    // 没有监听器时 'error' 会变成未捕获异常，导致主进程崩溃（Windows 上尤为明显）。
    // 这里吞掉 EPIPE/EOF/ECONNRESET 等 teardown 噪音，其余仅记录。
    const ptyWithOn = this.ptyProcess as unknown as { on?: (ev: string, cb: (e: Error) => void) => void }
    if (typeof ptyWithOn.on === 'function') {
      ptyWithOn.on('error', (err: Error) => {
        const msg = err?.message || String(err)
        if (msg.includes('EPIPE') || msg.includes('EOF') || msg.includes('ECONNRESET') || msg.includes('ECONNABORTED')) {
          log.debug(`Local PTY teardown error ignored for ${this.sessionId}: ${msg}`)
          return
        }
        log.warn(`Local PTY error for ${this.sessionId}:`, err)
      })
    }

    this.connected = true
  }

  /**
   * 断开连接（杀死 PTY 进程）
   */
  async disconnect(): Promise<void> {
    const pty = this.ptyProcess
    if (pty) {
      this.ptyProcess = null
      this.connected = false
      try {
        pty.kill()
      } catch (error) {
        // 进程可能已经退出或句柄已失效，忽略
        log.warn(`Failed to kill local PTY ${this.sessionId}:`, error)
      }
    } else {
      this.connected = false
    }
  }

  /**
   * 写入数据
   */
  write(data: string | Buffer): void {
    if (!this.ptyProcess) {
      log.warn('Local PTY not available')
      return
    }
    this.ptyProcess.write(typeof data === 'string' ? data : data.toString())
  }

  /**
   * 调整终端尺寸
   */
  resize(cols: number, rows: number): void {
    this._cols = cols
    this._rows = rows
    if (this.ptyProcess) {
      this.ptyProcess.resize(cols, rows)
    }
  }

  /**
   * 获取默认 shell
   */
  private getDefaultShell(): string {
    if (process.platform === 'win32') {
      return process.env.COMSPEC || 'cmd.exe'
    }
    return process.env.SHELL || '/bin/bash'
  }

  /**
   * 解析 shell 名称为完整路径
   */
  private resolveShell(shell: string): string {
    if (process.platform !== 'win32') return shell
    // Windows: 解析简称
    const lower = shell.toLowerCase()
    if (lower === 'powershell') {
      return 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    }
    if (lower === 'pwsh') {
      return 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
    }
    return shell
  }
}
