import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { DefaultBrowserStatus } from '@shared/default-browser'
import { requestBrowser } from '../../stores/browser-settings-store'

export default function DefaultBrowserControl(): React.ReactElement {
  const { t } = useTranslation()
  const [status, setStatus] = useState<DefaultBrowserStatus | null>(null)
  const [busy, setBusy] = useState(true)
  const [failed, setFailed] = useState(false)
  const [opened, setOpened] = useState(false)
  const active = useRef(false)
  const inFlight = useRef(false)

  const refresh = useCallback(async (request = false) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setFailed(false)
    try {
      const result = await requestBrowser({ kind: request ? 'requestDefaultBrowser' : 'defaultBrowserStatus' })
      if (!active.current) return
      if (result.success && result.defaultBrowserStatus) {
        setStatus(result.defaultBrowserStatus)
        if (request) setOpened(true)
      } else { setFailed(true); setStatus(null) }
    } finally {
      inFlight.current = false
      if (active.current) setBusy(false)
    }
  }, [])

  useEffect(() => {
    active.current = true
    const onFocus = () => { void refresh() }
    const onVisibility = () => { if (document.visibilityState === 'visible') void refresh() }
    void refresh()
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      active.current = false
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [refresh])

  const description = busy ? 'defaultBrowserChecking' : !status ? 'defaultBrowserUnknown'
    : !status.supported ? 'defaultBrowserUnsupported' : !status.canRegister ? 'defaultBrowserDevelopment'
      : status.isDefault ? 'defaultBrowserActive' : 'defaultBrowserInactive'

  return <section aria-label={t('browser.defaultBrowser')} className="browser-default-control">
    <div className="browser-action-row">
      <span>{t('browser.defaultBrowser')}</span>
      {status?.supported && status.canRegister && <button type="button" className="settings-input" disabled={busy} onClick={() => void refresh(true)}>
        {t(status.isDefault ? 'browser.defaultBrowserManage' : 'browser.defaultBrowserSet')}
      </button>}
      {!status && !busy && <button type="button" className="settings-input" onClick={() => void refresh()}>{t('browser.defaultBrowserRetry')}</button>}
    </div>
    {!failed && <p className="browser-hint" role="status" aria-live="polite">{t(`browser.${description}`)}</p>}
    {status?.supported && status.canRegister && !status.isDefault && <p className="browser-hint">{t('browser.defaultBrowserHint')}</p>}
    {opened && !failed && !status?.isDefault && <p className="browser-feedback" role="status">{t('browser.defaultBrowserOpened')}</p>}
    {failed && <p className="browser-feedback is-error" role="alert">{t('browser.defaultBrowserFailed')}</p>}
  </section>
}
