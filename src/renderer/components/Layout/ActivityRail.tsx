import React from 'react'
import cn from 'classnames'
import { useTranslation } from 'react-i18next'

/**
 * 左侧机柜竖版页签轨 -- 把"会话 / Agent / 插件"三权并立成等高的机柜卡槽。
 *
 * 视觉语言沿用 active SessionSlot:激活槽用 amber 左边条 + bg-slot 填充 + amber 图标,
 * 像"通电的 1U 卡片";槽间用 rule-soft hairline + inset 凹陷阴影做卡笼分隔。
 * 这是本组件的 signature -- 导航本身读作机柜插卡,而非通用图标条。
 *
 * no-mcp 构建隐藏 plugins 槽 -- 插件激活依赖 MCP HTTP server(见 MainWindow 同源逻辑),
 * 该构建下展示槽只会让用户"装了没反应"。__DISABLE_MCP__ 为编译期常量,经 vite define 消除分支。
 */
export type NavTab = 'sessions' | 'agents' | 'plugins'

const ALL_TABS: NavTab[] = ['sessions', 'agents', 'plugins']
const TABS: NavTab[] = __DISABLE_MCP__ ? ['sessions', 'agents'] : ALL_TABS

/** 轨宽(px) -- 单一真相源:本组件容器宽与 MainWindow 宽度拖拽算式共用,防两处漂移 */
export const RAIL_WIDTH = 44

// ─────────────────────────────────────────────────────────────────────────────
// 图标 -- 1.4 stroke / square cap,与既有图标集同语言
// ─────────────────────────────────────────────────────────────────────────────

/** 会话 = 三层服务器机柜(每层一颗电源灯) */
const IconSessions: React.FC = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square">
    <rect x="3" y="3" width="14" height="3.5" />
    <rect x="3" y="8.25" width="14" height="3.5" />
    <rect x="3" y="13.5" width="14" height="3.5" />
    <circle cx="6" cy="4.75" r="0.7" fill="currentColor" stroke="none" />
    <circle cx="6" cy="10" r="0.7" fill="currentColor" stroke="none" />
    <circle cx="6" cy="15.25" r="0.7" fill="currentColor" stroke="none" />
  </svg>
)

/** Agent = 机器人头(呼应默认 🤖 agent 图标) */
const IconAgents: React.FC = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square">
    <rect x="4" y="6" width="12" height="9.5" rx="1" />
    <path d="M10 3v3" />
    <circle cx="10" cy="2.6" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="7.6" cy="10.2" r="1" fill="currentColor" stroke="none" />
    <circle cx="12.4" cy="10.2" r="1" fill="currentColor" stroke="none" />
    <path d="M7.8 12.8h4.4" />
  </svg>
)

/** 插件 = 拼图块(通用约定,识别度优先于主题化) */
const IconPlugins: React.FC = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" strokeLinejoin="miter">
    <path d="M3 3 h5.5 a1.5 1.5 0 0 1 3 0 h5.5 v5.5 a1.5 1.5 0 0 1 0 3 v5.5 h-14 z" />
  </svg>
)

const TAB_ICON: Record<NavTab, React.FC> = {
  sessions: IconSessions,
  agents: IconAgents,
  plugins: IconPlugins,
}

// ─────────────────────────────────────────────────────────────────────────────
// 徽章 -- 仅 sessions 槽位一颗 live LED(在线信号)。agents/plugins 不堆计数:
// 数量已在各面板头条显示(AGENTS · N),轨上再叠 chip 是冗余读数,违背克制。
// ─────────────────────────────────────────────────────────────────────────────

interface ActivityRailProps {
  active: NavTab
  onChange: (tab: NavTab) => void
  /** 在线会话数 -- sessions 槽位显示 live LED */
  liveCount?: number
}

const ActivityRail: React.FC<ActivityRailProps> = ({
  active,
  onChange,
  liveCount = 0,
}) => {
  const { t } = useTranslation()

  const labelFor = (tab: NavTab): string =>
    tab === 'sessions' ? t('nav.sessions')
      : tab === 'agents' ? t('nav.agents')
        : t('nav.plugins')

  /** sessions 槽位:有在线会话时亮 live LED;其余槽位无徽章 */
  const ledFor = (tab: NavTab): string | undefined =>
    tab === 'sessions' && liveCount > 0 ? 'var(--live)' : undefined

  return (
    <div
      className="flex flex-col items-stretch h-full flex-shrink-0 bg-[var(--bg-base)] border-r border-[var(--rule)] select-none"
      style={{ width: RAIL_WIDTH }}
      role="tablist"
      aria-orientation="vertical"
    >
      {TABS.map((tab, i) => {
        const isActive = active === tab
        const Icon = TAB_ICON[tab]
        const led = ledFor(tab)
        const label = labelFor(tab)
        const isLast = i === TABS.length - 1
        return (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-label={label}
            title={label}
            onClick={() => onChange(tab)}
            className={cn(
              // 卡笼 1U 槽位:hairline 分隔 + inset 凹陷(槽嵌入框架感),与 SessionSlot 同语言
              'relative h-[44px] flex items-center justify-center transition-colors group',
              'shadow-[inset_0_-1px_0_var(--bg-base)]',
              !isLast && 'border-b border-[var(--rule-soft)]',
              isActive
                // 激活:通电槽 -- bg-slot 填充 + 上下 amber-soft inset(被"拉出"的通电感),镜像 SessionSlot active
                ? 'bg-[var(--bg-slot)] shadow-[inset_0_1px_0_var(--amber-soft),inset_0_-1px_0_var(--amber-soft)]'
                : 'hover:bg-[var(--bg-rack)]',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--amber)]'
            )}
          >
            {/* amber 左边条 -- 通电信号,镜像 active SessionSlot 的 before: 条 */}
            {isActive && (
              <span
                aria-hidden
                className="absolute left-0 top-0 bottom-0 w-[2px] bg-[var(--amber)] shadow-[0_0_4px_var(--amber-glow)]"
              />
            )}
            <span
              className={cn(
                'transition-colors',
                isActive
                  ? 'text-[var(--amber)]'
                  : 'text-[var(--text-rack-dim)] group-hover:text-[var(--text-rack-mute)]'
              )}
            >
              <Icon />
            </span>

            {/* live LED -- sessions 槽位在线信号 */}
            {led && (
              <span
                aria-hidden
                className="absolute top-[7px] right-[7px] w-[6px] h-[6px] rounded-full"
                style={{ backgroundColor: led, boxShadow: `0 0 5px ${led}` }}
              />
            )}
          </button>
        )
      })}
    </div>
  )
}

export default ActivityRail
