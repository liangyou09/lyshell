import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as zlib from 'node:zlib'
import { buildDshUsageSnapshot, normalizeSessionCwd, resetDshUsageCaches } from './usage-service'
import { beijingClock } from './tariff'

// 仓库的 @types/node 还没有 zstd 声明（能力检测在生产代码里做），测试这边按运行时取
const zstdCompressSync = (zlib as unknown as { zstdCompressSync?: (input: Buffer) => Buffer }).zstdCompressSync
const canCompress = typeof zstdCompressSync === 'function'

function compress(input: Buffer): Buffer {
  if (!zstdCompressSync) throw new Error('zstdCompressSync unavailable')
  return zstdCompressSync(input)
}
const DAY = 24 * 60 * 60 * 1000

const roots: string[] = []

afterEach(async () => {
  resetDshUsageCaches()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lyshell-dsh-usage-'))
  roots.push(root)
  return root
}

/**
 * 写一个真实形状的会话日志：**多个独立 zstd frame 顺序拼接**（dsh 就是这么落盘的），
 * 这样测试同时覆盖帧扫描与事件折叠两条链路。
 */
async function writeSession(
  root: string,
  options: { sessionId: string; events: unknown[]; cwd: string; version?: number; mtimeMs?: number }
): Promise<void> {
  const version = options.version ?? 4
  const dir = join(root, 'sessions', '--proj--', `session-${options.sessionId}`)
  await mkdir(dir, { recursive: true })
  const header = { type: 'session', version, id: `session-${options.sessionId}`, cwd: options.cwd, createdAt: 1, isSeeded: false }
  const lines = [header, ...options.events, { type: 'session/end-seed', data: {} }]
    .filter((event) => event !== null && event !== undefined)
    .map((event) => JSON.stringify(event))
  const middle = Math.ceil(lines.length / 2)
  const frames = [
    compress(Buffer.from(`${lines.slice(0, middle).join('\n')}\n`, 'utf8')),
    compress(Buffer.from(`${lines.slice(middle).join('\n')}\n`, 'utf8'))
  ]
  const file = join(dir, `session.v${version}.jsonl.zstd`)
  await writeFile(file, Buffer.concat(frames))
  if (options.mtimeMs !== undefined) {
    const when = new Date(options.mtimeMs)
    await utimes(file, when, when)
  }
}

function message(turn: number, step: number, usage: { input: number; output: number; cacheRead?: number }, time: number): unknown {
  return {
    type: 'assistant/message',
    time,
    data: {
      turn,
      step,
      message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } },
      usage: {
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead ?? 0,
        cacheWriteTokens: 0,
        totalTokens: usage.input + usage.output + (usage.cacheRead ?? 0)
      }
    }
  }
}

describe.skipIf(!canCompress)('buildDshUsageSnapshot', () => {
  it('会话目录存在但不可遍历时报告读取错误，不伪装没有日志', async () => {
    const root = await makeRoot()
    await writeFile(join(root, 'sessions'), 'not a directory')
    await expect(buildDshUsageSnapshot({ dshHome: root, cwd: null, pricingFile: join(root, 'p.json') })).rejects.toThrow()
  })

  it('完全损坏的日志不能显示零消耗；修复文件后重新读取', async () => {
    const root = await makeRoot()
    const dir = join(root, 'sessions', '--proj--', 'session-broken')
    await mkdir(dir, { recursive: true })
    const file = join(dir, 'session.v4.jsonl.zstd')
    await writeFile(file, 'not a zstd log')
    const options = { dshHome: root, cwd: null, pricingFile: join(root, 'pricing.json') }
    const broken = await buildDshUsageSnapshot(options)
    for (const scope of ['session', 'today', 'week', 'month'] as const) {
      expect(broken[scope]).toEqual({ ok: false, reason: 'unreadable' })
      expect(broken.cost[scope]).toBeNull()
      expect(broken.tariffCost[scope]).toEqual({ peak: null, offPeak: null })
    }
    expect(broken.partialLogs).toBe(1)
    await writeSession(root, { sessionId: 'broken', cwd: 'D:/w', events: [message(1, 1, { input: 10, output: 2 }, Date.now())] })
    const repaired = await buildDshUsageSnapshot(options)
    expect(repaired.session.ok && repaired.session.data.usage.totalTokens).toBe(12)
    expect(repaired.today.ok && repaired.today.data.totalTokens).toBe(12)
  })

  it('最新损坏日志不遮蔽可读会话，仍标记累计读数不完整', async () => {
    const root = await makeRoot()
    const now = Date.now()
    await writeSession(root, { sessionId: 'used', cwd: 'D:/w', events: [message(1, 1, { input: 10, output: 2 }, now)], mtimeMs: now - 1000 })
    const dir = join(root, 'sessions', '--proj--', 'session-broken')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'broken')
    const snapshot = await buildDshUsageSnapshot({ dshHome: root, cwd: null, pricingFile: join(root, 'pricing.json'), now })
    expect(snapshot.session.ok && snapshot.session.data.session.id).toBe('session-used')
    expect(snapshot.today.ok && snapshot.today.data.totalTokens).toBe(12)
    expect(snapshot.partialLogs).toBe(1)
  })

  it('会话口径按 cwd 匹配（分隔符归一化），四桶与轮次都对得上', async () => {
    const root = await makeRoot()
    const now = Date.now()
    await writeSession(root, {
      sessionId: 'a',
      cwd: 'D:\\workspace\\claude\\LyShell',
      events: [{ type: 'turn/start', time: now, data: { turn: 1 } }, message(1, 1, { input: 100, output: 10, cacheRead: 900 }, now)]
    })
    const snapshot = await buildDshUsageSnapshot({ dshHome: root, cwd: 'D:/workspace/claude/LyShell', pricingFile: join(root, 'pricing.json'), now })
    expect(snapshot.session.ok).toBe(true)
    if (!snapshot.session.ok) return
    expect(snapshot.session.data.session.cwd).toBe('D:\\workspace\\claude\\LyShell')
    expect(snapshot.session.data.usage.totalTokens).toBe(1010)
    expect(snapshot.session.data.usage.tokens.cacheRead).toBe(900)
    expect(snapshot.session.data.usage.requests).toBe(1)
    expect(snapshot.session.data.usage.turns).toBe(1)
    expect(snapshot.today.ok).toBe(true)
    if (!snapshot.today.ok) return
    expect(snapshot.today.data.sessions).toBe(1)
    expect(snapshot.today.data.totalTokens).toBe(1010)
    // 没有价目表文件：费用回落到内置官方价，来源要标明 builtin（不是「用户配的价」）
    expect(snapshot.pricing.configured).toBe(true)
    expect(snapshot.pricing.source).toBe('builtin')
    expect(snapshot.cost.session?.complete).toBe(true)
  })

  it('今日口径只算今天的部分，会话口径仍给整段；低版本日志不重复计数', async () => {
    const root = await makeRoot()
    const now = Date.now()
    await writeSession(root, {
      sessionId: 'b',
      cwd: 'D:/workspace/claude/LyShell',
      events: [
        message(1, 1, { input: 5, output: 1 }, now - DAY),
        message(2, 1, { input: 7, output: 3 }, now)
      ]
    })
    // 同一会话目录的 v3 世代必须被忽略（否则历史世代会重复计入）
    await writeSession(root, {
      sessionId: 'b',
      version: 3,
      cwd: 'D:/workspace/claude/LyShell',
      events: [message(1, 1, { input: 1000, output: 1000 }, now)]
    })
    const snapshot = await buildDshUsageSnapshot({ dshHome: root, cwd: 'D:/workspace/claude/LyShell', pricingFile: join(root, 'pricing.json'), now })
    if (!snapshot.session.ok || !snapshot.today.ok) throw new Error('scope unavailable')
    expect(snapshot.session.data.usage.totalTokens).toBe(16)
    expect(snapshot.today.data.totalTokens).toBe(10)
  })

  it('没有日志报 no-logs；目录不同不算取不到，只标记 withinTarget', async () => {
    const root = await makeRoot()
    const now = Date.now()
    const empty = await buildDshUsageSnapshot({ dshHome: root, cwd: 'D:/workspace/claude/LyShell', pricingFile: join(root, 'p.json'), now })
    expect(empty.session).toEqual({ ok: false, reason: 'no-logs' })
    expect(empty.today).toEqual({ ok: false, reason: 'no-logs' })
    // 7/30 天口径同理：读不到日志就说读不到，不能拿 30 行 0 冒充「这段时间没花钱」
    expect(empty.week).toEqual({ ok: false, reason: 'no-logs' })
    expect(empty.month).toEqual({ ok: false, reason: 'no-logs' })
    expect(empty.cost).toEqual({ session: null, today: null, week: null, month: null })

    await writeSession(root, { sessionId: 'c', cwd: 'D:/other/place', events: [message(1, 1, { input: 1, output: 1 }, now)] })
    const snapshot = await buildDshUsageSnapshot({ dshHome: root, cwd: 'D:/workspace/claude/LyShell', pricingFile: join(root, 'p.json'), now })
    if (!snapshot.session.ok) throw new Error('session should still resolve')
    // 「最近会话」是全局最新的那个：目录不同要说清楚来源，但不是「取不到」
    expect(snapshot.session.data.session.withinTarget).toBe(false)
    expect(snapshot.session.data.session.cwd).toBe('D:/other/place')
    expect(snapshot.session.data.usage.totalTokens).toBe(2)
    expect(snapshot.today.ok).toBe(true)

    // 目录一致时 withinTarget 为 true；连启动目标都没有（cwd=null）也算一致，只交代会话本身
    const same = await buildDshUsageSnapshot({ dshHome: root, cwd: 'D:/other/place', pricingFile: join(root, 'p.json'), now })
    expect(same.session.ok && same.session.data.session.withinTarget).toBe(true)
    const unknown = await buildDshUsageSnapshot({ dshHome: root, cwd: null, pricingFile: join(root, 'p.json'), now })
    expect(unknown.session.ok && unknown.session.data.session.withinTarget).toBe(true)
  })

  it('最新会话是空壳（只有会话头）时跳到上一个真正用过的会话', async () => {
    const root = await makeRoot()
    const now = Date.now()
    await writeSession(root, { sessionId: 'used', cwd: 'D:/w', events: [message(1, 1, { input: 40, output: 2 }, now - 5_000)] })
    // mtime 更新的空会话：dsh 先落会话头、用户还没发消息时就是这个形状
    await writeSession(root, { sessionId: 'seed', cwd: 'D:/w', events: [], mtimeMs: now })
    const snapshot = await buildDshUsageSnapshot({ dshHome: root, cwd: 'D:/w', pricingFile: join(root, 'p.json'), now })
    if (!snapshot.session.ok) throw new Error('scope unavailable')
    expect(snapshot.session.data.session.id).toBe('session-used')
    expect(snapshot.session.data.usage.totalTokens).toBe(42)
  })

  it('给了价目表就折算费用；缺单价的路由仍按未定价处理，不会悄悄少算', async () => {
    const root = await makeRoot()
    const now = Date.now()
    await writeSession(root, { sessionId: 'd', cwd: 'D:/w', events: [message(1, 1, { input: 100, output: 10, cacheRead: 900 }, now)] })
    const pricingFile = join(root, 'pricing.json')
    await writeFile(pricingFile, JSON.stringify({
      version: 1,
      currency: 'CNY',
      models: { 'deepseek-official/deepseek-flash': { input: 1, cacheRead: 0.1, cacheWrite: 1, output: 2 } }
    }))
    const snapshot = await buildDshUsageSnapshot({ dshHome: root, cwd: 'D:/w', pricingFile, now })
    expect(snapshot.pricing.configured).toBe(true)
    expect(snapshot.cost.session?.complete).toBe(true)
    // 100/1e6*1 + 900/1e6*0.1 + 10/1e6*2 = 0.00021
    expect(snapshot.cost.session?.amount ?? 0).toBeCloseTo(0.00021, 10)
  })
})

describe.skipIf(!canCompress)('7 / 30 天统计（week / month）', () => {
  // 高峰 2 元/M、空闲 1 元/M：一眼能看出「这条 token 落在哪一档」
  const PRICING = {
    version: 1,
    currency: 'CNY',
    models: { 'deepseek-official/deepseek-flash': { input: 2 } },
    offPeak: { 'deepseek-official/deepseek-flash': { input: 1 } }
  }

  async function writePricing(root: string, document: unknown): Promise<string> {
    const file = join(root, 'pricing.json')
    await writeFile(file, JSON.stringify(document))
    return file
  }

  it('daily 按本地日历日升序且长度固定 7 / 30，没活动的日子给完整 0 费用', async () => {
    const root = await makeRoot()
    const now = new Date(2026, 5, 15, 10, 0, 0).getTime()
    const pricingFile = await writePricing(root, PRICING)
    await writeSession(root, {
      sessionId: 'week',
      cwd: 'D:/w',
      events: [message(1, 1, { input: 1_000_000, output: 0 }, new Date(2026, 5, 15, 10, 0, 0).getTime())]
    })
    const snapshot = await buildDshUsageSnapshot({ dshHome: root, cwd: 'D:/w', pricingFile, now })
    if (!snapshot.week.ok || !snapshot.month.ok) throw new Error('period unavailable')
    const week = snapshot.week.data
    expect(week.startDay).toBe('2026-06-09')
    expect(week.endDay).toBe('2026-06-15')
    expect(week.daily.map((entry) => entry.day)).toEqual([
      '2026-06-09',
      '2026-06-10',
      '2026-06-11',
      '2026-06-12',
      '2026-06-13',
      '2026-06-14',
      '2026-06-15'
    ])
    const month = snapshot.month.data
    expect(month.daily).toHaveLength(30)
    expect(month.startDay).toBe('2026-05-17')
    expect(month.endDay).toBe('2026-06-15')
    // 30 天的窗口严格包含 7 天的窗口，且最后 7 项与 week 完全一致
    expect(month.daily.slice(-7).map((entry) => entry.day)).toEqual(week.daily.map((entry) => entry.day))

    const active = week.daily[6]
    expect(active.day).toBe('2026-06-15')
    expect(active.totalTokens).toBe(1_000_000)
    expect(active.cost?.complete).toBe(true)
    // 没活动的日子：读到日志了、也确实没用 token ⇒ 0 是已知的 0，不是 null
    for (const idle of [week.daily[0], week.daily[1], week.daily[2]]) {
      expect(idle.totalTokens).toBe(0)
      expect(idle.requests).toBe(0)
      expect(idle.cost).toEqual({ currency: 'CNY', amount: 0, complete: true, pricedRoutes: [], unpricedRoutes: [] })
    }
  })

  it('峰谷分别落在不同的事件上：每日金额之和必须等于周期金额', async () => {
    const root = await makeRoot()
    // 用 UTC 造时间：北京时间 10:00（高峰）与 21:00（空闲），不受本机时区影响
    const peakAt = Date.UTC(2026, 5, 15, 2, 0, 0)
    const offPeakAt = Date.UTC(2026, 5, 15, 13, 0, 0)
    const pricingFile = await writePricing(root, PRICING)
    await writeSession(root, {
      sessionId: 'tier',
      cwd: 'D:/w',
      events: [
        message(1, 1, { input: 1_000_000, output: 0 }, peakAt),
        message(2, 1, { input: 1_000_000, output: 0 }, offPeakAt)
      ],
      mtimeMs: offPeakAt
    })
    const snapshot = await buildDshUsageSnapshot({ dshHome: root, cwd: 'D:/w', pricingFile, now: offPeakAt })
    if (!snapshot.week.ok || !snapshot.month.ok) throw new Error('period unavailable')
    // 1M × 2（高峰）+ 1M × 1（空闲）
    expect(snapshot.cost.week?.amount ?? 0).toBeCloseTo(3, 10)
    expect(snapshot.cost.week?.complete).toBe(true)
    const weekSum = snapshot.week.data.daily.reduce((sum, entry) => sum + (entry.cost?.amount ?? 0), 0)
    expect(weekSum).toBeCloseTo(3, 10)
    const monthSum = snapshot.month.data.daily.reduce((sum, entry) => sum + (entry.cost?.amount ?? 0), 0)
    expect(monthSum).toBeCloseTo(snapshot.cost.month?.amount ?? 0, 10)
    expect(snapshot.week.data.offPeakTokens?.uncachedInput).toBe(1_000_000)
  })

  it('跨天的同一个会话：周会话数是去重后的 1，而不是每日会话数相加', async () => {
    const root = await makeRoot()
    const now = new Date(2026, 5, 15, 12, 0, 0).getTime()
    const pricingFile = await writePricing(root, PRICING)
    await writeSession(root, {
      sessionId: 'span',
      cwd: 'D:/w',
      events: [
        message(1, 1, { input: 1_000_000, output: 0 }, new Date(2026, 5, 14, 10, 0, 0).getTime()),
        message(2, 1, { input: 1_000_000, output: 0 }, new Date(2026, 5, 15, 10, 0, 0).getTime())
      ]
    })
    const snapshot = await buildDshUsageSnapshot({ dshHome: root, cwd: 'D:/w', pricingFile, now })
    if (!snapshot.week.ok || !snapshot.today.ok) throw new Error('period unavailable')
    const week = snapshot.week.data
    expect(week.sessions).toBe(1)
    const perDaySessions = week.daily.reduce((sum, entry) => sum + entry.sessions, 0)
    expect(perDaySessions).toBe(2)
    expect(snapshot.today.data.sessions).toBe(1)
    expect(week.totalTokens).toBe(2_000_000)
    // 今天那一格与 today 口径必须同源
    const todayEntry = week.daily[week.daily.length - 1]
    expect(todayEntry.totalTokens).toBe(snapshot.today.data.totalTokens)
    expect(todayEntry.requests).toBe(snapshot.today.data.requests)
  })

  it('窗口跨月跨年：30 天回到上一年，7 天回到上一月', async () => {
    const root = await makeRoot()
    const now = new Date(2026, 0, 2, 10, 0, 0).getTime()
    const pricingFile = await writePricing(root, PRICING)
    const lastYear = new Date(2025, 11, 10, 10, 0, 0).getTime()
    await writeSession(root, {
      sessionId: 'year',
      cwd: 'D:/w',
      events: [message(1, 1, { input: 1_000_000, output: 0 }, lastYear)],
      mtimeMs: lastYear
    })
    const snapshot = await buildDshUsageSnapshot({ dshHome: root, cwd: 'D:/w', pricingFile, now })
    if (!snapshot.week.ok || !snapshot.month.ok) throw new Error('period unavailable')
    expect(snapshot.week.data.startDay).toBe('2025-12-27')
    expect(snapshot.week.data.endDay).toBe('2026-01-02')
    expect(snapshot.month.data.startDay).toBe('2025-12-04')
    expect(snapshot.month.data.daily).toHaveLength(30)
    // 去年的消耗只进 30 天口径，不进 7 天口径
    expect(snapshot.week.data.totalTokens).toBe(0)
    expect(snapshot.month.data.totalTokens).toBe(1_000_000)
    const crossYear = snapshot.month.data.daily.find((entry) => entry.day === '2025-12-10')
    expect(crossYear?.totalTokens).toBe(1_000_000)
    // 2025 年没有内置节假日日历：有消耗就必须让界面知道费用会偏高
    expect(snapshot.pricing.calendarWarningYears).toEqual([2025])
  })

  it('日历变了（新增法定节假日）会作废折叠缓存，不会继续按高峰价算', async () => {
    const root = await makeRoot()
    // 北京时间 2026-06-15 10:00（周一高峰）
    const at = Date.UTC(2026, 5, 15, 2, 0, 0)
    const beijingDay = beijingClock(at).dayKey
    await writeSession(root, {
      sessionId: 'calendar',
      cwd: 'D:/w',
      events: [message(1, 1, { input: 1_000_000, output: 0 }, at)],
      mtimeMs: at
    })
    const file = await writePricing(root, PRICING)
    const first = await buildDshUsageSnapshot({ dshHome: root, cwd: 'D:/w', pricingFile: file, now: at })
    expect(first.cost.week?.amount ?? 0).toBeCloseTo(2, 10)
    // 同一天改成法定节假日（日志文件没变，折叠缓存会命中）：判定必须重建
    await writePricing(root, { ...PRICING, holidays: [beijingDay] })
    const second = await buildDshUsageSnapshot({ dshHome: root, cwd: 'D:/w', pricingFile: file, now: at })
    expect(second.cost.week?.amount ?? 0).toBeCloseTo(1, 10)
  })
})

describe.skipIf(!canCompress)('峰谷与周期部分定价的集成', () => {
  it('同路由跨天缺不同桶价格时，保留已知日期的金额且保持partial元数据', async () => {
    const root = await makeRoot()
    const peakAt = Date.UTC(2026, 5, 15, 2)
    const idleAt = Date.UTC(2026, 5, 16, 13)
    const pricingFile = join(root, 'usd.json')
    await writeFile(pricingFile, JSON.stringify({ currency: 'USD', models: { 'deepseek-official/deepseek-flash': { input: 2 } } }))
    await writeSession(root, {
      sessionId: 'partial-day', cwd: 'D:/w', mtimeMs: idleAt,
      events: [message(1, 1, { input: 1_000_000, output: 0 }, peakAt), message(2, 1, { input: 0, output: 1_000_000 }, idleAt)]
    })
    const snapshot = await buildDshUsageSnapshot({ dshHome: root, cwd: 'D:/w', pricingFile, now: idleAt })
    for (const scope of ['week', 'month'] as const) {
      const part = snapshot[scope]
      if (!part.ok) throw new Error('period unavailable')
      expect(snapshot.cost[scope]?.amount).toBe(2)
      expect(snapshot.cost[scope]?.complete).toBe(false)
      expect(snapshot.cost[scope]?.unpricedRoutes).toEqual(['deepseek-official/deepseek-flash'])
      expect(part.data.daily.reduce((sum, day) => sum + (day.cost?.amount ?? 0), 0)).toBe(2)
      expect(snapshot.tariffCost[scope].peak?.amount).toBe(2)
      expect(snapshot.tariffCost[scope].offPeak).toBeNull()
    }
    expect(snapshot.cost.today).toBeNull()
    expect(snapshot.tariffCost.today.peak?.amount).toBe(0)
    expect(snapshot.tariffCost.today.offPeak).toBeNull()
  })

  it('四个范围都按实际峰谷桶计价，峰谷之和等于总额，空白日期为0', async () => {
    const root = await makeRoot()
    const peakAt = Date.UTC(2026, 5, 15, 2)
    const idleAt = Date.UTC(2026, 5, 15, 13)
    await writeSession(root, { sessionId: 'tariff', cwd: 'D:/w', mtimeMs: idleAt, events: [
      message(1, 1, { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000 }, peakAt),
      message(2, 1, { input: 3_000_000, output: 100_000, cacheRead: 10_000_000 }, idleAt)
    ] })
    const snapshot = await buildDshUsageSnapshot({ dshHome: root, cwd: 'D:/w', pricingFile: join(root, 'missing.json'), now: idleAt })
    for (const scope of ['session', 'today', 'week', 'month'] as const) {
      expect(snapshot.tariffCost[scope].peak?.amount).toBeCloseTo(10.04, 10)
      expect(snapshot.tariffCost[scope].offPeak?.amount).toBeCloseTo(3.6, 10)
      expect(snapshot.cost[scope]?.amount).toBeCloseTo(13.64, 10)
    }
    if (!snapshot.week.ok) throw new Error('period unavailable')
    expect(snapshot.week.data.daily[0].cost?.amount).toBe(0)
  })

  it('无日志时四个范围的峰谷费用都是未知', async () => {
    const root = await makeRoot()
    const snapshot = await buildDshUsageSnapshot({ dshHome: root, cwd: null, pricingFile: join(root, 'missing.json') })
    for (const scope of ['session', 'today', 'week', 'month'] as const) {
      expect(snapshot.tariffCost[scope]).toEqual({ peak: null, offPeak: null })
    }
  })
})

describe('normalizeSessionCwd', () => {
  it('统一分隔符并去掉尾斜杠，让同一目录的两种写法能匹配上', () => {
    expect(normalizeSessionCwd('D:\\workspace\\claude\\LyShell')).toBe(normalizeSessionCwd('D:/workspace/claude/LyShell'))
    expect(normalizeSessionCwd('D:/w/')).toBe(normalizeSessionCwd('D:\\w'))
    expect(normalizeSessionCwd('')).toBeNull()
    expect(normalizeSessionCwd(null)).toBeNull()
  })
})
