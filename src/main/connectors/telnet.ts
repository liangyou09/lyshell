import { Socket } from 'net'
import log from 'electron-log'
import iconv from 'iconv-lite'
import { BaseConnector } from './base'

/**
 * Telnet 配置
 */
export interface TelnetConfig {
  host: string
  port: number
  timeout?: number
  encoding?: 'utf-8' | 'gbk' | 'gb2312'
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
   * 解码数据（根据配置的编码）
   */
  private decodeData(data: Buffer): string {
    const encoding = this.config.encoding || 'utf-8'
    try {
      return iconv.decode(data, encoding)
    } catch (e) {
      log.warn('Telnet decode error:', e)
      return data.toString('binary')
    }
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
      // 过滤Telnet IAC控制字符
      const filteredData = this.filterIAC(data)
      if (filteredData.length > 0) {
        this.emitData(this.decodeData(filteredData))
      }
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
      this.socket!.setTimeout(this.config.timeout || 10000)
      this.socket!.connect({
        host: this.config.host,
        port: this.config.port
      })

      this.socket!.on('connect', () => resolve())
      this.socket!.on('error', (err) => reject(err))
      this.socket!.on('timeout', () => reject(new Error('Connection timeout')))
    })
  }

  /**
   * 过滤Telnet IAC控制字符
   * IAC命令格式: 0xFF + 命令字节(1字节) + 可选参数字节
   * 标准Telnet命令:
   *   F0 (SE) - 子协商结束
   *   F1 (NOP) - 无操作 (KeepAlive)
   *   F2 (DM) - Data Mark
   *   F3 (BRK) - Break
   *   F4 (IP) - Interrupt Process
   *   F5 (AO) - Abort Output
   *   F6 (AYT) - Are You There
   *   F7 (EC) - Erase Character
   *   F8 (EL) - Erase Line
   *   F9 (GA) - Go Ahead
   *   FA (SB) - Subnegotiation Begin
   *   FB (WILL), FC (WONT), FD (DO), FE (DONT) - 选项协商
   */
  private filterIAC(data: Buffer): Buffer {
    const result: number[] = []
    let i = 0

    while (i < data.length) {
      if (data[i] === 0xFF) {
        // IAC命令开始
        if (i + 1 < data.length) {
          const cmd = data[i + 1]
          // 双FF表示发送FF字符（转义）- 保留一个FF
          if (cmd === 0xFF) {
            result.push(0xFF)
            i += 2
            continue
          }
          // 标准Telnet命令 (F0-FE): FF + cmd (2字节)
          // NOP(F1), DM(F2), BRK(F3), IP(F4), AO(F5), AYT(F6), EC(F7), EL(F8), GA(F9), SE(F0)
          if (cmd >= 0xF0 && cmd <= 0xF9) {
            i += 2
            continue
          }
          // WILL/WONT/DO/DONT 命令: FF + cmd + option (3字节)
          if (cmd >= 0xFB && cmd <= 0xFE) {
            i += 3
            continue
          }
          // SB (子协商开始): FF FA ... FF F0
          if (cmd === 0xFA) {
            i += 2
            // 寻找结束标记 FF F0
            while (i < data.length - 1) {
              if (data[i] === 0xFF && data[i + 1] === 0xF0) {
                i += 2
                break
              }
              if (data[i] === 0xFF && data[i + 1] === 0xFF) {
                i += 2
              } else {
                i++
              }
            }
            continue
          }
          // FF后面不是标准命令，保留FF作为数据
          result.push(0xFF)
          i++
        } else {
          // 只有FF没有后续字节，保留
          result.push(0xFF)
          i++
        }
      } else {
        // 过滤非打印字符（保留换行、回车、制表符等常用控制字符）
        const byte = data[i]
        if (byte >= 0x20 && byte <= 0x7E) {
          result.push(byte)
        } else if (byte === 0x08 || byte === 0x09 || byte === 0x0A || byte === 0x0D || byte === 0x1B) {
          result.push(byte)
        } else if (byte >= 0x80) {
          result.push(byte)
        }
        i++
      }
    }

    return Buffer.from(result)
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
   * 调整终端尺寸（Telnet 不支持NAWS）
   */
  resize(_cols: number, _rows: number): void {
    // Telnet 协议默认不支持终端尺寸调整，静默处理
  }
}