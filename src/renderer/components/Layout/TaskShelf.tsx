import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useTaskShelf, initializeTaskShelf, shelfEntryVisible, shelfResource, collectActiveShelfTask, requestShelfBrowserRestore, withdrawShelfBrowserRestores } from '../../stores/task-shelf'
import { matchShelfShortcut, TASK_SHELF_TRASH_LIMIT } from '@shared/task-shelf'
import { TaskShelfContextMenu, showShelfEntryContextMenu } from './TaskShelfContextMenu'
import { usePaneStore } from '../../stores/pane-store'
import { useSessionStore } from '../../stores/session-store'
import { useWorkbenchActivity } from '../../stores/workbench-activity'
import { OVERLAY_DRAG_MARKER } from './overlay-drag'
import { shelfDocked, shelfPanelWidth, shelfGridLayout, shelfHorizontalLayout, SHELF_PREVIEW_WIDTH, SHELF_INPUT_WIDTH, SHELF_PREVIEW_ASPECT_RATIO, SHELF_BROWSER_BAR_HEIGHT, type ShelfMode, type ShelfEdge, shelfEdge, shelfPanelHeight, shelfDropEdge } from './task-shelf-layout'
import TaskShelfPreview from './TaskShelfPreview'
import TaskShelfLiveSurface from './TaskShelfLiveSurface'
import TaskShelfBrowserBar from './TaskShelfBrowserBar'
import { isShelfSurfaceEngaged, refreshShelfSurfaces, SHELF_SURFACE_ENTER, SHELF_SURFACE_LEAVE } from './task-shelf-surfaces'
import { resolveShelfTaskStatus } from './task-shelf-status'
import { WorkbenchActivity } from './WorkbenchActivity'
import { TaskStatusLight, TaskStatusLegend } from './TaskStatusLight'
import { TaskTileStatusLight } from './TaskTileStatusLight'
import './TaskShelf.css'
import { useFrameCommit } from '../../hooks/useFrameCommit'
import { beginLayoutResize } from './layout-resize'
import { useShallow } from 'zustand/react/shallow'
import { SHELF_PREVIEWS_ENABLED, SHELF_SIDEBAR_RESTORE_ENABLED } from '../../stores/shelf-feature-flags'

const PREF_KEY = 'lyshell.taskShelf.view.v1'
function readPreferences(): { mode: ShelfMode; width: number; height: number; edge: ShelfEdge } {
  try {
    const saved = JSON.parse(localStorage.getItem(PREF_KEY) || '{}')
    return { edge: shelfEdge(saved.edge), height: Number.isFinite(saved.height) ? Math.max(200, saved.height) : 420, mode: ['auto', 'hover', 'fixed'].includes(saved.mode) ? saved.mode : 'auto', width: Number.isFinite(saved.width) ? shelfPanelWidth(saved.width, Infinity) : 304 }
  } catch { return { mode: 'auto', width: 304, height: 420, edge: 'right' } }
}
function readRealtimePreference(): 'tasks' | 'none' {
  try { return localStorage.getItem('lyshell.taskShelf.realtime.v1') === 'none' ? 'none' : 'tasks' }
  catch { return 'tasks' }
}

/** 恢复排队与真正挂载前都读取当前卡片几何，滚离视口不会沿用激活时的旧资格。 */
export function isShelfRestoreCardVisible(panel: HTMLElement | null, id: string): boolean {
  const card = [...panel?.querySelectorAll<HTMLElement>('[data-shelf-card]') ?? []].find(node => node.dataset.shelfCard === id)
  const bounds = panel?.getBoundingClientRect()
  if (!card || !bounds || bounds.width <= 0 || bounds.height <= 0) return false
  const rect = card.getBoundingClientRect()
  const clip = card.closest('.task-shelf-grid')?.getBoundingClientRect() ?? bounds
  return rect.width > 0 && rect.height > 0 && rect.bottom > Math.max(0, bounds.top, clip.top) &&
    rect.top < Math.min(window.innerHeight, bounds.bottom, clip.bottom) && rect.right > Math.max(0, bounds.left, clip.left) &&
    rect.left < Math.min(window.innerWidth, bounds.right, clip.right)
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
  const { t } = useTranslation()
  // 快捷键只在设置 → 终端 里修改(见 SettingsPanel)，保存区只消费当前绑定。
  const { entries, bindings, loaded, busy, error, saveErrors, open, retry, archive, activate, activating, activation, startup, viewRequest, preferences: shortcuts } = useTaskShelf(useShallow(s => ({
    entries: s.entries, bindings: s.bindings, loaded: s.loaded, busy: s.busy, error: s.error, saveErrors: s.saveErrors,
    open: s.open, retry: s.retry, archive: s.archive, activate: s.activate, activating: s.activating, activation: s.activation, startup: s.startup, viewRequest: s.viewRequest, preferences: s.preferences
  })))
  const draggingSession = usePaneStore(s => s.draggingSessionId)
  const draggingOverlay = usePaneStore(s => s.draggingOverlayId)
  // 显隐、状态与工作台事件分别驱动列表，不以静默输出推断完成。
  usePaneStore(s => s.layout)
  const overlayPayloads = usePaneStore(s => s.overlayPayloads)
  const hiddenSessions = usePaneStore(s => s.hiddenTabSessions)
  const sessions = useSessionStore(s => s.sessions)
  const previewEntries = useTaskShelf(s => s.previewEntries)
  const restoreFailures = useTaskShelf(s => s.restoreFailures)
  const activity = useWorkbenchActivity(s => s.snapshot)
  const unreadNoticeIds = useWorkbenchActivity(s => s.unreadNoticeIds)
  const [preferences, setPreferences] = useState(readPreferences)
  const [available, setAvailable] = useState(1200)
  const [availableHeight, setAvailableHeight] = useState(window.innerHeight - 36)
  const [moving, setMoving] = useState(false)
  const [dropEdge, setDropEdge] = useState<ShelfEdge | null>(null)
  const moveStart = useRef<{ x: number; y: number; open: boolean }>()
  const moveTarget = useRef<ShelfEdge | null>(null)
  const [windowWidth, setWindowWidth] = useState(window.innerWidth)
  const [docked, setDocked] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [realtime, setRealtime] = useState(readRealtimePreference)
  const [dropOver, setDropOver] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [shelfSelection, setShelfSelection] = useState<{ id: string; intent: number } | null>(null)
  const startedSelection = useRef<number>()
  const [resizing, setResizing] = useState(false)
  const [taskView, setTaskView] = useState<'tasks' | 'archive' | 'trash'>('tasks')
  const showArchived = taskView === 'archive'
  const showTrash = taskView === 'trash'
  const showStored = taskView !== 'tasks'
  const [activityView, setActivityView] = useState<'sessions' | 'notices' | null>(null)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [detailsEntryId, setDetailsEntryId] = useState<string | null>(null)
  const options = useRef<HTMLDivElement>(null)
  const optionsPanel = useRef<HTMLDivElement>(null)
  const optionsId = useId()
  const [now, setNow] = useState(Date.now)
  const root = useRef<HTMLElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const views = useRef<HTMLDivElement>(null)
  const [bodySize, setBodySize] = useState({ width: 0, height: 0 })
  const edge = useRef<HTMLButtonElement>(null)
  const keyboardOpen = useRef(false)
  const choseView = useRef(false)
  const initializedBoot = useRef<string>()
  const pointerInside = useRef(false)
  const composing = useRef(false)
  const keyboardNavigating = useRef(false)
  const closeRevision = useRef(0)
  const interaction = useRef({ resizing, mode: preferences.mode })
  interaction.current = { resizing, mode: preferences.mode }
  const panelId = useId()
  const activeView = activityView ?? taskView
  const contentId = `${panelId}-content`
  const resizeStart = useRef<{ x: number; width: number; value: number; columns: number; rows: number; showPreviews: boolean; bodyInset: number }>()
  const resizeTiles = useRef<Map<HTMLElement, DOMRect> | null>(null)
  const resizeAnimations = useRef<Animation[]>([])
  const resizeLease = useRef<(() => void) | null>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>()
  const closeTimer = useRef<ReturnType<typeof setTimeout>>()
  const pointerInsideWindow = useRef(true)
  const horizontal = preferences.edge === 'top' || preferences.edge === 'bottom'
  const height = shelfPanelHeight(horizontal ? resizeStart.current?.value ?? preferences.height : preferences.height, availableHeight)
  const width = horizontal ? available : shelfPanelWidth(resizeStart.current?.value ?? preferences.width, available, windowWidth)
  const resizeCommit = useFrameCommit<number>(next => {
    const drag = resizeStart.current, panel = root.current
    if (!drag || !panel) {
      setPreferences(p => horizontal ? p.height === next ? p : { ...p, height: next } : p.width === next ? p : { ...p, width: next })
      return
    }
    // 手势热路径只写当前帧几何；React、停靠状态及持久化留到释放时提交。
    drag.value = next
    if (horizontal) {
      panel.style.height = `${next}px`
      const layout = shelfHorizontalLayout(bodySize.width || width, Math.max(0, next - drag.bodyInset), displayedEntries.length, previewRequested, browserToolbarHeight, drag.rows)
      body.current?.style.setProperty('--shelf-grid-width', `${layout.gridWidth}px`)
      body.current?.style.setProperty('--shelf-preview-width', `${layout.previewCardWidth}px`)
    } else panel.style.width = `${next}px`
    if (docked && shown) panel.parentElement?.style.setProperty(horizontal ? '--task-shelf-drag-height' : '--task-shelf-drag-width', `${next}px`)
    refreshShelfSurfaces()
  })
  const resizeValue = (delta: number) => horizontal
    ? shelfPanelHeight(height + delta, availableHeight)
    : shelfPanelWidth(width + delta, available, windowWidth)
  const flushResize = resizeCommit.flush
  const finishResize = useCallback(() => {
    const drag = resizeStart.current
    if (!drag) return
    flushResize()
    // 松手前记录当前画面，只为最终换列做一次位置衔接；拖动本身不加缓动。
    if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      resizeTiles.current = new Map([...root.current?.querySelectorAll<HTMLElement>('.task-shelf-tile') ?? []].map(tile => [tile, tile.getBoundingClientRect()]))
    }
    resizeStart.current = undefined
    setPreferences(p => horizontal ? { ...p, height: drag.value } : { ...p, width: drag.value })
    setResizing(false)
  }, [flushResize, horizontal])
  useEffect(() => {
    if (!resizing) return
    window.addEventListener('blur', finishResize)
    return () => window.removeEventListener('blur', finishResize)
  }, [resizing, finishResize])
  const inputWidth = Math.min(SHELF_INPUT_WIDTH, shelfPanelWidth(Infinity, available, windowWidth))
  const canDrop = !!draggingSession || !!draggingOverlay && ['web', 'dshWeb'].includes(usePaneStore.getState().overlayPayloads[draggingOverlay]?.kind)
  const displayedEntries = showTrash
    ? entries.filter(entry => !!entry.trashedAt).reverse().sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0))
    : entries.filter(entry => !entry.trashedAt && !!entry.archivedAt === showArchived)
  const taskCount = entries.filter(entry => !entry.archivedAt && !entry.trashedAt).length
  const archiveCount = entries.filter(entry => !!entry.archivedAt && !entry.trashedAt).length
  const trashCount = entries.filter(entry => !!entry.trashedAt).length
  // 预览区域按当前任务类型预留几何，不随选中任务或是否已经打开而改变索引布局。
  const previewRequested = SHELF_PREVIEWS_ENABLED && !showStored && realtime === 'tasks'
  const browserToolbarHeight = displayedEntries.some(entry => bindings[entry.id]?.kind === 'web' || entry.recovery.kind === 'web') ? SHELF_BROWSER_BAR_HEIGHT : 0
  // 拖高直接用当前高度计算内容预算，避免 ResizeObserver 再触发一轮 React 更新。
  const bodyHeight = resizing && resizeStart.current ? Math.max(0, height - resizeStart.current.bodyInset) : bodySize.height || Math.max(0, height - 48)
  const horizontalLayout = shelfHorizontalLayout(bodySize.width || width, bodyHeight, displayedEntries.length, previewRequested, browserToolbarHeight, resizing ? resizeStart.current?.rows : undefined)
  const showPreviews = resizing && resizeStart.current ? resizeStart.current.showPreviews : previewRequested && width >= SHELF_PREVIEW_WIDTH && (!horizontal || horizontalLayout.showPreviews)
  const shown = !dismissed && (docked || expanded || pinned || (canDrop && dropOver))
  useLayoutEffect(() => {
    const strip = views.current
    const active = strip?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
    if (!shown || !strip || !active) return
    const bounds = strip.getBoundingClientRect(), tab = active.getBoundingClientRect()
    // 提醒或外部定位切换页签时同样保证选中项可见，只滚动导航条，不移动主工作区。
    if (tab.left < bounds.left) strip.scrollLeft += tab.left - bounds.left
    else if (tab.right > bounds.right) strip.scrollLeft += tab.right - bounds.right
  }, [shown, activeView, width])
  const activationNeedsAttention = !!activation && (activation.failed > 0 || activation.conflict > 0 || activation.missing > 0)
  useEffect(() => {
    if (!shown) setOptionsOpen(false)
  }, [shown])
  useEffect(() => {
    if (!optionsOpen) return
    const dismiss = (event: PointerEvent) => {
      if (options.current?.contains(event.target as Node) || optionsPanel.current?.contains(event.target as Node)) return
      if (optionsPanel.current?.contains(document.activeElement)) options.current?.querySelector('button')?.focus()
      setOptionsOpen(false)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [optionsOpen])
  const restorePolicy = useRef(false)
  restorePolicy.current = shown && showPreviews && !activityView && document.visibilityState !== 'hidden'
  const activationDemand = useTaskShelf(s => s.activationDemand)
  const restoreErrors = useTaskShelf(s => s.restoreErrors)
  const canRestore = (id: string, intent: number) => restorePolicy.current && !!useTaskShelf.getState().previewEntries[id] && isShelfRestoreCardVisible(root.current, id) && useTaskShelf.getState().uiIntentRevision === intent && useTaskShelf.getState().entries.some(entry => entry.id === id && !entry.archivedAt && !entry.trashedAt)
  useEffect(() => {
    if (!shelfSelection || !shown || !showPreviews || showStored || activityView || startedSelection.current === shelfSelection.intent) return
    let second = 0
    // 先完成窄栏扩展及实例召回，再按最终布局提交侧栏恢复需求。
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => {
      const { id, intent } = shelfSelection
      const state = useTaskShelf.getState()
      if (state.uiIntentRevision !== intent || !state.previewEntries[id]) return
      const entry = state.entries.find(item => item.id === id && !item.archivedAt && !item.trashedAt)
      if (!entry) return
      startedSelection.current = intent
      const card = [...root.current?.querySelectorAll<HTMLElement>('[data-shelf-card]') ?? []].find(node => node.dataset.shelfCard === id)
      card?.scrollIntoView?.({ block: 'nearest' })
      if (entry.recovery.kind === 'web') {
        if (SHELF_SIDEBAR_RESTORE_ENABLED) void requestShelfBrowserRestore(id, 'explicitShelf', () => canRestore(id, intent))
      } else void state.open(id, undefined, true)
    }) })
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second) }
  }, [shelfSelection, shown, showPreviews, showStored, activityView])
  useEffect(() => {
    if (!restorePolicy.current) withdrawShelfBrowserRestores()
    const onVisibility = () => {
      restorePolicy.current = shown && showPreviews && !activityView && !document.hidden
      if (!restorePolicy.current) withdrawShelfBrowserRestores()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [shown, showPreviews, activityView])
  useEffect(() => {
    // 激活只生成 Tasks 方块；只有显式点击方块才申请小窗恢复。
    if (activationDemand && !activationDemand.consumed) useTaskShelf.setState({ activationDemand: { ...activationDemand, consumed: true } })
  }, [activationDemand])

  useEffect(() => initializeTaskShelf(), [])
  useEffect(() => {
    if (startup?.status !== 'ready' || initializedBoot.current === startup.bootId) return
    initializedBoot.current = startup.bootId
    if (!choseView.current) setTaskView(startup.archiveOnBoot ? 'archive' : 'tasks')
  }, [startup])
  useLayoutEffect(() => { refreshShelfSurfaces() })
  useLayoutEffect(() => {
    // 竖向小窗尺寸由 CSS 决定，无须把同一宽度从 DOM 再读回 React。
    if (!horizontal || resizing) return
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
  }, [horizontal, resizing])
  useLayoutEffect(() => {
    const previous = resizeTiles.current
    if (resizing || !previous) return
    resizeTiles.current = null
    const changes = [...previous].filter(([tile]) => tile.isConnected && typeof tile.animate === 'function')
      .map(([tile, before]) => ({ tile, before, after: tile.getBoundingClientRect() }))
    for (const { tile, before, after } of changes) {
      if (before.width <= 0 || before.height <= 0 || after.width <= 0 || after.height <= 0) continue
      const x = before.left - after.left, y = before.top - after.top
      if (Math.abs(x) < .5 && Math.abs(y) < .5 && Math.abs(before.width - after.width) < .5 && Math.abs(before.height - after.height) < .5) continue
      resizeAnimations.current.push(tile.animate([
        { transform: `translate(${x}px, ${y}px) scale(${before.width / after.width}, ${before.height / after.height})`, transformOrigin: 'top left' },
        { transform: 'none', transformOrigin: 'top left' }
      ], { duration: 180, easing: 'cubic-bezier(.2,.7,.2,1)' }))
    }
  }, [resizing])
  useEffect(() => () => { resizeAnimations.current.forEach(animation => animation.cancel()) }, [])
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
    if (resizing) return
    const timer = setTimeout(() => setDocked(old => horizontal
      ? preferences.mode !== 'hover' && availableHeight - height >= (old ? 280 : 320) && (preferences.mode === 'fixed' || availableHeight >= (old ? 800 : 900))
      : shelfDocked(preferences.mode, windowWidth, available, width, old)), 180)
    return () => clearTimeout(timer)
  }, [preferences.mode, windowWidth, available, width, horizontal, height, availableHeight, resizing])
  useLayoutEffect(() => {
    if (resizing) return
    const reservedWidth = docked && shown && !horizontal ? width : 0
    const reservedHeight = docked && shown && horizontal ? height : 0
    const state = useTaskShelf.getState()
    if (state.reservedWidth !== reservedWidth || state.reservedHeight !== reservedHeight || state.reservedEdge !== preferences.edge) {
      useTaskShelf.setState({ reservedWidth, reservedHeight, reservedEdge: preferences.edge })
    }
    root.current?.parentElement?.style.removeProperty('--task-shelf-drag-width')
    root.current?.parentElement?.style.removeProperty('--task-shelf-drag-height')
    resizeLease.current?.(); resizeLease.current = null
  }, [docked, shown, width, height, horizontal, preferences.edge, resizing])
  useLayoutEffect(() => {
    const parent = root.current?.parentElement
    return () => {
      parent?.style.removeProperty('--task-shelf-drag-width'); parent?.style.removeProperty('--task-shelf-drag-height')
      useTaskShelf.setState({ reservedWidth: 0, reservedHeight: 0, reservedEdge: 'right' })
      resizeLease.current?.(); resizeLease.current = null
    }
  }, [])
  // 在 inert 生效前记录焦点，确保按钮、快捷键及外部请求收起时都能归还入口。
  useLayoutEffect(() => {
    const restoreFocus = !shown && root.current?.contains(document.activeElement)
    root.current?.toggleAttribute('inert', !shown)
    if (shown && keyboardOpen.current) {
      root.current?.querySelector<HTMLElement>('button:not([disabled])')?.focus({ preventScroll: true })
    } else if (restoreFocus) edge.current?.focus({ preventScroll: true })
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
    setDismissed(!viewRequest.open); setPinned(viewRequest.open); setExpanded(false); setDropOver(false)
    setActivityView(viewRequest.notices || viewRequest.view === 'notices' ? 'notices' : viewRequest.view === 'sessions' ? 'sessions' : null)
    if (viewRequest.entryId) {
      setSelected(viewRequest.entryId)
      choseView.current = true
      const entry = useTaskShelf.getState().entries.find(entry => entry.id === viewRequest.entryId)
      setTaskView(viewRequest.view === 'tasks' ? 'tasks' : entry?.trashedAt ? 'trash' : entry?.archivedAt ? 'archive' : 'tasks')
      if (!entry?.trashedAt && !viewRequest.view && !viewRequest.notices && !shelfEntryVisible(viewRequest.entryId)) {
        useTaskShelf.getState().setPreview(viewRequest.entryId, true)
        setRealtime('tasks')
        setPreferences(p => ({ ...p, width: Math.max(p.width, SHELF_PREVIEW_WIDTH), height: Math.max(p.height, 360) }))
        setShelfSelection({ id: viewRequest.entryId, intent: useTaskShelf.getState().uiIntentRevision })
      }
    }
    if (viewRequest.view) { choseView.current = true; if (viewRequest.view === 'tasks' || viewRequest.view === 'archive' || viewRequest.view === 'trash') setTaskView(viewRequest.view) }
  }, [viewRequest])
  useEffect(() => {
    if (!shown || !selected) return
    const node = [...root.current?.querySelectorAll<HTMLElement>('[data-shelf-entry]') ?? []].find(el => el.dataset.shelfEntry === selected)
    node?.scrollIntoView?.({ block: 'nearest' })
  }, [shown, selected, viewRequest, bindings])
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
        if (shown) closePanel()
        else { clearTimeout(hoverTimer.current); setDismissed(false); setExpanded(true); setPinned(false) }
      }
      else void collectActiveShelfTask()
    }
    const off = window.electronAPI?.onTaskShelfShortcut?.(run)
    const handle = (event: KeyboardEvent) => {
      if (!off) {
        const action = matchShelfShortcut({ type: 'keyDown', key: event.key, code: event.code, control: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey, alt: event.altKey, isAutoRepeat: event.repeat, isComposing: event.isComposing }, shortcuts)
        if (action) { event.preventDefault(); event.stopPropagation(); run(action) }
      }
      if (event.isComposing || composing.current) return
      if (event.key === 'Escape' && optionsOpen) { event.preventDefault(); event.stopPropagation(); setOptionsOpen(false); options.current?.querySelector('button')?.focus(); return }
      if (event.key === 'Escape' && moveStart.current) { event.preventDefault(); event.stopPropagation(); stopMove(); return }
      if (event.key === 'Escape' && shown && !resizing && !moveStart.current && !isShelfSurfaceEngaged()) closePanel()
    }
    window.addEventListener('keydown', handle)
    return () => { off?.(); window.removeEventListener('keydown', handle) }
  }, [shown, resizing, shortcuts, optionsOpen])

  const enter = () => { pointerInsideWindow.current = true; pointerInside.current = true; closeRevision.current++; clearTimeout(closeTimer.current); clearTimeout(hoverTimer.current); if (!moveStart.current) hoverTimer.current = setTimeout(() => { setDismissed(false); setExpanded(true) }, 150) }
  // 键盘聚焦入口只取消待执行的收起，不在悬停计时后自动展开并把入口自身藏掉；
  // 展开由 Enter/Space 触发，细柄焦点环继续作为可见入口。
  const holdEntryFocus = () => { clearTimeout(closeTimer.current); clearTimeout(hoverTimer.current) }
  const closePanel = () => {
    useTaskShelf.getState().invalidateIntent()
    closeRevision.current++
    clearTimeout(hoverTimer.current); clearTimeout(closeTimer.current)
    setDismissed(true)
    setExpanded(false); setPinned(false); setDropOver(false)
  }
  const leave = useCallback(() => {
    clearTimeout(hoverTimer.current)
    clearTimeout(closeTimer.current)
    const revision = ++closeRevision.current
    if (!pointerInsideWindow.current) return
    closeTimer.current = setTimeout(() => {
      const focus = document.activeElement
      const editing = focus instanceof Element && !!focus.closest('input,textarea,select,[contenteditable="true"]') && (root.current?.contains(focus) || !!focus.closest('[data-shelf-native]'))
      if (!pointerInsideWindow.current || moveStart.current || revision !== closeRevision.current || pointerInside.current || interaction.current.mode === 'fixed' || interaction.current.resizing || composing.current || keyboardNavigating.current || editing || document.querySelector('.task-shelf-context-menu') || isShelfSurfaceEngaged()) return
      setExpanded(false); setPinned(false); setDropOver(false)
    }, 600)
  }, [])
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
      pointerInside.current = false
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
  const exit = () => { pointerInside.current = false; leave() }
  useEffect(() => {
    const hold = () => { pointerInside.current = true; closeRevision.current++; clearTimeout(closeTimer.current); clearTimeout(hoverTimer.current) }
    const release = () => { pointerInside.current = false; leave() }
    const reconsider = () => { if (!pointerInside.current) leave() }
    document.addEventListener('focusin', reconsider)
    document.addEventListener('pointerup', reconsider)
    window.addEventListener(SHELF_SURFACE_ENTER, hold)
    window.addEventListener(SHELF_SURFACE_LEAVE, release)
    return () => { document.removeEventListener('focusin', reconsider); document.removeEventListener('pointerup', reconsider); window.removeEventListener(SHELF_SURFACE_ENTER, hold); window.removeEventListener(SHELF_SURFACE_LEAVE, release) }
  }, [leave])
  const handleDrop = async (event: React.DragEvent) => {
    if (!canDrop) return
    event.preventDefault(); event.stopPropagation(); setDropOver(false)
    const pane = usePaneStore.getState()
    const kind = pane.draggingSessionId ? 'terminal' : pane.overlayPayloads[pane.draggingOverlayId || '']?.kind === 'dshWeb' ? 'harness' : 'web'
    const resource = shelfResource(kind, pane.draggingSessionId || pane.draggingOverlayId || '')
    pane.setDraggingSession(null); pane.setDraggingOverlay(null)
    if (resource) await useTaskShelf.getState().collect(resource)
  }
  const attention = unreadNoticeIds.length + (error ? 1 : 0) + entries.filter(entry => {
    const binding = bindings[entry.id]
    const status = resolveShelfTaskStatus(entry, binding, activity, sessions.find(s => s.id === binding?.id)?.status, Math.max(now, Date.now()))
    return !!saveErrors[entry.id] || status === 'failed' || status === 'connectionError' || status === 'approval'
  }).length
  const selectedEntry = displayedEntries.find(entry => entry.id === selected) ?? displayedEntries.find(entry => !shelfEntryVisible(entry.id)) ?? displayedEntries[0]
  const focusedId = selectedEntry?.id
  const previewCandidates = showPreviews ? displayedEntries.filter(entry => previewEntries[entry.id] && !shelfEntryVisible(entry.id)) : []
  // 多个任务保持原实例；固定预览区只承载最近一次显式选择，键盘掠过方块不切换内容。
  const previewEntry = previewCandidates.find(entry => entry.id === shelfSelection?.id) ?? previewCandidates[0]
  const focusedWindows = previewEntry ? [previewEntry] : []
  const grid = { columns: resizing && resizeStart.current ? resizeStart.current.columns : shelfGridLayout(width).columns }
  const gridTileSize = Math.max(0, (width - 25 - (grid.columns - 1) * 10) / grid.columns)
  // 只预留完整的一至两行；高度由栏宽和任务数决定，点击预览不会留下被截断的半行。
  const gridRows = Math.max(1, Math.min(2, Math.ceil(displayedEntries.length / grid.columns), Math.floor((Math.min(360, availableHeight * .4) - 14) / (gridTileSize + 10))))
  const openInMain = async (id: string) => {
    const entry = entries.find(item => item.id === id)
    if ((entry?.archivedAt || entry?.trashedAt) && !await archive(id, false)) return
    useTaskShelf.getState().invalidateIntent()
    await open(id)
  }
  const openInShelf = (id: string) => {
    const state = useTaskShelf.getState()
    if (state.busy[id] || state.activating) return
    const intent = state.invalidateIntent()
    setSelected(id); setDismissed(false); setPinned(true); setExpanded(true)
    setRealtime('tasks')
    try { localStorage.setItem('lyshell.taskShelf.realtime.v1', 'tasks') } catch { /* 当前运行仍生效 */ }
    setPreferences(p => horizontal ? { ...p, height: Math.max(p.height, 360) } : { ...p, width: Math.max(p.width, SHELF_PREVIEW_WIDTH) })
    if (shelfEntryVisible(id)) state.hide(id)
    state.setPreview(id, true)
    setShelfSelection({ id, intent })
  }
  const toggleTask = (id: string) => {
    setDetailsEntryId(null)
    const state = useTaskShelf.getState()
    if (shelfEntryVisible(id) || previewEntry?.id === id) {
      state.invalidateIntent()
      state.hide(id)
      if (shelfSelection?.id === id) setShelfSelection(null)
      setSelected(id)
    } else openInShelf(id)
  }

  const changeEdge = (next: ShelfEdge, keepOpen = true) => {
    clearTimeout(hoverTimer.current); clearTimeout(closeTimer.current)
    useTaskShelf.getState().invalidateIntent()
    setDismissed(false)
    setPreferences(p => ({ ...p, edge: next }))
    if (keepOpen) { setPinned(true); setExpanded(true) }
  }
  const stopMove = () => { moveStart.current = undefined; moveTarget.current = null; setMoving(false); setDropEdge(null) }
  const startMove = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    clearTimeout(hoverTimer.current); clearTimeout(closeTimer.current)
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
    if (!moveStart.current) return
    const next = moveTarget.current, wasOpen = moveStart.current?.open ?? false
    stopMove()
    if (next) changeEdge(next, wasOpen)
  }

  const tasksInMain = entries.filter(entry => !entry.archivedAt && !entry.trashedAt && (shelfEntryVisible(entry.id) || previewEntries[entry.id]))
  const recallAll = () => {
    for (const entry of tasksInMain) useTaskShelf.getState().hide(entry.id)
    setSelected(tasksInMain[0]?.id ?? null)
  }

  const dragOver = (event: React.DragEvent) => {
    if (canDrop) { pointerInsideWindow.current = true; clearTimeout(hoverTimer.current); clearTimeout(closeTimer.current); event.preventDefault(); event.stopPropagation(); setDismissed(false); setExpanded(true); setDropOver(true); event.dataTransfer.dropEffect = 'move' }
  }

  return <>
    <TaskShelfContextMenu onDetails={id => { setSelected(id); setDetailsEntryId(id) }} />
    {resizing && <div className="task-shelf-resize-shield" style={{ cursor: horizontal ? 'row-resize' : 'col-resize' }} aria-hidden="true" />}
    {moving && <div className="task-shelf-position-overlay" aria-hidden="true">
      {(['left', 'right', 'top', 'bottom'] as ShelfEdge[]).map(side => <div key={side} className={`task-shelf-position-target at-${side} ${dropEdge === side ? 'is-target' : ''}`}>{t(`taskShelf.edge.${side}`)}</div>)}
    </div>}
    <button ref={edge} data-edge={preferences.edge} className={`task-shelf-edge win-no-drag ${shown ? 'is-open' : ''} ${canDrop ? 'is-drop-target' : ''}`} aria-controls={panelId} aria-expanded={shown}
      tabIndex={shown ? -1 : 0} aria-label={t('taskShelf.toggleHint', { shortcut: shortcuts.toggleShortcut || '—' })}
      title={t('taskShelf.toggleHint', { shortcut: shortcuts.toggleShortcut || '—' })}
      onMouseEnter={enter} onMouseLeave={exit} onFocus={holdEntryFocus} onBlur={leave}
      onClick={event => {
        clearTimeout(hoverTimer.current); clearTimeout(closeTimer.current)
        // detail 为 0 说明是键盘 Enter/Space 触发，打开后把焦点移入面板。
        if (event.detail === 0) { keyboardOpen.current = true; keyboardNavigating.current = true }
        setDismissed(false); setPinned(true)
      }}
      onDragOver={dragOver} onDrop={event => { void handleDrop(event) }}>
      {attention > 0 && <span className="task-shelf-handle-dot" />}
    </button>
    <aside ref={root} id={panelId} data-edge={preferences.edge} className={`task-shelf win-no-drag ${shown ? 'is-open' : ''} ${moving ? 'is-moving' : ''} ${docked && shown ? 'is-docked' : ''} ${dropOver ? 'is-drop' : ''} ${showPreviews ? 'has-previews' : ''}`}
    style={horizontal ? { width, height } : { width }} aria-hidden={!shown} aria-label={t('taskShelf.title')} onMouseEnter={enter} onMouseLeave={exit}
    onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false; if (!pointerInside.current) leave() }}
    onKeyDownCapture={event => { if (['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) keyboardNavigating.current = true }}
    onPointerDownCapture={() => { keyboardNavigating.current = false }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) keyboardNavigating.current = false; if (!pointerInside.current) leave() }} onDragOver={dragOver} onDragLeave={event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { setDropOver(false); leave() }
    }} onDrop={event => { void handleDrop(event) }}>
    <div className="task-shelf-panel">
      <div className="task-shelf-resizer" role="separator" aria-label={t('taskShelf.resize')} aria-orientation={horizontal ? 'horizontal' : 'vertical'} tabIndex={0}
        onKeyDown={event => {
          const increase = horizontal ? event.key === (preferences.edge === 'top' ? 'ArrowDown' : 'ArrowUp') : event.key === (preferences.edge === 'left' ? 'ArrowRight' : 'ArrowLeft')
          const decrease = horizontal ? event.key === (preferences.edge === 'top' ? 'ArrowUp' : 'ArrowDown') : event.key === (preferences.edge === 'left' ? 'ArrowLeft' : 'ArrowRight')
          if (increase || decrease) { event.preventDefault(); resizeCommit.schedule(resizeValue(increase ? 16 : -16)); resizeCommit.flush() }
        }}
        onPointerDown={event => {
          if (event.button !== 0 || resizeStart.current) return
          resizeAnimations.current.forEach(animation => animation.cancel()); resizeAnimations.current = []
          resizeStart.current = { x: horizontal ? event.clientY : event.clientX, width: horizontal ? height : width, value: horizontal ? height : width, columns: grid.columns, rows: horizontalLayout.rows, showPreviews, bodyInset: height - (body.current?.clientHeight ?? bodyHeight) }
          event.currentTarget.setPointerCapture(event.pointerId)
          resizeLease.current = beginLayoutResize()
          setResizing(true); event.preventDefault()
        }}
        onPointerMove={event => { const start = resizeStart.current; if (start) {
          const delta = ((horizontal ? event.clientY : event.clientX) - start.x) * (preferences.edge === 'left' || preferences.edge === 'top' ? 1 : -1)
          resizeCommit.schedule(horizontal ? shelfPanelHeight(start.width + delta, availableHeight) : shelfPanelWidth(start.width + delta, available, windowWidth))
        } }}
        onPointerUp={finishResize} onPointerCancel={finishResize} onLostPointerCapture={finishResize} />
      <div className={`task-shelf-chrome ${horizontal ? 'task-shelf-move-region' : ''}`}
        onPointerDown={event => {
          const target = event.target as Element
          if (target.closest('button, select, .task-shelf-options, .task-shelf-options-panel') || !horizontal && !target.closest('.task-shelf-header')) return
          startMove(event)
        }}
        onPointerMove={updateMove} onPointerUp={finishMove} onPointerCancel={stopMove} onLostPointerCapture={stopMove}>
      <header className="task-shelf-header task-shelf-move-region">
        <div className="task-shelf-heading"><h2>{t('taskShelf.shortTitle')}{attention > 0 && <span className="task-shelf-attention" aria-label={t('taskShelf.attention', { count: attention })} />}</h2></div>
        {activation && !activationNeedsAttention && !activityView && <span className="task-shelf-activation-success" role="status" aria-label={t('taskShelf.activationResult', { ...activation })} title={t('taskShelf.activationResult', { ...activation })}><svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m4 10 4 4 8-8" /></svg></span>}
        <div ref={options} className="task-shelf-options" onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node) && !optionsPanel.current?.contains(event.relatedTarget as Node)) setOptionsOpen(false) }}>
          <button className="task-shelf-options-toggle" type="button" aria-label={t('taskShelf.viewOptions')} aria-expanded={optionsOpen} aria-controls={optionsId} title={t('taskShelf.viewOptions')} onClick={() => setOptionsOpen(value => !value)}>
            <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><path d="M3 6h14M3 14h14" /><circle cx="7" cy="6" r="2" fill="var(--bg-base)" /><circle cx="13" cy="14" r="2" fill="var(--bg-base)" /></svg><span>{t(`taskShelf.mode.${preferences.mode}`)}</span>
          </button>
        </div>
        <button className="task-shelf-icon-button task-shelf-collapse" title={t('taskShelf.collapse')} aria-label={t('taskShelf.collapse')} onClick={closePanel}><svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m7 4 6 6-6 6" /></svg></button>
      </header>
      <div ref={optionsPanel} id={optionsId} className="task-shelf-options-panel" hidden={!optionsOpen} onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node) && !options.current?.contains(event.relatedTarget as Node)) setOptionsOpen(false) }}>
        <div className="task-shelf-option"><span>{t('taskShelf.displayMode')}</span><div className="task-shelf-modes" role="group" aria-label={t('taskShelf.displayMode')}>
          {(['auto', 'hover', 'fixed'] as const).map(mode => <button key={mode} aria-pressed={preferences.mode === mode} onClick={() => { setDismissed(false); setPreferences(p => ({ ...p, mode })) }}>{t(`taskShelf.mode.${mode}`)}</button>)}
        </div></div>
        <label className="task-shelf-option"><span>{t('taskShelf.realtimeLabel')}</span><select value={realtime} onChange={event => { const next = event.target.value === 'none' ? 'none' : 'tasks'; useTaskShelf.getState().invalidateIntent(); setRealtime(next); try { localStorage.setItem('lyshell.taskShelf.realtime.v1', next) } catch { /* 当前运行仍生效 */ } }}><option value="tasks">{t('taskShelf.realtimeTasks')}</option><option value="none">{t('taskShelf.realtimeNone')}</option></select></label>
        <details className="task-shelf-status-help"><summary>{t('taskShelf.statusLights')}</summary><TaskStatusLegend /></details>
      </div>
      <div className="task-shelf-view-row">
      <div ref={views} className="task-shelf-views" role="tablist" aria-label={t('taskShelf.taskViews')} onFocus={event => { if (event.target instanceof HTMLElement && event.target.getAttribute('role') === 'tab') event.target.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }) }} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
        const current = tabs.findIndex(tab => tab.getAttribute('aria-selected') === 'true')
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length
        tabs[next]?.click(); tabs[next]?.focus()
      }}>
        <button role="tab" id={`${panelId}-tasks`} aria-controls={contentId} tabIndex={!showStored && !activityView ? 0 : -1} aria-selected={!showStored && !activityView} onClick={() => { choseView.current = true; useTaskShelf.getState().invalidateIntent(); setTaskView('tasks'); setActivityView(null) }}>{t('taskShelf.activeTasks')} {taskCount > 0 && <span className="task-shelf-view-count">{taskCount}</span>}</button>
        <button role="tab" id={`${panelId}-archive`} aria-controls={contentId} tabIndex={showArchived && !activityView ? 0 : -1} aria-selected={showArchived && !activityView} onClick={() => { choseView.current = true; useTaskShelf.getState().invalidateIntent(); setTaskView('archive'); setActivityView(null) }}>{t('taskShelf.archivedTasks')} {archiveCount > 0 && <span className="task-shelf-view-count">{archiveCount}</span>}</button>
        <button role="tab" id={`${panelId}-trash`} aria-controls={contentId} tabIndex={showTrash && !activityView ? 0 : -1} aria-selected={showTrash && !activityView} onClick={() => { choseView.current = true; useTaskShelf.getState().invalidateIntent(); setTaskView('trash'); setActivityView(null) }}>{t('taskShelf.trash')} {trashCount > 0 && <span className="task-shelf-view-count">{trashCount}</span>}</button>
        <button role="tab" id={`${panelId}-sessions`} aria-controls={contentId} tabIndex={activityView === 'sessions' ? 0 : -1} aria-selected={activityView === 'sessions'} onClick={() => { choseView.current = true; useTaskShelf.getState().invalidateIntent(); setActivityView('sessions') }}>{t('taskShelf.sessions')}</button>
        <button role="tab" id={`${panelId}-notices`} aria-controls={contentId} tabIndex={activityView === 'notices' ? 0 : -1} aria-selected={activityView === 'notices'} onClick={() => { choseView.current = true; useTaskShelf.getState().invalidateIntent(); setActivityView('notices') }}>{t('taskShelf.notices')} {unreadNoticeIds.length > 0 && <span className="task-shelf-view-count">{unreadNoticeIds.length}</span>}</button>
      </div>

      {!showStored && !activityView && <button className="task-shelf-view-action" disabled={!tasksInMain.length || tasksInMain.some(entry => busy[entry.id])} aria-label={t('taskShelf.recallAll')} title={t('taskShelf.recallAllHint')} onClick={recallAll}>
        <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4h4v12h-4M3 10h9m-3-3 3 3-3 3" /></svg><span>{t('taskShelf.recallAll')}</span>
      </button>}
      {showStored && !activityView && <button className="task-shelf-view-action" disabled={activating || startup?.status !== 'ready' || !displayedEntries.length} title={t(activating ? 'taskShelf.activating' : 'taskShelf.activateAll')} aria-label={t(activating ? 'taskShelf.activating' : 'taskShelf.activateAll')} onClick={() => { void activate(showTrash ? displayedEntries.map(entry => entry.id) : undefined, selectedEntry?.id) }}>
        <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 4H4v12h4m0-6h9m-3-3 3 3-3 3" /></svg><span>{t(activating ? 'taskShelf.activating' : 'taskShelf.activateAll')}</span>
      </button>}
      </div>
      </div>
      {activation && activationNeedsAttention && !activityView && <div className="task-shelf-activation" role="status">{t('taskShelf.activationResult', { ...activation })}{activation.failed > 0 && <button disabled={activating} onClick={() => { void useTaskShelf.getState().retryActivation() }}>{t('taskShelf.retryActivation')}</button>}</div>}
      {error && <div className="task-shelf-error" role="alert"><span>{error}</span><button onClick={() => { void retry() }}>{t('taskShelf.retry')}</button></div>}
      {canDrop && <div className="task-shelf-drop-target">{t('taskShelf.drop')}</div>}
      <div ref={body} id={contentId} role="tabpanel" aria-labelledby={`${panelId}-${activeView}`} className={`task-shelf-body ${activityView ? 'is-activity' : ''} ${showArchived ? 'is-archive' : ''} ${showTrash ? 'is-trash' : ''}`} style={{ '--shelf-preview-aspect': SHELF_PREVIEW_ASPECT_RATIO, '--shelf-browser-bar-height': `${SHELF_BROWSER_BAR_HEIGHT}px`, ...(horizontal ? { '--shelf-grid-width': `${horizontalLayout.gridWidth}px`, '--shelf-preview-width': `${horizontalLayout.previewCardWidth}px` } : {}) } as React.CSSProperties}>
      {activityView && <WorkbenchActivity view={activityView} />}
      {!activityView && displayedEntries.length > 0 && <div className={`task-shelf-grid ${!showPreviews ? 'is-overview' : ''}`} role="group" aria-label={t('taskShelf.gridLabel')} style={horizontal ? { gridTemplateRows: `repeat(${horizontalLayout.rows}, 124px)` } : { gridTemplateColumns: `repeat(${grid.columns}, minmax(0, 1fr))`, '--shelf-grid-columns': grid.columns, '--shelf-grid-rows': gridRows } as React.CSSProperties}>
        {displayedEntries.map((entry, index) => {
          const binding = bindings[entry.id]
          const inMain = shelfEntryVisible(entry.id)
          const status = resolveShelfTaskStatus(entry, binding, activity, sessions.find(s => s.id === binding?.id)?.status, Math.max(now, Date.now()))
          const hasPreview = SHELF_PREVIEWS_ENABLED && shown && !showStored && realtime === 'tasks' && !!previewEntries[entry.id] && !!binding && !inMain
          return <button key={entry.id} data-shelf-card={entry.id} className={`task-shelf-tile ${focusedId === entry.id ? 'is-selected' : ''} ${inMain ? 'is-in-main' : ''} ${hasPreview ? 'has-preview' : ''}`}
            aria-label={t('taskShelf.slot', { index: index + 1 })} aria-pressed={previewEntry?.id === entry.id} title={[entry.title, entry.workspace, showTrash ? t('taskShelf.trash') : t(`taskShelf.activityStatus.${status}`), showStored ? t('taskShelf.activateTask') : inMain || previewEntry?.id === entry.id ? t('taskShelf.recallTask') : t('taskShelf.openInShelf')].filter(Boolean).join('\n')}
            disabled={busy[entry.id] || activating} onFocus={() => setSelected(entry.id)} onContextMenu={event => showShelfEntryContextMenu(event, entry.id)}
            onClick={() => {
              if (showStored) void activate([entry.id], entry.id)
              else toggleTask(entry.id)
            }}>
            <span className="task-shelf-tile-lamp"><TaskTileStatusLight entry={entry} binding={binding} terminalStatus={sessions.find(session => session.id === binding?.id)?.status} hostPresent={!!binding && !!overlayPayloads[binding.id]} taskStatus={status} visible={shown} now={now} /></span>
            <span className="task-shelf-tile-surface">{hasPreview && binding
              ? <TaskShelfPreview kind={binding.kind} id={binding.id} variant="tile" fallback={<ShelfIcon kind={entry.recovery.kind} />} />
              : <span className="task-shelf-tile-location" title={t(`taskShelf.type.${entry.recovery.kind}`)}><ShelfIcon kind={entry.recovery.kind} /></span>}</span>
            <span className="task-shelf-tile-label"><span>{entry.title}</span></span>
            <span className={`task-shelf-tile-state status-${status}`} title={showTrash ? t('taskShelf.trash') : t(`taskShelf.activityStatus.${status}`)}>{showTrash ? t('taskShelf.trash') : showArchived ? t('taskShelf.archivedBadge') : !binding ? t('taskShelf.savedLabel') : t(`taskShelf.statusShort.${status}`)}</span>
          </button>
        })}
      </div>}
      {!activityView && <div className={`task-shelf-list ${showPreviews && displayedEntries.length > 0 ? 'has-preview-slot' : ''} ${focusedWindows.length > 0 ? 'has-live-windows' : ''}`}>
        {!loaded && <span className="task-shelf-loading" role="status">{t('taskShelf.loading')}</span>}
        {loaded && displayedEntries.length === 0 && <div className="task-shelf-empty">
          <ShelfIcon /><h3>{t(showTrash ? 'taskShelf.emptyTrash' : showArchived ? 'taskShelf.emptyArchive' : 'taskShelf.emptyTitle')}</h3>
          <p>{t(showTrash ? 'taskShelf.trashHint' : showArchived ? 'taskShelf.archiveHint' : 'taskShelf.emptyHint', { count: TASK_SHELF_TRASH_LIMIT })}</p>
        </div>}
        {loaded && displayedEntries.length > 0 && showPreviews && !previewEntry && <div className="task-shelf-preview-idle">
          <ShelfIcon /><h3>{t('taskShelf.previewTitle')}</h3><p>{t('taskShelf.previewHint')}</p>
        </div>}
        {focusedWindows.map(entry => {
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
              onClick={() => setSelected(entry.id)}>
              <ShelfIcon kind={entry.recovery.kind} /><span className="task-shelf-item-text"><strong>{entry.title}</strong><span>{entry.workspace || t(`taskShelf.type.${entry.recovery.kind}`)}</span><small className={`task-shelf-status status-${status}`}>{busy[entry.id] ? t('taskShelf.opening') : t(`taskShelf.status.${status}`)}</small></span>
            </button>
            {showPreviews && <div className="task-shelf-window-toolbar"><span className="task-shelf-window-state" title={t(`taskShelf.activityStatus.${taskStatus}`)}><TaskStatusLight status={taskStatus} /><span>{t(`taskShelf.statusShort.${taskStatus}`)}</span></span>
              {!horizontal && width < inputWidth && <button className="task-shelf-enable-input" title={t('taskShelf.enableInput')} onClick={() => { setPreferences(p => ({ ...p, width: inputWidth })); setPinned(true) }}>{t('taskShelf.typeHere')}</button>}
            </div>}
            <div className="task-shelf-item-actions">
              <button className="task-shelf-main-button" disabled={busy[entry.id] || !binding} title={t('taskShelf.expandTask')} aria-label={t('taskShelf.expandTask')} onClick={() => { void openInMain(entry.id) }}><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><path d="M3 9 9 3M3 3h6v6"/></svg></button>
              <button title={t('taskShelf.taskActions')} aria-label={t('taskShelf.taskActions')} onClick={event => {
                const rect = event.currentTarget.getBoundingClientRect()
                showShelfEntryContextMenu({ preventDefault: () => event.preventDefault(), stopPropagation: () => event.stopPropagation(), clientX: rect.right, clientY: rect.bottom }, entry.id)
              }}><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="13" cy="8" r="1"/></svg></button>
            </div>
            </div>
            {restoreErrors[entry.id] && <p className="task-shelf-error" role="status">{restoreErrors[entry.id]}</p>}
            {!binding && <div className="task-shelf-window-pending" role="status">
              <span>{restoreErrors[entry.id] || (Object.hasOwn(restoreFailures, entry.id) ? error : t('taskShelf.opening'))}</span>
              {(restoreErrors[entry.id] || Object.hasOwn(restoreFailures, entry.id)) && <button onClick={() => openInShelf(entry.id)}>{t('taskShelf.retry')}</button>}
            </div>}
            {shown && showPreviews && binding && <div className="task-shelf-window-body">
              {binding.kind === 'web' && <TaskShelfBrowserBar id={binding.id} interactive={interactive} />}
              <div className={`task-shelf-window-content is-${binding.kind}`}><TaskShelfLiveSurface kind={binding.kind} id={binding.id} interactive={interactive} /></div>
            </div>}
          </div>
        })}
      </div>}
      </div>
      {selectedEntry && detailsEntryId === selectedEntry.id && !activityView && <div className="task-shelf-detail">
        <button className="task-shelf-detail-close" title={t('common.close')} aria-label={t('common.close')} onClick={() => setDetailsEntryId(null)}><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" /></svg></button>
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
// 停靠预留尺寸会更新 MainWindow；避免父级因此把侧栏同一帧再渲染一遍。
export default React.memo(TaskShelf)
