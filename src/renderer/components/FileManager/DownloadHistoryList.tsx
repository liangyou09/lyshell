import React, { useState, useEffect } from 'react'
import cn from 'classnames'
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n'

interface DownloadRecord {
  id: string
  sessionId: string
  sessionName: string
  host: string
  port: number
  fileName: string
  fileSize: number
  startTime: Date | string
  status: 'success' | 'failed' | 'cancelled'
  localPath: string
  md5?: string
}

// 格式化大小：和 fileType.formatSize 风格一致，不带 'B' 后缀（用 i18n 单例取单位）
const formatSize = (bytes: number): string => {
  if (bytes < 1024) return i18n.t('common.sizeB', { n: bytes })
  if (bytes < 1024 * 1024) return i18n.t('common.sizeK', { n: (bytes / 1024).toFixed(1) })
  if (bytes < 1024 * 1024 * 1024) return i18n.t('common.sizeM', { n: (bytes / (1024 * 1024)).toFixed(1) })
  return i18n.t('common.sizeG', { n: (bytes / (1024 * 1024 * 1024)).toFixed(1) })
}

// 相对时间：5m / 2h / 3d / 2026-06-12（用 i18n 单例）
const formatTime = (t: Date | string): string => {
  const d = new Date(t)
  const ms = Date.now() - d.getTime()
  if (ms < 60_000) return i18n.t('common.justNow')
  if (ms < 3600_000) return i18n.t('common.relTimeMinutes', { count: Math.floor(ms / 60_000) })
  if (ms < 86400_000) return i18n.t('common.relTimeHours', { count: Math.floor(ms / 3600_000) })
  if (ms < 7 * 86400_000) return i18n.t('common.relTimeDays', { count: Math.floor(ms / 86400_000) })
  return d.toISOString().slice(0, 10)
}

interface DownloadHistoryListProps {
  sessionId?: string | null
}

/**
 * 下载记录列表 — rack 风格
 *  3px 状态色条 + 文件名 / 路径 / 时间 · 大小 / reveal 按钮（默认可见）
 */
const DownloadHistoryList: React.FC<DownloadHistoryListProps> = ({ sessionId }) => {
  const [records, setRecords] = useState<DownloadRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedMd5, setExpandedMd5] = useState<Record<string, boolean>>({})
  const { t } = useTranslation()

  useEffect(() => {
    loadRecords()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  const loadRecords = async () => {
    setLoading(true)
    try {
      const result = await window.electronAPI.getDownloadHistory(sessionId || undefined)
      if (result.success) {
        setRecords(result.data || [])
      }
    } catch (err) {
      console.error('Failed to load history:', err)
    }
    setLoading(false)
  }

  const handleReveal = (localPath: string) => {
    window.electronAPI.openFolder(localPath)
  }

  const handleCopyPath = (p: string) => {
    navigator.clipboard?.writeText(p).catch(() => {})
  }

  const statusStripBg = (s: DownloadRecord['status']): string => {
    if (s === 'success') return 'bg-[var(--live)]'
    if (s === 'failed') return 'bg-[var(--error-rack)]'
    return 'bg-[var(--text-rack-faint)]'
  }

  const statusGlyph = (s: DownloadRecord['status']): { sym: string; color: string } => {
    if (s === 'success') return { sym: '✓', color: 'text-[var(--live)]' }
    if (s === 'failed')  return { sym: '✕', color: 'text-[var(--error-rack)]' }
    return { sym: '○',  color: 'text-[var(--text-rack-faint)]' }
  }

  return (
    <div className="flex flex-col h-full bg-[var(--bg-base)]">
      {/* === 顶栏 === */}
      <div className="flex items-center justify-between px-2.5 py-1.5 bg-[var(--bg-rack)] border-b border-[var(--rule-soft)] min-h-[26px]">
        <span className="font-mono text-[11.5px] text-[var(--text-rack-mute)] tracking-[.02em]">
          <span className="text-[var(--text-rack-data)] tabular-nums">{records.length}</span>
          <span className="ml-1">{t('fileManager.recordsCount')}</span>
        </span>
        <button
          onClick={loadRecords}
          title={t('common.refresh')}
          className="w-[20px] h-[20px] inline-flex items-center justify-center bg-transparent border-none rounded-[2px] cursor-pointer text-[var(--text-rack-mute)] hover:bg-[var(--bg-slot)] hover:text-[var(--text-rack)] transition-colors"
        >
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square"><path d="M1.5 3.5a4 4 0 1 1-.3 3.5M1.5 1v2.5h2.5"/></svg>
        </button>
      </div>

      {/* === 列表 === */}
      <div className="flex-1 overflow-auto rack-scroll">
        {loading ? (
          <div className="flex items-center justify-center h-full text-[13px] text-[var(--text-rack-mute)]">
            {t('fileManager.loadingDots')}
          </div>
        ) : records.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 px-4 text-center">
            <span className="font-mono text-[18px] text-[var(--text-rack-dim)] tracking-[.1em]">─ · ─</span>
            <span className="text-[13px] text-[var(--text-rack-mute)]">{t('fileManager.noTransfersYet')}</span>
            <span className="font-mono text-[12px] text-[var(--text-rack-faint)]">{t('fileManager.downloadedFilesHint')}</span>
          </div>
        ) : (
          <div>
            {records.map(record => {
              const g = statusGlyph(record.status)
              const md5Expanded = expandedMd5[record.id]
              return (
                <div
                  key={record.id}
                  className="group relative grid grid-cols-[3px_14px_1fr_auto] gap-2 pl-0 pr-2.5 py-2 items-start border-b border-[var(--rule-soft)] hover:bg-[var(--bg-rack)] transition-colors"
                >
                  {/* 状态色条 */}
                  <span className={cn('h-[28px] w-[3px] rounded-r-[2px] mt-px', statusStripBg(record.status))} />
                  {/* 状态符号 */}
                  <span className={cn('w-[14px] h-[14px] inline-flex items-center justify-center mt-px font-mono text-[12px]', g.color)}>
                    {g.sym}
                  </span>
                  {/* 主体内容 */}
                  <div className="min-w-0 flex flex-col gap-[2px]">
                    <span className="text-[13px] text-[var(--text-rack)] truncate" title={record.fileName}>
                      {record.fileName}
                    </span>
                    <div className="font-mono text-[11.5px] text-[var(--text-rack-mute)] flex items-center gap-1.5 truncate min-w-0">
                      <span className="text-[var(--text-rack-data)] tabular-nums flex-shrink-0">{formatSize(record.fileSize)}</span>
                      <span aria-hidden className="w-px h-[8px] bg-[var(--rule)] flex-shrink-0" />
                      <span className="flex-shrink-0">{formatTime(record.startTime)}</span>
                      {record.sessionName && (
                        <>
                          <span aria-hidden className="w-px h-[8px] bg-[var(--rule)] flex-shrink-0" />
                          <span className="text-[var(--text-rack-mute)] truncate flex-shrink min-w-0" title={record.sessionName}>{record.sessionName}</span>
                        </>
                      )}
                    </div>
                    {/* MD5 行（默认折叠） */}
                    {record.status === 'success' && record.md5 && md5Expanded && (
                      <div className="font-mono text-[11.5px] text-[var(--text-rack-mute)] flex items-center gap-1.5 mt-px whitespace-nowrap min-w-0">
                        <span className="text-[var(--text-rack-faint)] flex-shrink-0">{t('common.md5')}</span>
                        <span className="text-[var(--text-rack-data)] truncate">{record.md5}</span>
                        <button
                          onClick={() => navigator.clipboard?.writeText(record.md5!).catch(() => {})}
                          title={t('common.copy')}
                          className="w-[14px] h-[14px] inline-flex items-center justify-center bg-transparent border-none cursor-pointer text-[var(--text-rack-mute)] hover:text-[var(--amber)] flex-shrink-0"
                        >
                          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square"><rect x="3" y="3" width="6" height="6"/><path d="M2 7V2h5"/></svg>
                        </button>
                      </div>
                    )}
                  </div>
                  {/* 操作组 */}
                  <div className="flex items-center gap-0.5 flex-shrink-0 mt-px">
                    {record.status === 'success' && record.md5 && (
                      <button
                        onClick={() => setExpandedMd5(prev => ({ ...prev, [record.id]: !prev[record.id] }))}
                        title={t('common.md5Short')}
                        className={cn(
                          'w-[22px] h-[20px] inline-flex items-center justify-center bg-transparent border-none cursor-pointer rounded-[2px] font-mono text-[12px] transition-colors',
                          md5Expanded
                            ? 'text-[var(--amber)] bg-[var(--amber-soft)]'
                            : 'text-[var(--text-rack-mute)] hover:bg-[var(--bg-slot)] hover:text-[var(--text-rack)]'
                        )}
                      >
                        #
                      </button>
                    )}
                    <button
                      onClick={() => handleCopyPath(record.localPath)}
                      title={t('fileManager.copyLocalPath')}
                      className="w-[22px] h-[20px] inline-flex items-center justify-center bg-transparent border-none cursor-pointer rounded-[2px] text-[var(--text-rack-mute)] hover:bg-[var(--bg-slot)] hover:text-[var(--text-rack)] transition-colors"
                    >
                      <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="square"><rect x="3" y="3" width="6" height="6"/><path d="M2 7V2h5"/></svg>
                    </button>
                    {record.status === 'success' && (
                      <button
                        onClick={() => handleReveal(record.localPath)}
                        title={t('fileManager.revealInExplorer', { path: record.localPath })}
                        className="inline-flex items-center gap-1 px-1.5 h-[20px] bg-transparent hover:bg-[var(--amber-soft)] border border-[var(--rule)] hover:border-[var(--amber)] text-[var(--text-rack-data)] hover:text-[var(--amber)] cursor-pointer rounded-[2px] font-mono text-[11.5px] tracking-[.02em] transition-colors"
                      >
                        <svg width="9" height="9" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square"><path d="M3 8L8 3M8 3H4M8 3V7"/></svg>
                        {t('common.reveal')}
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

export default DownloadHistoryList
