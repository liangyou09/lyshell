import React from 'react'
import cn from 'classnames'
import { useTranslation } from 'react-i18next'
import DeepSeekWhaleIcon from './DeepSeekWhaleIcon'
import { McpActivityRailSlot } from './McpActivityRailSlot'
import { TOPBAR_HEIGHT } from './topbar-metrics'

/**
 * 左侧机柜竖版页签轨 -- 把"会话 / Agent / 插件"三权并立成等高的机柜卡槽。
 *
 * 视觉语言:浏览器式页签条 -- 页签笼整体染 bg-slot 成"条带"(chrome 材质,与
 * bg-base 面板底拉开一步;暗主题条带亮于页面、亮主题条带灰于页面,同浏览器
 * chrome/页面的材质分工),激活槽是条带上挖出的"窗口":bg-base 与面板同一面
 * 材质,右缘直角越过 border-r 竖线把它整个盖掉,窗口与面板之间无墙、同色
 * 无缝,读作浏览器激活页签与页面连成一片。窗口材质 = 面板"卡片区域外"的框体
 * 底:激活槽读作管理框本体的一部分,与面板里的卡片(bg-rack 底 + 文字行)是
 * 两个物种。选中显著性 = 条带/窗口对比 + amber 左边条 + amber 图标;槽间用
 * inset 凹陷阴影做卡笼分隔。
 * 这是本组件的 signature -- 导航读作机柜页签条,而非通用图标条。
 *
 * 轨顶第一槽是左列收起控位(非页签):与收起态终端列左上的展开 pill 构成同一开关的
 * 两个形态 -- 开关永远停在窗口左上角,展开时是本槽,收起时是 pill,150ms 交叉淡变。
 * 槽高读 TOPBAR_HEIGHT,与终端第一行页签条齐平。
 */
export type NavTab = 'sessions' | 'agents' | 'dsh' | 'codex' | 'claude' | 'env' | 'plugins' | 'web' | 'settings'

// 内容页签(上组):会话 / Agent / DeepSeek Harness / Codex / Claude / 变量组 / 插件 / 网页。
// env 是三个 harness 与通用 Agent 共享的全局变量组库,排在启动面(sessions..claude)之后、
// 资源组(plugins/web)之首。settings 是轨底独立工具槽,不在此列。
const ALL_TABS: NavTab[] = ['sessions', 'agents', 'dsh', 'codex', 'claude', 'env', 'plugins', 'web']
const TABS: NavTab[] = ALL_TABS

/** 轨宽(px) -- 单一真相源:本组件容器宽与 MainWindow 宽度拖拽算式共用,防两处漂移 */
export const RAIL_WIDTH = 44

// ─────────────────────────────────────────────────────────────────────────────
// 图标 -- 24px 渲染,线宽三档:20-box sw1.4(放大 1.2x,有效 ~1.68)为轨上基准;
// agents 短划单独 1.6(有效 ~1.92),24-box/28-box 款(env/web/设置)sw1.7 对齐有效线宽。
// cap:直线族 square,有机形态(写轮眼/齿轮)round —— 明细见各图标注释
// ─────────────────────────────────────────────────────────────────────────────

/** 会话 = 叠屏(后屏错位叠放,前屏两行内容)。
 *  「多开」语义直给:错位读出层次,前屏两行读作活跃会话;
 *  square cap 同轨上直线图标语言(前版机柜塔只有「机柜」没有「管理」,已换)。 */
const IconSessions: React.FC = () => (
  <svg width="24" height="24" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" strokeLinejoin="miter">
    <rect x="4" y="3.5" width="10" height="8" />
    <rect x="6" y="8.5" width="10" height="8" />
    <path d="M9 12.2h4" />
    <path d="M9 14.6h4" />
  </svg>
)

/** Agent = HUD 括号核(四角括号锁定 + 中心实心菱形核,「瞄准中的智能体」)。
 *  科技/HUD 语汇,「锁定中的焦点」读作 Agent 在场;square cap 同轨上直线图标语言。
 *  strokeWidth 1.6 略重于轨上 1.4 基准(有效 ~1.92):括号是短划,需要一档
 *  份量才在 24px 下读出 HUD 描边的存在感。 */
const IconAgents: React.FC = () => (
  <svg width="24" height="24" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" strokeLinejoin="miter">
    <path d="M3.5 6.8 V3.5 h3.3 M13.2 3.5 h3.3 v3.3 M16.5 13.2 v3.3 h-3.3 M6.8 16.5 H3.5 v-3.3" />
    <path d="M10 6.8 L12.4 10 L10 13.2 L7.6 10 Z" fill="currentColor" stroke="none" />
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

/** 变量组 = ENV 印章 —— 横幅满框,字标居中,读作机柜资产的钢印/模板标牌。
 *  28×24 横幅画布(strokeWidth 1.7 同 24-box 有效线宽惯例):字标天生横长,
 *  24 方画布里可读字号的墨迹缝顶死 ~2.7(字一收就回嫌小的档),拉开字与框的
 *  空气只能给字标配横长版式 —— 轨上唯一非方图标是刻意的(字标 ≠ 图形)。
 *  方框 25.7x21.7 外缘 0.3..27.7 / 0.3..23.7(视觉 27.4x23.4 横牌),字标 9.4 居中,
 *  左右墨迹缝各 ~4.4,上下留白读作印章版心的空气。字标 x/y 按栅格化墨迹实测
 *  居中(em 盒量不到字齿;ppem 取整随字号漂移,改字号必重标定)。
 *  (前几版弃:无框 ENV 在轨槽里轮廓发虚;花括号 { ENV } 欠直白。)
 *  mono 栈呼应 shell 语汇;框用 square cap 直线族语言,静息时框先于字读出。 */
const IconEnv: React.FC = () => (
  <svg width="28" height="24" viewBox="0 0 28 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="square" strokeLinejoin="miter">
    <rect x="1.15" y="1.15" width="25.7" height="21.7" />
    <text x="14" y="11.8" textAnchor="middle" dominantBaseline="central" fill="currentColor" stroke="none" fontSize="9.4" fontWeight="700" letterSpacing="0.15" fontFamily='ui-monospace, "JetBrains Mono", "Cascadia Code", Consolas, monospace'>ENV</text>
  </svg>
)

/** 插件 = 方块阵(三方块 + 第 4 块旋转 45°「转体入位」)。
 *  几何冷静,「入位」那一下读作安装;square cap 同轨上直线图标语言。 */
const IconPlugins: React.FC = () => (
  <svg width="24" height="24" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square" strokeLinejoin="miter">
    <rect x="3" y="3" width="6.4" height="6.4" />
    <rect x="10.6" y="3" width="6.4" height="6.4" />
    <rect x="3" y="10.6" width="6.4" height="6.4" />
    <rect x="10.9" y="10.9" width="5.8" height="5.8" transform="rotate(45 13.8 13.8)" />
  </svg>
)

/** 网页 = 写轮眼·实心勾玉(眼 = 浏览/观看,Web 面板就是内嵌浏览器)。
 *  24×24 viewBox 满框(同设置齿轮的 24-box 惯例,strokeWidth 1.7 对齐有效线宽):
 *  眼眶 r11 外缘 11.85,视觉直径 ~23.7px,是 24px 元素内的极限;
 *  瞳孔 + 三枚实心蝌蚪勾玉(120° 旋转对称,头部起宽、沿轨道收尖、向瞳孔内钩)。 */
const IconWeb: React.FC = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="11" />
    <circle cx="12" cy="12" r="2.68" fill="currentColor" stroke="none" />
    <g>
      <circle cx="12" cy="5.17" r="2.27" fill="currentColor" stroke="none" />
      <path d="M10.13 3.86 Q7.67 5.14 6.89 9.07 Q9.51 8.88 10.85 7.15 Z" fill="currentColor" stroke="none" />
    </g>
    <g transform="rotate(120 12 12)">
      <circle cx="12" cy="5.17" r="2.27" fill="currentColor" stroke="none" />
      <path d="M10.13 3.86 Q7.67 5.14 6.89 9.07 Q9.51 8.88 10.85 7.15 Z" fill="currentColor" stroke="none" />
    </g>
    <g transform="rotate(240 12 12)">
      <circle cx="12" cy="5.17" r="2.27" fill="currentColor" stroke="none" />
      <path d="M10.13 3.86 Q7.67 5.14 6.89 9.07 Q9.51 8.88 10.85 7.15 Z" fill="currentColor" stroke="none" />
    </g>
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
  env: IconEnv,
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
              : tab === 'env' ? t('nav.env')
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
          整行读作无分割的一条横带;下方内容页签取 40 行高 -- 第一行 36 是跨窗
          对齐的 chrome 行高,内容槽给 24px 图标留呼吸(44 过疏 / 36 过挤的折中)。
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
          竖线从第一行以下才开始。笼底整体染 bg-slot 成页签"条带"(chrome 材质,
          浏览器 chrome/页面的分工),激活槽的 bg-base 窗口在条带上挖出、与面板
          同面无缝(见各槽位 span)。tablist 也落在这层:笼里全是真页签,收起控件不混入 */}
      <div
        className="flex flex-col flex-1 border-r border-[var(--rule)] bg-[var(--bg-slot)]"
        role="tablist"
        aria-orientation="vertical"
      >
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
                'relative transition-[color,transform] duration-200 ease-out group-hover:scale-110',
                isActive
                  // 品牌位 + 写轮眼 web 激活变白(开眼),不亮 amber、不挂辉光
                  ? (tab === 'dsh' || tab === 'codex' || tab === 'claude' || tab === 'web')
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
            'relative transition-[color,transform] duration-200 ease-out group-hover:scale-110',
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
