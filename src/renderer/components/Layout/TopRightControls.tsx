import React, { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { TOPBAR_HEIGHT } from './topbar-metrics'
import './TopRightControls.css'

export interface TopRightControlsProps {
  isMaximized: boolean
  onMinimize: () => void
  onMaximize: () => void
  onClose: () => void
}

/**
 * 窗口第一行右侧控制簇；会话、任务和提醒统一收进任务侧栏。
 * 工具键统一为透明底按钮，静息字面与同行页签同档。
 * (MCP 活动状态片曾在此,现移至左侧 ActivityRail 轨底设置槽上方 -- McpActivityRailSlot)
 *
 * 页签条提顶后本簇悬浮在第一行最右上 pane 的页签条上方(absolute,带 bg-rack 底色
 * 遮住下层);对应页签条以 --top-right-reserve 做右留白防页签滚入簇下方 --
 * 该变量由本组件实测自身宽发布(见下方 effect),增删按钮时页签条留白始终刚好。
 */
const TopRightControls: React.FC<TopRightControlsProps> = ({
  isMaximized,
  onMinimize,
  onMaximize,
  onClose
}) => {
  const { t } = useTranslation()
  const rootRef = useRef<HTMLDivElement>(null)

  // 实测本簇宽度发布到 :root 的 --top-right-reserve，保留实测链路:后续增删按钮
  // 无需同步改常量,ResizeObserver 自动跟进
  useEffect(() => {
    // 测试环境(jsdom)无 ResizeObserver,保留 globals.css 的 130px 兜底值
    if (typeof ResizeObserver === 'undefined') return
    const el = rootRef.current
    if (!el) return
    const publish = () => {
      document.documentElement.style.setProperty('--top-right-reserve', `${Math.ceil(el.offsetWidth)}px`)
    }
    publish()
    const ro = new ResizeObserver(publish)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div
      ref={rootRef}
      className="top-right-controls win-no-drag"
      style={{ height: TOPBAR_HEIGHT }}
    >
      {/* 系统窗口控制簇 */}
      <div className="window-control-group">
        {/* 缩小 */}
        <button
          type="button"
          onClick={onMinimize}
          className="window-control"
          title={t('settings.minimize')}
          aria-label={t('settings.minimize')}
        >
          <span aria-hidden className="window-control-minimize" />
        </button>
        {/* 放大 */}
        <button
          type="button"
          onClick={onMaximize}
          className="window-control"
          title={isMaximized ? t('settings.restore') : t('settings.maximize')}
          aria-label={isMaximized ? t('settings.restore') : t('settings.maximize')}
        >
          {isMaximized ? (
            <svg aria-hidden width="14" height="14" viewBox="0 0 18 18" fill="none">
              <rect x="3" y="7" width="8" height="8" stroke="currentColor" strokeWidth="1.5" />
              <path d="M7 3H15V11" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          ) : (
            <svg aria-hidden width="14" height="14" viewBox="0 0 18 18" fill="none">
              <rect x="3" y="3" width="12" height="12" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          )}
        </button>
        {/* 关闭 */}
        <button
          type="button"
          onClick={onClose}
          className="window-control window-control-close"
          title={t('settings.close')}
          aria-label={t('settings.close')}
        >
          <span aria-hidden className="window-control-close-mark" />
        </button>
      </div>
    </div>
  )
}

export default TopRightControls
