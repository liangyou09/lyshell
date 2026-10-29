import { create } from 'zustand'
import { DEFAULT_TASK_SHELF_PREFERENCES, type TaskShelfPreferences, type ShelfResource, type TaskShelfEntry, type TaskShelfRequest, type TaskShelfResult, type TaskShelfStartup, type TaskShelfActivation } from '@shared/task-shelf'
import { usePaneStore } from './pane-store'
import { useSessionStore } from './session-store'
import { useWorkbenchActivity } from './workbench-activity'
import { ConnectionStatus } from '@shared/types'
import { createBrowserRestoreScheduler, type BrowserRestoreSource, type BrowserRestoreContext } from './browser-restore-scheduler'
import { waitForBrowserLoad, settleBrowserLoad } from './browser-load-tracker'
import { beginShelfTerminalRestore } from './shelf-terminal-placement'

type Binding = { kind: ShelfResource['kind']; id: string }
interface ShelfStore {
  entries: TaskShelfEntry[]
  bindings: Record<string, Binding>
  previewEntries: Record<string, true>
  setPreview: (id: string, visible: boolean) => void
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
  viewRequest: { revision: number; open: boolean; entryId?: string; notices?: boolean; view?: 'tasks' | 'archive' | 'sessions' | 'notices' } | null
  startup: TaskShelfStartup | null
  activation: TaskShelfActivation | null
  activating: boolean
  activationDemand: { revision: number; intent: number; ids: string[]; single: boolean; consumed?: boolean } | null
  restoreErrors: Record<string, string>
  uiIntentRevision: number
  invalidateIntent: () => number
  activate: (ids?: string[], selectionId?: string) => Promise<TaskShelfActivation | null>
  retryActivation: () => Promise<void>
  showPanel: (entryId?: string, notices?: boolean) => void
  showActivity: (view: 'sessions' | 'notices') => void
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

async function restoreBrowser(context: BrowserRestoreContext): Promise<Binding> {
  const id = context.resourceId
  const current = useTaskShelf.getState().bindings[id]
  if (current && usePaneStore.getState().overlayPayloads[current.id]) {
    const state = await window.electronAPI?.shelfBrowserRequest?.({ kind: 'inspect', resourceId: `saved:${id}` })
    if (state?.success && (state.state === 'sleeping' || state.state === 'suspending')) {
      if (!context.isValid()) throw new Error('Restore demand withdrawn')
      const loaded = waitForBrowserLoad(current.id)
      void loaded.catch(() => undefined)
      const wake = await window.electronAPI.shelfBrowserRequest({ kind: 'wake', resourceId: `saved:${id}`, source: context.source() })
      if (!wake.success) { settleBrowserLoad(current.id, wake.error); throw new Error(wake.error) }
      context.onCreated()
      if (context.source() === 'explicitMain') await reveal(current)
      await loaded
    }
    return current
  }
  const result = await invoke({ kind: 'restore', id })
  if (!context.isValid()) throw new Error('Restore demand withdrawn')
  if (result.restored?.kind !== 'web') throw new Error('Only ordinary webpages can be restored automatically')
  const overlayId = `shelf-web-${id}`
  const loaded = waitForBrowserLoad(overlayId)
  // 立即安装拒绝处理器，挂载前的同步错误也不会产生 unhandled rejection。
  void loaded.catch(() => undefined)
  const pane = usePaneStore.getState()
  const mounted = pane.mountOverlay(undefined, { kind: 'web', url: result.restored.url, title: result.entry?.title || result.restored.url, shelfTaskId: id, readonlyMode: result.entry?.recovery.kind === 'web' && result.entry.recovery.readonlyMode === true, reloadableMode: result.entry?.recovery.kind === 'web' && result.entry.recovery.reloadableMode === true }, { id: overlayId, background: true })
  if (!mounted) { settleBrowserLoad(overlayId, '无法创建网页入口'); throw new Error('无法创建网页入口') }
  context.onCreated()
  const binding: Binding = { kind: 'web', id: mounted }
  useTaskShelf.setState(state => ({ bindings: { ...state.bindings, [id]: binding } }))
  pane.retainShelfResource(mounted, false, true)
  if (context.source() === 'explicitMain') await reveal(binding)
  else pane.shelveOverlay(mounted)
  try { await loaded }
  catch (error) { useTaskShelf.setState(state => state.entries.some(entry => entry.id === id) ? { restoreErrors: { ...state.restoreErrors, [id]: (error as Error).message } } : {}); throw error }
  useTaskShelf.setState(state => { const restoreErrors = { ...state.restoreErrors }; delete restoreErrors[id]; return { restoreErrors } })
  return binding
}
const browserRestores = createBrowserRestoreScheduler<Binding>({ run: restoreBrowser })
export async function requestShelfBrowserRestore(id: string, source: BrowserRestoreSource, isValid: () => boolean): Promise<Binding | null> {
  const result = await browserRestores.submit(id, source, isValid)
  useTaskShelf.setState(state => {
    if (!state.entries.some(entry => entry.id === id)) return {}
    const restoreErrors = { ...state.restoreErrors }
    if (result.status === 'ready') delete restoreErrors[id]
    else if (result.status !== 'cancelled') restoreErrors[id] = result.error || (result.status === 'busy' ? '恢复预算已满，请选择卡片或在主区打开。' : '网页恢复失败，请在主区打开后重试。')
    return { restoreErrors }
  })
  return result.status === 'ready' ? result.value : null
}
export const shelfBrowserRestoreDiagnostics = () => browserRestores.diagnostics()
export function releaseSleepingBrowserResident(overlayId: string): void {
  for (const [id, binding] of Object.entries(useTaskShelf.getState().bindings)) if (binding.kind === 'web' && binding.id === overlayId) browserRestores.releaseResident(id)
}
export function withdrawShelfBrowserRestores(id?: string): void {
  for (const entry of useTaskShelf.getState().entries) {
    if (id && entry.id !== id) continue
    browserRestores.withdraw(entry.id, 'explicitShelf')
    browserRestores.withdraw(entry.id, 'bulkVisible')
  }
}

function invoke(request: TaskShelfRequest): Promise<Extract<TaskShelfResult, { success: true }>> {
  const call = queue.then(async () => {
    if (!window.electronAPI?.taskShelfRequest) throw new Error('任务保存区暂不可用，请更新并重启 LyShell。')
    const result = await window.electronAPI.taskShelfRequest(request)
    if (!result.success) { if (result.startup) useTaskShelf.setState({ startup: result.startup }); throw new Error(result.error) }
    useTaskShelf.setState({ entries: result.entries, loaded: true, ...(result.preferences ? { preferences: result.preferences } : {}), ...(result.startup ? { startup: result.startup } : {}) })
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
  previewEntries: {},
  setPreview: (id, visible) => set(state => {
    const previewEntries = { ...state.previewEntries }
    if (visible) previewEntries[id] = true
    else delete previewEntries[id]
    return { previewEntries }
  }),
  entries: [], bindings: {}, loaded: false, busy: {}, restoringArchived: false, restoreFailures: {}, reservedHeight: 0, reservedEdge: 'right', error: null, saveErrors: {}, reservedWidth: 0, panelVisible: false, viewRequest: null, startup: null, activation: null, activating: false, activationDemand: null, restoreErrors: {}, uiIntentRevision: 0, preferences: { ...DEFAULT_TASK_SHELF_PREFERENCES },
  invalidateIntent: () => { const next = get().uiIntentRevision + 1; set({ uiIntentRevision: next }); return next },
  showPanel: (entryId, notices = false) => set(state => ({ uiIntentRevision: state.uiIntentRevision + 1, viewRequest: { revision: (state.viewRequest?.revision ?? 0) + 1, open: true, entryId, notices } })),
  showActivity: view => set(state => ({ uiIntentRevision: state.uiIntentRevision + 1, viewRequest: { revision: (state.viewRequest?.revision ?? 0) + 1, open: true, view } })),
  togglePanel: () => set(state => ({ uiIntentRevision: state.uiIntentRevision + 1, viewRequest: { revision: (state.viewRequest?.revision ?? 0) + 1, open: !state.panelVisible } })),
  load: async () => {
    try { const result = await invoke({ kind: 'list' }); set({ error: result.startup?.status === 'blocked' ? result.startup.error || '任务初始化失败，请重试。' : null }) }
    catch (error) { set({ error: (error as Error).message }) }
  },
  activate: async (ids, selectionId) => {
    if (get().activating) return null
    const startup = get().startup
    if (!startup || startup.status !== 'ready') { set({ error: startup?.error || '任务初始化尚未完成，请重试。' }); return null }
    // 点击时固定集合及版本；排队期间的新归档不加入本批。
    const wanted = ids ? new Set(ids) : null
    const snapshot = get().entries.filter(entry => wanted ? wanted.has(entry.id) : !!entry.archivedAt).map(entry => ({ taskId: entry.id, expectedRevision: entry.revision }))
    const intent = get().invalidateIntent()
    set({ activating: true, error: null })
    try {
      const result = await invoke({ kind: 'activate', bootId: startup.bootId, scopeId: startup.scopeId, requestId: crypto.randomUUID(), items: snapshot })
      const activation = result.activation
      if (!activation) throw new Error('激活结果未确认，请重新读取任务状态。')
      set({ activation })
      const successful = activation.items.filter(item => item.status === 'moved' || item.status === 'alreadyTasks').map(item => item.taskId)
      if (successful.length && get().uiIntentRevision === intent) {
        for (const id of successful) get().hide(id)
        const target = selectionId && get().entries.some(e => e.id === selectionId && !e.archivedAt) ? selectionId : successful[0]
        set(state => ({ viewRequest: { revision: (state.viewRequest?.revision ?? 0) + 1, open: state.panelVisible, view: 'tasks', entryId: target } }))
        set(state => ({ activationDemand: { revision: (state.activationDemand?.revision ?? 0) + 1, intent, ids: successful, single: !!ids && ids.length === 1 } }))
      }
      return activation
    } catch (error) { set({ error: (error as Error).message }); return null }
    finally { set({ activating: false }) }
  },
  retryActivation: async () => {
    const ids = get().activation?.items.filter(item => item.status === 'failed').map(item => item.taskId) ?? []
    if (!ids.length) return
    await get().load()
    const eligible = ids.filter(id => get().entries.some(e => e.id === id && !!e.archivedAt))
    if (eligible.length) await get().activate(eligible)
  },
  collect: resource => {
    const key = `${resource.kind}:${resource.id}`
    const existing = pending.get(key)
    if (existing) return existing
    const job = (async () => {
      const id = shelfEntryFor(resource.kind, resource.id)
      const saved = await capture(resource, id)
      // 保存失败不隐藏，原现场保留。
      if (saved && shelfResource(resource.kind, resource.id)) {
        const savedId = shelfEntryFor(resource.kind, resource.id)
        if (savedId) get().setPreview(savedId, false)
        hideBinding(resource)
      }
      return saved
    })().finally(() => pending.delete(key))
    pending.set(key, job)
    return job
  },
  hide: id => {
    get().setPreview(id, false)
    withdrawShelfBrowserRestores(id)
    const binding = get().bindings[id]
    if (binding) { hideBinding(binding); schedule(id) }
  },
  open: async (id, paneId, background = false) => {
    if (get().busy[id]) return false
    let releasePlacement: (() => void) | undefined
    const finishOpen = () => { if (!background) get().setPreview(id, false); return true }
    set(state => { const restoreFailures = { ...state.restoreFailures }; delete restoreFailures[id]; return { restoreFailures } })
    set(state => ({ busy: { ...state.busy, [id]: true }, error: null }))
    try {
      let binding = get().bindings[id]
      const stillLive = binding && (binding.kind !== 'terminal' || useSessionStore.getState().sessions.some(s => s.id === binding.id && ['connected', 'connecting'].includes(s.status)))
      if (binding && stillLive && await reveal(binding, paneId, background)) { if (binding.kind === 'web') browserRestores.releaseResident(id); return finishOpen() }
      let entry = get().entries.find(item => item.id === id)
      if (!entry) { await get().load(); entry = get().entries.find(item => item.id === id) }
      if (!entry) throw new Error('保存记录不存在或尚未读取成功，请重新加载后再打开。')
      if (entry?.recovery.kind === 'web') {
        const restored = await requestShelfBrowserRestore(id, background ? 'explicitShelf' : 'explicitMain', () => get().entries.some(item => item.id === id) && (!background || !!get().previewEntries[id]))
        if (!restored) return false
        if (!await reveal(restored, paneId, background)) throw new Error('网页已恢复，定位页签失败。')
        const resource = shelfResource('web', restored.id)
        if (resource) await capture(resource, id)
        return finishOpen()
      }
      if (background && entry.recovery.kind === 'terminal') releasePlacement = beginShelfTerminalRestore()
      const result = await invoke({ kind: 'restore', id })
      const restored = result.restored
      if (!restored) throw new Error('当前任务需要在原界面手动恢复。')
      if (restored.kind === 'terminal') binding = { kind: 'terminal', id: restored.sessionId }
      else if (restored.kind === 'web') {
        // 记录在请求期间被外部更新：下一次按新类型进入网页队列，不能旁路创建实体。
        throw new Error('保存任务类型已变化，请重新读取后再打开。')
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
      return finishOpen()
    } catch (error) { set(state => ({ error: (error as Error).message, restoreFailures: { ...state.restoreFailures, [id]: false } })); return false }
    finally { releasePlacement?.(); set(state => { const busy = { ...state.busy }; delete busy[id]; return { busy } }) }
  },
  remove: async id => {
    if (get().busy[id]) return
    get().invalidateIntent()
    try {
      let binding = get().bindings[id]
      // 运行资源先恢复可见，再取消保存；不关闭进程或网页。
      if (binding) await reveal(binding)
      const result = await invoke({ kind: 'remove', id })
      // 自动恢复可能在 remove 排队期间才挂载；以当前绑定交回主区，不能遗留无卡片的隐藏实例。
      const latest = get().bindings[id]
      if (latest && (latest.id !== binding?.id || latest.kind !== binding?.kind)) await reveal(latest)
      binding = latest ?? binding
      if (!binding && result.restored?.kind === 'terminal') await reveal({ kind: 'terminal', id: result.restored.sessionId })
      if (binding) usePaneStore.getState().retainShelfResource(binding.id, binding.kind === 'terminal', false)
      browserRestores.releaseResident(id)
      dirty.delete(id)
      set(state => {
        const bindings = { ...state.bindings }; delete bindings[id]
        const saveErrors = { ...state.saveErrors }; delete saveErrors[id]
        const restoreFailures = { ...state.restoreFailures }; delete restoreFailures[id]
        const restoreErrors = { ...state.restoreErrors }; delete restoreErrors[id]
        const previewEntries = { ...state.previewEntries }; delete previewEntries[id]
        return { bindings, previewEntries, saveErrors, restoreFailures, restoreErrors, error: null }
      })
    } catch (error) { set({ error: (error as Error).message }) }
  },
  retry: async () => {
    const startup = get().startup
    if (startup?.status === 'blocked') {
      try { await invoke({ kind: 'retryInitialization', bootId: startup.bootId, scopeId: startup.scopeId }); await get().load() }
      catch (error) { set({ error: (error as Error).message }) }
      return
    }
    const failures = Object.entries(get().restoreFailures)
    if (failures.length) {
      const errors: string[] = []
      for (const [id, archived] of failures) {
        if (!await (archived ? get().archive(id, false) : get().open(id, undefined, !!get().previewEntries[id]))) errors.push(get().error || '恢复失败，请重试。')
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
    if (!archived) {
      const result = await get().activate([id])
      return !!result?.items.some(item => item.taskId === id && (item.status === 'moved' || item.status === 'alreadyTasks'))
    }
    get().invalidateIntent()
    try {
      await invoke({ kind: 'archive', id, archived })
      get().hide(id)
      return true
    } catch (error) { set(state => ({ error: (error as Error).message, ...(!archived ? { restoreFailures: { ...state.restoreFailures, [id]: true } } : {}) })); return false }
  },
  restoreArchived: async () => {
    if (get().restoringArchived) return false
    set({ restoringArchived: true })
    try {
      // 保留原入口的兼容名称，所有批量移回都走固定快照；分类本身不创建 shell/Agent。
      const result = await get().activate()
      return !!result && result.failed === 0 && result.conflict === 0 && result.missing === 0
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
      if (binding.kind === 'web' && previous.overlayPayloads[binding.id] && !state.overlayPayloads[binding.id]) {
        settleBrowserLoad(binding.id, '网页入口已关闭')
        browserRestores.releaseResident(id)
      }
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
