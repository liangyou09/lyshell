import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { browserAddress, type SearchEngine } from '@shared/browser-settings'
import { useBrowserSettingsStore } from '../../stores/browser-settings-store'
import './CommandWelcome.css'

interface CommandWelcomeProps {
  onCommand: (name: string) => void
  onNavigate: (url: string) => boolean
  onStartCommand?: (raw: string) => void
  searchInputRef?: React.RefObject<HTMLInputElement>
}

/** 空 pane 的水墨留白；输入和命令输出始终优先。 */
const CommandWelcome: React.FC<CommandWelcomeProps> = ({ onCommand, onNavigate, onStartCommand, searchInputRef }) => {
  const { t } = useTranslation()
  const { settings, loaded, save } = useBrowserSettingsStore()
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [savingEngine, setSavingEngine] = useState(false)
  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!query.trim()) return
    const url = browserAddress(query, settings.searchEngine)
    if (!url || !onNavigate(url)) setNotice(t('webBar.invalid'))
  }
  const selectEngine = async (searchEngine: SearchEngine) => {
    setNotice(null)
    setSavingEngine(true)
    const result = await save({ ...settings, searchEngine })
    if (!result.success) setNotice(t(`browser.${result.error ?? 'browserOperationFailed'}`))
    setSavingEngine(false)
  }
  return (
    <section className="command-welcome" aria-label={t('commandBar.welcome.title')}>
      <div className="command-welcome-landscape" aria-hidden="true" />
      <div className="command-welcome-inscription">
        <h1>LyShell</h1>
        <p>{t('commandBar.welcome.title')}</p>
        <form className="command-welcome-search" role="search" onSubmit={submit}>
          <select aria-label={t('browser.searchEngine')} value={settings.searchEngine} disabled={!loaded || savingEngine} onChange={event => void selectEngine(event.target.value as SearchEngine)}>
            <option value="bing">Bing</option>
            <option value="google">Google</option>
            <option value="baidu">百度</option>
            <option value="duckduckgo">DuckDuckGo</option>
            <option value="none">{t('commandBar.welcome.urlsOnly')}</option>
          </select>
          <input ref={searchInputRef} type="search" aria-label={t('commandBar.welcome.address')} placeholder={t(settings.searchEngine === 'none' ? 'commandBar.welcome.urlPlaceholder' : 'commandBar.welcome.searchPlaceholder')} value={query} onChange={event => {
            const next = event.target.value
            if (next.startsWith('/') && !(event.nativeEvent as InputEvent).isComposing && onStartCommand) onStartCommand(next)
            else setQuery(next)
            setNotice(null)
          }} onCompositionEnd={event => {
            if (event.currentTarget.value.startsWith('/')) onStartCommand?.(event.currentTarget.value)
          }} onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault() }} autoComplete="off" spellCheck={false} />
          <button type="submit" title={t('commandBar.welcome.go')} aria-label={t('commandBar.welcome.go')} disabled={!query.trim()}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6" /></svg>
          </button>
        </form>
        {notice && <p className="command-welcome-search-notice" role="alert">{notice}</p>}
        <div className="command-welcome-actions">
          {(['local', 'new', 'help'] as const).map(name => (
            <button key={name} type="button" onClick={() => onCommand(name)} className="command-welcome-action">
              <span>{t(`commandBar.welcome.${name}`)}</span>
            </button>
          ))}
        </div>
        <p className="command-welcome-command-hint">{t('commandBar.welcome.commandHint')}</p>
      </div>
    </section>
  )
}

export default CommandWelcome
