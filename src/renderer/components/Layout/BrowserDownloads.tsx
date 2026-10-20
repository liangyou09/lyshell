import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useBrowserDownloads } from '../../stores/browser-downloads-store'
import { requestBrowser } from '../../stores/browser-settings-store'
import { IconBtn } from './IconBtn'
import type { BrowserDownloadAction } from '@shared/browser-downloads'
import './BrowserDownloads.css'

function bytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(1)} GB`
}

const DownloadGlyph: React.FC<{ kind: 'file' | 'folder' | 'cancel' | 'remove' }> = ({ kind }) => <svg width={kind === 'file' ? 18 : 16} height={kind === 'file' ? 18 : 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  {kind === 'file' ? <><path d="M14 3H5a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9Z" /><path d="M14 3v6h6M8 13h8m-8 4h5" /></> : kind === 'folder' ? <><path d="M3 10V6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v1" /><path d="M3 10h19l-3 10H3Z" /></> : kind === 'remove' ? <><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7" /></> : <path d="m6 6 12 12M6 18 18 6" />}
</svg>

const BrowserDownloads: React.FC<{ showDirectorySettings?: boolean; downloadIds?: string[]; compact?: boolean }> = ({ showDirectorySettings = false, downloadIds, compact = false }) => {
  const { t } = useTranslation()
  const { downloads, downloadDirectory, loaded, error, refresh } = useBrowserDownloads()
  const [busy, setBusy] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const visibleDownloads = downloadIds ? downloadIds.flatMap(id => downloads.find(item => item.id === id) ?? []) : downloads
  const perform = async (id: string, action: BrowserDownloadAction) => {
    setBusy(id); setFailed(false)
    try {
      const result = await requestBrowser({ kind: 'downloadAction', id, action })
      setFailed(!result.success)
      await refresh()
    } finally { setBusy(null) }
  }
  const chooseDirectory = async () => {
    setBusy('directory'); setFailed(false)
    try {
      const directory = await window.electronAPI?.selectDirectory()
      if (!directory) return
      const result = await window.electronAPI?.setDownloadConfig({ defaultDir: directory })
      if (!result?.success) { setFailed(true); return }
      await refresh()
    } catch { setFailed(true) } finally { setBusy(null) }
  }
  const openDirectory = async () => {
    setFailed(false)
    try {
      const result = await requestBrowser({ kind: 'openDownloadDirectory' })
      if (!result?.success) setFailed(true)
    } catch { setFailed(true) }
  }
  return <section className="browser-downloads" aria-label={t('browser.downloads')}>
    {showDirectorySettings && <div className="browser-download-directory">
      <span>{t('browser.downloadDirectory')}</span>
      <p title={downloadDirectory}>{downloadDirectory || t(loaded ? 'browser.downloadDirectoryUnavailable' : 'browser.working')}</p>
      <div className="browser-download-actions">
        <button type="button" disabled={!downloadDirectory || !!busy} onClick={() => void openDirectory()}>{t('browser.openDownloadDirectory')}</button>
        <button type="button" disabled={!loaded || !!busy} onClick={() => void chooseDirectory()}>{t('browser.chooseDownloadDirectory')}</button>
      </div>
      <p className="browser-download-hint">{t('browser.downloadDirectoryHint')}</p>
    </div>}
    {(failed || error) && <div className="browser-download-error" role="alert"><p>{t('browser.browserDownloadFailed')}</p><button type="button" onClick={() => { setFailed(false); void refresh() }}>{t('browser.retryDownloadList')}</button></div>}
    <div className="browser-download-list rack-scroll">
      {!loaded ? <p role="status" className="browser-download-empty">{t('browser.working')}</p> : visibleDownloads.length === 0 && !error ? <p className="browser-download-empty">{t('browser.noDownloads')}</p> : null}
      {visibleDownloads.map(item => {
        const progress = item.totalBytes > 0 ? Math.min(100, Math.round(item.receivedBytes / item.totalBytes * 100)) : undefined
        const dot = item.fileName.lastIndexOf('.')
        const extension = dot > 0 && item.fileName.length - dot <= 10 ? item.fileName.slice(dot) : ''
        const stem = extension ? item.fileName.slice(0, dot) : item.fileName
        return <article key={item.id} className={`browser-download-item is-${item.state}`} aria-label={item.fileName} title={item.savePath || undefined}>
          <div className="browser-download-file" aria-hidden="true">{item.iconDataUrl ? <img src={item.iconDataUrl} alt="" draggable={false} /> : <DownloadGlyph kind="file" />}</div>
          <div className="browser-download-body">
            <strong className="browser-download-name" title={item.fileName}><span>{stem}</span>{extension && <span className="browser-download-extension">{extension}</span>}</strong>
            {item.state === 'completed'
              ? <button type="button" className="browser-download-open" disabled={!!busy} onClick={() => void perform(item.id, 'open')}>{t('browser.openDownload')}</button>
              : <p className="browser-download-meta">{item.active && item.state === 'progressing' ? <>{bytes(item.receivedBytes)}{item.totalBytes > 0 ? ` / ${bytes(item.totalBytes)} · ${progress}%` : ` · ${t('browser.downloadSizeUnknown')}`}</> : t(`browser.downloadStates.${item.state}`)}</p>}
          </div>
          <div className="browser-download-control">
            {item.active && <IconBtn title={t('browser.cancelDownload')} bright size="lg" disabled={!!busy} onClick={() => void perform(item.id, 'cancel')}><DownloadGlyph kind="cancel" /></IconBtn>}
            {item.state === 'completed' && <IconBtn title={t('browser.revealDownload')} bright size="lg" disabled={!!busy} onClick={() => void perform(item.id, 'reveal')}><DownloadGlyph kind="folder" /></IconBtn>}
            {!item.active && <IconBtn title={t('browser.removeDownloadRecord')} bright size="lg" disabled={!!busy} onClick={() => void perform(item.id, 'remove')}><DownloadGlyph kind="remove" /></IconBtn>}
          </div>
          {item.active && <div className="browser-download-transfer"><progress aria-label={t('browser.downloadProgress', { name: item.fileName })} max={100} value={progress} /></div>}
        </article>
      })}
    </div>
    {!compact && <p className="browser-download-session-hint">{t('browser.downloadSessionHint')}</p>}
  </section>
}
export default BrowserDownloads
