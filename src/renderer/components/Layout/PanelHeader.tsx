import React, { useRef, useState } from 'react'
import { useDismiss } from '@/hooks/useDismiss'
import { TOPBAR_HEIGHT } from './topbar-metrics'
import { IconPlus } from './IconBtn'
import './PanelHeader.css'

// 复用窗口与安装包的品牌图标，避免标题栏另存一份后随版本漂移。
const lyShellIcon = new URL('../../../../resources/icons/icon-windows.png', import.meta.url).href

interface PanelHeaderProps {
  title: string
  count?: number
  countHint?: string
  detail?: string
  actions?: React.ReactNode
  onTitleClick?: () => void
  titleHint?: string
  titleDisabled?: boolean
}

/** 统一面板首行：名称、数量读数与主操作；空白处仍可拖动窗口。 */
export const PanelHeader: React.FC<PanelHeaderProps> = ({
  title, count, countHint, detail, actions, onTitleClick, titleHint, titleDisabled
}) => (
  <header className="panel-header win-drag" style={{ height: TOPBAR_HEIGHT }}>
    <div className="panel-header-nameplate">
      <img className="panel-header-brand" src={lyShellIcon} alt="" aria-hidden draggable={false} />
      {onTitleClick ? (
        <button
          type="button"
          className="panel-header-title panel-header-title-button win-no-drag"
          onClick={onTitleClick}
          title={titleHint ?? title}
          disabled={titleDisabled}
        >
          {title}
        </button>
      ) : <h2 className="panel-header-title" title={title}>{title}</h2>}
      {count !== undefined && <span className="panel-header-count" title={countHint} aria-label={countHint ? `${countHint}: ${count}` : undefined}>{count}</span>}
    </div>
    {detail && <span className="panel-header-detail" title={detail}>{detail}</span>}
    {actions && <div className="panel-header-actions win-no-drag">{actions}</div>}
  </header>
)

/** 主操作用短文字提高可发现性，完整动作名保留在 tooltip 与无障碍名称中。 */
export const PanelHeaderAction: React.FC<{
  label: string
  title: string
  onClick: () => void
  disabled?: boolean
}> = ({ label, title, onClick, disabled }) => (
  <button
    type="button"
    className="panel-header-primary win-no-drag"
    title={title}
    aria-label={title}
    onClick={onClick}
    disabled={disabled}
  >
    <span aria-hidden><IconPlus /></span>
    <span className="panel-header-action-label">{label}</span>
  </button>
)

/** 次操作共享外点与 ESC 收层栈，避免菜单干扰后续对话框。 */
export const PanelHeaderMenu: React.FC<{
  title: string
  items: Array<{ label: string; onClick: () => void; disabled?: boolean }>
}> = ({ title, items }) => {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const close = () => {
    setOpen(false)
    if (rootRef.current?.contains(document.activeElement)) triggerRef.current?.focus()
  }
  useDismiss(open, close, [rootRef])
  return (
    <div ref={rootRef} className="panel-header-menu win-no-drag">
      <button ref={triggerRef} type="button" className="panel-header-menu-trigger" title={title} aria-label={title} aria-expanded={open} onClick={() => setOpen(value => !value)}>···</button>
      {open && <div className="panel-header-menu-items">
        {items.map(item => <button key={item.label} type="button" disabled={item.disabled} onClick={() => { close(); item.onClick() }}>{item.label}</button>)}
      </div>}
    </div>
  )
}
