import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { BrowserPromptAction, BrowserPromptData, BrowserPromptResult } from '@shared/browser-prompt'

function PromptIcon(): JSX.Element {
  return <svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="8" cy="9" r="5" /><path d="m12 12 8 8m-3-3 3-3m-6 0 3-3" />
  </svg>
}

export default function BrowserPromptView({ data, onAction }: {
  data: BrowserPromptData
  onAction: (action: BrowserPromptAction) => Promise<BrowserPromptResult>
}): JSX.Element {
  const { t } = useTranslation()
  const content = data.content
  const cancelRef = useRef<HTMLButtonElement>(null)
  const pending = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<BrowserPromptResult['error']>()
  const [expired, setExpired] = useState(false)
  useEffect(() => {
    cancelRef.current?.focus()
    void onAction({ kind: 'ready' }).catch(() => setExpired(true))
  }, [onAction])
  const decide = async (kind: 'confirm' | 'cancel'): Promise<void> => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError(undefined)
    try {
      const result = await onAction({ kind })
      if (!result.success) { setError(result.error ?? 'unavailable'); if (result.error !== 'saveFailed') setExpired(true) }
    } catch { setError('unavailable'); setExpired(true) }
    finally { pending.current = false; setBusy(false) }
  }
  useEffect(() => {
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); void onAction({ kind: 'cancel' }).catch(() => undefined) }
    }
    window.addEventListener('keydown', dismiss)
    return () => window.removeEventListener('keydown', dismiss)
  }, [onAction])
  return (
    <section className="browser-prompt" role="dialog" aria-modal="false" aria-labelledby="browser-prompt-title" aria-describedby="browser-prompt-description">
      <header className="browser-prompt-heading">
        <span className="browser-prompt-icon"><PromptIcon /></span>
        <h1 id="browser-prompt-title">{t('browserPrompt.passwordTitle')}</h1>
        <button type="button" className="browser-prompt-close" aria-label={t('common.close')} onClick={() => { void decide('cancel') }} disabled={busy}>
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg>
        </button>
      </header>
      <main className="browser-prompt-content">
        <p id="browser-prompt-description" className="browser-prompt-description">{t('browserPrompt.passwordDescription')}</p>
        <dl className="browser-prompt-identity">
          <div><dt>{t('browserPrompt.website')}</dt><dd><bdi dir="ltr">{content.origin}</bdi></dd></div>
          <div><dt>{t('browserPrompt.username')}</dt><dd><bdi>{content.username || t('browserPrompt.noUsername')}</bdi></dd></div>
        </dl>
        <p className="browser-prompt-hint">{t('browserPrompt.passwordHint')}</p>
        {error && <p className="browser-prompt-error" role="alert">{t(`browserPrompt.${error}`)}</p>}
      </main>
      <footer className="browser-prompt-actions">
        <button type="button" ref={cancelRef} disabled={busy} onClick={() => { void decide('cancel') }}>{t('browserPrompt.notNow')}</button>
        <button type="button" className="browser-prompt-primary" disabled={busy || expired} onClick={() => { void decide('confirm') }}>
          {t(busy ? 'browserPrompt.working' : error === 'saveFailed' ? 'browserPrompt.retrySave' : 'browserPrompt.save')}
        </button>
      </footer>
    </section>
  )
}
