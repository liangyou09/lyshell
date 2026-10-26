import { create } from 'zustand'
import type { WorkbenchActivityApproval, WorkbenchActivitySession, WorkbenchActivitySnapshot } from '@shared/workbench-activity'
import type { SceneTarget } from '@shared/project-scene'
import type { TuiActivitySnapshot } from '@shared/tui-activity'
import type { HarnessWebActivitySnapshot } from '@shared/harness-web-activity'

export const ACTIVITY_FRESH_MS = 12000
export function activityDirectoryKey(path: string, platform = window.electronAPI?.platform ?? ''): string {
  const normalized = platform === 'win32' ? path.replace(/\\/g, '/') : path
  if (platform === 'win32' && /^[a-zA-Z]:\/+$/u.test(normalized)) return normalized.slice(0, 2).toLowerCase() + '/'
  const trimmed = normalized.replace(/\/+$/, '') || (normalized.startsWith('/') ? '/' : '')
  return platform === 'win32' ? trimmed.toLowerCase() : trimmed
}
export interface ActivityNotice {
  id: string
  workspace: string
  sessionId: string
  taskId: string
  kind: 'approval' | 'completed' | 'failed' | 'turn-ended' | 'interrupted'
  source?: 'codex' | 'claude' | 'harness-web'
  launchId?: string
  tuiEventId?: string
  webEventId?: string
  at: number
}
export function activityFresh(snapshot: WorkbenchActivitySnapshot | null, now = Date.now()): boolean {
  return !!snapshot && snapshot.connection === 'connected' && !!snapshot.identity && now - snapshot.observedAt < ACTIVITY_FRESH_MS && now >= snapshot.observedAt
}
export function tuiActivityFresh(snapshot: TuiActivitySnapshot | undefined, now = Date.now()): boolean {
  return !!snapshot && now >= snapshot.observedAt && now - snapshot.observedAt < ACTIVITY_FRESH_MS
}
export function webActivityFresh(snapshot: HarnessWebActivitySnapshot | undefined, now = Date.now()): boolean {
  return !!snapshot?.identity && snapshot.connection === 'connected' && now >= snapshot.observedAt && now - snapshot.observedAt < ACTIVITY_FRESH_MS
}
export function collectWebNotices(current: HarnessWebActivitySnapshot | undefined, previous: HarnessWebActivitySnapshot | undefined, seen: Set<string>): ActivityNotice[] {
  if (!current || !webActivityFresh(current)) return []
  const sameBackend = !!previous?.identity && JSON.stringify(previous.identity) === JSON.stringify(current.identity)
  return current.events.flatMap(event => {
    const id = JSON.stringify(['harness-web', current.identity, event.id])
    if (seen.has(id)) return []
    seen.add(id)
    // 首次读取/后台换代建立基线，不重播旧终态；新会话的短回合仍能从事件日志提醒。
    if (event.kind !== 'approval' && !sameBackend) return []
    if (event.kind === 'approval' && !current.sessions.some(row => row.sessionId === event.sessionId && row.turnId === event.turnId && row.approvalIds.includes(event.id))) return []
    return [{ id, source: 'harness-web' as const, webEventId: event.id, workspace: event.workspace, sessionId: event.sessionId, taskId: event.turnId, kind: event.kind, at: event.at }]
  })
}
function tuiNewer(previous: TuiActivitySnapshot, incoming: TuiActivitySnapshot): boolean {
  if (previous.revision !== undefined && incoming.revision !== undefined && previous.revision !== incoming.revision) return previous.revision > incoming.revision
  return previous.observedAt > incoming.observedAt
}

export function collectTuiNotices(current: TuiActivitySnapshot | undefined, previous: TuiActivitySnapshot | undefined, seen: Set<string>): ActivityNotice[] {
  if (!current || !tuiActivityFresh(current)) return []
  const notices: ActivityNotice[] = []
  for (const event of current.events) {
    const id = JSON.stringify(['tui', event.launchId, event.id])
    if (seen.has(id)) continue
    seen.add(id)
    const session = current.sessions.find(row => row.launchId === event.launchId && row.terminalId === event.terminalId)
    if (!session || event.kind === 'approval' && (!session.active || session.state !== 'waiting-approval' || session.turnId !== event.turnId || session.approvalEventId && session.approvalEventId !== event.id)) continue
    // 初次挂载只显示当前审批，防止重播应用内已有的回合历史。
    if (!previous && event.kind !== 'approval') continue
    notices.push({ id, workspace: event.workspace, sessionId: event.terminalId, taskId: event.turnId,
      kind: event.kind, source: event.source, launchId: event.launchId, tuiEventId: event.id, at: event.at })
  }
  return notices
}

/** 提醒身份包含后台代际、会话、任务和审批，重复轮询不会重复提醒。 */
export function collectActivityNotices(snapshot: WorkbenchActivitySnapshot, previous: WorkbenchActivitySnapshot | null, seen: Set<string>): ActivityNotice[] {
  const notices: ActivityNotice[] = [...collectTuiNotices(snapshot.tui, previous?.tui, seen), ...collectWebNotices(snapshot.web, previous?.web, seen)]
  if (!activityFresh(snapshot)) return notices
  for (const row of snapshot.sessions) {
    if (row.stale || !row.taskId) continue
    const events: Array<{ kind: ActivityNotice['kind']; suffix: string }> = row.approvals.map(approval => ({ kind: 'approval', suffix: approval.id }))
    if (row.taskState === 'completed' || row.taskState === 'failed') events.push({ kind: row.taskState, suffix: row.taskState })
    for (const event of events) {
      const id = JSON.stringify([snapshot.identity, row.sessionId, row.taskId, event.kind, event.suffix])
      if (seen.has(id)) continue
      seen.add(id)
      // 每个新接入的会话都只提示待审批，不把其他凭据带入的历史终态当作新事件。
      const knownSession = previous && JSON.stringify(previous.identity) === JSON.stringify(snapshot.identity) &&
        previous.sessions.some(session => session.sessionId === row.sessionId)
      if (!knownSession && event.kind !== 'approval') continue
      notices.push({ id, workspace: row.workspace, sessionId: row.sessionId, taskId: row.taskId, kind: event.kind, at: snapshot.observedAt })
    }
  }
  return notices
}
const MUTE_KEY = 'lyshell.workbench-activity.muted.v1'
function readMuted(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(MUTE_KEY) ?? '[]')
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 256) : []
  } catch { return [] }
}
interface ActivityStore {
  snapshot: WorkbenchActivitySnapshot | null
  notices: ActivityNotice[]
  unreadNoticeIds: string[]
  muted: string[]
  open: boolean
  panelView: 'sessions' | 'notices'
  workspace: string | null
  selectedSessionId: string | null
  error: string | null
  actionError: string | null
  busy: boolean
  refresh: () => Promise<void>
  show: (workspace?: string | null, sessionId?: string | null) => void
  showNotifications: () => void
  setPanelView: (view: 'sessions' | 'notices') => void
  markRead: (id?: string) => void
  showProject: (target: SceneTarget) => Promise<void>
  close: () => void
  mute: (workspace: string) => void
  dismiss: () => void
  approve: (session: WorkbenchActivitySession, approval: WorkbenchActivityApproval, optionId: WorkbenchActivityApproval['options'][number]) => Promise<void>
}
let inFlight: Promise<void> | null = null
const seen = new Set<string>()
function accept(snapshot: WorkbenchActivitySnapshot): void {
  const state = useWorkbenchActivity.getState()
  if (state.snapshot?.tui && (!snapshot.tui || tuiNewer(state.snapshot.tui, snapshot.tui))) snapshot = { ...snapshot, tui: state.snapshot.tui }
  const oldWeb = state.snapshot?.web
  if (oldWeb && (!snapshot.web || snapshot.web.observedAt < oldWeb.observedAt ||
    JSON.stringify(oldWeb.identity) === JSON.stringify(snapshot.web.identity) && oldWeb.revision > snapshot.web.revision)) snapshot = { ...snapshot, web: oldWeb }
  const notices = collectActivityNotices(snapshot, state.snapshot, seen).filter(item => !state.muted.includes(activityDirectoryKey(item.workspace)))
  const currentTasks = new Set(snapshot.sessions.map(row => JSON.stringify([snapshot.identity, row.sessionId, row.taskId])))
  for (const id of seen) {
    const event = JSON.parse(id) as unknown[]
    if (event[0] === 'harness-web') {
      if (JSON.stringify(event[1]) !== JSON.stringify(snapshot.web?.identity) || !snapshot.web?.events.some(item => item.id === event[2])) seen.delete(id)
      continue
    }
    if (event[0] === 'tui') {
      if (!snapshot.tui?.events.some(item => JSON.stringify(['tui', item.launchId, item.id]) === id)) seen.delete(id)
      continue
    }
    if (!currentTasks.has(JSON.stringify(event.slice(0, 3)))) seen.delete(id)
  }
  // 只保留本次运行的有界提醒；项目切换不会改变其归属。
  const retained = [...notices, ...state.notices].slice(0, 100)
  const retainedIds = new Set(retained.map(notice => notice.id))
  const unreadNoticeIds = [...new Set([...notices.map(notice => notice.id), ...state.unreadNoticeIds])].filter(id => retainedIds.has(id))
  useWorkbenchActivity.setState({ snapshot, notices: retained, unreadNoticeIds, error: snapshot.error ?? null })
}
export function acceptTuiActivity(tui: TuiActivitySnapshot): void {
  const previous = useWorkbenchActivity.getState().snapshot
  if (previous?.tui && tuiNewer(previous.tui, tui)) return
  accept({ ...(previous ?? { observedAt: 0, connection: 'offline', identity: null, sessions: [] }), tui })
}
export const useWorkbenchActivity = create<ActivityStore>((set, get) => ({
  snapshot: null, notices: [], unreadNoticeIds: [], muted: readMuted(), open: false, panelView: 'sessions', workspace: null, selectedSessionId: null, error: null, actionError: null, busy: false,
  refresh: async () => {
    if (inFlight) return inFlight
    if (!window.electronAPI?.workbenchActivityRequest) return
    inFlight = (async () => {
      try { accept(await window.electronAPI.workbenchActivityRequest({ kind: 'snapshot' })) }
      catch (error) {
        const previous = get().snapshot
        set({ error: (error as Error).message, snapshot: previous ? { ...previous, connection: 'stale' } : null })
      }
    })().finally(() => { inFlight = null })
    return inFlight
  },
  show: (workspace = null, selectedSessionId = null) => set({ open: true, panelView: 'sessions', workspace, selectedSessionId, actionError: null,
    ...(selectedSessionId ? { unreadNoticeIds: get().unreadNoticeIds.filter(id => !get().notices.some(notice => notice.id === id && notice.sessionId === selectedSessionId && activityDirectoryKey(notice.workspace) === activityDirectoryKey(workspace ?? ''))) } : {}) }),
  showNotifications: () => set({ open: true, panelView: 'notices', workspace: null, selectedSessionId: null, actionError: null }),
  setPanelView: panelView => set({ panelView }),
  markRead: id => set({ unreadNoticeIds: id ? get().unreadNoticeIds.filter(item => item !== id) : [] }),
  showProject: async target => {
    try {
      const result = await window.electronAPI.projectSceneRequest({ kind: 'inspect', target })
      if (!result.success || !result.cwd) throw new Error(result.success ? 'Project directory unavailable' : result.error)
      set({ open: true, panelView: 'sessions', workspace: result.cwd, selectedSessionId: null, actionError: null })
    } catch (error) { set({ open: true, panelView: 'sessions', workspace: null, selectedSessionId: null, actionError: (error as Error).message }) }
  },
  close: () => set({ open: false }),
  mute: workspace => {
    const key = activityDirectoryKey(workspace)
    const muted = get().muted.includes(key) ? get().muted.filter(item => item !== key) : [...get().muted, key].slice(-256)
    try { localStorage.setItem(MUTE_KEY, JSON.stringify(muted)) } catch { /* 本次运行仍保留偏好。 */ }
    set({ muted })
  },
  dismiss: () => set({ notices: [], unreadNoticeIds: [] }),
  approve: async (session, approval, optionId) => {
    const snapshot = get().snapshot
    if (get().busy || !activityFresh(snapshot) || session.stale || !snapshot?.identity || !session.taskId) return
    set({ busy: true, actionError: null })
    try {
      const result = await window.electronAPI.workbenchActivityRequest({ kind: 'approve', identity: snapshot.identity, sessionId: session.sessionId, taskId: session.taskId, approvalId: approval.id, optionId })
      accept(result)
      set({ actionError: result.error ?? null })
    } catch (error) { set({ actionError: (error as Error).message }); await get().refresh() }
    finally { set({ busy: false }) }
  }
}))

/** 单例轮询由 MainWindow 挂载；读失败只使状态过期，不提交、不重发任务。 */
export function startActivityPolling(): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout>
  const unsubscribe = window.electronAPI?.onTuiActivityChanged?.(acceptTuiActivity)
  const poll = async () => {
    await useWorkbenchActivity.getState().refresh()
    if (!stopped) timer = setTimeout(() => { void poll() }, 4000)
  }
  void poll()
  return () => { stopped = true; clearTimeout(timer); unsubscribe?.() }
}
