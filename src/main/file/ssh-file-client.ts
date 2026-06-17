import { Client } from 'ssh2'
import type { ConnectConfig } from 'ssh2'
import { EventEmitter } from 'events'
import type { SFTPWrapper } from '../types/global'
import log from 'electron-log'
import type { SSHConfig } from '@shared/types'

/**
 * SSH 文件传输独立连接管理器
 * 与终端 Shell 连接分离，避免传输时阻塞终端
 */
export class SSHFileClient extends EventEmitter {
  private sessionId: string
  private sshConfig: SSHConfig
  private client: Client | null = null
  private sftp: SFTPWrapper | null = null
  private connecting: boolean = false
  private idleTimer: NodeJS.Timeout | null = null
  private reconnectAttempts: number = 0

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

    // 正在连接中，等待连接完成
    if (this.connecting) {
      return this.waitForConnection()
    }

    // 需要建立新连接
    return this.connect()
  }

  /**
   * 获取 SFTP Wrapper（懒加载）
   */
  async getSFTP(): Promise<SFTPWrapper> {
    // 确保 client 已连接
    await this.getClient()

    // SFTP 已初始化，直接返回
    if (this.sftp) {
      this.resetIdleTimer()
      return this.sftp
    }

    // 初始化 SFTP subsystem
    return new Promise((resolve, reject) => {
      this.client!.sftp((err, sftp) => {
        if (err) {
          log.error(`SFTP init error for session ${this.sessionId}: ${err.message}`)
          reject(err)
          return
        }
        this.sftp = sftp
        log.info(`SFTP initialized for file transfer session: ${this.sessionId}`)
        this.resetIdleTimer()
        resolve(sftp)
      })
    })
  }

  /**
   * 建立 SSH 连接
   */
  private async connect(): Promise<Client> {
    this.connecting = true
    this.reconnectAttempts = 0

    try {
      const client = await this.doConnect()
      this.connecting = false
      return client
    } catch (error) {
      this.connecting = false
      throw error
    }
  }

  /**
   * 实际执行连接
   */
  private async doConnect(): Promise<Client> {
    return new Promise((resolve, reject) => {
      log.info(`SSHFileClient connecting to ${this.sshConfig.host}:${this.sshConfig.port} for session ${this.sessionId}`)

      this.client = new Client()

      // 连接配置
      const connectionConfig: ConnectConfig = {
        host: this.sshConfig.host,
        port: this.sshConfig.port,
        username: this.sshConfig.username,
        readyTimeout: this.sshConfig.readyTimeout || 15000,
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

      // 连接就绪
      this.client.on('ready', () => {
        log.info(`SSHFileClient connected for session ${this.sessionId}`)
        this.ready = true
        this.reconnectAttempts = 0
        this.resetIdleTimer()
        this.emit('connected')
        resolve(this.client!)
      })

      // 连接错误
      this.client.on('error', (err) => {
        const errMsg = err.message?.split('\n')[0]?.replace(/^Error:\s*/, '') || err.toString()
        log.error(`SSHFileClient error for session ${this.sessionId}: ${errMsg}`)
        this.ready = false
        this.emit('error', err)

        // 如果正在连接中，reject
        if (this.connecting) {
          reject(err)
        }
      })

      // 连接关闭
      this.client.on('close', () => {
        log.info(`SSHFileClient closed for session ${this.sessionId}`)
        this.ready = false
        this.sftp = null
        this.clearIdleTimer()
        this.emit('close')
      })

      // 开始连接
      this.client.connect(connectionConfig)
    })
  }

  /**
   * 等待连接完成（用于并发调用时）
   */
  private async waitForConnection(): Promise<Client> {
    return new Promise((resolve, reject) => {
      const checkReady = () => {
        if (this.ready && this.client) {
          resolve(this.client)
        } else if (!this.connecting) {
          // 连接失败，尝试重新连接
          this.connect().then(resolve).catch(reject)
        } else {
          // 继续等待
          setTimeout(checkReady, 50)
        }
      }
      checkReady()
    })
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

    // 清理旧连接
    if (this.client) {
      try {
        this.client.end()
      } catch (e) {
        // 忽略关闭错误
      }
      this.client = null
      this.sftp = null
      this.ready = false
    }

    // 等待延迟后重连
    await new Promise(resolve => setTimeout(resolve, delay))

    return this.connect()
  }

  /**
   * 断开连接
   */
  async disconnect(): Promise<void> {
    log.info(`SSHFileClient disconnecting for session ${this.sessionId}`)
    this.clearIdleTimer()

    if (this.client) {
      try {
        this.client.end()
      } catch (e) {
        // 忽略关闭错误
      }
      this.client = null
      this.sftp = null
      this.ready = false
      this.connecting = false
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