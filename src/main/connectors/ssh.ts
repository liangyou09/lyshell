import { Client, ClientChannel } from 'ssh2'
import type { ConnectConfig } from 'ssh2'
import log from 'electron-log'
import { BaseConnector } from './base'
import type { TerminalEncoding } from '@shared/types'

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
}

/**
 * SSH 连接器
 */
export class SSHConnector extends BaseConnector {
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

  constructor(sessionId: string, config: SSHConfig) {
    super(sessionId, config.encoding)
    this.config = config
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

    log.info(`SSH connecting to ${this.config.host}:${this.config.port}`)

    const client = new Client()
    this.retainClient(client)
    this._connecting = true

    const onReady = () => {
      if (this.client !== client) return
      log.info('SSH connection ready')
      this._connecting = false
      this._connectReject = null
      this.connected = true
      this.emit('connected')

      // 每个连接单独一个流式解码器
      this.replaceDecoder()

      // 启动 shell
      this.startShell()
    }

    const onError = (err: Error) => {
      if (this.client !== client) return
      // 提取关键错误信息（去掉堆栈）
      const errMsg = err.message?.split('\n')[0]?.replace(/^Error:\s*/, '') || err.toString()
      log.error(`SSH connection error: ${errMsg}`)
      this._connectReject?.(err)
      this._connecting = false
      this._connectReject = null
      this.connected = false
      this.emitError(err)
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
    const connectionConfig: ConnectConfig = {
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      readyTimeout: this.config.readyTimeout || 30000, // 同 upload/download worker 的默认值，慢握手服务器(如 UseDNS 超时)10 秒不够
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
      const ready = () => {
        client.off('ready', ready)
        this._connectReject = null
        resolve()
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
      const channel = this.channel
      this.channel = null
      channel.close()
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
