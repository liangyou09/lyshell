import React from 'react'
import cn from 'classnames'

/**
 * 头条图标钮 —— 会话/Agent/变量组/Harness/插件五处头条共用的一枚：
 * 24px 无框、mute 面、悬停 slot 面；amber 档悬停琥珀字（各面板「新建 +」
 * 入口的标准形态）。原先是 SessionsPanel 的本地组件，五处统一后抽出防样式漂移。
 */
export const IconBtn: React.FC<{
  onClick?: () => void
  title?: string
  amber?: boolean
  disabled?: boolean
  children: React.ReactNode
}> = ({ onClick, title, amber, disabled, children }) => (
  <button
    onClick={onClick}
    title={title}
    disabled={disabled}
    className={cn(
      'w-[24px] h-[24px] flex items-center justify-center bg-transparent border-none rounded-[3px] cursor-pointer transition-colors disabled:opacity-50',
      'text-[var(--text-rack-mute)] hover:bg-[var(--bg-slot)]',
      amber ? 'hover:text-[var(--amber)]' : 'hover:text-[var(--text-rack)]'
    )}
  >
    {children}
  </button>
)

/** 14px 方角 + 字形 —— 「新建」入口的标准加号，与 IconBtn 配对使用 */
export const IconPlus: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square"><path d="M7 2v10M2 7h10" /></svg>
)
