import { Socket } from 'net'
import log from 'electron-log'
import { BaseConnector } from './base'

/**
 * Telnet 配置
 */
export interface TelnetConfig {
  host: string
  port: number
  timeout?: number
}

/**
 * Telnet 连接器
 */
export class TelnetConnector extends BaseConnector {
  private config: TelnetConfig
  private socket: Socket | null = null

  constructor(sessionId: string, config: TelnetConfig) {
    super(sessionId)
    this.config = config
  }

  /**
   * 连接到 Telnet 服务器
   */
  async connect(config?: TelnetConfig): Promise<void> {
    if (config) {
      this.config = config
    }

    log.info(`Telnet connecting to ${this.config.host}:${this.config.port}`)

    this.socket = new Socket()

    this.socket.on('connect', () => {
      log.info('Telnet connected')
      this.connected = true
      this.emit('connected')
    })

    this.socket.on('data', (data: Buffer) => {
      this.emitData(data.toString())
    })

    this.socket.on('error', (err) => {
      log.error('Telnet error:', err)
      this.connected = false
      this.emitError(err)
    })

    this.socket.on('close', () => {
      log.info('Telnet connection closed')
      this.connected = false
      this.emitClose()
    })

    return new Promise((resolve, reject) => {
      this.socket!.connect({
        host: this.config.host,
        port: this.config.port,
        timeout: this.config.timeout || 10000
      })

      this.socket!.on('connect', () => resolve())
      this.socket!.on('error', (err) => reject(err))
      this.socket!.on('timeout', () => reject(new Error('Connection timeout')))
    })
  }

  /**
   * 断开连接
   */
  async disconnect(): Promise<void> {
    log.info('Telnet disconnecting')

    if (this.socket) {
      this.socket.destroy()
      this.socket = null
    }

    this.connected = false
  }

  /**
   * 写入数据
   */
  write(data: string | Buffer): void {
    if (!this.socket) {
      log.warn('Telnet socket not available')
      return
    }

    this.socket.write(data)
  }

  /**
   * 调整终端尺寸（Telnet 不支持）
   */
  resize(_cols: number, _rows: number): void {
    // Telnet 协议不支持终端尺寸调整
    log.warn('Telnet does not support terminal resize')
  }
}