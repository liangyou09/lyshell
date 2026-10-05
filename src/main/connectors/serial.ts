import { SerialPort } from 'serialport'
import type { PortInfo } from '@serialport/bindings-interface'
import log from 'electron-log'
import { BaseConnector } from './base'
import type { TerminalEncoding } from '@shared/types'

/**
 * 串口配置
 */
export interface SerialConfig {
  path: string
  baudRate: number
  dataBits?: 5 | 6 | 7 | 8
  stopBits?: 1 | 2
  parity?: 'none' | 'even' | 'odd' | 'mark' | 'space'
  encoding?: TerminalEncoding
}

/**
 * 串口连接器
 */
export class SerialConnector extends BaseConnector {
  private config: SerialConfig
  private port: SerialPort | null = null
  private openingPromise: Promise<void> | null = null
  private disconnectPromise: Promise<void> | null = null
  private closeError: Error | null = null
  private cancelled = false

  constructor(sessionId: string, config: SerialConfig) {
    super(sessionId, config.encoding)
    this.config = config
  }

  /**
   * 打开串口
   */
  async connect(config?: SerialConfig): Promise<void> {
    if (this.port || this.disconnectPromise) throw new Error('Serial connection is already active')
    if (config) {
      this.config = config
      this.encoding = config.encoding || 'utf-8'
    }

    log.info(`Serial opening ${this.config.path} @ ${this.config.baudRate}`)

    this.cancelled = false
    const port = new SerialPort({
      path: this.config.path,
      baudRate: this.config.baudRate,
      dataBits: this.config.dataBits || 8,
      stopBits: this.config.stopBits || 1,
      parity: this.config.parity || 'none',
      autoOpen: false
    })
    this.port = port

    const opening = new Promise<void>((resolve, reject) => {
      port.open((err) => {
        if (err) {
          log.error('Serial open error:', err)
          reject(err)
          return
        }

        // 取消时保留原生句柄，disconnect 等此回调落定后关闭，不再发布连接成功。
        if (this.cancelled || this.port !== port) {
          reject(new Error('Serial connection cancelled'))
          return
        }

        log.info('Serial port opened')
        this.connected = true
        this.emit('connected')

        // 每个串口连接单独一个流式解码器
        this.replaceDecoder()

        resolve()
      })

      port.on('data', (data: Buffer) => {
        if (this.cancelled || this.port !== port) return
        this.decoder?.write(data)
      })

      port.on('error', (err) => {
        if (this.cancelled || this.port !== port) return
        log.error('Serial error:', err)
        this.connected = false
        this.emitError(err)
      })

      port.on('close', () => {
        if (this.port !== port) return
        log.info('Serial port closed')
        this.connected = false
        this.emitClose()
      })
    })
    this.openingPromise = opening
    try {
      await opening
    } finally {
      if (this.openingPromise === opening) this.openingPromise = null
    }
  }

  /**
   * 关闭串口
   */
  async disconnect(): Promise<void> {
    if (this.disconnectPromise) return this.disconnectPromise
    log.info('Serial closing')
    this.cancelled = true
    this.connected = false
    const closing = this.closePort(this.port, this.openingPromise)
    this.disconnectPromise = closing
    try {
      await closing
    } finally {
      if (this.disconnectPromise === closing) this.disconnectPromise = null
    }
  }

  /** 打开和关闭各自串行化；等待打开失败或成功后，再决定是否需要释放句柄。 */
  private async closePort(port: SerialPort | null, opening: Promise<void> | null): Promise<void> {
    if (opening) {
      try { await opening } catch { /* 打开失败无需关句柄；取消后的成功打开仍需关闭。 */ }
    }
    if (port?.isOpen) {
      try {
        await new Promise<void>((resolve, reject) => {
          port.close(error => error ? reject(error) : resolve())
        })
        this.closeError = null
      } catch (error) {
        this.closeError = error instanceof Error ? error : new Error(String(error))
        throw this.closeError
      }
    } else if (this.closeError) {
      // bindings-cpp 会在原生 close 前清空 fd；isOpen=false 不能证明失败的 close 已释放资源。
      throw new Error(`Serial close could not be confirmed; restart the application: ${this.closeError.message}`, { cause: this.closeError })
    }
    if (this.port === port) {
      this.port = null
      if (this.decoder) {
        try { this.decoder.end() } catch { /* ignore */ }
        this.decoder = null
      }
      this.connected = false
    }
  }

  /**
   * 写入数据
   */
  write(data: string | Buffer): void {
    if (!this.port) {
      log.warn('Serial port not available')
      return
    }

    this.port.write(this.encodeOut(data))
  }

  /**
   * 调整终端尺寸（串口不支持）
   */
  resize(_cols: number, _rows: number): void {
    // 串口不支持终端尺寸调整
    log.warn('Serial does not support terminal resize')
  }

  /**
   * 获取可用串口列表
   */
  static async listPorts(): Promise<PortInfo[]> {
    return SerialPort.list()
  }
}
