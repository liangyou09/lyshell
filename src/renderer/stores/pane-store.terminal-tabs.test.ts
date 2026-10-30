// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectionStatus, ConnectionType, type SessionConfig } from '@shared/types'
import type { TaskShelfEntry } from '@shared/task-shelf'
import { subscribeToTerminalOpenSessionsSync, usePaneStore } from './pane-store'
import { useSessionStore } from './session-store'
import { useTaskShelf } from './task-shelf'

type PaneState = ReturnType<typeof usePaneStore.getState>
const entry: TaskShelfEntry = {
  id: 'saved', resourceKey: 'terminal:saved-runtime', title: 'Saved shell', createdAt: 1, updatedAt: 1, revision: 1,
  recovery: { kind: 'terminal', sessionId: 'saved-runtime', type: ConnectionType.LOCAL }, capability: 'directory'
}
const syncTabs = vi.fn<[string[]], Promise<void>>()
const disposers: Array<() => void> = []
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
const config = (id: string): SessionConfig => ({
  id, name: id, type: ConnectionType.LOCAL, local: { cwd: 'D:/workspace/claude/LyShell' },
  terminal: {} as SessionConfig['terminal'], tags: [], createdAt: new Date(), updatedAt: new Date()
})

/** 独立假 store：不触发 pane-store 模块级的全局订阅。 */
function fixture(ids = ['visible']) {
  let current: PaneState = {
    ...usePaneStore.getState(),
    layout: { root: { type: 'leaf', id: 'pane', sessions: ids, activeSessionId: ids[0] ?? null, overlays: [] }, activePaneId: 'pane' }
  }
  const listeners = new Set<(state: PaneState, previous: PaneState) => void>()
  const store = {
    getState: () => current,
    subscribe: (listener: (state: PaneState, previous: PaneState) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
  }
  const update = (patch: Partial<PaneState>) => {
    const previous = current
    current = { ...current, ...patch }
    for (const listener of listeners) listener(current, previous)
  }
  return {
    store,
    setTabs: (sessions: string[]) => update({ layout: { root: { type: 'leaf', id: 'pane', sessions, activeSessionId: sessions[0] ?? null, overlays: [] }, activePaneId: 'pane' } }),
    update,
    subscribe: () => { const dispose = subscribeToTerminalOpenSessionsSync(store); disposers.push(dispose); return dispose }
  }
}

beforeEach(() => {
  syncTabs.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { syncTerminalOpenSessions: syncTabs } })
  useTaskShelf.setState({ entries: [entry], bindings: {}, loaded: true, busy: {}, saveErrors: {}, error: null })
  useSessionStore.setState({ sessions: ['visible', 'detached-config'].map(id => ({ id, config: config(id), status: ConnectionStatus.CONNECTED })) })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  disposers.splice(0).forEach(dispose => dispose())
  await flush()
  vi.restoreAllMocks()
})

describe('退出回收所需的实际终端页签同步', () => {
  it('首次只上报实际页签并去重，不把未打开的会话配置当成页签', async () => {
    const target = fixture(['visible', 'visible', 'saved-runtime'])
    target.subscribe()
    await flush()
    expect(syncTabs.mock.calls).toEqual([[['visible', 'saved-runtime']]])
    expect(syncTabs.mock.calls[0][0]).not.toContain('detached-config')
  })

  it('添加、移除及最后一个页签关闭时同步最新列表', async () => {
    const target = fixture()
    target.subscribe()
    await flush()
    target.setTabs(['visible', 'new-tab'])
    await flush()
    target.setTabs(['new-tab'])
    await flush()
    target.setTabs([])
    await flush()
    expect(syncTabs.mock.calls).toEqual([[['visible']], [['visible', 'new-tab']], [['new-tab']], [[]]])
  })

  it('列表不变或仅页签显隐、其他会话状态变化时不重复同步', async () => {
    const target = fixture()
    target.subscribe()
    await flush()
    target.setTabs(['visible', 'visible'])
    target.update({ hiddenTabSessions: { visible: true } })
    useSessionStore.setState(state => ({ sessions: state.sessions.map(row => ({ ...row, status: ConnectionStatus.DISCONNECTED })) }))
    await flush()
    expect(syncTabs.mock.calls).toEqual([[['visible']]])
  })

  it('清理订阅后后续页签变化不再发送', async () => {
    const target = fixture()
    const dispose = target.subscribe()
    await flush()
    dispose()
    disposers.pop()
    target.setTabs(['later'])
    await flush()
    expect(syncTabs.mock.calls).toEqual([[['visible']]])
  })

  it('同步失败不会覆盖任务记录或现有保存错误', async () => {
    const target = fixture()
    target.subscribe()
    await flush()
    useTaskShelf.setState({ error: 'existing save error' })
    const before = useTaskShelf.getState().entries
    syncTabs.mockRejectedValueOnce(new Error('main process unavailable'))
    target.setTabs(['visible', 'later'])
    await flush()
    expect(useTaskShelf.getState().entries).toBe(before)
    expect(useTaskShelf.getState().error).toBe('existing save error')
    expect(console.warn).toHaveBeenCalledTimes(1)
  })
})
