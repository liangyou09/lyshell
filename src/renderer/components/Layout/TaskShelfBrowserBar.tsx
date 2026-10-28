import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { normalizeWebBarUrl, usePaneStore } from '../../stores/pane-store'
import { getWebview } from './web-tab-controls'

export default function TaskShelfBrowserBar({ id, interactive }: { id: string; interactive: boolean }) {
  const { t } = useTranslation()
  const payload = usePaneStore(s => s.overlayPayloads[id])
  const url = payload?.kind === 'web' ? payload.nav?.url || payload.url : ''
  const loading = payload?.kind === 'web' && !!payload.nav?.loading
  const [address, setAddress] = useState(url)
  const [error, setError] = useState(false)
  useEffect(() => { setAddress(url); setError(false) }, [url])
  const run = (action: 'back' | 'forward' | 'reload') => {
    const page = getWebview(id)
    if (!interactive || !page) return
    try {
      if (action === 'back' && page.canGoBack()) page.goBack()
      else if (action === 'forward' && page.canGoForward()) page.goForward()
      else if (action === 'reload') { if (loading) page.stop(); else page.reload() }
    } catch { setError(true) }
  }
  return <form className="task-shelf-browser-bar" onSubmit={event => {
    event.preventDefault()
    const next = normalizeWebBarUrl(address)
    const page = getWebview(id)
    if (!interactive || !next || !page) { setError(true); return }
    try { void page.loadURL(next).catch(() => setError(true)); setError(false) } catch { setError(true) }
  }}>
    {(['back', 'forward', 'reload'] as const).map(action => <button key={action} type="button" disabled={!interactive || action === 'back' && !(payload?.kind === 'web' && payload.nav?.canGoBack) || action === 'forward' && !(payload?.kind === 'web' && payload.nav?.canGoForward)} aria-label={t(`taskShelf.browser.${action}`)} title={t(`taskShelf.browser.${action}`)} onClick={() => run(action)}>
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">{action === 'reload' ? loading ? <path d="M4 4h8v8H4z" /> : <><path d="M13 7a5 5 0 1 0-1 4M13 3v4H9" /></> : <path d={action === 'back' ? 'm10 3-5 5 5 5' : 'm6 3 5 5-5 5'} />}</svg>
    </button>)}
    <input aria-label={t('taskShelf.browser.address')} aria-invalid={error || undefined} title={address} value={address} readOnly={!interactive} onChange={event => setAddress(event.target.value)} onFocus={event => event.currentTarget.select()} onKeyDown={event => { if (event.key === 'Escape') { setAddress(url); setError(false); event.currentTarget.blur() } }} spellCheck={false} />
  </form>
}
