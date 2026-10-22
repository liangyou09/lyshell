/**
 * 会话事件的用量折叠 —— 逐字复刻 `@deepseek-ai/dsh-token-meter` 的 `usage-projection` 语义。
 *
 * 为什么不能简单求和：一次 LLM 调用在日志里可能落**多条**带 usage 的
 * `assistant/message`（流式落盘 + 重试另起一次尝试），dsh 的投影对同一
 * `turn/step` 槽位做「替换」而不是「追加」—— 所以这里也必须维护一个 `last` 槽位：
 *
 * - `llm/retry-started` 且槽位相同 → 清空 `last`（新的尝试要重新累加，不能把上一次当同槽替换）；
 * - 带 usage 的事件：`assistant/message` 有 `data.usage` 就用它，否则反向扫 `data.stream` 的
 *   usage chunk（官方 `usageOf` 的行为）—— 只读 `data.usage` 会把流式落盘的会话整段记成 0；
 * - 带 usage 的事件：若 `last` 的 turn/step 与它相同 → 先从总量里**减掉**上一次的桶再相加；
 * - 四个桶互斥（`inputTokens` 只是未缓存输入，缓存读/写在 `cacheReadTokens`/`cacheWriteTokens`；
 *   本机 5144 条带缓存的事件里 5051 条满足 `totalTokens = input + output + cacheRead + cacheWrite`）。
 *
 * 另外按事件时间分天（`byDay`）并把用量归属到路由（`provider/model`），
 * 这样「本次会话」与「今日累计」共用一个折叠结果，不需要读两遍日志。
 *
 * 第三层是**时段**：DeepSeek 的空闲时段单价是高峰的一半，同一个路由的两笔 token 可能价不同。
 * 判定规则在 `tariff.ts`，这里只接收一个 `isPeak(time)` 判定并把每个桶拆成「全量 + 其中空闲那部分」
 * （空闲桶是子集，不是另一半，这样总量始终能直接相加）。
 *
 * 种子前缀：`isSeeded` 会话的日志里包含父会话的事件回放，`session/end-seed` 且
 * `data.inherited === true` 标记继承段的结尾。这段消耗发生在父会话里，必须跳过，
 * 否则父子两代都会把同一笔消耗记一遍。
 */
import {
  addDshTokenBuckets,
  emptyDshTokenBuckets,
  localDayKey,
  subtractDshTokenBuckets,
  type DshTokenBuckets
} from '@shared/dsh-usage'
import type { DshSessionEvent } from './session-log'

export interface DshRouteAccumulator {
  tokens: DshTokenBuckets
  /** 其中落在空闲时段的部分（`tokens` 的子集） */
  offPeakTokens: DshTokenBuckets
  requests: number
}

export interface DshDayUsage {
  tokens: DshTokenBuckets
  offPeakTokens: DshTokenBuckets
  requests: number
  turns: number
  routes: Map<string, DshRouteAccumulator>
}

export interface DshFoldedSession {
  id: string
  cwd: string | null
  title: string | null
  createdAt: number | null
  isSeeded: boolean
  lastActivityAt: number
  tokens: DshTokenBuckets
  offPeakTokens: DshTokenBuckets
  requests: number
  turns: number
  routes: Map<string, DshRouteAccumulator>
  byDay: Map<string, DshDayUsage>
}

interface UsageSample {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

interface UsageSlot {
  turn: number | null
  step: number | null
  route: string
  day: string
  tokens: DshTokenBuckets
  offPeakTokens: DshTokenBuckets
}

export interface DshFoldOptions {
  /** 这个时刻算不算高峰；不传则一律按高峰（费用口径最保守） */
  isPeak?: (time: number) => boolean
}

interface DayAccumulator {
  tokens: DshTokenBuckets
  offPeakTokens: DshTokenBuckets
  requests: number
  turns: Set<number>
  routes: Map<string, DshRouteAccumulator>
}

function finiteCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * 官方 `lastAssistantStreamChunk(stream, 'usage')`：从后往前找最后一条
 * `{ type: 'chunk', chunk: { type: 'usage', usage } }`。
 *
 * 流式回复的 usage 是随流落的，`assistant/message` 上并不一定有 `data.usage`；
 * 只读 `data.usage` 会把这类会话整段记成 0 消耗（官方投影能读到，LyShell 读不到）。
 */
function lastStreamUsage(stream: unknown): Record<string, unknown> | null {
  if (!Array.isArray(stream)) return null
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (!record || typeof record !== 'object') continue
    const { type, chunk } = record as { type?: unknown; chunk?: unknown }
    if (type !== 'chunk' || !chunk || typeof chunk !== 'object') continue
    const { type: chunkType, usage } = chunk as { type?: unknown; usage?: unknown }
    if (chunkType !== 'usage') continue
    return usage && typeof usage === 'object' ? (usage as Record<string, unknown>) : null
  }
  return null
}

/**
 * 一条事件的 usage 来源，逐字对齐官方 `usageOf`：
 * `assistant/message` 且 `data.usage !== undefined` 时用它（即使格式不对也不回退，与官方一致）；
 * 否则（`assistant/attempt` 或没有 `data.usage` 的 message）反向扫 `data.stream`。
 */
function usageOf(event: DshSessionEvent): Record<string, unknown> | null {
  if (event.type === 'assistant/message' && event.data?.usage !== undefined) {
    const usage = event.data.usage
    return usage && typeof usage === 'object' ? (usage as Record<string, unknown>) : null
  }
  return lastStreamUsage(event.data?.stream)
}

function readUsage(event: DshSessionEvent): UsageSample | null {
  const raw = usageOf(event)
  if (!raw) return null
  const input = finiteCount(raw.inputTokens)
  const output = finiteCount(raw.outputTokens)
  // 没有输入/输出的 usage 无法归属，宁可当没读到（不算 0）
  if (input === null || output === null) return null
  return {
    input,
    output,
    cacheRead: finiteCount(raw.cacheReadTokens) ?? 0,
    cacheWrite: finiteCount(raw.cacheWriteTokens) ?? 0
  }
}

interface ModelRoute {
  route: string
  provider: string
  model: string
}

/** 事件里能确定的模型路由：`assistant/message` 看 `message.source`，`model/selection` 直接给 provider/model。 */
function routeOfEvent(event: DshSessionEvent): ModelRoute | null {
  if (event.type === 'model/selection') {
    const provider = typeof event.data?.provider === 'string' ? event.data.provider : ''
    const model = typeof event.data?.model === 'string' ? event.data.model : ''
    return provider && model ? { route: `${provider}/${model}`, provider, model } : null
  }
  const message = event.data?.message
  if (!message || typeof message !== 'object') return null
  const source = (message as { source?: unknown }).source
  if (!source || typeof source !== 'object') return null
  const { kind, provider, model } = source as { kind?: unknown; provider?: unknown; model?: unknown }
  if (kind !== 'model' || typeof provider !== 'string' || typeof model !== 'string') return null
  return provider && model ? { route: `${provider}/${model}`, provider, model } : null
}

/**
 * 继承前缀的结束位置：`isSeeded` 会话跳过到最后一个 `inherited` 种子事件（含）。
 * 找不到标记时返回 0 —— 宁可多数（与 dsh 自己的投影一致）也不整段丢弃。
 */
export function seededPrefixEnd(events: readonly DshSessionEvent[]): number {
  const header = events.find((event) => event.type === 'session')
  if (!header || header.isSeeded !== true) return 0
  let mark = -1
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event.type === 'session/end-seed' && event.data?.inherited === true) mark = index
  }
  return mark === -1 ? 0 : mark + 1
}

function ensureDay(days: Map<string, DayAccumulator>, day: string): DayAccumulator {
  let entry = days.get(day)
  if (!entry) {
    entry = { tokens: emptyDshTokenBuckets(), offPeakTokens: emptyDshTokenBuckets(), requests: 0, turns: new Set<number>(), routes: new Map() }
    days.set(day, entry)
  }
  return entry
}

function addRoute(
  routes: Map<string, DshRouteAccumulator>,
  route: string,
  tokens: DshTokenBuckets,
  offPeakTokens: DshTokenBuckets,
  requests: number
): void {
  const entry = routes.get(route) ?? { tokens: emptyDshTokenBuckets(), offPeakTokens: emptyDshTokenBuckets(), requests: 0 }
  entry.tokens = addDshTokenBuckets(entry.tokens, tokens)
  entry.offPeakTokens = addDshTokenBuckets(entry.offPeakTokens, offPeakTokens)
  entry.requests += requests
  routes.set(route, entry)
}

function subtractRoute(
  routes: Map<string, DshRouteAccumulator>,
  route: string,
  tokens: DshTokenBuckets,
  offPeakTokens: DshTokenBuckets,
  requests: number
): void {
  const entry = routes.get(route)
  if (!entry) return
  entry.tokens = subtractDshTokenBuckets(entry.tokens, tokens)
  entry.offPeakTokens = subtractDshTokenBuckets(entry.offPeakTokens, offPeakTokens)
  entry.requests -= requests
  if (entry.tokens.uncachedInput === 0 && entry.tokens.cacheRead === 0 && entry.tokens.cacheWrite === 0 && entry.tokens.output === 0 && entry.requests <= 0) {
    routes.delete(route)
  }
}

/** 折叠一个会话的全部事件（只保留用量、轮次、路由与按天拆分）。 */
export function foldDshSessionEvents(events: readonly DshSessionEvent[], options: DshFoldOptions = {}): DshFoldedSession {
  const header = events.find((event) => event.type === 'session')
  const result: DshFoldedSession = {
    id: typeof header?.id === 'string' ? header.id : '',
    cwd: typeof header?.cwd === 'string' ? header.cwd : null,
    title: null,
    createdAt: typeof header?.createdAt === 'number' ? header.createdAt : null,
    isSeeded: header?.isSeeded === true,
    lastActivityAt: 0,
    tokens: emptyDshTokenBuckets(),
    offPeakTokens: emptyDshTokenBuckets(),
    requests: 0,
    turns: 0,
    routes: new Map(),
    byDay: new Map()
  }
  const days = new Map<string, DayAccumulator>()
  const turns = new Set<number>()
  let last: UsageSlot | null = null
  let fallbackRoute: string | null = null
  const startIndex = seededPrefixEnd(events)

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    const time = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : 0
    if (time > result.lastActivityAt) result.lastActivityAt = time
    // 会话元信息（标题/创建时间）来自整段日志，用量只从继承前缀之后开始算
    if (event.type === 'session/title') {
      const title = typeof event.data?.title === 'string' ? event.data.title : ''
      if (title) result.title = title
      continue
    }
    if (index < startIndex) continue

    const route = routeOfEvent(event)
    if (event.type === 'model/selection' && route) {
      fallbackRoute = route.route
      continue
    }
    if (event.type === 'turn/start') {
      const turn = typeof event.data?.turn === 'number' ? event.data.turn : null
      if (turn !== null) {
        turns.add(turn)
        ensureDay(days, localDayKey(time)).turns.add(turn)
      }
      continue
    }
    if (event.type === 'llm/retry-started') {
      // 同槽重试：清空槽位，让新尝试的 usage 全额累加
      const turn = typeof event.data?.turn === 'number' ? event.data.turn : null
      const step = typeof event.data?.step === 'number' ? event.data.step : null
      if (last && last.turn === turn && last.step === step) last = null
      continue
    }
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue

    const usage = readUsage(event)
    if (!usage) continue
    if (route) fallbackRoute = route.route
    const routeKey = route?.route ?? fallbackRoute ?? 'unknown/unknown'
    const turn = typeof event.data?.turn === 'number' ? event.data.turn : null
    const step = typeof event.data?.step === 'number' ? event.data.step : null
    const buckets: DshTokenBuckets = {
      uncachedInput: usage.input,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      output: usage.output
    }
    const day = localDayKey(time)
    // 不传判定就一律当高峰：宁可高估，也不凭空给一个折扣
    const offPeakBuckets = options.isPeak && !options.isPeak(time) ? buckets : emptyDshTokenBuckets()
    const previous = last && last.turn === turn && last.step === step ? last : null
    if (previous) {
      result.tokens = subtractDshTokenBuckets(result.tokens, previous.tokens)
      result.offPeakTokens = subtractDshTokenBuckets(result.offPeakTokens, previous.offPeakTokens)
      result.requests -= 1
      subtractRoute(result.routes, previous.route, previous.tokens, previous.offPeakTokens, 1)
      const previousDay = days.get(previous.day)
      if (previousDay) {
        previousDay.tokens = subtractDshTokenBuckets(previousDay.tokens, previous.tokens)
        previousDay.offPeakTokens = subtractDshTokenBuckets(previousDay.offPeakTokens, previous.offPeakTokens)
        previousDay.requests -= 1
        subtractRoute(previousDay.routes, previous.route, previous.tokens, previous.offPeakTokens, 1)
      }
    }
    result.tokens = addDshTokenBuckets(result.tokens, buckets)
    result.offPeakTokens = addDshTokenBuckets(result.offPeakTokens, offPeakBuckets)
    result.requests += 1
    addRoute(result.routes, routeKey, buckets, offPeakBuckets, 1)
    const dayEntry = ensureDay(days, day)
    dayEntry.tokens = addDshTokenBuckets(dayEntry.tokens, buckets)
    dayEntry.offPeakTokens = addDshTokenBuckets(dayEntry.offPeakTokens, offPeakBuckets)
    dayEntry.requests += 1
    addRoute(dayEntry.routes, routeKey, buckets, offPeakBuckets, 1)
    last = { turn, step, route: routeKey, day, tokens: buckets, offPeakTokens: offPeakBuckets }
  }

  result.turns = turns.size
  for (const [day, entry] of days) {
    result.byDay.set(day, {
      tokens: entry.tokens,
      offPeakTokens: entry.offPeakTokens,
      requests: entry.requests,
      turns: entry.turns.size,
      routes: entry.routes
    })
  }
  return result
}
