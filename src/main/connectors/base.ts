import { EventEmitter } from 'events'
import log from 'electron-log'

/**
 * 连接器基类
 * 所有连接器（SSH、Telnet、Serial）继承此类
 */
export abstract class BaseConnector extends EventEmitter {
  protected sessionId: string
  protected connected: boolean = false

  constructor(sessionId: string) {
    super()
    this.sessionId = sessionId
  }

  /**
   * 连接
   */
  abstract connect(config: unknown): Promise<void>

  /**
   * 断开连接
   */
  abstract disconnect(): Promise<void>

  /**
   * 写入数据
   */
  abstract write(data: string | Buffer): void

  /**
   * 调整终端尺寸
   */
  abstract resize(cols: number, rows: number): void

  /**
   * 获取连接状态
   */
  isConnected(): boolean {
    return this.connected
  }

  /**
   * 获取会话ID
   */
  getSessionId(): string {
    return this.sessionId
  }

  /**
   * 发送数据事件
   */
  protected emitData(data: string): void {
    this.emit('data', data)
  }

  /**
   * 发送错误事件
   */
  protected emitError(error: Error): void {
    this.emit('error', error)
  }

  /**
   * 发送关闭事件
   */
  protected emitClose(): void {
    this.emit('close')
  }
}

/**
 * 连接状态
 */
export enum ConnectionStatus {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting',
  ERROR = 'error'
}

/**
 * 连接类型
 */
export enum ConnectionType {
  SSH = 'ssh',
  TELNET = 'telnet',
  SERIAL = 'serial',
  LOCAL = 'local'
}