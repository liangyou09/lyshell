import { describe, expect, it, vi } from 'vitest'
import { OperationError } from '@shared/operation'
import {
  CommandOutputCollector,
  CommandOutputLimitError,
  MAX_COMMAND_OUTPUT_CHARS,
  MAX_PARTIAL_OUTPUT_CHARS
} from './command-output'

describe('CommandOutputCollector', () => {
  it('stdout/stderr 独立解码，跨分片 UTF-8 不截断', () => {
    const collector = new CommandOutputCollector()
    const bytes = Buffer.from('中文')
    collector.writeStdout(bytes.subarray(0, 1))
    collector.writeStderr(Buffer.from('err'))
    expect(collector.output).toBe('err')
    collector.writeStdout(bytes.subarray(1))
    collector.endStdout()
    collector.endStderr()
    expect(collector.output).toBe('err中文')
    expect(collector.charCount).toBe(5)
    expect(collector.encodedBytes).toBe(Buffer.byteLength('err中文'))
  })

  it('增量回调只推送通过上限与预算的内容', () => {
    const chunks: string[] = []
    const collector = new CommandOutputCollector({ onData: chunk => chunks.push(chunk) })
    collector.append('a')
    collector.append('b')
    expect(chunks).toEqual(['a', 'b'])
    expect(collector.streamedChars).toBe(2)
  })

  it('字符上限抛 RESOURCE_LIMIT，部分结果只进 partialOutput', () => {
    const collector = new CommandOutputCollector({ maxChars: 5 })
    collector.append('abc')
    let caught: unknown
    try {
      collector.append('def')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(CommandOutputLimitError)
    expect(caught).toBeInstanceOf(OperationError)
    expect((caught as OperationError).code).toBe('RESOURCE_LIMIT')
    expect((caught as Error).message).toContain('max 5 chars')
    expect((caught as CommandOutputLimitError).partialOutput).toBe('abc')
    expect(collector.output).toBe('abc')
  })

  it('预算超限转成带 partialOutput 的 RESOURCE_LIMIT，且不再接收后续内容', () => {
    let remaining = 5
    const collector = new CommandOutputCollector({
      reserveBytes: delta => {
        if (delta > remaining) throw new OperationError('RESOURCE_LIMIT', 'Command output limit exceeded (global max 5 bytes)', 'never')
        remaining -= delta
      }
    })
    collector.append('abc')
    let caught: unknown
    try {
      collector.append('def')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(CommandOutputLimitError)
    expect((caught as OperationError).message).toContain('global max 5 bytes')
    expect((caught as CommandOutputLimitError).partialOutput).toBe('abc')
    collector.append('late')
    expect(collector.output).toBe('abc')
  })

  it('诊断片段有界，不复制超大结果', () => {
    const collector = new CommandOutputCollector({ maxChars: MAX_PARTIAL_OUTPUT_CHARS + 10 })
    collector.append('x'.repeat(MAX_PARTIAL_OUTPUT_CHARS + 5))
    expect(collector.partialOutput).toHaveLength(MAX_PARTIAL_OUTPUT_CHARS)
  })

  it('默认上限仍是 1 Mi 字符，兼容旧语义', () => {
    expect(MAX_COMMAND_OUTPUT_CHARS).toBe(1024 * 1024)
    const collector = new CommandOutputCollector()
    collector.append('x'.repeat(MAX_COMMAND_OUTPUT_CHARS - 1))
    expect(() => collector.append('yy')).toThrowError(/max 1048576 chars/)
  })

  it('预算回调只调用一次并收到实际字节增量', () => {
    const reserve = vi.fn()
    const collector = new CommandOutputCollector({ reserveBytes: reserve })
    collector.append('中')
    collector.append('a')
    expect(reserve.mock.calls).toEqual([[3], [1]])
  })
})
