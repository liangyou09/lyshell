import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { BrowserCertificateInfo } from '@shared/browser-settings'
import type { WebLoadFailure } from './web-load-error'
import './WebCertificateError.css'

export default function WebCertificateError({ failure, getGuestId, onRetry, onLeave, compact }: {
  failure: WebLoadFailure; getGuestId: () => number | undefined; onRetry: () => void; onLeave?: () => void; compact: boolean
}): JSX.Element {
  const { t } = useTranslation()
  const titleId = useId()
  const [advanced, setAdvanced] = useState(false)
  const [certificate, setCertificate] = useState<BrowserCertificateInfo>()
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const getGuest = useRef(getGuestId)
  getGuest.current = getGuestId
  useEffect(() => { setAdvanced(false); setCertificate(undefined); setError(false) }, [failure])
  useEffect(() => {
    if (!advanced) return
    let current = true
    void (async () => {
      try {
        const guestId = getGuest.current()
        if (!guestId || !window.electronAPI?.browserRequest) throw new Error('Unavailable')
        const result = await window.electronAPI.browserRequest({ kind: 'certificateInfo', guestId, url: failure.url })
        if (current) { setCertificate(result.certificate); setError(!result.success || !result.certificate) }
      } catch { if (current) setError(true) }
    })()
    return () => { current = false }
  }, [advanced, failure])
  const active = useRef<WebLoadFailure | null>(failure)
  useEffect(() => { active.current = failure; return () => { active.current = null } }, [failure])
  const continueToSite = async (): Promise<void> => {
    if (!certificate || pending.current) return
    pending.current = true; setBusy(true); setError(false)
    try {
      const guestId = getGuest.current()
      if (!guestId) throw new Error('Unavailable')
      const result = await window.electronAPI.browserRequest({ kind: 'trustCertificate', guestId, url: failure.url, certificateId: certificate.certificateId })
      if (active.current !== failure) return
      if (result.success && result.certificateTrusted) onRetry()
      else { setError(true); setCertificate(undefined) }
    } catch { if (active.current === failure) { setError(true); setCertificate(undefined) } }
    finally { pending.current = false; if (active.current) setBusy(false) }
  }
  let host = failure.url
  try { host = new URL(failure.url).host } catch { /* 显示原始失败地址。 */ }
  return <div className={`web-certificate-error${compact ? ' is-compact' : ''}`}>
    <section aria-labelledby={titleId}>
      <svg className="web-certificate-icon" width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m12 3 10 17H2L12 3Z" /><path d="M12 9v5m0 3h.01" /></svg>
      <h2 id={titleId}>{t('webCertificate.title')}</h2>
      <p className="web-certificate-description">{t('webCertificate.description', { host })}</p>
      <p className="web-certificate-code">{failure.description}</p>
      <div className="web-certificate-actions">
        <button type="button" className="web-certificate-advanced" aria-expanded={advanced} onClick={() => setAdvanced(value => !value)}>{t(advanced ? 'webCertificate.hideAdvanced' : 'webCertificate.advanced')}</button>
        <button type="button" className="web-certificate-back" onClick={onLeave ?? onRetry} disabled={busy}>{t(onLeave ? 'webCertificate.back' : 'webBar.retry')}</button>
      </div>
      {advanced && <div className="web-certificate-explanation">
        <p>{t('webCertificate.warning')}</p>
        <p className="web-certificate-scope">{t('webCertificate.scope')}</p>
        {certificate && <>
          <details><summary>{t('webCertificate.details')}</summary><dl>
            {[[t('webCertificate.subject'), certificate.subject], [t('webCertificate.issuer'), certificate.issuer], [t('webCertificate.validity'), `${certificate.validFrom} — ${certificate.validTo}`], ['SHA-256', certificate.fingerprint]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
          </dl></details>
          <button type="button" className="web-certificate-proceed" disabled={busy} onClick={() => { void continueToSite() }}>{t(busy ? 'webCertificate.connecting' : 'webCertificate.proceed', { host })}</button>
        </>}
        {!certificate && !error && <p role="status">{t('webCertificate.reading')}</p>}
        {error && <p role="alert">{t('webBar.certificateUnavailable')}</p>}
      </div>}
    </section>
  </div>
}
