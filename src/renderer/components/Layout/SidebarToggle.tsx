import React from 'react'
import { useTranslation } from 'react-i18next'
import './SidebarToggle.css'

interface SidebarToggleProps {
  collapsed: boolean
  onClick: () => void
  tabIndex?: number
}

/** 两种状态共用侧栏轮廓，仅反转箭头，保持控位和视觉重量一致。 */
const SidebarToggle: React.FC<SidebarToggleProps> = ({ collapsed, onClick, tabIndex }) => {
  const { t } = useTranslation()
  const label = t(collapsed ? 'settings.expandSidebar' : 'settings.collapseSidebar')

  return (
    <button
      type="button"
      className="sidebar-toggle win-no-drag"
      onClick={(event) => {
        onClick()
        // 键盘开合后把焦点交给另一状态的按钮，避免落进已隐藏的侧栏。
        if (event.detail === 0) {
          requestAnimationFrame(() => {
            document.querySelector<HTMLButtonElement>(
              `.sidebar-toggle[data-collapsed="${!collapsed}"]`
            )?.focus()
          })
        }
      }}
      tabIndex={tabIndex}
      title={label}
      aria-label={label}
      aria-expanded={!collapsed}
      aria-controls="workspace-sidebar"
      data-collapsed={collapsed}
    >
      <span className="sidebar-toggle-face" aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4.5" width="18" height="15" rx="2" />
          <path d="M8.5 4.5v15" opacity=".65" />
          <path className="sidebar-toggle-arrow" d={collapsed ? 'm13 9 3 3-3 3' : 'm16 9-3 3 3 3'} />
        </svg>
      </span>
    </button>
  )
}

export default SidebarToggle
