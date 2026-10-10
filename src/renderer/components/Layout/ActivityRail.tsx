import React, { useEffect, useState } from 'react'
import './ActivityRail.css'
import cn from 'classnames'
import { useTranslation } from 'react-i18next'
import DeepSeekWhaleIcon from './DeepSeekWhaleIcon'
import { McpActivityRailSlot } from './McpActivityRailSlot'
import { TOPBAR_HEIGHT } from './topbar-metrics'
import { makePluginViewKey, parsePluginViewKey } from '@shared/plugin-types'
import type { PluginViewMeta } from '@shared/plugin-types'

/** 左侧机柜导航：保留分槽与连片选中态，图标采用统一光学尺寸和轻量托座。 */
/** 固定页签白名单（内容页签 + 轨底设置槽）—— localStorage 恢复校验与类型收窄共用 */
export const FIXED_NAV_TABS = ['sessions', 'agents', 'dsh', 'codex', 'claude', 'env', 'plugins', 'web', 'settings'] as const
export type FixedNavTab = (typeof FIXED_NAV_TABS)[number]

/** 插件视图复合键由 @shared 的 makePluginViewKey 构造、parsePluginViewKey 解析。 */
export type PluginViewNavTab = `plugin:${string}:${string}`

export type NavTab = FixedNavTab | PluginViewNavTab

export function isFixedNavTab(tab: string): tab is FixedNavTab {
  return (FIXED_NAV_TABS as readonly string[]).includes(tab)
}

// 内容页签(上组):会话 / Agent / DeepSeek Harness / Codex / Claude / 变量组 / 插件 / 网页。
// env 是三个 harness 与通用 Agent 共享的全局变量组库,排在启动面(sessions..claude)之后、
// 资源组(plugins/web)之首。settings 是轨底独立工具槽,不在此列。
const ALL_TABS: FixedNavTab[] = ['sessions', 'agents', 'dsh', 'codex', 'claude', 'env', 'plugins', 'web']
const TABS: FixedNavTab[] = ALL_TABS

/** 轨宽(px) -- 单一真相源:本组件容器宽与 MainWindow 宽度拖拽算式共用,防两处漂移 */
export const RAIL_WIDTH = 44

// ─────────────────────────────────────────────────────────────────────────────
// 图标：22px 光学尺寸、圆角端点；品牌轮廓与 ENV 横牌按视觉重量单独校准。
// ─────────────────────────────────────────────────────────────────────────────

/** 会话 = 叠屏与终端提示符；后屏收淡，前屏突出可操作的终端。 */
const IconSessions: React.FC = () => (
  <svg aria-hidden width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M7 6V4.5A1.5 1.5 0 0 1 8.5 3h11A1.5 1.5 0 0 1 21 4.5v9a1.5 1.5 0 0 1-1.5 1.5H18" opacity=".55" />
    <rect x="3" y="8" width="14" height="13" rx="2" />
    <path d="m6.5 12 2.5 2.5-2.5 2.5M11.5 17H14" />
  </svg>
)

/** Agent = 四角定位框与星形内核，短线和主图形保持同一描边重量。 */
const IconAgents: React.FC = () => (
  <svg aria-hidden width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 8V4a1 1 0 0 1 1-1h4M16 3h4a1 1 0 0 1 1 1v4M21 16v4a1 1 0 0 1-1 1h-4M8 21H4a1 1 0 0 1-1-1v-4" opacity=".65" />
    <path d="m12 6 1.8 4.2L18 12l-4.2 1.8L12 18l-1.8-4.2L6 12l4.2-1.8Z" />
    <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
  </svg>
)

/** codex/claude = 官方内置品牌标(assets/agent-icons/*.png),mask 取资产 alpha 作实心剪影、随主题着色。
 *  Filled 剪影保留品牌轮廓，走 bg-current + mask;
 *  激活色与 dsh 鲸鱼一致为 --text-rack(白/黑),不亮 amber。 */
const codexIcon = new URL('../../assets/agent-icons/codex.png', import.meta.url).href
const claudeIcon = new URL('../../assets/agent-icons/claude.png', import.meta.url).href

/** 实心剪影图标:bg-current 跟随父级 currentColor,取资产 alpha 作 mask(与 rail 其余 currentColor 图标同色) */
const BrandMaskIcon: React.FC<{ src: string }> = ({ src }) => (
  <span
    aria-hidden
    className="block w-[22px] h-[22px] bg-current"
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

/** 变量组 = ENV 横牌；圆角外框和加重顶边呼应机柜上的铭牌。 */
const IconEnv: React.FC = () => (
  <svg aria-hidden width="26" height="22" viewBox="0 0 28 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <rect x="1.15" y="1.15" width="25.7" height="21.7" rx="3" />
    <path d="M6 1.15h16" strokeWidth="2.4" />
    <text x="14" y="11.8" textAnchor="middle" dominantBaseline="central" fill="currentColor" stroke="none" fontSize="9.4" fontWeight="700" letterSpacing="0.15" fontFamily='ui-monospace, "JetBrains Mono", "Cascadia Code", Consolas, monospace'>ENV</text>
  </svg>
)

/** 插件 = 三枚固定模块与一枚轻微转动的模块，表达安装入位。 */
const IconPlugins: React.FC = () => (
  <svg aria-hidden width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="7" height="7" rx="1.3" />
    <rect x="3" y="14" width="7" height="7" rx="1.3" />
    <rect x="14" y="14" width="7" height="7" rx="1.3" />
    <rect x="14.3" y="3.3" width="6.4" height="6.4" rx="1.3" transform="rotate(15 17.5 6.5)" fill="currentColor" fillOpacity=".12" />
  </svg>
)

/** 写轮眼小尺寸稿：空心虹膜、小瞳孔、三枚独立勾玉，24px 下保留清楚的负空间。 */
const IconWeb: React.FC = () => (
  <svg aria-hidden width="24" height="24" viewBox="0 0 24 24" fill="none">
    <circle cx="12" cy="12" r="10.25" stroke="currentColor" strokeWidth="1.7" />
    <circle cx="12" cy="12" r="1.65" fill="currentColor" />
    {[0, 120, 240].map((angle) => (
      <path
        key={angle}
        transform={`rotate(${angle} 12 12)`}
        d="M12 4.7C10.95 4.7 10.1 5.5 10.1 6.55C10.1 7.6 10.95 8.45 12 8.45C13.55 8.45 14.65 7.05 14.65 5.45C14.65 4.6 14.05 3.85 13.2 3.6C13.6 4.15 13.55 4.6 13.05 5.1C12.75 4.85 12.4 4.7 12 4.7Z"
        fill="currentColor"
      />
    ))}
  </svg>
)

/** 收起控位 = 双层左箭头；尺寸略小，让导航图标保持主次。 */
const IconCollapseRail: React.FC = () => (
  <svg aria-hidden width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="m11 6-6 6 6 6m7-12-6 6 6 6" />
  </svg>
)

/** 设置 = 圆角齿轮；画布留出边缘余量，避免齿尖贴近托座。 */
const IconSettings: React.FC = () => (
  <svg aria-hidden width="22" height="22" viewBox="-1 -1 26 26" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
)

const TAB_ICON: Record<FixedNavTab, React.FC> = {
  sessions: IconSessions,
  agents: IconAgents,
  dsh: DeepSeekWhaleIcon,
  codex: IconCodex,
  claude: IconClaude,
  env: IconEnv,
  plugins: IconPlugins,
  web: IconWeb,
  settings: IconSettings,
}

/** 插件视图槽位图标：经受限 IPC 入口取 main 净化后的 data URL（主 renderer 默认
 *  session 够不着插件专属 partition 上的资源协议，见 plan §三「图标入口」）；
 *  失败或未声明 icon 回退内置 IconPlugins。 */
const PluginRailIcon: React.FC<{ pluginId: string; viewId: string }> = ({ pluginId, viewId }) => {
  const [icon, setIcon] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    setIcon(null)
    window.electronAPI?.getPluginViewIcon(pluginId, viewId)
      .then((r) => {
        if (!cancelled && r?.success && r.data) setIcon(r.data)
      })
      .catch(() => { /* 取不到即用内置图标 */ })
    return () => { cancelled = true }
  }, [pluginId, viewId])
  if (icon) {
    return <img src={icon} alt="" draggable={false} className="w-[22px] h-[22px] object-contain" />
  }
  return <IconPlugins />
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
  /** 插件贡献的视图（plugin:list 快照，已启用插件才会带 views）——固定项之后稳定排序 */
  pluginViews?: PluginViewMeta[]
}

const ActivityRail: React.FC<ActivityRailProps> = ({
  active,
  onChange,
  onCollapse,
  liveCount = 0,
  pluginViews = [],
}) => {
  const { t } = useTranslation()

  const labelFor = (tab: NavTab): string => {
    if (!isFixedNavTab(tab)) {
      // 插件视图槽位：title 用 manifest 值；键失效瞬间（列表已重拉但槽位还在树上）
      // 回退复合键本身，不抛错
      const parsed = parsePluginViewKey(tab)
      const view = parsed ? pluginViews.find((v) => v.pluginId === parsed.pluginId && v.id === parsed.viewId) : undefined
      return view?.title ?? tab
    }
    return tab === 'sessions' ? t('nav.sessions')
      : tab === 'agents' ? t('nav.agents')
        : tab === 'dsh' ? t('nav.dsh')
          : tab === 'codex' ? t('nav.codex')
            : tab === 'claude' ? t('nav.claude')
              : tab === 'env' ? t('nav.env')
                : tab === 'plugins' ? t('nav.plugins')
                  : tab === 'web' ? t('nav.web')
                    : t('nav.settings')
  }

  /** sessions 槽位:有在线会话时亮 live LED;其余槽位无徽章 */
  const ledFor = (tab: NavTab): string | undefined =>
    tab === 'sessions' && liveCount > 0 ? 'var(--live)' : undefined

  return (
    <div
      className="activity-rail flex flex-col items-stretch h-full flex-shrink-0 bg-[var(--bg-base)] select-none"
      style={{ width: RAIL_WIDTH }}
    >
      {/* 轨顶收起控位 -- 左列展开时的收起开关(收起态由终端列左上 ghost 控位接棒,见 MainWindow)。
          非页签:无 role=tab/激活态。槽高对齐终端第一行(TOPBAR_HEIGHT),底部 rule 线与
          面板头条的 border-b 同色同 y -- 它是横贯窗口的"第一行底线"(收起槽 → 面板头条 →
          页签条连成一条),不是收起槽与内容页签的槽位分隔;第一行内部(右侧)不画竖线,
          整行读作无分割的一条横带;下方内容页签取 40 行高 -- 第一行 36 是跨窗
          对齐的 chrome 行高,内容槽给图标托座留呼吸(44 过疏 / 36 过挤的折中)。
          ghost 语言与收起态 pill 同源:静息线走 --text-tab-idle(轨上未选中
          图标的统一档,见组件 docstring),悬停 bg-rack 托起(轨槽的一步抬升,
          对应 pill 的 bg-elev)+ chevron 提亮到 rack */}
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
        <span className="activity-rail-icon text-[var(--text-tab-idle)] group-hover:text-[var(--text-rack)] group-focus-visible:text-[var(--text-rack)] transition-colors">
          <IconCollapseRail />
        </span>
      </button>

      {/* 页签笼 -- 机柜轨与面板的竖分隔线(border-r)画在这里而不是轨容器上:
          收起槽所在的窗口第一行不画竖线,收起槽 + 面板头条读作一条连续横带,
          竖线从第一行以下才开始。笼底整体染 bg-slot 成页签"条带"(chrome 材质,
          浏览器 chrome/页面的分工),激活槽的 bg-base 窗口在条带上挖出、与面板
          同面无缝(见各槽位 span)。tablist 也落在这层:笼里全是真页签,收起控件不混入。
          插件视图槽位可能很多 —— 中段页签区可滚(min-h-0 + overflow-y-auto),
          轨底工具槽组(MCP/设置)固定笼底,设置槽始终可见可达(plan §五) */}
      <div
        className="flex flex-col flex-1 min-h-0 border-r border-[var(--rule)] bg-[var(--bg-slot)]"
        role="tablist"
        aria-orientation="vertical"
      >
      {/* 可滚中段:固定内容页签 + 插件视图槽位 */}
      <div className="flex flex-col flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
      {TABS.map((tab) => {
        const isActive = active === tab
        const Icon = TAB_ICON[tab]
        const led = ledFor(tab)
        const label = labelFor(tab)
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
              // 卡笼槽位:hairline 分隔 + inset 凹陷(槽嵌入框架感),与 SessionSlot 同语言。
              // 行高 40:44 图标间隔过疏、36 呼吸不足的折中;槽间区分交给分隔线,
              // 不靠留空(线条清晰即可)。
              // 所有槽位(含末位 web)一律带底部分隔线:页签笼以闭合的横线收底,
              // 与轨底工具槽组(MCP/设置)之间的空档不读作"缺线"
              'relative h-[40px] flex items-center justify-center transition-colors group',
              'shadow-[inset_0_-1px_0_var(--bg-base)]',
              'border-b border-[var(--rule-soft)]',
              // 激活窗口画在下方独立 span 上(bg-base,需越过 border-r 1px 盖墙,
              // 按钮本体背景到不了那里);非激活槽透明坐在条带上,悬停抬一档到 elev
              !isActive && 'hover:bg-[var(--bg-elev)]',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--amber)]'
            )}
          >
            {/* 激活窗口 -- bg-base 与面板同一面材质,右缘直角越过页签笼 border-r
                竖线 1px 把它整个盖掉:窗口与面板之间无墙、同色无缝,读作浏览器
                激活页签与页面连成一片;墙沿槽上下沿整齐断开,断口是干净的竖直缝。
                (圆肩版弃:6px 弧在两角露出条带色月牙 + 墙线残段,再撞上相邻槽的
                分隔线,6×6px 里三线相碰读作毛刺;直角无此问题。) */}
            {isActive && (
              <span
                aria-hidden
                className="absolute left-0 top-0 bottom-0 right-[-1px] bg-[var(--bg-base)]"
              />
            )}
            {/* amber 左边条 -- 通电信号,镜像 active SessionSlot 的 before: 条
                (排在窗口 span 之后,压在填充上方) */}
            {isActive && (
              <span
                aria-hidden
                className="absolute left-0 top-0 bottom-0 w-[2px] bg-[var(--amber)] shadow-[0_0_4px_var(--amber-glow)]"
              />
            )}
            <span
              className={cn(
                // relative:窗口 span 在绝对定位层,画在普通流内容之上;图标不定位
                // 会被窗口填充盖住(上一版"图标消失"的根因)
                'activity-rail-icon relative',
                isActive
                  // 品牌位激活变白(开眼),不亮 amber、不挂辉光;写轮眼 web 激活
                  // 走红色描边与托座，小尺寸稿以负空间区分勾玉和瞳孔
                  ? (tab === 'dsh' || tab === 'codex' || tab === 'claude')
                    ? 'text-[var(--text-rack)]'
                    : tab === 'web'
                      ? 'rail-icon-sharingan-active'
                      : 'text-[var(--amber)]'
                  // 静息 --text-tab-idle(页签静息字同款混档,轨上未选中图标统一:
                  // 曾走 mute ~3:1,用户校准嫌暗提到该档 —— dim 在 bg-slot 条带
                  // 上仅 ~2:1,低亮度低饱和蓝灰糊进蓝黑条带,读作"暗影"而非图标)。
                  // 悬停再提一档到 rack:静息/悬停/激活(amber)三态各自拉开一档
                  : 'text-[var(--text-tab-idle)] group-hover:text-[var(--text-rack)]'
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

      {/* 插件视图槽位 -- 每个 PluginViewMeta 一个槽,固定项之后稳定排序(注册表已按
          安装序 → manifest 序 → 运行时注册序排好)。槽位 chrome 与固定页签同语言
          (激活窗口 span + amber 左条 + mute/hover-data 图标),无 LED;图标经受限
          IPC 取 main 净化后的 data URL,失败回退 IconPlugins。key 用复合键 --
          注销/重注册按键卸载重挂,不串槽 */}
      {pluginViews.map((view) => {
        const tab = makePluginViewKey(view.pluginId, view.id)
        const isActive = active === tab
        const label = labelFor(tab)
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
              'relative h-[40px] flex items-center justify-center transition-colors group',
              'shadow-[inset_0_-1px_0_var(--bg-base)]',
              'border-b border-[var(--rule-soft)]',
              !isActive && 'hover:bg-[var(--bg-elev)]',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--amber)]'
            )}
          >
            {isActive && (
              <span
                aria-hidden
                className="absolute left-0 top-0 bottom-0 right-[-1px] bg-[var(--bg-base)]"
              />
            )}
            {isActive && (
              <span
                aria-hidden
                className="absolute left-0 top-0 bottom-0 w-[2px] bg-[var(--amber)] shadow-[0_0_4px_var(--amber-glow)]"
              />
            )}
            <span
              className={cn(
                'activity-rail-icon relative',
                isActive
                  ? 'text-[var(--amber)]'
                  : 'text-[var(--text-rack-mute)] group-hover:text-[var(--text-rack-data)]'
              )}
            >
              <PluginRailIcon pluginId={view.pluginId} viewId={view.id} />
            </span>
          </button>
        )
      })}
      </div>

      {/* 轨底工具槽组 -- MCP 活动槽(McpActivityRailSlot 自带 mt-auto 整组推底) + 设置槽。
          MCP 槽非页签(切换 pane 覆盖层而非导航),置于设置槽上方;组内两槽间以
          MCP 槽的 border-b + 槽内 inset bg-base 凹线做卡笼分隔,与上面内容页签的
          槽间横条同读数(单 hairline 在条带上读不出,McpActivityRailSlot 处有注);
          MCP 槽上缘同款凹槽把工具槽组与上方空条带分开(用户校准)。 */}
      <McpActivityRailSlot />

      {/* settings 工具槽 -- 轨底最末位;无 LED。
          active 语言与内容槽一致:bg-base 窗口 + amber 左条,读作"打开中的工具页签"。 */}
      <button
        type="button"
        role="tab"
        aria-selected={active === 'settings'}
        aria-label={labelFor('settings')}
        title={labelFor('settings')}
        onClick={() => onChange('settings')}
        className={cn(
          'relative h-[40px] flex items-center justify-center transition-colors group',
          // 激活窗口画在下方独立 span 上(bg-base,越 border-r 1px 盖墙);非激活透明坐条带,悬停抬一档
          active !== 'settings' && 'hover:bg-[var(--bg-elev)]',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--amber)]'
        )}
      >
        {active === 'settings' && (
          <span
            aria-hidden
            className="absolute left-0 top-0 bottom-0 right-[-1px] bg-[var(--bg-base)]"
          />
        )}
        {active === 'settings' && (
          <span
            aria-hidden
            className="absolute left-0 top-0 bottom-0 w-[2px] bg-[var(--amber)] shadow-[0_0_4px_var(--amber-glow)]"
          />
        )}
        <span
          className={cn(
            // relative:同内容槽 -- 不定位会被窗口 span(绝对定位层)盖住
            'activity-rail-icon relative',
            active === 'settings'
              ? 'text-[var(--amber)]'
              // 静息 tab-idle / 悬停 rack:同内容页签槽的未选中读数亮度档(见上)
              : 'text-[var(--text-tab-idle)] group-hover:text-[var(--text-rack)]'
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
