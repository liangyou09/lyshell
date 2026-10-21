import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatCodeWorkspaceName, type CodeWorkspacePreset, type CodeWorkspaceRequest } from '@shared/code-workspaces'
import { GroupListActions } from './GroupList'
import { buildWorkLauncherProjects, findManagedWorkspace, workLauncherTargetKey, type WorkLauncherAgent } from './work-launcher-tree'
import { buildWorkLauncherDirectories, type WorkLauncherDirectory } from './work-launcher-paths'
import { workspaceProjectHue } from './workspace-project-color'
import './WorkspaceLauncherTree.css'

const Folder = () => <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M2 4h4l2 2h6v7H2z" /></svg>
const Branch = () => <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><circle cx="4" cy="3" r="1.5"/><circle cx="12" cy="4" r="1.5"/><circle cx="4" cy="13" r="1.5"/><path d="M4 4.5v7M4 9c5 0 8-1 8-3.5"/></svg>
const Chevron: React.FC<{ open: boolean }> = ({ open }) => <svg className={`workspace-launcher-chevron${open ? ' is-open' : ''}`} width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>

interface LaunchTarget {
  key: string
  name: string
  cwd: string
  request: Extract<CodeWorkspaceRequest, { kind: 'launch' | 'launchDirectory' }>
}
const presetTarget = (preset: CodeWorkspacePreset): LaunchTarget => ({
  key: `preset:${preset.id}`, name: formatCodeWorkspaceName(preset), cwd: preset.cwd, request: { kind: 'launch', id: preset.id }
})

const WorkspaceLauncherTree = <T extends WorkLauncherAgent,>({ visible, onManage, agents = [], renderAgent, renderHeader, onPresetsChange, refreshKey = false }: {
  visible: boolean
  onManage?: () => void
  agents?: readonly T[]
  renderAgent?: (agent: T) => React.ReactNode
  renderHeader?: (controls: React.ReactNode) => React.ReactNode
  onPresetsChange?: (presets: CodeWorkspacePreset[]) => void
  refreshKey?: boolean
}) => {
  const { t } = useTranslation()
  const treeId = useId()
  const [presets, setPresets] = useState<CodeWorkspacePreset[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [launchingId, setLaunchingId] = useState<string | null>(null)
  const launching = useRef(false)
  const [launchError, setLaunchError] = useState<{ target: LaunchTarget; message: string } | null>(null)
  const [announcement, setAnnouncement] = useState('')

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    void (async () => {
      try {
        const result = await window.electronAPI?.codeWorkspaceRequest({ kind: 'list' })
        if (cancelled) return
        if (result?.success) { setPresets(result.presets); onPresetsChange?.(result.presets) }
        else setLoadError(result?.error || t('workspacePresets.failed'))
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : t('workspacePresets.failed'))
      } finally { if (!cancelled) setLoading(false) }
    })()
    return () => { cancelled = true }
    // 进入面板或显式重试时读取；切换语言不发起新请求。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, reload, refreshKey])

  const projects = useMemo(() => buildWorkLauncherProjects(presets, window.electronAPI?.platform ?? ''), [presets])
  const unassigned = useMemo(() => agents.filter(agent => !findManagedWorkspace(agent, presets, window.electronAPI?.platform ?? '')), [agents, presets])
  const directories = useMemo(() => buildWorkLauncherDirectories(projects, window.electronAPI?.platform ?? ''), [projects])
  const byTarget = useMemo(() => {
    const platform = window.electronAPI?.platform ?? ''
    const grouped = new Map<string, T[]>()
    for (const agent of agents) {
      const preset = findManagedWorkspace(agent, presets, platform)
      if (!preset) continue
      const key = workLauncherTargetKey(preset, platform)
      const list = grouped.get(key) ?? []
      list.push({ ...agent, cwd: preset.cwd, isolation: preset.isolation, worktreeKey: preset.worktreeKey })
      grouped.set(key, list)
    }
    return grouped
  }, [agents, presets])
  const agentsFor = (preset: Pick<CodeWorkspacePreset, 'cwd' | 'isolation' | 'worktreeKey'>): T[] => byTarget.get(workLauncherTargetKey(preset, window.electronAPI?.platform ?? '')) ?? []
  const expandableKeys = useMemo(() => {
    const keys: string[] = []
    const visit = (nodes: WorkLauncherDirectory[]): void => nodes.forEach(node => {
      if (node.children.length || node.project?.entries.some(entry => entry.isolation === 'worktree' || (byTarget.get(workLauncherTargetKey(entry, window.electronAPI?.platform ?? ''))?.length ?? 0) > 0)) keys.push(node.key)
      node.project?.entries.forEach(entry => {
        if (entry.isolation === 'worktree' && (byTarget.get(workLauncherTargetKey(entry, window.electronAPI?.platform ?? ''))?.length ?? 0) > 0) keys.push(`worktree:${entry.id}`)
      })
      visit(node.children)
    })
    visit(directories)
    if (unassigned.length) keys.push('unassigned')
    return keys
  }, [directories, byTarget, unassigned.length])
  const toggle = (key: string): void => setCollapsed(current => {
    const next = new Set(current)
    if (!next.delete(key)) next.add(key)
    return next
  })
  const launch = async (target: LaunchTarget): Promise<void> => {
    if (launching.current) return
    launching.current = true
    setLaunchingId(target.key)
    setLaunchError(null)
    setAnnouncement(t('workspacePresets.launching'))
    try {
      const result = await window.electronAPI?.codeWorkspaceRequest(target.request)
      if (!result?.success) {
        setLaunchError({ target, message: result?.error || t('workspacePresets.failed') })
        setAnnouncement('')
      } else setAnnouncement(t('agents.workspaceLaunched', { name: target.name }))
    } catch (error) {
      setLaunchError({ target, message: error instanceof Error ? error.message : t('workspacePresets.failed') })
      setAnnouncement('')
    } finally { launching.current = false; setLaunchingId(null) }
  }
  const launchButton = (target: LaunchTarget, label: string, worktree = false) => <button type="button" className="workspace-launcher-launch"
    aria-label={`${t('workspacePresets.launchPs7For', { name: target.name })} · ${target.cwd}`}
    title={target.cwd + (worktree ? ` · ${label}` : '')}
    disabled={launchingId !== null} aria-busy={launchingId === target.key} onClick={() => void launch(target)}>
    {worktree ? <Branch/> : <Folder/>}<span className="workspace-launcher-label">{label}</span>
    <span className="workspace-launcher-affordance" aria-hidden="true"><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m3 4 4 4-4 4M9 12h4"/></svg><span>PS7</span></span>
  </button>

  const renderDirectory = (node: WorkLauncherDirectory): React.ReactNode => {
    const worktrees = node.project?.entries.filter(entry => entry.isolation === 'worktree') ?? []
    const shared = node.project?.entries.find(entry => entry.isolation !== 'worktree')
    const directoryAgents = agentsFor(shared ?? { cwd: node.path, isolation: 'shared' })
    const expandable = node.children.length > 0 || worktrees.length > 0 || directoryAgents.length > 0
    const open = !collapsed.has(node.key)
    const childrenId = `${treeId}-${encodeURIComponent(node.key)}`
    const target: LaunchTarget = shared ? presetTarget(shared) : {
      key: `directory:${node.key}`, name: node.label, cwd: node.path,
      request: { kind: 'launchDirectory', id: node.project?.entries[0]?.id ?? node.sourceId, cwd: node.path }
    }
    return <li key={node.key} style={{ '--project-hue': workspaceProjectHue(node.project?.dir ?? node.path) } as React.CSSProperties}>
      <div className={`workspace-launcher-row${node.project ? ' is-workspace' : ' is-parent'}`}>
        {expandable ? <button type="button" className="workspace-launcher-disclosure" aria-label={t('agents.toggleDirectory', { name: node.path })} aria-expanded={open} aria-controls={childrenId} onClick={() => toggle(node.key)}><Chevron open={open}/></button>
          : <span className="workspace-launcher-disclosure"/>}
        {launchButton(target, node.label)}
      </div>
      {expandable && <ul id={childrenId} hidden={!open}>
        {node.children.map(renderDirectory)}
        {worktrees.map(preset => {
          const items = agentsFor(preset)
          const key = `worktree:${preset.id}`
          const open = !collapsed.has(key)
          const groupId = `${treeId}-${encodeURIComponent(key)}`
          return <li key={preset.id}>
          <div className="workspace-launcher-row is-worktree">
            {items.length ? <button type="button" className="workspace-launcher-disclosure" aria-label={t('agents.toggleDirectory', { name: formatCodeWorkspaceName(preset) })} aria-expanded={open} aria-controls={groupId} onClick={() => toggle(key)}><Chevron open={open}/></button> : <span className="workspace-launcher-disclosure"/>}
            {launchButton(presetTarget(preset), preset.worktreeKey ?? preset.name, true)}
          </div>
          {items.length > 0 && <ul id={groupId} hidden={!open}>{items.map(renderAgentItem)}</ul>}
        </li>})}
        {directoryAgents.map(renderAgentItem)}
      </ul>}
    </li>
  }

  function renderAgentItem(agent: T): React.ReactNode {
    return <li key={agent.id} className="workspace-launcher-agent">{renderAgent?.(agent)}</li>
  }
  const controls = expandableKeys.length > 0 ? <GroupListActions allCollapsed={expandableKeys.every(key => collapsed.has(key))} allExpanded={expandableKeys.every(key => !collapsed.has(key))} onChange={value => setCollapsed(value ? new Set(expandableKeys) : new Set())}/> : null
  return <>{renderHeader ? renderHeader(controls) : controls}<section className="workspace-launcher" aria-label={t('agents.workLauncher')}>
    {loading && presets.length === 0 && <div className="workspace-launcher-message" role="status">{t('workspacePresets.loading')}</div>}
    {loadError && <div className="workspace-launcher-error" role="alert"><span>{loadError}</span><button type="button" disabled={loading} onClick={() => setReload(value => value + 1)}>{t('workspacePresets.retry')}</button></div>}
    {!loading && !loadError && projects.length === 0 && unassigned.length === 0 && <div className="workspace-launcher-message"><p>{t('workspacePresets.empty')}</p>{onManage && <button type="button" onClick={onManage}>{t('workspacePresets.add')}</button>}</div>}
    {(!loading || presets.length > 0) && (projects.length > 0 || unassigned.length > 0) && <div className="workspace-launcher-viewport rack-scroll" aria-busy={loading}><ul className="workspace-launcher-roots" aria-label={t('agents.workspacePaths')}>{directories.map(renderDirectory)}
      {unassigned.length > 0 && <li>
        <div className="workspace-launcher-row">
          <button type="button" className="workspace-launcher-disclosure" aria-label={t('agents.toggleDirectory', { name: t('workspacePresets.unassigned') })} aria-expanded={!collapsed.has('unassigned')} aria-controls={`${treeId}-unassigned`} onClick={() => toggle('unassigned')}><Chevron open={!collapsed.has('unassigned')}/></button>
          <span className="workspace-launcher-unassigned"><Folder/><span className="workspace-launcher-label">{t('workspacePresets.unassigned')} ({unassigned.length})</span></span>
        </div>
        <ul id={`${treeId}-unassigned`} hidden={collapsed.has('unassigned')}>{unassigned.map(renderAgentItem)}</ul>
      </li>}
    </ul></div>}
    {launchError && <div className="workspace-launcher-error" role="alert"><span>{launchError.target.name}: {launchError.message}</span><button type="button" disabled={launchingId !== null} onClick={() => void launch(launchError.target)}>{t('workspacePresets.retry')}</button></div>}
    <div className="workspace-launcher-status" role="status" aria-live="polite">{announcement}</div>
  </section></>
}

export default WorkspaceLauncherTree
