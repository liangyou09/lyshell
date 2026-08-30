import React from 'react'
import cn from 'classnames'
import { useTranslation } from 'react-i18next'
import dayjs from 'dayjs'
import type { DocTabEntry } from '@shared/types'
import { refreshDocTab } from './readDoc'
import { useDocZoom, resetDocZoom } from './docZoom'
import { usePanMode, togglePanMode } from './docPan'

/** 文件大小格式化（与 FileTree.formatSize 同款单位表，模块级走 i18n 单例） */
function formatDocSize(bytes: number, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (bytes < 1024) return t('file.fileSizeB', { n: bytes })
  if (bytes < 1024 * 1024) return t('file.fileSizeKB', { n: (bytes / 1024).toFixed(1) })
  if (bytes < 1024 * 1024 * 1024) return t('file.fileSizeMB', { n: (bytes / (1024 * 1024)).toFixed(1) })
  return t('file.fileSizeGB', { n: (bytes / (1024 * 1024 * 1024)).toFixed(1) })
}

/**
 * 文档页签头条 —— prompt 行美学（设计稿）：来源色点 + 路径 + 大小/时间元信息 +
 * 类型 chip + 刷新/关闭。全部走 rack 主题变量，7 主题自动适配。
 */
const DocHeader: React.FC<{ tab: DocTabEntry; onClose: () => void }> = ({ tab, onClose }) => {
  const { t } = useTranslation()
  const zoom = useDocZoom()
  const panMode = usePanMode()
  const meta = [
    formatDocSize(tab.size, t),
    tab.mtime > 0 ? dayjs(tab.mtime).format('YYYY-MM-DD HH:mm') : ''
  ].filter(Boolean).join(' · ')

  return (
    <div className="flex items-center gap-2 px-3 h-8 border-b border-[var(--rule)] bg-[var(--bg-elev)] flex-shrink-0">
      {/* 来源色点：琥珀=远端（会话 amber 语义）、青=本地（与页签点色一致） */}
      <span
        aria-hidden
        title={tab.source === 'remote' ? t('doc.remoteChip') : t('doc.localChip')}
        className={cn(
          'w-[7px] h-[7px] rounded-full flex-shrink-0',
          tab.source === 'remote' ? 'bg-[var(--amber)]' : 'bg-[var(--reachable)]'
        )}
      />
      <span className="text-xs text-[var(--text-rack)] truncate flex-1" title={tab.path}>
        {tab.path}
      </span>
      <span className="text-[10px] text-[var(--text-rack-mute)] flex-shrink-0 whitespace-nowrap">{meta}</span>
      <span className="text-[10px] px-1.5 rounded bg-[var(--bg-slot)] text-[var(--text-rack-mute)] flex-shrink-0 uppercase">
        {tab.kind === 'html' ? 'html' : 'md'}
      </span>
      {/* 缩放指示：Ctrl+滚轮调节后出现，点击复位 100% */}
      {zoom !== 1 && (
        <button
          onClick={resetDocZoom}
          title={t('doc.zoomReset')}
          className="win-no-drag text-[10px] px-1.5 rounded bg-[var(--bg-slot)] text-[var(--text-rack-mute)] hover:text-[var(--text-rack)] flex-shrink-0 tabular-nums transition-colors"
        >
          {Math.round(zoom * 100)}%
        </button>
      )}
      {/* 抓手工具：按住拖动平移文档（超大文档上下左右挪视图） */}
      <button
        onClick={togglePanMode}
        title={t('doc.panToggle')}
        className={cn(
          'win-no-drag w-[18px] h-[18px] flex items-center justify-center text-xs rounded-[2px] transition-colors flex-shrink-0',
          panMode
            ? 'text-[var(--amber)] bg-[var(--bg-slot)]'
            : 'text-[var(--text-rack-mute)] hover:text-[var(--text-rack)] hover:bg-[var(--bg-slot)]'
        )}
      >
        ✥
      </button>
      <button
        onClick={() => void refreshDocTab(tab)}
        title={t('doc.refresh')}
        className="win-no-drag w-[18px] h-[18px] flex items-center justify-center text-xs text-[var(--text-rack-mute)] hover:text-[var(--text-rack)] hover:bg-[var(--bg-slot)] rounded-[2px] transition-colors flex-shrink-0"
      >
        ↻
      </button>
      <button
        onClick={onClose}
        title={t('doc.close')}
        className="win-no-drag w-[18px] h-[18px] flex items-center justify-center text-xs text-[var(--text-rack-mute)] hover:bg-[var(--error-rack)] hover:text-white rounded-[2px] transition-colors flex-shrink-0"
      >
        ✕
      </button>
    </div>
  )
}

export default DocHeader
