import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BUILTIN_DSH_PRICING,
  canonicalDshModelRoute,
  canonicalPricingCurrency,
  ensureDshPricingTemplate,
  estimateDshCost,
  estimateDshCostBreakdown,
  buildDshPricingTemplate,
  loadDshPricing,
  parseDshPricing,
  zeroDshCost
} from './pricing'
import { emptyDshTokenBuckets, totalDshTokens, type DshRouteUsage, type DshTokenBuckets } from '@shared/dsh-usage'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lyshell-dsh-pricing-'))
  roots.push(root)
  return root
}

function route(name: string, tokens: Partial<DshTokenBuckets>): DshRouteUsage {
  const buckets = { ...emptyDshTokenBuckets(), ...tokens }
  const [provider, model] = name.includes('/') ? name.split('/') : ['', name]
  return { route: name, provider, model, tokens: buckets, totalTokens: totalDshTokens(buckets), requests: 1 }
}

const table = parseDshPricing({
  version: 1,
  currency: 'USD',
  models: {
    'deepseek-official/deepseek-flash': { input: 1, cacheRead: 0.1, cacheWrite: 2, output: 4 },
    'deepseek-v4-pro': { input: 8, cacheRead: 1, cacheWrite: 8, output: 16 },
    '*': { input: 100, cacheRead: 100, cacheWrite: 100, output: 100 }
  }
})

if (!table.ok) throw new Error(table.error)

describe('parseDshPricing', () => {
  it('读出版本、币种与逐路由单价，缺失的币种回落默认值', () => {
    expect(table.table.currency).toBe('USD')
    const bare = parseDshPricing({ models: { 'p/m': { input: 1 } } })
    if (!bare.ok) throw new Error(bare.error)
    expect(bare.table.currency).toBe('CNY')
    expect(bare.table.models['p/m']).toEqual({ input: 1, cacheRead: null, cacheWrite: null, output: null })
  })

  it('版本不符、单价为负、结构不是对象都明确报错', () => {
    expect(parseDshPricing({ version: 9 }).ok).toBe(false)
    expect(parseDshPricing({ models: { m: { input: -1 } } })).toEqual({
      ok: false,
      error: 'models["m"].input must be a non-negative number or null'
    })
    expect(parseDshPricing({ models: [] }).ok).toBe(false)
    expect(parseDshPricing(null).ok).toBe(false)
  })

  it('没有文件就用内置官方价，来源标成 builtin 而不是错误', async () => {
    const root = await makeRoot()
    const missing = await loadDshPricing(join(root, 'nope.json'))
    expect(missing.table).toBe(BUILTIN_DSH_PRICING)
    expect(missing.configured).toBe(true)
    expect(missing.source).toBe('builtin')
    expect(missing.currency).toBe('CNY')
    expect(missing.error).toBeNull()
    expect(missing.rates).toBe(3)
    expect(missing.offPeakRates).toBe(3)
  })

  it('坏 JSON 报错但仍然用内置价兜底：费用不能因为一个逗号就消失', async () => {
    const root = await makeRoot()
    const broken = join(root, 'broken.json')
    await writeFile(broken, '{ not json', 'utf8')
    const loaded = await loadDshPricing(broken)
    expect(loaded.configured).toBe(true)
    expect(loaded.source).toBe('builtin')
    expect(loaded.error).toContain('invalid JSON')
    const estimate = estimateDshCost([route('deepseek-official/deepseek-flash', { output: 1_000_000 })], loaded.table)
    expect(estimate?.amount ?? 0).toBeCloseTo(8, 10)
  })

  it('文件里的单价按桶覆盖内置价，没写的桶继续用内置价', async () => {
    const root = await makeRoot()
    const file = join(root, 'p.json')
    await writeFile(file, JSON.stringify({
      version: 1,
      currency: 'CNY',
      models: { 'deepseek-official/deepseek-flash': { input: 1 } }
    }), 'utf8')
    const loaded = await loadDshPricing(file)
    expect(loaded.source).toBe('file')
    const estimate = estimateDshCost([
      route('deepseek-official/deepseek-flash', { uncachedInput: 1_000_000, output: 1_000_000 })
    ], loaded.table)
    // input 走文件里的 1，output 仍走内置的 8
    expect(estimate?.amount ?? 0).toBeCloseTo(9, 10)
  })
})

describe('estimateDshCost', () => {
  it('没有价目表返回 null —— 不是 0 元', () => {
    expect(estimateDshCost([route('deepseek-official/deepseek-flash', { uncachedInput: 1000 })], null)).toBeNull()
  })

  it('按四桶分别计价，精确匹配优先', () => {
    const estimate = estimateDshCost([
      route('deepseek-official/deepseek-flash', { uncachedInput: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, output: 1_000_000 })
    ], table.table)
    expect(estimate?.complete).toBe(true)
    expect(estimate?.currency).toBe('USD')
    expect(estimate?.amount ?? 0).toBeCloseTo(1 + 0.1 + 2 + 4, 10)
  })

  it('退化到裸模型名与 * 兜底，让同一模型的不同 provider 共用单价', () => {
    const bare = estimateDshCost([route('other-provider/deepseek-v4-pro', { uncachedInput: 1_000_000 })], table.table)
    expect(bare?.amount ?? 0).toBeCloseTo(8, 10)
    const wildcard = estimateDshCost([route('mystery/model', { output: 1_000_000 })], table.table)
    expect(wildcard?.amount ?? 0).toBeCloseTo(100, 10)
  })

  it('有 token 但缺单价 ⇒ 该路由未定价，complete:false 且金额只含已定价部分', () => {
    const estimate = estimateDshCost([
      route('deepseek-official/deepseek-flash', { output: 1_000_000 }),
      route('unpriced/model-x', { output: 1_000_000 })
    ], { currency: 'CNY', models: { 'deepseek-official/deepseek-flash': { input: 1, cacheRead: 1, cacheWrite: 1, output: 2 } } })
    expect(estimate?.complete).toBe(false)
    expect(estimate?.pricedRoutes).toEqual(['deepseek-official/deepseek-flash'])
    expect(estimate?.unpricedRoutes).toEqual(['unpriced/model-x'])
    expect(estimate?.amount ?? 0).toBeCloseTo(2, 10)
  })

  it('一条路由都定不了价返回 null（界面显示破折号而不是半截金额）', () => {
    expect(estimateDshCost([route('unpriced/model-x', { output: 10 })], { currency: 'CNY', models: {} })).toBeNull()
  })
})

describe('峰谷费用明细', () => {
  it('四桶按所属时段单价计算，不能按 token 比例分摊总价', () => {
    const sample = route('deepseek-official/deepseek-flash', { uncachedInput: 1_000_000, cacheRead: 1_000_000, output: 1_000_000 })
    sample.offPeakTokens = { uncachedInput: 800_000, cacheRead: 100_000, cacheWrite: 0, output: 100_000 }
    const estimate = estimateDshCostBreakdown([sample], BUILTIN_DSH_PRICING)
    expect(estimate.peak?.amount).toBeCloseTo(7.636, 10)
    expect(estimate.offPeak?.amount).toBeCloseTo(1.202, 10)
    expect(estimate.total?.amount).toBeCloseTo(8.838, 10)
  })

  it('有真实空闲用量但该档全未定价时，不能标记完整0元', () => {
    const known = route('deepseek-official/deepseek-flash', { uncachedInput: 1_000_000 })
    const unknown = route('third/unknown', { uncachedInput: 1_000_000 })
    unknown.offPeakTokens = unknown.tokens
    const estimate = estimateDshCostBreakdown([known, unknown], BUILTIN_DSH_PRICING)
    expect(estimate.total?.amount).toBe(2)
    expect(estimate.total?.complete).toBe(false)
    expect(estimate.peak?.amount).toBe(2)
    expect(estimate.offPeak).toBeNull()
    expect(estimate.unpricedRoutes).toEqual(['third/unknown'])
  })

  it('全部未定价仍保留缺价路由，实际零用量时段才可返回0', () => {
    const unknown = route('third/unknown', { uncachedInput: 1_000_000 })
    unknown.offPeakTokens = unknown.tokens
    const estimate = estimateDshCostBreakdown([unknown], BUILTIN_DSH_PRICING)
    expect(estimate.total).toBeNull()
    expect(estimate.offPeak).toBeNull()
    expect(estimate.peak?.amount).toBe(0)
    expect(estimate.peak?.complete).toBe(true)
    expect(estimate.unpricedRoutes).toEqual(['third/unknown'])
  })
})

describe('价目表模板', () => {
  it('并发创建只有一个写入者，其余请求不会覆盖先创建的模板', async () => {
    const root = await makeRoot()
    const file = join(root, 'concurrent.json')
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => ensureDshPricingTemplate(file, [`p/model-${index}`])))
    expect(results.filter(result => result.created)).toHaveLength(1)
    const winner = results.findIndex(result => result.created)
    expect(await readFile(file, 'utf8')).toBe(buildDshPricingTemplate([`p/model-${winner}`]))
  })

  it('把真实出现过的路由去重排序列好，单价留 null', () => {
    const text = buildDshPricingTemplate(['b/model', 'a/model', 'b/model', ''], 'USD')
    const parsed = JSON.parse(text) as { version: number; currency: string; models: Record<string, unknown> }
    expect(parsed.version).toBe(1)
    expect(parsed.currency).toBe('USD')
    expect(Object.keys(parsed.models)).toEqual(['*', 'a/model', 'b/model'])
    expect(parsed.models['a/model']).toEqual({ input: null, cacheRead: null, cacheWrite: null, output: null })
    expect(text.endsWith('\n')).toBe(true)
  })

  it('rates 只数真正填了数字的路由；空模板算 builtin，填了就变成 file', async () => {
    const root = await makeRoot()
    const file = join(root, 'p.json')
    await writeFile(file, buildDshPricingTemplate(['a/model']), 'utf8')
    const empty = await loadDshPricing(file)
    // 模板里全是 null：一条单价都没贡献，费用整份来自内置表
    expect(empty.source).toBe('builtin')
    expect(empty.rates).toBe(3)
    await writeFile(file, JSON.stringify({
      version: 1,
      currency: 'CNY',
      models: {
        'a/model': { input: 1 },
        'b/model': { input: null, cacheRead: null, cacheWrite: null, output: null }
      }
    }), 'utf8')
    const loaded = await loadDshPricing(file)
    expect(loaded.configured).toBe(true)
    expect(loaded.source).toBe('file')
    // 内置 3 条 + 文件填的 a/model；b/model 全 null 不算
    expect(loaded.rates).toBe(4)
  })

  it('首次打开生成模板，已存在的文件绝不覆盖', async () => {
    const root = await makeRoot()
    const file = join(root, 'pricing.json')
    expect(await ensureDshPricingTemplate(file, ['p/m'])).toEqual({ created: true })
    const filled = '{"version":1,"currency":"CNY","models":{"p/m":{"input":9}}}\n'
    await writeFile(file, filled, 'utf8')
    expect(await ensureDshPricingTemplate(file, ['p/m'])).toEqual({ created: false })
    expect(await readFile(file, 'utf8')).toBe(filled)
  })
})

describe('高峰 / 空闲两档单价', () => {
  const tiered = parseDshPricing({
    version: 1,
    currency: 'CNY',
    models: { 'p/m': { input: 2, cacheRead: 0.04, cacheWrite: 2, output: 8 } },
    offPeak: { 'p/m': { input: 1, cacheRead: 0.02, cacheWrite: 1, output: 4 } }
  })
  if (!tiered.ok) throw new Error(tiered.error)

  function offPeakRoute(tokens: Partial<DshTokenBuckets>, offPeak: Partial<DshTokenBuckets>): DshRouteUsage {
    const usage = route('p/m', tokens)
    return { ...usage, offPeakTokens: { ...emptyDshTokenBuckets(), ...offPeak } }
  }

  it('只对落在空闲时段的那部分套空闲价，其余仍按高峰价', () => {
    const usage = offPeakRoute({ uncachedInput: 1_000_000, output: 1_000_000 }, { uncachedInput: 400_000 })
    // 高峰：0.6M 输入 × 2 + 1M 输出 × 8 = 1.2 + 8；空闲：0.4M 输入 × 1 = 0.4
    expect(estimateDshCost([usage], tiered.table)?.amount).toBeCloseTo(9.6, 10)
  })

  it('没给空闲价就按高峰价算（宁可高估，也不凭空给折扣）', () => {
    const peakOnly = parseDshPricing({ models: { 'p/m': { input: 2 } } })
    if (!peakOnly.ok) throw new Error(peakOnly.error)
    const usage = offPeakRoute({ uncachedInput: 1_000_000 }, { uncachedInput: 1_000_000 })
    expect(estimateDshCost([usage], peakOnly.table)?.amount).toBeCloseTo(2, 10)
  })

  it('模板里的 offPeak 全是 null 等于没填：解析时丢弃，不再拖累整条路由', () => {
    const parsed = parseDshPricing({ models: { 'p/m': { input: 2 } }, offPeak: { 'p/m': { input: null } } })
    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.table.offPeak).toEqual({})
    const usage = offPeakRoute({ uncachedInput: 500_000 }, { uncachedInput: 500_000 })
    expect(estimateDshCost([usage], parsed.table)?.amount).toBeCloseTo(1, 10)
  })

  it('节假日与补班日只认 YYYY-MM-DD，写错就整表报错', () => {
    expect(parseDshPricing({ models: {}, holidays: ['2026-10-01'], workdays: ['2026-10-11'] }).ok).toBe(true)
    const bad = parseDshPricing({ models: {}, holidays: ['2026/10/01'] })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toContain('holidays entries must be YYYY-MM-DD')
  })
})

describe('审查发现的五个缺陷（回归）', () => {
  async function loadFrom(document: unknown): Promise<Awaited<ReturnType<typeof loadDshPricing>>> {
    const root = await makeRoot()
    const file = join(root, 'p.json')
    await writeFile(file, JSON.stringify(document), 'utf8')
    return loadDshPricing(file)
  }

  function withOffPeak(name: string, tokens: Partial<DshTokenBuckets>, offPeak: Partial<DshTokenBuckets>): DshRouteUsage {
    const usage = route(name, tokens)
    return { ...usage, offPeakTokens: { ...emptyDshTokenBuckets(), ...offPeak } }
  }

  it('精确键只覆盖部分桶时，其他桶仍优先采用用户的兜底价', async () => {
    const loaded = await loadFrom({ currency: 'CNY', models: {
      'deepseek-official/deepseek-flash': { input: 5 },
      '*': { output: 100 }
    } })
    const estimate = estimateDshCost([route('deepseek-official/deepseek-flash', {
      uncachedInput: 1_000_000, output: 1_000_000
    })], loaded.table)
    expect(estimate?.amount).toBe(105)
  })

  it('[1] 只覆盖高峰价时，空闲价跟随覆盖后的高峰价，不再留内置折扣', async () => {
    const loaded = await loadFrom({
      version: 1,
      currency: 'CNY',
      models: { 'deepseek-official/deepseek-flash': { input: 5 } }
    })
    const flash = withOffPeak(
      'deepseek-official/deepseek-flash',
      { uncachedInput: 1_000_000 },
      { uncachedInput: 1_000_000 }
    )
    // 修复前空闲时段按内置的 1 元算，用户把高峰价改成 5 之后仍然只收 1 元
    expect(estimateDshCost([flash], loaded.table)?.amount ?? 0).toBeCloseTo(5, 10)
    // 别的路由没被文件碰过，内置空闲价照旧
    const pro = withOffPeak(
      'deepseek-official/deepseek-v4-pro',
      { uncachedInput: 1_000_000 },
      { uncachedInput: 1_000_000 }
    )
    expect(estimateDshCost([pro], loaded.table)?.amount ?? 0).toBeCloseTo(4.5, 10)
  })

  it('[2] 文件写别的币种时不叠加内置人民币价：没填的桶是未知，不是美元数字', async () => {
    const usd = await loadFrom({ version: 1, currency: 'USD', models: {} })
    expect(usd.currency).toBe('USD')
    expect(usd.configured).toBe(false)
    expect(usd.source).toBe('none')
    // 修复前：100 万高峰 Flash 输入被当成 $2 报出来
    expect(estimateDshCost([route('deepseek-official/deepseek-flash', { uncachedInput: 1_000_000 })], usd.table)).toBeNull()

    const partial = await loadFrom({
      version: 1,
      currency: 'USD',
      models: { 'deepseek-official/deepseek-flash': { input: 2 } }
    })
    // 文件自己写的桶按美元算
    const inputOnly = estimateDshCost([route('deepseek-official/deepseek-flash', { uncachedInput: 1_000_000 })], partial.table)
    expect(inputOnly?.currency).toBe('USD')
    expect(inputOnly?.amount ?? 0).toBeCloseTo(2, 10)
    // 没填的桶仍然是未知：输出 token 定不了价，不能拿人民币内置价顶上
    const outputOnly = estimateDshCost([route('deepseek-official/deepseek-flash', { output: 1_000_000 })], partial.table)
    expect(outputOnly).toBeNull()
  })

  it('[2] CNY 与 RMB 是同一个人民币：共用内置价，币种归一成 CNY', async () => {
    expect(canonicalPricingCurrency('rmb')).toBe('CNY')
    expect(canonicalPricingCurrency(' usd ')).toBe('USD')
    const rmb = await loadFrom({ version: 1, currency: 'RMB', models: {} })
    expect(rmb.currency).toBe('CNY')
    expect(rmb.source).toBe('builtin')
    expect(rmb.rates).toBe(3)
    expect(
      estimateDshCost([route('deepseek-official/deepseek-flash', { uncachedInput: 1_000_000 })], rmb.table)?.amount ?? 0
    ).toBeCloseTo(2, 10)
  })

  it('[3] 官方旧 Flash 名按 Flash 价计费，第三方同名路由不算官方', () => {
    expect(canonicalDshModelRoute('deepseek-official/deepseek-v4-flash')).toBe('deepseek-official/deepseek-flash')
    expect(canonicalDshModelRoute('deepseek-account/deepseek-v4-flash-vision-exp')).toBe('deepseek-account/deepseek-flash')
    expect(canonicalDshModelRoute('other-provider/deepseek-v4-flash')).toBeNull()
    expect(canonicalDshModelRoute('deepseek-v4-flash')).toBeNull()

    const official = estimateDshCost(
      [route('deepseek-official/deepseek-v4-flash-vision-exp', { uncachedInput: 1_000_000, output: 1_000_000 })],
      BUILTIN_DSH_PRICING
    )
    expect(official?.amount ?? 0).toBeCloseTo(2 + 8, 10)
    expect(official?.complete).toBe(true)
    // 第三方同名路由不能被当成官方 Flash
    expect(estimateDshCost([route('other-provider/deepseek-v4-flash', { output: 1_000_000 })], BUILTIN_DSH_PRICING)).toBeNull()
  })

  it('[4] 文件里的裸模型名与 * 兜底不会被内置精确键遮蔽', async () => {
    const wildcard = await loadFrom({
      version: 1,
      currency: 'CNY',
      models: { '*': { input: 100, cacheRead: 100, cacheWrite: 100, output: 100 } }
    })
    expect(
      estimateDshCost([route('deepseek-official/deepseek-flash', { uncachedInput: 1_000_000 })], wildcard.table)?.amount ?? 0
    ).toBeCloseTo(100, 10)

    const bare = await loadFrom({ version: 1, currency: 'CNY', models: { 'deepseek-flash': { input: 50 } } })
    expect(
      estimateDshCost([route('deepseek-official/deepseek-flash', { uncachedInput: 1_000_000 })], bare.table)?.amount ?? 0
    ).toBeCloseTo(50, 10)
  })

  it('零价是有效单价（免费），不是未知', () => {
    const parsed = parseDshPricing({
      currency: 'CNY',
      models: { 'p/m': { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } }
    })
    if (!parsed.ok) throw new Error(parsed.error)
    const estimate = estimateDshCost([route('p/m', { output: 1_000_000 })], parsed.table)
    expect(estimate).toEqual({
      currency: 'CNY',
      amount: 0,
      complete: true,
      pricedRoutes: ['p/m'],
      unpricedRoutes: []
    })
  })

  it('零消耗费用是完整的 0，没有价目表才是 null', () => {
    expect(zeroDshCost(BUILTIN_DSH_PRICING)).toEqual({
      currency: 'CNY',
      amount: 0,
      complete: true,
      pricedRoutes: [],
      unpricedRoutes: []
    })
    expect(zeroDshCost(null)).toBeNull()
  })

  it('空白模板不切段官方峰谷表：写入模板后内置空闲价仍然生效', async () => {
    const root = await makeRoot()
    const file = join(root, 'p.json')
    await writeFile(file, buildDshPricingTemplate(['deepseek-official/deepseek-flash']), 'utf8')
    const loaded = await loadDshPricing(file)
    expect(loaded.source).toBe('builtin')
    const flash = withOffPeak(
      'deepseek-official/deepseek-flash',
      { uncachedInput: 1_000_000 },
      { uncachedInput: 1_000_000 }
    )
    expect(estimateDshCost([flash], loaded.table)?.amount ?? 0).toBeCloseTo(1, 10)
  })
})
