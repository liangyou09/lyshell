import React from 'react'
import cn from 'classnames'
import { useTranslation } from 'react-i18next'
import DeepSeekWhaleIcon from './DeepSeekWhaleIcon'
import { McpActivityRailSlot } from './McpActivityRailSlot'
import { TOPBAR_HEIGHT } from './topbar-metrics'

/**
 * 左侧机柜竖版页签轨 -- 把"会话 / Agent / 插件"三权并立成等高的机柜卡槽。
 *
 * 视觉语言沿用 active SessionSlot:激活槽用 amber 左边条 + bg-slot 填充 + amber 图标,
 * 像"通电的 1U 卡片";槽间用 rule-soft hairline + inset 凹陷阴影做卡笼分隔。
 * 这是本组件的 signature -- 导航本身读作机柜插卡,而非通用图标条。
 *
 * 轨顶第一槽是左列收起控位(非页签):与收起态终端列左上的展开 pill 构成同一开关的
 * 两个形态 -- 开关永远停在窗口左上角,展开时是本槽,收起时是 pill,150ms 交叉淡变。
 * 槽高读 TOPBAR_HEIGHT,与终端第一行页签条齐平。
 */
export type NavTab = 'sessions' | 'agents' | 'dsh' | 'codex' | 'claude' | 'plugins' | 'web' | 'settings'

// 内容页签(上组):会话 / Agent / DeepSeek Harness / Codex / Claude / 插件 / 网页。settings 是轨底独立工具槽,不在此列。
const ALL_TABS: NavTab[] = ['sessions', 'agents', 'dsh', 'codex', 'claude', 'plugins', 'web']
const TABS: NavTab[] = ALL_TABS

/** 轨宽(px) -- 单一真相源:本组件容器宽与 MainWindow 宽度拖拽算式共用,防两处漂移 */
export const RAIL_WIDTH = 44

// ─────────────────────────────────────────────────────────────────────────────
// 图标 -- 24px 渲染(20 viewBox 放大 1.2x,有效线宽 ~1.68),方形 cap 与既有图标集同语言
// ─────────────────────────────────────────────────────────────────────────────

/** 会话 = 三层服务器机柜(每层一颗电源灯) */
const IconSessions: React.FC = () => (
  <svg width="24" height="24" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square">
    <rect x="3" y="3" width="14" height="3.5" />
    <rect x="3" y="8.25" width="14" height="3.5" />
    <rect x="3" y="13.5" width="14" height="3.5" />
    <circle cx="6" cy="4.75" r="0.7" fill="currentColor" stroke="none" />
    <circle cx="6" cy="10" r="0.7" fill="currentColor" stroke="none" />
    <circle cx="6" cy="15.25" r="0.7" fill="currentColor" stroke="none" />
  </svg>
)

/** Agent = 机器人头(呼应默认 🤖 agent 图标)。
 *  宽略大于高(12.5×10.5),在「扁」与「方」之间取中;rx=2.5 大圆角去方感,微笑嘴,round cap/join。 */
const IconAgents: React.FC = () => (
  <svg width="24" height="24" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10 4.3v1.7" />
    <circle cx="10" cy="3.4" r="0.9" fill="currentColor" stroke="none" />
    <rect x="3.75" y="6" width="12.5" height="10.5" rx="2.5" />
    <circle cx="7.9" cy="10.5" r="1.05" fill="currentColor" stroke="none" />
    <circle cx="12.1" cy="10.5" r="1.05" fill="currentColor" stroke="none" />
    <path d="M7.9 13.7q2.1 1.4 4.2 0" />
  </svg>
)

/** codex/claude = 官方内置品牌标(assets/agent-icons/*.png),mask 取资产 alpha 作实心剪影、随主题着色。
 *  Filled 剪影与线描图标(会话/机器人头/拼图/齿轮)不同语言,故走 bg-current + mask;
 *  激活色与 dsh 鲸鱼一致为 --text-rack(白/黑),不亮 amber。 */
const codexIcon = new URL('../../assets/agent-icons/codex.png', import.meta.url).href
const claudeIcon = new URL('../../assets/agent-icons/claude.png', import.meta.url).href

/** 实心剪影图标:bg-current 跟随父级 currentColor,取资产 alpha 作 mask(与 rail 其余 currentColor 图标同色) */
const BrandMaskIcon: React.FC<{ src: string }> = ({ src }) => (
  <span
    aria-hidden
    className="block w-[24px] h-[24px] bg-current"
    style={{
      maskImage: `url(${src})`,
      WebkitMaskImage: `url(${src})`,
      maskSize: 'contain',
      WebkitMaskSize: 'contain',
      maskPosition: 'center',
      WebkitMaskPosition: 'center',
      maskRepeat: 'no-repeat',
      WebkitMaskRepeat: 'no-repeat'
    }}
  />
)

/** codex = OpenAI 花朵(官方内置品牌标,mask 取 alpha 剪影、随主题着色) */
const IconCodex: React.FC = () => <BrandMaskIcon src={codexIcon} />

/** claude = Anthropic 太阳花(官方内置品牌标,mask 取 alpha 剪影、随主题着色) */
const IconClaude: React.FC = () => <BrandMaskIcon src={claudeIcon} />

/** 插件 = 拼图块(通用约定,识别度优先于主题化) */
const IconPlugins: React.FC = () => (
  <svg width="24" height="24" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" strokeLinejoin="miter">
    <path d="M3 3 h5.5 a1.5 1.5 0 0 1 3 0 h5.5 v5.5 a1.5 1.5 0 0 1 0 3 v5.5 h-14 z" />
  </svg>
)

/** 网页 = 地球仪(圆 + 赤道/经线,通用"网页/网络"约定;square cap 同轨上直线图标语言) */
const IconWeb: React.FC = () => (
  <svg width="24" height="24" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" strokeLinejoin="miter">
    <circle cx="10" cy="10" r="7" />
    <path d="M3 10 h14" />
    <path d="M10 3 c2.4 2 2.4 12 0 14 c-2.4 -2 -2.4 -12 0 -14 z" />
  </svg>
)

/** 收起控位 = 双层 « 指向左列滑出方向(与收起态 pill 的单层 » 成对:« 收 / » 展)。
 *  双层的份量对齐相邻的机架/机器人头/齿轮图标;square cap 同轨上直线图标语言。 */
const IconCollapseRail: React.FC = () => (
  <svg width="24" height="24" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" strokeLinejoin="miter">
    <path d="M10.5 5.5 L5.5 10 L10.5 14.5" />
    <path d="M15.5 5.5 L10.5 10 L15.5 14.5" />
  </svg>
)

/** 设置 = 齿轮(工具位,轨底独立槽)。
 *  齿轮是曲线形态,round cap/join 更自然,故不随其余直线图标用 square;
 *  24 viewBox 缩小到 20 渲染,strokeWidth 取 1.7 使有效线宽对齐其余图标的 1.4。 */
const IconSettings: React.FC = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
)

const TAB_ICON: Record<NavTab, React.FC> = {
  sessions: IconSessions,
  agents: IconAgents,
  dsh: DeepSeekWhaleIcon,
  codex: IconCodex,
  claude: IconClaude,
  plugins: IconPlugins,
  web: IconWeb,
  settings: IconSettings,
}

// ─────────────────────────────────────────────────────────────────────────────
// 徽章 -- 仅 sessions 槽位一颗 live LED(在线信号)。agents/plugins 不堆计数:
// 数量已在各面板头条显示(AGENTS · N),轨上再叠 chip 是冗余读数,违背克制。
// ─────────────────────────────────────────────────────────────────────────────

interface ActivityRailProps {
  active: NavTab
  onChange: (tab: NavTab) => void
  /** 收起左列 -- 轨顶收起控位点击;收起后由终端列左上的展开 pill 接棒 */
  onCollapse: () => void
  /** 在线会话数 -- sessions 槽位显示 live LED */
  liveCount?: number
}

const ActivityRail: React.FC<ActivityRailProps> = ({
  active,
  onChange,
  onCollapse,
  liveCount = 0,
}) => {
  const { t } = useTranslation()

  const labelFor = (tab: NavTab): string =>
    tab === 'sessions' ? t('nav.sessions')
      : tab === 'agents' ? t('nav.agents')
        : tab === 'dsh' ? t('nav.dsh')
          : tab === 'codex' ? t('nav.codex')
            : tab === 'claude' ? t('nav.claude')
              : tab === 'plugins' ? t('nav.plugins')
                : tab === 'web' ? t('nav.web')
                  : t('nav.settings')

  /** sessions 槽位:有在线会话时亮 live LED;其余槽位无徽章 */
  const ledFor = (tab: NavTab): string | undefined =>
    tab === 'sessions' && liveCount > 0 ? 'var(--live)' : undefined

  return (
    <div
      className="flex flex-col items-stretch h-full flex-shrink-0 bg-[var(--bg-base)] select-none"
      style={{ width: RAIL_WIDTH }}
    >
      {/* 轨顶收起控位 -- 左列展开时的收起开关(收起态由终端列左上 ghost 控位接棒,见 MainWindow)。
          非页签:无 role=tab/激活态。槽高对齐终端第一行(TOPBAR_HEIGHT),底部 rule 线与
          面板头条的 border-b 同色同 y -- 它是横贯窗口的"第一行底线"(收起槽 → 面板头条 →
          页签条连成一条),不是收起槽与内容页签的槽位分隔;第一行内部(右侧)不画竖线,
          整行读作无分割的一条横带,下方内容页签保持 44 高不变。
          ghost 语言与收起态 pill 同源:静息线走 mute(与面板头条文字同档,
          第一行的读数亮度),悬停 bg-rack 托起(轨槽的一步抬升,对应 pill 的
          bg-elev)+ chevron 提亮到 data */}
      <button
        type="button"
        onClick={onCollapse}
        title={t('settings.collapseSidebar')}
        aria-label={t('settings.collapseSidebar')}
        style={{ height: TOPBAR_HEIGHT }}
        className={cn(
          'relative flex items-center justify-center transition-colors group',
          'border-b border-[var(--rule)]',
          'hover:bg-[var(--bg-rack)]',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--amber)]'
        )}
      >
        <span className="text-[var(--text-rack-mute)] group-hover:text-[var(--text-rack-data)] group-focus-visible:text-[var(--text-rack-data)] transition-colors">
          <IconCollapseRail />
        </span>
      </button>

      {/* 页签笼 -- 机柜轨与面板的竖分隔线(border-r)画在这里而不是轨容器上:
          收起槽所在的窗口第一行不画竖线,收起槽 + 面板头条读作一条连续横带,
          竖线从第一行以下才开始。tablist 也落在这层:笼里全是真页签,收起控件不混入 */}
      <div
        className="flex flex-col flex-1 border-r border-[var(--rule)]"
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
                'transition-[color,transform] duration-200 ease-out group-hover:scale-110',
                isActive
                  ? (tab === 'dsh' || tab === 'codex' || tab === 'claude')
                    ? 'text-[var(--text-rack)]'
                    : 'text-[var(--amber)] animate-rail-icon-glow'
                  : 'text-[var(--text-rack-dim)] group-hover:text-[var(--text-rack-mute)]'
              )}
            >
              <Icon />
            </span>

            {/* live LED -- sessions 槽位在线信号 */}
            {led && (
              <span
                aria-hidden
                className="absolute top-[7px] right-[7px] w-[6px] h-[6px] rounded-full animate-breathe"
                style={{ backgroundColor: led, boxShadow: `0 0 5px ${led}` }}
              />
            )}
          </button>
        )
      })}

      {/* 轨底工具槽组 -- MCP 活动槽(McpActivityRailSlot 自带 mt-auto 整组推底) + 设置槽。
          MCP 槽非页签(切换 pane 覆盖层而非导航),置于设置槽上方;组内两槽间以
          MCP 槽的 border-b 做 hairline 分隔(卡笼语言)。 */}
      <McpActivityRailSlot />

      {/* settings 工具槽 -- 轨底最末位;无 LED。
          active 语言与内容槽一致:amber 左条 + bg-slot 填充,读作"通电的工具卡"。 */}
      <button
        type="button"
        role="tab"
        aria-selected={active === 'settings'}
        aria-label={labelFor('settings')}
        title={labelFor('settings')}
        onClick={() => onChange('settings')}
        className={cn(
          'relative h-[44px] flex items-center justify-center transition-colors group',
          active === 'settings'
            ? 'bg-[var(--bg-slot)] shadow-[inset_0_1px_0_var(--amber-soft),inset_0_-1px_0_var(--amber-soft)]'
            : 'hover:bg-[var(--bg-rack)]',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--amber)]'
        )}
      >
        {active === 'settings' && (
          <span
            aria-hidden
            className="absolute left-0 top-0 bottom-0 w-[2px] bg-[var(--amber)] shadow-[0_0_4px_var(--amber-glow)]"
          />
        )}
        <span
          className={cn(
            'transition-[color,transform] duration-200 ease-out group-hover:scale-110',
            active === 'settings'
              ? 'text-[var(--amber)] animate-rail-icon-glow'
              : 'text-[var(--text-rack-dim)] group-hover:text-[var(--text-rack-mute)]'
          )}
        >
          <IconSettings />
        </span>
      </button>
      </div>
    </div>
  )
}

export default ActivityRail
