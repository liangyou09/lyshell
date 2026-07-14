import { useEffect, useState, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import cn from 'classnames'

interface McpAuditRecord {
  id: string
  timestamp: string
  operation: string
  capability: string
  sessionId?: string
  sessionName?: string
  sessionType?: string
  allowed: boolean
  reason?: string
  summary?: string
  durationMs?: number
  tokenSource: string
  originSessionId?: string
}

interface McpAuditResult {
  records: McpAuditRecord[]
  total: number
}

interface McpAuditPanelProps {
  onClose: () => void
}

type AllowedFilter = 'all' | 'allowed' | 'denied'

/** 每页条数：审计日志多为浏览/回溯，50 条/页在 640px 面板里滚动适中 */
const PAGE_SIZE = 50

export function McpAuditPanel({ onClose }: McpAuditPanelProps): JSX.Element {
  const { t } = useTranslation()
  const [records, setRecords] = useState<McpAuditRecord[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  // 下拉选项：打开面板/刷新时从后端拉取去重后的操作名与会话
  const [operations, setOperations] = useState<string[]>([])
  const [sessions, setSessions] = useState<{ sessionId: string; sessionName?: string; sessionType?: string }[]>([])
  const [operation, setOperation] = useState('')
  const [allowed, setAllowed] = useState<AllowedFilter>('all')
  const [session, setSession] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [copied, setCopied] = useState(false)
  // 当前页(1-indexed)。过滤条件变化时回到第 1 页；翻页时由 load 直接传入目标页。
  const [page, setPage] = useState(1)
  // summary 鼠标 tip：仅当单元格内容被截断时显示，固定定位避免被 overflow-auto 裁切
  const [summaryTip, setSummaryTip] = useState<{ text: string; x: number; y: number } | null>(null)

  // 过滤值镜像到 ref，让 load 回调稳定（不依赖各过滤 state），
  // 避免 effect 每次按键都重建 load 并触发 IPC 查询。查询由挂载 / 回车 / 刷新按钮 / select/date 变更显式触发。
  const operationRef = useRef('')
  const allowedRef = useRef<AllowedFilter>('all')
  const sessionRef = useRef('')
  const fromRef = useRef('')
  const toRef = useRef('')

  // targetPage 显式传入：翻页=目标页，过滤变化=1，刷新=当前页。
  // load 自身不依赖 page state（空 deps 稳定），page 由调用方决定并在成功后同步进 state。
  const load = useCallback(async (targetPage: number) => {
    setLoading(true)
    try {
      const filter: Record<string, unknown> = {
        limit: PAGE_SIZE,
        offset: (targetPage - 1) * PAGE_SIZE
      }
      const op = operationRef.current.trim()
      if (op) filter.operation = op
      if (allowedRef.current === 'allowed') filter.allowed = true
      if (allowedRef.current === 'denied') filter.allowed = false
      const sess = sessionRef.current.trim()
      // session 下拉选的是 sessionId，走精确匹配（repo 的 sessionId 过滤）
      if (sess) filter.sessionId = sess
      // 日期框是 yyyy-mm-dd，补成当天起止 ISO 做 >= / <= 比较
      if (fromRef.current) filter.since = `${fromRef.current}T00:00:00.000`
      if (toRef.current) filter.until = `${toRef.current}T23:59:59.999`
      const result = await window.electronAPI?.getMcpAudit(filter) as McpAuditResult | undefined
      if (result) {
        setRecords(result.records)
        setTotal(result.total)
        setPage(targetPage)
      }
    } catch (err) {
      console.warn('Failed to load MCP audit:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  // 拉取下拉选项（去重操作名/会话）。打开、刷新、清空后调用。
  const loadFacets = useCallback(async () => {
    try {
      const f = await window.electronAPI?.getMcpAuditFacets() as
        | { operations: string[]; sessions: { sessionId: string; sessionName?: string; sessionType?: string }[] }
        | undefined
      if (f) {
        setOperations(f.operations)
        setSessions(f.sessions)
      }
    } catch (err) {
      console.warn('Failed to load MCP audit facets:', err)
    }
  }, [])

  // 每次挂载(面板打开)回到第 1 页并刷新下拉选项
  useEffect(() => {
    load(1); loadFacets()
  }, [load, loadFacets])

  // ESC 关闭面板。MainWindow 在 MCP 面板打开时会停用设置面板的 ESC 监听，
  // 因此这里独占 ESC，不会一次按下同时关掉两层。
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const handleClear = async () => {
    if (!window.confirm(t('mcpAudit.confirmClear'))) return
    try {
      await window.electronAPI?.clearMcpAudit()
      // 清空后下拉选项也归零，并把所有过滤复位到"全部"
      setOperation(''); operationRef.current = ''
      setSession(''); sessionRef.current = ''
      setAllowed('all'); allowedRef.current = 'all'
      setFromDate(''); fromRef.current = ''
      setToDate(''); toRef.current = ''
      await load(1)
      loadFacets()
    } catch (err) {
      console.warn('Failed to clear MCP audit:', err)
    }
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(records, null, 2))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.warn('Failed to copy audit:', err)
    }
  }

  const fmtTime = (iso: string): string => {
    try {
      const d = new Date(iso)
      return d.toLocaleTimeString(undefined, { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0')
    } catch {
      return iso
    }
  }
  const fmtDate = (iso: string): string => {
    try {
      return new Date(iso).toLocaleDateString(undefined, { month: '2-digit', day: '2-digit' })
    } catch {
      return ''
    }
  }

  // 翻页：到达边界时夹紧，避免越界请求空页
  const gotoPage = (p: number) => load(Math.min(totalPages, Math.max(1, p)))
  const rangeStart = total > 0 ? (page - 1) * PAGE_SIZE + 1 : 0
  const rangeEnd = Math.min(page * PAGE_SIZE, total)

  // summary tip：仅当单元格内容被截断(scrollWidth > clientWidth)时弹出，
  // 固定定位 + 视口夹紧，避免被记录列表的 overflow-auto 裁切或溢出屏幕底部
  const handleSummaryEnter = (e: React.MouseEvent<HTMLTableCellElement>, summary?: string) => {
    const el = e.currentTarget
    if (summary && el.scrollWidth > el.clientWidth) {
      const rect = el.getBoundingClientRect()
      setSummaryTip({
        text: summary,
        x: rect.left,
        y: Math.min(rect.bottom + 4, window.innerHeight - 140)
      })
    }
  }

  return (
    <div className="flex h-full w-full">
      <div className="flex-1 flex flex-col bg-[var(--bg-rack)] overflow-hidden">
        {/* 过滤栏 -- flex-wrap：窄屏自动换行，避免输入挤一起 */}
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-[var(--rule)] text-[11px] font-mono">
          <select
            value={operation}
            onChange={(e) => { setOperation(e.target.value); operationRef.current = e.target.value; load(1) }}
            className="px-2 py-1 bg-[var(--bg-slot)] border border-[var(--rule)] rounded-[2px] text-[var(--text-rack)] w-[180px] focus:border-[var(--amber)] outline-none"
          >
            <option value="">{t('mcpAudit.filterAll')}</option>
            {operations.map((op) => <option key={op} value={op}>{op}</option>)}
          </select>
          <select
            value={session}
            onChange={(e) => { setSession(e.target.value); sessionRef.current = e.target.value; load(1) }}
            className="px-2 py-1 bg-[var(--bg-slot)] border border-[var(--rule)] rounded-[2px] text-[var(--text-rack)] w-[150px] focus:border-[var(--amber)] outline-none"
          >
            <option value="">{t('mcpAudit.filterAll')}</option>
            {sessions.map((s) => (
              <option key={s.sessionId} value={s.sessionId}>
                {s.sessionName || s.sessionId.slice(0, 8)}
              </option>
            ))}
          </select>
          <select
            value={allowed}
            onChange={(e) => { const v = e.target.value as AllowedFilter; setAllowed(v); allowedRef.current = v; load(1) }}
            className="px-2 py-1 bg-[var(--bg-slot)] border border-[var(--rule)] rounded-[2px] text-[var(--text-rack)] outline-none focus:border-[var(--amber)]"
          >
            <option value="all">{t('mcpAudit.filterAll')}</option>
            <option value="allowed">{t('mcpAudit.filterAllowed')}</option>
            <option value="denied">{t('mcpAudit.filterDenied')}</option>
          </select>
          <input
            type="text"
            value={fromDate}
            onChange={(e) => {
              const v = e.target.value
              setFromDate(v)
              // 只在完整 yyyy-mm-dd 或清空时写入 ref 并查询；半截输入只更新显示
              if (v === '' || /^\d{4}-\d{2}-\d{2}$/.test(v)) {
                fromRef.current = v
                load(1)
              }
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') load(1) }}
            placeholder="YYYY-MM-DD"
            maxLength={10}
            title={t('mcpAudit.filterFrom')}
            className="px-2 py-1 bg-[var(--bg-slot)] border border-[var(--rule)] rounded-[2px] text-[var(--text-rack)] w-[104px] focus:border-[var(--amber)] outline-none"
          />
          <span className="text-[var(--text-rack-faint)]">–</span>
          <input
            type="text"
            value={toDate}
            onChange={(e) => {
              const v = e.target.value
              setToDate(v)
              if (v === '' || /^\d{4}-\d{2}-\d{2}$/.test(v)) {
                toRef.current = v
                load(1)
              }
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') load(1) }}
            placeholder="YYYY-MM-DD"
            maxLength={10}
            title={t('mcpAudit.filterTo')}
            className="px-2 py-1 bg-[var(--bg-slot)] border border-[var(--rule)] rounded-[2px] text-[var(--text-rack)] w-[104px] focus:border-[var(--amber)] outline-none"
          />
          <button
            onClick={() => { load(page); loadFacets() }}
            className="px-2 py-1 bg-[var(--bg-slot)] border border-[var(--rule)] rounded-[2px] text-[var(--text-rack)] hover:border-[var(--amber)] hover:text-[var(--amber)]"
          >
            {loading ? '…' : t('mcpAudit.refresh')}
          </button>
          <div className="flex-1" />
          <button
            onClick={handleCopy}
            className={cn(
              'px-2 py-1 rounded-[2px] border transition-colors',
              copied
                ? 'bg-[var(--amber)] border-[var(--amber)] text-[var(--bg-rack)]'
                : 'bg-[var(--bg-slot)] border-[var(--rule)] text-[var(--text-rack)] hover:border-[var(--amber)]'
            )}
          >
            {copied ? t('mcpAudit.copied') : t('mcpAudit.copy')}
          </button>
          <button
            onClick={handleClear}
            className="px-2 py-1 bg-[var(--bg-slot)] border border-[var(--rule)] rounded-[2px] text-[var(--text-rack)] hover:border-[var(--danger, #e06c75)] hover:text-[var(--danger, #e06c75)]"
          >
            {t('mcpAudit.clear')}
          </button>
        </div>

        {/* 记录列表 -- 滚动时清掉 summary tip，避免定位错乱 */}
        <div className="flex-1 overflow-auto" onScroll={() => setSummaryTip(null)}>
          {records.length === 0 ? (
            <div className="p-6 text-[12px] font-mono text-[var(--text-rack-mute)] text-center">
              {t('mcpAudit.empty')}
            </div>
          ) : (
            <table className="w-full text-[11px] font-mono">
              <thead className="sticky top-0 z-10 bg-[var(--bg-elev)] border-b border-[var(--rule)]">
                <tr className="text-[11px] tracking-[.04em] text-[var(--text-rack-data)]">
                  <th className="text-left px-2 py-1.5 font-semibold">{t('mcpAudit.colTime')}</th>
                  <th className="text-left px-2 py-1.5 font-semibold">{t('mcpAudit.colOperation')}</th>
                  <th className="text-left px-2 py-1.5 font-semibold">{t('mcpAudit.colCapability')}</th>
                  <th className="text-left px-2 py-1.5 font-semibold">{t('mcpAudit.colSession')}</th>
                  <th className="text-left px-2 py-1.5 font-semibold">{t('mcpAudit.colResult')}</th>
                  <th className="text-left px-2 py-1.5 font-semibold">{t('mcpAudit.colSource')}</th>
                  <th className="text-left px-2 py-1.5 font-semibold">{t('mcpAudit.colSummary')}</th>
                </tr>
              </thead>
              <tbody>
                {records.map((r) => (
                  <tr key={r.id} className="border-b border-[var(--rule-soft,var(--rule))] hover:bg-[var(--bg-elev)]">
                    <td className="px-2 py-1.5 text-[var(--text-rack)] whitespace-nowrap" title={r.timestamp}>
                      <span className="text-[var(--text-rack-data)]">{fmtDate(r.timestamp)}</span>{' '}{fmtTime(r.timestamp)}
                    </td>
                    <td className="px-2 py-1.5 text-[var(--text-rack)] whitespace-nowrap font-semibold">{r.operation}</td>
                    <td className="px-2 py-1.5 text-[var(--text-rack-data)] whitespace-nowrap">{r.capability}</td>
                    <td className="px-2 py-1.5 text-[var(--text-rack-data)] whitespace-nowrap" title={r.sessionId}>
                      {r.sessionName || r.sessionId?.slice(0, 8) || '–'}
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      <span
                        className={cn(
                          'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[2px] text-[10px] font-semibold',
                          r.allowed
                            ? 'bg-[color-mix(in_srgb,var(--amber)_18%,transparent)] text-[var(--amber)]'
                            : 'bg-[color-mix(in_srgb,var(--danger,#e06c75)_18%,transparent)] text-[var(--danger,#e06c75)]'
                        )}
                      >
                        {r.allowed ? '✓' : '✗'}
                        {r.reason ? <span className="opacity-70" title={r.reason}>ⓘ</span> : null}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-[var(--text-rack-mute)] whitespace-nowrap">
                      {r.tokenSource || '–'}
                      {r.originSessionId ? <span className="text-[var(--text-rack-faint)]" title={r.originSessionId}>·{r.originSessionId.slice(0, 6)}</span> : null}
                    </td>
                    <td
                      className="px-2 py-1.5 text-[var(--text-rack-data)] truncate max-w-[280px] cursor-help"
                      onMouseEnter={(e) => handleSummaryEnter(e, r.summary)}
                      onMouseLeave={() => setSummaryTip(null)}
                    >
                      {r.summary || '–'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* 分页栏 */}
        <div className="flex items-center justify-between px-3 py-2 border-t border-[var(--rule)] text-[11px] font-mono text-[var(--text-rack-mute)]">
          <span className="tabular-nums">
            {total > 0 ? `${rangeStart}–${rangeEnd} / ${total}` : '– / –'}
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => gotoPage(page - 1)}
              disabled={page <= 1}
              className={cn(
                'w-[24px] h-[20px] flex items-center justify-center rounded-[2px] border transition-colors',
                page <= 1
                  ? 'border-[var(--rule)] text-[var(--text-rack-faint)] cursor-not-allowed'
                  : 'border-[var(--rule)] text-[var(--text-rack)] hover:border-[var(--amber)] hover:text-[var(--amber)]'
              )}
            >‹</button>
            <span className="tabular-nums text-[var(--text-rack-data)] min-w-[48px] text-center">{page} / {totalPages}</span>
            <button
              type="button"
              onClick={() => gotoPage(page + 1)}
              disabled={page >= totalPages}
              className={cn(
                'w-[24px] h-[20px] flex items-center justify-center rounded-[2px] border transition-colors',
                page >= totalPages
                  ? 'border-[var(--rule)] text-[var(--text-rack-faint)] cursor-not-allowed'
                  : 'border-[var(--rule)] text-[var(--text-rack)] hover:border-[var(--amber)] hover:text-[var(--amber)]'
              )}
            >›</button>
          </div>
        </div>
      </div>

      {/* summary 鼠标 tip -- 渲染在面板外层、固定定位，不被记录列表的 overflow-auto 裁切 */}
      {summaryTip && (
        <div
          className="fixed z-[300] px-2 py-1.5 rounded-[3px] bg-[var(--bg-elev)] border border-[var(--rule)] text-[11px] font-mono text-[var(--text-rack)] shadow-xl pointer-events-none whitespace-normal break-words"
          style={{ left: summaryTip.x, top: summaryTip.y, maxWidth: Math.min(400, window.innerWidth - summaryTip.x - 8) }}
        >
          {summaryTip.text}
        </div>
      )}
    </div>
  )
}
