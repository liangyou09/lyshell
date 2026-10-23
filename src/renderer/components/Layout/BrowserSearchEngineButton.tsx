import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SearchEngine } from '@shared/browser-settings'
import { useBrowserSettingsStore } from '../../stores/browser-settings-store'
import MiniBrowserActions from './MiniBrowserActions'

/** 地球仪仅以提示框显示当前引擎；选择直接保存到既有浏览器设置。 */
export default function BrowserSearchEngineButton({ visible, onOpen }: { visible: boolean; onOpen: () => void }): JSX.Element {
  const { t } = useTranslation()
  const engine = useBrowserSettingsStore(s => s.settings.searchEngine)
  const loaded = useBrowserSettingsStore(s => s.loaded)
  const loadError = useBrowserSettingsStore(s => s.error)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const names: Record<SearchEngine, string> = { bing: 'Bing', google: 'Google', baidu: t('webBar.baiduEngine'), duckduckgo: 'DuckDuckGo', none: t('browser.noSearch') }
  const tooltip = t('webBar.searchEngineTooltip', { engine: names[engine] })
  const choose = async (next: SearchEngine): Promise<void> => {
    if (saving || next === useBrowserSettingsStore.getState().settings.searchEngine) return
    setSaving(true); setError(null)
    try {
      const store = useBrowserSettingsStore.getState()
      const result = await store.save({ ...store.settings, searchEngine: next })
      if (!result.success) setError(result.error ?? 'browserOperationFailed')
    } catch { setError('browserOperationFailed') }
    finally { setSaving(false) }
  }
  return <>
    <MiniBrowserActions label={error ? `${tooltip}\n${t(`browser.${error}`)}` : tooltip} visible={visible}
      disabled={!loaded || !!loadError || saving} onOpen={onOpen} triggerClassName="web-address-symbol"
      triggerIcon={<svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18" /></svg>}
      actions={(['bing', 'google', 'baidu', 'duckduckgo', 'none'] as const).map(value => ({
        label: names[value], disabled: saving, checked: engine === value,
        icon: <svg aria-hidden width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: engine === value ? 1 : 0 }}><path d="m4 10 4 4 8-8" /></svg>,
        onClick: () => { void choose(value) }
      }))} />
    {error && <span role="status" className="sr-only">{t(`browser.${error}`)}</span>}
  </>
}
