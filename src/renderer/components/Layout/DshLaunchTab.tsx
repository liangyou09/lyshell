import { useCallback, useEffect, useRef, useState } from 'react'
import cn from 'classnames'
import { useTranslation } from 'react-i18next'
import { DSH_WEB_INSTALL_COMMAND } from '@shared/harness'
import { usePaneStore } from '../../stores/pane-store'
import { DSH_WEB_OVERLAY_ID } from '../../stores/overlay-kinds'
import DeepSeekWhaleIcon from './DeepSeekWhaleIcon'
import { DshUsagePanel } from './DshUsagePanel'

export type DshLaunchAction = () => Promise<{ success: boolean; error?: string }>

/** Launch 页签内容：点击大鲸鱼启动或切回右侧官方工作台。 */
export function DshLaunchTab({ onLaunch }: {
  onLaunch: DshLaunchAction
}): JSX.Element {
  const { t, i18n } = useTranslation()
  const open = usePaneStore(state => !!state.overlayPayloads[DSH_WEB_OVERLAY_ID])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const inFlight = useRef(false)
  const mounted = useRef(false)
  const launch = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    setCopyState('idle')
    try {
      const result = await onLaunch()
      if (mounted.current && !result.success) setError(result.error || t('dsh.webFailed'))
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : t('dsh.webFailed'))
    } finally {
      inFlight.current = false
      if (mounted.current) setBusy(false)
    }
  }, [onLaunch, t])

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const copyInstallCommand = async () => {
    try {
      await navigator.clipboard.writeText(DSH_WEB_INSTALL_COMMAND)
      if (mounted.current) setCopyState('copied')
    } catch {
      if (mounted.current) setCopyState('failed')
    }
  }

  const label = t('dshMarket.workbench')
  // 图形和状态语共用启动按钮，变色层保持相同的扫描节奏。
  const hint = error ? t('dshLaunch.failed')
    : busy ? t('dshLaunch.opening')
      : open ? t('dshLaunch.running')
        : t('dshLaunch.hint')

  return <div className="dsh-launch-content">
    <div className="dsh-launch-stage">
      <button type="button" onClick={() => void launch()} disabled={busy}
        aria-label={label} title={busy ? t('dsh.launching') : label} aria-pressed={open} aria-busy={busy}
        className={cn('dsh-launch-whale', open && 'is-open', busy && 'is-busy')}>
        {/* 同一只鲸鱼叠两层，从左向右揭开主题端点色；这是等待动效，不代表实际百分比。 */}
        <span className="dsh-whale-stack" aria-hidden="true">
          {/* 大图去掉方形图标上下自带的留白，让文字与可见轮廓保持自然间距。 */}
          <span className="dsh-whale-base"><DeepSeekWhaleIcon viewBox="0 6 50 38" /></span>
          <span className="dsh-whale-fill" aria-hidden="true"><DeepSeekWhaleIcon viewBox="0 6 50 38" /></span>
        </span>
        <span className="dsh-launch-hint" aria-hidden="true" lang={i18n?.resolvedLanguage ?? i18n?.language}>
          <span className="dsh-launch-hint-base">{hint}</span>
          <span className="dsh-launch-hint-fill" data-hint={hint} aria-hidden="true" />
        </span>
      </button>
      {/* 按钮子元素的语义会被辅助技术折叠，状态播报需独立于按钮。 */}
      <span className="sr-only" role="status">{hint}</span>
    </div>
    {error && <div role="alert" className="dsh-launch-error m-4 text-[12px] text-[var(--error-rack)]">
      <p className="break-words">{error === 'dsh not installed' ? t('dshLaunch.installHint') : error}</p>
      {error === 'dsh not installed' && <>
        <div className="flex items-start gap-2 mt-2 text-[var(--text-rack)]">
          <code className="flex-1 min-w-0 break-all select-all">{DSH_WEB_INSTALL_COMMAND}</code>
          <button type="button" onClick={() => void copyInstallCommand()} aria-live="polite"
            className="shrink-0 px-1 underline text-[var(--amber)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--amber)]">
            {copyState === 'copied' ? t('dsh.copied') : t('dsh.copy')}
          </button>
        </div>
        {copyState === 'failed' && <p role="status" className="mt-2 break-words">{t('dshLaunch.copyFailed')}</p>}
      </>}
      <div className="flex flex-wrap gap-3 mt-2">
        <button type="button" className="text-[var(--amber)] underline" onClick={() => void launch()}>{t('dshLaunch.retry')}</button>
        <button type="button" className="underline" onClick={() => setError(null)}>{t('dshLaunch.dismiss')}</button>
      </div>
    </div>}
    <DshUsagePanel />
  </div>
}
