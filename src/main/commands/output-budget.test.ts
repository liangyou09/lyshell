import { describe, expect, it } from 'vitest'
import { OperationError } from '@shared/operation'
import {
  CommandOutputBudget,
  DEFAULT_OUTPUT_BUDGET_LIMITS,
  jsonEscapedBytes,
  utf8Bytes
} from './output-budget'

describe('UTF-8 与 JSON 转义字节', () => {
  it('按 UTF-8 计算多字节内容', () => {
    expect(utf8Bytes('abc')).toBe(3)
    expect(utf8Bytes('中文')).toBe(6)
    expect(utf8Bytes('😀')).toBe(4)
  })

  it('转义引号/反斜杠/控制字符并展开 JSON 预算', () => {
    expect(jsonEscapedBytes('a"b\\c')).toBe(2 + 1 + 2 + 1 + 1)
    expect(jsonEscapedBytes('\n')).toBe(2)
    expect(jsonEscapedBytes('\t')).toBe(2)
    expect(jsonEscapedBytes('\u0001')).toBe(6)
    expect(jsonEscapedBytes('中')).toBe(3)
    expect(jsonEscapedBytes('😀')).toBe(4)
  })

  it('孤立代理项按 6 字节计，不产生非法 JSON 预算', () => {
    expect(jsonEscapedBytes('\ud800')).toBe(6)
    expect(jsonEscapedBytes('\udc00')).toBe(6)
    expect(jsonEscapedBytes('\ud800\udc00')).toBe(4)
  })
})

describe('保留与发送预算', () => {
  it('批次/全局保留上限整体拒绝，不部分记账', () => {
    const budget = new CommandOutputBudget({ batchBytes: 10, globalBytes: 12, sendBytes: 100 })
    budget.reserveRetained('b1', 8)
    expect(budget.retainedBytes).toBe(8)
    expect(() => budget.reserveRetained('b1', 3)).toThrowError(/batch max 10 bytes/)
    expect(budget.retainedBytes).toBe(8)
    budget.reserveRetained('b2', 4)
    expect(budget.retainedBytes).toBe(12)
    expect(() => budget.reserveRetained('b2', 1)).toThrowError(/global max 12 bytes/)
    expect(budget.retainedBytes).toBe(12)
  })

  it('release 幂等，按 owner 释放', () => {
    const budget = new CommandOutputBudget({ batchBytes: 100, globalBytes: 100, sendBytes: 100 })
    budget.reserveRetained('b1', 10)
    budget.reserveRetained('b2', 20)
    budget.releaseRetained('b1')
    budget.releaseRetained('b1')
    expect(budget.retainedBytes).toBe(20)
    expect(budget.retainedBytesFor('b2')).toBe(20)
    expect(budget.retainedOwners).toBe(1)
  })

  it('单目标失败可归还其字节，其余结果继续占用', () => {
    const budget = new CommandOutputBudget({ batchBytes: 100, globalBytes: 100, sendBytes: 100 })
    budget.reserveRetained('batch', 30)
    budget.reserveRetained('batch', 30)
    budget.releaseRetainedBytes('batch', 30)
    expect(budget.retainedBytesFor('batch')).toBe(30)
    expect(budget.retainedBytes).toBe(30)
  })

  it('发送预算按转义后字节拒绝，释放后恢复', () => {
    const budget = new CommandOutputBudget({ sendBytes: 8 })
    budget.reserveSend('r1', 6)
    expect(() => budget.reserveSend('r2', 4)).toThrowError(/send max 8 bytes/)
    budget.releaseSend('r1')
    budget.releaseSend('r1')
    expect(budget.sendBytes).toBe(0)
    budget.reserveSend('r2', 8)
    expect(budget.sendBytes).toBe(8)
  })

  it('OperationError 携带 RESOURCE_LIMIT 且不自动重试', () => {
    const budget = new CommandOutputBudget({ batchBytes: 1, globalBytes: 1, sendBytes: 1 })
    try {
      budget.reserveRetained('b', 2)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(OperationError)
      const operation = error as OperationError
      expect(operation.code).toBe('RESOURCE_LIMIT')
      expect(operation.retryDisposition).toBe('never')
    }
  })

  it('默认上限与 COMMAND_LIMITS 对齐（8/32/64 MiB）', () => {
    expect(DEFAULT_OUTPUT_BUDGET_LIMITS).toEqual({
      batchBytes: 8 * 1024 * 1024,
      globalBytes: 32 * 1024 * 1024,
      sendBytes: 64 * 1024 * 1024
    })
  })
})
