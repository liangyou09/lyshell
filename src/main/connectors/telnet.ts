import { Socket } from 'net'
import log from 'electron-log'
import { BaseConnector } from './base'
import type { TerminalEncoding } from '@shared/types'

/**
 * Telnet 配置
 */
export interface TelnetConfig {
  host: string
  port: number
  timeout?: number
  encoding?: TerminalEncoding
}

/**
 * Telnet 连接器
 */
export class TelnetConnector extends BaseConnector {
  get capabilities() {
    return { interactiveInput: true, resize: false, exec: false, fileTransfer: false, pauseOutput: true, reattach: false }
  }
  private config: TelnetConfig
  private socket: Socket | null = null
  private outputPaused = false
  /** 连接尝试代次 —— socket 回调按代次校验，旧 socket 的迟到事件不得污染新一次连接 */
  private attempt = 0
  /** 当前尝试的收尾函数 —— disconnect 据此落定悬挂的 connect Promise */
  private cancelPending: ((error: Error) => void) | null = null
  private socketCleanup = new WeakMap<Socket, () => void>()

  constructor(sessionId: string, config: TelnetConfig) {
    super(sessionId, config.encoding)
    this.config = config
  }

  /**
   * 连接到 Telnet 服务器
   *
   * 连接期（connect 事件之前）的超时/错误/关闭都必须让本次 Promise 恰好落定一次，
   * 并销毁本次 socket、结束解码流。只 reject 不销毁会让服务器侧留下一条半开连接，
   * 且之后迟到的 connect 事件还能把 connected 改成 true —— 连接明明失败却在报成功。
   */
  async connect(config?: TelnetConfig): Promise<void> {
    if (config) {
      this.config = config
      this.encoding = config.encoding || 'utf-8'
    }

    // 新一次尝试立刻取代旧尝试：旧 socket 先解绑再销毁，其迟到事件不再影响连接器；
    // 悬挂的旧 Promise 也必须落定，否则调用方永远等不到结果。
    const previous = this.socket
    this.socket = null
    this.attempt++
    const supersede = this.cancelPending
    this.cancelPending = null
    supersede?.(new Error('Connection superseded by a new attempt'))
    if (previous) this.releaseSocket(previous)
    this.connected = false

    const attempt = this.attempt
    const socket = new Socket()
    this.socket = socket
    this.replaceDecoder()
    if (this.outputPaused) socket.pause()

    log.info(`Telnet connecting to ${this.config.host}:${this.config.port}`)

    return new Promise<void>((resolve, reject) => {
      let settled = false
      let established = false
      const isCurrent = (): boolean => this.attempt === attempt && this.socket === socket

      /** 落定本次连接（幂等）；返回是否由本次调用落定 */
      const settle = (error?: Error): boolean => {
        if (settled) return false
        settled = true
        this.cancelPending = null
        if (error) reject(error)
        else resolve()
        return true
      }

      /**
       * 连接失败收尾：先落定再销毁 —— destroy 触发的 close/error 不得再次 reject。
       * 连接已落定（已连接后的运行期错误）时无操作，交由 close 收尾。
       */
      const fail = (error: Error): void => {
        if (!settle(error)) return
        this.releaseSocket(socket)
        this.releaseDecoder()
      }

      const onConnect = (): void => {
        if (!isCurrent() || settled) return
        log.info('Telnet connected')
        established = true
        this.connected = true
        // setTimeout 是空闲计时器：连接成功后必须撤销，否则登录后长时间无输出的
        // 会话会被当成连接超时掐断。连接期 deadline 只覆盖握手。
        socket.setTimeout(0)
        socket.removeListener('timeout', onTimeout)
        settle()
        this.emit('connected')
      }

      const onData = (data: Buffer): void => {
        if (!isCurrent()) return
        // 过滤Telnet IAC控制字符
        const filteredData = this.filterIAC(data)
        if (filteredData.length > 0) {
          this.decoder?.write(filteredData)
        }
      }

      const onError = (err: Error): void => {
        if (!isCurrent()) return
        log.error('Telnet error:', err)
        this.connected = false
        // 连接期：落定 + 释放；已连接后：fail 无操作，等随后的 close 收尾。
        fail(err)
        this.emitError(err)
      }

      const onTimeout = (): void => {
        // 连接成功时已撤销计时器并移除本监听；能走到这里只可能是握手超时
        if (!isCurrent() || settled) return
        log.warn(`Telnet connect timeout after ${this.config.timeout || 10000}ms`)
        fail(new Error('Connection timeout'))
      }

      const onClose = (): void => {
        if (!isCurrent()) return
        log.info('Telnet connection closed')
        const wasEstablished = established
        this.connected = false
        // 握手期关闭同样要落定，否则 connect Promise 永久悬挂
        settle(wasEstablished ? undefined : new Error('Connection closed'))
        this.releaseSocket(socket)
        this.releaseDecoder()
        // 未建立起来的连接不广播 close：上层只该把它当成一次失败，而不是已建立
        // 会话的自然断开（后者才需要走会话清理）。
        if (wasEstablished) this.emitClose()
      }

      // 允许 disconnect 取消悬挂的 connect
      this.cancelPending = (error: Error): void => {
        settle(error)
      }

      socket.on('connect', onConnect)
      socket.on('data', onData)
      socket.on('error', onError)
      socket.on('close', onClose)
      socket.on('timeout', onTimeout)
      this.socketCleanup.set(socket, () => {
        socket.off('connect', onConnect)
        socket.off('data', onData)
        socket.off('error', onError)
        socket.off('close', onClose)
        socket.off('timeout', onTimeout)
      })

      try {
        socket.setTimeout(this.config.timeout || 10000)
        socket.connect({
          host: this.config.host,
          port: this.config.port
        })
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /** 解绑并销毁 socket：不再依赖它自己的事件收尾，也不会残留可达的监听器 */
  private releaseSocket(socket: Socket): void {
    // 仅解绑自己注册的回调，保留 net.Socket 自身的流生命周期监听。
    this.socketCleanup.get(socket)?.()
    this.socketCleanup.delete(socket)
    // 已销毁的 socket 仍可能异步抛出写/连接错误；保留空监听避免 uncaughtException
    socket.on('error', () => { /* 已释放 */ })
    try { socket.setTimeout(0) } catch { /* ignore */ }
    try { socket.destroy() } catch { /* 已销毁 */ }
    if (this.socket === socket) this.socket = null
  }

  /** 结束解码流并丢弃引用（半截多字节以替换字符吐出，流不悬挂） */
  private releaseDecoder(): void {
    if (this.decoder) {
      try { this.decoder.end() } catch { /* ignore */ }
      this.decoder = null
    }
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

    // 先取消悬挂的连接：socket 尚未连通时 error/close 都不可靠，只能由这里落定，
    // 否则 connect Promise 永久悬挂。destroy 后的 close 由 releaseSocket 解绑吞掉。
    this.attempt++
    const cancel = this.cancelPending
    this.cancelPending = null
    cancel?.(new Error('Connection cancelled by user'))

    const socket = this.socket
    this.socket = null
    if (socket) this.releaseSocket(socket)
    this.releaseDecoder()

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

    this.socket.write(this.encodeOut(data))
  }

  /**
   * 调整终端尺寸（Telnet 不支持NAWS）
   */
  resize(_cols: number, _rows: number): void {
    // Telnet 协议默认不支持终端尺寸调整，静默处理
  }

  setOutputPaused(paused: boolean): void {
    this.outputPaused = paused
    if (paused) this.socket?.pause()
    else this.socket?.resume()
  }
}
