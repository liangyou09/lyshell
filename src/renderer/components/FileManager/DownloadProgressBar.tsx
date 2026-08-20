import React, { useState, useEffect } from 'react'
import cn from 'classnames'
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n'

interface DownloadProgress {
  taskId: string
  fileName: string
  progress: number
  transferredSize: number
  fileSize: number
  speed: number
  status: 'downloading' | 'uploading' | 'completed' | 'failed'
  error?: string
  direction: 'download' | 'upload'
  localPath?: string
}

// 格式化速度（用 i18n 单例）
const formatSpeed = (bytesPerSecond: number) => {
  if (bytesPerSecond < 1024) return i18n.t('fileManager.speedB', { n: bytesPerSecond })
  if (bytesPerSecond < 1024 * 1024) return i18n.t('fileManager.speedK', { n: (bytesPerSecond / 1024).toFixed(1) })
  return i18n.t('fileManager.speedM', { n: (bytesPerSecond / (1024 * 1024)).toFixed(1) })
}

// 全局文件名存储（用于进度条显示）
const fileNameStore: Map<string, string> = new Map()
const localPathStore: Map<string, string> = new Map()

export const registerDownloadFileName = (taskId: string, fileName: string, localPath?: string) => {
  fileNameStore.set(taskId, fileName)
  if (localPath) localPathStore.set(taskId, localPath)
}

export const clearAllDownloads = () => {
  fileNameStore.clear()
  localPathStore.clear()
}

export const clearDownload = (taskId: string) => {
  fileNameStore.delete(taskId)
  localPathStore.delete(taskId)
}

/**
 * 传输进度条 — 焊在文件管理器底部的 24px hairline 行
 *  下载中：name ↓ ~/Downloads · 64% · 3.4M/s
 *  上传中：name ↑ /var/log    · 64% · 3.4M/s
 *  完成 / 失败：保留显示，可关闭
 *  无任务：渲染 null
 */
const DownloadProgressBar: React.FC = () => {
  const [downloads, setDownloads] = useState<DownloadProgress[]>([])
  const { t } = useTranslation()

  const removeDownload = (taskId: string) => {
    setDownloads(prev => prev.filter(d => d.taskId !== taskId))
    fileNameStore.delete(taskId)
    localPathStore.delete(taskId)
  }

  // 关闭按钮：活动传输先终止 worker，再移除 UI 行；完成/失败仅移除
  const handleClose = (taskId: string, active: boolean) => {
    if (active) void window.electronAPI.fileCancel(taskId)
    removeDownload(taskId)
  }

  const openFolder = (localPath?: string) => {
    if (localPath) window.electronAPI.openFolder(localPath)
  }

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cleanup = window.electronAPI.onFileProgress((data: any) => {
      if (data.md5Update) return
      if (data.cancelled) {
        removeDownload(data.taskId)
        return
      }

      const taskId = data.taskId
      const fileName = fileNameStore.get(taskId) || t('fileManager.unknownFile')
      const localPath = localPathStore.get(taskId)
      const direction = data.direction || 'download'

      if (data.failed) {
        setDownloads(prev => {
          const existing = prev.find(d => d.taskId === taskId)
          if (existing) {
            return prev.map(d =>
              d.taskId === taskId ? { ...d, status: 'failed', error: data.error } : d
            )
          }
          return [{
            taskId, fileName, progress: 0,
            transferredSize: 0, fileSize: 0, speed: 0,
            status: 'failed', error: data.error, direction, localPath
          }, ...prev]
        })
        fileNameStore.delete(taskId)
        localPathStore.delete(taskId)
      } else if (data.completed) {
        setDownloads(prev => prev.map(d =>
          d.taskId === taskId ? { ...d, status: 'completed', progress: 100, direction, localPath } : d
        ))
        fileNameStore.delete(taskId)
        localPathStore.delete(taskId)
      } else {
        setDownloads(prev => {
          const existing = prev.find(d => d.taskId === taskId)
          if (existing) {
            return prev.map(d =>
              d.taskId === taskId ? {
                ...d, fileName,
                progress: data.progress, transferredSize: data.transferredSize,
                fileSize: data.fileSize, speed: data.speed,
                direction, localPath
              } : d
            )
          }
          return [{
            taskId, fileName,
            progress: data.progress || 0,
            transferredSize: data.transferredSize || 0,
            fileSize: data.fileSize || 0,
            speed: data.speed || 0,
            status: direction === 'upload' ? 'uploading' : 'downloading',
            direction, localPath
          }, ...prev]
        })
      }
    })

    return cleanup
  }, [])

  if (downloads.length === 0) return null

  const current = downloads[0]
  const hasMultiple = downloads.length > 1
  const isActive = current.status === 'downloading' || current.status === 'uploading'
  const arrow = current.direction === 'upload' ? '↑' : '↓'

  const arrowColor =
    current.status === 'failed' ? 'text-[var(--error-rack)]' :
    current.status === 'completed' ? 'text-[var(--live)]' :
    'text-[var(--amber)]'

  const nameColor =
    current.status === 'failed' ? 'text-[var(--error-rack)]' :
    current.status === 'completed' ? 'text-[var(--live)]' :
    'text-[var(--text-rack)]'

  const fillColor =
    current.status === 'failed' ? 'bg-[var(--error-rack)]' :
    current.status === 'completed' ? 'bg-[var(--live)]' :
    'bg-[var(--amber)]'

  return (
    <div className="flex items-center gap-2 px-2.5 py-1 bg-[var(--bg-rack)] border-t border-[var(--rule)] font-mono text-[12px] text-[var(--text-rack-mute)] min-h-[28px]">
      <div className="flex items-center gap-1.5 flex-1 min-w-0">
        <span className={cn('text-[14px] flex-shrink-0', arrowColor)}>{arrow}</span>
        <span className={cn('truncate flex-shrink min-w-0', nameColor)} title={current.fileName}>
          {current.fileName}
        </span>
        {hasMultiple && (
          <span className="text-[var(--text-rack-mute)] flex-shrink-0">+{downloads.length - 1}</span>
        )}
      </div>

      {isActive && (
        <>
          <span aria-hidden className="w-px h-[10px] bg-[var(--rule)] flex-shrink-0" />
          <div className="flex-shrink-0 w-[80px] h-[4px] bg-[var(--bg-elev)] rounded-[1px] overflow-hidden">
            <div className={cn('h-full transition-[width] duration-300', fillColor)} style={{ width: `${current.progress}%` }} />
          </div>
        </>
      )}

      {isActive && (
        <span className={cn('flex-shrink-0 font-medium tracking-[-.02em] min-w-[32px] text-right tabular-nums', nameColor)}>
          {`${current.progress}%`}
        </span>
      )}
      {!isActive && current.status === 'failed' && (
        <span
          className="flex-shrink-0 font-medium tracking-[-.02em] text-[var(--error-rack)] cursor-help"
          title={current.error || t('fileManager.transferFailed')}
        >
          {t('fileManager.err')}
        </span>
      )}
      {/* 完成态：download 时显示主 CTA "reveal"；upload 时只是个静态 done */}
      {!isActive && current.status === 'completed' && current.direction !== 'download' && (
        <span className="flex-shrink-0 font-medium tracking-[-.02em] text-[var(--live)]">{t('fileManager.done')}</span>
      )}

      {isActive && current.fileSize > 0 && (
        <>
          <span aria-hidden className="w-px h-[10px] bg-[var(--rule)] flex-shrink-0" />
          <span className="flex-shrink-0 text-[var(--text-rack-data)] tracking-[-.02em] tabular-nums">
            {formatSpeed(current.speed)}
          </span>
        </>
      )}

      {/* 完成 · download · 有本地路径 → 主 CTA: reveal (按钮 = 状态 + 动作合一) */}
      {current.status === 'completed' && current.direction === 'download' && current.localPath && (
        <button
          onClick={() => openFolder(current.localPath)}
          title={t('fileManager.revealInExplorer', { path: current.localPath })}
          className="inline-flex items-center gap-1 px-1.5 h-[20px] flex-shrink-0 bg-[var(--amber-soft)] hover:bg-[var(--amber)] text-[var(--amber)] hover:text-[var(--bg-base)] border-none cursor-pointer rounded-[2px] font-mono text-[11.5px] font-semibold tracking-[.02em] transition-colors"
        >
          <svg width="10" height="10" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square"><path d="M3 8L8 3M8 3H4M8 3V7"/></svg>
          {t('common.reveal')}
        </button>
      )}

      <button
        onClick={(e) => { e.stopPropagation(); handleClose(current.taskId, isActive) }}
        title={t('common.close')}
        className="w-[18px] h-[18px] inline-flex items-center justify-center bg-transparent border-none cursor-pointer text-[var(--text-rack-mute)] hover:text-[var(--text-rack)] flex-shrink-0 rounded-[2px] hover:bg-[var(--bg-slot)] transition-colors"
      >
        <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square"><path d="M2 2l6 6M8 2l-6 6"/></svg>
      </button>
    </div>
  )
}

export default DownloadProgressBar
