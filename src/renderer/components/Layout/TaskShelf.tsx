import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useTaskShelf, initializeTaskShelf, shelfEntryVisible, shelfResource, collectActiveShelfTask } from '../../stores/task-shelf'
import { matchShelfShortcut } from '@shared/task-shelf'
import { TaskShelfContextMenu, showShelfEntryContextMenu } from './TaskShelfContextMenu'
import { usePaneStore } from '../../stores/pane-store'
import { useSessionStore } from '../../stores/session-store'
import { useWorkbenchActivity } from '../../stores/workbench-activity'
import { OVERLAY_DRAG_MARKER } from './overlay-drag'
import { shelfDocked, shelfPanelWidth, shelfGridLayout, shelfHorizontalLayout, SHELF_PREVIEW_WIDTH, SHELF_INPUT_WIDTH, type ShelfMode, type ShelfEdge, shelfEdge, shelfPanelHeight, shelfDropEdge } from './task-shelf-layout'
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
function readPreferences(): { mode: ShelfMode; width: number; height: number; edge: ShelfEdge } {
  try {
    const saved = JSON.parse(localStorage.getItem(PREF_KEY) || '{}')
    return { edge: shelfEdge(saved.edge), height: Number.isFinite(saved.height) ? Math.max(200, saved.height) : 420, mode: ['auto', 'hover', 'fixed'].includes(saved.mode) ? saved.mode : 'auto', width: Number.isFinite(saved.width) ? shelfPanelWidth(saved.width, Infinity) : 304 }
  } catch { return { mode: 'auto', width: 304, height: 420, edge: 'right' } }
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
  const { entries, bindings, loaded, busy, restoringArchived, error, saveErrors, open, retry, archive, restoreArchived, viewRequest, preferences: shortcuts } = useTaskShelf(useShallow(s => ({
    entries: s.entries, bindings: s.bindings, loaded: s.loaded, busy: s.busy, restoringArchived: s.restoringArchived, error: s.error, saveErrors: s.saveErrors,
    open: s.open, retry: s.retry, archive: s.archive, restoreArchived: s.restoreArchived, viewRequest: s.viewRequest, preferences: s.preferences
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
  const [availableHeight, setAvailableHeight] = useState(window.innerHeight - 36)
  const [moving, setMoving] = useState(false)
  const [dropEdge, setDropEdge] = useState<ShelfEdge | null>(null)
  const moveStart = useRef<{ x: number; y: number; open: boolean }>()
  const moveTarget = useRef<ShelfEdge | null>(null)
  const skipEdgeClick = useRef(false)
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
  const body = useRef<HTMLDivElement>(null)
  const [bodySize, setBodySize] = useState({ width: 0, height: 0 })
  const edge = useRef<HTMLButtonElement>(null)
  const keyboardOpen = useRef(false)
  const focusRestoredTasks = useRef(false)
  const panelId = useId()
  const resizeStart = useRef<{ x: number; width: number }>()
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>()
  const closeTimer = useRef<ReturnType<typeof setTimeout>>()
  const pointerInsideWindow = useRef(true)
  const horizontal = preferences.edge === 'top' || preferences.edge === 'bottom'
  const height = shelfPanelHeight(preferences.height, availableHeight)
  const width = horizontal ? available : shelfPanelWidth(preferences.width, available, windowWidth)
  const resizeCommit = useFrameCommit<number>(next => setPreferences(p => horizontal
    ? p.height === next ? p : { ...p, height: next }
    : p.width === next ? p : { ...p, width: next }))
  const resizeValue = (delta: number) => horizontal
    ? shelfPanelHeight(height + delta, availableHeight)
    : shelfPanelWidth(width + delta, available, windowWidth)
  const finishResize = () => { resizeCommit.flush(); resizeStart.current = undefined; setResizing(false) }
  const inputWidth = Math.min(SHELF_INPUT_WIDTH, shelfPanelWidth(Infinity, available, windowWidth))
  const canDrop = !!draggingSession || !!draggingOverlay && ['web', 'dshWeb'].includes(usePaneStore.getState().overlayPayloads[draggingOverlay]?.kind)
  const shown = docked || expanded || pinned || (canDrop && dropOver)

  useEffect(() => initializeTaskShelf(), [])
  useLayoutEffect(() => {
    if (focusRestoredTasks.current && !showArchived && !showNotices) {
      focusRestoredTasks.current = false
      root.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus()
    }
  }, [showArchived, showNotices])
  useLayoutEffect(() => { refreshShelfSurfaces() })
  useLayoutEffect(() => {
    const target = body.current
    if (!target) return
    const update = () => {
      const next = { width: target.clientWidth, height: target.clientHeight }
      if (next.width > 0 && next.height > 0) setBodySize(old => old.width === next.width && old.height === next.height ? old : next)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(target)
    return () => observer.disconnect()
  }, [horizontal])
  useLayoutEffect(() => {
    const parent = root.current?.parentElement
    if (!parent) return
    const update = () => { if (parent.clientWidth > 0) setAvailable(parent.clientWidth); setWindowWidth(window.innerWidth); if (parent.clientHeight > 36) setAvailableHeight(parent.clientHeight - 36) }
    update()
    const observer = new ResizeObserver(update); observer.observe(parent)
    window.addEventListener('resize', update)
    return () => { observer.disconnect(); window.removeEventListener('resize', update) }
  }, [])
  useEffect(() => {
    const timer = setTimeout(() => setDocked(old => horizontal
      ? preferences.mode !== 'hover' && availableHeight - height >= (old ? 280 : 320) && (preferences.mode === 'fixed' || availableHeight >= (old ? 800 : 900))
      : shelfDocked(preferences.mode, windowWidth, available, width, old)), 180)
    return () => clearTimeout(timer)
  }, [preferences.mode, windowWidth, available, width, horizontal, height, availableHeight])
  useLayoutEffect(() => {
    const reservedWidth = docked && !horizontal ? width : 0
    const reservedHeight = docked && horizontal ? height : 0
    const state = useTaskShelf.getState()
    if (state.reservedWidth !== reservedWidth || state.reservedHeight !== reservedHeight || state.reservedEdge !== preferences.edge) {
      useTaskShelf.setState({ reservedWidth, reservedHeight, reservedEdge: preferences.edge })
    }
  }, [docked, width, height, horizontal, preferences.edge])
  useLayoutEffect(() => () => { useTaskShelf.setState({ reservedWidth: 0, reservedHeight: 0, reservedEdge: 'right' }) }, [])
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
        const action = matchShelfShortcut({ type: 'keyDown', key: event.key, code: event.code, control: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey, alt: event.altKey, isAutoRepeat: event.repeat, isComposing: event.isComposing }, shortcuts)
        if (action) { event.preventDefault(); event.stopPropagation(); run(action) }
      }
      if (event.key === 'Escape' && (expanded || pinned) && !resizing && !moveStart.current && !isShelfSurfaceEngaged()) closePanel()
    }
    window.addEventListener('keydown', handle)
    return () => { off?.(); window.removeEventListener('keydown', handle) }
  }, [expanded, pinned, resizing, shortcuts, docked])

  const enter = () => { pointerInsideWindow.current = true; clearTimeout(closeTimer.current); clearTimeout(hoverTimer.current); if (!moveStart.current) hoverTimer.current = setTimeout(() => setExpanded(true), 300) }
  // 键盘聚焦入口只取消待执行的收起，不在 300ms 后自动展开并把入口自身藏掉；
  // 展开由 Enter/Space 触发，细柄焦点环继续作为可见入口。
  const holdEntryFocus = () => { clearTimeout(closeTimer.current); clearTimeout(hoverTimer.current) }
  const closePanel = () => {
    clearTimeout(hoverTimer.current); clearTimeout(closeTimer.current)
    setExpanded(false); setPinned(false); setDropOver(false)
  }
  const leave = useCallback(() => {
    clearTimeout(hoverTimer.current); clearTimeout(closeTimer.current)
    if (!pointerInsideWindow.current) return
    closeTimer.current = setTimeout(() => {
      if (!pointerInsideWindow.current) return
      if (!root.current?.matches(':hover') && !root.current?.contains(document.activeElement) && !document.activeElement?.closest('.task-shelf-context-menu') && !isShelfSurfaceEngaged() && !resizing && !moveStart.current) setExpanded(false)
      setDropOver(false)
    }, 450)
  }, [resizing])
  useEffect(() => {
    // 离开整个软件只暂停自动收起；返回客户端后再依据实际落点重新计时。
    const pause = () => {
      pointerInsideWindow.current = false
      clearTimeout(hoverTimer.current); clearTimeout(closeTimer.current)
    }
    const boundaryLeave = (event: MouseEvent) => {
      if (event.relatedTarget === null || event.relatedTarget === window) pause()
    }
    const resume = (event: MouseEvent) => {
      if (event.clientX < 0 || event.clientY < 0 || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight) { pause(); return }
      if (pointerInsideWindow.current) return
      pointerInsideWindow.current = true
      const target = event.target
      if (target instanceof Node && (root.current?.contains(target) || edge.current?.contains(target))) return
      if (target instanceof Element && target.closest('.task-shelf-context-menu,[data-shelf-native]')) return
      leave()
    }
    window.addEventListener('mouseout', boundaryLeave, true)
    window.addEventListener('dragleave', boundaryLeave, true)
    window.addEventListener('blur', pause)
    document.documentElement.addEventListener('mouseleave', boundaryLeave)
    document.addEventListener('mousemove', resume, true)
    document.addEventListener('dragover', resume, true)
    return () => {
      window.removeEventListener('mouseout', boundaryLeave, true)
      window.removeEventListener('dragleave', boundaryLeave, true)
      window.removeEventListener('blur', pause)
      document.documentElement.removeEventListener('mouseleave', boundaryLeave)
      document.removeEventListener('mousemove', resume, true)
      document.removeEventListener('dragover', resume, true)
    }
  }, [leave])
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
  const horizontalLayout = shelfHorizontalLayout(bodySize.width || width, bodySize.height || Math.max(0, height - 48), displayedEntries.length)
  const showPreviews = width >= SHELF_PREVIEW_WIDTH && (!horizontal || horizontalLayout.showPreviews)
  const focusedWindows = showPreviews ? displayedEntries.filter(entry => !shelfEntryVisible(entry.id) && !!bindings[entry.id]) : []
  const grid = shelfGridLayout(width)
  const openInMain = async (id: string) => {
    const entry = entries.find(item => item.id === id)
    if (entry?.archivedAt && !await archive(id, false)) return
    await open(id)
  }

  const changeEdge = (next: ShelfEdge, keepOpen = true) => {
    clearTimeout(hoverTimer.current); clearTimeout(closeTimer.current)
    setPreferences(p => ({ ...p, edge: next }))
    if (keepOpen) { setPinned(true); setExpanded(true) }
  }
  const stopMove = () => { moveStart.current = undefined; moveTarget.current = null; setMoving(false); setDropEdge(null) }
  const startMove = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    clearTimeout(hoverTimer.current); clearTimeout(closeTimer.current)
    skipEdgeClick.current = false
    moveStart.current = { x: event.clientX, y: event.clientY, open: shown }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }
  const updateMove = (event: React.PointerEvent<HTMLElement>) => {
    const start = moveStart.current, parent = root.current?.parentElement
    if (!start || !parent || !moving && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 6) return
    const rect = parent.getBoundingClientRect()
    const next = shelfDropEdge(event.clientX, event.clientY, { left: rect.left, top: rect.top + 36, width: rect.width, height: Math.max(0, rect.height - 36) })
    moveTarget.current = next; setMoving(true); setDropEdge(next)
  }
  const finishMove = () => {
    const next = moveTarget.current, wasOpen = moveStart.current?.open ?? false
    skipEdgeClick.current = moving
    stopMove()
    if (next) changeEdge(next, wasOpen)
  }

  const tasksInMain = entries.filter(entry => !entry.archivedAt && shelfEntryVisible(entry.id))
  const recallAll = () => {
    for (const entry of tasksInMain) useTaskShelf.getState().hide(entry.id)
    setSelected(tasksInMain[0]?.id ?? null)
  }

  const dragOver = (event: React.DragEvent) => {
    if (canDrop) { pointerInsideWindow.current = true; clearTimeout(hoverTimer.current); clearTimeout(closeTimer.current); event.preventDefault(); event.stopPropagation(); setExpanded(true); setDropOver(true); event.dataTransfer.dropEffect = 'move' }
  }

  return <>
    <TaskShelfContextMenu />
    {moving && <div className="task-shelf-position-overlay" aria-hidden="true">
      {(['left', 'right', 'top', 'bottom'] as ShelfEdge[]).map(side => <div key={side} className={`task-shelf-position-target at-${side} ${dropEdge === side ? 'is-target' : ''}`}>{t(`taskShelf.edge.${side}`)}</div>)}
    </div>}
    <button ref={edge} data-edge={preferences.edge} className={`task-shelf-edge win-no-drag ${shown ? 'is-open' : ''} ${canDrop ? 'is-drop-target' : ''}`} aria-controls={panelId} aria-expanded={shown}
      tabIndex={shown ? -1 : 0} aria-label={t('taskShelf.toggleHint', { shortcut: shortcuts.toggleShortcut || '—' })}
      title={t('taskShelf.movePanelHint')}
      onPointerDown={startMove} onPointerMove={updateMove} onPointerUp={finishMove} onPointerCancel={stopMove} onLostPointerCapture={stopMove}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.stopPropagation(); stopMove(); return }
        const next = ({ ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'top', ArrowDown: 'bottom' } as Record<string, ShelfEdge>)[event.key]
        if (next) { event.preventDefault(); event.stopPropagation(); changeEdge(next, shown) }
      }}
      onMouseEnter={enter} onMouseLeave={leave} onFocus={holdEntryFocus} onBlur={leave}
      onClick={event => {
        if (skipEdgeClick.current) { skipEdgeClick.current = false; if (event.detail !== 0) return }
        clearTimeout(hoverTimer.current); clearTimeout(closeTimer.current)
        // detail 为 0 说明是键盘 Enter/Space 触发，打开后把焦点移入面板。
        if (event.detail === 0) keyboardOpen.current = true
        setPinned(true)
      }}
      onDragOver={dragOver} onDrop={event => { void handleDrop(event) }}>
      {attention > 0 && <span className="task-shelf-handle-dot" />}
    </button>
    <aside ref={root} id={panelId} data-edge={preferences.edge} className={`task-shelf win-no-drag ${shown ? 'is-open' : ''} ${moving ? 'is-moving' : ''} ${docked ? 'is-docked' : ''} ${dropOver ? 'is-drop' : ''} ${showPreviews ? 'has-previews' : ''}`}
    style={horizontal ? { width, height } : { width }} aria-hidden={!shown} aria-label={t('taskShelf.title')} onMouseEnter={enter} onMouseLeave={leave}
    onFocus={holdEntryFocus} onBlur={leave} onDragOver={dragOver} onDragLeave={event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { setDropOver(false); leave() }
    }} onDrop={event => { void handleDrop(event) }}>
    <div className="task-shelf-panel">
      <div className="task-shelf-resizer" role="separator" aria-label={t('taskShelf.resize')} aria-orientation={horizontal ? 'horizontal' : 'vertical'} tabIndex={0}
        onKeyDown={event => {
          const increase = horizontal ? event.key === (preferences.edge === 'top' ? 'ArrowDown' : 'ArrowUp') : event.key === (preferences.edge === 'left' ? 'ArrowRight' : 'ArrowLeft')
          const decrease = horizontal ? event.key === (preferences.edge === 'top' ? 'ArrowUp' : 'ArrowDown') : event.key === (preferences.edge === 'left' ? 'ArrowLeft' : 'ArrowRight')
          if (increase || decrease) { event.preventDefault(); resizeCommit.schedule(resizeValue(increase ? 16 : -16)); resizeCommit.flush() }
        }}
        onPointerDown={event => { if (event.button !== 0) return; resizeStart.current = { x: horizontal ? event.clientY : event.clientX, width: horizontal ? height : width }; setResizing(true); event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault() }}
        onPointerMove={event => { const start = resizeStart.current; if (start) {
          const delta = ((horizontal ? event.clientY : event.clientX) - start.x) * (preferences.edge === 'left' || preferences.edge === 'top' ? 1 : -1)
          resizeCommit.schedule(horizontal ? shelfPanelHeight(start.width + delta, availableHeight) : shelfPanelWidth(start.width + delta, available, windowWidth))
        } }}
        onPointerUp={finishResize} onPointerCancel={finishResize} onLostPointerCapture={finishResize} />
      <div className="task-shelf-chrome">
      <header className="task-shelf-header">
        <div className="task-shelf-heading"><h2>{t('taskShelf.shortTitle')}{attention > 0 && <span className="task-shelf-attention" aria-label={t('taskShelf.attention', { count: attention })} />}</h2></div>
        <div className="task-shelf-modes" role="group" aria-label={t('taskShelf.displayMode')}>
          {(['auto', 'hover', 'fixed'] as const).map(mode => <button key={mode} aria-pressed={preferences.mode === mode} onClick={() => setPreferences(p => ({ ...p, mode }))}>{t(`taskShelf.mode.${mode}`)}</button>)}
          <select className="task-shelf-mode-select" aria-label={t('taskShelf.displayMode')} value={preferences.mode} onChange={event => setPreferences(p => ({ ...p, mode: event.target.value as ShelfMode }))}>
            {(['auto', 'hover', 'fixed'] as const).map(mode => <option key={mode} value={mode}>{t(`taskShelf.mode.${mode}`)}</option>)}
          </select>
        </div>
        <button className="task-shelf-icon-button task-shelf-collapse" title={t('taskShelf.collapse')} aria-label={t('taskShelf.collapse')} onClick={() => { closePanel(); if (docked) { setDocked(false); setPreferences(p => ({ ...p, mode: 'hover' })) } }}><svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m7 4 6 6-6 6" /></svg></button>
      </header>
      <div className="task-shelf-view-row">
      <div className="task-shelf-views" role="tablist" aria-label={t('taskShelf.taskViews')} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const current = showNotices ? 2 : showArchived ? 1 : 0
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (current + (event.key === 'ArrowLeft' ? 2 : 1)) % 3
        setShowArchived(next === 1); setShowNotices(next === 2)
        event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
      }}>
        <button role="tab" tabIndex={!showArchived && !showNotices ? 0 : -1} aria-selected={!showArchived && !showNotices} onClick={() => { setShowArchived(false); setShowNotices(false) }}>{t('taskShelf.activeTasks')} <span className="task-shelf-view-count">{entries.filter(entry => !entry.archivedAt).length}</span></button>
        <button role="tab" tabIndex={showArchived && !showNotices ? 0 : -1} aria-selected={showArchived && !showNotices} onClick={() => { setShowArchived(true); setShowNotices(false) }}>{t('taskShelf.archivedTasks')} <span className="task-shelf-view-count">{entries.filter(entry => !!entry.archivedAt).length}</span></button>
        <button role="tab" tabIndex={showNotices ? 0 : -1} aria-selected={showNotices} onClick={() => setShowNotices(true)}>{t('taskShelf.notices')} <span className="task-shelf-view-count">{unreadNoticeIds.length}</span></button>
      </div>

      {!showArchived && !showNotices && <button className="task-shelf-view-action" disabled={!tasksInMain.length || tasksInMain.some(entry => busy[entry.id])} aria-label={t('taskShelf.recallAll')} title={t('taskShelf.recallAllHint')} onClick={recallAll}>
        <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4h4v12h-4M3 10h9m-3-3 3 3-3 3" /></svg><span>{t('taskShelf.recallAll')}</span>
      </button>}
      {showArchived && !showNotices && <div className="task-shelf-archive-actions">
        <button className="task-shelf-view-action" aria-label={t(restoringArchived ? 'taskShelf.restoringAll' : 'taskShelf.restoreAll')} disabled={!loaded || restoringArchived || !entries.some(entry => !!entry.archivedAt)} title={t('taskShelf.restoreAllHint')} onClick={() => {
          void restoreArchived().then(restored => {
            if (!restored) return
            focusRestoredTasks.current = true
            setSelected(null); setShowArchived(false); setShowNotices(false)
          })
        }}><svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 6h9a4 4 0 0 1 0 8H9M7 3 4 6l3 3M4 14v3h12v-3" /></svg><span>{t(restoringArchived ? 'taskShelf.restoringAll' : 'taskShelf.restoreAll')}</span></button>
      </div>}
      </div>
      </div>
      {error && <div className="task-shelf-error" role="alert"><span>{error}</span><button onClick={() => { void retry() }}>{t('taskShelf.retry')}</button></div>}
      {canDrop && <div className="task-shelf-drop-target">{t('taskShelf.drop')}</div>}
      <div ref={body} className="task-shelf-body" style={horizontal ? { '--shelf-grid-width': `${horizontalLayout.gridWidth}px`, '--shelf-preview-width': `${horizontalLayout.previewCardWidth}px` } as React.CSSProperties : undefined}>
      {!showNotices && displayedEntries.length > 0 && <div className={`task-shelf-grid ${focusedWindows.length === 0 ? 'is-overview' : ''}`} role="group" aria-label={t('taskShelf.gridLabel')} style={horizontal ? { gridTemplateRows: `repeat(${horizontalLayout.rows}, 124px)` } : { gridTemplateColumns: `repeat(${grid.columns}, minmax(0, 1fr))` }}>
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
              : <span className="task-shelf-tile-location"><ShelfIcon kind={entry.recovery.kind} /><span>{t(`taskShelf.type.${entry.recovery.kind}`)}</span></span>}</span>
            <span className="task-shelf-tile-label">{entry.title}</span>
            <span className="task-shelf-tile-state"><span className={`task-shelf-status-dot is-${status}`} role="img" aria-label={t(`taskShelf.activityStatus.${status}`)} /><span>{inMain ? t('taskShelf.mainWindow') : status === 'unknown' ? t(binding ? `taskShelf.type.${entry.recovery.kind}` : 'taskShelf.savedLabel') : t(`taskShelf.activityStatus.${status}`)}</span></span>
          </button>
        })}
      </div>}
      <div className={`task-shelf-list ${focusedWindows.length > 0 && !showNotices ? 'has-live-windows' : ''}`}>
        {!loaded && <span className="task-shelf-loading" role="status">{t('taskShelf.loading')}</span>}
        {loaded && !showNotices && displayedEntries.length === 0 && <div className="task-shelf-empty">
          <ShelfIcon /><h3>{t(showArchived ? 'taskShelf.emptyArchive' : 'taskShelf.emptyTitle')}</h3>
          <p>{t(showArchived ? 'taskShelf.archiveHint' : 'taskShelf.emptyHint')}</p>
        </div>}
        {showNotices && <div className="task-shelf-notices">{notices.map(notice => <button key={notice.id} className={`task-shelf-notice ${unreadNoticeIds.includes(notice.id) ? 'is-unread' : ''}`} onClick={() => {
          const state = useWorkbenchActivity.getState(); state.markRead(notice.id)
          if (!showShelfNotice(notice)) state.show(notice.workspace, notice.sessionId)
        }}><span>{activityProjectName(notice.workspace)}</span><strong>{activityNoticeTitle(notice, i18n.language.startsWith('en'))}</strong></button>)}
          {notices.length === 0 && <div className="task-shelf-empty"><ShelfIcon /><h3>{t('taskShelf.emptyNotices')}</h3><p>{t('taskShelf.emptyNoticesHint')}</p></div>}
          <button className="task-shelf-notice-history" onClick={() => useWorkbenchActivity.getState().showNotifications()}>{t('taskShelf.notificationHistory')}</button>
        </div>}
        {!showNotices && focusedWindows.map(entry => {
          const binding = bindings[entry.id]
          const session = binding?.kind === 'terminal' ? sessions.find(s => s.id === binding.id) : undefined
          const payload = binding && binding.kind !== 'terminal' ? usePaneStore.getState().overlayPayloads[binding.id] : undefined
          const contentWidth = horizontal ? horizontalLayout.previewWidth : width
          const interactive = showPreviews && contentWidth >= inputWidth && !canDrop && !session?.lockedByMcp && !session?.config.ownerPluginId && !payload?.ownerPluginId && !(payload?.kind === 'dshWeb' && payload.readOnly)
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
              {!horizontal && width < inputWidth && <button className="task-shelf-enable-input" title={t('taskShelf.enableInput')} onClick={() => { setPreferences(p => ({ ...p, width: inputWidth })); setPinned(true) }}>{t('taskShelf.typeHere')}</button>}
            </div>}
            <div className="task-shelf-item-actions">
              <button className="task-shelf-main-button" disabled={busy[entry.id]} title={t('taskShelf.openInMain')} aria-label={t('taskShelf.openInMain')} onClick={() => { void openInMain(entry.id) }}><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><path d="M3 9 9 3M3 3h6v6"/></svg></button>
              <button title={t('taskShelf.taskActions')} aria-label={t('taskShelf.taskActions')} onClick={event => {
                const rect = event.currentTarget.getBoundingClientRect()
                showShelfEntryContextMenu({ preventDefault: () => event.preventDefault(), stopPropagation: () => event.stopPropagation(), clientX: rect.right, clientY: rect.bottom }, entry.id)
              }}><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="13" cy="8" r="1"/></svg></button>
            </div>
            </div>
            {shown && showPreviews && binding && <div className="task-shelf-window-body">
              {binding.kind === 'web' && <TaskShelfBrowserBar id={binding.id} interactive={interactive} />}
              <div className={`task-shelf-window-content is-${binding.kind}`}><TaskShelfLiveSurface kind={binding.kind} id={binding.id} interactive={interactive} /></div>
            </div>}
          </div>
        })}
      </div>
      </div>
      {selectedEntry && !horizontal && !showPreviews && !showNotices && <div className="task-shelf-detail">
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
