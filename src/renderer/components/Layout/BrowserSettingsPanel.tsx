import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { browserOrigin, type BrowserPasswordInfo, type BrowserPermission, type BrowserSettings } from '@shared/browser-settings'
import { useBrowserSettingsStore, requestBrowser } from '../../stores/browser-settings-store'
import { usePaneStore } from '../../stores/pane-store'
import { SettingsBackGlyph, SettingsNavigation } from './SettingsNavigation'
import './BrowserSettingsPanel.css'

const Card: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => <section className="settings-card" aria-label={title}>{children}</section>

const CATEGORIES = ['general', 'network', 'privacy', 'sitePermissions', 'passwords'] as const
export type BrowserSettingsCategory = typeof CATEGORIES[number]

const BrowserSettingsPanel: React.FC<{
  category?: BrowserSettingsCategory | null
  onCategoryChange?: (category: BrowserSettingsCategory | null) => void
}> = ({ category: requestedCategory, onCategoryChange }) => {
  const { t } = useTranslation()
  const { settings, loaded, encryptionAvailable, error, load, save } = useBrowserSettingsStore()
  const [draft, setDraft] = useState(settings)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [failure, setFailure] = useState(false)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [entries, setEntries] = useState<BrowserPasswordInfo[]>([])
  const [entry, setEntry] = useState({ origin: '', username: '', password: '' })
  const [showAdd, setShowAdd] = useState(false)
  const [localCategory, setLocalCategory] = useState<BrowserSettingsCategory | null>(null)
  const category = requestedCategory === undefined ? localCategory : requestedCategory
  const setCategory = onCategoryChange ?? setLocalCategory
  useEffect(() => { setConfirm(null) }, [category])
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings)
  useEffect(() => { void load() }, [load])
  useEffect(() => { setDraft(settings) }, [settings])
  useEffect(() => {
    let disposed = false
    void requestBrowser({ kind: 'passwords' }).then(result => {
      if (disposed) return
      if (result.success) setEntries(result.passwords ?? [])
      else { setFailure(true); setMessage(result.error ?? 'browserOperationFailed') }
    })
    return () => { disposed = true }
  }, [])
  const patch = <K extends keyof BrowserSettings>(key: K, value: BrowserSettings[K]) => {
    setDraft(v => ({ ...v, [key]: value })); setMessage(null)
  }
  const report = (success: boolean, key?: string) => { setFailure(!success); setMessage(key ?? (success ? 'saved' : 'browserOperationFailed')) }
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    const result = await save(draft)
    report(result.success, result.success ? 'saved' : result.error)
    setBusy(false)
  }
  const clearData = async (target: 'cache' | 'siteData') => {
    setBusy(true); setConfirm(null)
    const result = await requestBrowser({ kind: 'clear', target })
    report(result.success, result.success ? 'cleared' : result.error)
    setBusy(false)
  }
  const deletePassword = async (id: string) => {
    setBusy(true); setConfirm(null)
    const result = await requestBrowser({ kind: 'deletePassword', id })
    if (result.success) setEntries(result.passwords ?? [])
    report(result.success, result.success ? 'deleted' : result.error)
    setBusy(false)
  }
  const addPassword = async () => {
    if (!browserOrigin(entry.origin) || !entry.password) { report(false, 'invalidPassword'); return }
    setBusy(true)
    const result = await requestBrowser({ kind: 'savePassword', ...entry })
    if (result.success) { setEntries(result.passwords ?? []); setEntry({ origin: '', username: '', password: '' }); setShowAdd(false) }
    report(result.success, result.success ? 'saved' : result.error)
    setBusy(false)
  }
  const switchRow = (key: 'rememberHistory' | 'restoreTabs' | 'restoreMini' | 'savePasswords') => <label className="settings-field-row browser-switch-row">
    <span>{t(`browser.${key}`)}</span>
    <input type="checkbox" className="settings-switch" checked={draft[key]} onChange={e => patch(key, e.target.checked)} />
  </label>
  return <form className="browser-settings" onSubmit={submit}>
    {!onCategoryChange && category && <button type="button" className="settings-category-header" title={t('browser.backToCategories')} aria-label={t('browser.backToCategories')} onClick={() => setCategory(null)}><span className="settings-content-back" aria-hidden="true"><SettingsBackGlyph /></span><span className="settings-category-title">{t(`browser.${category}`)}</span></button>}
    <div className={`settings-content${category === null ? ' settings-index' : ''}`} key={category}>
      {category === null && <>
        <SettingsNavigation label={t('browser.category')} items={CATEGORIES.map(key => ({ key, icon: key, label: t(`browser.${key}`), hint: t(`browser.categoryHints.${key}`) }))} onSelect={key => setCategory(key as BrowserSettingsCategory)} />
        <p className="browser-scope">{t('browser.scope')}</p>
      </>}
      <fieldset disabled={busy || !loaded} className="browser-fields">
        {category === 'general' && <Card title={t('browser.general')}>
          <label className="browser-field"><span>{t('browser.homePage')}</span><input type="url" className="settings-input" placeholder="https://example.com" value={draft.homePage} maxLength={4096} onChange={e => patch('homePage', e.target.value)} /></label>
          <p className="browser-hint">{t('browser.homeHint')}</p>
          <label className="browser-field"><span>{t('browser.searchEngine')}</span><select className="settings-input" value={draft.searchEngine} onChange={e => patch('searchEngine', e.target.value as BrowserSettings['searchEngine'])}>
            <option value="none">{t('browser.noSearch')}</option><option value="bing">Bing</option><option value="google">Google</option><option value="baidu">百度</option><option value="duckduckgo">DuckDuckGo</option>
          </select></label>
          <label className="browser-field"><span>{t('browser.zoom')}</span><select className="settings-input" value={draft.zoomFactor} onChange={e => patch('zoomFactor', Number(e.target.value))}>
            {[0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2].map(value => <option key={value} value={value}>{Math.round(value * 100)}%</option>)}
          </select></label>
          {switchRow('restoreTabs')}{switchRow('restoreMini')}
          <p className="browser-hint">{t('browser.restoreHint')}</p>
        </Card>}
        {category === 'network' && <Card title={t('browser.network')}>
          <label className="browser-field"><span>{t('browser.proxyMode')}</span><select className="settings-input" value={draft.proxyMode} onChange={e => patch('proxyMode', e.target.value as BrowserSettings['proxyMode'])}>
            <option value="system">{t('browser.systemProxy')}</option><option value="direct">{t('browser.directProxy')}</option><option value="fixed">{t('browser.fixedProxy')}</option>
          </select></label>
          {draft.proxyMode === 'fixed' && <>
            <label className="browser-field"><span>{t('browser.proxyServer')}</span><input className="settings-input" type="url" required value={draft.proxyServer} placeholder="http://127.0.0.1:7890" maxLength={2048} onChange={e => patch('proxyServer', e.target.value)} /></label>
            <label className="browser-field"><span>{t('browser.proxyBypass')}</span><input className="settings-input" value={draft.proxyBypass} placeholder="<local>;*.example.com" maxLength={2048} onChange={e => patch('proxyBypass', e.target.value)} /></label>
            <p className="browser-hint">{t('browser.proxyHint')}</p>
          </>}
          <p className="browser-hint">{t('browser.networkHint')}</p>
        </Card>}
        {category === 'privacy' && <Card title={t('browser.privacy')}>
          {switchRow('rememberHistory')}
          <p className="browser-hint">{t('browser.historyHint')}</p>
          <div className="browser-data-actions">
            <button type="button" className="settings-input" onClick={() => setConfirm('history')}>{t('browser.clearHistory')}</button>
            <button type="button" className="settings-input" onClick={() => void clearData('cache')}>{t('browser.clearCache')}</button>
            <button type="button" className="settings-input" onClick={() => setConfirm('siteData')}>{t('browser.clearSiteData')}</button>
          </div>
          {(confirm === 'siteData' || confirm === 'history') && <div className="browser-confirm" role="alert">
            <p>{t(confirm === 'siteData' ? 'browser.confirmSiteData' : 'browser.confirmHistory')}</p>
            <div className="browser-action-row"><button type="button" className="settings-apply" onClick={() => {
              if (confirm === 'siteData') void clearData('siteData')
              else { usePaneStore.getState().clearWebTabHistory(); setConfirm(null); report(true, 'cleared') }
            }}>{t('browser.confirmClear')}</button><button type="button" className="settings-input" onClick={() => setConfirm(null)}>{t('browser.cancel')}</button></div>
          </div>}
          <p className="browser-hint">{t('browser.dataHint')}</p>
        </Card>}
        {category === 'sitePermissions' && <Card title={t('browser.sitePermissions')}>
          <p className="browser-hint">{t('browser.permissionHint')}</p>
          {(Object.keys(draft.permissions) as BrowserPermission[]).map(key => <label key={key} className="browser-permission-row"><span>{t(`browser.permissions.${key}`)}</span><select className="settings-input" value={draft.permissions[key]} onChange={e => patch('permissions', { ...draft.permissions, [key]: e.target.value })}><option value="ask">{t('browser.ask')}</option><option value="deny">{t('browser.deny')}</option></select></label>)}
        </Card>}
        {category === 'passwords' && <Card title={t('browser.passwords')}>
          {switchRow('savePasswords')}
          <p className="browser-hint">{t('browser.passwordHint')}</p>
          {!encryptionAvailable && <p className="browser-feedback is-error" role="status">{t('browser.encryptionUnavailable')}</p>}
          <div className="browser-password-list">
            {entries.length === 0 ? <p className="browser-hint">{t('browser.noPasswords')}</p> : entries.map(item => <div key={item.id} className="browser-password-entry">
              <div><strong title={item.origin}>{item.origin}</strong><span title={item.username}>{item.username || t('browser.noUsername')}</span></div>
              {confirm === item.id ? <div className="browser-action-row"><button type="button" className="settings-apply" onClick={() => void deletePassword(item.id)}>{t('browser.confirmDelete')}</button><button type="button" className="settings-input" onClick={() => setConfirm(null)}>{t('browser.cancel')}</button></div> : <button type="button" className="settings-input browser-delete" aria-label={t('browser.deleteAccount', { origin: item.origin, username: item.username })} onClick={() => setConfirm(item.id)}>{t('browser.delete')}</button>}
            </div>)}
          </div>
          {!showAdd ? <button type="button" className="settings-input" disabled={!encryptionAvailable} onClick={() => setShowAdd(true)}>{t('browser.addPassword')}</button> : <div className="browser-add-password" onKeyDown={event => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              if (!busy && encryptionAvailable) void addPassword()
            }
          }}>
            <label className="browser-field"><span>{t('browser.website')}</span><input className="settings-input" value={entry.origin} type="url" maxLength={4096} placeholder="https://example.com" onChange={e => setEntry(v => ({ ...v, origin: e.target.value }))} /></label>
            <label className="browser-field"><span>{t('browser.username')}</span><input className="settings-input" value={entry.username} autoComplete="off" maxLength={1024} onChange={e => setEntry(v => ({ ...v, username: e.target.value }))} /></label>
            <label className="browser-field"><span>{t('browser.password')}</span><input className="settings-input" value={entry.password} type="password" autoComplete="new-password" maxLength={4096} onChange={e => setEntry(v => ({ ...v, password: e.target.value }))} /></label>
            <div className="browser-action-row"><button type="button" className="settings-apply" disabled={!encryptionAvailable || !entry.origin || !entry.password} onClick={() => void addPassword()}>{t('browser.savePassword')}</button><button type="button" className="settings-input" onClick={() => { setShowAdd(false); setEntry({ origin: '', username: '', password: '' }) }}>{t('browser.cancel')}</button></div>
          </div>}
        </Card>}
      </fieldset>
    </div>
    {(category !== null || dirty || message || error) && <div className="browser-settings-footer">
      {(message || error) && <p className={`browser-feedback${failure || !message && error ? ' is-error' : ''}`} role={failure || !message && error ? 'alert' : 'status'}>{t(`browser.${message ?? error}`)}</p>}
      <div className="browser-action-row"><span className="browser-hint">{t(busy || !loaded ? 'browser.working' : dirty ? 'browser.unsaved' : 'browser.upToDate')}</span><button type="submit" className="settings-apply" disabled={busy || !loaded || !dirty}>{t('browser.saveSettings')}</button></div>
    </div>}
  </form>
}
export default BrowserSettingsPanel
