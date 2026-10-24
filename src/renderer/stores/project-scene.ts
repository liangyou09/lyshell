import type { OverlayPayload, OverlayRef, PaneLayout, PaneNode } from '@shared/types'
import type { ProjectScene, SceneEntry, SceneNode, SceneTarget } from '@shared/project-scene'
import { sceneWebUrl } from '@shared/project-scene'
import { WORKTREE_DIR } from '@shared/worktree'
import { docKindFromPath } from '@shared/types/doc'
import { usePaneStore } from './pane-store'
import { useSessionStore, type SessionState } from './session-store'
import { workLauncherTargetKey } from '../components/Layout/work-launcher-tree'

const platform = () => window.electronAPI.platform
const pathKey = (cwd: string) => workLauncherTargetKey({ cwd, isolation: 'shared' }, platform())
export const sceneTargetKey = (target: SceneTarget) => workLauncherTargetKey(target, platform())
const normalizePath = (value: string) => platform() === 'win32' ? value.replace(/\\/g, '/').toLowerCase() : value
function within(path: string, cwd: string): boolean {
  const prefix = `${normalizePath(cwd).replace(/\/+$/, '')}/`
  const candidate = normalizePath(path)
  return candidate.startsWith(prefix) && !candidate.slice(prefix.length).split('/').some(segment => segment.toLowerCase() === WORKTREE_DIR)
}

/** 仅采集所选目标的终端引用；从不复制 config/startupCommands/env。 */
export function captureProjectScene(target: SceneTarget, cwd: string, layout: PaneLayout, payloads: Record<string, OverlayPayload>, sessions: readonly SessionState[], hiddenSessions: Readonly<Record<string, boolean>> = {}) {
  const issues: string[] = []
  const webIds: string[] = []
  // 被本次采集收进现场的覆盖层 / 终端 —— 保存后用于把新保存点绑定到界面上已有的实例。
  const overlayIds: string[] = []
  const overlayEntries: Record<string, SceneEntry> = {}
  const sessionIds: string[] = []
  let leafIndex = 0
  let activeLeaf = 0
  const key = sceneTargetKey(target)
  const capture = (node: PaneNode): SceneNode => {
    if (node.type === 'split') return { type: 'split', direction: node.direction, ratio: Math.max(.1, Math.min(.9, node.splitRatio)), first: capture(node.firstChild), second: capture(node.secondChild) }
    if (node.id === layout.activePaneId) activeLeaf = leafIndex
    leafIndex++
    const entries: SceneEntry[] = []
    let active = -1
    const add = (id: string | null, entry: SceneEntry, selected: boolean) => {
      if (selected) active = entries.length
      entries.push(entry)
      if (id) { overlayIds.push(id); overlayEntries[id] = entry }
    }
    const overlay = (id: string, selected: boolean) => {
      const payload = payloads[id]
      if (!payload || payload.ownerPluginId) return
      if (payload.projectSceneKey && payload.projectSceneKey !== key) return
      if (payload.kind === 'projectEntry' && sceneTargetKey(payload.target) === key) add(id, payload.entry, selected)
      else if (payload.kind === 'doc' && payload.source === 'local' && within(payload.path, cwd)) add(id, { kind: 'doc', path: payload.path }, selected)
      else if (payload.kind === 'web') {
        const url = !payload.postToken && sceneWebUrl(payload.nav?.url ?? payload.url)
        if (url) { add(id, { kind: 'web', url }, selected); webIds.push(id) }
        else issues.push('已跳过一个网页：仅保存无查询参数、无片段的普通网页入口；本机后台、认证和一次性地址不保存。')
      } else if (payload.kind === 'dshWeb') issues.push('DeepSeek 官方工作台为瞬态：后台控制权和认证入口不保存。')
      else if (payload.kind === 'doc' && payload.source !== 'local') issues.push('远端及内置文档不在本阶段恢复范围。')
    }
    const hasActiveOverlay = node.overlays.some(item => item.active)
    // 与 PaneTabBar 相同的 RAW session 插槽顺序。
    const pending = node.overlays.filter(item => item.slot != null).sort((a, b) => a.slot! - b.slot!)
    for (let index = 0; index < node.sessions.length; index++) {
      for (let i = 0; i < pending.length;) {
        const ref = pending[i]
        if (ref.slot! <= index) { overlay(ref.id, ref.active); pending.splice(i, 1) } else i++
      }
      const session = sessions.find(item => item.id === node.sessions[index])
      if (!session || hiddenSessions[session.id] || session.config.type !== 'local' || session.config.ownerPluginId || pathKey(session.config.local?.cwd ?? session.cwd ?? '') !== pathKey(cwd)) continue
      const tag = session.config.tags.find(item => /^(codex|claude|dsh|agent):/.test(item))
      if (tag) {
        const separator = tag.indexOf(':')
        add(null, { kind: 'agent', agentKind: tag.slice(0, separator) as 'codex' | 'claude' | 'dsh' | 'agent', agentId: tag.slice(separator + 1) }, !hasActiveOverlay && session.id === node.activeSessionId)
        sessionIds.push(session.id)
      } else {
        add(null, { kind: 'directory' }, !hasActiveOverlay && session.id === node.activeSessionId)
        sessionIds.push(session.id)
      }
    }
    for (const ref of [...pending, ...node.overlays.filter(item => item.slot == null)]) overlay(ref.id, ref.active)
    return { type: 'leaf', entries, active: active >= 0 ? active : entries.length ? 0 : -1 }
  }
  const root = capture(layout.root)
  // 空现场仍提供目录入口。
  const first = (node: SceneNode): Extract<SceneNode, { type: 'leaf' }> => node.type === 'leaf' ? node : first(node.first)
  const count = (node: SceneNode): number => node.type === 'leaf' ? node.entries.length : count(node.first) + count(node.second)
  if (!count(root)) { const leaf = first(root); leaf.entries.push({ kind: 'directory' }); leaf.active = 0 }
  return { root, activeLeaf, issues, webIds, overlayIds, overlayEntries, sessionIds }
}

// ───────────────── 运行期现场归属（不持久化） ─────────────────
// sceneId -> 已关联终端；sessionId -> sceneId。仅供显式启动恢复入口后把「实际终端」注册
// 回现场，避免同一入口被重复启动。进程/命令/凭据一律不在此沉淀，应用重启即失效。
const sceneSessions = new Map<string, Set<string>>()
const sessionScenes = new Map<string, string>()

/** 把实际终端与现场关联（sceneId 为空 = 解除该终端的现场归属）。运行期状态，不落盘。 */
export function registerSceneSession(sceneId: string | undefined, sessionId: string): void {
  if (!sessionId) return
  const previous = sessionScenes.get(sessionId)
  if (previous && previous !== sceneId) {
    const owned = sceneSessions.get(previous)
    owned?.delete(sessionId)
    if (owned && owned.size === 0) sceneSessions.delete(previous)
  }
  if (!sceneId) { sessionScenes.delete(sessionId); return }
  sessionScenes.set(sessionId, sceneId)
  let owned = sceneSessions.get(sceneId)
  if (!owned) { owned = new Set(); sceneSessions.set(sceneId, owned) }
  owned.add(sessionId)
}

// (项目键 + 现场 id) -> 已实现过的条目身份计数。用于区分「用户关掉的、确实实现过的条目」
// （继续时只定位，不重新打开）与「从未成功实现过的条目」（失效修复后补齐）。运行期状态。
const realizedLedger = new Map<string, Map<string, number>>()
const LEDGER_LIMIT = 64
const ledgerKey = (scene: ProjectScene) => `${sceneTargetKey(scene.target)}\u0000${scene.id}`

function ledgerFor(scene: ProjectScene): Map<string, number> {
  const key = ledgerKey(scene)
  let ledger = realizedLedger.get(key)
  if (ledger) realizedLedger.delete(key)
  else ledger = new Map<string, number>()
  realizedLedger.set(key, ledger)
  while (realizedLedger.size > LEDGER_LIMIT) {
    const oldest = realizedLedger.keys().next().value
    if (oldest === undefined) break
    realizedLedger.delete(oldest)
  }
  return ledger
}

function commitLedger(scene: ProjectScene, counts: ReadonlyMap<string, number>): void {
  const key = ledgerKey(scene)
  realizedLedger.delete(key)
  if (counts.size) realizedLedger.set(key, new Map(counts))
}

/** 仅供测试与退出清理：丢弃全部运行期归属、已实现记录与在途恢复。 */
export function resetProjectSceneRuntime(): void {
  sceneSessions.clear()
  sessionScenes.clear()
  realizedLedger.clear()
  inFlightRestores.clear()
}

const entryIdentity = (entry: SceneEntry): string => {
  if (entry.kind === 'doc') return `doc:${normalizePath(entry.path)}`
  if (entry.kind === 'web') return `web:${sceneWebUrl(entry.url) ?? entry.url}`
  if (entry.kind === 'agent') return `agent:${entry.agentKind}:${entry.agentId}`
  return 'directory'
}
const sessionTag = (session: SessionState) => session.config.tags.find(item => /^(codex|claude|dsh|agent):/.test(item))
const sessionIdentity = (session: SessionState): string => {
  const tag = sessionTag(session)
  return tag ? `agent:${tag}` : 'directory'
}
const describeEntry = (entry: SceneEntry, cwd: string): string => {
  if (entry.kind === 'doc') return entry.path
  if (entry.kind === 'web') return entry.url
  if (entry.kind === 'agent') return `${entry.agentKind}:${entry.agentId}`
  return cwd
}

export interface ProjectSceneRestoreResult {
  issues: string[]
  /** 本次新挂载的入口数量（兼容旧字段）。 */
  restored: number
  /** 是否定位到了界面上已存在的现场资源（重复继续 / 部分关闭时为 true）。 */
  focused: boolean
}

const inFlightRestores = new Map<string, Promise<ProjectSceneRestoreResult>>()

/** 先定位界面上已有的现场资源，再一次性合并剩余入口；已有终端/覆盖层及进程不关闭。 */
export function restoreProjectScene(scene: ProjectScene): Promise<ProjectSceneRestoreResult> {
  // 同一现场（同项目键 + 同保存点）的并发继续共用在途操作：不重复读文档、不重复分屏。
  const flightKey = ledgerKey(scene)
  const pending = inFlightRestores.get(flightKey)
  if (pending) return pending.then(result => ({ ...result, issues: [...result.issues] }))
  const run = performRestore(scene)
  inFlightRestores.set(flightKey, run)
  const settle = () => { if (inFlightRestores.get(flightKey) === run) inFlightRestores.delete(flightKey) }
  run.then(settle, settle)
  return run.then(result => ({ ...result, issues: [...result.issues] }))
}

interface LocatedItem { paneId: string; overlayId?: string; sessionId?: string }

async function performRestore(scene: ProjectScene): Promise<ProjectSceneRestoreResult> {
  const issues: string[] = []
  const key = sceneTargetKey(scene.target)
  const cwd = scene.directory || scene.target.cwd
  const state = usePaneStore.getState()
  const openIds = new Set(state.getAllOpenSessionIds())
  for (const sessionId of sessionScenes.keys()) { if (!openIds.has(sessionId)) registerSceneSession(undefined, sessionId) }
  const hidden = state.hiddenTabSessions

  // 1. 已挂载的覆盖层：同项目（或尚未归属）才可复用，绝不跨项目/worktree 借用。
  const located = new Map<string, LocatedItem[]>()
  const push = (identity: string, item: LocatedItem) => {
    const list = located.get(identity)
    if (list) list.push(item)
    else located.set(identity, [item])
  }
  const walk = (node: PaneNode): void => {
    if (node.type === 'split') { walk(node.firstChild); walk(node.secondChild); return }
    for (const ref of node.overlays) {
      const payload = state.overlayPayloads[ref.id]
      if (!payload || payload.ownerPluginId) continue
      if (payload.projectSceneKey && payload.projectSceneKey !== key) continue
      if (payload.projectSceneId === scene.id && payload.projectSceneEntry) {
        push(entryIdentity(payload.projectSceneEntry), { paneId: node.id, overlayId: ref.id })
        continue
      }
      if (payload.kind === 'doc') {
        if (payload.source === 'local' && within(payload.path, cwd)) push(`doc:${normalizePath(payload.path)}`, { paneId: node.id, overlayId: ref.id })
      } else if (payload.kind === 'web') {
        const url = sceneWebUrl(payload.nav?.url ?? payload.url)
        if (url) push(`web:${url}`, { paneId: node.id, overlayId: ref.id })
      } else if (payload.kind === 'projectEntry') {
        if (sceneTargetKey(payload.target) === key) push(entryIdentity(payload.entry), { paneId: node.id, overlayId: ref.id })
      }
    }
  }
  walk(state.layout.root)

  // 2. 已打开的终端：本现场显式注册过的排最前；跨项目/worktree 由实际工作目录隔离。
  const currentCwdKey = pathKey(cwd)
  const rank = (session: SessionState) => sessionScenes.get(session.id) === scene.id ? 0 : sessionScenes.has(session.id) ? 2 : 1
  const candidates = useSessionStore.getState().sessions
    .filter(session => openIds.has(session.id) && !hidden[session.id] && session.config.type === 'local' && !session.config.ownerPluginId
      && (sessionScenes.get(session.id) === scene.id || pathKey(session.config.local?.cwd ?? session.cwd ?? '') === currentCwdKey))
    .sort((a, b) => rank(a) - rank(b))
  for (const session of candidates) {
    const paneId = state.getPaneBySessionId(session.id)?.id
    if (paneId) push(sessionIdentity(session), { paneId, sessionId: session.id })
  }

  const wanted = new Set<string>()
  const collectWanted = (node: SceneNode): void => {
    if (node.type === 'split') { collectWanted(node.first); collectWanted(node.second) }
    else node.entries.forEach(entry => wanted.add(entryIdentity(entry)))
  }
  collectWanted(scene.root)
  const hasDesiredContent = [...wanted].some(identity => !!located.get(identity)?.length)
  let locatedTotal = 0

  const ledger = ledgerFor(scene)
  // 全关之后允许重新恢复：界面上已无本现场内容时，过期记录不得阻止重挂。
  if (!hasDesiredContent && ledger.size) ledger.clear()
  const credits = new Map(ledger)
  const nextLedger = new Map<string, number>()
  const remember = (identity: string) => nextLedger.set(identity, (nextLedger.get(identity) ?? 0) + 1)
  const take = (identity: string): LocatedItem | undefined => {
    const list = located.get(identity)
    return list && list.length ? list.shift() : undefined
  }

  const claimed: Record<string, OverlayPayload> = {}
  const created: Record<string, OverlayPayload> = {}
  const locatedItems: LocatedItem[] = []
  let preferredLocated: LocatedItem | undefined
  const createdLeafIds: (string | null)[] = []
  let leafCursor = 0
  let restored = 0

  const claim = (overlayId: string, entry: SceneEntry) => {
    const payload = state.overlayPayloads[overlayId]
    if (!payload) return
    const next = { ...payload, projectSceneKey: key, projectSceneId: scene.id, projectSceneEntry: entry }
    if (next.projectSceneKey !== payload.projectSceneKey || next.projectSceneId !== payload.projectSceneId || !payload.projectSceneEntry || entryIdentity(payload.projectSceneEntry) !== entryIdentity(entry)) claimed[overlayId] = next
  }

  const buildEntry = async (entry: SceneEntry): Promise<{ payload: OverlayPayload; kind: OverlayPayload['kind'] } | null> => {
    if (entry.kind === 'web') return { payload: { kind: 'web', url: entry.url, title: new URL(entry.url).hostname }, kind: 'web' }
    if (entry.kind === 'doc') {
      try {
        const result = await window.electronAPI.fileReadLocalDoc(entry.path)
        if (!result.success || !result.data) { issues.push(`${entry.path}：${result.error || '文档读取失败'}`); return null }
        return { payload: { kind: 'doc', source: 'local', path: entry.path, title: entry.path.split(/[\\/]/).pop()!, docKind: docKindFromPath(entry.path)!, content: result.data.content, size: result.data.size, mtime: result.data.mtime }, kind: 'doc' }
      } catch (error) { issues.push(`${entry.path}：${(error as Error).message}`); return null }
    }
    return { payload: { kind: 'projectEntry', target: scene.target, entry }, kind: 'projectEntry' }
  }

  const create = async (node: SceneNode): Promise<PaneNode | null> => {
    if (node.type === 'split') {
      // 只保留真正有新增内容的叶子；已有内容的分支不再复制一份布局。
      const first = await create(node.first)
      const second = await create(node.second)
      if (!first) return second
      if (!second) return first
      return { id: crypto.randomUUID(), type: 'split', direction: node.direction, splitRatio: node.ratio, firstChild: first, secondChild: second }
    }
    const leafIndex = leafCursor++
    const overlays: OverlayRef[] = []
    for (const [entryIndex, entry] of node.entries.entries()) {
      const identity = entryIdentity(entry)
      const hit = take(identity)
      if (hit) {
        // 已存在：定位原实例，保持它所在分屏的页签/进程/插槽不动。
        locatedItems.push(hit)
        locatedTotal++
        if (leafIndex === scene.activeLeaf && entryIndex === node.active) preferredLocated = hit
        if (hit.overlayId) claim(hit.overlayId, entry)
        const credit = credits.get(identity) ?? 0
        if (credit > 0) credits.set(identity, credit - 1)
        remember(identity)
        continue
      }
      const credit = credits.get(identity) ?? 0
      if (credit > 0) {
        // 此前确实挂载过、现在已被用户关闭：继续时只定位仍存在的内容，不重开。
        credits.set(identity, credit - 1)
        remember(identity)
        issues.push(`${describeEntry(entry, cwd)}：此前已挂载、现已关闭，继续时只定位仍打开的内容。`)
        continue
      }
      const built = await buildEntry(entry)
      if (!built) continue
      const overlayId = crypto.randomUUID()
      created[overlayId] = { ...built.payload, projectSceneKey: key, projectSceneId: scene.id, projectSceneEntry: entry }
      overlays.push({ id: overlayId, kind: built.kind, active: entryIndex === node.active, slot: null })
      restored++
      remember(identity)
    }
    if (!overlays.length) return null
    if (!overlays.some(ref => ref.active)) overlays[0].active = true
    const paneId = crypto.randomUUID()
    createdLeafIds[leafIndex] = paneId
    return { id: paneId, type: 'leaf', sessions: [], activeSessionId: null, overlays }
  }

  const root = await create(scene.root)
  const claims = Object.keys(claimed).length > 0
  const visible = (item: LocatedItem) => {
    const current = usePaneStore.getState()
    const pane = current.getPaneById(item.paneId)
    if (pane?.type !== 'leaf' || current.layout.activePaneId !== pane.id) return false
    return item.overlayId ? pane.overlays.some(ref => ref.id === item.overlayId && ref.active) : !pane.overlays.some(ref => ref.active) && pane.activeSessionId === item.sessionId
  }
  const valid = (item: LocatedItem) => item.overlayId ? !!usePaneStore.getState().getOverlayPaneId(item.overlayId) : !!usePaneStore.getState().getPaneBySessionId(item.sessionId!)
  const locatedFocus = locatedItems.find(item => valid(item) && visible(item)) ?? (preferredLocated && valid(preferredLocated) ? preferredLocated : locatedItems.find(valid))
  const claimCurrent = (current: ReturnType<typeof usePaneStore.getState>) => Object.fromEntries(Object.entries(claimed).flatMap(([id, payload]) => {
    const live = current.overlayPayloads[id]
    return live && current.getOverlayPaneId(id) ? [[id, { ...live, projectSceneKey: payload.projectSceneKey, projectSceneId: payload.projectSceneId, projectSceneEntry: payload.projectSceneEntry }]] : []
  }))

  if (!root) {
    commitLedger(scene, nextLedger)
    if (locatedFocus) {
      // 纯定位：显示已有现场资源，不重置布局、不重读资源、不启动进程。
      usePaneStore.setState(current => {
        const patch: Partial<ReturnType<typeof usePaneStore.getState>> = {}
        if (claims) patch.overlayPayloads = { ...current.overlayPayloads, ...claimCurrent(current) }
        return patch
      })
      if (!visible(locatedFocus)) {
        const current = usePaneStore.getState()
        if (locatedFocus.overlayId) current.activateOverlay(locatedFocus.overlayId)
        else if (locatedFocus.sessionId) {
          const paneId = current.getPaneBySessionId(locatedFocus.sessionId)?.id
          if (paneId) { current.deactivateOverlaysInPane(paneId); usePaneStore.getState().setActiveSessionInPane(paneId, locatedFocus.sessionId); usePaneStore.getState().setActivePane(paneId) }
        }
      }
      return { issues, restored: 0, focused: true }
    }
    return { issues, restored: 0, focused: false }
  }

  const activePaneId = createdLeafIds[scene.activeLeaf] ?? createdLeafIds.find((id): id is string => !!id) ?? ''
  const hasContent = (node: PaneNode): boolean => node.type === 'leaf' ? !!(node.sessions.length || node.overlays.length) : hasContent(node.firstChild) || hasContent(node.secondChild)
  usePaneStore.setState(current => ({
    layout: {
      root: hasContent(current.layout.root) ? { id: crypto.randomUUID(), type: 'split' as const, direction: 'horizontal' as const, splitRatio: .5, firstChild: current.layout.root, secondChild: root } : root,
      activePaneId
    },
    overlayPayloads: { ...current.overlayPayloads, ...claimCurrent(current), ...created }
  }))
  commitLedger(scene, nextLedger)
  return { issues, restored, focused: locatedTotal > 0 }
}

export async function saveCurrentProjectScene(target: SceneTarget) {
  const inspected = await window.electronAPI.projectSceneRequest({ kind: 'inspect', target })
  if (!inspected.success || !inspected.cwd) throw new Error(inspected.success ? '工作目录不可用' : inspected.error)
  const state = usePaneStore.getState()
  const capture = captureProjectScene(target, inspected.cwd, state.layout, state.overlayPayloads, useSessionStore.getState().sessions, state.hiddenTabSessions)
  const saved = await window.electronAPI.projectSceneRequest({ kind: 'save', target, root: capture.root, activeLeaf: capture.activeLeaf })
  if (!saved.success) throw new Error(saved.error)
  if (saved.scene) {
    // 新保存点绑定界面上已有的终端与覆盖层：随后「继续」优先定位它们，不再复制一份。
    for (const sessionId of capture.sessionIds) registerSceneSession(saved.scene.id, sessionId)
    usePaneStore.setState(current => ({
      overlayPayloads: Object.fromEntries(Object.entries(current.overlayPayloads).map(([id, payload]) => {
        if (!capture.overlayIds.includes(id)) return [id, payload]
        return [id, { ...payload, projectSceneKey: sceneTargetKey(target), projectSceneId: saved.scene!.id, projectSceneEntry: capture.overlayEntries[id] }]
      }))
    }))
    const realized = new Map<string, number>()
    const countRealized = (node: SceneNode): void => {
      if (node.type === 'split') { countRealized(node.first); countRealized(node.second) }
      else node.entries.forEach(entry => { const identity = entryIdentity(entry); realized.set(identity, (realized.get(identity) ?? 0) + 1) })
    }
    countRealized(saved.scene.root)
    commitLedger(saved.scene, realized)
  }
  return { ...saved, issues: capture.issues }
}
