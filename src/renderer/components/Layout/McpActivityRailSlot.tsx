import { useEffect, useRef, useState } from 'react'
import cn from 'classnames'
import { useTranslation } from 'react-i18next'
import { usePaneStore } from '../../stores/pane-store'
import { MCP_AUDIT_OVERLAY_ID } from '../../stores'

/**
 * "最近有活动" 判定窗口：最近一条审计记录距现在不超过该阈值时，LED 亮 amber。
 * 5 分钟覆盖一次典型的 MCP 工具调用往返；超过则视为空闲，LED 熄灭。
 */
const RECENT_WINDOW_MS = 5 * 60 * 1000
/** 活动槽轮询间隔：cheap 查询(limit:1)，30s 刷新一次计数 + 最近活动点亮。 */
const POLL_INTERVAL_MS = 30 * 1000

interface McpAuditSummary {
  records: { timestamp: string }[]
  total: number
}

/** MCP 活动 = 脉冲折线(ECG 语言,通用"活动"记号;square cap 同轨上直线图标语言) */
const IconMcpActivity: React.FC = () => (
  <svg width="24" height="24" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" strokeLinejoin="miter">
    <path d="M2 10 h3.2 l2.2 -5.5 3.2 11 2.2 -5.5 H18" />
  </svg>
)

/**
 * 轨底 MCP 活动工具槽 -- 原右上控制簇状态片(McpActivityChip)的轨上版,置于设置槽上方。
 * 脉冲图标 + 最近活动 LED(amber 常亮 = 5 分钟内有审计记录);
 * 审计计数收进 title 提示(轨上不叠计数读数,保持克制)。点击在当前活跃分屏打开/关闭
 * MCP 活动页签(整面覆盖该 pane)。active 态 = MCP 页签正打开在某个 pane,
 * 读作"通电的工具卡"(镜像设置槽激活语言)。
 *
 * 非页签:切换的是 pane 覆盖层而非导航,与轨顶收起控位同类,用 aria-pressed 表达开关态。
 */
export function McpActivityRailSlot(): JSX.Element {
  const { t } = useTranslation()
  const [count, setCount] = useState(0)
  const [recent, setRecent] = useState(false)
  // MCP 审计面板是单例覆盖层，开关态只消费 null 性（active 判定 + 关闭跳变检测）。
  // 布尔 selector 一次字典查找即答：payload 哨兵与树同 set 原子增删（挂载即建、
  // closeRefsTail 回收即删），字典在 ≡ 面板开着。此前按 paneId 订阅要在每次
  // store 写入（含拖分屏调宽的逐帧 setSplitRatio）付一次全树遍历，只为了
  // 学一个布尔值 —— 挂载 pane id 需要时点击处 getState 现查即可
  const mcpAuditOpen = usePaneStore(s => !!s.overlayPayloads[MCP_AUDIT_OVERLAY_ID])

  // MCP 页签关闭(true -> false)时自增 refreshKey，触发立即拉取最新计数
  // （保留"关闭即刷新计数"的体验，不等 30s 轮询）
  const [refreshKey, setRefreshKey] = useState(0)
  const prevMcpOpen = useRef<boolean>(mcpAuditOpen)
  useEffect(() => {
    if (prevMcpOpen.current && !mcpAuditOpen) {
      setRefreshKey(k => k + 1)
    }
    prevMcpOpen.current = mcpAuditOpen
  }, [mcpAuditOpen])

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

  const active = mcpAuditOpen

  // 点击：在当前活跃分屏切换 MCP 页签。正显示在本 pane -> 关；未开 / 开在别的 pane /
  // 开在本 pane 但被终端或 web 页签盖住 -> 打开并置顶（单例，会从别的 pane 移过来）。
  const handleClick = () => {
    const st = usePaneStore.getState()
    const ap = st.layout.activePaneId
    if (!ap) return
    const mcp = st.getOverlayByKind('mcpAudit')
    if (mcp && mcp.paneId === ap && mcp.ref.active) st.closeMcpAudit()
    else st.openMcpAuditInPane(ap)
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-pressed={active}
      title={t('settings.mcpActivityHint', { count })}
      aria-label={t('settings.mcpActivityHint', { count })}
      className={cn(
        // 轨底工具槽(组内上位):mt-auto 把 MCP + 设置整组推到轨底;
        // border-t 与内容页签分笼,border-b 与下方设置槽做卡笼 hairline 分隔
        'relative h-[44px] flex items-center justify-center transition-colors group mt-auto',
        'border-t border-b border-[var(--rule-soft)]',
        active
          ? 'bg-[var(--bg-slot)] shadow-[inset_0_1px_0_var(--amber-soft),inset_0_-1px_0_var(--amber-soft)]'
          : 'hover:bg-[var(--bg-rack)]',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--amber)]'
      )}
    >
      {/* amber 左边条 -- 通电信号,镜像 active SessionSlot 的 before: 条 */}
      {active && (
        <span
          aria-hidden
          className="absolute left-0 top-0 bottom-0 w-[2px] bg-[var(--amber)] shadow-[0_0_4px_var(--amber-glow)]"
        />
      )}
      <span
        className={cn(
          'transition-[color,transform] duration-200 ease-out group-hover:scale-110',
          active
            ? 'text-[var(--amber)] animate-rail-icon-glow'
            : 'text-[var(--text-rack-dim)] group-hover:text-[var(--text-rack-mute)]'
        )}
      >
        <IconMcpActivity />
      </span>

      {/* 最近活动 LED -- 5 分钟内有 MCP 审计记录时亮 amber 常亮(静态)。
          不做呼吸动画:MCP 客户端持续调用时 recent 恒为 true,周期性明灭在视野
          边缘读作持续闪烁打扰;常亮 + 辉光足以承载"最近有活动"的信号 */}
      {recent && (
        <span
          aria-hidden
          className="absolute top-[7px] right-[7px] w-[6px] h-[6px] rounded-full"
          style={{ backgroundColor: 'var(--amber)', boxShadow: '0 0 5px var(--amber)' }}
        />
      )}
    </button>
  )
}
