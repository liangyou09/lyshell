import React from 'react'
import cn from 'classnames'

/**
 * 头条图标钮 —— 会话/Agent/变量组/Harness/插件五处头条共用的一枚：
 * 24px 无框、tab-idle 面(页签静息字同款混档 -- 原走 mute,用户校准嫌暗,
 * 与轨上未选中图标一起提到该档,见 ActivityRail docstring 的「未选中 chrome」
 * 同亮说明)、悬停 slot 面;amber 档悬停琥珀字（各面板「新建 +」
 * 入口的标准形态）。原先是 SessionsPanel 的本地组件，五处统一后抽出防样式漂移。
 * 可选档：size lg = 28px 面；bright 使用主题前景与按钮底色，轮廓保持清晰，
 * 供 Web 栏铭牌行的导航/清空簇使用。
 * 头条整行挂 win-drag 做窗口拖拽区（见 topbar-metrics 的 TOPBAR_GRIP_WIDTH 注），
 * 按钮须显式 win-no-drag 脱离拖拽区，否则点击被 drag 区吞掉。
 */
export const IconBtn: React.FC<{
  onClick?: () => void
  title?: string
  amber?: boolean
  disabled?: boolean
  /** 尺寸档 —— lg = 28px 面(默认 md 24px):Web 栏铭牌行的导航/清空簇用,
   *  按钮簇是那行的主体操作,面提大一档(TOPBAR_HEIGHT 36 装得下,上下各留 4) */
  size?: 'md' | 'lg'
  /** 主操作档：主题前景、实色按钮底与细边框；不叠加模糊光晕。 */
  bright?: boolean
  children: React.ReactNode
}> = ({ onClick, title, amber, disabled, size = 'md', bright, children }) => (
  <button
    type="button"
    onClick={onClick}
    title={title}
    aria-label={title}
    disabled={disabled}
    className={cn(
      'win-no-drag flex-shrink-0 flex items-center justify-center rounded-[3px] cursor-pointer transition-colors disabled:cursor-default focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--amber)]',
      size === 'lg' ? 'w-[28px] h-[28px]' : 'w-[24px] h-[24px]',
      bright
        ? 'border border-solid border-[var(--rule)] bg-[var(--bg-slot)] text-[var(--text-rack)] enabled:hover:bg-[var(--bg-elev)] disabled:bg-transparent disabled:border-transparent disabled:opacity-50'
        : 'bg-transparent border-none text-[var(--text-tab-idle)] hover:bg-[var(--bg-slot)] disabled:opacity-50',
      amber ? 'enabled:hover:text-[var(--amber)]' : 'enabled:hover:text-[var(--text-rack)]'
    )}
  >
    {children}
  </button>
)

/** 14px 方角 + 字形 —— 「新建」入口的标准加号，与 IconBtn 配对使用 */
export const IconPlus: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square"><path d="M7 2v10M2 7h10" /></svg>
)
