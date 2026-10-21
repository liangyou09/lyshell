import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { WebviewTag } from 'electron'
import { useTranslation } from 'react-i18next'
import { DSH_WEB_PARTITION } from '@shared/constants'
import type { DshMarketAction } from '@shared/dsh-market'
import { PanelHeader } from './PanelHeader'
import { IconBtn } from './IconBtn'
import { SettingsGlyph } from './SettingsNavigation'
import { PANEL_STRIP_HEIGHT } from './topbar-metrics'
import { DshLaunchTab, type DshLaunchAction } from './DshLaunchTab'
import DeepSeekWhaleIcon from './DeepSeekWhaleIcon'
import './DshMarketPanel.css'

/** 市场原页面住在左列，切页签保活；不把搜索/安装改写成另一套 LyShell 逻辑。 */
export default function DshMarketPanel({ onOpenEnvSettings, onLaunch }: {
  onOpenEnvSettings?: () => void
  onLaunch: DshLaunchAction
}) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<'launch' | 'market'>('launch')
  const [marketVisited, setMarketVisited] = useState(false)
  const tabId = useId()
  const launchTab = useRef<HTMLButtonElement>(null)
  const marketTab = useRef<HTMLButtonElement>(null)
  const selectTab = (tab: 'launch' | 'market') => {
    setActiveTab(tab)
    if (tab === 'market') setMarketVisited(true)
  }
  const translate = useRef(t)
  translate.current = t
  const [url, setUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [needsInstall, setNeedsInstall] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [marketSurface, setMarketSurface] = useState<{ background: string; color: string } | null>(null)
  const mounted = useRef(false)
  const inFlight = useRef(false)
  const webview = useRef<WebviewTag | null>(null)

  const connect = useCallback(async (action: DshMarketAction = 'open') => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    setUrl(null)
    setMarketSurface(null)
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
    if (!marketVisited) return
    mounted.current = true
    void connect()
    return () => {
      mounted.current = false
      // StrictMode 会立即重挂同一个 effect；只在真实卸载后释放连接。
      void Promise.resolve().then(() => {
        if (!mounted.current) return window.electronAPI.requestDshMarket('release').catch(() => {})
      })
    }
  }, [connect, marketVisited])

  useEffect(() => {
    const guest = webview.current
    if (!url || !guest) return
    let active = true
    let surfaceRequest = 0
    const syncSurface = async () => {
      const request = ++surfaceRequest
      try {
        // 只读取市场画布的两个颜色，让宿主栏目与 webview 形成同一块表面。
        const surface: { background?: unknown; color?: unknown } | null = await guest.executeJavaScript(`(() => {
          const root = document.getElementById('lyshell-market-root');
          if (!root) return null;
          const style = getComputedStyle(root);
          return { background: style.backgroundColor, color: style.color };
        })()`)
        const cssColor = /^rgba?\([\d.,\s]+\)$/
        if (active && request === surfaceRequest && mounted.current && webview.current === guest && surface && typeof surface.background === 'string' && typeof surface.color === 'string' && cssColor.test(surface.background) && cssColor.test(surface.color)) {
          setMarketSurface({ background: surface.background, color: surface.color })
        }
      } catch { /* 加载失败或 guest 尚未就绪时，保留主题默认表面。 */ }
    }
    const ready = () => { setLoading(false); void syncSurface() }
    const failed = (event: Event) => {
      const failure = event as Event & { errorCode?: number; isMainFrame?: boolean }
      if (failure.errorCode === -3 || failure.isMainFrame === false) return
      setLoading(false)
      setError(t('dshMarket.failed'))
    }
    guest.addEventListener('dom-ready', ready)
    guest.addEventListener('did-stop-loading', syncSurface)
    guest.addEventListener('did-fail-load', failed)
    guest.addEventListener('render-process-gone', failed)
    return () => {
      active = false
      guest.removeEventListener('dom-ready', ready)
      guest.removeEventListener('did-stop-loading', syncSurface)
      guest.removeEventListener('did-fail-load', failed)
      guest.removeEventListener('render-process-gone', failed)
    }
  }, [url, t])

  return <section className="dsh-market-panel flex flex-col h-full min-w-0" aria-label={t('dsh.title')} style={activeTab === 'market' && marketSurface ? {
    '--dsh-market-surface': marketSurface.background,
    '--dsh-market-ink': marketSurface.color
  } as CSSProperties : undefined}>
    <PanelHeader title={t('dsh.title')} actions={
      <>
        {onOpenEnvSettings && <IconBtn title={t('env.manage')} onClick={onOpenEnvSettings}><SettingsGlyph name="env" /></IconBtn>}
        {activeTab === 'market' && <button type="button" disabled={busy} onClick={() => void connect()} className="panel-header-menu-trigger" title={t('dshMarket.reconnect')} aria-label={t('dshMarket.reconnect')}>
          <svg aria-hidden="true" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13 6a5 5 0 1 0 .1 3.4M13 2.5V6H9.5" />
          </svg>
        </button>}
      </>
    } />
    <div className={`dsh-market-frame${activeTab === 'launch' ? ' is-launch' : ''}`}>
      <div className="dsh-market-section-bar" role="tablist" aria-label={t('dsh.title')} style={{ height: PANEL_STRIP_HEIGHT }}
        onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const tab = event.key === 'Home' ? 'launch' : event.key === 'End' ? 'market' : activeTab === 'launch' ? 'market' : 'launch'
          selectTab(tab)
          const focusTarget = tab === 'launch' ? launchTab : marketTab
          focusTarget.current?.focus()
        }}>
        <button ref={launchTab} type="button" role="tab" id={`${tabId}-launch-tab`} aria-controls={`${tabId}-launch-panel`}
          aria-selected={activeTab === 'launch'} tabIndex={activeTab === 'launch' ? 0 : -1}
          className="dsh-launch-tab" onClick={() => selectTab('launch')}>
          <span className="dsh-launch-tab-icon" aria-hidden="true"><DeepSeekWhaleIcon /></span>
          Launcher
        </button>
        <button ref={marketTab} type="button" role="tab" id={`${tabId}-market-tab`} aria-controls={`${tabId}-market-panel`}
          aria-selected={activeTab === 'market'} tabIndex={activeTab === 'market' ? 0 : -1}
          className="dsh-market-section-name" onClick={() => selectTab('market')}>
          <span className="dsh-market-section-icon" aria-hidden="true">
            {/* 市场官方标识，取自 dshmarket 包 assets/logo.svg：八格方块 + 右上一格略微倾斜的朱砂块。
                只画图形本体、去掉奶油色底板，才能在 14px 的页签里与鲸鱼剪影同高同重。 */}
            <svg width="14" height="14" viewBox="0 0 16 16">
              <g fill="currentColor">
                <rect x="1" y="1" width="4" height="4" rx="0.65" />
                <rect x="5.75" y="1" width="4" height="4" rx="0.65" />
                <rect x="1" y="5.75" width="4" height="4" rx="0.65" />
                <rect x="5.75" y="5.75" width="4" height="4" rx="0.65" />
                <rect x="1" y="10.5" width="4" height="4" rx="0.65" />
                <rect x="5.75" y="10.5" width="4" height="4" rx="0.65" />
                <rect x="10.5" y="5.75" width="4" height="4" rx="0.65" />
                <rect x="10.5" y="10.5" width="4" height="4" rx="0.65" />
              </g>
              {/* 右上一格照官方 logo 那样斜 9°；14px 里不再做出「向上插入」的位移，否则红块会浮在网格外。 */}
              <rect x="10.5" y="1" width="4" height="4" rx="0.65" fill="#c0392b" transform="rotate(9 12.5 3)" />
            </svg>
          </span>
          <span className="dsh-market-section-title" title={t('dshMarket.title')}>{t('dshMarket.title')}</span>
        </button>
        {activeTab === 'market' && <span className="dsh-market-source" title="dsh-market">dsh-market</span>}
      </div>
      <div role="tabpanel" id={`${tabId}-launch-panel`} aria-labelledby={`${tabId}-launch-tab`} hidden={activeTab !== 'launch'} className="dsh-panel-body">
        <DshLaunchTab onLaunch={onLaunch} />
      </div>
      <div role="tabpanel" id={`${tabId}-market-panel`} aria-labelledby={`${tabId}-market-tab`} hidden={activeTab !== 'market'} className="dsh-panel-body">
      {marketVisited && <>
      {error && <div role="alert" className="m-3 p-2 border border-[var(--rule)] text-[11px] leading-relaxed text-[var(--error-rack)] break-words">{error}</div>}
      {(busy || loading) && <p role="status" className="px-3 py-2 text-[11px] text-[var(--text-rack-mute)]">{busy && needsInstall ? t('dshMarket.installing') : t('dshMarket.loading')}</p>}
      {url ? <webview ref={webview} partition={DSH_WEB_PARTITION} src={url} className="flex-1 w-full min-h-0" /> : !busy && <div className="flex-1 min-h-0 flex flex-col items-start justify-center gap-3 p-4 text-[12px] leading-relaxed text-[var(--text-rack-mute)]">
        <p>{needsInstall ? t('dshMarket.installHint') : t('dshMarket.retryHint')}</p>
        <button type="button" className="px-3 py-1.5 rounded border border-[var(--rule)] text-[var(--text-rack)] hover:bg-[var(--bg-elev)]" onClick={() => void connect(needsInstall ? 'install' : 'open')}>
          {needsInstall ? t('dshMarket.install') : t('dshMarket.reconnect')}
        </button>
        {!needsInstall && <button type="button" className="text-[11px] underline" onClick={() => void connect('install')}>{t('dshMarket.install')}</button>}
      </div>}
      </>}
      </div>
    </div>
  </section>
}
