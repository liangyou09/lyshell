import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createLogTap } from './log-throttle'

describe('createLogTap', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('窗口内放行 maxLines 条，超量抑制不落 sink', () => {
    const lines: string[] = []
    const tap = createLogTap((l) => lines.push(l), { windowMs: 10_000, maxLines: 3 })
    for (let i = 0; i < 5; i++) tap(`line-${i}`)
    expect(lines).toEqual(['line-0', 'line-1', 'line-2'])
    expect(tap.suppressedCount()).toBe(2)
  })

  it('窗口滚动时汇总一条抑制摘要，随后重新放行', () => {
    const lines: string[] = []
    const tap = createLogTap((l) => lines.push(l), { windowMs: 10_000, maxLines: 1 })
    tap('a')
    tap('b') // 抑制
    vi.advanceTimersByTime(10_001)
    // 摘要在下一条日志到来时惰性输出（窗口滚动发生在 tap 入口）
    tap('c')
    expect(lines).toEqual(['a', '[log-tap] 过去 10s 抑制了 1 条刷屏日志', 'c'])
  })

  it('单条超长截断', () => {
    const lines: string[] = []
    const tap = createLogTap((l) => lines.push(l), { maxChars: 10 })
    tap('x'.repeat(50))
    expect(lines[0]).toHaveLength(15) // 10 字符 + '…[截断]' 5 字符
    expect(lines[0]!.startsWith('x'.repeat(10))).toBe(true)
  })
})
