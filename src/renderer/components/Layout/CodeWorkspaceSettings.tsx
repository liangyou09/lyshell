import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatCodeWorkspaceName, type CodeWorkspacePreset, type CodeWorkspaceRequest } from '@shared/code-workspaces'
import { generateWorktreeCode, generateWorktreeKey } from '@shared/worktree'
import { useEscDismiss } from '@/hooks/useDismiss'
import RackSelect from './RackSelect'
import RackCombobox from './RackCombobox'
import './CodeWorkspaceSettings.css'

const CodeWorkspaceSettings: React.FC = () => {
  const { t } = useTranslation()
  const [presets, setPresets] = useState<CodeWorkspacePreset[]>([])
  const [usage, setUsage] = useState<Record<string, number>>({})
  const [draft, setDraft] = useState<Extract<CodeWorkspaceRequest, { kind: 'save' }> | null>(null)
  const [busy, setBusy] = useState(false)
  const [launchingId, setLaunchingId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [keys, setKeys] = useState<string[]>([])
  const busyRef = useRef(false)
  const openerRef = useRef<HTMLButtonElement | null>(null)
  const addRef = useRef<HTMLButtonElement | null>(null)
  const editorId = `code-workspace-editor-${draft?.preset.id ?? 'add'}`
  const restoreFocus = () => requestAnimationFrame(() => {
    const target = openerRef.current?.isConnected ? openerRef.current : addRef.current
    target?.focus()
  })
  const cancel = () => { if (busyRef.current) return; setDraft(null); setError(''); restoreFocus() }
  useEscDismiss(!!draft, cancel)

  const run = async (request: CodeWorkspaceRequest) => {
    if (busyRef.current) return
    busyRef.current = true
    setLaunchingId(request.kind === 'launch' ? request.id : null)
    setBusy(true); setError('')
    try {
      const result = await window.electronAPI.codeWorkspaceRequest(request)
      if (!result.success) { setError(result.error); return }
      setPresets(result.presets)
      setUsage(result.usage ?? {})
      if (request.kind === 'save' || (request.kind === 'delete' && request.id === draft?.preset.id)) { setDraft(null); restoreFocus() }
      setConfirmId(null)
    } catch (error) { setError(error instanceof Error ? error.message : t('workspacePresets.failed')) }
    finally { busyRef.current = false; setBusy(false); setLaunchingId(null) }
  }
  const prepareDelete = async (id: string) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true); setError(''); setConfirmId(null)
    try {
      const result = await window.electronAPI.codeWorkspaceRequest({ kind: 'list' })
      if (!result.success) { setError(result.error); return }
      setPresets(result.presets); setUsage(result.usage ?? {})
      if (result.presets.some(preset => preset.id === id)) setConfirmId(id)
    } catch (error) { setError(error instanceof Error ? error.message : t('workspacePresets.failed')) }
    finally { busyRef.current = false; setBusy(false) }
  }
  useEffect(() => { void run({ kind: 'list' }) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const cwd = draft?.preset.cwd
  const isolation = draft?.preset.isolation
  useEffect(() => {
    setKeys([])
    if (!cwd || isolation !== 'worktree') return
    let cancelled = false
    void window.electronAPI.listHarnessWorktrees(cwd).then(result => {
      if (!cancelled && result.success) setKeys(result.keys)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [cwd, isolation])
  const change = (patch: Partial<NonNullable<typeof draft>['preset']>) => setDraft(current => current ? { ...current, preset: { ...current.preset, ...patch } } : null)
  const browse = async () => {
    try {
      const result = await window.electronAPI.showOpenDialog({ title: t('settings.workspaceBrowse'), defaultPath: cwd || undefined, properties: ['openDirectory', 'createDirectory'] })
      if (!result.canceled && result.filePaths[0]) change({ cwd: result.filePaths[0] })
    } catch (error) { setError(error instanceof Error ? error.message : t('workspacePresets.failed')) }
  }
  const renderEditor = () => draft && (<form id={editorId} aria-label={t('settings.workspace')} onSubmit={event => { event.preventDefault(); if (!busyRef.current && draft) void run(draft) }}>
      <div className="code-workspace-editor-heading">{t(draft.preset.id ? 'workspacePresets.edit' : 'workspacePresets.add')}</div>
      {error && <p role="alert" className="code-workspace-error">{error}</p>}
      <label>{t('workspacePresets.name')}<input className="settings-input" value={draft.preset.name} required maxLength={120} disabled={busy} onChange={event => change({ name: event.target.value })} autoFocus /></label>
      <div className="code-workspace-field">
        <label htmlFor="preset-cwd">{t('settings.workspaceDefaultCwd')}</label>
        <div className="settings-workspace-path"><input id="preset-cwd" className="settings-input" value={draft.preset.cwd} required disabled={busy} onChange={event => change({ cwd: event.target.value })} /><button type="button" className="settings-apply" aria-label={t('settings.workspaceBrowse')} disabled={busy} onClick={() => void browse()}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M3 7V5h7l2 3h9v12H3V7Z" /></svg></button></div>
      </div>
      <div className="code-workspace-field">
        <label htmlFor={`${editorId}-isolation`}>{t('workspacePresets.directoryIsolation')}</label>
        <RackSelect id={`${editorId}-isolation`} className="rack-select" value={draft.preset.isolation === 'worktree' ? 'worktree' : 'shared'} disabled={busy}
          onChange={event => change({ isolation: event.target.value === 'worktree' ? 'worktree' : 'shared', worktreeKey: event.target.value === 'worktree' ? draft.preset.worktreeKey || generateWorktreeKey('shared', draft.preset.name, generateWorktreeCode()) : undefined })}>
          <option value="shared">{t('workspacePresets.sharedDirectory')}</option>
          <option value="worktree">{t('workspacePresets.dedicatedWorktree')}</option>
        </RackSelect>
      </div>
      {draft.preset.isolation === 'worktree' && <><div className="code-workspace-field">
        <label htmlFor={`${editorId}-worktree`}>{t('workspacePresets.worktreeName')}</label>
        <RackCombobox id={`${editorId}-worktree`} label={t('workspacePresets.worktreeName')} optionsLabel={t('workspacePresets.chooseWorktree')}
          emptyText={t('workspacePresets.customWorktree')} value={draft.preset.worktreeKey || ''} options={keys}
          required maxLength={64} disabled={busy} onChange={worktreeKey => change({ worktreeKey })} />
      </div><p className="settings-path-label">{t('workspacePresets.worktreeHint')}</p></>}
      <div className="code-workspace-actions"><button type="button" disabled={busy} onClick={cancel}>{t('workspacePresets.cancel')}</button><button className="settings-apply" type="submit" disabled={busy}>{t(busy ? 'workspacePresets.saving' : 'workspacePresets.save')}</button></div>
    </form>)
  return <section className="code-workspace-settings" aria-label={t('settings.workspace')}>
    <div className="code-workspace-toolbar">
      <span className="code-workspace-shared" title={t('workspacePresets.hint')}>{t('settings.workspace')}{!busy && <span className="code-workspace-count" aria-label={`${t('settings.workspace')}: ${presets.length}`}>{presets.length}</span>}</span>
      <button ref={addRef} type="button" className="settings-apply" disabled={busy} aria-expanded={!!draft && !draft.preset.id} aria-controls="code-workspace-editor-add" onClick={event => {
        if (draft && !draft.preset.id) { cancel(); return }
        openerRef.current = event.currentTarget
        setDraft({ kind: 'save', preset: { name: '', cwd: '', isolation: 'shared' } }); setError(''); setConfirmId(null)
      }}>{t('workspacePresets.add')}</button>
    </div>
    {error && !draft && <p role="alert" className="code-workspace-error">{error}<button type="button" disabled={busy} onClick={() => void run({ kind: 'list' })}>{t('workspacePresets.retry')}</button></p>}
    {draft && !draft.preset.id && renderEditor()}
    {busy && !draft && <p role="status">{t(launchingId ? 'workspacePresets.launching' : 'workspacePresets.loading')}</p>}
    {!busy && !presets.length && !error && !draft && <p>{t('workspacePresets.empty')}</p>}
    {presets.map(preset => {
      const expanded = draft?.preset.id === preset.id
      return <div className={`code-workspace-item${expanded ? ' is-expanded' : ''}`} key={preset.id}>
        <div className="code-workspace-row">
          <button type="button" className="code-workspace-edit" disabled={busy} aria-label={`${formatCodeWorkspaceName(preset)} ${preset.cwd}`} title={formatCodeWorkspaceName(preset)} aria-expanded={expanded} aria-controls={`code-workspace-editor-${preset.id}`} onClick={event => {
            if (expanded) { cancel(); return }
            openerRef.current = event.currentTarget
            setDraft({ kind: 'save', preset }); setError(''); setConfirmId(null)
          }}><span className="code-workspace-title"><svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" className={expanded ? 'is-expanded' : ''}><path d="m4 2 4 4-4 4" /></svg><strong>{formatCodeWorkspaceName(preset)}</strong></span></button>
          <button type="button" className="code-workspace-launch" disabled={busy || !!draft} aria-busy={launchingId === preset.id} aria-label={t('workspacePresets.launchPs7For', { name: formatCodeWorkspaceName(preset) })} title={`${t('workspacePresets.launchPs7')} · ${t('workspacePresets.launchPs7Hint')}`} onClick={() => void run({ kind: 'launch', id: preset.id })}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true"><path d="m5 3 8 5-8 5Z" /></svg>
            <span aria-hidden="true">PS7</span>
          </button>
          <button type="button" className={`code-workspace-remove${confirmId === preset.id ? ' is-confirming' : ''}`} disabled={busy} title={t(confirmId === preset.id ? 'workspacePresets.confirmDelete' : 'workspacePresets.delete', { name: formatCodeWorkspaceName(preset) })} aria-label={t(confirmId === preset.id ? 'workspacePresets.confirmDelete' : 'workspacePresets.delete', { name: formatCodeWorkspaceName(preset) })} aria-describedby={confirmId === preset.id ? `workspace-delete-${preset.id}` : undefined} onClick={() => confirmId === preset.id ? void run({ kind: 'delete', id: preset.id }) : void prepareDelete(preset.id)}>
            {confirmId === preset.id ? t('workspacePresets.confirm') : <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 4.5h10M6 4.5V2.5h4v2M4.5 4.5l.5 9h6l.5-9M6.5 7v4M9.5 7v4" /></svg>}
          </button>
          <span className="code-workspace-path" title={preset.cwd}>{preset.cwd}</span>
        </div>
        {confirmId === preset.id && <div id={`workspace-delete-${preset.id}`} className="code-workspace-delete-notice" role="status">
          <p>{t('workspacePresets.deleteReferences', { count: usage[preset.id] ?? 0 })}</p>
          <button type="button" disabled={busy} onClick={() => setConfirmId(null)}>{t('workspacePresets.cancel')}</button>
        </div>}
        {expanded && renderEditor()}
      </div>
    })}
  </section>
}
export default CodeWorkspaceSettings
