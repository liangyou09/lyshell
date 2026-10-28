import { spawn, IPty } from 'node-pty'
import log from 'electron-log'
import { existsSync } from 'fs'
import { delimiter, join } from 'path'
import { BaseConnector } from './base'
import { readSystemPath } from '../env/refresh'
import { safeStorage } from 'electron'
import { LocalHostClient } from '../terminal/local-host-client'
import type { LocalConfig, TerminalEncoding } from '@shared/types'

/**
 * 本地终端配置 —— 复用 @shared/types 的 LocalConfig（单一真相源）。
 * 本文件历史上有份本地副本（多一个 encoding 字段），但 connector 从不读它、
 * 唯一调用方 session-manager 传的也是 shared 形状，纯属双处定义漂移；
 * 统一后新增字段（如 shellArgs）不必两处同步。
 */
export type { LocalConfig }

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

/** 资源管理器启动的交互终端：优先 PowerShell 7，未安装回落 Windows PowerShell。 */
export function findExplorerShell(path: string = process.env.PATH || ''): string {
  return findPwshPath(path) ?? join(
    process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
  )
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
  private outputPaused = false
  private connectGeneration = 0
  private host: LocalHostClient | null = null
  private hostExited = false
  private hostDisconnecting: Promise<void> | null = null

  constructor(sessionId: string, config: LocalConfig, extraEnv: Record<string, string> = {}, private readonly runtime: { userDataDir?: string } = {}) {
    super(sessionId)
    this.config = { ...config }
    this.extraEnv = extraEnv
  }

  get localHostId(): string | undefined { return this.host?.id ?? this.config.terminalHostId }
  /** 只有真实 exit/terminate 证据才允许后续普通重连新建 shell；失联保持未知。 */
  get localHostHasExited(): boolean { return this.hostExited }
  async retainForShelf(retained: boolean): Promise<void> {
    if (!this.host) { if (retained) throw new Error('这个终端未由独立宿主持有，无法保留后台终端。请在新版中新建终端。'); return }
    await this.host.retain(retained)
  }
  /** 应用退出时结束原进程，收纳标记不再允许终端跨退出保活。 */
  async disconnectForQuit(): Promise<void> {
    const released = this.host?.retain(false).catch(error => log.warn(`Failed to release local host retention for ${this.sessionId}:`, error))
    // 两帧按管道顺序发送；撤销保活迟迟没有回执，也不能阻止发送终止。
    await Promise.all([released, this.disconnect()])
  }

  /**
   * 运行时切换编码的空实现：local 走 ConPTY 恒为 UTF-8，无编码层可切
   * （见 BaseConnector.setEncoding；SessionManager 对 LOCAL 会话直接拒绝，这里仅兜底）。
   */
  setEncoding(_encoding: TerminalEncoding): void {
    // 无操作
  }

  /**
   * 连接（启动本地 PTY 进程）
   */
  async connect(config?: LocalConfig): Promise<void> {
    const generation = ++this.connectGeneration
    if (config) {
      this.config = { ...config }
    }

    const shell = this.resolveShell(this.config.shell || this.getDefaultShell())
    log.info(`Local terminal spawning: ${shell}`)

    // 即时读取系统 PATH 注入子进程（用户改环境变量后无需重启 app 生效）。
    // 优先级：即时系统 PATH < config.env < extraEnv（工作区/env 显式覆盖仍生效）。
    const systemPath = await readSystemPath()
    if (generation !== this.connectGeneration) throw new Error('Local connection cancelled')

    if (this.runtime.userDataDir && (this.config.terminalHostId || safeStorage?.isEncryptionAvailable?.())) {
      const options = { shell, args: this.config.shellArgs ?? [], cwd: this.getSpawnCwd() ?? undefined, cols: this._cols, rows: this._rows,
        env: { ...process.env, POWERSHELL_UPDATECHECK: process.env.POWERSHELL_UPDATECHECK ?? 'Off', ...(systemPath ? { PATH: systemPath } : {}), ...this.config.env, ...this.extraEnv } as Record<string, string> }
      const attaching = !!this.config.terminalHostId
      const host = attaching ? await LocalHostClient.attach(this.runtime.userDataDir, this.config.terminalHostId!) : await LocalHostClient.create(this.runtime.userDataDir, options)
      if (generation !== this.connectGeneration) {
        // 恢复取消只解除本次附着，不能终止已经收纳的原进程。
        if (attaching) await host.detach()
        else await host.terminate()
        throw new Error('Local connection cancelled')
      }
      this.host = host
      this.hostExited = false
      this.config.terminalHostId = host.id
      host.on('data', (data: string) => { if (this.host === host) this.emitData(data) })
      host.on('gap', () => { if (this.host === host) this.emitData('\r\n[LyShell: 较早输出已超出保留范围，以下为最近输出。]\r\n') })
      host.on('exit', () => { if (this.host !== host) return; this.hostExited = true; this.connected = false; this.emitClose() })
      host.on('error', (error: Error) => { if (this.host === host && this.listenerCount('error')) this.emitError(error) })
      host.on('disconnect', () => { if (this.host !== host) return; this.host = null; this.connected = false; this.emitClose() })
      let status
      try { status = await host.status() }
      catch (error) { this.host = null; await host.detach(); throw error }
      if (generation !== this.connectGeneration || this.host !== host) {
        await host.detach()
        throw new Error('Local connection cancelled')
      }
      if (!status.running) { this.hostExited = true; await host.detach(); this.host = null; throw new Error('原本地终端进程已经结束') }
      // bootstrap / attach 是异步的，期间 resize 只能更新本地字段，须补到真实 PTY。
      // 附着时原宿主尺寸未知，交由宿主按实际尺寸去重，避免同尺寸重排整屏。
      if (attaching || options.cols !== this._cols || options.rows !== this._rows) host.resize(this._cols, this._rows)
      if (this.outputPaused) host.pause()
      this.connected = true
      return
    }

    this.ptyProcess = spawn(shell, this.config.shellArgs ?? [], {
      name: 'xterm-256color',
      cols: this._cols,
      rows: this._rows,
      cwd: this.getSpawnCwd() ?? undefined,
      env: {
        ...process.env,
        // PowerShell 7.6.6 的本地化更新通知可能向 PadRight 传入负数并终止进程。
        // 在启动前默认禁用通知（包含从 cmd/bash 再启动的 pwsh），显式环境配置仍可覆盖。
        POWERSHELL_UPDATECHECK: process.env.POWERSHELL_UPDATECHECK ?? 'Off',
        ...(systemPath ? { PATH: systemPath } : {}),
        ...this.config.env,
        ...this.extraEnv
      } as Record<string, string>
    })

    this.ptyProcess.onData((data: string) => {
      this.emitData(data)
    })
    if (this.outputPaused) this.ptyProcess.pause()

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
    if (this.hostDisconnecting) return this.hostDisconnecting
    this.connectGeneration++
    if (this.host) {
      const host = this.host
      const pending = host.terminate().then(() => { this.hostExited = true; if (this.host === host) this.host = null; this.connected = false }).finally(() => { this.hostDisconnecting = null })
      this.hostDisconnecting = pending
      return pending
    }
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
    if (this.host) { this.host.write(typeof data === 'string' ? data : data.toString()); return }
    if (!this.ptyProcess) {
      log.warn('Local PTY not available')
      return
    }
    this.ptyProcess.write(typeof data === 'string' ? data : data.toString())
  }

  setOutputPaused(paused: boolean): void {
    if (this.outputPaused === paused) return
    this.outputPaused = paused
    if (this.host) { if (paused) this.host.pause(); else this.host.resume(); return }
    if (paused) this.ptyProcess?.pause()
    else this.ptyProcess?.resume()
  }

  /**
   * 调整终端尺寸
   */
  resize(cols: number, rows: number): void {
    // 净零 resize 直接跳过:ConPTY 每次 resize 都会整屏重印,与 raw-mode TUI
    // (Claude Code/Ink)自身的 SIGWINCH 重绘互相踩踏 —— 字号 +5 再 -5 往返后
    // TUI 画面被挤压错位的根源。同尺寸重设没有任何收益,不打扰 PTY。
    if (this._cols === cols && this._rows === rows) {
      return
    }
    this._cols = cols
    this._rows = rows
    if (this.host) { this.host.resize(cols, rows); return }
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
   * 本次连接实际 spawn 的工作目录(config.cwd 缺省回落用户主目录)。
   * 读 this.config 实时值而非构造时快照:connect(config) 传新配置会整体替换
   * this.config,连接后调用读到的即是本次连接的 cwd —— 种子取值须在
   * connect 之后(session-manager 的 cwdTracker 初始落位即此约定)。
   * 工作目录报告的种子值 —— cmd 等不发 OSC 目录序列的 shell,
   * 页签悬停详情卡始终显示这个值。
   */
  getSpawnCwd(): string | null {
    return this.config.cwd || process.env.USERPROFILE || process.env.HOME || null
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
      // 简称解析与 findPwshPath 同口径：先探测（PATH/WindowsApps 别名/常规位置，
      // Store 版或自定义安装也能解析到），探测不到才回落硬编码默认安装路径
      return findPwshPath() ?? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
    }
    return shell
  }
}
