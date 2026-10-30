import { Client, ClientChannel } from 'ssh2'
import type { ConnectConfig } from 'ssh2'
import log from 'electron-log'
import { BaseConnector } from './base'
import type { TerminalEncoding } from '@shared/types'
import { buildSshDirectoryCommand } from '../terminal/shelf-ssh-context'
import {
  buildTmuxAttachCommand,
  buildTmuxEnsureSessionCommand,
  buildTmuxKillSessionCommand,
  buildTmuxProbeCommand,
  deriveRemoteSessionName,
  parseTmuxPath,
  sanitizeRemoteSessionName,
  shellQuote,
  TMUX_EXIT_SESSION_MISSING
} from './ssh-persistence'
import {
  createSsh2HostVerifier,
  isSshHostKeyError,
  SSH_HOST_KEY_CONFIRM_TIMEOUT_MS,
  SshHostKeyError,
  type Ssh2HostVerifier,
  type SshHostKeyChallenge
} from '../security/ssh-host-key'
import { authorizeSshHostKey } from '../security/ssh-trust'

export type { SshHostKeyChallenge }

/**
 * SSH 配置
 */
export interface SSHConfig {
  host: string
  port: number
  username: string
  password?: string
  privateKey?: string
  passphrase?: string
  keepaliveInterval?: number
  readyTimeout?: number
  encoding?: TerminalEncoding
  /** 可续接终端：交互 shell 在远端 tmux 里运行，断线后能附着回原会话。 */
  keepSessionAlive?: boolean
  /** 仅运行期注入：要附着回来的原 tmux 会话名（保存区恢复用，普通编辑不暴露）。 */
  resumeSessionName?: string
  resumeDirectory?: string
}

/**
 * SSH 终端连接器运行期选项（第三个构造参数）。
 *
 * `confirmHostKey` 只能由可信 GUI 建连路径注入：它是「弹给用户看并等用户点确认」的
 * 能力，绝不能来自会话配置、外部 HTTP/MCP 请求或插件自报。
 * 缺省（不传）时未知或变化的主机密钥一律拒绝 —— 自动化通道不会因此变成「首次即信任」。
 */
export interface SSHConnectorRuntimeOptions {
  confirmHostKey?: (challenge: SshHostKeyChallenge) => Promise<boolean>
}

/** 托管 shell 建立后观察窗口：窗口内通道就关闭说明 tmux 立刻退出，不能当连接成功。 */
const MANAGED_SHELL_SETTLE_MS = 300
/** 探测 tmux 的远端命令超时。 */
const TMUX_PROBE_TIMEOUT_MS = 5000
/** 准备（检查/创建）远端会话的命令超时。 */
const TMUX_ENSURE_TIMEOUT_MS = 5000
/** 清理远端会话的命令超时：显式断开时不能因为远端卡住而挂死退出流程。 */
const TMUX_KILL_TIMEOUT_MS = 3000

/** 保留最近若干字符的远端输出，仅用于失败诊断。 */
function tailText(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max)
}

/**
 * SSH 连接器
 */
export class SSHConnector extends BaseConnector {
  get capabilities() {
    return { interactiveInput: true, resize: true, exec: true, fileTransfer: true, pauseOutput: true, reattach: false }
  }
  /** transport 由所有存活 channel 共同持有，最后一个释放时关闭。 */
  private static clientOwners = new WeakMap<Client, Set<SSHConnector>>()
  private config: SSHConfig
  private client: Client | null = null
  private channel: ClientChannel | null = null
  private sharedClient: Client | null = null  // 共享的 SSH client
  private _connecting: boolean = false  // 是否正在连接中
  private _connectReject: ((error: Error) => void) | null = null  // 连接 Promise 的 reject 函数
  private _cols: number = 80  // 终端列数
  private _rows: number = 24  // 终端行数
  private outputPaused = false
  private clientListenerCleanup: Array<() => void> = []
  /**
   * 已被保存区收纳的远端会话名（进程内）。重连会新建 connector，保留标记必须
   * 跟着名字走，否则「收纳过的会话重连后再关闭」会误杀远端程序。
   */
  private static retainedSessionNames = new Set<string>()
  /** 当前托管的远端 tmux 会话名（断开后仍保留最后已知值，供保存区读取）。 */
  private remoteName: string | null = null
  /** 远端 tmux 绝对路径（清理时需要）。 */
  private remoteTmuxPath: string | null = null
  /** 本次连接是否拥有该远端会话（恢复/附着别人的会话时为 false，绝不 kill）。 */
  private remoteOwned = false
  /** 用户或保存区声明延长远端保留。 */
  private retained = false
  /** 托管 shell 的建立 Promise（connect 在托管模式下要等它）。 */
  private managedShellReady: Promise<void> | null = null
  /** transport 已断开：此时不能再发清理命令。 */
  private linkLost = false
  /** 运行期选项（主机密钥人工确认只能从这里来）。 */
  private readonly runtimeOptions: SSHConnectorRuntimeOptions
  /** 主机密钥校验期次：每次 connect 递增，disconnect/关闭后旧期次的确认作废。 */
  private hostKeyAttempt = 0
  /** 本次连接是否仍在等待/允许主机密钥校验推进。 */
  private hostKeyActive = false
  /** 主机密钥拒绝的明确原因（ssh2 只报「Host denied」，要换成带 code 的错误）。 */
  private hostKeyFailure: SshHostKeyError | null = null

  constructor(sessionId: string, config: SSHConfig, runtimeOptions: SSHConnectorRuntimeOptions = {}) {
    super(sessionId, config.encoding)
    this.config = config
    this.runtimeOptions = runtimeOptions
  }

  /**
   * 握手 readyTimeout：带人工确认时放宽到覆盖确认窗口，
   * 否则用户在确认框前犹豫 30 秒就会被默认超时打断（确认完也回不来）。
   */
  private connectionReadyTimeout(hasHostKeyConfirm: boolean): number {
    const configured = this.config.readyTimeout || 30000
    return hasHostKeyConfirm ? Math.max(configured, SSH_HOST_KEY_CONFIRM_TIMEOUT_MS + 5000) : configured
  }

  /** 取出并清空本次连接的主机密钥失败原因 */
  private consumeHostKeyFailure(): SshHostKeyError | null {
    const failure = this.hostKeyFailure
    this.hostKeyFailure = null
    return failure
  }

  /** 是否启用远端可续接终端（用户开关，或运行期注入了恢复名）。 */
  isManagedRemoteSession(): boolean {
    return this.config.keepSessionAlive === true || typeof this.config.resumeSessionName === 'string'
  }

  /** 远端 tmux 会话名：托管模式建立后可用，断开后保留最后已知值。 */
  get remoteSessionName(): string | undefined {
    return this.remoteName ?? undefined
  }

  /**
   * 标记远端会话已被收纳：之后断开只 detach，不销毁远端程序。
   * 这是保留语义（保存区成功收纳），不是权限审批。
   */
  setSessionRetained(retained: boolean): void {
    this.retained = retained
    if (this.remoteName) {
      if (retained) SSHConnector.retainedSessionNames.add(this.remoteName)
      else SSHConnector.retainedSessionNames.delete(this.remoteName)
    }
  }

  /**
   * 设置共享的 SSH client（用于克隆渠道）
   */
  setSharedClient(client: Client): void {
    this.sharedClient = client
    this.retainClient(client)
    this.connected = true
  }

  private retainClient(client: Client): void {
    this.client = client
    let owners = SSHConnector.clientOwners.get(client)
    if (!owners) {
      SSHConnector.clientOwners.set(client, owners = new Set())
      // 最后一个 channel 释放后直到 TCP 完全关闭的窗口也要有 error 监听。
      const teardownError = (error: Error) => {
        log.debug('SSH transport error:', error.message)
        for (const owner of SSHConnector.clientOwners.get(client) ?? []) {
          if (owner.sharedClient === client) owner.emitError(error)
        }
      }
      client.on('error', teardownError)
      client.once('close', () => {
        for (const owner of [...(SSHConnector.clientOwners.get(client) ?? [])]) owner.handleTransportClose(client)
        client.off('error', teardownError)
      })
    }
    owners.add(this)
  }

  private releaseClient(): void {
    const client = this.client
    this.client = null
    this.sharedClient = null
    for (const cleanup of this.clientListenerCleanup.splice(0)) cleanup()
    if (!client) return
    const owners = SSHConnector.clientOwners.get(client)
    owners?.delete(this)
    if (!owners?.size) {
      SSHConnector.clientOwners.delete(client)
      client.end()
    }
  }

  private handleTransportClose(client: Client): void {
    if (this.client !== client) return
    // 链路已被对端断开：此时发清理命令必然失败（或挂到超时），标记后跳过 kill。
    this.linkLost = true
    const reject = this._connectReject
    this._connectReject = null
    this._connecting = false
    reject?.(new Error('Connection closed'))
    void this.disconnect()
    this.emitClose()
  }

  private handleShellClose(channel: ClientChannel): void {
    if (this.channel !== channel) return
    this.channel = null
    // 普通和克隆渠道都进入同一回收路径；共享 transport 的其他渠道不受影响。
    void this.disconnect()
    this.emitClose()
  }

  setOutputPaused(paused: boolean): void {
    this.outputPaused = paused
    if (paused) this.channel?.pause()
    else this.channel?.resume()
  }

  /**
   * 获取 SSH client（用于克隆）
   */
  getClient(): Client | null {
    return this.client
  }

  /**
   * 只启动 shell（用于克隆渠道，不建立新连接）
   */
  async startShellOnly(): Promise<void> {
    const client = this.sharedClient || this.client
    if (!client) {
      throw new Error('SSH client not available')
    }

    // 克隆渠道也走托管：每个克隆是独立终端，用自己 runtime id 派生的新会话名。
    // 克隆不是恢复 —— 明确忽略 resumeSessionName，不能两个终端抢同一个 tmux 会话。
    if (this.isManagedRemoteSession()) {
      this.replaceDecoder()
      await this.startManagedShell(client, true)
      return
    }

    // 传入终端窗口尺寸，避免默认 80x24(空窗期补发同 startShell)
    const reqCols = this._cols || 80
    const reqRows = this._rows || 24
    const windowOpts = { rows: reqRows, cols: reqCols }

    return new Promise((resolve, reject) => {
      client.shell({ term: 'xterm-256color', ...windowOpts }, (err, channel) => {
        if (err) {
          log.error('SSH shell error:', err)
          reject(err)
          return
        }

        if (this.client !== client) {
          channel.close()
          reject(new Error('SSH shell creation cancelled'))
          return
        }

        this.channel = channel
        if (this.outputPaused) channel.pause()

        // 空窗期补偿(同 startShell):await startShellOnly() 期间到达的 resize
        // 只改写了 _cols/_rows 而没发 setWindow,这里按最新存储值补发。
        if (this._cols !== reqCols || this._rows !== reqRows) {
          channel.setWindow(this._rows || 24, this._cols || 80, this._rows || 24, this._cols || 80)
        }

        this.connected = true

        // 共享 client 复用路径上也需要独立的解码器
        this.replaceDecoder()

        // 接收数据（写入流式解码器，避免多字节字符被拆包截断）
        channel.on('data', (data: Buffer) => {
          this.decoder?.write(data)
        })

        // Shell 关闭
        channel.on('close', () => {
          log.info('SSH shell closed')
          this.handleShellClose(channel)
        })

        log.info('SSH shell started (clone channel)')
        resolve()
      })
    })
  }

  /**
   * 连接到 SSH 服务器
   */
  async connect(config?: SSHConfig): Promise<void> {
    if (config) {
      this.config = config
      this.encoding = config.encoding || 'utf-8'
    }

    // 恢复名来自运行期注入（保存区），拼进远端命令前必须先过白名单：
    // 非法就在这里 reject，连 transport 都不建立，避免「连上了才发现名字有毒」。
    if (typeof this.config.resumeSessionName === 'string' && this.config.resumeSessionName.trim()) {
      const safe = sanitizeRemoteSessionName(this.config.resumeSessionName)
      if (!safe) {
        throw new Error(`远端会话名不合法，拒绝恢复：${this.config.resumeSessionName.slice(0, 80)}`)
      }
      this.config = { ...this.config, resumeSessionName: safe }
    }

    this.linkLost = false
    this.managedShellReady = null

    log.info(`SSH connecting to ${this.config.host}:${this.config.port}`)

    const client = new Client()
    this.retainClient(client)
    this._connecting = true

    // 主机密钥校验绑定「本次 connect 的实例 + 期次」：disconnect/关闭后 isActive 变为
    // false，晚到的确认既不会被保存，也不能用来推进已经放弃的握手。
    const hostKeyAttempt = ++this.hostKeyAttempt
    this.hostKeyActive = true
    this.hostKeyFailure = null
    const hostKeyStillActive = (): boolean =>
      this.hostKeyActive && this.hostKeyAttempt === hostKeyAttempt && this.client === client

    const onReady = () => {
      if (this.client !== client) return
      log.info('SSH connection ready')
      this._connecting = false
      this._connectReject = null
      this.connected = true
      this.emit('connected')

      // 每个连接单独一个流式解码器
      this.replaceDecoder()

      // 启动 shell：托管模式先在远端把 tmux 会话准备好，connect 会等它完成。
      if (this.isManagedRemoteSession()) {
        this.managedShellReady = this.startManagedShell(client)
        // connect() 之外的调用方（如克隆渠道）不会 await 它，这里兜住拒绝避免 unhandled。
        this.managedShellReady.catch(() => {})
      } else {
        this.startShell()
      }
    }

    const onError = (err: Error) => {
      if (this.client !== client) return
      // 主机密钥拒绝必须把明确原因（code + 指纹）交给调用方：ssh2 自己只报
      // 「Host denied (verification failed)」，界面无法据此提示「密钥变了」。
      const hostKeyFailure = this.consumeHostKeyFailure()
      const surfaced: Error = hostKeyFailure ?? err
      // 提取关键错误信息（去掉堆栈）
      const errMsg = surfaced.message?.split('\n')[0]?.replace(/^Error:\s*/, '') || surfaced.toString()
      log.error(`SSH connection error${hostKeyFailure ? ` [${hostKeyFailure.code}]` : ''}: ${errMsg}`)
      this._connectReject?.(surfaced)
      this._connecting = false
      this._connectReject = null
      this.connected = false
      this.emitError(surfaced)
    }

    const onClose = () => {
      log.info('SSH connection closed')
      this.handleTransportClose(client)
    }
    client.on('ready', onReady)
    client.on('error', onError)
    client.on('close', onClose)
    this.clientListenerCleanup.push(() => {
      client.off('ready', onReady)
      client.off('error', onError)
      client.off('close', onClose)
    })

    // 连接配置
    // 注意：这里必须显式配置 hostVerifier。ssh2 在未配置时默认**接受任何主机密钥**
    // （README R10），不校验就等于没有主机身份。
    const confirmHostKey = this.runtimeOptions.confirmHostKey
    const connectionConfig: ConnectConfig & { hostVerifier: Ssh2HostVerifier } = {
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      readyTimeout: this.connectionReadyTimeout(!!confirmHostKey), // 同 upload/download worker 的默认值，慢握手服务器(如 UseDNS 超时)10 秒不够；带确认时覆盖确认窗口
      keepaliveInterval: this.config.keepaliveInterval || 10000, // 默认 10 秒心跳
      keepaliveCountMax: 3, // 3 次心跳失败后断开
      hostVerifier: createSsh2HostVerifier({
        host: this.config.host,
        port: this.config.port,
        isActive: hostKeyStillActive,
        decide: async (key) => {
          await authorizeSshHostKey(key, this.config.host, this.config.port, {
            confirm: confirmHostKey,
            isActive: hostKeyStillActive
          })
        },
        onReject: (error) => {
          this.hostKeyFailure = isSshHostKeyError(error)
            ? error
            : new SshHostKeyError('SSH_HOST_KEY_REJECTED', `SSH 主机密钥校验失败：${error instanceof Error ? error.message : String(error)}`)
        }
      })
    }

    // 认证方式
    if (this.config.password) {
      connectionConfig.password = this.config.password
    } else if (this.config.privateKey) {
      connectionConfig.privateKey = this.config.privateKey
      if (this.config.passphrase) {
        connectionConfig.passphrase = this.config.passphrase
      }
    }

    return new Promise((resolve, reject) => {
      const ready = () => {
        client.off('ready', ready)
        this._connectReject = null
        const managedShell = this.managedShellReady
        if (!managedShell) {
          resolve()
          return
        }
        // 托管模式：tmux 会话没准备好就不算连上。启动失败的错误直接作为连接失败抛出，
        // 由调用方走统一的断线清理，UI 显示的是「连不上」而不是「已连接但终端空白」。
        managedShell.then(
          () => {
            if (this.client !== client) {
              reject(new Error('SSH shell creation cancelled'))
              return
            }
            resolve()
          },
          (error: Error) => reject(error)
        )
      }
      this._connectReject = error => { client.off('ready', ready); reject(error) }
      this.clientListenerCleanup.push(() => client.off('ready', ready))
      client.once('ready', ready)
      client.connect(connectionConfig)
    })
  }

  /**
   * 启动 Shell
   */
  private startShell(): void {
    if (!this.client) return
    const client = this.client

    // 传入终端窗口尺寸，避免默认 80x24。
    // 记下请求时的几何:shell 请求发出到 channel 回来隔一个网络往返,期间落进来的
    // resize 只会暂存 _cols/_rows、发不出 setWindow(见 resize),回调里据此补发。
    const reqCols = this._cols || 80
    const reqRows = this._rows || 24
    const windowOpts = { rows: reqRows, cols: reqCols }

    client.shell({ term: 'xterm-256color', ...windowOpts }, (err, channel) => {
      if (err) {
        log.error('SSH shell error:', err)
        this.emitError(err)
        void this.disconnect()
        this.emitClose()
        return
      }

      if (this.client !== client) { channel.close(); return }

      this.channel = channel
      if (this.outputPaused) channel.pause()

      // 空窗期补偿:channel 以请求时的 windowOpts 开启,而「connect 已 resolve、
      // channel 未就绪」期间到达的 resize 已改写 _cols/_rows。按最新存储值补发
      // setWindow,保证 channel 实际几何与 _cols/_rows 一致 —— resize() 的净零
      // 跳过才有「跳过的一定是已送达的尺寸」这一前提;不补发的话,渲染层连接后
      // 的重试阶梯(TerminalView 100/500/1000/2000ms)会被同尺寸守卫永久吞掉,
      // 远端停留 80x24、本地已 fit 到 120x40,整场会话输出错位。
      if (this._cols !== reqCols || this._rows !== reqRows) {
        channel.setWindow(this._rows || 24, this._cols || 80, this._rows || 24, this._cols || 80)
      }

      // 接收数据（写入流式解码器，避免多字节字符被拆包截断）
      channel.on('data', (data: Buffer) => {
        this.decoder?.write(data)
      })

      // Shell 关闭
      channel.on('close', () => {
        log.info('SSH shell closed')
        this.handleShellClose(channel)
      })

      // 仅新建交互通道时发送一次 cd；失败保持普通连接，不重放旧命令。
      const directoryCommand = buildSshDirectoryCommand(this.config.resumeDirectory)
      if (directoryCommand) {
        // 把 cd 放在条件列表内，避免远端启用 set -e 时因目录失效直接退出 shell。
        const guardedCommand = directoryCommand.replace(/\r$/, ' || :\r')
        try { channel.write(this.encodeOut(guardedCommand)) }
        catch { log.warn('SSH directory restore could not be sent; keeping the normal connection') }
      }

      log.info('SSH shell started')
    })
  }

  /**
   * 建立托管 shell：探测 tmux → 准备远端会话 → 带 pty 附着。
   *
   * 与普通 shell 的关键差异：connect() 会等这条链路真正可用（settle 窗口内没退出）
   * 才算连上；启动失败一律 reject，不能把「tmux 立刻退出」当连接成功。
   */
  private async startManagedShell(client: Client, ignoreResume = false): Promise<void> {
    const target = ignoreResume
      ? { name: deriveRemoteSessionName(this.sessionId), resume: false }
      : this.resolveManagedTarget()

    try {
      const tmuxPath = await this.probeTmux(client)
      if (this.client !== client) throw new Error('SSH shell creation cancelled')

      // 恢复路径只允许 attach：create=false 时 ensure 脚本里根本没有 new-session。
      const created = await this.ensureRemoteSession(client, tmuxPath, target.name, !target.resume)
      if (this.client !== client) throw new Error('SSH shell creation cancelled')

      this.remoteName = target.name
      this.remoteTmuxPath = tmuxPath
      // 恢复（附着保存区里的原会话）不归本次连接所有，断开时绝不销毁；
      // 派生名（本终端自己的会话，含上次链路留下的残留）归本终端所有。
      this.remoteOwned = created
      this.retained = this.retained || SSHConnector.retainedSessionNames.has(target.name)
      if (this.retained) SSHConnector.retainedSessionNames.add(target.name)

      await this.openManagedChannel(client, tmuxPath, target.name)
    } catch (error) {
      // 托管 shell 没起来就不算连上：connect 会 reject，这里先回退连接状态，
      // 避免调用方在错误处理里读到「已连接但终端空白」。
      this.connected = false
      if (this.listenerCount('error')) this.emitError(error as Error)
      // 启动阶段失败：本连接创建的会话顺手清掉，不留没人认领的 tmux 会话。
      if (this.remoteOwned && !this.retained && this.remoteName && this.remoteTmuxPath && this.client === client) {
        await this.killRemoteSession(client, this.remoteTmuxPath, this.remoteName)
        this.remoteOwned = false
      }
      throw error
    }
  }

  /** 解析本次要用的远端会话：有恢复名就只用它，否则按 runtime session id 派生。 */
  private resolveManagedTarget(): { name: string; resume: boolean } {
    const resumeRaw = this.config.resumeSessionName
    if (typeof resumeRaw === 'string' && resumeRaw.trim()) {
      const safe = sanitizeRemoteSessionName(resumeRaw)
      if (!safe) throw new Error(`远端会话名不合法，拒绝恢复：${resumeRaw.slice(0, 80)}`)
      return { name: safe, resume: true }
    }
    return { name: deriveRemoteSessionName(this.sessionId), resume: false }
  }

  /** 探测远端 tmux 绝对路径；没有 tmux 就明确报错，不静默退回普通 shell。 */
  private async probeTmux(client: Client): Promise<string> {
    const command = `/bin/sh -c ${shellQuote(buildTmuxProbeCommand())}`
    const result = await this.execCapture(client, command, TMUX_PROBE_TIMEOUT_MS)
    const tmuxPath = parseTmuxPath(result.stdout)
    if (!tmuxPath) {
      throw new Error(`远端主机未提供 tmux（${this.config.host}），无法开启可续接终端`)
    }
    log.info(`SSH tmux detected: ${tmuxPath}`)
    return tmuxPath
  }

  /** 检查/创建远端会话；恢复时缺失必须如实报「原现场已结束」。 */
  private async ensureRemoteSession(
    client: Client,
    tmuxPath: string,
    sessionName: string,
    create: boolean
  ): Promise<boolean> {
    const command = `/bin/sh -c ${shellQuote(buildTmuxEnsureSessionCommand({ tmuxPath, sessionName, create }))}`
    const result = await this.execCapture(client, command, TMUX_ENSURE_TIMEOUT_MS)
    if (result.code === 0) return result.stdout.trim() === 'created'

    const detail = result.stderr.trim()
    if (!create && result.code === TMUX_EXIT_SESSION_MISSING) {
      throw new Error(`原现场已结束：远端 tmux 会话 ${sessionName} 已不存在`)
    }
    if (result.code === null) {
      throw new Error(`远端 tmux 会话 ${sessionName} 状态未知（命令未返回退出码）`)
    }
    throw new Error(
      `无法${create ? '创建' : '附着'}远端 tmux 会话 ${sessionName}${detail ? `：${detail}` : ''}`
    )
  }

  /** 带 pty 附着到远端会话，并在 settle 窗口内确认 tmux 没有立刻退出。 */
  private openManagedChannel(client: Client, tmuxPath: string, sessionName: string): Promise<void> {
    const reqCols = this._cols || 80
    const reqRows = this._rows || 24
    const command = buildTmuxAttachCommand({ tmuxPath, sessionName })

    return new Promise((resolve, reject) => {
      client.exec(command, { pty: { term: 'xterm-256color', rows: reqRows, cols: reqCols } }, (err, channel) => {
        if (err) {
          reject(err)
          return
        }
        if (this.client !== client) {
          channel.close()
          reject(new Error('SSH shell creation cancelled'))
          return
        }

        this.channel = channel
        if (this.outputPaused) channel.pause()

        // 空窗期补偿：请求 attach 到通道回来之间落进来的 resize 只改了 _cols/_rows。
        if (this._cols !== reqCols || this._rows !== reqRows) {
          channel.setWindow(this._rows || 24, this._cols || 80, this._rows || 24, this._cols || 80)
        }

        let ready = false
        let failed = false
        let closed = false
        let exitCode: number | null = null
        let stdoutTail = ''
        let stderrTail = ''

        const settleTimer = setTimeout(() => {
          if (closed || failed) return
          ready = true
          this.connected = true
          log.info(`SSH tmux shell started (${sessionName})`)
          resolve()
        }, MANAGED_SHELL_SETTLE_MS)

        const fail = (reason: string): void => {
          if (failed || ready) return
          failed = true
          clearTimeout(settleTimer)
          this.channel = null
          // 通道可能还开着（'error' 早于 'close'），主动关掉，别留悬挂的 exec 通道。
          if (!closed) {
            try { channel.close() } catch { /* ignore */ }
          }
          const detail = [stderrTail.trim(), stdoutTail.trim()].filter(Boolean).join(' ').trim()
          const suffix = exitCode !== null ? `（退出码 ${exitCode}）` : ''
          reject(new Error(`${reason}${detail ? `：${detail}` : ''}${suffix}`))
        }

        // 建立阶段的输出也要落到终端：用户能直接看到 tmux 的报错原文。
        channel.on('data', (data: Buffer) => {
          stdoutTail = tailText(stdoutTail + data.toString('utf8'), 2048)
          this.decoder?.write(data)
        })
        channel.stderr?.on('data', (data: Buffer) => {
          stderrTail = tailText(stderrTail + data.toString('utf8'), 2048)
        })
        channel.on('exit', (code: number | null) => { exitCode = code ?? null })
        channel.on('error', (error: Error) => {
          if (ready) {
            this.emitError(error)
            return
          }
          fail('tmux 终端启动失败')
        })
        channel.on('close', () => {
          closed = true
          if (!ready) {
            // 建立窗口内就关闭：tmux 立刻退出（会话被别人杀掉、参数错误等），
            // 这不是「连上了」，必须当连接失败处理。
            fail('tmux 终端未就绪即退出')
            return
          }
          log.info('SSH shell closed')
          this.handleShellClose(channel)
        })
      })
    })
  }

  /** 在同一个 client 上跑一条收集输出的短命令。 */
  private execCapture(
    client: Client,
    command: string,
    timeoutMs: number
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      let done = false
      let activeChannel: import('ssh2').ClientChannel | undefined
      const timer = setTimeout(() => {
        if (done) return
        done = true
        try { activeChannel?.close() } catch { /* 连接已被关闭 */ }
        reject(new Error('远端命令超时'))
      }, timeoutMs)

      client.exec(command, (err, channel) => {
        if (err) {
          if (done) return
          done = true
          clearTimeout(timer)
          reject(err)
          return
        }
        if (done || this.client !== client) {
          try { channel.close() } catch { /* 迟到的通道已关闭 */ }
          return
        }
        activeChannel = channel

        let stdout = ''
        let stderr = ''
        const finish = (fn: () => void): void => {
          if (done) return
          done = true
          clearTimeout(timer)
          try { channel.close() } catch { /* ignore */ }
          fn()
        }

        channel.on('data', (data: Buffer) => {
          stdout = tailText(stdout + data.toString('utf8'), 8192)
        })
        channel.stderr?.on('data', (data: Buffer) => {
          stderr = tailText(stderr + data.toString('utf8'), 2048)
        })
        channel.on('error', (error: Error) => finish(() => reject(error)))
        channel.on('close', (code: number | null) => {
          finish(() => resolve({ code: code ?? null, stdout, stderr }))
        })
      })
    })
  }

  /** 销毁远端会话：只用于本连接创建且未被收纳的会话，失败只记日志。 */
  private async killRemoteSession(client: Client, tmuxPath: string, sessionName: string): Promise<void> {
    try {
      const command = `/bin/sh -c ${shellQuote(buildTmuxKillSessionCommand({ tmuxPath, sessionName }))}`
      await this.execCapture(client, command, TMUX_KILL_TIMEOUT_MS)
      log.info(`SSH tmux session cleaned up: ${sessionName}`)
    } catch (error) {
      log.warn(`Failed to clean up remote tmux session ${sessionName}:`, (error as Error).message)
    }
  }

  /**
   * 断开连接
   */
  async disconnect(): Promise<void> {
    log.info('SSH disconnecting')

    // 本次连接的主机密钥校验期次作废：之后到达的「信任」确认既不能保存记录，
    // 也不能用来推进一个已经被用户放弃的握手。
    this.hostKeyActive = false
    this.hostKeyAttempt++
    this.hostKeyFailure = null

    // 如果正在连接中，主动取消连接
    if (this._connecting && this._connectReject) {
      this._connectReject(new Error('Connection cancelled by user'))
      this._connectReject = null
      this._connecting = false
    }

    const channel = this.channel
    const client = this.client
    this.channel = null

    // 只有「用户主动断开时通道还挂在远端」才销毁 tmux 会话：
    //  - handleShellClose/handleTransportClose 已把通道置空（远端自己退出、Ctrl-b d 到
    //    后台、链路中断）时绝不能 kill，否则会误杀用户还想保留的远端程序；
    //  - retained（已收纳）的只 detach；
    //  - 恢复来的会话不归本连接所有。
    const shouldKill = !!channel && !!client && !this.linkLost &&
      this.remoteOwned && !this.retained && !!this.remoteName && !!this.remoteTmuxPath

    if (channel) channel.close()

    if (shouldKill && client && this.remoteTmuxPath && this.remoteName) {
      await this.killRemoteSession(client, this.remoteTmuxPath, this.remoteName)
      this.remoteOwned = false
    }

    this.releaseClient()

    if (this.decoder) {
      try { this.decoder.end() } catch { /* ignore */ }
      this.decoder = null
    }

    this.connected = false
  }

  /**
   * 写入数据
   */
  write(data: string | Buffer): void {
    if (!this.channel) {
      log.warn('SSH channel not available')
      return
    }

    this.channel.write(this.encodeOut(data))
  }

  /**
   * 调整终端尺寸
   */
  resize(cols: number, rows: number): void {
    // 净零 resize 跳过(同 LocalConnector):同尺寸 window-change 也会让远端
    // ncurses/TUI 重绘,字号往返时没必要打扰远端。
    if (this._cols === cols && this._rows === rows) {
      return
    }
    // 保存尺寸，用于后续 shell 创建
    this._cols = cols
    this._rows = rows

    if (!this.channel) {
      // connect 已 resolve 但 channel 尚未就绪(ready → shell 回调之间的空窗):
      // 尺寸已暂存到 _cols/_rows,channel 开启时由 startShell/startShellOnly
      // 补发 setWindow,降为 debug;已断开后的 resize 才是真异常,保持 warn。
      if (this.connected) {
        log.debug(`SSH channel not open yet, ${cols}x${rows} deferred for ${this.sessionId}`)
      } else {
        log.warn('SSH channel not available')
      }
      return
    }

    this.channel.setWindow(rows, cols, rows, cols)
  }
}
