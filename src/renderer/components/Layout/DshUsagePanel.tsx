import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  dshCacheHitRate, emptyDshTokenBuckets, formatDshCost, formatDshPercent, formatDshTokens, localDayKey,
  subtractDshTokenBuckets, totalDshTokens,
  type DshCostEstimate, type DshPeriodUsage, type DshTariffCost, type DshUsageDay, type DshUsageFailure,
  type DshUsageScope, type DshUsageSnapshot, type DshUsageTotals
} from '@shared/dsh-usage'

const REFRESH_MS = 15_000
const SCOPES: DshUsageScope[] = ['session', 'today', 'week', 'month']
const FAILURE_KEYS: Record<DshUsageFailure, string> = {
  'no-logs': 'dshLaunch.usageNoLogs', unsupported: 'dshLaunch.usageUnsupported', unreadable: 'dshLaunch.usageUnreadable'
}

/** 日期直接读取日键，避免 YYYY-MM-DD 经 UTC 解析后在本地偏移一天。 */
function shortDay(day: string): string { return day.slice(5).replace('-', '/') }
function exactTokens(count: number, locale: string): string { return count.toLocaleString(locale) }
function costLabel(cost: DshCostEstimate | null): string {
  return cost ? `${cost.complete ? '' : '≥'}${formatDshCost(cost.amount, cost.currency)}` : '—'
}
function exactCost(cost: DshCostEstimate | null, locale: string): string | undefined {
  return cost ? `${cost.currency} ${cost.amount.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 8 })}` : undefined
}

const BUCKETS = ['uncachedInput', 'cacheRead', 'cacheWrite', 'output'] as const
const BUCKET_LABELS = ['usageInput', 'usageCacheRead', 'usageCacheWrite', 'usageOutput'] as const
function TariffDetails({ totals, costs, locale }: { totals: DshUsageTotals; costs?: DshTariffCost; locale: string }): JSX.Element {
  const { t } = useTranslation()
  const offPeak = totals.offPeakTokens ?? emptyDshTokenBuckets()
  const peak = subtractDshTokenBuckets(totals.tokens, offPeak)
  return <details className="dsh-usage-details dsh-usage-tariffs">
    <summary><span>{t('dshLaunch.usageTariffDetails')}</span><span className="dsh-usage-source">{t('dshLaunch.usageBeijingTime')}</span></summary>
    <div className="dsh-usage-detail-body">
      <table>
        <caption className="sr-only">{t('dshLaunch.usageTariffDetails')}</caption>
        <thead><tr><th scope="col">Token</th><th scope="col">{t('dshLaunch.usagePeak')}</th><th scope="col">{t('dshLaunch.usageOffPeakShort')}</th></tr></thead>
        <tbody>
          {BUCKETS.map((bucket, index) => <tr key={bucket}><th scope="row">{t(`dshLaunch.${BUCKET_LABELS[index]}`)}</th>
            <td title={exactTokens(peak[bucket], locale)}>{formatDshTokens(peak[bucket])}</td>
            <td title={exactTokens(offPeak[bucket], locale)}>{formatDshTokens(offPeak[bucket])}</td>
          </tr>)}
          <tr className="dsh-usage-tariff-total"><th scope="row">{t('dshLaunch.usageTokens')}</th>
            <td title={exactTokens(totalDshTokens(peak), locale)}>{formatDshTokens(totalDshTokens(peak))}</td>
            <td title={exactTokens(totalDshTokens(offPeak), locale)}>{formatDshTokens(totalDshTokens(offPeak))}</td></tr>
          <tr className="dsh-usage-tariff-cost"><th scope="row">{t('dshLaunch.usageEstimatedCost')}</th>
            <td title={exactCost(costs?.peak ?? null, locale)}>{costLabel(costs?.peak ?? null)}</td>
            <td title={exactCost(costs?.offPeak ?? null, locale)}>{costLabel(costs?.offPeak ?? null)}</td></tr>
        </tbody>
      </table>
      <p className="dsh-launch-usage-note">{t('dshLaunch.usagePeakRule')}</p>
      <p className="dsh-launch-usage-note">{t('dshLaunch.usageOffPeakRule')}</p>
    </div>
  </details>
}

/** 原生按钮 + 单个 Tab 停靠点；左右键逐日查看，鼠标和触屏也可直接选日。 */
function DailyCosts({ daily, locale }: { daily: DshUsageDay[]; locale: string }): JSX.Element | null {
  const { t } = useTranslation()
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  if (daily.length === 0) return null
  const selected = daily.find(day => day.day === selectedDay) ?? daily[daily.length - 1]
  const maximum = Math.max(0, ...daily.map(day => day.cost?.amount ?? 0))
  const selectWithKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index
    if (event.key === 'ArrowLeft') next = Math.max(0, index - 1)
    else if (event.key === 'ArrowRight') next = Math.min(daily.length - 1, index + 1)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = daily.length - 1
    else return
    event.preventDefault()
    setSelectedDay(daily[next].day)
    buttons.current[next]?.focus()
  }
  return <div className="dsh-usage-trend">
    <div className="dsh-usage-trend-heading">
      <span>{t('dshLaunch.usageDailyCost')}</span>
      <span className="dsh-usage-trend-reading" aria-live="polite" aria-atomic="true">
        {shortDay(selected.day)} <strong>{costLabel(selected.cost)}</strong>
      </span>
    </div>
    <div className="dsh-usage-bars" role="group" aria-label={t('dshLaunch.usageDailyCost')}>
      {daily.map((day, index) => {
        const label = `${day.day} · ${costLabel(day.cost)} · ${exactTokens(day.totalTokens, locale)} tokens`
        const height = day.cost && maximum > 0 ? day.cost.amount / maximum * 100 : 0
        return <button key={day.day} type="button" ref={element => { buttons.current[index] = element }}
          className={`dsh-usage-day${selected.day === day.day ? ' is-selected' : ''}${day.cost === null ? ' is-unknown' : ''}`}
          tabIndex={selected.day === day.day ? 0 : -1} aria-pressed={selected.day === day.day}
          aria-label={label} title={label} onClick={() => setSelectedDay(day.day)}
          onFocus={() => setSelectedDay(day.day)} onKeyDown={event => selectWithKey(event, index)}>
          <span style={{ height: `${height}%` }} />
        </button>
      })}
    </div>
    <div className="dsh-usage-chart-axis"><span>{shortDay(daily[0].day)}</span><span>{shortDay(daily[daily.length - 1].day)}</span></div>
  </div>
}

/** 用量区独立于启动按钮；轮询不会启动工作台或调用模型。 */
export function DshUsagePanel(): JSX.Element {
  const { t, i18n } = useTranslation()
  const locale = i18n?.resolvedLanguage ?? i18n?.language ?? 'zh'
  const [scope, setScope] = useState<DshUsageScope>('session')
  const [snapshot, setSnapshot] = useState<DshUsageSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [settled, setSettled] = useState(false)
  const [pricingNote, setPricingNote] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)
  const alive = useRef(false)
  const openingRef = useRef(false)

  useEffect(() => {
    alive.current = true
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      try {
        const result = await window.electronAPI.getDshUsage()
        if (cancelled) return
        if (result.success) { setSnapshot(result.snapshot); setError(null) }
        else setError(result.error)
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (!cancelled) { setSettled(true); timer = setTimeout(() => { void load() }, REFRESH_MS) }
      }
    }
    void load()
    return () => { alive.current = false; cancelled = true; if (timer) clearTimeout(timer) }
  }, [])

  const openPricing = async () => {
    if (openingRef.current) return
    openingRef.current = true
    setOpening(true)
    try {
      const result = await window.electronAPI.openDshUsagePricing()
      if (alive.current) setPricingNote(result.success
        ? t(result.created ? 'dshLaunch.usagePricingCreated' : 'dshLaunch.usagePricingOpened')
        : result.error || t('dshLaunch.usagePricingFailed'))
    } catch (cause) {
      if (alive.current) setPricingNote(cause instanceof Error ? cause.message : t('dshLaunch.usagePricingFailed'))
    } finally {
      openingRef.current = false
      if (alive.current) setOpening(false)
    }
  }

  const scoped = snapshot?.[scope]
  const totals: DshUsageTotals | null = scoped?.ok ? ('usage' in scoped.data ? scoped.data.usage : scoped.data) : null
  const period: DshPeriodUsage | null = scoped?.ok && 'daily' in scoped.data ? scoped.data : null
  const session = scoped?.ok && 'session' in scoped.data ? scoped.data.session : null
  const sessions = scoped?.ok && 'sessions' in scoped.data ? scoped.data.sessions : null
  const cost = snapshot?.cost[scope] ?? null
  const tariffCost = snapshot?.tariffCost[scope]
  const today = snapshot ? localDayKey(snapshot.generatedAt) : null
  const context = session ? t('dshLaunch.usageSessionLabel', { title: session.title ?? session.id })
    : period ? `${period.startDay} – ${period.endDay}`
      : scope === 'today' && today ? today : t(`dshLaunch.${scope}`)
  const warnings: string[] = []
  if (error) warnings.push(t('dshLaunch.usageError', { message: error }))
  if (snapshot?.pricing.error) warnings.push(t('dshLaunch.usagePricingError', { message: snapshot.pricing.error }))
  if (cost && !cost.complete) warnings.push(t('dshLaunch.usagePricingPartial', { routes: cost.unpricedRoutes.join(' / ') }))
  if (snapshot && snapshot.partialLogs > 0) warnings.push(t('dshLaunch.usagePartial', { count: snapshot.partialLogs }))
  if (snapshot?.pricing.calendarWarningYears?.length) warnings.push(t('dshLaunch.usageCalendarWarning', { years: snapshot.pricing.calendarWarningYears.join(', ') }))
  if (totals && !cost && totals.totalTokens > 0) warnings.push(t('dshLaunch.usageNoRates'))
  const unavailable = !totals ? (error ? null : !settled ? t('dshLaunch.usageLoading')
    : scoped && !scoped.ok ? t(FAILURE_KEYS[scoped.reason]) : t('dshLaunch.usageUnreadable')) : null
  const source = snapshot?.pricing.source === 'builtin' ? 'dshLaunch.usageSourceOfficial'
    : snapshot?.pricing.source === 'file' ? 'dshLaunch.usageSourceCustom' : 'dshLaunch.usageNoRates'

  return <section className="dsh-launch-usage" lang={locale} aria-label={t('dshLaunch.usage')} aria-busy={!settled}>
    <div className="dsh-launch-usage-head">
      <h3>{t('dshLaunch.usageTitle')}</h3>
      <button type="button" className="dsh-launch-usage-pricing" onClick={() => void openPricing()} disabled={opening}>
        {t('dshLaunch.usagePricing')}
      </button>
    </div>
    <div className="dsh-launch-usage-scopes" role="group" aria-label={t('dshLaunch.usageScope')}>
      {SCOPES.map(value => <button key={value} type="button" aria-pressed={value === scope}
        aria-label={t(`dshLaunch.${value}`)} onClick={() => setScope(value)}>
        {t(value === 'session' ? 'dshLaunch.usageSessionShort' : `dshLaunch.${value}`)}
      </button>)}
    </div>
    <p className="dsh-usage-context" title={context}>{context}</p>
    <dl className="dsh-launch-usage-values">
      <div className="dsh-usage-cost"><dt>{t('dshLaunch.usageEstimatedCost')}</dt><dd title={totals ? exactCost(cost, locale) : undefined}>{totals ? costLabel(cost) : '—'}</dd></div>
      <div><dt>{t('dshLaunch.usageTokens')}</dt><dd title={totals ? exactTokens(totals.totalTokens, locale) : undefined}>{totals ? formatDshTokens(totals.totalTokens) : '—'}</dd></div>
    </dl>
    {unavailable && <p className="dsh-launch-usage-note dsh-usage-empty">{unavailable}</p>}
    {totals && <>
      <div className="dsh-usage-cache"><span>{t('dshLaunch.usageCacheHit')}</span><strong>{formatDshPercent(dshCacheHitRate(totals.tokens))}</strong></div>
      <ul className="dsh-launch-usage-metrics">
        {BUCKETS.map((bucket, index) => <li key={bucket}>
          <span>{t(`dshLaunch.${BUCKET_LABELS[index]}`)}</span>
          <b title={exactTokens(totals.tokens[bucket], locale)}>{formatDshTokens(totals.tokens[bucket])}</b>
        </li>)}
      </ul>
      <p className="dsh-usage-activity">
        <span>{t('dshLaunch.usageRequests', { count: totals.requests })}</span>
        <span>{t('dshLaunch.usageTurns', { count: totals.turns })}</span>
        {sessions !== null && <span>{t('dshLaunch.usageSessions', { count: sessions })}</span>}
      </p>
      {period && <DailyCosts key={scope} daily={period.daily} locale={locale} />}
      <TariffDetails totals={totals} costs={tariffCost} locale={locale} />
    </>}
    {warnings.length > 0 && <div className="dsh-usage-warnings" role="note">{warnings.map(note => <p key={note}>{note}</p>)}</div>}
    {pricingNote && <p className="dsh-launch-usage-note" role="status">{pricingNote}</p>}
    {snapshot && <details className="dsh-usage-details">
      <summary><span>{t('dshLaunch.usageDetails')}</span><span className="dsh-usage-source">{t(source)}</span></summary>
      <div className="dsh-usage-detail-body">
        <p className="dsh-launch-usage-note">{t(snapshot.pricing.source === 'builtin' ? 'dshLaunch.usagePricingBuiltin' : 'dshLaunch.usageEstimateHint')}</p>
        {period && <p className="dsh-launch-usage-note">{t('dshLaunch.usagePeriodHint')}</p>}
        {session && !session.withinTarget && <p className="dsh-launch-usage-note">{t('dshLaunch.usageSessionCwd', { cwd: session.cwd })}</p>}
        {totals?.routes.map(route => <div className="dsh-usage-route" key={route.route}>
          <span title={route.route}>{route.model}<small>{route.provider}</small></span><b>{formatDshTokens(route.totalTokens)}</b>
        </div>)}
        {!snapshot.pricing.configured && <p className="dsh-launch-usage-note">{t('dshLaunch.usagePricingHint', { file: snapshot.pricing.file })}</p>}
      </div>
    </details>}
  </section>
}
