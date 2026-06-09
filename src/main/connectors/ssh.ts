import { Client, ClientChannel } from 'ssh2'
import { EventEmitter } from 'events'
import log from 'electron-log'
import iconv from 'iconv-lite'
import { BaseConnector, ConnectionStatus } from './base'

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
  encoding?: 'utf-8' | 'gbk' | 'gb2312'
}

/**
 * SSH 连接器
 */
export class SSHConnector extends BaseConnector {
  private config: SSHConfig
  private client: Client | null = null
  private channel: ClientChannel | null = null
  private sharedClient: Client | null = null  // 共享的 SSH client
  private _connecting: boolean = false  // 是否正在连接中
  private _connectReject: ((error: Error) => void) | null = null  // 连接 Promise 的 reject 函数

  constructor(sessionId: string, config: SSHConfig) {
    super(sessionId)
    this.config = config
  }

  /**
   * 解码数据（根据配置的编码）
   */
  private decodeData(data: Buffer): string {
    const encoding = this.config.encoding || 'utf-8'
    try {
      return iconv.decode(data, encoding)
    } catch (e) {
      log.warn('SSH decode error:', e)
      return data.toString('binary')
    }
  }

  /**
   * 设置共享的 SSH client（用于克隆渠道）
   */
  setSharedClient(client: Client): void {
    this.sharedClient = client
    this.client = client
    this.connected = true
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

    return new Promise((resolve, reject) => {
      client.shell((err, channel) => {
        if (err) {
          log.error('SSH shell error:', err)
          reject(err)
          return
        }

        this.channel = channel
        this.connected = true

        // 接收数据
        channel.on('data', (data: Buffer) => {
          this.emitData(this.decodeData(data))
        })

        // Shell 关闭
        channel.on('close', () => {
          log.info('SSH shell closed')
          this.channel = null
          // 共享 client 时，只关闭 channel，不关闭整个连接
          if (!this.sharedClient) {
            this.connected = false
            this.emitClose()
          }
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
    }

    log.info(`SSH connecting to ${this.config.host}:${this.config.port}`)

    this.client = new Client()
    this._connecting = true

    this.client.on('ready', () => {
      log.info('SSH connection ready')
      this._connecting = false
      this._connectReject = null
      this.connected = true
      this.emit('connected')

      // 启动 shell
      this.startShell()
    })

    this.client.on('error', (err) => {
      // 提取关键错误信息（去掉堆栈）
      const errMsg = err.message?.split('\n')[0]?.replace(/^Error:\s*/, '') || err.toString()
      log.error(`SSH connection error: ${errMsg}`)
      this._connecting = false
      this._connectReject = null
      this.connected = false
      this.emitError(err)
    })

    this.client.on('close', () => {
      log.info('SSH connection closed')
      this._connecting = false
      this._connectReject = null
      this.connected = false
      this.emitClose()
    })

    // 连接配置
    const connectionConfig: ssh2.ConnectConfig = {
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      readyTimeout: this.config.readyTimeout || 10000,
      keepaliveInterval: this.config.keepaliveInterval || 10000, // 默认 10 秒心跳
      keepaliveCountMax: 3, // 3 次心跳失败后断开
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
      this._connectReject = reject  // 保存 reject 函数，以便 disconnect 时调用

      // 使用 once 确保只触发一次，避免重复 reject
      this.client!.once('ready', () => {
        this._connecting = false
        this._connectReject = null
        resolve()
      })
      this.client!.once('error', (err) => {
        if (this._connecting) {
          this._connecting = false
          this._connectReject = null
          reject(err)
        }
      })
      this.client!.once('close', () => {
        if (this._connecting) {
          this._connecting = false
          this._connectReject = null
          reject(new Error('Connection closed'))
        }
      })

      this.client!.connect(connectionConfig)
    })
  }

  /**
   * 启动 Shell
   */
  private startShell(): void {
    if (!this.client) return

    this.client.shell((err, channel) => {
      if (err) {
        log.error('SSH shell error:', err)
        this.emitError(err)
        return
      }

      this.channel = channel

      // 接收数据
      channel.on('data', (data: Buffer) => {
        this.emitData(this.decodeData(data))
      })

      // Shell 关闭
      channel.on('close', () => {
        log.info('SSH shell closed')
        this.channel = null
        this.emitClose()
      })

      log.info('SSH shell started')
    })
  }

  /**
   * 断开连接
   */
  async disconnect(): Promise<void> {
    log.info('SSH disconnecting')

    // 如果正在连接中，主动取消连接
    if (this._connecting && this._connectReject) {
      this._connectReject(new Error('Connection cancelled by user'))
      this._connectReject = null
      this._connecting = false
    }

    if (this.channel) {
      this.channel.close()
      this.channel = null
    }

    // 共享 client 时，不关闭整个连接
    if (!this.sharedClient && this.client) {
      this.client.end()
      this.client = null
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

    this.channel.write(data)
  }

  /**
   * 调整终端尺寸
   */
  resize(cols: number, rows: number): void {
    if (!this.channel) {
      log.warn('SSH channel not available')
      return
    }

    this.channel.setWindow(rows, cols, rows, cols)
  }
}