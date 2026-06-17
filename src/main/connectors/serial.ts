import { SerialPort } from 'serialport'
import type { PortInfo } from '@serialport/bindings-interface'
import log from 'electron-log'
import iconv from 'iconv-lite'
import { BaseConnector } from './base'

/**
 * 串口配置
 */
export interface SerialConfig {
  path: string
  baudRate: number
  dataBits?: 5 | 6 | 7 | 8
  stopBits?: 1 | 2
  parity?: 'none' | 'even' | 'odd' | 'mark' | 'space'
  encoding?: 'utf-8' | 'gbk' | 'gb2312'
}

/**
 * 串口连接器
 */
export class SerialConnector extends BaseConnector {
  private config: SerialConfig
  private port: SerialPort | null = null

  constructor(sessionId: string, config: SerialConfig) {
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
      log.warn('Serial decode error:', e)
      return data.toString('binary')
    }
  }

  /**
   * 打开串口
   */
  async connect(config?: SerialConfig): Promise<void> {
    if (config) {
      this.config = config
    }

    log.info(`Serial opening ${this.config.path} @ ${this.config.baudRate}`)

    this.port = new SerialPort({
      path: this.config.path,
      baudRate: this.config.baudRate,
      dataBits: this.config.dataBits || 8,
      stopBits: this.config.stopBits || 1,
      parity: this.config.parity || 'none',
      autoOpen: false
    })

    return new Promise((resolve, reject) => {
      this.port!.open((err) => {
        if (err) {
          log.error('Serial open error:', err)
          reject(err)
          return
        }

        log.info('Serial port opened')
        this.connected = true
        this.emit('connected')
        resolve()
      })

      this.port!.on('data', (data: Buffer) => {
        this.emitData(this.decodeData(data))
      })

      this.port!.on('error', (err) => {
        log.error('Serial error:', err)
        this.connected = false
        this.emitError(err)
      })

      this.port!.on('close', () => {
        log.info('Serial port closed')
        this.connected = false
        this.emitClose()
      })
    })
  }

  /**
   * 关闭串口
   */
  async disconnect(): Promise<void> {
    log.info('Serial closing')

    if (this.port) {
      await new Promise<void>((resolve) => {
        this.port!.close(() => resolve())
      })
      this.port = null
    }

    this.connected = false
  }

  /**
   * 写入数据
   */
  write(data: string | Buffer): void {
    if (!this.port) {
      log.warn('Serial port not available')
      return
    }

    this.port.write(data)
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