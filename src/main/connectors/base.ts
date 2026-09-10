import { EventEmitter } from 'events'
import log from 'electron-log'
import iconv from 'iconv-lite'
import type { TerminalEncoding } from '@shared/types'

/**
 * 连接器基类
 * 所有连接器（SSH、Telnet、Serial）继承此类
 */
export abstract class BaseConnector extends EventEmitter {
  protected sessionId: string
  protected connected: boolean = false
  /** 运行时编码 —— 解码流与写方向编码的唯一来源；构造时由协议 config.encoding 派生，切档走 setEncoding */
  protected encoding: TerminalEncoding
  /** 流式解码器 —— ssh/telnet/serial 按 encoding 解码；local 恒为 null */
  protected decoder: ReturnType<typeof iconv.decodeStream> | null = null

  constructor(sessionId: string, encoding: TerminalEncoding = 'utf-8') {
    super()
    this.sessionId = sessionId
    this.encoding = encoding
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
   * 重建解码流（连接建流与运行时切档共用）：旧流先 end() 收尾 —— 半截多字节序列
   * 以替换字符吐出（而非随旧对象静默丢弃），流也不悬挂；再按当前 encoding 建新流。
   * data 回调按写入时取 decoder 引用，换掉对象后新字节自然走新流。
   */
  protected replaceDecoder(): void {
    if (this.decoder) {
      try { this.decoder.end() } catch { /* ignore */ }
    }
    const dec = iconv.decodeStream(this.encoding)
    dec.on('data', (str: string) => this.emitData(str))
    dec.on('error', (err: Error) => log.warn(`Decode stream error (${this.sessionId}):`, err))
    this.decoder = dec
  }

  /**
   * 运行时切换编码（状态栏点击）：记录新值并重建解码流。
   * 同值短路：值没变不重建 —— replaceDecoder 的 end() 会把半截多字节序列冲成替换
   * 字符，「切回当前档」不该在终端里多落一个 �（sessionManager.setSessionEncoding
   * 已有一层短路，这里兜住绕过它的调法，如恢复路径 config 先被 updateSession 冲掉、
   * 再以 connector 当前值重设）。
   * LocalConnector 覆盖为空实现（ConPTY 恒为 UTF-8，无编码概念）。
   */
  setEncoding(encoding: TerminalEncoding): void {
    if (this.encoding === encoding) return
    this.encoding = encoding
    this.replaceDecoder()
  }

  /**
   * 当前运行时编码 —— 连接刷新路径（connection:connect 对已存在会话 updateSession
   * 整体替换 terminal 段后）以 connector 为准恢复被冲掉的运行时切换值。
   */
  getEncoding(): TerminalEncoding {
    return this.encoding
  }

  /**
   * 写方向编码：utf-8 时字符串原样（Node 写入即按 UTF-8 编码，行为不变），
   * gbk/gb2312 时转成对应字节 —— 保证 GBK 设备上输入中文不乱码，与读方向对称。
   */
  protected encodeOut(data: string | Buffer): string | Buffer {
    if (typeof data !== 'string' || this.encoding === 'utf-8') return data
    return iconv.encode(data, this.encoding)
  }

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