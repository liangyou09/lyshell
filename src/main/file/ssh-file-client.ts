import { Client } from 'ssh2'
import type { ConnectConfig } from 'ssh2'
import { EventEmitter } from 'events'
import type { SFTPWrapper } from '../types/global'
import log from 'electron-log'
import type { SSHConfig } from '@shared/types'

/** 连接被主动断开或被远端关闭时统一使用的错误信息 */
const CONNECTION_CLOSED_MESSAGE = 'SSH file connection closed'

/**
 * SSH 文件传输独立连接管理器
 * 与终端 Shell 连接分离，避免传输时阻塞终端
 *
 * 并发约定：
 * - 同一时刻最多只有一个在途连接 Promise，所有并发调用方共享它；
 * - 同一时刻最多只有一个在途 SFTP 初始化 Promise；
 * - 断开（主动或远端关闭）会拒绝全部等待者；每次拆除都递增代次，
 *   旧 client 的迟到 ready/close/error 与迟到 SFTP 回调都会因实例/代次不符被丢弃，
 *   不会污染随后建立的新连接。
 */
export class SSHFileClient extends EventEmitter {
  private sessionId: string
  private sshConfig: SSHConfig
  private client: Client | null = null
  private sftp: SFTPWrapper | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private reconnectAttempts: number = 0

  /** 在途连接 Promise 及其 reject（保证断开时能取消等待） */
  private connectPromise: Promise<Client> | null = null
  private connectReject: ((error: Error) => void) | null = null
  /** 在途 SFTP 初始化 Promise 及其 reject */
  private sftpPromise: Promise<SFTPWrapper> | null = null
  private sftpReject: ((error: Error) => void) | null = null

  /**
   * 连接代次：每次拆除连接自增。异步回调只在实例与代次都匹配时才允许改动状态，
   * 从而丢弃迟到事件。
   */
  private generation: number = 0

  // 配置
  private readonly maxReconnectAttempts = 3
  private readonly idleTimeoutMs = 5 * 60 * 1000  // 5 分钟空闲超时
  private readonly baseReconnectDelayMs = 1000   // 重连基础延迟 1s

  // 连接状态
  private ready: boolean = false

  constructor(sessionId: string, sshConfig: SSHConfig) {
    super()
    this.sessionId = sessionId
    this.sshConfig = sshConfig
    log.debug(`SSHFileClient created for session ${sessionId}`)
  }

  /**
   * 获取 SSH Client（懒加载，自动连接）
   */
  async getClient(): Promise<Client> {
    // 已连接且就绪，直接返回
    if (this.client && this.ready) {
      this.resetIdleTimer()
      return this.client
    }

    // 有在途连接：复用同一个 Promise，不再新建 transport
    if (this.connectPromise) {
      return this.connectPromise
    }

    // 需要建立新连接
    return this.connect()
  }

  /**
   * 获取 SFTP Wrapper（懒加载，同一时刻只初始化一个）
   */
  async getSFTP(): Promise<SFTPWrapper> {
    const client = await this.getClient()

    // 等待连接期间连接可能已被断开或替换：拒绝，而不是复用错误的对象
    if (this.client !== client || !this.ready) {
      throw new Error(CONNECTION_CLOSED_MESSAGE)
    }

    // SFTP 已初始化，直接返回
    if (this.sftp) {
      this.resetIdleTimer()
      return this.sftp
    }

    // 已有在途初始化，共享同一个 Promise
    if (this.sftpPromise) {
      return this.sftpPromise
    }

    const generation = this.generation
    let resolveSftp!: (sftp: SFTPWrapper) => void
    let rejectSftp!: (error: Error) => void
    const promise = new Promise<SFTPWrapper>((resolve, reject) => {
      resolveSftp = resolve
      rejectSftp = reject
    })

    this.sftpPromise = promise
    this.sftpReject = rejectSftp

    const onSftp = (err: Error | undefined, sftp: SFTPWrapper): void => {
      // 迟到回调：连接已被断开/替换，或该 Promise 已被新的初始化取代。
      // 此时绝不能把旧 sftp 安装到当前连接上。
      if (this.sftpPromise !== promise || this.client !== client || this.generation !== generation) {
        return
      }
      this.sftpPromise = null
      this.sftpReject = null

      if (err) {
        log.error(`SFTP init error for session ${this.sessionId}: ${err.message}`)
        rejectSftp(err)
        return
      }

      this.sftp = sftp
      log.info(`SFTP initialized for file transfer session: ${this.sessionId}`)
      this.resetIdleTimer()
      resolveSftp(sftp)
    }

    try {
      client.sftp(onSftp)
    } catch (error) {
      // 同步抛错也要让等待者结束，不能留下悬挂的 Promise
      if (this.sftpPromise === promise) {
        this.sftpPromise = null
        this.sftpReject = null
        rejectSftp(error instanceof Error ? error : new Error(String(error)))
      }
    }

    return promise
  }

  /**
   * 建立 SSH 连接（同一时刻只会有一个在途 Promise）
   */
  private connect(): Promise<Client> {
    if (this.connectPromise) {
      return this.connectPromise
    }

    // 防御：存在未就绪且无在途 Promise 的旧 client 时先清理，避免其迟到事件干扰新连接
    if (this.client) {
      const stale = this.client
      this.generation++
      this.client = null
      this.sftp = null
      this.ready = false
      this.clearIdleTimer()
      try {
        stale.end()
      } catch {
        // 忽略关闭错误
      }
    }

    const generation = this.generation
    let resolveConnect!: (client: Client) => void
    let rejectConnect!: (error: Error) => void
    const promise = new Promise<Client>((resolve, reject) => {
      resolveConnect = resolve
      rejectConnect = reject
    })

    this.connectPromise = promise
    this.connectReject = rejectConnect

    let client: Client
    try {
      client = new Client()
    } catch (error) {
      // 同步构造失败：不留下在途状态
      const err = error instanceof Error ? error : new Error(String(error))
      this.connectPromise = null
      this.connectReject = null
      rejectConnect(err)
      return promise
    }

    this.client = client

    /** 只有当前实例且代次未变，事件才有资格改动状态 */
    const isCurrent = (): boolean => this.client === client && this.generation === generation

    // 连接就绪
    client.once('ready', () => {
      if (!isCurrent()) return
      log.info(`SSHFileClient connected for session ${this.sessionId}`)
      this.ready = true
      this.reconnectAttempts = 0
      this.resetIdleTimer()
      this.connectPromise = null
      this.connectReject = null
      this.emit('connected')
      resolveConnect(client)
    })

    // 连接错误
    client.on('error', (err) => {
      if (!isCurrent()) return
      const errMsg = err.message?.split('\n')[0]?.replace(/^Error:\s*/, '') || err.toString()
      log.error(`SSHFileClient error for session ${this.sessionId}: ${errMsg}`)
      if (this.listenerCount('error') > 0) {
        this.emit('error', err)
      }
      // 错误后 transport 可能不会再发 close：主动销毁，避免丢失引用后 socket 悬空
      const stale = this.teardown(err, true)
      try {
        stale?.destroy()
      } catch {
        // 忽略关闭错误
      }
    })

    // 连接关闭（远端或 transport 自行关闭）
    client.once('close', () => {
      if (!isCurrent()) return
      log.info(`SSHFileClient closed for session ${this.sessionId}`)
      this.teardown(new Error(CONNECTION_CLOSED_MESSAGE), true)
    })

    log.info(`SSHFileClient connecting to ${this.sshConfig.host}:${this.sshConfig.port} for session ${this.sessionId}`)
    try {
      client.connect(this.buildConnectionConfig())
    } catch (error) {
      // 同步抛错同样要结束在途 Promise
      if (isCurrent()) {
        const err = error instanceof Error ? error : new Error(String(error))
        this.teardown(err, true)
        try { client.destroy() } catch { /* 同步失败也收回已创建 transport */ }
      }
    }

    return promise
  }

  /**
   * 构造 ssh2 连接配置
   */
  private buildConnectionConfig(): ConnectConfig {
    const connectionConfig: ConnectConfig = {
      host: this.sshConfig.host,
      port: this.sshConfig.port,
      username: this.sshConfig.username,
      // 与终端连接器/connectors/ssh.ts、upload/download worker 四路统一的握手默认值:
      // 慢握手服务器(如 UseDNS 超时)15 秒不够 —— 终端连得上、文件面板连不上是错位行为。
      // 显式 readyTimeout 配置仍优先
      readyTimeout: this.sshConfig.readyTimeout || 30000,
      keepaliveInterval: this.sshConfig.keepaliveInterval || 10000,
      keepaliveCountMax: 3,
    }

    // 认证方式
    if (this.sshConfig.password) {
      connectionConfig.password = this.sshConfig.password
    } else if (this.sshConfig.privateKey) {
      connectionConfig.privateKey = this.sshConfig.privateKey
      if (this.sshConfig.passphrase) {
        connectionConfig.passphrase = this.sshConfig.passphrase
      }
    }

    return connectionConfig
  }

  /**
   * 统一拆除当前连接状态：
   * 递增代次让旧 client 的迟到事件全部失效，并拒绝所有等待中的连接/SFTP 调用方。
   * @returns 需要调用方负责 end 的旧 client（若存在）
   */
  private teardown(error: Error, emitClose: boolean): Client | null {
    const client = this.client
    const hadState = client !== null || this.connectReject !== null || this.sftpReject !== null || this.sftp !== null
    const pendingConnect = this.connectReject
    const pendingSftp = this.sftpReject

    this.generation++
    this.clearIdleTimer()
    this.client = null
    this.sftp = null
    this.ready = false
    this.connectPromise = null
    this.connectReject = null
    this.sftpPromise = null
    this.sftpReject = null

    // 先清空状态再 reject，等待者回调里看到的一定是已断开状态
    pendingConnect?.(error)
    pendingSftp?.(error)

    if (emitClose && hadState) {
      this.emit('close')
    }

    return client
  }

  /**
   * 重连机制
   */
  async reconnect(): Promise<Client> {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      throw new Error(`Max reconnect attempts (${this.maxReconnectAttempts}) exceeded for session ${this.sessionId}`)
    }

    this.reconnectAttempts++
    const delay = this.baseReconnectDelayMs * Math.pow(2, this.reconnectAttempts - 1)  // 递增延迟: 1s, 2s, 4s

    log.info(`SSHFileClient reconnecting for session ${this.sessionId}, attempt ${this.reconnectAttempts}, delay ${delay}ms`)

    // 清理旧连接并拒绝其等待者
    const disconnect = this.disconnect()
    const generation = this.generation
    await disconnect

    // 等待延迟后重连
    await new Promise(resolve => setTimeout(resolve, delay))

    if (this.generation !== generation) throw new Error(CONNECTION_CLOSED_MESSAGE)

    // 等待期间可能已被其他调用方重新连上
    if (this.client && this.ready) return this.client
    if (this.connectPromise) return this.connectPromise
    return this.connect()
  }

  /**
   * 断开连接：拒绝所有等待中的调用方，之后的新请求会重新建立连接
   */
  async disconnect(): Promise<void> {
    log.info(`SSHFileClient disconnecting for session ${this.sessionId}`)
    const client = this.teardown(new Error(CONNECTION_CLOSED_MESSAGE), true)
    if (client) {
      try {
        client.end()
        client.destroy()
      } catch {
        // 忽略关闭错误
      }
    }
  }

  /**
   * 检查连接状态
   */
  isConnected(): boolean {
    return this.ready && this.client !== null
  }

  /**
   * 获取 session ID
   */
  getSessionId(): string {
    return this.sessionId
  }

  /**
   * 重置空闲计时器（每次操作后调用）
   */
  private resetIdleTimer(): void {
    this.clearIdleTimer()

    this.idleTimer = setTimeout(() => {
      log.info(`SSHFileClient idle timeout for session ${this.sessionId}, auto disconnecting`)
      this.disconnect().catch(e => {
        log.warn(`Idle disconnect error: ${e}`)
      })
    }, this.idleTimeoutMs)
  }

  /**
   * 清除空闲计时器
   */
  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }
}
