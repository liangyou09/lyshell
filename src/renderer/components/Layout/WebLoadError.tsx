import { useTranslation } from 'react-i18next'
import cn from 'classnames'
import { webLoadFailureReason, type WebLoadFailure } from './web-load-error'

/** 完整页签与小窗共用的失败页；窄窗可换行，矮窗可滚动，保留地址与诊断信息。 */
export default function WebLoadError({ failure, onRetry, compact = false }: {
  failure: WebLoadFailure
  onRetry: () => void
  compact?: boolean
}): JSX.Element {
  const { t } = useTranslation()
  let address = failure.url
  try { address = new URL(failure.url).host || failure.url } catch { /* 非标准地址保留原值 */ }
  return (
    <div className="absolute inset-0 z-10 overflow-auto bg-[var(--terminal-bg)] text-[var(--text-rack)]">
      <div className={cn('flex min-h-full items-center justify-center', compact ? 'p-3' : 'p-4')}>
        <section className={cn('w-full max-w-md', !compact && 'py-4')} aria-label={t('webBar.loadFailed')}>
          {!compact && <svg className="mb-4 text-[var(--text-rack)] opacity-70" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
            <path d="M14 2v6h6M9 13l6 6m0-6-6 6" />
          </svg>}
          <div role="status">
            <h2 className={cn('font-semibold leading-snug', compact ? 'text-sm' : 'text-base')}>{t('webBar.loadFailed')}</h2>
            <p className={cn('break-words leading-relaxed [overflow-wrap:anywhere]', compact ? 'mt-1 text-xs' : 'mt-2 text-sm')}>{t(`webBar.failure.${webLoadFailureReason(failure)}`)}</p>
          </div>
          <p className={cn('break-all text-xs leading-relaxed opacity-75', compact ? 'mt-1' : 'mt-2')} title={failure.url}>{address}</p>
          <div className={compact ? 'mt-3 flex flex-wrap items-start gap-x-3 gap-y-2' : 'mt-5'}>
            <button type="button" onClick={onRetry} className={cn('inline-flex min-h-8 items-center gap-2 rounded py-1.5 font-medium bg-[var(--bg-slot)] text-[var(--text-rack)] hover:bg-[var(--bg-elev)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--text-rack)]', compact ? 'px-2 text-xs' : 'px-3 text-sm')}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 7a9 9 0 1 0 1 8M20 3v5h-5" /></svg>
              {t('webBar.retry')}
            </button>
            <details className={cn('text-xs leading-relaxed', compact ? 'min-w-0 flex-1 [&[open]]:basis-full' : 'mt-5')}>
              <summary className={cn('w-fit cursor-pointer rounded whitespace-nowrap opacity-75 hover:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--text-rack)]', compact && 'leading-8')}>{t('webBar.errorDetails')}</summary>
              <div className="mt-2 space-y-1 break-all select-text">
                <p className="font-mono">{failure.description}{failure.code !== undefined ? ` (${failure.code})` : ''}</p>
                <p>{failure.url}</p>
              </div>
            </details>
          </div>
        </section>
      </div>
    </div>
  )
}
