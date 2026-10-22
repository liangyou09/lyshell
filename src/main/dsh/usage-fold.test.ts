import { describe, expect, it } from 'vitest'
import { foldDshSessionEvents, seededPrefixEnd } from './usage-fold'
import type { DshSessionEvent } from './session-log'

const DAY = 24 * 60 * 60 * 1000

function message(
  turn: number,
  step: number,
  usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
  options: { time?: number; provider?: string; model?: string } = {}
): DshSessionEvent {
  return {
    type: 'assistant/message',
    time: options.time ?? 1_700_000_000_000,
    data: {
      turn,
      step,
      message: {
        role: 'assistant',
        source: { kind: 'model', provider: options.provider ?? 'deepseek-official', model: options.model ?? 'deepseek-flash' }
      },
      usage: {
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead ?? 0,
        cacheWriteTokens: usage.cacheWrite ?? 0,
        totalTokens: usage.input + usage.output + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
      }
    }
  }
}

function header(overrides: Partial<DshSessionEvent> = {}): DshSessionEvent {
  return { type: 'session', version: 4, id: 'session-1', cwd: 'D:/workspace/claude/LyShell', createdAt: 1, isSeeded: false, ...overrides }
}

describe('foldDshSessionEvents', () => {
  it('四桶直接取自 usage，不把缓存读混进未命中输入', () => {
    const folded = foldDshSessionEvents([header(), message(1, 1, { input: 762, output: 583, cacheRead: 18432 })])
    expect(folded.tokens).toEqual({ uncachedInput: 762, cacheRead: 18432, cacheWrite: 0, output: 583 })
    expect(folded.requests).toBe(1)
  })

  it('同一 turn/step 的多条 usage 是替换而不是追加（重试/重复落盘不重复计费）', () => {
    const folded = foldDshSessionEvents([
      header(),
      message(1, 1, { input: 100, output: 10 }),
      message(1, 1, { input: 200, output: 20 })
    ])
    expect(folded.tokens).toEqual({ uncachedInput: 200, cacheRead: 0, cacheWrite: 0, output: 20 })
    expect(folded.requests).toBe(1)
    expect(folded.routes.get('deepseek-official/deepseek-flash')).toEqual({
      tokens: { uncachedInput: 200, cacheRead: 0, cacheWrite: 0, output: 20 },
      offPeakTokens: { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      requests: 1
    })
  })

  it('llm/retry-started 清空同槽位：重试的另一次尝试要累加两份', () => {
    const folded = foldDshSessionEvents([
      header(),
      message(2, 78, { input: 100, output: 10 }),
      { type: 'llm/retry-started', data: { retryId: 'r1', turn: 2, step: 78, retry: 1 } },
      message(2, 78, { input: 200, output: 20 })
    ])
    expect(folded.tokens).toEqual({ uncachedInput: 300, cacheRead: 0, cacheWrite: 0, output: 30 })
    expect(folded.requests).toBe(2)
  })

  it('不同 turn/step 累加，并统计 turn/start 的轮次', () => {
    const folded = foldDshSessionEvents([
      header(),
      { type: 'turn/start', data: { turn: 1 } },
      message(1, 1, { input: 100, output: 10 }),
      message(1, 2, { input: 50, output: 5 }),
      { type: 'turn/start', data: { turn: 2 } },
      message(2, 1, { input: 10, output: 1 })
    ])
    expect(folded.tokens).toEqual({ uncachedInput: 160, cacheRead: 0, cacheWrite: 0, output: 16 })
    expect(folded.requests).toBe(3)
    expect(folded.turns).toBe(2)
  })

  it('isSeeded 会话跳过 inherited 种子前缀，避免与父会话重复计费', () => {
    const events: DshSessionEvent[] = [
      header({ isSeeded: true }),
      message(1, 1, { input: 999, output: 999 }),
      { type: 'session/end-seed', data: { inherited: true } },
      message(2, 1, { input: 10, output: 2 })
    ]
    expect(seededPrefixEnd(events)).toBe(3)
    const folded = foldDshSessionEvents(events)
    expect(folded.tokens).toEqual({ uncachedInput: 10, cacheRead: 0, cacheWrite: 0, output: 2 })
  })

  it('没有 inherited 标记的 end-seed 不当作继承边界', () => {
    const events: DshSessionEvent[] = [
      header({ isSeeded: true }),
      message(1, 1, { input: 10, output: 2 }),
      { type: 'session/end-seed', data: {} }
    ]
    expect(seededPrefixEnd(events)).toBe(0)
    expect(foldDshSessionEvents(events).tokens.uncachedInput).toBe(10)
  })

  it('按事件时间分天，跨天会话不会被整天算进同一天', () => {
    const start = new Date(2026, 0, 1, 23, 0, 0).getTime()
    const folded = foldDshSessionEvents([
      header(),
      message(1, 1, { input: 10, output: 1 }, { time: start }),
      message(2, 1, { input: 20, output: 2 }, { time: start + DAY })
    ])
    expect([...folded.byDay.keys()]).toEqual(['2026-01-01', '2026-01-02'])
    expect(folded.byDay.get('2026-01-01')?.tokens.uncachedInput).toBe(10)
    expect(folded.byDay.get('2026-01-02')?.tokens.uncachedInput).toBe(20)
  })

  it('按 provider/model 归路由；没有模型信息时退到最后一次 selection，再退到 unknown', () => {
    const folded = foldDshSessionEvents([
      header(),
      { type: 'model/selection', data: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } },
      {
        type: 'assistant/message',
        time: 1,
        data: { turn: 1, step: 1, usage: { inputTokens: 5, outputTokens: 1 } }
      }
    ])
    expect(folded.routes.get('deepseek-official/deepseek-v4-pro')?.requests).toBe(1)

    const unknown = foldDshSessionEvents([
      header(),
      { type: 'assistant/message', time: 1, data: { turn: 1, step: 1, usage: { inputTokens: 5, outputTokens: 1 } } }
    ])
    expect(unknown.routes.get('unknown/unknown')?.requests).toBe(1)
  })

  it('没有 usage 的事件不计请求数（不能把空读数当零消耗的请求）', () => {
    const folded = foldDshSessionEvents([
      header(),
      { type: 'assistant/message', time: 1, data: { turn: 1, step: 1, message: { source: { kind: 'model', provider: 'p', model: 'm' } } } }
    ])
    expect(folded.requests).toBe(0)
    expect(folded.tokens).toEqual({ uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 })
  })
})

/** 官方流式落盘的 usage 形状：一串 chunk，最后一条 `chunk.type === 'usage'` 才是最终读数 */
function usageChunk(usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number }): unknown {
  return {
    type: 'chunk',
    chunk: {
      type: 'usage',
      usage: {
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead ?? 0,
        cacheWriteTokens: usage.cacheWrite ?? 0,
        totalTokens: usage.input + usage.output + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
      }
    }
  }
}

describe('流式事件里的 usage（官方 usageOf）', () => {
  it('assistant/message 只有 data.stream 时也要读到 usage，不能整段记成 0', () => {
    const folded = foldDshSessionEvents([
      header(),
      {
        type: 'assistant/message',
        time: 1,
        data: {
          turn: 1,
          step: 1,
          message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } },
          stream: [
            { type: 'chunk', chunk: { type: 'delta', text: 'hi' } },
            usageChunk({ input: 1000, output: 20, cacheRead: 200 })
          ]
        }
      }
    ])
    expect(folded.requests).toBe(1)
    expect(folded.tokens).toEqual({ uncachedInput: 1000, cacheRead: 200, cacheWrite: 0, output: 20 })
    expect(folded.routes.get('deepseek-official/deepseek-flash')?.requests).toBe(1)
  })

  it('多个 usage chunk 取最后一个（反向扫描的第一条）', () => {
    const folded = foldDshSessionEvents([
      header(),
      {
        type: 'assistant/message',
        time: 1,
        data: {
          turn: 1,
          step: 1,
          stream: [usageChunk({ input: 1000, output: 10 }), usageChunk({ input: 2000, output: 30 })]
        }
      }
    ])
    expect(folded.tokens).toEqual({ uncachedInput: 2000, cacheRead: 0, cacheWrite: 0, output: 30 })
  })

  it('data.usage 存在时优先用它，与官方一致（即使 stream 里也有）', () => {
    const event = message(1, 1, { input: 5, output: 1 })
    const withStream: DshSessionEvent = {
      ...event,
      data: { ...event.data, stream: [usageChunk({ input: 999, output: 999 })] }
    }
    const folded = foldDshSessionEvents([header(), withStream])
    expect(folded.tokens).toEqual({ uncachedInput: 5, cacheRead: 0, cacheWrite: 0, output: 1 })
  })

  it('assistant/attempt 的流式 usage 同样计入', () => {
    const folded = foldDshSessionEvents([
      header(),
      {
        type: 'assistant/attempt',
        time: 1,
        data: { turn: 1, step: 1, stream: [usageChunk({ input: 300, output: 3 })] }
      }
    ])
    expect(folded.requests).toBe(1)
    expect(folded.tokens).toEqual({ uncachedInput: 300, cacheRead: 0, cacheWrite: 0, output: 3 })
  })

  it('流里没有 usage chunk 时仍然当没读到（不伪造 0 消耗请求）', () => {
    const folded = foldDshSessionEvents([
      header(),
      {
        type: 'assistant/message',
        time: 1,
        data: { turn: 1, step: 1, stream: [{ type: 'chunk', chunk: { type: 'delta', text: 'hi' } }] }
      }
    ])
    expect(folded.requests).toBe(0)
  })
})

describe('折叠时的时段拆分', () => {
  const peak = 1_700_000_000_000
  const idle = peak + 60_000

  it('把落在空闲时段的那部分单独记下来，且始终是 tokens 的子集', () => {
    const folded = foldDshSessionEvents([
      header(),
      message(1, 1, { input: 100, output: 10 }, { time: peak }),
      message(1, 2, { input: 200, output: 20 }, { time: idle })
    ], { isPeak: (time) => time === peak })
    expect(folded.tokens).toEqual({ uncachedInput: 300, cacheRead: 0, cacheWrite: 0, output: 30 })
    expect(folded.offPeakTokens).toEqual({ uncachedInput: 200, cacheRead: 0, cacheWrite: 0, output: 20 })
    expect(folded.routes.get('deepseek-official/deepseek-flash')?.offPeakTokens).toEqual({
      uncachedInput: 200,
      cacheRead: 0,
      cacheWrite: 0,
      output: 20
    })
  })

  it('同槽替换时把上一笔的空闲归属一起减掉，不留幽灵折扣', () => {
    const folded = foldDshSessionEvents([
      header(),
      message(1, 1, { input: 100, output: 10 }, { time: peak }),
      message(1, 1, { input: 300, output: 30 }, { time: idle })
    ], { isPeak: (time) => time === peak })
    expect(folded.tokens).toEqual({ uncachedInput: 300, cacheRead: 0, cacheWrite: 0, output: 30 })
    // 后一条落在空闲时段：整个槽位替换成「300 全空闲」，不是「100 空闲 + 300 高峰」
    expect(folded.offPeakTokens).toEqual({ uncachedInput: 300, cacheRead: 0, cacheWrite: 0, output: 30 })
  })

  it('不传 isPeak 就一律算高峰，不会凭空出现折扣', () => {
    const folded = foldDshSessionEvents([header(), message(1, 1, { input: 100, output: 10 }, { time: idle })])
    expect(folded.offPeakTokens).toEqual({ uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 })
  })
})
