import { create } from 'zustand'
import { DEFAULT_TASK_SHELF_PREFERENCES, type TaskShelfPreferences, type ShelfResource, type TaskShelfEntry, type TaskShelfRequest, type TaskShelfResult } from '@shared/task-shelf'
import { usePaneStore } from './pane-store'
import { useSessionStore } from './session-store'
import { useWorkbenchActivity } from './workbench-activity'
import { ConnectionStatus } from '@shared/types'

type Binding = { kind: ShelfResource['kind']; id: string }
interface ShelfStore {
  entries: TaskShelfEntry[]
  bindings: Record<string, Binding>
  loaded: boolean
  busy: Record<string, boolean>
  restoringArchived: boolean
  error: string | null
  saveErrors: Record<string, string>
  restoreFailures: Record<string, boolean>
  reservedWidth: number
  reservedHeight: number
  reservedEdge: 'left' | 'right' | 'top' | 'bottom'
  panelVisible: boolean
  viewRequest: { revision: number; open: boolean; entryId?: string; notices?: boolean } | null
  showPanel: (entryId?: string, notices?: boolean) => void
  togglePanel: () => void
  preferences: TaskShelfPreferences
  load: () => Promise<void>
  collect: (resource: ShelfResource) => Promise<boolean>
  open: (id: string, paneId?: string, background?: boolean) => Promise<boolean>
  remove: (id: string) => Promise<void>
  hide: (id: string) => void
  retry: () => Promise<void>
  archive: (id: string, archived: boolean) => Promise<boolean>
  restoreArchived: () => Promise<boolean>
  setPreferences: (preferences: TaskShelfPreferences) => Promise<boolean>
}

let queue = Promise.resolve()
const pending = new Map<string, Promise<boolean>>()
const dirty = new Set<string>()
let timer: ReturnType<typeof setTimeout> | undefined

function invoke(request: TaskShelfRequest): Promise<Extract<TaskShelfResult, { success: true }>> {
  const call = queue.then(async () => {
    if (!window.electronAPI?.taskShelfRequest) throw new Error('任务保存区暂不可用，请更新并重启 LyShell。')
    const result = await window.electronAPI.taskShelfRequest(request)
    if (!result.success) throw new Error(result.error)
    useTaskShelf.setState({ entries: result.entries, loaded: true, ...(result.preferences ? { preferences: result.preferences } : {}) })
    return result
  })
  queue = call.then(() => undefined, () => undefined)
  return call
}

export function shelfResource(kind: Binding['kind'], id: string): ShelfResource | null {
  if (kind === 'terminal') return useSessionStore.getState().sessions.some(s => s.id === id && !s.config.ownerPluginId) ? { kind, id } : null
  const payload = usePaneStore.getState().overlayPayloads[id]
  if (!payload || payload.ownerPluginId) return null
  if (kind === 'web' && payload.kind === 'web') {
    const url = payload.nav?.url || payload.url
    return { kind, id, url: url.length <= 4096 ? url : '', title: payload.title.slice(0, 200), post: !!payload.postToken || !!payload.fromPost }
  }
  return kind === 'harness' && payload.kind === 'dshWeb' ? { kind, id } : null
}

export function shelfEntryFor(kind: Binding['kind'], id: string): string | undefined {
  return Object.entries(useTaskShelf.getState().bindings).find(([, b]) => b.kind === kind && b.id === id)?.[0]
}

export function collectActiveShelfTask(): Promise<boolean> {
  const pane = usePaneStore.getState(), leaf = pane.getAllLeafPanes().find(item => item.id === pane.layout.activePaneId)
  if (!leaf) return Promise.resolve(false)
  const overlay = leaf.overlays.find(ref => ref.active && !ref.shelved)
  const resource = overlay ? shelfResource(overlay.kind === 'dshWeb' ? 'harness' : 'web', overlay.id) : leaf.activeSessionId ? shelfResource('terminal', leaf.activeSessionId) : null
  if (!resource) { useTaskShelf.setState({ error: '当前页签不支持收纳，请选择终端、DeepSeek 或普通网页。' }); return Promise.resolve(false) }
  return useTaskShelf.getState().collect(resource)
}

function hideBinding(binding: Binding): void {
  const pane = usePaneStore.getState()
  if (binding.kind === 'terminal') pane.toggleLiveSessionTabs([binding.id], true)
  else pane.shelveOverlay(binding.id)
}

export function shelfEntryVisible(id: string): boolean {
  const binding = useTaskShelf.getState().bindings[id]
  if (!binding) return false
  const pane = usePaneStore.getState()
  if (binding.kind === 'terminal') return !!pane.getPaneBySessionId(binding.id) && !pane.hiddenTabSessions[binding.id]
  const leaf = pane.getAllLeafPanes().find(p => p.overlays.some(r => r.id === binding.id))
  return !!leaf?.overlays.some(r => r.id === binding.id && !r.shelved)
}

async function reveal(binding: Binding, paneId?: string, background = false): Promise<boolean> {
  const pane = usePaneStore.getState()
  if (binding.kind === 'terminal') {
    if (!useSessionStore.getState().sessions.some(s => s.id === binding.id)) {
      const config = await window.electronAPI.getSession(binding.id)
      if (!config) return false
      useSessionStore.getState().addTemporarySession({ id: binding.id, config, status: ConnectionStatus.CONNECTING })
    }
    const target = paneId || pane.getPaneBySessionId(binding.id)?.id || pane.layout.activePaneId || pane.getAllLeafPanes()[0]?.id
    if (!target) return false
    if (paneId || !pane.getPaneBySessionId(binding.id)) pane.addSessionToPane(target, binding.id, { background })
    if (background) { hideBinding(binding); return true }
    pane.toggleLiveSessionTabs([binding.id], false)
    pane.deactivateOverlaysInPane(target)
    pane.setActiveSessionInPane(target, binding.id)
    pane.setActivePane(target)
    window.dispatchEvent(new CustomEvent('terminal-tab-switched'))
    return true
  }
  if (!pane.overlayPayloads[binding.id] || !pane.getOverlayPaneId(binding.id)) return false
  if (background) { hideBinding(binding); return true }
  if (paneId) pane.moveOverlayToPane(binding.id, paneId)
  pane.activateOverlay(binding.id)
  return true
}

async function capture(resource: ShelfResource, entryId?: string): Promise<boolean> {
  try {
    const result = await invoke({ kind: 'capture', resource, ...(entryId ? { entryId } : {}) })
    const entry = result.entry || result.entries.find(e => e.resourceKey === `${resource.kind}:${resource.id}`)
    if (!entry) throw new Error('保存结果缺少任务记录，请重试。')
    useTaskShelf.setState(state => {
      const saveErrors = { ...state.saveErrors }; delete saveErrors[entry.id]
      return { bindings: { ...state.bindings, [entry.id]: { kind: resource.kind, id: resource.id } }, saveErrors, error: null }
    })
    usePaneStore.getState().retainShelfResource(resource.id, resource.kind === 'terminal', true)
    return true
  } catch (error) {
    const message = (error as Error).message
    useTaskShelf.setState(state => ({ error: message, saveErrors: entryId ? { ...state.saveErrors, [entryId]: message } : state.saveErrors }))
    return false
  }
}

async function flush(): Promise<void> {
  if (timer) clearTimeout(timer)
  timer = undefined
  const ids = [...dirty]; dirty.clear()
  for (const id of ids) {
    const binding = useTaskShelf.getState().bindings[id]
    const resource = binding && shelfResource(binding.kind, binding.id)
    if (resource) await capture(resource, id)
  }
}

function schedule(id: string): void {
  dirty.add(id)
  // 固定尾窗，不被连续变更无限推迟；只刷新已收纳并仍有实例的任务。
  if (!timer) timer = setTimeout(() => { void flush() }, 700)
}

export const useTaskShelf = create<ShelfStore>((set, get) => ({
  entries: [], bindings: {}, loaded: false, busy: {}, restoringArchived: false, error: null, saveErrors: {}, restoreFailures: {}, reservedWidth: 0, reservedHeight: 0, reservedEdge: 'right', panelVisible: false, viewRequest: null, preferences: { ...DEFAULT_TASK_SHELF_PREFERENCES },
  showPanel: (entryId, notices = false) => set(state => ({ viewRequest: { revision: (state.viewRequest?.revision ?? 0) + 1, open: true, entryId, notices } })),
  togglePanel: () => set(state => ({ viewRequest: { revision: (state.viewRequest?.revision ?? 0) + 1, open: !state.panelVisible } })),
  load: async () => {
    try { await invoke({ kind: 'list' }); set({ error: null }) }
    catch (error) { set({ error: (error as Error).message }) }
  },
  collect: resource => {
    const key = `${resource.kind}:${resource.id}`
    const existing = pending.get(key)
    if (existing) return existing
    const job = (async () => {
      const id = shelfEntryFor(resource.kind, resource.id)
      const saved = await capture(resource, id)
      // 保存失败不隐藏，原现场保留。
      if (saved && shelfResource(resource.kind, resource.id)) hideBinding(resource)
      return saved
    })().finally(() => pending.delete(key))
    pending.set(key, job)
    return job
  },
  hide: id => { const binding = get().bindings[id]; if (binding) { hideBinding(binding); schedule(id) } },
  open: async (id, paneId, background = false) => {
    if (get().busy[id]) return false
    set(state => { const restoreFailures = { ...state.restoreFailures }; delete restoreFailures[id]; return { restoreFailures } })
    set(state => ({ busy: { ...state.busy, [id]: true }, error: null }))
    try {
      let binding = get().bindings[id]
      const stillLive = binding && (binding.kind !== 'terminal' || useSessionStore.getState().sessions.some(s => s.id === binding.id && ['connected', 'connecting'].includes(s.status)))
      if (binding && stillLive && await reveal(binding, paneId, background)) return true
      const result = await invoke({ kind: 'restore', id })
      const restored = result.restored
      if (!restored) throw new Error('当前任务需要在原界面手动恢复。')
      if (restored.kind === 'terminal') binding = { kind: 'terminal', id: restored.sessionId }
      else if (restored.kind === 'web') {
        const pane = usePaneStore.getState()
        const overlayId = pane.mountOverlay(paneId, { kind: 'web', url: restored.url, title: result.entry?.title || restored.url }, { background })
        if (!overlayId) throw new Error('无法打开任务页签。')
        binding = { kind: 'web', id: overlayId }
      } else {
        const navigation = restored.sessionId && restored.identity
          ? await window.electronAPI.workbenchActivityNavigate({ kind: 'open', identity: restored.identity, sessionId: restored.sessionId }) : null
        if (navigation && !navigation.success) throw new Error(`原工作台会话暂不能定位（${restored.sessionId}）。请从 DeepSeek 面板打开官方工作台选择历史；任务没有重发。`)
        const response = navigation?.success ? navigation : await window.electronAPI.openDshWeb({})
        if (!response.success || !response.url) throw new Error(response.error || '无法打开 DeepSeek 工作台。')
        const pane = usePaneStore.getState()
        const overlayId = pane.mountOverlay(paneId, { kind: 'dshWeb', url: response.url, name: 'DeepSeek Harness' }, { background })
        if (!overlayId) throw new Error('无法打开工作台页签。')
        if (navigation?.success && restored.identity && restored.sessionId) {
          const deadline = Date.now() + 12000
          let confirmed = false
          while (Date.now() < deadline) {
            const progress = await window.electronAPI.workbenchActivityNavigate({ kind: 'navigation', identity: restored.identity, sessionId: restored.sessionId, requestId: navigation.requestId })
            if (!progress.success || progress.navigation === 'failed') break
            if (progress.navigation === 'navigated') { confirmed = true; break }
            await new Promise(resolve => setTimeout(resolve, 250))
          }
          if (!confirmed) throw new Error('工作台没有确认原会话的跳转，请在官方界面核对；任务没有重发。')
        }
        binding = { kind: 'harness', id: overlayId }
      }
      set(state => ({ bindings: { ...state.bindings, [id]: binding } }))
      if (!await reveal(binding, paneId, background)) throw new Error('任务已恢复，定位页签失败，请重试定位。')
      const resource = shelfResource(binding.kind, binding.id)
      if (resource) await capture(resource, id)
      return true
    } catch (error) { set(state => ({ error: (error as Error).message, restoreFailures: { ...state.restoreFailures, [id]: false } })); return false }
    finally { set(state => { const busy = { ...state.busy }; delete busy[id]; return { busy } }) }
  },
  remove: async id => {
    if (get().busy[id]) return
    try {
      const binding = get().bindings[id]
      // 运行资源先恢复可见，再取消保存；不关闭进程或网页。
      if (binding) await reveal(binding)
      const result = await invoke({ kind: 'remove', id })
      if (!binding && result.restored?.kind === 'terminal') await reveal({ kind: 'terminal', id: result.restored.sessionId })
      if (binding) usePaneStore.getState().retainShelfResource(binding.id, binding.kind === 'terminal', false)
      dirty.delete(id)
      set(state => {
        const bindings = { ...state.bindings }; delete bindings[id]
        const saveErrors = { ...state.saveErrors }; delete saveErrors[id]
        const restoreFailures = { ...state.restoreFailures }; delete restoreFailures[id]
        return { bindings, saveErrors, restoreFailures, error: null }
      })
    } catch (error) { set({ error: (error as Error).message }) }
  },
  retry: async () => {
    const failures = Object.entries(get().restoreFailures)
    if (failures.length) {
      const errors: string[] = []
      for (const [id, archived] of failures) {
        if (!await (archived ? get().archive(id, false) : get().open(id))) errors.push(get().error || '恢复失败，请重试。')
      }
      set({ error: errors.length ? [...new Set(errors)].join('\n') : null })
      return
    }
    for (const id of Object.keys(get().bindings)) dirty.add(id)
    await flush()
    if (!get().loaded) await get().load()
  },
  archive: async (id, archived) => {
    if (get().busy[id]) return false
    try {
      // 移回 Tasks 代表恢复可用实例；启动失败时仍留在归档，便于重试。
      if (!archived && !await get().open(id, undefined, true)) {
        set(state => ({ restoreFailures: { ...state.restoreFailures, [id]: true } }))
        return false
      }
      await invoke({ kind: 'archive', id, archived })
      get().hide(id)
      return true
    } catch (error) { set(state => ({ error: (error as Error).message, ...(!archived ? { restoreFailures: { ...state.restoreFailures, [id]: true } } : {}) })); return false }
  },
  restoreArchived: async () => {
    if (get().restoringArchived) return false
    set({ restoringArchived: true })
    try {
      const ids = get().entries.filter(entry => !!entry.archivedAt).map(entry => entry.id)
      const errors: string[] = []
      for (const id of ids) {
        if (!await get().archive(id, false)) errors.push(get().error || '任务正在恢复，请稍后重试。')
      }
      set({ error: errors.length ? [...new Set(errors)].join('\n') : null })
      return !errors.length
    } catch (error) {
      set({ error: (error as Error).message })
      return false
    } finally { set({ restoringArchived: false }) }
  },
  setPreferences: async preferences => {
    try { await invoke({ kind: 'preferences', preferences }); set({ error: null }); return true }
    catch (error) { set({ error: (error as Error).message }); return false }
  }
}))

/** 事件跟随任务，不跟随页签显隐；收纳以后前台继续使用也持续捕获。 */
export function initializeTaskShelf(): () => void {
  void useTaskShelf.getState().load()
  const offPanes = usePaneStore.subscribe((state, previous) => {
    if (state.overlayPayloads === previous.overlayPayloads) return
    for (const [id, binding] of Object.entries(useTaskShelf.getState().bindings)) {
      if (binding.kind !== 'terminal' && state.overlayPayloads[binding.id] !== previous.overlayPayloads[binding.id]) schedule(id)
    }
  })
  const offSessions = useSessionStore.subscribe((state, previous) => {
    if (state.sessions === previous.sessions) return
    for (const [id, binding] of Object.entries(useTaskShelf.getState().bindings)) {
      if (binding.kind !== 'terminal') continue
      const next = state.sessions.find(s => s.id === binding.id), old = previous.sessions.find(s => s.id === binding.id)
      if (next && (next.cwd !== old?.cwd || next.config !== old?.config || next.status !== old?.status)) schedule(id)
    }
  })
  const offActivity = useWorkbenchActivity.subscribe((state, previous) => {
    if (state.snapshot === previous.snapshot) return
    for (const [id, binding] of Object.entries(useTaskShelf.getState().bindings)) {
      // Harness 的当前会话与回合由主进程官方快照核实；收起后同样跟随活动源更新。
      if (binding.kind === 'harness') { schedule(id); continue }
      if (binding.kind !== 'terminal') continue
      const row = state.snapshot?.tui?.sessions.find(s => s.terminalId === binding.id)
      const old = previous.snapshot?.tui?.sessions.find(s => s.terminalId === binding.id)
      if (row && (row.cliSessionId !== old?.cliSessionId || row.state !== old?.state)) schedule(id)
    }
  })
  // SSH 输出单独合并到约 3 秒一轮；终端状态变化仍会更早触发最终快照。
  const outputDirty = new Set<string>()
  let outputTimer: ReturnType<typeof setTimeout> | undefined
  const offOutput = window.electronAPI.onTerminalData?.((sessionId: string) => {
    for (const [id, binding] of Object.entries(useTaskShelf.getState().bindings)) {
      if (binding.kind !== 'terminal' || binding.id !== sessionId) continue
      const entry = useTaskShelf.getState().entries.find(item => item.id === id)
      if (entry?.recovery.kind === 'terminal' && entry.recovery.type === 'ssh') outputDirty.add(id)
    }
    if (outputDirty.size && !outputTimer) outputTimer = setTimeout(() => {
      outputTimer = undefined
      for (const id of outputDirty) schedule(id)
      outputDirty.clear()
    }, 3000)
  })
  const onHide = () => {
    clearTimeout(outputTimer); outputTimer = undefined
    for (const id of outputDirty) dirty.add(id)
    outputDirty.clear(); void flush()
  }
  window.addEventListener('pagehide', onHide)
  return () => {
    offPanes(); offSessions(); offActivity(); offOutput?.(); clearTimeout(outputTimer)
    for (const id of outputDirty) dirty.add(id)
    window.removeEventListener('pagehide', onHide); void flush()
  }
}
