/**
 * 费用折算：**dsh 自己不提供任何价目**。
 *
 * 核实过：`dsh --profile web --dump-config-schema` 的 877KB schema 里没有 price/pricing/cost 之类的键，
 * `dsh-deepseek-account` 只给平台钱包余额与一个网页用量链接，dsh 自带的 chat UI 也只显示 token
 * 与缓存命中率 —— 所以「花了多少钱」只能由 LyShell 用一份价目表折算。
 *
 * 价目表是用户资产（`<userData>/dsh-usage-pricing.json`，每 1M token 的单价，未知填 `null`）：
 * - 内置的只有官方公开价（见 `BUILTIN_DSH_PRICING`），第三方路由绝不猜价：猜出来的金额比「—」更糟；
 * - 路由按 `provider/model` 匹配，允许退化到裸模型名与 `*` 兜底；
 * - 任一桶有 token 但缺对应单价 ⇒ 该路由算「未定价」，整体 `complete: false`，界面显示约等号；
 * - 分高峰 / 空闲两档单价（时段判定在 `tariff.ts`）：只对落在空闲时段的那部分 token 用空闲价，
 *   没给空闲价时按高峰价算 —— 宁可高估，也不凭空给折扣。
 *
 * 合并规则（都是踩过的坑，改之前先看这里）：
 * - 币种不同就**不能**合并：内置价是人民币，文件写 `USD` 时若还叠加内置的人民币数字，
 *   等于把 ¥2 当成 $2 报给用户。币种不同时只认文件自己的单价，没填的桶一律「未知」。
 * - 文件真的给某条路由写了高峰价、却没写它的空闲价时，空闲价跟随**覆盖后的高峰价**，
 *   而不是继续用内置的空闲价 —— 否则用户把高峰价抬到 10，空闲时段还在按内置的 1 元算。
 * - 文件里写过的键（含裸模型名与 `*`）优先于内置精确键，否则用户配的裸名/兜底价会被内置表遮蔽。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  DSH_USAGE_PRICING_VERSION,
  emptyDshTokenBuckets,
  subtractDshTokenBuckets,
  totalDshTokens,
  type DshCostEstimate,
  type DshPricingTable,
  type DshRouteRates,
  type DshRouteUsage,
  type DshTokenBuckets,
  type DshUsagePricingSource
} from '@shared/dsh-usage'

export interface DshPricingLoad {
  table: DshPricingTable | null
  configured: boolean
  /** 单价来源：文件确实贡献了单价才算 `file`，否则是内置官方价 */
  source: DshUsagePricingSource
  currency: string
  error: string | null
  /**
   * 真正填了数字的路由数（全 `null` 的模板算 0）。
   * 「文件在但一条单价都没有」和「文件不在」是两种不同的状态：前者界面要提示去填，
   * 后者要提示还没建 —— 否则用户只看到一个「—」，不知道下一步该做什么。
   */
  rates: number
  /** 填了空闲价的路由数：>0 说明费用会按时段分档 */
  offPeakRates: number
}

export const DEFAULT_PRICING_CURRENCY = 'CNY'

const RATE_KEYS = ['input', 'cacheRead', 'cacheWrite', 'output'] as const

function emptyRates(): DshRouteRates {
  return { input: null, cacheRead: null, cacheWrite: null, output: null }
}

function hasAnyRate(rates: DshRouteRates | undefined): boolean {
  return !!rates && RATE_KEYS.some((key) => typeof rates[key] === 'number' && Number.isFinite(rates[key]))
}

/** 逐桶补齐：目标为 `null`（未知/没填）的桶才用来源的值。写 0 是有效的「免费」。 */
function fillMissingRates(target: DshRouteRates, source: DshRouteRates | undefined): void {
  if (!source) return
  for (const key of RATE_KEYS) {
    if (target[key] === null && typeof source[key] === 'number' && Number.isFinite(source[key])) target[key] = source[key]
  }
}

/**
 * 内置的官方价目（元 / 每 1M token，2026-10 版）。
 *
 * 为什么要内置：dsh 不提供任何价格，如果「没有配置文件就等于没有费用」，用户第一步只会
 * 看到「—」，还得先知道要自己填价才能用 —— 这不合理。内置价让面板开箱就能折算。
 *
 * 覆盖规则：用户文件里的单价按桶逐个覆盖内置值（写 0 就是真的 0），文件没写的桶继续用内置价；
 * 内置表里也没有的路由仍然算「未定价」，绝不按 0 计。
 *
 * `holidays` 留空：官方节假日日历单独放 `calendar.ts`（带年份与来源），
 * 由 `createDshPeakClassifier` 与这里合并 —— 免得把「2026 年的放假安排」写成永久事实。
 */
export const BUILTIN_DSH_PRICING: DshPricingTable = {
  currency: DEFAULT_PRICING_CURRENCY,
  models: {
    '*': emptyRates(),
    'deepseek-account/deepseek-flash': { input: 2, cacheRead: 0.04, cacheWrite: 2, output: 8 },
    'deepseek-official/deepseek-flash': { input: 2, cacheRead: 0.04, cacheWrite: 2, output: 8 },
    'deepseek-official/deepseek-v4-pro': { input: 9, cacheRead: 0.3, cacheWrite: 9, output: 27 }
  },
  offPeak: {
    'deepseek-account/deepseek-flash': { input: 1, cacheRead: 0.02, cacheWrite: 1, output: 4 },
    'deepseek-official/deepseek-flash': { input: 1, cacheRead: 0.02, cacheWrite: 1, output: 4 },
    'deepseek-official/deepseek-v4-pro': { input: 4.5, cacheRead: 0.15, cacheWrite: 4.5, output: 13.5 }
  },
  holidays: [],
  workdays: []
}

/**
 * 已知的官方 provider。只有这些 provider 下的旧模型名才允许规范化，
 * 第三方同名路由（比如某个自建网关也叫 `deepseek-v4-flash`）不能被当成官方 Flash 计价。
 */
export const DSH_OFFICIAL_PROVIDERS: readonly string[] = ['deepseek-account', 'deepseek-official']

/**
 * 官方仍按 Flash 价计费的旧模型名（dsh 侧还在发这两个名字，DeepSeek 官方按 Flash 收费）。
 * 漏掉它们就会让「官方旧名」变成未定价，界面上凭空多出一条收费「—」。
 */
export const DSH_FLASH_MODEL_ALIASES: Readonly<Record<string, string>> = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash'
}

/** 把官方旧 Flash 名规范化成 `provider/deepseek-flash`；不是已知官方路由则返回 `null`。 */
export function canonicalDshModelRoute(route: string): string | null {
  const slash = route.indexOf('/')
  if (slash < 0) return null
  const provider = route.slice(0, slash)
  if (!DSH_OFFICIAL_PROVIDERS.includes(provider)) return null
  const alias = DSH_FLASH_MODEL_ALIASES[route.slice(slash + 1)]
  return alias ? `${provider}/${alias}` : null
}

/**
 * 一条路由在价目表里可以命中的键，按优先级排列：精确 → 官方规范名 → 裸模型名 → 官方裸名 → `*`。
 * 两档单价用同一组键查，保证「高峰认哪个键，空闲也认哪个键」。
 */
function routeKeys(route: string): string[] {
  const keys = [route]
  const canonical = canonicalDshModelRoute(route)
  if (canonical) keys.push(canonical)
  const slash = route.indexOf('/')
  if (slash >= 0) {
    const provider = route.slice(0, slash)
    const bare = route.slice(slash + 1)
    if (bare) keys.push(bare)
    const alias = DSH_FLASH_MODEL_ALIASES[bare]
    if (alias && DSH_OFFICIAL_PROVIDERS.includes(provider)) keys.push(alias)
  }
  // `*` 是兜底：只想填一次就填它，没单独定价的路由都按它算
  keys.push('*')
  return [...new Set(keys)]
}

/** 宽松解析单个路由的单价：缺失/`null` 都是「未知」，负数或非数字直接报错。 */
function parseRates(raw: unknown, where: string): { ok: true; rates: DshRouteRates } | { ok: false; error: string } {
  if (raw === null || raw === undefined) return { ok: true, rates: emptyRates() }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: `${where} must be an object` }
  const record = raw as Record<string, unknown>
  const rates = emptyRates()
  for (const key of RATE_KEYS) {
    const value = record[key]
    if (value === undefined || value === null) continue
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return { ok: false, error: `${where}.${key} must be a non-negative number or null` }
    }
    rates[key] = value
  }
  return { ok: true, rates }
}

function parseRateMap(
  raw: unknown,
  where: string
): { ok: true; rates: Record<string, DshRouteRates> } | { ok: false; error: string } {
  const rates: Record<string, DshRouteRates> = {}
  if (raw === undefined || raw === null) return { ok: true, rates }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: `pricing file "${where}" must be an object` }
  for (const [route, value] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = parseRates(value, `${where}[${JSON.stringify(route)}]`)
    if (!parsed.ok) return parsed
    rates[route] = parsed.rates
  }
  return { ok: true, rates }
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** 节假日/补班日列表：写错一天就会让整天按错价折算，所以宁可整表报错也不跳过。 */
function parseDayList(raw: unknown, where: string): { ok: true; days: string[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, days: [] }
  if (!Array.isArray(raw)) return { ok: false, error: `pricing file "${where}" must be an array of YYYY-MM-DD` }
  const days: string[] = []
  for (const value of raw) {
    if (typeof value !== 'string' || !DAY_PATTERN.test(value)) {
      return { ok: false, error: `${where} entries must be YYYY-MM-DD, got ${JSON.stringify(value)}` }
    }
    days.push(value)
  }
  return { ok: true, days }
}

export function parseDshPricing(raw: unknown): { ok: true; table: DshPricingTable } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'pricing file must be a JSON object' }
  const record = raw as Record<string, unknown>
  if (record.version !== undefined && record.version !== DSH_USAGE_PRICING_VERSION) {
    return { ok: false, error: `unsupported pricing version: ${String(record.version)}` }
  }
  const currency = typeof record.currency === 'string' && record.currency.trim()
    ? canonicalPricingCurrency(record.currency)
    : DEFAULT_PRICING_CURRENCY
  const models = parseRateMap(record.models, 'models')
  if (!models.ok) return models
  const offPeak = parseRateMap(record.offPeak, 'offPeak')
  if (!offPeak.ok) return offPeak
  // 全 null 的项等于没填：留着会让「有 token 却没单价」把整条路由判成未定价，反而更糟
  const offPeakRates: Record<string, DshRouteRates> = {}
  for (const [route, rates] of Object.entries(offPeak.rates)) {
    if (hasAnyRate(rates)) offPeakRates[route] = rates
  }
  const holidays = parseDayList(record.holidays, 'holidays')
  if (!holidays.ok) return holidays
  const workdays = parseDayList(record.workdays, 'workdays')
  if (!workdays.ok) return workdays
  // 记下「文件真的写过哪些键」：查价时这些键要压过内置精确键（见文件头注释）。
  // 高峰价与空闲价分开记 —— 「只写了高峰价」才需要让空闲价跟随，不能算成写过了空闲价。
  const fileKeys: string[] = []
  for (const [route, rates] of Object.entries(models.rates)) {
    if (hasAnyRate(rates)) fileKeys.push(route)
  }
  const fileOffPeakKeys = Object.keys(offPeakRates)
  return {
    ok: true,
    table: {
      currency,
      models: models.rates,
      offPeak: offPeakRates,
      holidays: holidays.days,
      workdays: workdays.days,
      fileKeys,
      fileOffPeakKeys
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

/** 填了至少一个单价的路由数：用来区分「模板还在空转」与「已经在折算」。 */
function countPricedRoutes(table: DshPricingTable): number {
  let count = 0
  for (const rates of Object.values(table.models)) {
    if (hasAnyRate(rates)) count += 1
  }
  return count
}

function countOffPeakRoutes(table: DshPricingTable): number {
  return Object.keys(table.offPeak ?? {}).length
}

/** 单条路由的两档单价合并：文件填了就用文件的，没填就落回内置价。 */
function mergeRates(base: DshRouteRates | undefined, override: DshRouteRates | undefined): DshRouteRates {
  const merged = emptyRates()
  for (const key of RATE_KEYS) {
    const fromFile = override?.[key] ?? null
    merged[key] = fromFile !== null ? fromFile : (base?.[key] ?? null)
  }
  return merged
}

/**
 * 币种规范化：`CNY` 与 `RMB` 是同一个人民币，必须共用内置人民币价。
 * 其他币种一律原样保留（大写），并触发「不合并内置数字」的处理。
 */
export function canonicalPricingCurrency(value: string): string {
  const upper = value.trim().toUpperCase()
  return upper === 'RMB' ? 'CNY' : upper
}

/**
 * 文件覆盖内置表：逐桶合并而不是整表替换，用户只写自己关心的那几项就够了。
 * - 币种不同（且不是 CNY/RMB）时**不合并**内置单价，只有文件自己写的桶算数；
 * - 节假日取并集：内置的是官方放假安排，文件里的是用户自己补的日子，谁也不能吃掉谁；
 * - 补班日（`workdays`）只为兼容旧文件而保留解析，判定已不看它（官方规则：周末全天空闲）。
 */
function mergePricingTable(base: DshPricingTable, override: DshPricingTable): DshPricingTable {
  const baseCurrency = canonicalPricingCurrency(base.currency || DEFAULT_PRICING_CURRENCY)
  const currency = canonicalPricingCurrency(override.currency || baseCurrency)
  const sameCurrency = currency === baseCurrency
  const models: Record<string, DshRouteRates> = {}
  const routes = sameCurrency
    ? new Set([...Object.keys(base.models), ...Object.keys(override.models)])
    : new Set(Object.keys(override.models))
  for (const route of routes) {
    models[route] = mergeRates(sameCurrency ? base.models[route] : undefined, override.models[route])
  }
  const offPeak: Record<string, DshRouteRates> = {}
  const offPeakRoutes = sameCurrency
    ? new Set([...Object.keys(base.offPeak ?? {}), ...Object.keys(override.offPeak ?? {})])
    : new Set(Object.keys(override.offPeak ?? {}))
  for (const route of offPeakRoutes) {
    const rates = mergeRates(sameCurrency ? base.offPeak?.[route] : undefined, override.offPeak?.[route])
    if (hasAnyRate(rates)) offPeak[route] = rates
  }
  const holidays = [...new Set([...(base.holidays ?? []), ...(override.holidays ?? [])])].sort()
  // 只带文件自己的键：内置表里的键不是「用户配的」，不能让它们抢到查询优先级，
  // 也不能让一张空白模板把内置的峰谷档位当成用户配置（见 fileOffPeakKeys 的注释）。
  const uniqueKeys = (keys: string[] | undefined): string[] => [...new Set(keys ?? [])].sort()
  return {
    currency,
    models,
    offPeak,
    holidays,
    workdays: override.workdays && override.workdays.length > 0 ? override.workdays : base.workdays,
    fileKeys: uniqueKeys(override.fileKeys).filter((key) => hasAnyRate(models[key])),
    fileOffPeakKeys: uniqueKeys(override.fileOffPeakKeys).filter((key) => hasAnyRate(offPeak[key])),
    fileModels: override.models,
    fileOffPeak: override.offPeak
  }
}

/** 文件读不出来时回落到内置价：费用照算，同时把错误如实报上去。 */
function builtinPricing(error: string | null): DshPricingLoad {
  return {
    table: BUILTIN_DSH_PRICING,
    configured: true,
    source: 'builtin',
    currency: BUILTIN_DSH_PRICING.currency,
    error,
    rates: countPricedRoutes(BUILTIN_DSH_PRICING),
    offPeakRates: countOffPeakRoutes(BUILTIN_DSH_PRICING)
  }
}

/** 读价目表并叠加到内置官方价上。文件不存在不再是「没配」——内置价照常可用。 */
export async function loadDshPricing(file: string): Promise<DshPricingLoad> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (isMissingFile(error)) return builtinPricing(null)
    return builtinPricing((error as Error).message)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return builtinPricing(`invalid JSON: ${(error as Error).message}`)
  }
  const parsed = parseDshPricing(raw)
  if (!parsed.ok) return builtinPricing(parsed.error)
  const merged = mergePricingTable(BUILTIN_DSH_PRICING, parsed.table)
  const rates = countPricedRoutes(merged)
  const fromFile = (parsed.table.fileKeys?.length ?? 0) + (parsed.table.fileOffPeakKeys?.length ?? 0) > 0
  return {
    table: merged,
    // 一条单价都没有（或币种对不上导致内置价被排除）就是真的没价可折算
    configured: rates > 0,
    // 文件一条单价都没填时，费用其实全部来自内置表 —— 别让界面说「你配的价」
    source: rates === 0 ? 'none' : fromFile ? 'file' : 'builtin',
    currency: merged.currency,
    error: null,
    rates,
    offPeakRates: countOffPeakRoutes(merged)
  }
}

/**
 * 路由查价：精确键 → 官方规范名 → 裸模型名 → 官方裸名 → `*` 兜底，
 * 其中「文件里真的写过的键」整体排在最前 —— 用户写的裸名/兜底价不能被内置精确键遮蔽。
 * 单条路由的两档单价各桶合并，所以用户只写 `output` 也能生效。
 */
function lookupRates(table: DshPricingTable, route: string): { peak: DshRouteRates; offPeak: DshRouteRates | null } | null {
  const keys = routeKeys(route)
  const fileKeys = table.fileKeys ?? []
  const fileOffPeakKeys = table.fileOffPeakKeys ?? []
  const isFileKey = (key: string): boolean => fileKeys.includes(key) || fileOffPeakKeys.includes(key)
  const ordered = [...keys.filter(isFileKey), ...keys]
  const filePeakConfigured = ordered.some((key) => fileKeys.includes(key) && hasAnyRate(table.models[key]))
  const fileOffPeakConfigured = ordered.some(
    (key) => fileOffPeakKeys.includes(key) && hasAnyRate(table.offPeak?.[key])
  )
  const peak = emptyRates()
  // 先填完所有用户桶，再回退内置值；精确键补入的内置 output 不能挡住用户的 * output。
  for (const key of keys) if (fileKeys.includes(key)) fillMissingRates(peak, (table.fileModels ?? table.models)[key])
  for (const key of ordered) fillMissingRates(peak, table.models[key])
  if (!hasAnyRate(peak)) return null
  // 文件覆盖了这条路由的高峰价却没给空闲价：空闲价跟随覆盖后的高峰价，不继续吃内置折扣
  if (filePeakConfigured && !fileOffPeakConfigured) {
    return { peak, offPeak: peak }
  }
  const offPeak = emptyRates()
  for (const key of keys) if (fileOffPeakKeys.includes(key)) fillMissingRates(offPeak, (table.fileOffPeak ?? table.offPeak)?.[key])
  for (const key of ordered) fillMissingRates(offPeak, table.offPeak?.[key])
  return { peak, offPeak: hasAnyRate(offPeak) ? offPeak : null }
}

/** 一组 token 桶按一组单价的金额；任一有用量的桶缺单价则整组算不出来（返回 null）。 */
function costOfTokens(tokens: DshTokenBuckets, rates: DshRouteRates): number | null {
  const buckets: Array<[keyof DshRouteRates, number]> = [
    ['input', tokens.uncachedInput],
    ['cacheRead', tokens.cacheRead],
    ['cacheWrite', tokens.cacheWrite],
    ['output', tokens.output]
  ]
  let amount = 0
  for (const [key, count] of buckets) {
    if (count <= 0) continue
    const rate = rates[key]
    if (rate === null) return null
    amount += (count / 1_000_000) * rate
  }
  return amount
}

/** 一个口径的费用，按峰谷拆开：`total` 恒等于 `peak + offPeak`。 */
export interface DshCostBreakdown {
  total: DshCostEstimate | null
  peak: DshCostEstimate | null
  offPeak: DshCostEstimate | null
  /**
   * 记账台账：即使三项都是 `null`（一条都没法定价），调用方也能知道卡在哪些路由上。
   * 7/30 天口径按天聚合时要用它 —— 缺价的那天不能把整条路由的历史金额一起丢掉。
   */
  pricedRoutes: string[]
  unpricedRoutes: string[]
}

/**
 * 折算费用，并同时给出高峰 / 空闲两份明细。
 *
 * 关键点（改之前先读）：
 * - **一条路由要么整条按实际时段收费，要么整条算未定价**：高峰那半能算、空闲那半缺价时，
 *   不能只收高峰那半 —— 那样总额会偏低，用户还以为已经算全了。
 * - 两份明细用**同一批**已定价路由与同一套未定价路由，所以 `peak + offPeak` 恒等于 `total`，
 *   三项的 `complete` / `pricedRoutes` / `unpricedRoutes` 也天然一致。
 * - 某个时段真的一 token 都没用 ⇒ 那份是完整 0（`amount: 0, complete: true`）；
 *   不是把 0 当成「没有价」。
 * - `total` 为 `null` 表示一条路由都没法定价（不是 0 元）。
 */
export function estimateDshCostBreakdown(
  routes: readonly DshRouteUsage[],
  table: DshPricingTable | null
): DshCostBreakdown {
  const empty: DshCostBreakdown = { total: null, peak: null, offPeak: null, pricedRoutes: [], unpricedRoutes: [] }
  if (!table) return empty
  const pricedRoutes: string[] = []
  const unpricedRoutes: string[] = []
  let peakAmount = 0
  let offPeakAmount = 0
  let peakTokenTotal = 0
  let offPeakTokenTotal = 0
  let pricedPeakTokens = 0
  let pricedOffPeakTokens = 0
  for (const usage of routes) {
    if (usage.totalTokens <= 0) continue
    const offPeakPart = usage.offPeakTokens ?? emptyDshTokenBuckets()
    const peakPart = subtractDshTokenBuckets(usage.tokens, offPeakPart)
    peakTokenTotal += totalDshTokens(peakPart)
    offPeakTokenTotal += totalDshTokens(offPeakPart)
    const rates = lookupRates(table, usage.route)
    if (!rates) {
      unpricedRoutes.push(usage.route)
      continue
    }
    // 空闲时段只对「落在时段里的那部分」打折，其余仍按高峰价
    const peakCost = costOfTokens(peakPart, rates.peak)
    // 没单独给空闲价时按高峰价算：宁可高估，也不凭空给折扣
    const offPeakCost = costOfTokens(offPeakPart, rates.offPeak ?? rates.peak)
    if (peakCost === null || offPeakCost === null) {
      unpricedRoutes.push(usage.route)
      continue
    }
    pricedRoutes.push(usage.route)
    peakAmount += peakCost
    offPeakAmount += offPeakCost
    pricedPeakTokens += totalDshTokens(peakPart)
    pricedOffPeakTokens += totalDshTokens(offPeakPart)
  }
  if (pricedRoutes.length === 0) return {
    ...empty, unpricedRoutes,
    peak: peakTokenTotal <= 0 ? zeroDshCost(table) : null,
    offPeak: offPeakTokenTotal <= 0 ? zeroDshCost(table) : null
  }
  const complete = unpricedRoutes.length === 0
  const tier = (amount: number, tokens: number, pricedTokens: number): DshCostEstimate | null => {
    // 这个时段一 token 都没用：0 是已知的 0（不是「没价」）
    if (tokens <= 0) return zeroDshCost(table)
    // 有真实用量，但该档所有路由都缺价：不能冒充「完整的 0 元」。
    if (pricedTokens <= 0) return null
    return { currency: table.currency, amount, complete, pricedRoutes, unpricedRoutes }
  }
  return {
    total: { currency: table.currency, amount: peakAmount + offPeakAmount, complete, pricedRoutes, unpricedRoutes },
    peak: tier(peakAmount, peakTokenTotal, pricedPeakTokens),
    offPeak: tier(offPeakAmount, offPeakTokenTotal, pricedOffPeakTokens),
    pricedRoutes,
    unpricedRoutes
  }
}

/**
 * 折算费用。返回 `null` 表示**一条路由都没法定价**（不是 0 元）；
 * `complete: false` 表示只折算了一部分，界面必须说明该金额为下限。
 */
export function estimateDshCost(routes: readonly DshRouteUsage[], table: DshPricingTable | null): DshCostEstimate | null {
  return estimateDshCostBreakdown(routes, table).total
}

/**
 * 零消耗的金额（`amount: 0, complete: true`）。
 * 「这天/这段真的没用 token」是已知的 0，不能拿 `null`（未知）去表示，
 * 更不能在日志读不到时用它冒充 0 —— 那个分支由调用方判断。
 */
export function zeroDshCost(table: DshPricingTable | null): DshCostEstimate | null {
  if (!table) return null
  return { currency: table.currency, amount: 0, complete: true, pricedRoutes: [], unpricedRoutes: [] }
}

/** 生成一份「待填」价目表：把日志里真实出现过的路由先列好，单价留 `null`。 */
export function buildDshPricingTemplate(routes: readonly string[], currency = DEFAULT_PRICING_CURRENCY): string {
  const models: Record<string, DshRouteRates> = {}
  const offPeak: Record<string, DshRouteRates> = {}
  // `*` 是兜底路由：只想填一次就填它，没单独定价的路由都按它算。
  models['*'] = emptyRates()
  offPeak['*'] = emptyRates()
  for (const route of [...new Set(routes)].filter(Boolean).sort()) {
    models[route] = emptyRates()
    offPeak[route] = emptyRates()
  }
  const document = {
    version: DSH_USAGE_PRICING_VERSION,
    currency,
    comment:
      'per 1M tokens in the currency above. "models" are PEAK rates, "offPeak" are off-peak rates (leave null to be charged at peak). Off-peak = every hour outside Beijing-time Mon-Fri 09:00-12:00 and 14:00-18:00, plus every weekend and every statutory holiday. Your own "holidays" are added on top of LyShell\'s built-in statutory calendar. Prices are only merged with the built-in CNY table when the currency is CNY/RMB; any other currency means "only what you fill in here". null means "unknown" and is never counted as 0. "*" is the fallback route.',
    holidays: [] as string[],
    workdays: [] as string[],
    models,
    offPeak
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

/**
 * 首次「打开价目表」时落地模板。已存在就**绝不覆盖** —— 那里面是用户填的单价。
 * 返回是否新建，便于界面提示「已生成模板，请填写单价」。
 */
export async function ensureDshPricingTemplate(file: string, routes: readonly string[], currency?: string): Promise<{ created: boolean }> {
  try {
    await readFile(file, 'utf8')
    return { created: false }
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }
  await mkdir(dirname(file), { recursive: true })
  try {
    await writeFile(file, buildDshPricingTemplate(routes, currency), { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'EEXIST') {
      return { created: false }
    }
    throw error
  }
  return { created: true }
}
