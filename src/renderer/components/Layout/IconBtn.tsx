import React from 'react'
import cn from 'classnames'

/**
 * 头条图标钮 —— 会话/Agent/变量组/Harness/插件五处头条共用的一枚：
 * 24px 无框、mute 面、悬停 slot 面；amber 档悬停琥珀字（各面板「新建 +」
 * 入口的标准形态）。原先是 SessionsPanel 的本地组件，五处统一后抽出防样式漂移。
 * 可选档（默认不传即五处头条的原形态）：size lg = 28px 面、bright = 白面
 * （比 --text-rack 再亮一档，#E4E7EA → #FFF）—— Web 栏铭牌行的导航/清空
 * 簇用（按钮簇是那行的主体操作）。
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
  /** 字面常亮 —— 白面 + currentColor 辉光(默认 mute 面):按钮簇是行内主体
   *  操作的面板用,静息即可读;白已顶满色阶,再亮走 .icon-bright-glow 光晕
   *  (globals.css,悬停随 currentColor 变琥珀),悬停提亮只走 bg-slot 一档。
   *  浅色主题下白面在浅底上不可读,CSS 侧回落 --text-rack 深墨面(见该节) */
  bright?: boolean
  children: React.ReactNode
}> = ({ onClick, title, amber, disabled, size = 'md', bright, children }) => (
  <button
    onClick={onClick}
    title={title}
    disabled={disabled}
    className={cn(
      'win-no-drag flex items-center justify-center bg-transparent border-none rounded-[3px] cursor-pointer transition-colors disabled:opacity-50',
      size === 'lg' ? 'w-[28px] h-[28px]' : 'w-[24px] h-[24px]',
      bright ? 'icon-bright-glow text-white' : 'text-[var(--text-rack-mute)]',
      'hover:bg-[var(--bg-slot)]',
      amber ? 'hover:text-[var(--amber)]' : bright ? 'hover:text-white' : 'hover:text-[var(--text-rack)]'
    )}
  >
    {children}
  </button>
)

/** 14px 方角 + 字形 —— 「新建」入口的标准加号，与 IconBtn 配对使用 */
export const IconPlus: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square"><path d="M7 2v10M2 7h10" /></svg>
)
