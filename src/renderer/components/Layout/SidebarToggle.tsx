import React from 'react'
import { useTranslation } from 'react-i18next'
import './SidebarToggle.css'

// 品牌图标同时作为侧栏开合入口，与窗口和安装包复用同一资产。
const lyShellIcon = new URL('../../../../resources/icons/icon-windows.png', import.meta.url).href

interface SidebarToggleProps {
  collapsed: boolean
  onClick: () => void
  tabIndex?: number
  showBrand?: boolean
}

/** 两种状态共用品牌入口，动作通过提示文字与无障碍状态表达。 */
const SidebarToggle: React.FC<SidebarToggleProps> = ({ collapsed, onClick, tabIndex, showBrand = collapsed }) => {
  const { t } = useTranslation()
  const label = t(collapsed ? 'settings.expandSidebar' : 'settings.collapseSidebar')
  const brandVisible = collapsed && showBrand

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
      data-brand-visible={brandVisible}
    >
      <span className="sidebar-toggle-face" aria-hidden="true">
        <img className="sidebar-toggle-brand" src={lyShellIcon} alt="" draggable={false} />
        {brandVisible && <>
          <span className="sidebar-toggle-wordmark">LyShell</span>
          <span className="sidebar-toggle-version">v{__APP_VERSION__}</span>
        </>}
      </span>
    </button>
  )
}

export default SidebarToggle
