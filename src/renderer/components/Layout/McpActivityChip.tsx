import { useEffect, useRef, useState } from 'react'
import cn from 'classnames'
import { useTranslation } from 'react-i18next'
import { usePaneStore } from '../../stores/pane-store'

/**
 * "最近有活动" 判定窗口：最近一条审计记录距现在不超过该阈值时，状态点亮 amber。
 * 5 分钟覆盖一次典型的 MCP 工具调用往返；超过则视为空闲，回落到灰点。
 */
const RECENT_WINDOW_MS = 5 * 60 * 1000
/** 状态片轮询间隔：cheap 查询(limit:1)，30s 刷新一次计数 + 最近活动点亮。 */
const POLL_INTERVAL_MS = 30 * 1000

interface McpAuditSummary {
  records: { timestamp: string }[]
  total: number
}

/**
 * 标题栏 MCP 活动状态片 -- 原设置页 MCP tab 里"MCP 活动"按钮的提升版。
 * 圆点(amber=最近有活动 / 灰=空闲) + 标签 + 审计记录条数；点击在当前活跃分屏
 * 打开/关闭 MCP 活动页签(整面覆盖该 pane)。active 态 = MCP 页签正打开在某个 pane。
 */
export function McpActivityChip(): JSX.Element {
  const { t } = useTranslation()
  const [count, setCount] = useState(0)
  const [recent, setRecent] = useState(false)
  const mcpAuditPaneId = usePaneStore(s => s.mcpAuditPaneId)

  // MCP 页签关闭(非空 -> null)时自增 refreshKey，触发立即拉取最新计数
  // （保留"关闭即刷新计数"的体验，不等 30s 轮询）
  const [refreshKey, setRefreshKey] = useState(0)
  const prevMcpPaneId = useRef<string | null>(mcpAuditPaneId)
  useEffect(() => {
    if (prevMcpPaneId.current !== null && mcpAuditPaneId === null) {
      setRefreshKey(k => k + 1)
    }
    prevMcpPaneId.current = mcpAuditPaneId
  }, [mcpAuditPaneId])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const result = await window.electronAPI?.getMcpAudit({ limit: 1 }) as McpAuditSummary | undefined
        if (cancelled || !result) return
        setCount(result.total ?? 0)
        const latest = result.records?.[0]?.timestamp
        if (latest) {
          const age = Date.now() - new Date(latest).getTime()
          setRecent(Number.isFinite(age) && age >= 0 && age <= RECENT_WINDOW_MS)
        } else {
          setRecent(false)
        }
      } catch {
        // 查询失败保持上一次状态，不打扰用户
      }
    }
    load()
    const timer = setInterval(load, POLL_INTERVAL_MS)
    return () => { cancelled = true; clearInterval(timer) }
  }, [refreshKey])

  const active = mcpAuditPaneId !== null

  // 点击：在当前活跃分屏切换 MCP 页签。已开在本 pane -> 关；否则开在本 pane（单例，会从别的 pane 移过来）。
  const handleClick = () => {
    const st = usePaneStore.getState()
    const ap = st.layout.activePaneId
    if (!ap) return
    if (st.mcpAuditPaneId === ap) st.closeMcpAudit()
    else st.openMcpAuditInPane(ap)
  }

  const dotColor = recent ? 'var(--amber)' : 'var(--text-rack-mute)'
  const dotGlow = recent ? '0 0 6px color-mix(in srgb, var(--amber) 60%, transparent)' : 'none'

  return (
    <button
      type="button"
      onClick={handleClick}
      title={t('settings.mcpActivityHint', { count })}
      className={cn(
        'h-[24px] flex items-center gap-1.5 px-2 rounded-[2px] cursor-pointer group transition-colors',
        active ? 'bg-[var(--bg-elev)]' : 'bg-[var(--bg-slot)] hover:bg-[var(--bg-elev)]'
      )}
      style={{ fontFamily: 'ui-monospace, "JetBrains Mono", "Cascadia Code", Consolas, monospace' }}
    >
      <span
        aria-hidden
        className="w-[6px] h-[6px] rounded-full flex-shrink-0 transition-[background-color,box-shadow]"
        style={{ backgroundColor: dotColor, boxShadow: dotGlow }}
      />
      <span
        className={cn(
          'text-[11px] [font-family:inherit] font-semibold tracking-[.08em] transition-colors leading-none',
          active ? 'text-[var(--amber)]' : 'text-[var(--text-rack-data)] group-hover:text-[var(--amber)]'
        )}
      >
        {t('settings.mcpAudit')}
      </span>
      <span
        className={cn(
          'text-[11px] [font-family:inherit] tabular-nums leading-none group-hover:text-[var(--amber)]',
          count > 0 ? 'text-[var(--text-rack)]' : 'text-[var(--text-rack-mute)]'
        )}
        style={{ fontFeatureSettings: '"tnum" 1' }}
      >
        {count}
      </span>
    </button>
  )
}
