import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { CodeWorkspacePreset } from '@shared/code-workspaces'
import type { ProjectScene, SceneTarget } from '@shared/project-scene'
import { presetSceneTarget, sameSceneProject, sceneProjectName, sceneResourceCount, shortSceneDirectory, useProjectSceneUI, sceneTargetKey } from '../../stores/project-scene-ui'
import './ProjectScene.css'
import { useWorkbenchActivity } from '../../stores/workbench-activity'

function useSceneText() {
  const { i18n } = useTranslation()
  return (zh: string, en: string) => i18n?.language?.startsWith('en') ? en : zh
}
function savedTime(scene: ProjectScene, english: boolean): string {
  return new Date(scene.savedAt).toLocaleString(english ? 'en-US' : 'zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
const targetId = (target: SceneTarget) => `${target.presetId}:${sceneTargetKey(target)}`

/** 目录本身旁边操作现场，不要求在两个下拉框之间匹配路径。侧栏里只保留图标，与 PS7 同为 28px。 */
export function ProjectSceneProjectActions({ preset, showName = false }: { preset: CodeWorkspacePreset; showName?: boolean }) {
  const text = useSceneText()
  const { scenes, busy, refresh, save, continue: resume, openMenu } = useProjectSceneUI()
  useEffect(() => { void refresh() }, [refresh])
  if (!window.electronAPI?.projectSceneRequest) return null
  const target = presetSceneTarget(preset)
  const latest = scenes.find(scene => sameSceneProject(scene.target, target))
  const name = sceneProjectName(target, [preset])
  const continueLabel = text('继续上次工作', 'Continue work')
  const saveLabel = text('保存现场', 'Save scene')
  const historyLabel = text('历史', 'History')
  return <div className={`project-scene-inline${showName ? ' has-name' : ''}`} data-project-scene-target={targetId(target)} aria-label={text(`${name} 的项目现场`, `${name} project scene`)}>
    {showName && <strong className="project-scene-inline-name" title={preset.cwd}>{sceneProjectName(target, [preset])}</strong>}
    {latest && <button className="project-scene-primary" disabled={busy} aria-label={continueLabel} title={continueLabel} onClick={() => void resume(latest)}>
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5.6 3.6 12.4 8l-6.8 4.4z"/></svg>
    </button>}
    {latest && <button className="project-scene-history" disabled={busy} aria-label={historyLabel} title={historyLabel} onClick={() => openMenu('history', target)}>
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="5.6"/><path d="M8 4.9v3.4l2.2 1.4"/></svg>
    </button>}
    <button className="project-scene-save" disabled={busy} aria-label={saveLabel} title={saveLabel} onClick={() => void save(target)}>
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M13.5 13.5h-11v-11h7.5l3.5 3.5z"/><path d="M5.6 2.5v3.5h4.2v-3.5"/><path d="M5.6 13.5v-4h5.2v4"/></svg>
    </button>
    {window.electronAPI?.workbenchActivityRequest && <button className="project-scene-activity" aria-label={text('查看项目会话与任务', 'View project sessions and tasks')} title={text('查看项目会话与任务', 'View project sessions and tasks')} onClick={() => void useWorkbenchActivity.getState().showProject(target)}>
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M2 3.5h12v9H2zM5 6h6M5 9h4"/></svg>
    </button>}
  </div>
}

export function ProjectSceneBar({ showBar = true }: { showBar?: boolean }) {
  const text = useSceneText()
  const { presets, scenes, selected, loaded, busy, notice, menu, refresh, select, save, continue: resume, openMenu } = useProjectSceneUI()
  const barRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: 8, bottom: 48, width: 420, maxHeight: 420 })
  const [query, setQuery] = useState('')
  const [allHistory, setAllHistory] = useState(false)
  const selectedKey = selected ? targetId(selected) : ''
  const focusProjectControl = useCallback(() => {
    const project = barRef.current?.querySelector<HTMLButtonElement>('.project-scene-project')
    const inline = [...document.querySelectorAll<HTMLElement>('[data-project-scene-target]')].find(item => item.dataset.projectSceneTarget === selectedKey && item.getBoundingClientRect().height > 0)
    const control = project ?? inline?.querySelector<HTMLButtonElement>('button:last-child')
    control?.focus()
  }, [selectedKey])
  const english = text('zh', 'en') === 'en'
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => { setQuery(''); setAllHistory(false) }, [menu, selectedKey])
  useLayoutEffect(() => {
    if (!menu) return
    const measure = () => {
      const rect = barRef.current?.getBoundingClientRect()
      const width = Math.min(440, window.innerWidth - 16)
      const left = rect?.left ?? document.querySelector('.terminal-wrapper')?.getBoundingClientRect().left ?? 0
      const bottom = rect ? window.innerHeight - rect.top + 6 : 16
      setPosition({ left: Math.max(8, Math.min(left + 8, window.innerWidth - width - 8)), bottom, width, maxHeight: Math.min(440, window.innerHeight - bottom - 16) })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [menu, showBar])
  useEffect(() => {
    if (!menu) return
    const outside = (event: PointerEvent) => {
      if (!barRef.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) openMenu(null)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      openMenu(null); focusProjectControl()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape, true)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true) }
  }, [menu, openMenu, focusProjectControl])
  if (!window.electronAPI?.projectSceneRequest) return null

  const currentPreset = selected && presets.find(preset => sameSceneProject(presetSceneTarget(preset), selected))
  const latest = selected && scenes.find(scene => sameSceneProject(scene.target, selected))
  const projects = new Map<string, SceneTarget>()
  presets.forEach(preset => { const target = presetSceneTarget(preset); projects.set(targetId(target), target) })
  scenes.forEach(scene => { if (!projects.has(targetId(scene.target))) projects.set(targetId(scene.target), scene.target) })
  const filteredProjects = [...projects.values()].filter(target => `${sceneProjectName(target, presets)} ${target.cwd}`.toLowerCase().includes(query.toLowerCase()))
  const history = scenes.filter(scene => (allHistory || !selected || sameSceneProject(scene.target, selected)) && `${sceneProjectName(scene.target, presets)} ${scene.target.cwd}`.toLowerCase().includes(query.toLowerCase()))
  const status = !notice ? '' : notice.kind === 'saved' ? text('现场已保存', 'Scene saved') : notice.kind === 'focused' ? text('已定位打开的现场', 'Focused open scene') : notice.kind === 'restored' ? text(`已恢复 ${notice.count} 个入口 · 进程未启动`, `${notice.count} entries restored · processes stopped`) : notice.kind === 'empty' ? text('暂无有效资源可恢复', 'No valid resources to restore') : text('操作未完成', 'Action failed')
  function toggleMenu(next: 'projects' | 'history') {
    setQuery(''); setAllHistory(false)
    openMenu(menu === next ? null : next)
    if (menu !== next) void refresh(true)
  }
  function dismissMenu() {
    openMenu(null)
    focusProjectControl()
  }
  return <>
    {showBar && <div ref={barRef} className="project-scene-bar win-no-drag" aria-label={text('项目现场', 'Project scenes')} aria-busy={busy}>
    <div className="project-scene-controls">
      <button className="project-scene-project" disabled={busy} aria-expanded={menu === 'projects'} aria-controls="project-scene-menu" onClick={() => toggleMenu('projects')} title={selected?.cwd}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><path d="M2 4h4l2 2h6v7H2z"/></svg>
        <span>{selected ? sceneProjectName(selected, presets) : text(loaded ? '选择项目' : '正在读取项目…', loaded ? 'Choose project' : 'Loading projects…')}</span>
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" aria-hidden="true"><path d="m3 4 3 3 3-3"/></svg>
      </button>
      <span className="project-scene-last">{latest ? text(`保存于 ${savedTime(latest, english)}`, `Saved ${savedTime(latest, english)}`) : text('手动保存 · 关闭不覆盖', 'Manual save · no overwrite on exit')}</span>
      {latest && <button className="project-scene-primary" disabled={busy} onClick={() => void resume(latest)}>{text('继续上次工作', 'Continue work')}</button>}
      <button disabled={busy || !currentPreset} onClick={() => selected && void save(selected)}>{text('保存现场', 'Save scene')}</button>
      <button disabled={!scenes.length || busy} aria-expanded={menu === 'history'} aria-controls="project-scene-menu" onClick={() => toggleMenu('history')}>{text('历史', 'History')}</button>
      {notice && <span className="project-scene-feedback" role="status" aria-live="polite">{status}</span>}
      {!!notice?.issues.length && <details className="project-scene-notice"><summary>{text(`${notice.issues.length} 项提示`, `${notice.issues.length} notices`)}</summary><div className="project-scene-issues rack-scroll"><ul>{notice.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>{notice.kind === 'error' && <button onClick={() => void refresh(true)}>{text('重新读取项目', 'Reload projects')}</button>}</div></details>}
    </div>
    </div>}
    {menu && createPortal(<div ref={menuRef} id="project-scene-menu" role="dialog" aria-label={text('项目现场选择', 'Project scene selection')} className="project-scene-menu win-no-drag" style={position}>
      <header><div className="project-scene-menu-tabs" role="group" aria-label={text('现场视图', 'Scene view')}><button aria-pressed={menu === 'projects'} onClick={() => openMenu('projects')}>{text('项目', 'Projects')}</button><button aria-pressed={menu === 'history'} onClick={() => openMenu('history')}>{text('保存记录', 'Saved scenes')}</button></div><button onClick={dismissMenu} aria-label={text('关闭现场选择', 'Close scene selection')}>{text('关闭', 'Close')}</button></header>
      <input autoFocus aria-label={text('查找项目', 'Find project')} placeholder={text('查找项目或目录', 'Find project or directory')} value={query} onChange={event => setQuery(event.target.value)}/>
      {!showBar && notice && <div className="project-scene-help rack-scroll"><p role="status">{status}</p>{!!notice.issues.length && <details><summary>{text(`${notice.issues.length} 项提示`, `${notice.issues.length} notices`)}</summary><ul>{notice.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></details>}</div>}
      {menu === 'history' && selected && <div className="project-scene-history-scope"><span>{allHistory ? text('全部项目', 'All projects') : sceneProjectName(selected, presets)}</span><button aria-pressed={allHistory} onClick={() => setAllHistory(value => !value)}>{allHistory ? text('只看此项目', 'This project only') : text('全部项目', 'All projects')}</button></div>}
      <div className="project-scene-menu-list rack-scroll">
        {menu === 'projects' ? filteredProjects.map(target => {
          const preset = presets.find(item => sameSceneProject(presetSceneTarget(item), target))
          const recent = scenes.find(scene => sameSceneProject(scene.target, target))
          return <div className="project-scene-menu-row" key={targetId(target)}>
            <button className="project-scene-choice" disabled={busy} aria-pressed={!!selected && sameSceneProject(selected, target)} title={target.cwd} onClick={() => { select(target); dismissMenu() }}><strong>{sceneProjectName(target, presets)}</strong><span>{shortSceneDirectory(target.cwd)}{!preset ? text(' · 预设已删除', ' · preset removed') : ''}</span></button>
            <div className="project-scene-menu-row-actions"><small>{recent ? savedTime(recent, english) : text('尚未保存', 'No saved scene')}</small>{recent ? <button className="project-scene-primary" disabled={busy} onClick={() => void resume(recent)}>{text('继续', 'Continue')}</button> : <button disabled={busy || !preset} onClick={() => void save(target)}>{text('保存现场', 'Save scene')}</button>}</div>
          </div>
        }) : history.map(scene => <div className="project-scene-menu-row" key={scene.id}><div className="project-scene-choice"><strong>{sceneProjectName(scene.target, presets)}</strong><span>{savedTime(scene, english)} · {text(`${sceneResourceCount(scene.root)} 个入口`, `${sceneResourceCount(scene.root)} entries`)}</span></div><button disabled={busy} onClick={() => void resume(scene)}>{text('恢复此现场', 'Restore scene')}</button></div>)}
        {!(menu === 'projects' ? filteredProjects.length : history.length) && <p className="project-scene-menu-empty">{text(menu === 'projects' ? '没有匹配的项目。请先在设置中添加目录预设。' : '这个项目还没有保存的现场。', menu === 'projects' ? 'No matching projects. Add a directory preset in Settings.' : 'No saved scenes for this project yet.')}</p>}
      </div>
      <details className="project-scene-help"><summary>{text('保存与恢复范围', 'What gets restored')}</summary><p>{text('手动保留最近 30 份现场。恢复文档、网页入口与布局，终端和 Agent 等待你启动；不会重跑命令或提交任务。', 'Manually keeps the latest 30 scenes. Restores documents, web links and layout; terminals and Agents wait for you to start them. Commands and tasks are never replayed.')}</p><p>{text('不保存凭据、编辑或表单状态；认证、一次性和带参数的网页会跳过。', 'Credentials, edits and forms are excluded; authentication, one-time and parameterized web links are skipped.')}</p></details>
    </div>, document.body)}
  </>
}
