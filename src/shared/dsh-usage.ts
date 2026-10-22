/**
 * dsh 用量（token / 费用）读数的共享契约。
 *
 * 数据来源是 dsh 自己的会话日志（`$DSH_HOME/sessions/<project>/session-<id>/session.v<N>.jsonl.zstd`），
 * 主进程按 `dsh-token-meter` 的投影语义精确折叠出 token 四桶（见 `main/dsh/usage-fold.ts`），
 * 渲染层只负责展示 —— 类型与格式化纯函数放这里，两侧共用，避免各写一套「12.3K」。
 *
 * 一条硬规则：**未知不等于零**。取不到读数时 `dd` 显示破折号而不是 0，
 * 费用没有价目表时也不折算成 0 —— 读成「今天花了 0 元」比读不到更糟。
 */

/** 四个互斥的 token 桶；reasoning token 已含在 output 内，不单列（与 dsh 的投影一致）。 */
export interface DshTokenBuckets {
  /** 未命中缓存的输入 token */
  uncachedInput: number
  /** 命中前缀缓存、按缓存价计费的输入 token */
  cacheRead: number
  /** 写入前缀缓存的 token */
  cacheWrite: number
  /** 输出 token（含 reasoning） */
  output: number
}

export function emptyDshTokenBuckets(): DshTokenBuckets {
  return { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
}

export function addDshTokenBuckets(a: DshTokenBuckets, b: DshTokenBuckets): DshTokenBuckets {
  return {
    uncachedInput: a.uncachedInput + b.uncachedInput,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output
  }
}

export function subtractDshTokenBuckets(a: DshTokenBuckets, b: DshTokenBuckets): DshTokenBuckets {
  return {
    uncachedInput: a.uncachedInput - b.uncachedInput,
    cacheRead: a.cacheRead - b.cacheRead,
    cacheWrite: a.cacheWrite - b.cacheWrite,
    output: a.output - b.output
  }
}

export function totalDshTokens(b: DshTokenBuckets): number {
  return b.uncachedInput + b.cacheRead + b.cacheWrite + b.output
}

/** 单条路由（provider/model）的用量：价目表按这个键定价。 */
export interface DshRouteUsage {
  /** `provider/model`，例如 `deepseek-official/deepseek-flash` */
  route: string
  provider: string
  model: string
  tokens: DshTokenBuckets
  /** 其中落在空闲时段的那部分（已含在 `tokens` 里，用于套用不同单价） */
  offPeakTokens?: DshTokenBuckets
  totalTokens: number
  requests: number
}

export interface DshUsageTotals {
  tokens: DshTokenBuckets
  /** 其中落在空闲时段的那部分（已含在 `tokens` 里） */
  offPeakTokens?: DshTokenBuckets
  totalTokens: number
  /** 计入用量的模型请求数；同槽重复落盘替换，重试另起的尝试累加。 */
  requests: number
  /** 已开始的轮次数量 */
  turns: number
  /** 按用量降序 */
  routes: DshRouteUsage[]
}

/** 会话身份的只读摘要（供面板标注「这是哪个会话」）。 */
export interface DshSessionInfo {
  id: string
  title: string | null
  cwd: string | null
  createdAt: number | null
  lastActivityAt: number
  /**
   * 这个会话是否就在启动目标的目录里。
   * 会话口径取的是「最后写入的那个会话」，用户可能刚在别的目录聊过；为 false 时 UI 要交代它的 cwd，
   * 否则「最近会话」会看起来像个来源不明的数字。
   */
  withinTarget: boolean
}

/** 取不到读数的原因。渲染层逐条翻译，**任何一种都不渲染成 0**。 */
export type DshUsageFailure =
  /** 会话目录存在但没有可读日志 */
  | 'no-logs'
  /** 运行时缺少 zstd 解码能力（本应只在极老的 Node 上出现） */
  | 'unsupported'
  /** 读取/解析整体失败 */
  | 'unreadable'

export type DshUsageScopeData<T> =
  | { ok: true; data: T }
  | { ok: false; reason: DshUsageFailure; detail?: string }

export interface DshSessionUsage {
  session: DshSessionInfo
  usage: DshUsageTotals
}

export interface DshTodayUsage extends DshUsageTotals {
  /** 该口径里有活动的会话数（周期口径是**去重**的会话数，不是每日之和） */
  sessions: number
}

/**
 * 一天的分项读数：`day` 是**本地日历日**（`YYYY-MM-DD`），与 `today` 同一套口径。
 * `cost` 为 `null` 只在「这天有消耗但一条路由都定不了价」时出现；
 * 已成功读取且零消耗的日期给的是完整的 0（`amount: 0, complete: true`），不是 `null`。
 */
export interface DshUsageDay extends DshTodayUsage {
  day: string
  cost: DshCostEstimate | null
}

/**
 * 7 天 / 30 天口径：本地日历日、含今天，`daily` 升序且恰好 `7` / `30` 项（无活动的日子补 0）。
 * `sessions` 是**整个区间去重**的会话数 —— 同一个会话跨天只能算一次。
 */
export interface DshPeriodUsage extends DshTodayUsage {
  startDay: string
  endDay: string
  daily: DshUsageDay[]
}

/** 价目表折算结果；`null` 表示一条路由都没定价（不是 0 元）。 */
export interface DshCostEstimate {
  currency: string
  amount: number
  /** 所有产生过 token 的路由都能定价时为 true */
  complete: boolean
  pricedRoutes: string[]
  unpricedRoutes: string[]
}

/**
 * 峰谷分档金额：把同一个口径的总费用拆成「高峰时段」与「空闲时段」两份。
 *
 * - 两份金额各自按**所属时段的单价**独立折算，不是把总额按 token 比例劈开 ——
 *   不同桶的单价差着一个数量级（缓存读 0.04 vs 输出 8），按比例拆出来的数字对不上账。
 * - 两份之和恒等于同口径的 `cost.amount`（同一批「已定价路由」、同一套未定价判定），
 *   不会出现「高峰 + 空闲 ≠ 合计」。
 * - 某时段真的一 token 都没用 ⇒ 完整 0（`amount: 0, complete: true`）；
 *   口径整体读不到 ⇒ 两项都是 `null`；有用量但缺价的时段也为 `null`，不是 0。
 */
export interface DshTariffCost {
  peak: DshCostEstimate | null
  offPeak: DshCostEstimate | null
}

/** 价目表来源：用户文件（含覆盖）/ 内置官方价 / 一份都用不上 */
export type DshUsagePricingSource = 'file' | 'builtin' | 'none'

export interface DshUsagePricingState {
  /** 是否有可用的价目表（文件或内置官方价都算） */
  configured: boolean
  /** 这份单价从哪来：`builtin` 时要告诉用户「填文件就能覆盖」 */
  source: DshUsagePricingSource
  currency: string
  /** 价目表文件绝对路径（面板上的「打开价目表」用它） */
  file: string
  /** 价目表存在但不可用时的原因 */
  error: string | null
  /** 填了至少一个单价的路由数：0 表示模板还在空转，费用必然算不出来 */
  rates: number
  /** 填了空闲时段单价的路由数：>0 表示费用会按高峰/空闲两档折算 */
  offPeakRates?: number
  /**
   * 有实际消耗、但**内置节假日日历没覆盖**的年份（升序）。
   * 这些年份的法定节假日仍按「工作日/周末」判定，节假日当天的费用会被高估 ——
   * 界面要如实说明，不能假装节假日日历是完整的。
   */
  calendarWarningYears?: number[]
}

export interface DshUsageSnapshot {
  generatedAt: number
  /** 本地零点（「今日」的口径） */
  dayStart: number
  session: DshUsageScopeData<DshSessionUsage>
  today: DshUsageScopeData<DshTodayUsage>
  /** 最近 7 个本地日历日（含今天） */
  week: DshUsageScopeData<DshPeriodUsage>
  /** 最近 30 个本地日历日（含今天） */
  month: DshUsageScopeData<DshPeriodUsage>
  cost: {
    session: DshCostEstimate | null
    today: DshCostEstimate | null
    week: DshCostEstimate | null
    month: DshCostEstimate | null
  }
  /**
   * 每个口径的峰谷分档金额。键必须齐四个口径：读不到时两项为 `null`，
   * 而不是省略这个键 —— 否则渲染层要区分「没有这个字段」和「这个口径没有峰谷数据」。
   */
  tariffCost: Record<DshUsageScope, DshTariffCost>
  pricing: DshUsagePricingState
  /** 有帧解码失败/尾部截断的日志数：>0 时读数可能偏低，界面必须提示 */
  partialLogs: number
  /** 本次真正解码过的日志数（缓存命中不计），用于判断是不是冷启动 */
  decodedLogs: number
}

export type DshUsageScope = 'session' | 'today' | 'week' | 'month'

/** IPC 返回形状：失败时只有错误文案，渲染层据此显示「读取失败」而不是 0。 */
export type DshUsageResult = { success: true; snapshot: DshUsageSnapshot } | { success: false; error: string }

export interface DshUsagePricingOpenResult {
  success: boolean
  /** 是否本次新建了模板（用户第一次打开） */
  created?: boolean
  path?: string
  error?: string
}

/** 单价表：每 100 万 token 多少钱，单位由 `currency` 决定。 */
export interface DshRouteRates {
  input: number | null
  cacheRead: number | null
  cacheWrite: number | null
  output: number | null
}

/**
 * 价目表。`models` 是**高峰时段**单价，`offPeak` 是空闲时段单价；空闲价按官方说明是高峰价的一半，
 * 但这里仍分成两张表 —— 不同模型、不同时期的折扣不一定同步，写死「除以 2」迟早对不上账。
 * 时段判定见 `tariff.ts`（北京时间工作日 09:00-12:00、14:00-18:00 为高峰）。
 */
export interface DshPricingTable {
  currency: string
  models: Record<string, DshRouteRates>
  /** 空闲时段单价；缺省或某项全空表示不区分时段（一律按高峰价折算） */
  offPeak?: Record<string, DshRouteRates>
  /** 中国法定节假日（`YYYY-MM-DD`，北京时间）：全天按空闲价。内置官方日历按年维护，见 `main/dsh/calendar.ts` */
  holidays?: string[]
  /** @deprecated 调休补班日不再影响峰谷判定（周末始终全天空闲），保留仅为兼容旧价目表 */
  workdays?: string[]
  /**
   * 文件里在 `models`（高峰价）**真的写过**单价的键（`provider/model`、裸模型名或 `*`）。
   * 查价时这些键优先于内置精确键 —— 否则用户配的裸名/兜底价会被内置表遮蔽，等于没配。
   */
  fileKeys?: string[]
  /**
   * 文件里在 `offPeak`（空闲价）真的写过单价的键。
   * 单独记一份是因为：只写了高峰价时，空闲价必须跟随覆盖后的高峰价，不能再吃内置折扣。
   */
  fileOffPeakKeys?: string[]
  /** 合并前用户实际填写的桶；查价先遍历这些桶，再回退到内置表。 */
  fileModels?: Record<string, DshRouteRates>
  fileOffPeak?: Record<string, DshRouteRates>
}

export const DSH_USAGE_PRICING_FILE = 'dsh-usage-pricing.json'
export const DSH_USAGE_PRICING_VERSION = 1

/**
 * 把 token 数压成面板宽度内的短读数：999 → `999`，12345 → `12.3K`，1234567 → `1.23M`。
 * 非有限数一律回 `—`（未知 ≠ 0）。
 */
export function formatDshTokens(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (abs < 1000) return String(Math.round(value))
  const units: Array<[number, string]> = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K']
  ]
  for (const [size, suffix] of units) {
    if (abs < size) continue
    const scaled = value / size
    const magnitude = Math.abs(scaled)
    // 有效位随量级收缩，避免 `1234.5K` 这种既长又难读的读数
    const rounded = magnitude >= 100 ? Math.round(scaled) : magnitude >= 10 ? Math.round(scaled * 10) / 10 : Math.round(scaled * 100) / 100
    return `${rounded}${suffix}`
  }
  return '—'
}

const CURRENCY_SYMBOLS: Record<string, string> = { CNY: '¥', RMB: '¥', USD: '$', EUR: '€', GBP: '£', JPY: '¥' }

/** 费用读数：小额保留 4 位小数（0.0031 而不是 0.00），未知币种退化为「数值 + 代码」。 */
export function formatDshCost(amount: number, currency: string): string {
  if (!Number.isFinite(amount)) return '—'
  const code = (currency || '').trim().toUpperCase()
  const digits = Math.abs(amount) >= 0.005 ? 2 : 4
  const text = amount.toFixed(digits)
  const symbol = CURRENCY_SYMBOLS[code]
  return symbol ? `${symbol}${text}` : `${text} ${code || '?'}`
}

/** 缓存命中率：命中读 / (未命中输入 + 命中读 + 缓存写)。没有输入 token 时返回 null。 */
export function dshCacheHitRate(tokens: DshTokenBuckets): number | null {
  const prompt = tokens.uncachedInput + tokens.cacheRead + tokens.cacheWrite
  if (!Number.isFinite(prompt) || prompt <= 0) return null
  return tokens.cacheRead / prompt
}

export function formatDshPercent(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return '—'
  const percent = Math.round(rate * 1000) / 10
  return `${percent}%`
}

/** 本地零点：`today` 口径的唯一来源，主进程与测试共用。 */
export function startOfLocalDay(now: number): number {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** 本地日键 `YYYY-MM-DD`：折叠时按事件时间分天，跨天会话不会被算进同一天。 */
export function localDayKey(time: number): string {
  const date = new Date(time)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * 往前数 `daysAgo` 个**本地日历日**的零点。
 *
 * 用 `setDate` 做日历运算而不是「减 86400000 毫秒」：跨夏令时的那一天只有 23/25 小时，
 * 按毫秒减会让起点落在前一天 23:00 或次日 01:00，7/30 天的边界就整体偏一天。
 */
export function startOfLocalDayOffset(now: number, daysAgo: number): number {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() - daysAgo)
  return date.getTime()
}

/** 含今天在内的最近 `count` 个本地日键，**升序**（最后一项是今天）。 */
export function localDayKeys(now: number, count: number): string[] {
  const keys: string[] = []
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    keys.push(localDayKey(startOfLocalDayOffset(now, offset)))
  }
  return keys
}
