import { useCallback, useEffect, useRef, useState } from 'react'
import cn from 'classnames'
import { useTranslation } from 'react-i18next'
import { usePaneStore } from '../../stores/pane-store'
import { DSH_WEB_OVERLAY_ID } from '../../stores/overlay-kinds'
import DeepSeekWhaleIcon from './DeepSeekWhaleIcon'

export type DshLaunchAction = () => Promise<{ success: boolean; error?: string }>

/** Launch 页签内容：点击大鲸鱼启动或切回右侧官方工作台。 */
export function DshLaunchTab({ onLaunch }: {
  onLaunch: DshLaunchAction
}): JSX.Element {
  const { t } = useTranslation()
  const open = usePaneStore(state => !!state.overlayPayloads[DSH_WEB_OVERLAY_ID])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  const mounted = useRef(false)

  const launch = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
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

  const label = t('dshMarket.workbench')
  // 状态语只占鲸鱼下方一行：启动中 → 已开启 → 失败 → 待启动，按当前状态取一句。
  const hint = error ? t('dshLaunch.failed')
    : busy ? t('dshLaunch.opening')
      : open ? t('dshLaunch.running')
        : t('dshLaunch.hint')
  return <div className="dsh-launch-content">
    <button type="button" onClick={() => void launch()} disabled={busy}
      aria-label={label} title={busy ? t('dsh.launching') : label} aria-pressed={open} aria-busy={busy}
      className={cn('dsh-launch-whale', open && 'is-open', busy && 'is-busy')}>
      {/* 两层同一只鲸鱼：底层静息灰，上层主题端点色（浅色纯黑/深色亮白）按进度条方式从左向右铺满（见 CSS @keyframes）。 */}
      <span className="dsh-whale-stack">
        <span className="dsh-whale-base"><DeepSeekWhaleIcon /></span>
        <span className="dsh-whale-fill" aria-hidden="true"><DeepSeekWhaleIcon /></span>
      </span>
    </button>
    <p className="dsh-launch-hint" role="status">{hint}</p>
    {error && <div role="alert" className="dsh-launch-error m-4 text-[12px] text-[var(--error-rack)]">
      <p className="break-words">{error}</p>
      <div className="flex gap-3 mt-2">
        <button type="button" className="text-[var(--amber)] underline" onClick={() => void launch()}>{t('dshLaunch.retry')}</button>
        <button type="button" className="underline" onClick={() => setError(null)}>{t('dshLaunch.dismiss')}</button>
      </div>
    </div>}
  </div>
}
