import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useBrowserDownloads } from '../../stores/browser-downloads-store'
import BrowserDownloads from './BrowserDownloads'
import { IconBtn } from './IconBtn'
import { TOPBAR_HEIGHT } from './topbar-metrics'
import './BrowserDownloadPopup.css'
import { useEscDismiss } from '../../hooks/useDismiss'

/** 主窗口常驻订阅，网页/侧栏是否可见都能收到下载提醒。浮窗不主动移动焦点。 */
const BrowserDownloadPopup: React.FC = () => {
  const { t } = useTranslation()
  const { downloads, popupRequest, popupDownloadIds, notice } = useBrowserDownloads()
  const [open, setOpen] = useState(false)
  const [focused, setFocused] = useState(false)
  const hasDownloads = downloads.some(item => popupDownloadIds.includes(item.id))
  const close = () => { setOpen(false); setFocused(false) }
  // 自动提醒不占用当前编辑器的 Esc；用户进入浮窗后才成为栈顶。
  useEscDismiss(open && hasDownloads && focused, close)
  useEffect(() => { if (popupRequest > 0) setOpen(true) }, [popupRequest])
  if (!open || !hasDownloads) return null
  return <aside className="browser-download-popup win-no-drag" style={{ top: TOPBAR_HEIGHT + 8 }} aria-label={t('browser.downloadPopup')}
    onFocusCapture={() => setFocused(true)}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false) }}>
    <header className="browser-download-popup-header">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M4 17v4h16v-4" /></svg>
      <h2>{t('browser.downloads')}</h2>
      <IconBtn title={t('common.close')} bright size="lg" onClick={close}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg></IconBtn>
    </header>
    <span className="sr-only" role="status">{notice && <>{downloads.find(item => item.id === notice.downloadId)?.fileName} · {t(`browser.downloadStates.${notice.kind === 'started' ? 'progressing' : notice.kind}`)}</>}</span>
    <BrowserDownloads downloadIds={popupDownloadIds} compact />
  </aside>
}

export default BrowserDownloadPopup
