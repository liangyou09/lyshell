/**
 * 共享输出协议常量与类型的不变量测试。
 * 这些值是“可调候选值”，集中在这里声明；测试只锁定它们之间的关系，
 * 避免调大/调小时出现低水位高于高水位、单消费者上限超过全局预算之类的矛盾配置。
 */

import { describe, expect, it } from 'vitest'
import {
  TERMINAL_OUTPUT_ACK_TIMEOUT_MS,
  TERMINAL_OUTPUT_HARD_MAX_RESPONSE_CHARS,
  TERMINAL_OUTPUT_HIGH_WATER,
  TERMINAL_OUTPUT_HISTORY_LIMIT,
  TERMINAL_OUTPUT_HISTORY_TOTAL_BUDGET,
  TERMINAL_OUTPUT_LOW_WATER,
  TERMINAL_OUTPUT_MAX_CONSUMERS,
  TERMINAL_OUTPUT_MAX_PENDING,
  TERMINAL_OUTPUT_MAX_RESPONSE_CHARS,
  TERMINAL_OUTPUT_PACKET_SIZE,
  TERMINAL_OUTPUT_TOTAL_QUEUE_BUDGET,
  type TerminalOutputReadResult,
  type TerminalOutputReceipt,
  type TerminalOutputReceiptError
} from '@shared/terminal-output'

describe('终端输出协议常量', () => {
  it('水位与帧大小保持单调关系', () => {
    expect(TERMINAL_OUTPUT_LOW_WATER).toBeGreaterThan(0)
    expect(TERMINAL_OUTPUT_LOW_WATER).toBeLessThan(TERMINAL_OUTPUT_HIGH_WATER)
    expect(TERMINAL_OUTPUT_HIGH_WATER).toBeLessThanOrEqual(TERMINAL_OUTPUT_MAX_PENDING)
    expect(TERMINAL_OUTPUT_PACKET_SIZE).toBeGreaterThan(0)
    expect(TERMINAL_OUTPUT_PACKET_SIZE).toBeLessThanOrEqual(TERMINAL_OUTPUT_LOW_WATER)
  })

  it('全局队列预算容纳至少一个满额消费者，且消费者数量为正', () => {
    expect(TERMINAL_OUTPUT_MAX_CONSUMERS).toBeGreaterThan(0)
    expect(TERMINAL_OUTPUT_TOTAL_QUEUE_BUDGET).toBeGreaterThanOrEqual(TERMINAL_OUTPUT_MAX_PENDING)
    expect(Number.isSafeInteger(TERMINAL_OUTPUT_TOTAL_QUEUE_BUDGET)).toBe(true)
  })

  it('ACK 超时是正的有限毫秒值', () => {
    expect(TERMINAL_OUTPUT_ACK_TIMEOUT_MS).toBeGreaterThan(0)
    expect(Number.isFinite(TERMINAL_OUTPUT_ACK_TIMEOUT_MS)).toBe(true)
  })

  it('增量读响应上限不超过硬上限，且单缓冲容量不超过全局历史预算', () => {
    expect(TERMINAL_OUTPUT_MAX_RESPONSE_CHARS).toBeGreaterThan(0)
    expect(TERMINAL_OUTPUT_MAX_RESPONSE_CHARS).toBeLessThanOrEqual(TERMINAL_OUTPUT_HARD_MAX_RESPONSE_CHARS)
    expect(TERMINAL_OUTPUT_HISTORY_LIMIT).toBeLessThanOrEqual(TERMINAL_OUTPUT_HISTORY_TOTAL_BUDGET)
    // 单个缓冲不能一次占满全局预算，否则第二个会话创建即超限。
    expect(TERMINAL_OUTPUT_HISTORY_TOTAL_BUDGET / TERMINAL_OUTPUT_HISTORY_LIMIT).toBeGreaterThanOrEqual(2)
  })
})

describe('终端输出协议类型', () => {
  it('回执错误码覆盖六类可识别失败', () => {
    const errors: TerminalOutputReceiptError[] = [
      'overflow',
      'queue-budget',
      'ack-timeout',
      'consumer-limit',
      'send-failed',
      'disposed'
    ]
    expect(new Set(errors).size).toBe(6)

    const receipt: TerminalOutputReceipt = {
      subscriptionId: 'sub-1',
      sequence: 3,
      error: 'ack-timeout'
    }
    expect(receipt.error).toBe('ack-timeout')
  })

  it('增量读结果同时暴露代际、游标、缺口与截断标记', () => {
    const result: TerminalOutputReadResult = {
      ok: true,
      text: '中文😀',
      outputEpoch: 7,
      cursor: 0,
      earliestCursor: 0,
      latestCursor: 4,
      nextCursor: 4,
      responseTruncated: false,
      maxChars: 64 * 1024
    }
    // 文本按 UTF-16 代码单元计量：'中文' 2 + emoji 2 = 4，而不是 UTF-8 的 10 字节。
    expect(result.text.length).toBe(4)
    expect(result.latestCursor).toBe(result.text.length)
    expect(result.historyGap).toBeUndefined()
  })
})
