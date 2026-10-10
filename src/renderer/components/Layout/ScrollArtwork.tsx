import React from 'react'
import cn from 'classnames'
import ScrollFold, { ScrollTie } from './ScrollFold'

/** 独立单轴；图集由 CSS 九宫格取帧，只有中段拉伸，玉雕两端保持比例。 */
export const ScrollRoller: React.FC<{ rolled?: boolean; className?: string }> = ({ rolled = false, className }) => (
  <span aria-hidden="true" className={cn('scroll-art-roller', rolled && 'is-rolled', className)} />
)

/** 独立宣纸/裱绢，自动跟随所在容器的浅色或深色主题。 */
export const ScrollPaper: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({ className, ...props }) => (
  <div {...props} className={cn('scroll-art-paper', className)} />
)

/** 纯宣纸画心，不带轴体、裱绢或边饰。 */
export const XuanPaper: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({ className, ...props }) => (
  <div {...props} className={cn('scroll-art-xuan', className)} />
)

/** 单轴垂卷沿用分组标题的开合和 inert 规则，标题只用于功能命名。 */
export const SingleScroll: React.FC<{
  open: boolean
  onToggle: () => void
  label: string
  count?: number
  children: React.ReactNode
}> = ({ open, onToggle, label, count, children }) => (
  <div className="scroll-art-single" data-scroll-material="jade">
    <button type="button" className={cn('scroll-head', !open && 'rolled')} aria-label={label} aria-expanded={open} onClick={onToggle}>
      <span aria-hidden="true" className="rod-caps" />
      <span className="scroll-art-single-tie"><ScrollTie group /></span>
      {count !== undefined && <span className="scroll-count">{count}</span>}
    </button>
    <ScrollFold open={open}>
      <ScrollPaper>{children}</ScrollPaper>
    </ScrollFold>
  </div>
)
