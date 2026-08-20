/**
 * 终端输出缓冲区
 * 捕获会话的 terminal:data 事件，提供最近输出读取与增量输出读取能力
 * 原始数据（含 ANSI）原样存储，读取时按需清洗
 */

import { stripAnsiToText } from './ansi-stripper'

const DEFAULT_MAX_BYTES = 1024 * 1024 // 1MB

export interface RecentOutputResult {
  text: string
  lines: number
}

export interface SinceOutputResult {
  text: string
  cursor: number
  truncated: boolean // 游标已被回收，返回了从最早可用位置开始的内容
}

export class OutputBuffer {
  /** 原始数据缓冲（含 ANSI 转义码） */
  private buffer = ''
  /** 已被回收的字节数（buffer 字符串起点对应的绝对偏移） */
  private baseOffset = 0
  /** 已写入的总字节数（绝对游标） */
  private writeCursor = 0
  /** 最近一次写入时间戳（ms） */
  private lastDataTime = 0
  /** 最大缓冲字节 */
  private maxBytes: number

  constructor(maxBytes: number = DEFAULT_MAX_BYTES) {
    this.maxBytes = maxBytes
  }

  /**
   * 追加原始终端数据
   */
  append(data: string): void {
    if (!data) return
    this.buffer += data
    this.writeCursor += data.length
    this.lastDataTime = Date.now()

    // 超过上限时从头部回收
    if (this.buffer.length > this.maxBytes) {
      const drop = this.buffer.length - this.maxBytes
      this.buffer = this.buffer.slice(drop)
      this.baseOffset += drop
    }
  }

  /**
   * 当前写入游标（绝对偏移），用于 send_and_wait 记录起点
   */
  getWriteCursor(): number {
    return this.writeCursor
  }

  /**
   * 最近一次数据写入时间戳（ms）
   */
  getLastDataTime(): number {
    return this.lastDataTime
  }

  /**
   * 获取最近 N 行（按 \n 分割）
   * @param count 行数
   * @param stripAnsi 是否清洗 ANSI（默认 true）
   */
  getRecentLines(count: number, stripAnsi: boolean = true): RecentOutputResult {
    const source = stripAnsi ? stripAnsiToText(this.buffer) : this.buffer
    const allLines = source.split('\n')
    // 去除末尾因结尾 \n 产生的空串
    if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
      allLines.pop()
    }
    const start = Math.max(0, allLines.length - count)
    const lines = allLines.slice(start)
    return { text: lines.join('\n'), lines: lines.length }
  }

  /**
   * 获取从指定游标之后的所有新增输出
   * @param cursor 起始游标（getWriteCursor 返回值）
   * @param stripAnsi 是否清洗 ANSI（默认 true）
   */
  getOutputSince(cursor: number, stripAnsi: boolean = true): SinceOutputResult {
    let start: number
    let truncated = false

    if (cursor < this.baseOffset) {
      // 游标已被回收，从最早可用位置开始
      start = 0
      truncated = true
    } else {
      start = cursor - this.baseOffset
      if (start < 0) start = 0
      if (start > this.buffer.length) start = this.buffer.length
    }

    const raw = this.buffer.slice(start)
    const text = stripAnsi ? stripAnsiToText(raw) : raw
    return { text, cursor: this.writeCursor, truncated }
  }

  /**
   * 清空缓冲区
   */
  clear(): void {
    this.buffer = ''
    this.baseOffset = 0
    this.writeCursor = 0
  }

  /**
   * 当前缓冲字节大小
   */
  size(): number {
    return this.buffer.length
  }
}
