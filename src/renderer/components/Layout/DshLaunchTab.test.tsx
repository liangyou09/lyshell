// @vitest-environment jsdom
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DshLaunchTab } from './DshLaunchTab'
import { DSH_WEB_INSTALL_COMMAND, HARNESS_AGENT_VIEWS } from '../../../shared/harness'
import type { DshCostEstimate, DshPeriodUsage, DshTokenBuckets, DshUsageSnapshot } from '../../../shared/dsh-usage'

const fixture = vi.hoisted(() => ({ open: false, t: (key: string) => key }))
// 用量读数走 preload 的 electronAPI：这里只替换两个方法，组件其余行为保持原样
const usageApi = vi.hoisted(() => ({ getDshUsage: vi.fn(), openDshUsagePricing: vi.fn() }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: fixture.t, i18n: { resolvedLanguage: 'zh', language: 'zh' } }) }))
vi.mock('../../stores/pane-store', () => ({ usePaneStore: (selector: (state: unknown) => unknown) => selector({
  overlayPayloads: fixture.open ? { __dsh_web__: { kind: 'dshWeb' } } : {}
}) }))

/** 四桶夹具：数值刻意让缓存读远大于未缓存输入（真实分布就是这样）。 */
function buckets(uncachedInput: number, cacheRead: number, cacheWrite: number, output: number): DshTokenBuckets {
  return { uncachedInput, cacheRead, cacheWrite, output }
}

function periodWith(days: number): DshPeriodUsage {
  return {
    tokens: buckets(10_000, 200_000, 0, 5000), totalTokens: 215000, requests: 30, turns: 20,
    routes: [], sessions: 4, startDay: days === 7 ? '2026-10-16' : '2026-09-23', endDay: '2026-10-22',
    daily: Array.from({ length: days }, (_, index) => {
      const day = new Date(2026, 9, 22 - days + 1 + index)
      return {
        day: `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`,
        tokens: buckets(1000, 20000, 0, 500), totalTokens: 21500, requests: 3, turns: 2, sessions: 1, routes: [],
        cost: { currency: 'CNY', amount: index / 10, complete: true, pricedRoutes: [], unpricedRoutes: [] }
      }
    })
  }
}

function costValue(amount: number): DshCostEstimate {
  return { currency: 'CNY', amount, complete: true, pricedRoutes: [], unpricedRoutes: [] }
}

function snapshotWith(overrides: Partial<DshUsageSnapshot> = {}): DshUsageSnapshot {
  return {
    generatedAt: 1,
    dayStart: 0,
    session: {
      ok: true,
      data: {
        session: { id: 'session-1', title: '布局重做', cwd: 'D:/workspace/claude/LyShell', createdAt: 1, lastActivityAt: 2, withinTarget: true },
        usage: { tokens: buckets(1000, 20000, 0, 500), totalTokens: 21500, requests: 3, turns: 2, routes: [] }
      }
    },
    today: {
      ok: true,
      data: { tokens: buckets(2000, 30000, 0, 800), totalTokens: 32800, requests: 5, turns: 3, routes: [], sessions: 2 }
    },
    week: { ok: true, data: periodWith(7) },
    month: { ok: true, data: periodWith(30) },
    cost: {
      session: { currency: 'CNY', amount: 0.0012, complete: false, pricedRoutes: ['deepseek-official/deepseek-flash'], unpricedRoutes: ['deepseek-official/deepseek-v4-pro'] },
      today: null,
      week: { currency: 'CNY', amount: 2.1, complete: true, pricedRoutes: [], unpricedRoutes: [] },
      month: { currency: 'CNY', amount: 43.5, complete: true, pricedRoutes: [], unpricedRoutes: [] }
    },
    tariffCost: {
      session: { peak: costValue(0.0010), offPeak: costValue(0.0002) },
      today: { peak: null, offPeak: null },
      week: { peak: costValue(1.5), offPeak: costValue(0.6) },
      month: { peak: costValue(30), offPeak: costValue(13.5) }
    },
    pricing: { configured: true, source: 'file', currency: 'CNY', file: '/tmp/dsh-usage-pricing.json', error: null, rates: 4 },
    partialLogs: 1,
    decodedLogs: 2,
    ...overrides
  }
}

beforeEach(() => {
  usageApi.getDshUsage.mockReset().mockResolvedValue({ success: true, snapshot: snapshotWith() })
  usageApi.openDshUsagePricing.mockReset().mockResolvedValue({ success: true, created: false })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = usageApi
})

afterEach(() => { cleanup(); fixture.open = false; vi.unstubAllGlobals() })

describe('DeepSeek Harness Launch 槽', () => {
  it('Web 安装提示只需 dsh，终端工作区的安装提示仍包含 dsh-tui', () => {
    expect(DSH_WEB_INSTALL_COMMAND).toBe('npm install -g @deepseek-ai/dsh')
    expect(HARNESS_AGENT_VIEWS.dsh.installCommand).toBe('npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui')
  })

  it('默认只显示鲸鱼，点击才启动；StrictMode 和连点不重复提交', async () => {
    let finish!: (result: { success: boolean }) => void
    const launch = vi.fn(() => new Promise<{ success: boolean }>(resolve => { finish = resolve }))
    const view = render(<StrictMode><DshLaunchTab onLaunch={launch} /></StrictMode>)
    const button = view.getByRole('button', { name: 'dshMarket.workbench' }) as HTMLButtonElement
    expect(launch).not.toHaveBeenCalled()
    fireEvent.click(button)
    expect(launch).toHaveBeenCalledOnce()
    expect(button.getAttribute('aria-busy')).toBe('true')
    fireEvent.click(button)
    expect(launch).toHaveBeenCalledOnce()
    await act(async () => { finish({ success: true }) })
    expect(button.getAttribute('aria-busy')).toBe('false')
    view.rerender(<StrictMode><DshLaunchTab onLaunch={launch} /></StrictMode>)
    expect(launch).toHaveBeenCalledOnce()
  })

  it('打开时变色，关闭后恢复且不自动重新打开，点击可重开', async () => {
    const launch = vi.fn().mockResolvedValue({ success: true })
    const view = render(<DshLaunchTab onLaunch={launch} />)
    await act(async () => {})
    const button = view.getByRole('button', { name: 'dshMarket.workbench' })
    fixture.open = true
    view.rerender(<DshLaunchTab onLaunch={launch} />)
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(button.className).toContain('is-open')
    fixture.open = false
    view.rerender(<DshLaunchTab onLaunch={launch} />)
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(button.className).not.toContain('is-open')
    expect(launch).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(button) })
    expect(launch).toHaveBeenCalledOnce()
  })

  it('失败显示原因，重试成功后消除提示', async () => {
    const launch = vi.fn().mockResolvedValueOnce({ success: false, error: 'dsh not installed' }).mockResolvedValueOnce({ success: true })
    const view = render(<DshLaunchTab onLaunch={launch} />)
    fireEvent.click(view.getByRole('button', { name: 'dshMarket.workbench' }))
    await act(async () => {})
    expect(view.getByRole('alert').textContent).toContain('dshLaunch.installHint')
    expect(view.getByRole('alert').querySelector('code')?.textContent).toBe('npm install -g @deepseek-ai/dsh')
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'dshLaunch.retry' })) })
    expect(launch).toHaveBeenCalledTimes(2)
    expect(view.queryByRole('alert')).toBeNull()
  })

  it('启动异常被捕获，提示可以关闭', async () => {
    const launch = vi.fn().mockRejectedValue(new Error('backend unavailable'))
    const view = render(<DshLaunchTab onLaunch={launch} />)
    fireEvent.click(view.getByRole('button', { name: 'dshMarket.workbench' }))
    await act(async () => {})
    expect(view.getByRole('alert').textContent).toContain('backend unavailable')
    expect(view.getByRole('alert').querySelector('code')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'dshLaunch.dismiss' }))
    expect(view.queryByRole('alert')).toBeNull()
  })

  it('复制完整安装命令，成功后显示已复制且不触发启动', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const launch = vi.fn().mockResolvedValue({ success: false, error: 'dsh not installed' })
    const view = render(<DshLaunchTab onLaunch={launch} />)
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'dshMarket.workbench' })) })
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'dsh.copy' })) })
    expect(writeText).toHaveBeenCalledWith('npm install -g @deepseek-ai/dsh')
    expect(view.getByRole('button', { name: 'dsh.copied' })).toBeTruthy()
    expect(launch).toHaveBeenCalledOnce()
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'dshLaunch.retry' })) })
    expect(view.getByRole('button', { name: 'dsh.copy' })).toBeTruthy()
  })

  it('剪贴板写入失败时保留命令并提示手动复制，可重试', async () => {
    const writeText = vi.fn().mockRejectedValueOnce(new Error('clipboard denied')).mockResolvedValueOnce(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const view = render(<DshLaunchTab onLaunch={async () => ({ success: false, error: 'dsh not installed' })} />)
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'dshMarket.workbench' })) })
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'dsh.copy' })) })
    expect(view.getByText('dshLaunch.copyFailed')).toBeTruthy()
    expect(view.getByRole('alert').querySelector('code')?.textContent).toBe(DSH_WEB_INSTALL_COMMAND)
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'dsh.copy' })) })
    expect(view.queryByText('dshLaunch.copyFailed')).toBeNull()
    expect(view.getByRole('button', { name: 'dsh.copied' })).toBeTruthy()
  })

  it('鲸鱼下方状态语随状态切换', async () => {
    const launch = vi.fn().mockResolvedValue({ success: false, error: 'boom' })
    const view = render(<DshLaunchTab onLaunch={launch} />)
    const hint = view.getByRole('status')
    expect(hint.closest('button')).toBeNull()
    expect(view.container.querySelector('.dsh-launch-hint')?.getAttribute('aria-hidden')).toBe('true')
    expect(hint.textContent).toBe('dshLaunch.hint')
    fireEvent.click(view.getByRole('button', { name: 'dshMarket.workbench' }))
    expect(hint.textContent).toBe('dshLaunch.opening')
    await act(async () => {})
    expect(hint.textContent).toBe('dshLaunch.failed')
  })

  it('工作台已开时状态语提示点击切回', () => {
    const launch = vi.fn().mockResolvedValue({ success: true })
    fixture.open = true
    const view = render(<DshLaunchTab onLaunch={launch} />)
    expect(view.getByRole('status').textContent).toBe('dshLaunch.running')
  })

  it('用量接真值：会话口径显示四桶与费用，切到今日走今日口径，不触发启动', async () => {
    const launch = vi.fn()
    const view = render(<DshLaunchTab onLaunch={launch} />)
    await act(async () => {})
    const session = view.getByRole('button', { name: 'dshLaunch.session' })
    const today = view.getByRole('button', { name: 'dshLaunch.today' })
    expect(session.getAttribute('aria-pressed')).toBe('true')
    const usage = view.getByRole('region', { name: 'dshLaunch.usage' })
    // 四个桶各自可见；费用因为有一条路由未定价而带「约」，绝不是精确金额
    expect(Array.from(usage.querySelectorAll('dd')).map(value => value.textContent)).toEqual(['≥¥0.0012', '21.5K'])
    expect(Array.from(usage.querySelectorAll('.dsh-launch-usage-metrics b')).map(value => value.textContent))
      .toEqual(['1K', '20K', '0', '500'])
    expect(usage.textContent).toContain('dshLaunch.usageRequests')
    expect(usage.textContent).toContain('dshLaunch.usagePricingPartial')
    expect(usage.textContent).toContain('dshLaunch.usagePartial')
    fireEvent.click(today)
    expect(today.getAttribute('aria-pressed')).toBe('true')
    expect(Array.from(usage.querySelectorAll('dd')).map(value => value.textContent)).toEqual(['—', '32.8K'])
    expect(usage.textContent).toContain('dshLaunch.usageSessions')
    expect(launch).not.toHaveBeenCalled()
  })

  it('读不到读数时保留破折号并说明原因，未配置价目表不折算成零消费', async () => {
    usageApi.getDshUsage.mockResolvedValue({
      success: true,
      snapshot: snapshotWith({
        session: { ok: false, reason: 'no-logs' },
        today: { ok: false, reason: 'no-logs' },
        cost: { session: null, today: null, week: null, month: null },
        pricing: { configured: false, source: 'none', currency: 'CNY', file: '/tmp/dsh-usage-pricing.json', error: null, rates: 0 },
        partialLogs: 0
      })
    })
    const view = render(<DshLaunchTab onLaunch={vi.fn()} />)
    await act(async () => {})
    const usage = view.getByRole('region', { name: 'dshLaunch.usage' })
    expect(Array.from(usage.querySelectorAll('dd')).map(value => value.textContent)).toEqual(['—', '—'])
    expect(usage.textContent).toContain('dshLaunch.usageNoLogs')
    expect(usage.textContent).toContain('dshLaunch.usagePricingHint')
    expect(usage.querySelector('.dsh-launch-usage-metrics')).toBeNull()
  })

  it('没有价目表文件时说清「用的是内置官方价」，别让人以为费用凭空来的', async () => {
    usageApi.getDshUsage.mockResolvedValue({
      success: true,
      snapshot: snapshotWith({
        pricing: { configured: true, source: 'builtin', currency: 'CNY', file: '/tmp/dsh-usage-pricing.json', error: null, rates: 3 }
      })
    })
    const view = render(<DshLaunchTab onLaunch={vi.fn()} />)
    await act(async () => {})
    const usage = view.getByRole('region', { name: 'dshLaunch.usage' })
    expect(usage.textContent).toContain('dshLaunch.usagePricingBuiltin')
    expect(Array.from(usage.querySelectorAll('dd')).map(value => value.textContent)).toEqual(['≥¥0.0012', '21.5K'])
  })

  it('读数失败时说失败而不是 0；价目表入口可打开并提示已生成模板', async () => {
    usageApi.getDshUsage.mockResolvedValue({ success: false, error: 'logs exploded' })
    usageApi.openDshUsagePricing.mockResolvedValue({ success: true, created: true })
    const view = render(<DshLaunchTab onLaunch={vi.fn()} />)
    await act(async () => {})
    const usage = view.getByRole('region', { name: 'dshLaunch.usage' })
    expect(usage.textContent).toContain('dshLaunch.usageError')
    expect(Array.from(usage.querySelectorAll('dd')).map(value => value.textContent)).toEqual(['—', '—'])
    await act(async () => { fireEvent.click(view.getByRole('button', { name: 'dshLaunch.usagePricing' })) })
    expect(usageApi.openDshUsagePricing).toHaveBeenCalledOnce()
    expect(usage.textContent).toContain('dshLaunch.usagePricingCreated')
  })

  it('7/30天读取各自总数与逐日费用，切换不重新请求或启动工作台', async () => {
    const launch = vi.fn()
    const view = render(<DshLaunchTab onLaunch={launch} />)
    await act(async () => {})
    const usage = view.getByRole('region', { name: 'dshLaunch.usage' })
    fireEvent.click(view.getByRole('button', { name: 'dshLaunch.week' }))
    expect(Array.from(usage.querySelectorAll('dd')).map(x => x.textContent)).toEqual(['¥2.10', '215K'])
    expect(usage.textContent).toContain('2026-10-16 – 2026-10-22')
    expect(usage.querySelectorAll('.dsh-usage-day')).toHaveLength(7)
    fireEvent.click(view.getByRole('button', { name: 'dshLaunch.month' }))
    expect(Array.from(usage.querySelectorAll('dd')).map(x => x.textContent)).toEqual(['¥43.50', '215K'])
    expect(usage.textContent).toContain('2026-09-23 – 2026-10-22')
    expect(usage.querySelectorAll('.dsh-usage-day')).toHaveLength(30)
    expect(usageApi.getDshUsage).toHaveBeenCalledOnce()
    expect(launch).not.toHaveBeenCalled()
  })

  it('逐日费用支持键盘切日，未知费用保留破折号', async () => {
    const period = periodWith(7)
    period.daily[0].cost = null
    usageApi.getDshUsage.mockResolvedValue({ success: true, snapshot: snapshotWith({ week: { ok: true, data: period } }) })
    const view = render(<DshLaunchTab onLaunch={vi.fn()} />)
    await act(async () => {})
    fireEvent.click(view.getByRole('button', { name: 'dshLaunch.week' }))
    const days = view.container.querySelectorAll<HTMLButtonElement>('.dsh-usage-day')
    expect(days[6].tabIndex).toBe(0)
    fireEvent.keyDown(days[6], { key: 'Home' })
    expect(document.activeElement).toBe(days[0])
    expect(days[0].getAttribute('aria-pressed')).toBe('true')
    expect(view.container.querySelector('.dsh-usage-trend-reading')?.textContent).toContain('—')
    fireEvent.keyDown(days[0], { key: 'ArrowRight' })
    expect(document.activeElement).toBe(days[1])
    expect(view.container.querySelector('.dsh-usage-trend-reading')?.textContent).toContain('¥0.10')
  })

  it('峰谷四桶来自同一范围，部分未定价时保留可见告警', async () => {
    const snapshot = snapshotWith({ partialLogs: 0 })
    if (!snapshot.session.ok) throw new Error('missing fixture')
    snapshot.session.data.usage.offPeakTokens = buckets(200, 10000, 0, 200)
    snapshot.pricing.source = 'builtin'
    usageApi.getDshUsage.mockResolvedValue({ success: true, snapshot })
    const view = render(<DshLaunchTab onLaunch={vi.fn()} />)
    await act(async () => {})
    const table = view.container.querySelector('.dsh-usage-tariffs table')!
    expect(Array.from(table.querySelectorAll('tbody tr:first-child td')).map(x => x.textContent)).toEqual(['800', '200'])
    expect(Array.from(table.querySelectorAll('tbody tr:nth-child(2) td')).map(x => x.textContent)).toEqual(['10K', '10K'])
    expect(Array.from(table.querySelectorAll('tbody tr:last-child td')).map(x => x.textContent)).toEqual(['¥0.0010', '¥0.0002'])
    expect(view.getByRole('note').textContent).toContain('dshLaunch.usagePricingPartial')
    fireEvent.click(view.getByRole('button', { name: 'dshLaunch.week' }))
    expect(Array.from(table.querySelectorAll('tbody tr:last-child td')).map(x => x.textContent)).toEqual(['¥1.50', '¥0.60'])
    fireEvent.click(view.getByRole('button', { name: 'dshLaunch.today' }))
    expect(Array.from(table.querySelectorAll('tbody tr:last-child td')).map(x => x.textContent)).toEqual(['—', '—'])
  })

})
