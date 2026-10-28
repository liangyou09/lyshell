import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useTaskShelf, initializeTaskShelf, shelfEntryVisible, shelfResource, collectActiveShelfTask } from '../../stores/task-shelf'
import { matchShelfShortcut } from '@shared/task-shelf'
import { TaskShelfContextMenu, showShelfEntryContextMenu } from './TaskShelfContextMenu'
import { usePaneStore } from '../../stores/pane-store'
import { useSessionStore } from '../../stores/session-store'
import { useWorkbenchActivity } from '../../stores/workbench-activity'
import { OVERLAY_DRAG_MARKER } from './overlay-drag'
import { shelfDocked, shelfPanelWidth, shelfGridLayout, SHELF_PREVIEW_WIDTH, SHELF_INPUT_WIDTH, type ShelfMode } from './task-shelf-layout'
import TaskShelfPreview from './TaskShelfPreview'
import TaskShelfLiveSurface from './TaskShelfLiveSurface'
import TaskShelfBrowserBar from './TaskShelfBrowserBar'
import { isShelfSurfaceEngaged, refreshShelfSurfaces, SHELF_SURFACE_ENTER, SHELF_SURFACE_LEAVE } from './task-shelf-surfaces'
import { resolveShelfTaskStatus } from './task-shelf-status'
import { showShelfNotice } from './task-shelf-navigation'
import { activityNoticeTitle, activityProjectName } from './ActivityNotifications'
import './TaskShelf.css'
import { useFrameCommit } from '../../hooks/useFrameCommit'
import { useShallow } from 'zustand/react/shallow'

const PREF_KEY = 'lyshell.taskShelf.view.v1'
function readPreferences(): { mode: ShelfMode; width: number } {
  try {
    const saved = JSON.parse(localStorage.getItem(PREF_KEY) || '{}')
    return { mode: ['auto', 'hover', 'fixed'].includes(saved.mode) ? saved.mode : 'auto', width: Number.isFinite(saved.width) ? shelfPanelWidth(saved.width, Infinity) : 304 }
  } catch { return { mode: 'auto', width: 304 } }
}

export function ShelfIcon({ kind = 'shelf' }: { kind?: string }): React.ReactElement {
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === 'terminal' ? <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3m6 0h4" /></>
      : kind === 'web' ? <><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18" /></>
      : kind === 'harness' ? <><path d="m12 3 3 6 6 3-6 3-3 6-3-6-6-3 6-3z" /></>
      : <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M15 3v18M6 8h6M6 12h6M6 16h4" /></>}
  </svg>
}

const TaskShelf: React.FC = () => {
  const { t, i18n } = useTranslation()
  // 快捷键只在设置 → 终端 里修改(见 SettingsPanel)，保存区只消费当前绑定。
  const { entries, bindings, loaded, busy, error, saveErrors, open, retry, archive, viewRequest, preferences: shortcuts } = useTaskShelf(useShallow(s => ({
    entries: s.entries, bindings: s.bindings, loaded: s.loaded, busy: s.busy, error: s.error, saveErrors: s.saveErrors,
    open: s.open, retry: s.retry, archive: s.archive, viewRequest: s.viewRequest, preferences: s.preferences
  })))
  const draggingSession = usePaneStore(s => s.draggingSessionId)
  const draggingOverlay = usePaneStore(s => s.draggingOverlayId)
  // 显隐、状态与工作台事件分别驱动列表，不以静默输出推断完成。
  usePaneStore(s => s.layout)
  const hiddenSessions = usePaneStore(s => s.hiddenTabSessions)
  const sessions = useSessionStore(s => s.sessions)
  const activity = useWorkbenchActivity(s => s.snapshot)
  const notices = useWorkbenchActivity(s => s.notices)
  const unreadNoticeIds = useWorkbenchActivity(s => s.unreadNoticeIds)
  const [preferences, setPreferences] = useState(readPreferences)
  const [available, setAvailable] = useState(1200)
  const [windowWidth, setWindowWidth] = useState(window.innerWidth)
  const [docked, setDocked] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [dropOver, setDropOver] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [resizing, setResizing] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [showNotices, setShowNotices] = useState(false)
  const [now, setNow] = useState(Date.now)
  const root = useRef<HTMLElement>(null)
  const edge = useRef<HTMLButtonElement>(null)
  const keyboardOpen = useRef(false)
  const panelId = useId()
  const resizeStart = useRef<{ x: number; width: number }>()
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>()
  const closeTimer = useRef<ReturnType<typeof setTimeout>>()
  const width = shelfPanelWidth(preferences.width, available, windowWidth)
  const resizeCommit = useFrameCommit<number>(next => setPreferences(p => p.width === next ? p : { ...p, width: next }))
  const finishResize = () => { resizeCommit.flush(); resizeStart.current = undefined; setResizing(false) }
  const showPreviews = width >= SHELF_PREVIEW_WIDTH
  const inputWidth = Math.min(SHELF_INPUT_WIDTH, shelfPanelWidth(Infinity, available, windowWidth))
  const canDrop = !!draggingSession || !!draggingOverlay && ['web', 'dshWeb'].includes(usePaneStore.getState().overlayPayloads[draggingOverlay]?.kind)
  const shown = docked || expanded || pinned || (canDrop && dropOver)

  useEffect(() => initializeTaskShelf(), [])
  useLayoutEffect(() => { refreshShelfSurfaces() })
  useLayoutEffect(() => {
    const parent = root.current?.parentElement
    if (!parent) return
    const update = () => { if (parent.clientWidth > 0) setAvailable(parent.clientWidth); setWindowWidth(window.innerWidth) }
    update()
    const observer = new ResizeObserver(update); observer.observe(parent)
    window.addEventListener('resize', update)
    return () => { observer.disconnect(); window.removeEventListener('resize', update) }
  }, [])
  useEffect(() => {
    const timer = setTimeout(() => setDocked(old => shelfDocked(preferences.mode, windowWidth, available, width, old)), 180)
    return () => clearTimeout(timer)
  }, [preferences.mode, windowWidth, available, width])
  useLayoutEffect(() => {
    const reservedWidth = docked ? width : 0
    if (useTaskShelf.getState().reservedWidth !== reservedWidth) useTaskShelf.setState({ reservedWidth })
  }, [docked, width])
  useLayoutEffect(() => () => { useTaskShelf.setState({ reservedWidth: 0 }) }, [])
  // 在 inert 生效前记录焦点，确保按钮、快捷键及外部请求收起时都能归还入口。
  useLayoutEffect(() => {
    const restoreFocus = !shown && root.current?.contains(document.activeElement)
    root.current?.toggleAttribute('inert', !shown)
    if (shown && keyboardOpen.current) {
      root.current?.querySelector<HTMLElement>('button:not([disabled])')?.focus()
    } else if (restoreFocus) edge.current?.focus()
    keyboardOpen.current = false
  }, [shown])
  useLayoutEffect(() => {
    useTaskShelf.setState({ panelVisible: shown })
    return () => { useTaskShelf.setState({ panelVisible: false }) }
  }, [shown])
  useEffect(() => {
    if (!shown) return
    const timer = setInterval(() => setNow(Date.now()), 4000)
    return () => clearInterval(timer)
  }, [shown])
  useEffect(() => {
    if (!viewRequest) return
    clearTimeout(hoverTimer.current); clearTimeout(closeTimer.current)
    setPinned(viewRequest.open); setExpanded(false); setDropOver(false)
    setShowNotices(!!viewRequest.notices)
    if (viewRequest.entryId) {
      setSelected(viewRequest.entryId)
      setShowArchived(!!useTaskShelf.getState().entries.find(entry => entry.id === viewRequest.entryId)?.archivedAt)
      setPreferences(p => ({ ...p, width: Math.max(p.width, SHELF_PREVIEW_WIDTH) }))
    }
    if (!viewRequest.open) { setDocked(false); setPreferences(p => ({ ...p, mode: 'hover' })) }
  }, [viewRequest])
  useEffect(() => {
    if (!shown || !selected) return
    const node = [...root.current?.querySelectorAll<HTMLElement>('[data-shelf-entry]') ?? []].find(el => el.dataset.shelfEntry === selected)
    node?.scrollIntoView?.({ block: 'nearest' })
  }, [shown, selected, viewRequest])
  useEffect(() => {
    if (!canDrop && dropOver) { setDropOver(false); setExpanded(false) }
  }, [canDrop, dropOver])
  useEffect(() => {
    if (resizing) return
    try { localStorage.setItem(PREF_KEY, JSON.stringify(preferences)) } catch { /* 保留本次布局 */ }
  }, [preferences, resizing])
  useEffect(() => () => { clearTimeout(hoverTimer.current); clearTimeout(closeTimer.current) }, [])
  useEffect(() => {
    const run = (action: 'toggle' | 'collect') => {
      if (action === 'toggle') {
        if (docked) { closePanel(); setDocked(false); setPreferences(p => ({ ...p, mode: 'hover' })) }
        else { clearTimeout(hoverTimer.current); setExpanded(false); setPinned(value => !value) }
      }
      else void collectActiveShelfTask()
    }
    const off = window.electronAPI?.onTaskShelfShortcut?.(run)
    const handle = (event: KeyboardEvent) => {
      if (!off) {
        const action = matchShelfShortcut({ type: 'keyDown', key: event.key, control: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey, alt: event.altKey, isAutoRepeat: event.repeat, isComposing: event.isComposing }, shortcuts)
        if (action) { event.preventDefault(); event.stopPropagation(); run(action) }
      }
      if (event.key === 'Escape' && (expanded || pinned) && !resizing && !isShelfSurfaceEngaged()) closePanel()
    }
    window.addEventListener('keydown', handle)
    return () => { off?.(); window.removeEventListener('keydown', handle) }
  }, [expanded, pinned, resizing, shortcuts, docked])

  const enter = () => { clearTimeout(closeTimer.current); clearTimeout(hoverTimer.current); hoverTimer.current = setTimeout(() => setExpanded(true), 250) }
  // 键盘聚焦入口只取消待执行的收起，不在 250ms 后自动展开并把入口自身藏掉；
  // 展开由 Enter/Space 触发，细柄焦点环继续作为可见入口。
  const holdEntryFocus = () => { clearTimeout(closeTimer.current); clearTimeout(hoverTimer.current) }
  const closePanel = () => {
    clearTimeout(hoverTimer.current); clearTimeout(closeTimer.current)
    setExpanded(false); setPinned(false); setDropOver(false)
  }
  const leave = useCallback(() => {
    clearTimeout(hoverTimer.current)
    closeTimer.current = setTimeout(() => { if (!root.current?.contains(document.activeElement) && !document.activeElement?.closest('.task-shelf-context-menu') && !isShelfSurfaceEngaged() && !resizing) setExpanded(false); setDropOver(false) }, 350)
  }, [resizing])
  useEffect(() => {
    const hold = () => { clearTimeout(closeTimer.current); clearTimeout(hoverTimer.current) }
    const release = () => leave()
    window.addEventListener(SHELF_SURFACE_ENTER, hold)
    window.addEventListener(SHELF_SURFACE_LEAVE, release)
    return () => { window.removeEventListener(SHELF_SURFACE_ENTER, hold); window.removeEventListener(SHELF_SURFACE_LEAVE, release) }
  }, [leave])
  const handleDrop = async (event: React.DragEvent) => {
    if (!canDrop) return
    event.preventDefault(); event.stopPropagation(); setDropOver(false)
    const pane = usePaneStore.getState()
    const kind = pane.draggingSessionId ? 'terminal' : pane.overlayPayloads[pane.draggingOverlayId || '']?.kind === 'dshWeb' ? 'harness' : 'web'
    const resource = shelfResource(kind, pane.draggingSessionId || pane.draggingOverlayId || '')
    pane.setDraggingSession(null); pane.setDraggingOverlay(null)
    if (resource) { const saved = await useTaskShelf.getState().collect(resource); if (saved) closePanel() }
  }
  const attention = (error ? 1 : 0) + entries.filter(entry => {
    const binding = bindings[entry.id]
    const status = resolveShelfTaskStatus(entry, binding, activity, sessions.find(s => s.id === binding?.id)?.status, Math.max(now, Date.now()))
    return !!saveErrors[entry.id] || status === 'failed' || status === 'approval'
  }).length
  const displayedEntries = entries.filter(entry => !!entry.archivedAt === showArchived)
  const selectedEntry = displayedEntries.find(entry => entry.id === selected) ?? displayedEntries.find(entry => !shelfEntryVisible(entry.id)) ?? displayedEntries[0]
  const focusedId = selectedEntry?.id
  const focusedWindows = showPreviews ? displayedEntries.filter(entry => !shelfEntryVisible(entry.id) && !!bindings[entry.id]) : []
  const grid = shelfGridLayout(width, displayedEntries.length)
  const openInMain = async (id: string) => {
    const entry = entries.find(item => item.id === id)
    if (entry?.archivedAt && !await archive(id, false)) return
    if (await open(id)) closePanel()
  }

  const dragOver = (event: React.DragEvent) => {
    if (canDrop) { clearTimeout(hoverTimer.current); clearTimeout(closeTimer.current); event.preventDefault(); event.stopPropagation(); setExpanded(true); setDropOver(true); event.dataTransfer.dropEffect = 'move' }
  }

  return <>
    <TaskShelfContextMenu />
    <button ref={edge} className={`task-shelf-edge win-no-drag ${shown ? 'is-open' : ''} ${canDrop ? 'is-drop-target' : ''}`} aria-controls={panelId} aria-expanded={shown}
      tabIndex={shown ? -1 : 0} aria-label={t('taskShelf.toggleHint', { shortcut: shortcuts.toggleShortcut || '—' })}
      onMouseEnter={enter} onMouseLeave={leave} onFocus={holdEntryFocus} onBlur={leave}
      onClick={event => {
        clearTimeout(hoverTimer.current); clearTimeout(closeTimer.current)
        // detail 为 0 说明是键盘 Enter/Space 触发，打开后把焦点移入面板。
        if (event.detail === 0) keyboardOpen.current = true
        setPinned(true)
      }}
      onDragOver={dragOver} onDrop={event => { void handleDrop(event) }}>
      {attention > 0 && <span className="task-shelf-handle-dot" />}
    </button>
    <aside ref={root} id={panelId} className={`task-shelf win-no-drag ${shown ? 'is-open' : ''} ${docked ? 'is-docked' : ''} ${dropOver ? 'is-drop' : ''} ${showPreviews ? 'has-previews' : ''}`}
    style={{ width }} aria-hidden={!shown} aria-label={t('taskShelf.title')} onMouseEnter={enter} onMouseLeave={leave}
    onFocus={enter} onBlur={leave} onDragOver={dragOver} onDragLeave={event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { setDropOver(false); leave() }
    }} onDrop={event => { void handleDrop(event) }}>
    <div className="task-shelf-panel">
      <div className="task-shelf-resizer" role="separator" aria-label={t('taskShelf.resize')} aria-orientation="vertical" tabIndex={0}
        onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setPreferences(p => ({ ...p, width: shelfPanelWidth(width + (event.key === 'ArrowLeft' ? 16 : -16), available, windowWidth) })) } }}
        onPointerDown={event => { if (event.button !== 0) return; resizeStart.current = { x: event.clientX, width }; setResizing(true); event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault() }}
        onPointerMove={event => { const start = resizeStart.current; if (start) resizeCommit.schedule(shelfPanelWidth(start.width + start.x - event.clientX, available, windowWidth)) }}
        onPointerUp={finishResize} onPointerCancel={finishResize} onLostPointerCapture={finishResize} />
      <header className="task-shelf-header"><div className="task-shelf-heading"><h2>{t('taskShelf.shortTitle')}{attention > 0 && <span className="task-shelf-attention" aria-label={t('taskShelf.attention', { count: attention })} />}</h2></div>
        <div className="task-shelf-modes" role="group" aria-label={t('taskShelf.displayMode')}>
          {(['auto', 'hover', 'fixed'] as const).map(mode => <button key={mode} aria-pressed={preferences.mode === mode} onClick={() => setPreferences(p => ({ ...p, mode }))}>{t(`taskShelf.mode.${mode}`)}</button>)}
        </div>
        <button className="task-shelf-icon-button" title={t('taskShelf.collapse')} aria-label={t('taskShelf.collapse')} onClick={() => { closePanel(); if (docked) { setDocked(false); setPreferences(p => ({ ...p, mode: 'hover' })) } }}><svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m7 4 6 6-6 6" /></svg></button>
      </header>
      <div className="task-shelf-views" role="tablist" aria-label={t('taskShelf.taskViews')} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const current = showNotices ? 2 : showArchived ? 1 : 0
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (current + (event.key === 'ArrowLeft' ? 2 : 1)) % 3
        setShowArchived(next === 1); setShowNotices(next === 2)
        event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
      }}>
        <button role="tab" tabIndex={!showArchived && !showNotices ? 0 : -1} aria-selected={!showArchived && !showNotices} onClick={() => { setShowArchived(false); setShowNotices(false) }}>{t('taskShelf.activeTasks')} {entries.filter(entry => !entry.archivedAt).length}</button>
        <button role="tab" tabIndex={showArchived && !showNotices ? 0 : -1} aria-selected={showArchived && !showNotices} onClick={() => { setShowArchived(true); setShowNotices(false) }}>{t('taskShelf.archivedTasks')} {entries.filter(entry => !!entry.archivedAt).length}</button>
        <button role="tab" tabIndex={showNotices ? 0 : -1} aria-selected={showNotices} onClick={() => setShowNotices(true)}>{t('taskShelf.notices')} {unreadNoticeIds.length}</button>
      </div>
      {error && <div className="task-shelf-error" role="alert"><span>{error}</span><button onClick={() => { void retry() }}>{t('taskShelf.retry')}</button></div>}
      {canDrop && <div className="task-shelf-drop-target">{t('taskShelf.drop')}</div>}
      {!showNotices && <div className="task-shelf-grid" role="group" aria-label={t('taskShelf.gridLabel')} style={{ gridTemplateColumns: `repeat(${grid.columns}, minmax(0, 1fr))` }}>
        {displayedEntries.map((entry, index) => {
          const binding = bindings[entry.id]
          const inMain = shelfEntryVisible(entry.id)
          const status = resolveShelfTaskStatus(entry, binding, activity, sessions.find(s => s.id === binding?.id)?.status, Math.max(now, Date.now()))
          return <button key={entry.id} className={`task-shelf-tile ${focusedId === entry.id ? 'is-selected' : ''} ${inMain ? 'is-in-main' : ''}`}
            aria-label={t('taskShelf.slot', { index: index + 1 })} title={[entry.title, entry.workspace, t(`taskShelf.activityStatus.${status}`), inMain ? t('taskShelf.inMain') : ''].filter(Boolean).join('\n')}
            disabled={busy[entry.id]} onFocus={() => setSelected(entry.id)} onContextMenu={event => showShelfEntryContextMenu(event, entry.id)}
            onClick={() => {
              setSelected(entry.id)
              if (!showPreviews || inMain || !binding) void openInMain(entry.id)
              else [...root.current?.querySelectorAll<HTMLElement>('[data-shelf-entry]') ?? []].find(node => node.dataset.shelfEntry === entry.id)?.scrollIntoView?.({ block: 'nearest' })
            }}>
            <span className="task-shelf-tile-surface">{shown && binding && !inMain
              ? <TaskShelfPreview kind={binding.kind} id={binding.id} variant="tile" fallback={<ShelfIcon kind={entry.recovery.kind} />} />
              : <span className="task-shelf-tile-location"><ShelfIcon kind={entry.recovery.kind} />{inMain && <span>{t('taskShelf.mainWindow')}</span>}</span>}</span>
            <span className="task-shelf-tile-label">{entry.title}</span>
            <span className="task-shelf-tile-state"><span className={`task-shelf-status-dot is-${status}`} role="img" aria-label={t(`taskShelf.activityStatus.${status}`)} /><span>{inMain ? t('taskShelf.mainWindow') : status === 'unknown' ? t(`taskShelf.type.${entry.recovery.kind}`) : t(`taskShelf.activityStatus.${status}`)}</span></span>
          </button>
        })}
        {Array.from({ length: grid.slots - displayedEntries.length }, (_, index) => <span key={`empty-${index}`} className="task-shelf-tile is-empty" aria-hidden="true" />)}
      </div>}
      <div className={`task-shelf-list ${showPreviews && !showNotices ? 'has-live-windows' : ''}`}>
        {!loaded && <span className="task-shelf-loading" role="status">{t('taskShelf.loading')}</span>}
        {showNotices && <div className="task-shelf-notices">{notices.map(notice => <button key={notice.id} className={`task-shelf-notice ${unreadNoticeIds.includes(notice.id) ? 'is-unread' : ''}`} onClick={() => {
          const state = useWorkbenchActivity.getState(); state.markRead(notice.id)
          if (!showShelfNotice(notice)) state.show(notice.workspace, notice.sessionId)
        }}><span>{activityProjectName(notice.workspace)}</span><strong>{activityNoticeTitle(notice, i18n.language.startsWith('en'))}</strong></button>)}
          <button className="task-shelf-notice-history" onClick={() => useWorkbenchActivity.getState().showNotifications()}>{t('taskShelf.notificationHistory')}</button>
        </div>}
        {!showNotices && focusedWindows.map(entry => {
          const binding = bindings[entry.id]
          const session = binding?.kind === 'terminal' ? sessions.find(s => s.id === binding.id) : undefined
          const payload = binding && binding.kind !== 'terminal' ? usePaneStore.getState().overlayPayloads[binding.id] : undefined
          const interactive = showPreviews && width >= inputWidth && !canDrop && !session?.lockedByMcp && !session?.config.ownerPluginId && !payload?.ownerPluginId && !(payload?.kind === 'dshWeb' && payload.readOnly)
          const taskStatus = resolveShelfTaskStatus(entry, binding, activity, session?.status, Math.max(now, Date.now()))
          const status = saveErrors[entry.id] ? 'unsaved' : !binding ? 'saved' : ['approval', 'failed', 'turnEnded', 'disconnected'].includes(taskStatus) ? taskStatus : 'background'
          return <div key={entry.id} data-shelf-entry={entry.id} className={`task-shelf-item ${focusedId === entry.id ? 'is-focused' : ''}`} role="region" aria-label={t('taskShelf.focusedTask')} onContextMenu={event => showShelfEntryContextMenu(event, entry.id)}>
            <div className="task-shelf-window-header"><button className="task-shelf-open" disabled={busy[entry.id]} onFocus={() => setSelected(entry.id)} title={[entry.title, entry.workspace, t(`taskShelf.status.${status}`)].filter(Boolean).join('\n')}
              draggable={!!binding && !busy[entry.id]} onDragStart={event => {
                if (!binding) return
                event.dataTransfer.setData('text/plain', binding.kind === 'terminal' ? binding.id : OVERLAY_DRAG_MARKER + binding.id); event.dataTransfer.effectAllowed = 'move'
                // 先显示原实例再按现有拖拽协议放入目标分屏；仍保持收纳和动态保存。
                void open(entry.id)
                const pane = usePaneStore.getState(); if (binding.kind === 'terminal') pane.setDraggingSession(binding.id); else pane.setDraggingOverlay(binding.id)
              }} onDragEnd={() => { usePaneStore.getState().setDraggingSession(null); usePaneStore.getState().setDraggingOverlay(null) }}
              onClick={() => { void openInMain(entry.id) }}>
              <ShelfIcon kind={entry.recovery.kind} /><span className="task-shelf-item-text"><strong>{entry.title}</strong><span>{entry.workspace || t(`taskShelf.type.${entry.recovery.kind}`)}</span><small className={`task-shelf-status status-${status}`}>{busy[entry.id] ? t('taskShelf.opening') : t(`taskShelf.status.${status}`)}</small></span>
            </button>
            {showPreviews && <div className="task-shelf-window-toolbar"><span className="task-shelf-window-state" title={t(`taskShelf.activityStatus.${taskStatus}`)}><span className={`task-shelf-status-dot is-${taskStatus}`} />{taskStatus === 'unknown' ? t(`taskShelf.type.${entry.recovery.kind}`) : t(`taskShelf.activityStatus.${taskStatus}`)}</span>
              {width < inputWidth && <button className="task-shelf-enable-input" title={t('taskShelf.enableInput')} onClick={() => { setPreferences(p => ({ ...p, width: inputWidth })); setPinned(true) }}>{t('taskShelf.typeHere')}</button>}
            </div>}
            <div className="task-shelf-item-actions">
              <button className="task-shelf-main-button" disabled={busy[entry.id]} title={t('taskShelf.openInMain')} aria-label={t('taskShelf.openInMain')} onClick={() => { void openInMain(entry.id) }}><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><path d="M3 9 9 3M3 3h6v6"/></svg></button>
              <button title={t('taskShelf.taskActions')} aria-label={t('taskShelf.taskActions')} onClick={event => {
                const rect = event.currentTarget.getBoundingClientRect()
                showShelfEntryContextMenu({ preventDefault: () => event.preventDefault(), stopPropagation: () => event.stopPropagation(), clientX: rect.right, clientY: rect.bottom }, entry.id)
              }}><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="13" cy="8" r="1"/></svg></button>
            </div>
            </div>
            {shown && showPreviews && binding && <>
              {binding.kind === 'web' && <TaskShelfBrowserBar id={binding.id} interactive={interactive} />}
              <div className={`task-shelf-window-content is-${binding.kind}`}><TaskShelfLiveSurface kind={binding.kind} id={binding.id} interactive={interactive} /></div>
            </>}
          </div>
        })}
      </div>
      {selectedEntry && !showPreviews && !showNotices && <div className="task-shelf-detail">
        {selectedEntry.recovery.kind === 'terminal' && selectedEntry.recovery.type === 'ssh' && <p>{selectedEntry.recovery.cwd ? t('taskShelf.remoteDirectory', { directory: selectedEntry.recovery.cwd }) : t('taskShelf.remoteDirectoryUnknown')}</p>}
        {selectedEntry.context && <details className="task-shelf-context"><summary>{t('taskShelf.contextTitle')}</summary><p>{t('taskShelf.contextHint')}</p><pre tabIndex={0} aria-label={t('taskShelf.contextTitle')}>{selectedEntry.context.text}</pre></details>}
        {selectedEntry.recovery.kind === 'terminal' && selectedEntry.recovery.cliSessionId && <p className="task-shelf-session-id" title={selectedEntry.recovery.cliSessionId}>{selectedEntry.recovery.cliSessionId}</p>}
        {selectedEntry.recovery.kind === 'terminal' && selectedEntry.recovery.cliObservationLost && <p>{t('taskShelf.cliObservationLost')}</p>}
        {selectedEntry.recovery.kind === 'harness' && selectedEntry.recovery.sessionId && <p className="task-shelf-session-id">{selectedEntry.recovery.sessionId}</p>}
        <time dateTime={new Date(selectedEntry.updatedAt).toISOString()}>{t('taskShelf.savedAt', { time: new Date(selectedEntry.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })}</time>
        {bindings[selectedEntry.id]?.kind === 'terminal' && sessions.some(s => s.id === bindings[selectedEntry.id].id && s.status === 'connected') && <button className="task-shelf-disconnect" disabled={busy[selectedEntry.id]} title={t(selectedEntry.recovery.kind === 'terminal' && selectedEntry.recovery.type === 'local' ? 'taskShelf.terminateLocalHint' : 'taskShelf.disconnectHint')} onClick={() => {
          const id = selectedEntry.id, binding = bindings[id]
          useTaskShelf.setState(s => ({ busy: { ...s.busy, [id]: true } }))
          void window.electronAPI.disconnect(binding.id).then(result => { if (!result.success) throw new Error(result.error || '断开未确认') }).catch(error => useTaskShelf.setState({ error: (error as Error).message })).finally(() => useTaskShelf.setState(s => { const next = { ...s.busy }; delete next[id]; return { busy: next } }))
        }}>{t(selectedEntry.recovery.kind === 'terminal' && selectedEntry.recovery.type === 'local' ? 'taskShelf.terminateLocal' : 'taskShelf.disconnect')}</button>}
      </div>}
    </div>
    {/* hiddenSessions 订阅负责触发列表显隐更新，不参与后端状态推断。 */}
    <span hidden data-hidden-terminal-count={Object.keys(hiddenSessions).length} />
  </aside></>
}
export default TaskShelf
