import React, { useEffect, useRef } from 'react'
import cn from 'classnames'
import { useTranslation } from 'react-i18next'
import { McpActivityChip } from './McpActivityChip'
import { TOPBAR_HEIGHT } from './topbar-metrics'

export interface TopRightControlsProps {
  isMaximized: boolean
  onMinimize: () => void
  onMaximize: () => void
  onClose: () => void
  /** 浮窗是否可见 -- 浮窗按钮的激活态 */
  floatVisible: boolean
  onToggleFloat: () => void
}

/**
 * 窗口第一行右侧控制簇 -- 原自定义标题栏右侧按钮组的整块搬迁
 * (MCP 状态片 + 浮窗按钮 │ hairline │ ─ □ ✕),样式零改动。
 *
 * 页签条提顶后本簇悬浮在第一行最右上 pane 的页签条上方(absolute,带 bg-rack 底色
 * 遮住下层);对应页签条以 --top-right-reserve 做右留白防页签滚入簇下方 --
 * 该变量由本组件实测自身宽发布(见下方 effect),随 chip 文案伸缩,页签条留白始终刚好。
 */
const TopRightControls: React.FC<TopRightControlsProps> = ({
  isMaximized,
  onMinimize,
  onMaximize,
  onClose,
  floatVisible,
  onToggleFloat
}) => {
  const { t } = useTranslation()
  const rootRef = useRef<HTMLDivElement>(null)

  // 实测本簇宽度发布到 :root 的 --top-right-reserve -- chip 文案随语言(zh/en)与审计
  // 条数变宽,静态常量两头不讨好:常态 ~150px 浪费留白,en 最坏 ~265px 又盖不住。
  // 实测随内容伸缩,语言切换/计数增长时 ResizeObserver 自动跟进
  useEffect(() => {
    // 测试环境(jsdom)无 ResizeObserver,保留 globals.css 的 252px 兜底值
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
      className="win-no-drag flex items-center pl-1 pr-1 bg-[var(--bg-rack)] select-none"
      style={{ height: TOPBAR_HEIGHT }}
    >
      {/* 应用控制簇 */}
      <div className="flex items-center gap-[2px]">
        {/* MCP 活动状态片 -- 浮窗键左边；从设置页 MCP tab 提升出来，随时可达。
            圆点(amber=最近有活动/灰=空闲)+标签+记录条数，点击打开 MCP 活动面板(ESC 可关) */}
        <McpActivityChip />
        {/* 浮窗按钮 — 两矩形错位，PIP/分窗形态 */}
        <div
          onClick={onToggleFloat}
          className={cn(
            'w-[24px] h-[24px] flex items-center justify-center rounded-[2px] cursor-pointer group transition-colors',
            floatVisible
              ? 'bg-[var(--bg-elev)]'
              : 'bg-[var(--bg-slot)] hover:bg-[var(--bg-elev)]'
          )}
          title={t('settings.floatWindow')}
        >
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
            <rect x="1" y="2.5" width="9" height="7" stroke="currentColor" strokeWidth="1.3"
              className={cn(floatVisible ? 'text-[var(--amber)]' : 'text-[var(--text-rack-mute)] group-hover:text-[var(--text-rack)]', 'transition-colors')} />
            <rect x="5.5" y="6" width="7.5" height="6" fill="currentColor"
              className={cn(floatVisible ? 'text-[var(--amber)]' : 'text-[var(--text-rack-mute)] group-hover:text-[var(--text-rack)]', 'transition-colors')} />
          </svg>
        </div>
      </div>

      {/* 簇分隔 hairline */}
      <span aria-hidden className="w-px h-[14px] bg-[var(--rule)] mx-1.5" />

      {/* 系统窗口控制簇 */}
      <div className="flex items-center gap-[2px]">
        {/* 缩小 */}
        <div
          onClick={onMinimize}
          className="w-[24px] h-[24px] bg-[var(--bg-slot)] flex items-center justify-center rounded-[2px] hover:bg-[var(--bg-elev)] transition-colors cursor-pointer group"
          title={t('settings.minimize')}
        >
          <span className="text-[var(--text-rack-mute)] text-base leading-none group-hover:text-[var(--text-rack)] transition-colors">─</span>
        </div>
        {/* 放大 */}
        <div
          onClick={onMaximize}
          className="w-[24px] h-[24px] bg-[var(--bg-slot)] flex items-center justify-center rounded-[2px] hover:bg-[var(--bg-elev)] transition-colors cursor-pointer group"
          title={isMaximized ? t('settings.restore') : t('settings.maximize')}
        >
          {isMaximized ? (
            <svg width="14" height="14" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="3" y="7" width="8" height="8" stroke="currentColor" strokeWidth="1.5" fill="none" className="text-[var(--text-rack-mute)] group-hover:text-[var(--text-rack)] transition-colors"/>
              <path d="M7 3H15V11" stroke="currentColor" strokeWidth="1.5" fill="none" className="text-[var(--text-rack-mute)] group-hover:text-[var(--text-rack)] transition-colors"/>
              <path d="M5 11V5H11" stroke="currentColor" strokeWidth="1.5" fill="none" className="text-[var(--text-rack-mute)] group-hover:text-[var(--text-rack)] transition-colors"/>
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="3" y="3" width="12" height="12" stroke="currentColor" strokeWidth="2" fill="none" className="text-[var(--text-rack-mute)] group-hover:text-[var(--text-rack)] transition-colors"/>
            </svg>
          )}
        </div>
        {/* 关闭 */}
        <div
          onClick={onClose}
          className="w-[24px] h-[24px] bg-[var(--bg-slot)] flex items-center justify-center rounded-[2px] hover:bg-[var(--error-rack)] transition-colors cursor-pointer group"
          title={t('settings.close')}
        >
          <span className="text-[var(--text-rack-mute)] text-base leading-none group-hover:text-white transition-colors">✕</span>
        </div>
      </div>
    </div>
  )
}

export default TopRightControls
