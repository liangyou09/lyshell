import { spawn, IPty } from 'node-pty'
import log from 'electron-log'
import { BaseConnector } from './base'

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
 * 本地终端连接器
 * 使用 node-pty 启动本地 shell 进程
 */
export class LocalConnector extends BaseConnector {
  private config: LocalConfig
  private ptyProcess: IPty | null = null
  private _cols: number = 80
  private _rows: number = 24

  constructor(sessionId: string, config: LocalConfig) {
    super(sessionId)
    this.config = config
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

    this.ptyProcess = spawn(shell, [], {
      name: 'xterm-256color',
      cols: this._cols,
      rows: this._rows,
      cwd: this.config.cwd || process.env.USERPROFILE || process.env.HOME,
      env: { ...process.env, ...this.config.env } as Record<string, string>
    })

    this.ptyProcess.onData((data: string) => {
      this.emitData(data)
    })

    this.ptyProcess.onExit(({ exitCode }) => {
      log.info(`Local terminal exited: code ${exitCode}`)
      this.connected = false
      this.emitClose()
    })

    this.connected = true
  }

  /**
   * 断开连接（杀死 PTY 进程）
   */
  async disconnect(): Promise<void> {
    if (this.ptyProcess) {
      this.ptyProcess.kill()
      this.ptyProcess = null
    }
    this.connected = false
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
