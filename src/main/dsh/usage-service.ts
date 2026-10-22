/**
 * 组装 dsh 用量快照：找日志 → 折叠 → 分「最近会话 / 今日 / 近 7 天 / 近 30 天」→ 折算费用。
 *
 * 四个口径：
 * - **最近会话** = 最后写入时间最新的那个会话（**不按目录过滤**）。dsh 日志里没有「当前活动会话」
 *   指针，谁也答不出「用户眼前这个是哪个会话」；按目录过滤只会把「刚在别的目录聊的那次」判成
 *   取不到，所以这里取全局最新，再用 `withinTarget` 说明它是否就在启动目标目录里。
 * - **今日累计** = 所有项目下「今天写过」的会话按事件时间切出来的今天那一份（同一个会话
 *   跨天不会被整段算进今天）。
 * - **近 7 / 30 天** = 含今天在内的 7 / 30 个**本地日历日**，同样按事件时间归属。
 *   `daily` 升序且长度固定（没活动的日子补 0），周期总数是区间**去重**的会话数 ——
 *   把每日的会话数加起来会把跨天会话算成好几个人。
 *
 * 费用分档：折叠时就把每个桶拆成「全量 + 其中空闲时段那部分」，因为同一条路由在高峰与空闲
 * 是两个单价（`tariff.ts` 判定时段，`pricing.ts` 折算）。节假日来自「内置官方日历 + 价目表里的
 * 额外假日」，所以折叠缓存要跟着日历变 —— 日历一变就整体作废。
 *
 * 每个口径除合计外还给峰谷两份明细（`tariffCost`），两份各按自己时段的单价折算、之和恒等于合计。
 * 周期口径的金额与峰谷明细都**按天累加**：同一条路由不同天的桶可能不一样，先合并整段再折
 * 会把「某天缺价」放大成「整条路由没价」，把算得出来的那些天一起丢掉。
 *
 * 性能：只解码「近 30 天写过」的文件 + 挑会话时往回翻的那几个；折叠结果按 `size + mtimeMs` 缓存，
 * 未变更的文件不重读。日志的 mtime 就是它最后一次写入的时间，所以 mtime 早于窗口起点的文件
 * 不可能含窗口内的事件，直接跳过。
 */
import { join } from 'node:path'
import {
  addDshTokenBuckets,
  emptyDshTokenBuckets,
  localDayKey,
  localDayKeys,
  startOfLocalDayOffset,
  totalDshTokens,
  type DshCostEstimate,
  type DshPeriodUsage,
  type DshRouteUsage,
  type DshSessionInfo,
  type DshTariffCost,
  type DshTodayUsage,
  type DshTokenBuckets,
  type DshUsageDay,
  type DshUsageScope,
  type DshUsageSnapshot,
  type DshUsageTotals
} from '@shared/dsh-usage'
import { listDshSessionLogs, readDshSessionLog, type DshSessionLogRef } from './session-log'
import { foldDshSessionEvents, type DshFoldedSession } from './usage-fold'
import { estimateDshCostBreakdown, loadDshPricing, zeroDshCost, type DshCostBreakdown, type DshPricingLoad } from './pricing'
import { createDshPeakClassifier, resolveDshCalendar } from './tariff'
import { isDshHolidayCalendarYearCovered } from './calendar'
import { zstdDecodingSupported } from './zstd-frames'

/** 「近 7 天」与「近 30 天」的天数（含今天）。 */
export const WEEK_DAYS = 7
export const MONTH_DAYS = 30

/** 读不到时的峰谷明细：四个口径的键都在、两项都是 `null`，渲染层不用猜字段是否存在。 */
function emptyTariffCost(): Record<DshUsageScope, DshTariffCost> {
  const blank = (): DshTariffCost => ({ peak: null, offPeak: null })
  return { session: blank(), today: blank(), week: blank(), month: blank() }
}

export interface DshUsageBuildOptions {
  /** dsh 的 DSH_HOME（会话日志在其下的 `sessions/`） */
  dshHome: string
  /** 当前启动目标的工作目录；null 表示连启动目标都解析不出来 */
  cwd: string | null
  /** 价目表文件绝对路径 */
  pricingFile: string
  now?: number
}

interface FoldCacheEntry {
  size: number
  mtimeMs: number
  folded: DshFoldedSession
  partial: boolean
  readable: boolean
}

const foldCache = new Map<string, FoldCacheEntry>()
/** 折叠结果依赖的日历签名：节假日一变，缓存的「空闲时段」归属就全错了。 */
let foldCacheCalendarKey = ''

/** 归一化会话头里的 cwd：统一分隔符；Windows 下大小写不敏感（同一目录两种写法都要匹配上）。 */
export function normalizeSessionCwd(value: string | null | undefined): string | null {
  if (!value) return null
  const unified = value.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!unified) return null
  return process.platform === 'win32' ? unified.toLowerCase() : unified
}

function pruneCaches(livePaths: Set<string>): void {
  for (const path of foldCache.keys()) if (!livePaths.has(path)) foldCache.delete(path)
}

interface ReadStats {
  decodedLogs: number
  /** 只记路径：同一个文件可能既进「最近会话」又进「今日累计」，按文件去重才是真实条数 */
  partialPaths: Set<string>
}

/** 「最近会话」最多往回翻几个：最近几个都是空会话（刚建未用）时别把整个库都折一遍。 */
const LATEST_SCAN_LIMIT = 5

async function foldLog(
  ref: DshSessionLogRef,
  stats: ReadStats,
  isPeak: (time: number) => boolean
): Promise<FoldCacheEntry> {
  const cached = foldCache.get(ref.path)
  const hit = cached && cached.size === ref.size && cached.mtimeMs === ref.mtimeMs ? cached : null
  if (hit) {
    if (hit.partial) stats.partialPaths.add(ref.path)
    return hit
  }
  const read = await readDshSessionLog(ref)
  stats.decodedLogs += 1
  const entry: FoldCacheEntry = {
    size: ref.size,
    mtimeMs: ref.mtimeMs,
    folded: foldDshSessionEvents(read.events, { isPeak }),
    partial: read.partial,
    readable: read.events.some(event => event.type === 'session') || read.events.some(event => event.type === 'assistant/message' || event.type === 'assistant/attempt')
  }
  if (entry.partial) stats.partialPaths.add(ref.path)
  // 短暂的权限/共享锁错误不会改变 size/mtime，不能缓存到文件下次写入为止。
  if (read.error === null && entry.readable) foldCache.set(ref.path, entry)
  return entry
}

/**
 * 取「最近会话」：按 mtime 降序（`listDshSessionLogs` 已排好）找第一个真正用过的会话。
 *
 * 为什么跳过 0 请求的：dsh 会先写一条只有会话头的种子会话，两个会话的写入时间可能只差几十毫秒，
 * 这时候「最新」是个空壳，展示成 0 反而更像故障。最近几个都空时仍然退回落首个，如实反映现状。
 */
async function pickLatestSession(
  logs: DshSessionLogRef[],
  stats: ReadStats,
  isPeak: (time: number) => boolean
): Promise<{ ref: DshSessionLogRef; entry: FoldCacheEntry } | null> {
  let fallback: { ref: DshSessionLogRef; entry: FoldCacheEntry } | null = null
  for (const ref of logs.slice(0, LATEST_SCAN_LIMIT)) {
    const entry = await foldLog(ref, stats, isPeak)
    if (!entry.readable) continue
    fallback ??= { ref, entry }
    if (entry.folded.requests > 0) return { ref, entry }
  }
  return fallback
}

interface RouteAggregate {
  tokens: DshTokenBuckets
  offPeakTokens: DshTokenBuckets
  requests: number
}

/** 一天的累计（含当天有活动的会话集合，供周期口径去重）。 */
interface DayBucket {
  tokens: DshTokenBuckets
  offPeakTokens: DshTokenBuckets
  requests: number
  turns: number
  routes: Map<string, RouteAggregate>
  /** 当天有活动的会话日志路径；周期口径取并集，跨天会话只算一次 */
  sessions: Set<string>
}

function emptyDayBucket(): DayBucket {
  return {
    tokens: emptyDshTokenBuckets(),
    offPeakTokens: emptyDshTokenBuckets(),
    requests: 0,
    turns: 0,
    routes: new Map(),
    sessions: new Set()
  }
}

function toRouteUsage(routes: Map<string, RouteAggregate>): DshRouteUsage[] {
  return [...routes.entries()]
    .map(([route, entry]) => {
      const slash = route.indexOf('/')
      return {
        route,
        provider: slash >= 0 ? route.slice(0, slash) : 'unknown',
        model: slash >= 0 ? route.slice(slash + 1) : route,
        tokens: entry.tokens,
        offPeakTokens: entry.offPeakTokens,
        totalTokens: totalDshTokens(entry.tokens),
        requests: entry.requests
      }
    })
    .sort((a, b) => b.totalTokens - a.totalTokens)
}

function toTotals(folded: DshFoldedSession): DshUsageTotals {
  return {
    tokens: folded.tokens,
    offPeakTokens: folded.offPeakTokens,
    totalTokens: totalDshTokens(folded.tokens),
    requests: folded.requests,
    turns: folded.turns,
    routes: toRouteUsage(folded.routes)
  }
}

function toSessionInfo(folded: DshFoldedSession, ref: DshSessionLogRef, withinTarget: boolean): DshSessionInfo {
  return {
    id: folded.id || ref.sessionId,
    title: folded.title,
    cwd: folded.cwd,
    createdAt: folded.createdAt,
    lastActivityAt: folded.lastActivityAt || ref.mtimeMs,
    withinTarget
  }
}

function addRouteInto(routes: Map<string, RouteAggregate>, route: string, value: RouteAggregate): void {
  const aggregate = routes.get(route) ?? { tokens: emptyDshTokenBuckets(), offPeakTokens: emptyDshTokenBuckets(), requests: 0 }
  aggregate.tokens = addDshTokenBuckets(aggregate.tokens, value.tokens)
  aggregate.offPeakTokens = addDshTokenBuckets(aggregate.offPeakTokens, value.offPeakTokens)
  aggregate.requests += value.requests
  routes.set(route, aggregate)
}

/** 多个日桶合成一个口径（周期用）：token/请求/轮次相加，会话取并集。 */
interface ScopeAccumulator {
  tokens: DshTokenBuckets
  offPeakTokens: DshTokenBuckets
  requests: number
  turns: number
  routes: Map<string, RouteAggregate>
  sessions: Set<string>
}

function emptyScopeAccumulator(): ScopeAccumulator {
  return {
    tokens: emptyDshTokenBuckets(),
    offPeakTokens: emptyDshTokenBuckets(),
    requests: 0,
    turns: 0,
    routes: new Map(),
    sessions: new Set()
  }
}

function accumulateBucket(scope: ScopeAccumulator, bucket: DayBucket | undefined): void {
  if (!bucket) return
  scope.tokens = addDshTokenBuckets(scope.tokens, bucket.tokens)
  scope.offPeakTokens = addDshTokenBuckets(scope.offPeakTokens, bucket.offPeakTokens)
  scope.requests += bucket.requests
  scope.turns += bucket.turns
  for (const [route, value] of bucket.routes) addRouteInto(scope.routes, route, value)
  for (const session of bucket.sessions) scope.sessions.add(session)
}

function toTodayUsage(scope: ScopeAccumulator): DshTodayUsage {
  return {
    tokens: scope.tokens,
    offPeakTokens: scope.offPeakTokens,
    totalTokens: totalDshTokens(scope.tokens),
    requests: scope.requests,
    turns: scope.turns,
    routes: toRouteUsage(scope.routes),
    sessions: scope.sessions.size
  }
}

/** 一个口径的费用：合计 + 峰谷两份明细（`total` 恒等于 `peak + offPeak`）。 */
type ScopeCost = DshCostBreakdown

/**
 * 口径费用。零消耗 ⇒ 三项都是**完整的 0**（`amount: 0, complete: true`）：
 * 日志读到了、价目表也在，那「没用 token」就是已知的 0，不是「不知道」。
 * 有消耗但一条路由都定不了价 ⇒ 三项都是 `null`。
 */
function costOfUsage(usage: DshUsageTotals, pricing: DshPricingLoad): ScopeCost {
  if (usage.totalTokens <= 0) {
    const zero = zeroDshCost(pricing.table)
    return { total: zero, peak: zero, offPeak: zero, pricedRoutes: [], unpricedRoutes: [] }
  }
  return estimateDshCostBreakdown(usage.routes, pricing.table)
}

/** 按天累加的计费台账（周期的合计与峰谷明细都从它出）。 */
interface CostTally {
  peakAmount: number
  offPeakAmount: number
  peakTokens: number
  offPeakTokens: number
  peakHasEstimate: boolean
  offPeakHasEstimate: boolean
  priced: string[]
  unpriced: string[]
}

function emptyCostTally(): CostTally {
  return { peakAmount: 0, offPeakAmount: 0, peakTokens: 0, offPeakTokens: 0, peakHasEstimate: false, offPeakHasEstimate: false, priced: [], unpriced: [] }
}

function pushRoutes(target: string[], routes: readonly string[]): void {
  for (const route of routes) if (!target.includes(route)) target.push(route)
}

/**
 * 周期按**天**累加，不是先合并整段的路由再折一次。
 *
 * 同一条路由不同天的桶可能不一样：A 天只有 input（有价），B 天冒出 output（缺价）。
 * 先合并再折会把整条路由判成未定价，把 A 天那笔明明算得出来的钱一起丢掉；
 * 但也不能只收 A 天、对外还报 `complete: true`。所以：能算的天照收，缺价的天进
 * `unpriced`，整段标 `complete: false` —— 金额与元数据来自同一批天，对得上。
 */
function addDayCost(tally: CostTally, usage: DshUsageTotals, cost: ScopeCost): void {
  if (usage.totalTokens <= 0) return
  pushRoutes(tally.priced, cost.pricedRoutes)
  pushRoutes(tally.unpriced, cost.unpricedRoutes)
  tally.peakAmount += cost.peak?.amount ?? 0
  tally.offPeakAmount += cost.offPeak?.amount ?? 0
  const offPeakTokens = totalDshTokens(usage.offPeakTokens ?? emptyDshTokenBuckets())
  tally.offPeakTokens += offPeakTokens
  tally.peakTokens += Math.max(0, usage.totalTokens - offPeakTokens)
  if (usage.totalTokens > offPeakTokens && cost.peak !== null) tally.peakHasEstimate = true
  if (offPeakTokens > 0 && cost.offPeak !== null) tally.offPeakHasEstimate = true
}

/** 把台账收成一个口径的费用；峰谷两项与合计共用同一批已定价/未定价路由。 */
function tallyCost(tally: CostTally, usage: DshUsageTotals, pricing: DshPricingLoad): ScopeCost {
  const table = pricing.table
  if (usage.totalTokens <= 0) {
    const zero = zeroDshCost(table)
    return { total: zero, peak: zero, offPeak: zero, pricedRoutes: [], unpricedRoutes: [] }
  }
  if (!table || tally.priced.length === 0) {
    return {
      total: null,
      peak: table && tally.peakTokens <= 0 ? zeroDshCost(table) : null,
      offPeak: table && tally.offPeakTokens <= 0 ? zeroDshCost(table) : null,
      pricedRoutes: [], unpricedRoutes: tally.unpriced
    }
  }
  const complete = tally.unpriced.length === 0
  const tier = (amount: number, tokens: number, hasEstimate: boolean): DshCostEstimate | null => {
    // 这个时段一 token 都没用：0 是已知的 0（不是「没价」）
    if (tokens <= 0) return zeroDshCost(table)
    if (!hasEstimate) return null
    return { currency: table.currency, amount, complete, pricedRoutes: tally.priced, unpricedRoutes: tally.unpriced }
  }
  return {
    total: {
      currency: table.currency,
      amount: tally.peakAmount + tally.offPeakAmount,
      complete,
      pricedRoutes: tally.priced,
      unpricedRoutes: tally.unpriced
    },
    peak: tier(tally.peakAmount, tally.peakTokens, tally.peakHasEstimate),
    offPeak: tier(tally.offPeakAmount, tally.offPeakTokens, tally.offPeakHasEstimate),
    pricedRoutes: tally.priced,
    unpricedRoutes: tally.unpriced
  }
}

/**
 * 组装 7 / 30 天口径：`daily` 升序、长度固定，没活动的日子补一整行 0。
 * 起点必须落在「本地日历日」上（`localDayKeys` 用 `setDate` 做日历运算，跨夏令时也不偏）。
 */
function buildPeriodUsage(
  dayKeys: readonly string[],
  buckets: Map<string, DayBucket>,
  pricing: DshPricingLoad
): { period: DshPeriodUsage; cost: ScopeCost } {
  const scope = emptyScopeAccumulator()
  const daily: DshUsageDay[] = []
  const tally = emptyCostTally()
  for (const day of dayKeys) {
    const bucket = buckets.get(day)
    accumulateBucket(scope, bucket)
    const dayScope = emptyScopeAccumulator()
    accumulateBucket(dayScope, bucket)
    const usage = toTodayUsage(dayScope)
    const cost = costOfUsage(usage, pricing)
    daily.push({ ...usage, day, cost: cost.total })
    addDayCost(tally, usage, cost)
  }
  const usage = toTodayUsage(scope)
  return {
    period: {
      ...usage,
      startDay: dayKeys[0] ?? '',
      endDay: dayKeys[dayKeys.length - 1] ?? '',
      daily
    },
    cost: tallyCost(tally, usage, pricing)
  }
}

/**
 * 有消耗、但内置节假日日历没覆盖的年份。
 *
 * 内置表只到 2026 年：2027 年的国庆会被当成工作日按高峰价折算，金额偏高。
 * 这件事必须让用户看见（`pricing.calendarWarningYears`），不能假装日历是完整的。
 */
function collectCalendarWarningYears(
  buckets: Map<string, DayBucket>,
  session: DshFoldedSession | null
): number[] {
  const years = new Set<number>()
  const note = (day: string, tokens: DshTokenBuckets): void => {
    if (totalDshTokens(tokens) <= 0) return
    const year = Number(day.slice(0, 4))
    if (Number.isInteger(year)) years.add(year)
  }
  for (const [day, bucket] of buckets) note(day, bucket.tokens)
  if (session) for (const [day, value] of session.byDay) note(day, value.tokens)
  return [...years].filter((year) => !isDshHolidayCalendarYearCovered(year)).sort((a, b) => a - b)
}

export async function buildDshUsageSnapshot(options: DshUsageBuildOptions): Promise<DshUsageSnapshot> {
  const now = options.now ?? Date.now()
  const dayStart = startOfLocalDayOffset(now, 0)
  const dayKey = localDayKey(now)
  const pricingFile = options.pricingFile
  const pricing = await loadDshPricing(pricingFile)

  const calendar = resolveDshCalendar(pricing.table?.holidays)
  const calendarKey = (calendar.holidays ?? []).join(',')
  if (calendarKey !== foldCacheCalendarKey) {
    foldCache.clear()
    foldCacheCalendarKey = calendarKey
  }
  const isPeak = createDshPeakClassifier(calendar)

  const basePricingState: Omit<DshUsageSnapshot['pricing'], 'calendarWarningYears'> = {
    configured: pricing.configured,
    source: pricing.source,
    currency: pricing.currency,
    file: pricingFile,
    error: pricing.error,
    rates: pricing.rates,
    offPeakRates: pricing.offPeakRates
  }

  // 窗口的日键（升序，最后一项是今天）；7 天窗口就是 30 天窗口的后 7 项
  const monthKeys = localDayKeys(now, MONTH_DAYS)
  const weekKeys = monthKeys.slice(-WEEK_DAYS)
  const monthStart = startOfLocalDayOffset(now, MONTH_DAYS - 1)

  if (!zstdDecodingSupported()) {
    return {
      generatedAt: now,
      dayStart,
      session: { ok: false, reason: 'unsupported' },
      today: { ok: false, reason: 'unsupported' },
      week: { ok: false, reason: 'unsupported' },
      month: { ok: false, reason: 'unsupported' },
      cost: { session: null, today: null, week: null, month: null },
      tariffCost: emptyTariffCost(),
      pricing: basePricingState,
      partialLogs: 0,
      decodedLogs: 0
    }
  }

  const logs = await listDshSessionLogs(join(options.dshHome, 'sessions'))
  pruneCaches(new Set(logs.map((log) => log.path)))
  const stats: ReadStats = { decodedLogs: 0, partialPaths: new Set() }

  if (logs.length === 0) {
    return {
      generatedAt: now,
      dayStart,
      session: { ok: false, reason: 'no-logs' },
      today: { ok: false, reason: 'no-logs' },
      week: { ok: false, reason: 'no-logs' },
      month: { ok: false, reason: 'no-logs' },
      cost: { session: null, today: null, week: null, month: null },
      tariffCost: emptyTariffCost(),
      pricing: basePricingState,
      partialLogs: 0,
      decodedLogs: 0
    }
  }

  // ---- 最近会话：全局最后写入的那个（不按目录过滤，见文件头说明）----
  const wantedCwd = normalizeSessionCwd(options.cwd)
  let sessionPart: DshUsageSnapshot['session']
  let sessionCost: ScopeCost = { total: null, peak: null, offPeak: null, pricedRoutes: [], unpricedRoutes: [] }
  let sessionFolded: DshFoldedSession | null = null
  {
    const picked = await pickLatestSession(logs, stats, isPeak)
    if (!picked) {
      // 有日志却一条都折不出来：如实报读取失败，不填 0
      sessionPart = { ok: false, reason: 'unreadable' }
    } else {
      sessionFolded = picked.entry.folded
      const usage = toTotals(picked.entry.folded)
      const sessionCwd = normalizeSessionCwd(picked.entry.folded.cwd)
      const withinTarget = wantedCwd === null || sessionCwd === null || sessionCwd === wantedCwd
      sessionPart = {
        ok: true,
        data: { session: toSessionInfo(picked.entry.folded, picked.ref, withinTarget), usage }
      }
      sessionCost = costOfUsage(usage, pricing)
    }
  }

  // ---- 按天累计：近 30 天写过/用过的会话，按事件时间落到本地日历日 ----
  const buckets = new Map<string, DayBucket>()
  let readableLogs = 0
  let unreadableLogs = 0
  for (const ref of logs) {
    // mtime 是最后一次写入时间：早于窗口起点的文件不可能含窗口内的事件
    if (ref.mtimeMs < monthStart) continue
    const entry = await foldLog(ref, stats, isPeak)
    if (!entry.readable) {
      unreadableLogs += 1
      continue
    }
    readableLogs += 1
    for (const [day, value] of entry.folded.byDay) {
      if (day < monthKeys[0] || day > dayKey) continue
      const bucket = buckets.get(day) ?? emptyDayBucket()
      bucket.tokens = addDshTokenBuckets(bucket.tokens, value.tokens)
      bucket.offPeakTokens = addDshTokenBuckets(bucket.offPeakTokens, value.offPeakTokens)
      bucket.requests += value.requests
      bucket.turns += value.turns
      for (const [route, routeValue] of value.routes) addRouteInto(bucket.routes, route, routeValue)
      if (value.requests > 0 || value.turns > 0) bucket.sessions.add(ref.path)
      buckets.set(day, bucket)
    }
  }

  const todayScope = emptyScopeAccumulator()
  accumulateBucket(todayScope, buckets.get(dayKey))
  const todayUsage = toTodayUsage(todayScope)
  const todayCost = costOfUsage(todayUsage, pricing)

  const week = buildPeriodUsage(weekKeys, buckets, pricing)
  const month = buildPeriodUsage(monthKeys, buckets, pricing)

  const calendarWarningYears = collectCalendarWarningYears(buckets, sessionFolded)
  const pricingState: DshUsageSnapshot['pricing'] =
    calendarWarningYears.length > 0 ? { ...basePricingState, calendarWarningYears } : basePricingState

  // 窗口内的日志全部读不到时，空日桶代表未知，不能作为「完整的零消耗」展示。
  const periodUnreadable = unreadableLogs > 0 && readableLogs === 0
  const unreadable = { ok: false, reason: 'unreadable' } as const
  const unknownTariff = { peak: null, offPeak: null }

  return {
    generatedAt: now,
    dayStart,
    session: sessionPart,
    today: periodUnreadable ? unreadable : { ok: true, data: todayUsage },
    week: periodUnreadable ? unreadable : { ok: true, data: week.period },
    month: periodUnreadable ? unreadable : { ok: true, data: month.period },
    cost: { session: sessionCost.total, today: periodUnreadable ? null : todayCost.total, week: periodUnreadable ? null : week.cost.total, month: periodUnreadable ? null : month.cost.total },
    tariffCost: {
      session: { peak: sessionCost.peak, offPeak: sessionCost.offPeak },
      today: periodUnreadable ? unknownTariff : { peak: todayCost.peak, offPeak: todayCost.offPeak },
      week: periodUnreadable ? unknownTariff : { peak: week.cost.peak, offPeak: week.cost.offPeak },
      month: periodUnreadable ? unknownTariff : { peak: month.cost.peak, offPeak: month.cost.offPeak }
    },
    pricing: pricingState,
    partialLogs: stats.partialPaths.size,
    decodedLogs: stats.decodedLogs
  }
}

/** 价目表模板需要的路由全集（所有口径合并），供「打开价目表」首次落地用。 */
export function collectSnapshotRoutes(snapshot: DshUsageSnapshot): string[] {
  const routes = new Set<string>()
  if (snapshot.session.ok) for (const route of snapshot.session.data.usage.routes) routes.add(route.route)
  if (snapshot.today.ok) for (const route of snapshot.today.data.routes) routes.add(route.route)
  if (snapshot.week.ok) for (const route of snapshot.week.data.routes) routes.add(route.route)
  if (snapshot.month.ok) for (const route of snapshot.month.data.routes) routes.add(route.route)
  return [...routes].sort()
}

/** 单测用：清空模块级缓存，避免用例之间互相污染。 */
export function resetDshUsageCaches(): void {
  foldCache.clear()
  foldCacheCalendarKey = ''
}
