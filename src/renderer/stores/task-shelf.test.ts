// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTaskShelf, initializeTaskShelf, shelfResource } from './task-shelf'
import { usePaneStore } from './pane-store'
import { useSessionStore } from './session-store'
import { ConnectionStatus, ConnectionType, type SessionConfig } from '@shared/types'
import { DEFAULT_TASK_SHELF_PREFERENCES, type TaskShelfEntry, type TaskShelfRequest, type TaskShelfResult } from '@shared/task-shelf'

const entry: TaskShelfEntry = { id: 'saved-web', resourceKey: 'web:web-1', title: 'Original', createdAt: 1, updatedAt: 1, revision: 1, capability: 'web', recovery: { kind: 'web', url: 'https://example.org/' } }
let records: TaskShelfEntry[]
const api = vi.fn<[TaskShelfRequest], Promise<TaskShelfResult>>()
// 后端按资源类型生成记录；渲染层只用 id/archivedAt，保持与 repository.capture 一致的归档保留语义。
const recordIdFor = (resource: { kind: string }) => resource.kind === 'web' ? entry.id : `saved-${resource.kind}`
const terminalConfig = (cwd: string): SessionConfig => ({
  id: 'term-1',
  name: 'Local shell',
  type: ConnectionType.LOCAL,
  local: { cwd },
  terminal: {} as SessionConfig['terminal'],
  tags: [],
  createdAt: new Date(),
  updatedAt: new Date()
})
beforeEach(() => {
  vi.useFakeTimers(); records = []
  useTaskShelf.setState({ entries: [], bindings: {}, loaded: false, busy: {}, error: null, saveErrors: {}, startup: null, activation: null, activating: false, uiIntentRevision: 0, preferences: { ...DEFAULT_TASK_SHELF_PREFERENCES } })
  useSessionStore.setState({ sessions: [] })
  usePaneStore.setState({ layout: { root: { type: 'leaf', id: 'pane', sessions: [], activeSessionId: null, overlays: [{ kind: 'web', id: 'web-1', active: true, slot: null }] }, activePaneId: 'pane' }, overlayPayloads: { 'web-1': { kind: 'web', url: 'https://example.org/', title: 'Original' } }, hiddenTabSessions: {}, retainedSessionIds: {} })
  api.mockReset(); api.mockImplementation(async request => {
    if (request.kind === 'capture') {
      const id = recordIdFor(request.resource)
      const previous = records.find(item => item.id === id)
      const saved: TaskShelfEntry = {
        ...entry,
        id,
        resourceKey: `${request.resource.kind}:${request.resource.id}`,
        title: request.resource.kind === 'web' ? request.resource.title : 'Terminal',
        revision: (previous?.revision ?? 0) + 1,
        ...(previous?.archivedAt ? { archivedAt: previous.archivedAt } : {})
      }
      records = [saved]
      return { success: true, entries: records, entry: saved }
    }
    if (request.kind === 'remove') { records = records.filter(item => item.id !== request.id); return { success: true, entries: records } }
    if (request.kind === 'archive') {
      records = records.map(item => {
        if (item.id !== request.id) return item
        const next = { ...item }
        if (request.archived) next.archivedAt = 100
        else delete next.archivedAt
        return next
      })
      return { success: true, entries: records }
    }
    if (request.kind === 'preferences') return { success: true, entries: records, preferences: request.preferences }
    return { success: true, entries: records }
  })
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { taskShelfRequest: api, syncTerminalOpenSessions: vi.fn().mockResolvedValue(undefined) } })
})
afterEach(async () => { await vi.runOnlyPendingTimersAsync(); vi.useRealTimers() })

describe('任务保存区现场与持续保存', () => {
  it('保存成功后只收起引用，网页 payload 与原实例 ID 均保持', async () => {
    const payload = usePaneStore.getState().overlayPayloads['web-1']
    expect(await useTaskShelf.getState().collect({ kind: 'web', id: 'web-1', url: 'https://example.org/', title: 'Original' })).toBe(true)
    expect(usePaneStore.getState().overlayPayloads['web-1']).toBe(payload)
    expect(usePaneStore.getState().getAllLeafPanes()[0].overlays[0]).toMatchObject({ id: 'web-1', active: false, shelved: true })
    expect(await useTaskShelf.getState().open(entry.id)).toBe(true)
    expect(usePaneStore.getState().getAllLeafPanes()[0].overlays[0]).toMatchObject({ id: 'web-1', active: true, shelved: false })
    expect(api.mock.calls.filter(([r]) => r.kind === 'restore')).toHaveLength(0)
    expect(Object.keys(usePaneStore.getState().overlayPayloads)).toEqual(['web-1'])
  })
  it('首次保存失败保留原页签和活动现场', async () => {
    api.mockResolvedValueOnce({ success: false, error: 'disk full' })
    const root = usePaneStore.getState().layout.root
    expect(await useTaskShelf.getState().collect({ kind: 'web', id: 'web-1', url: 'https://example.org/', title: 'Original' })).toBe(false)
    expect(usePaneStore.getState().layout.root).toBe(root)
    expect(useTaskShelf.getState().bindings).toEqual({})
    expect(useTaskShelf.getState().error).toBe('disk full')
  })
  it('展开继续使用也保存导航更新，未收纳网页不会进入自动保存请求', async () => {
    const dispose = initializeTaskShelf()
    await useTaskShelf.getState().collect({ kind: 'web', id: 'web-1', url: 'https://example.org/', title: 'Original' })
    await useTaskShelf.getState().open(entry.id)
    usePaneStore.getState().setWebTabNav('web-1', { url: 'https://example.org/next' })
    usePaneStore.getState().setWebTabTitle('web-1', 'Updated')
    usePaneStore.getState().openWebTab('https://temporary.example/')
    await vi.advanceTimersByTimeAsync(800)
    const captures = api.mock.calls.map(([r]) => r).filter(r => r.kind === 'capture')
    expect(captures).toHaveLength(2)
    expect(captures[1]).toMatchObject({ kind: 'capture', entryId: entry.id, resource: { id: 'web-1', url: 'https://example.org/next', title: 'Updated' } })
    dispose()
  })
  it('重复收纳共享请求；取消保存先展开原网页且不会销毁', async () => {
    const resource = { kind: 'web' as const, id: 'web-1', url: 'https://example.org/', title: 'Original' }
    await Promise.all([useTaskShelf.getState().collect(resource), useTaskShelf.getState().collect(resource)])
    expect(api.mock.calls.filter(([r]) => r.kind === 'capture')).toHaveLength(1)
    await useTaskShelf.getState().remove(entry.id)
    expect(useTaskShelf.getState().entries).toEqual([])
    expect(usePaneStore.getState().overlayPayloads['web-1']).toBeDefined()
    expect(usePaneStore.getState().getAllLeafPanes()[0].overlays[0].active).toBe(true)
  })
  it('已收起网页不会被关闭其他终端时自动激活', () => {
    const pane = usePaneStore.getState()
    pane.shelveOverlay('web-1')
    pane.addSessionToPane('pane', 'terminal')
    pane.removeSessionFromPane('pane', 'terminal')
    expect(usePaneStore.getState().getAllLeafPanes()[0].overlays[0]).toMatchObject({ active: false, shelved: true })
  })
  it('批量关闭混合页签时保留已收纳实例，并维持收起状态', async () => {
    await useTaskShelf.getState().collect({ kind: 'web', id: 'web-1', url: 'https://example.org/', title: 'Original' })
    await useTaskShelf.getState().open(entry.id)
    const other = usePaneStore.getState().openWebTab('https://temporary.example/')
    expect(other.ok).toBe(true)
    usePaneStore.getState().activateOverlay('web-1')
    usePaneStore.getState().closeOverlaysInPane('pane')
    expect(usePaneStore.getState().getAllLeafPanes()[0].overlays).toEqual([
      expect.objectContaining({ id: 'web-1', active: false, shelved: true, retained: true })
    ])
    expect(Object.keys(usePaneStore.getState().overlayPayloads)).toEqual(['web-1'])
  })
  it('关闭承载分屏后，收纳网页迁入存活分屏而非销毁', async () => {
    await useTaskShelf.getState().collect({ kind: 'web', id: 'web-1', url: 'https://example.org/', title: 'Original' })
    const leaf = usePaneStore.getState().getAllLeafPanes()[0]
    usePaneStore.setState({ layout: { root: { type: 'split', id: 'split', direction: 'horizontal', splitRatio: .5, firstChild: leaf, secondChild: { type: 'leaf', id: 'other', sessions: [], activeSessionId: null, overlays: [] } }, activePaneId: 'pane' } })
    usePaneStore.getState().closePane('pane')
    expect(usePaneStore.getState().overlayPayloads['web-1']).toBeDefined()
    expect(usePaneStore.getState().getOverlayPaneId('web-1')).not.toBe('pane')
    expect(usePaneStore.getState().getAllLeafPanes()).toHaveLength(1)
    expect(usePaneStore.getState().getAllLeafPanes()[0].overlays[0]).toMatchObject({ shelved: true, retained: true, active: false })
  })
  it('展开任务移动到另一分屏后继续持有原网页，关闭入口只收起', async () => {
    await useTaskShelf.getState().collect({ kind: 'web', id: 'web-1', url: 'https://example.org/', title: 'Original' })
    const leaf = usePaneStore.getState().getAllLeafPanes()[0]
    usePaneStore.setState({ layout: { root: { type: 'split', id: 'split', direction: 'horizontal', splitRatio: .5, firstChild: leaf, secondChild: { type: 'leaf', id: 'other', sessions: [], activeSessionId: null, overlays: [] } }, activePaneId: 'pane' } })
    await useTaskShelf.getState().open(entry.id, 'other')
    expect(usePaneStore.getState().getAllLeafPanes().flatMap(p => p.overlays).find(r => r.id === 'web-1')).toMatchObject({ retained: true, active: true })
    usePaneStore.getState().closeOverlay('web-1')
    expect(usePaneStore.getState().overlayPayloads['web-1']).toBeDefined()
    expect(usePaneStore.getState().getAllLeafPanes().flatMap(p => p.overlays).find(r => r.id === 'web-1')).toMatchObject({ retained: true, shelved: true })
  })
  it('POST 令牌消耗后仍保留来源，不生成可重放的 GET 恢复地址', () => {
    usePaneStore.getState().openWebTab('https://example.org/result', undefined, { postToken: 'one-use' })
    const id = Object.keys(usePaneStore.getState().overlayPayloads).find(key => key !== 'web-1')!
    usePaneStore.getState().settleWebTabPost(id, 'https://example.org/result')
    expect(shelfResource('web', id)).toMatchObject({ post: true })
  })
})

describe('归档、快捷键与后台保存', () => {
  it('归档后保留运行实例，后台导航更新仍写回同一条已归档记录', async () => {
    const dispose = initializeTaskShelf()
    const resource = { kind: 'web' as const, id: 'web-1', url: 'https://example.org/', title: 'Original' }
    expect(await useTaskShelf.getState().collect(resource)).toBe(true)
    expect(await useTaskShelf.getState().open(entry.id)).toBe(true)
    const payload = usePaneStore.getState().overlayPayloads['web-1']
    expect(await useTaskShelf.getState().archive(entry.id, true)).toBe(true)
    expect(useTaskShelf.getState().entries[0]).toMatchObject({ id: entry.id, archivedAt: 100 })
    expect(useTaskShelf.getState().bindings[entry.id]).toEqual({ kind: 'web', id: 'web-1' })
    // 归档只收起引用：运行中的 webview 与后台更新链路都仍在。
    expect(usePaneStore.getState().overlayPayloads['web-1']).toBe(payload)
    expect(usePaneStore.getState().getAllLeafPanes()[0].overlays[0]).toMatchObject({ id: 'web-1', active: false, shelved: true, retained: true })
    usePaneStore.getState().setWebTabNav('web-1', { url: 'https://example.org/next' })
    await vi.advanceTimersByTimeAsync(800)
    const captures = api.mock.calls.map(([r]) => r).filter(r => r.kind === 'capture')
    expect(captures.at(-1)).toMatchObject({ kind: 'capture', entryId: entry.id, resource: { kind: 'web', id: 'web-1', url: 'https://example.org/next' } })
    expect(api.mock.calls.filter(([r]) => r.kind === 'capture')).toHaveLength(2)
    // 后台保存不会把归档标记丢掉，也不会重建实例。
    expect(useTaskShelf.getState().entries[0]).toMatchObject({ id: entry.id, archivedAt: 100 })
    expect(usePaneStore.getState().overlayPayloads['web-1']).toMatchObject({ kind: 'web', url: 'https://example.org/', title: 'Original', nav: { url: 'https://example.org/next' } })
    expect(api.mock.calls.filter(([r]) => r.kind === 'restore')).toHaveLength(0)
    dispose()
  })
  it('归档失败保留原视图：不收起页签、不改记录、不触发后台保存', async () => {
    await useTaskShelf.getState().collect({ kind: 'web', id: 'web-1', url: 'https://example.org/', title: 'Original' })
    await useTaskShelf.getState().open(entry.id)
    expect(usePaneStore.getState().getAllLeafPanes()[0].overlays[0]).toMatchObject({ id: 'web-1', active: true, shelved: false })
    api.mockResolvedValueOnce({ success: false, error: 'disk full' })
    expect(await useTaskShelf.getState().archive(entry.id, true)).toBe(false)
    expect(useTaskShelf.getState().error).toBe('disk full')
    expect(useTaskShelf.getState().entries[0].archivedAt).toBeUndefined()
    expect(useTaskShelf.getState().bindings[entry.id]).toEqual({ kind: 'web', id: 'web-1' })
    expect(usePaneStore.getState().getAllLeafPanes()[0].overlays[0]).toMatchObject({ id: 'web-1', active: true, shelved: false, retained: true })
    await vi.advanceTimersByTimeAsync(800)
    expect(api.mock.calls.filter(([r]) => r.kind === 'capture')).toHaveLength(1)
  })
  it('终端归档后实例仍在现场，后台状态变化继续保存同一记录', async () => {
    useSessionStore.setState({ sessions: [{ id: 'term-1', config: terminalConfig('C:/work'), status: ConnectionStatus.CONNECTED, cwd: 'C:/work' }] })
    usePaneStore.setState({ layout: { root: { type: 'leaf', id: 'pane', sessions: ['term-1'], activeSessionId: 'term-1', overlays: [] }, activePaneId: 'pane' }, overlayPayloads: {}, hiddenTabSessions: {}, retainedSessionIds: {} })
    const dispose = initializeTaskShelf()
    expect(await useTaskShelf.getState().collect({ kind: 'terminal', id: 'term-1' })).toBe(true)
    const saved = useTaskShelf.getState().entries[0]
    expect(saved).toMatchObject({ resourceKey: 'terminal:term-1' })
    expect(usePaneStore.getState().hiddenTabSessions['term-1']).toBe(true)
    expect(await useTaskShelf.getState().archive(saved.id, true)).toBe(true)
    expect(useTaskShelf.getState().entries[0].archivedAt).toBe(100)
    // 归档不关闭进程：会话与分屏实例都还在，只隐藏页签。
    expect(useSessionStore.getState().sessions).toHaveLength(1)
    expect(useSessionStore.getState().sessions[0].status).toBe(ConnectionStatus.CONNECTED)
    expect(usePaneStore.getState().getAllLeafPanes()[0].sessions).toEqual(['term-1'])
    expect(usePaneStore.getState().hiddenTabSessions['term-1']).toBe(true)
    useSessionStore.setState(state => ({ sessions: state.sessions.map(session => session.id === 'term-1' ? { ...session, cwd: 'C:/work/sub' } : session) }))
    await vi.advanceTimersByTimeAsync(800)
    const captures = api.mock.calls.map(([r]) => r).filter(r => r.kind === 'capture')
    expect(captures.at(-1)).toMatchObject({ kind: 'capture', entryId: saved.id, resource: { kind: 'terminal', id: 'term-1' } })
    expect(useTaskShelf.getState().entries[0].archivedAt).toBe(100)
    dispose()
  })
  it('自定义快捷键保存成功后采用后端回执', async () => {
    const preferences = { toggleShortcut: 'Ctrl+Shift+K', collectShortcut: 'Ctrl+Shift+L' }
    expect(await useTaskShelf.getState().setPreferences(preferences)).toBe(true)
    expect(api.mock.calls.at(-1)?.[0]).toEqual({ kind: 'preferences', preferences })
    expect(useTaskShelf.getState().preferences).toEqual(preferences)
    expect(useTaskShelf.getState().error).toBeNull()
  })
  it('快捷键保存失败保留旧配置并暴露错误', async () => {
    const previous = useTaskShelf.getState().preferences
    api.mockResolvedValueOnce({ success: false, error: '快捷键需使用 Ctrl/Meta+Shift+字母，不能重复或占用 P；留空可禁用。' })
    expect(await useTaskShelf.getState().setPreferences({ toggleShortcut: 'Ctrl+Shift+P', collectShortcut: '' })).toBe(false)
    expect(useTaskShelf.getState().preferences).toEqual(previous)
    expect(useTaskShelf.getState().error).toContain('快捷键')
  })
})
