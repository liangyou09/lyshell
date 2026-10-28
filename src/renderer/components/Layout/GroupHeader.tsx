import React from 'react'
import cn from 'classnames'
import { ScrollTie } from './ScrollFold'

/** 段身份 tone 令牌 —— 会话墙的七色 + 工作区目录墙的四色(agents 青紫/claude 青橙/
    codex 青白/dsh 青花,seg-* tokens;四面互斥不同屏,一墙一色)。Env/Plugins
    是平铺纸面列表，没有可折叠组头。HarnessPanel/AgentsPanel 的目录组头跨面板
    复用本组件,故 tone 联合在此归一 */
export type GroupHeaderTone =
  | 'amber' | 'pin' | 'live' | 'reach' | 'serial' | 'local' | 'subnet'
  | 'seg-violet' | 'seg-orange' | 'seg-qingbai' | 'seg-qinghua'

export const GroupHeader: React.FC<{
  label: string
  count: number
  /** 段身份色:live=绿 / pin=置顶金 / serial=串口橙 / local=本地紫 / subnet=网段胭脂 /
      reach=可达;seg-* = 工作区目录组四面段身份(青紫/青橙/青白/青花);
      undefined = 中性兜底(现行调用方都带 tone,卷轴身份全归一) */
  tone?: GroupHeaderTone
  /** 长键截断:题签可缩可截(min-w-0 truncate,全名走 title tooltip)—— 目录路径等
      长组键用;默认 flex-shrink-0 不缩(短组键,IP/COM/协议名) */
  truncateLabel?: boolean
  /** 题签 tooltip 覆写:组键与展示名分离时给全名(目录组 basename 作题名、
      路径片段在 detail、全路径在 tooltip);缺省回落 truncateLabel 的「title=label」约定 */
  labelTitle?: string
  /** 目录组等可在题签后补一条较轻的上下文，避免每张卡重复显示相同路径 */
  detail?: string
  /** 同名目录的短序号，单独占位，避免路径截断时一起消失 */
  detailMarker?: string
  /** 可折叠时传入；undefined 表示不可折叠 */
  collapsed?: boolean
  onToggle?: () => void
  /** 右侧可选 action 按钮(LIVE 段的 close-all 用) */
  action?: React.ReactNode
}> = ({ label, count, tone, truncateLabel, collapsed, onToggle, action, labelTitle, detail, detailMarker }) => {
  const collapsible = typeof collapsed === 'boolean' && !!onToggle
  // tone → 语义 token(色值经 style 注入,轴头专用一份;题名已改金墨);serial/local
  // 复用行级 --proto-* 协议色(组内同质,轴头与行同身份),subnet 是段级组
  // 语义(网段/主机名分组的远程会话),独立胭脂 token(与 error 粉红同屏拆值);
  // seg-* 是工作区目录组段身份(Agents/Claude/Codex/Dsh 四面,--seg-* token)
  const toneVar =
    tone === 'pin'        ? 'var(--pin)'        :
    tone === 'amber'      ? 'var(--amber)'      :
    tone === 'live'       ? 'var(--live)'       :
    tone === 'reach'      ? 'var(--reachable)'  :
    tone === 'serial'     ? 'var(--proto-ser)'  :
    tone === 'local'      ? 'var(--proto-loc)'  :
    tone === 'subnet'     ? 'var(--subnet)'     :
    tone === 'seg-violet'  ? 'var(--seg-violet)'  :
    tone === 'seg-orange'  ? 'var(--seg-orange)'  :
    tone === 'seg-qingbai' ? 'var(--seg-qingbai)' :
    tone === 'seg-qinghua' ? 'var(--seg-qinghua)' : undefined
  return (
    <div
      onClick={collapsible ? onToggle : undefined}
      role={collapsible ? 'button' : undefined}
      tabIndex={collapsible ? 0 : undefined}
      aria-expanded={collapsible ? !collapsed : undefined}
      onKeyDown={collapsible ? (e: React.KeyboardEvent) => {
        // 键盘开合:折叠内容被 ScrollFold inert 挡在 Tab 序外,键盘用户只能
        // 从这里展开。target 不在自己身上不接 —— 行内 action(如 LIVE 段的
        // close-all)聚焦时按 Enter,keydown 冒泡上来不能误触整行折叠
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle?.() }
      } : undefined}
      className={cn(
        'relative flex items-center gap-2.5 pl-3 pr-[20px] text-[10px] text-[var(--text-rack-mute)]',
        // 行内垫:可折叠(有辊)时对称垫 —— 辊在栏内垂直居中,内容线与辊同
        // 心、贴印在辊上(非对称垫会把内容压离辊心,甚至跨出辊面);不可折叠
        // 无辊,常规对称垫。垫随辊收细(2026/09/20 辊 20→16,py 5→3):行高
        // = 内容行盒 + 2×py,不随辊径自动走 —— 只收辊不收垫,省下的辊径会
        // 变成辊周多出的透明空气(栏本体无底,这圈空气就是画轴下方那块透
        // 明长方形),整条栏读感不变细;py 跟辊同收,空气恒 ~3px、行矮 4px,
        // 栏才真的细。右垫加厚到 20px:右轴头占行缘内 6-12px,内容
        // 右缘(计数/action)与其隔 8px 空气 —— 数字不贴着轴头
        collapsible ? 'py-[3px]' : 'py-2',
        // 折叠栏 = 卷轴的辊位(scroll-head):装配盒恒高 16px，轴头居中。
        // 收起(rolled)时纸裹轴成 16px 满卷，题名贴在卷面上；展开后露出
        // 8px 木杆，题名落在杆下的纸面上。CSS 的 ::before 与下方
        // paper-sheet 同宽同材质，连成一张纸，题名和画心不会分离。
        // typography + flex-1 hairline 仍是栏内分隔。
        // 可折叠时这道缝由辊与纸跨缝相接自己拴成,不画 border-b(硬线会把
        // 辊与纸切成两物);不可折叠的栏没有辊,border-b 回落为普通分组线
        'scroll-head',
        tone && `tone-${tone}`,
        !collapsible && 'border-b border-[var(--rule-soft)]',
        // group 供系绳(ScrollTie)悬停提亮 —— 栏不铺 hover 底色(矩形连
        // hover 也不出现),指针 + 绳的提亮就是全部悬停反馈
        collapsible && 'group cursor-pointer',
        collapsible && collapsed && 'rolled'
      )}
    >
      {/* 卷轴辊 —— .rod-caps 的装配盒恒高 16px，展开露出细木杆，收起纸裹轴。
          两端 12px 木轴头居中，身份色仅落在窄轴肩与系绳；具体形制由 CSS 绘制。 */}
      {collapsible && (
        <span aria-hidden className="rod-caps" style={toneVar ? { color: toneVar } : undefined}>
          <span className="scroll-rod-collar scroll-rod-collar-l" />
          <span className="scroll-rod-collar scroll-rod-collar-r" />
        </span>
      )}
      {collapsible && (
        <span
          // 蝴蝶结记号(ScrollTie):收起(rolled)时绳在满卷上系成蝴蝶结
          // (纸自下方卷回,绳随纸自下方荡上绑紧 + 自由端各拍微摆),展开后
          // 纸向下垂落、结解开、绳跟着纸向下飘落淡出 —— 槽位恒占防行首跳动,
          // 节拍在 globals.css 的 .scroll-tie。
          // 绳色随轴头(toneVar inline 注入 —— 拴卷的绳与卷两端的轴头同
          // 色,同一件物的两处署名),无 tone 回落中性 mute;行悬停提亮走
          // opacity 一档(inline color 压过 class,hover 变色类只在无 tone
          // 时生效)—— 去 hover 底色后,绳的提亮就是指针外唯一的悬停反馈
          className={cn('inline-flex transition text-[var(--text-rack-mute)] group-hover:text-[var(--text-rack)] opacity-80 group-hover:opacity-100')}
          style={toneVar ? { color: toneVar } : undefined}
        >
          <ScrollTie group />
        </span>
      )}
      {/* 题签(scroll-slip)—— 折叠栏题名:书体(Cambria 铭刻衬线 / 隶书)
          与金墨都在 globals.css;题名全栏一只金(置顶金同源;亮色主题反
          转银枪,暗金亮银)—— 段身份仍读轴头,题名只读一墨;COM/local
          组键走手书大写(scroll-slip-hand);收起时这行字落在纸卷面上,
          就是卷上题签。长键(truncateLabel)可缩可截,全名走 title
          (目录路径等 —— 行内 URL 同一约定;labelTitle 覆写 —— 目录组
          basename 作题名、路径片段进 detail、全路径进 tooltip) */}
      <span
        title={labelTitle ?? label}
        className={cn(
          'scroll-slip text-[13px]',
          detail ? 'max-w-[45%] shrink-0 truncate' : truncateLabel ? 'min-w-0 truncate' : 'flex-shrink-0',
          (tone === 'serial' || tone === 'local') && 'scroll-slip-hand'
        )}
      >
        {label}
      </span>
      {detailMarker && (
        <span title={labelTitle ?? detail} className="shrink-0 [font-family:inherit] text-[10px] tabular-nums text-[var(--text-rack-mute)]">
          {detailMarker}
        </span>
      )}
      {detail ? (
        <span title={labelTitle ?? detail} className="min-w-0 flex-1 truncate [font-family:inherit] text-[10px] text-[var(--text-rack-mute)]">
          {detail}
        </span>
      ) : (
        <span aria-hidden className="flex-1 h-px bg-[var(--rule)]" />
      )}
      <span className="scroll-count [font-family:inherit] text-[11px] text-[var(--text-rack-data)] tracking-[.04em] normal-case">{count}</span>
      {action}
    </div>
  )
}
