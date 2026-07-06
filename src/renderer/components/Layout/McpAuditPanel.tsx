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
  open: boolean
  onClose: () => void
}

type AllowedFilter = 'all' | 'allowed' | 'denied'

export function McpAuditPanel({ open, onClose }: McpAuditPanelProps): JSX.Element | null {
  const { t } = useTranslation()
  const [records, setRecords] = useState<McpAuditRecord[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [operation, setOperation] = useState('')
  const [allowed, setAllowed] = useState<AllowedFilter>('all')
  const [copied, setCopied] = useState(false)

  // 过滤值镜像到 ref，让 load 回调稳定（不依赖 operation/allowed），
  // 避免 effect 每次按键都重建 load 并触发 IPC 查询。查询由 open / 回车 / 刷新按钮 / select 变更显式触发。
  const operationRef = useRef('')
  const allowedRef = useRef<AllowedFilter>('all')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const filter: Record<string, unknown> = { limit: 500 }
      const op = operationRef.current.trim()
      if (op) filter.operation = op
      if (allowedRef.current === 'allowed') filter.allowed = true
      if (allowedRef.current === 'denied') filter.allowed = false
      const result = await window.electronAPI?.getMcpAudit(filter) as McpAuditResult | undefined
      if (result) {
        setRecords(result.records)
        setTotal(result.total)
      }
    } catch (err) {
      console.warn('Failed to load MCP audit:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) load()
  }, [open, load])

  if (!open) return null

  const handleClear = async () => {
    if (!window.confirm(t('mcpAudit.confirmClear'))) return
    try {
      await window.electronAPI?.clearMcpAudit()
      await load()
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

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-[min(900px,92vw)] h-[min(640px,88vh)] bg-[var(--bg-rack)] border border-[var(--rule)] rounded-[4px] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--rule)]">
          <span className="text-[12px] font-mono text-[var(--text-rack)]">
            {t('mcpAudit.title')}
            <span className="text-[10px] text-[var(--text-rack-mute)] ml-2">
              {t('mcpAudit.total', { total })}
            </span>
          </span>
          <button
            onClick={onClose}
            className="text-[var(--text-rack-mute)] hover:text-[var(--amber)] text-[14px] px-2"
            title={t('mcpAudit.close')}
          >
            ✕
          </button>
        </div>

        {/* 过滤栏 */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--rule)] text-[11px] font-mono">
          <input
            type="text"
            value={operation}
            onChange={(e) => { setOperation(e.target.value); operationRef.current = e.target.value }}
            onKeyDown={(e) => { if (e.key === 'Enter') load() }}
            placeholder={t('mcpAudit.filterOperation')}
            className="px-2 py-1 bg-[var(--bg-slot)] border border-[var(--rule)] rounded-[2px] text-[var(--text-rack)] w-[180px] focus:border-[var(--amber)] outline-none"
          />
          <select
            value={allowed}
            onChange={(e) => { const v = e.target.value as AllowedFilter; setAllowed(v); allowedRef.current = v; load() }}
            className="px-2 py-1 bg-[var(--bg-slot)] border border-[var(--rule)] rounded-[2px] text-[var(--text-rack)] outline-none focus:border-[var(--amber)]"
          >
            <option value="all">{t('mcpAudit.filterAll')}</option>
            <option value="allowed">{t('mcpAudit.filterAllowed')}</option>
            <option value="denied">{t('mcpAudit.filterDenied')}</option>
          </select>
          <button
            onClick={load}
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

        {/* 记录列表 */}
        <div className="flex-1 overflow-auto">
          {records.length === 0 ? (
            <div className="p-4 text-[11px] font-mono text-[var(--text-rack-mute)] text-center">
              {t('mcpAudit.empty')}
            </div>
          ) : (
            <table className="w-full text-[10px] font-mono">
              <thead className="sticky top-0 bg-[var(--bg-elev)] text-[var(--text-rack-mute)] border-b border-[var(--rule)]">
                <tr>
                  <th className="text-left px-2 py-1 font-normal">{t('mcpAudit.colTime')}</th>
                  <th className="text-left px-2 py-1 font-normal">{t('mcpAudit.colOperation')}</th>
                  <th className="text-left px-2 py-1 font-normal">{t('mcpAudit.colCapability')}</th>
                  <th className="text-left px-2 py-1 font-normal">{t('mcpAudit.colSession')}</th>
                  <th className="text-left px-2 py-1 font-normal">{t('mcpAudit.colResult')}</th>
                  <th className="text-left px-2 py-1 font-normal">{t('mcpAudit.colSource')}</th>
                  <th className="text-left px-2 py-1 font-normal">{t('mcpAudit.colSummary')}</th>
                </tr>
              </thead>
              <tbody>
                {records.map((r) => (
                  <tr key={r.id} className="border-b border-[var(--rule)] hover:bg-[var(--bg-elev)]">
                    <td className="px-2 py-1 text-[var(--text-rack-mute)] whitespace-nowrap" title={r.timestamp}>
                      <span className="text-[var(--text-rack-faint)]">{fmtDate(r.timestamp)}</span> {fmtTime(r.timestamp)}
                    </td>
                    <td className="px-2 py-1 text-[var(--text-rack)] whitespace-nowrap">{r.operation}</td>
                    <td className="px-2 py-1 text-[var(--text-rack-mute)] whitespace-nowrap">{r.capability}</td>
                    <td className="px-2 py-1 text-[var(--text-rack-mute)] whitespace-nowrap" title={r.sessionId}>
                      {r.sessionName || r.sessionId?.slice(0, 8) || '—'}
                    </td>
                    <td className={cn('px-2 py-1 whitespace-nowrap', r.allowed ? 'text-[var(--amber)]' : 'text-[var(--danger, #e06c75)]')}>
                      {r.allowed ? '✓' : '✗'}
                      {r.reason ? <span className="text-[var(--text-rack-faint)] ml-1" title={r.reason}>ⓘ</span> : null}
                    </td>
                    <td className="px-2 py-1 text-[var(--text-rack-mute)] whitespace-nowrap">
                      {r.tokenSource || '—'}
                      {r.originSessionId ? <span className="text-[var(--text-rack-faint)]" title={r.originSessionId}>·{r.originSessionId.slice(0, 6)}</span> : null}
                    </td>
                    <td className="px-2 py-1 text-[var(--text-rack-mute)] truncate max-w-[260px]" title={r.summary || ''}>
                      {r.summary || ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
