import { useCallback, useEffect, useRef, useState } from 'react'
import type { WebviewTag } from 'electron'
import { useTranslation } from 'react-i18next'
import { DSH_WEB_PARTITION } from '@shared/constants'
import type { DshMarketAction } from '@shared/dsh-market'
import { PanelHeader } from './PanelHeader'

/** 市场原页面住在左列，切页签保活；不把搜索/安装改写成另一套 LyShell 逻辑。 */
export default function DshMarketPanel({ onOpenWeb }: {
  onOpenWeb: (target: { workspaceId?: string; cwd?: string }, name?: string) => Promise<{ success: boolean; error?: string }>
}) {
  const { t } = useTranslation()
  const translate = useRef(t)
  translate.current = t
  const [url, setUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [needsInstall, setNeedsInstall] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(false)
  const inFlight = useRef(false)
  const webview = useRef<WebviewTag | null>(null)

  const connect = useCallback(async (action: DshMarketAction = 'open') => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    setUrl(null)
    setLoading(false)
    try {
      const result = await window.electronAPI.requestDshMarket(action)
      if (!mounted.current) return
      if (!result.success) setError(result.error)
      else if (result.restartRequired) setError(translate.current('dshMarket.backendInUse'))
      else {
        setNeedsInstall(Boolean(result.needsInstall))
        if (result.url) { setLoading(true); setUrl(result.url) }
      }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : translate.current('dshMarket.failed'))
    } finally {
      inFlight.current = false
      if (mounted.current) setBusy(false)
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void connect()
    return () => {
      mounted.current = false
      // StrictMode 会立即重挂同一个 effect；只在真实卸载后释放连接。
      void Promise.resolve().then(() => {
        if (!mounted.current) return window.electronAPI.requestDshMarket('release').catch(() => {})
      })
    }
  }, [connect])

  useEffect(() => {
    const guest = webview.current
    if (!url || !guest) return
    const ready = () => setLoading(false)
    const failed = (event: Event) => {
      const failure = event as Event & { errorCode?: number; isMainFrame?: boolean }
      if (failure.errorCode === -3 || failure.isMainFrame === false) return
      setLoading(false)
      setError(t('dshMarket.failed'))
    }
    guest.addEventListener('dom-ready', ready)
    guest.addEventListener('did-fail-load', failed)
    guest.addEventListener('render-process-gone', failed)
    return () => {
      guest.removeEventListener('dom-ready', ready)
      guest.removeEventListener('did-fail-load', failed)
      guest.removeEventListener('render-process-gone', failed)
    }
  }, [url, t])

  const openWorkbench = async () => {
    const result = await onOpenWeb({})
    if (!result.success) setError(result.error || t('dsh.webFailed'))
  }

  return <section className="flex flex-col h-full min-w-0 bg-[var(--bg-rack)]" aria-label={t('dshMarket.title')}>
    <PanelHeader title={t('dsh.title')} onTitleClick={() => void openWorkbench()} titleHint={t('dshMarket.workbench')} actions={
      <button type="button" disabled={busy} onClick={() => void connect()} className="panel-header-menu-trigger" title={t('dshMarket.reconnect')} aria-label={t('dshMarket.reconnect')}>↻</button>
    } />
    <div className="flex items-center justify-between gap-2 border-b border-[var(--rule)] px-3 py-2 text-[11px] text-[var(--text-rack-mute)]">
      <span>{t('dshMarket.title')}</span>
      <span className="text-[10px] opacity-70">dsh-market</span>
    </div>
    {error && <div role="alert" className="m-3 p-2 border border-[var(--rule)] text-[11px] leading-relaxed text-[var(--error-rack)] break-words">{error}</div>}
    {(busy || loading) && <p role="status" className="px-3 py-2 text-[11px] text-[var(--text-rack-mute)]">{busy && needsInstall ? t('dshMarket.installing') : t('dshMarket.loading')}</p>}
    {url ? <webview ref={webview} partition={DSH_WEB_PARTITION} src={url} className="flex-1 w-full min-h-0" /> : !busy && <div className="flex-1 min-h-0 flex flex-col items-start justify-center gap-3 p-4 text-[12px] leading-relaxed text-[var(--text-rack-mute)]">
      <p>{needsInstall ? t('dshMarket.installHint') : t('dshMarket.retryHint')}</p>
      <button type="button" className="px-3 py-1.5 rounded border border-[var(--rule)] text-[var(--text-rack)] hover:bg-[var(--bg-elev)]" onClick={() => void connect(needsInstall ? 'install' : 'open')}>
        {needsInstall ? t('dshMarket.install') : t('dshMarket.reconnect')}
      </button>
      {!needsInstall && <button type="button" className="text-[11px] underline" onClick={() => void connect('install')}>{t('dshMarket.install')}</button>}
    </div>}
  </section>
}
