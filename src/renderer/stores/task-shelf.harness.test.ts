// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initializeTaskShelf, useTaskShelf } from './task-shelf'
import { usePaneStore } from './pane-store'
import { useSessionStore } from './session-store'
import { useWorkbenchActivity } from './workbench-activity'
import type { TaskShelfEntry, TaskShelfRequest } from '@shared/task-shelf'

afterEach(() => { vi.useRealTimers() })
describe('Harness 收纳后的动态保存', () => {
  it('只有收纳后的工作台跟随官方活动源刷新，归档后仍写回原记录', async () => {
    vi.useFakeTimers()
    let records: TaskShelfEntry[] = []
    const entry: TaskShelfEntry = { id: 'saved-harness', resourceKey: 'harness:h', title: 'DeepSeek', revision: 1, createdAt: 1, updatedAt: 1,
      recovery: { kind: 'harness', sessionId: 'official-session' }, capability: 'harness-history' }
    const api = vi.fn(async (request: TaskShelfRequest) => {
      if (request.kind === 'capture') { records = [{ ...entry, ...(records[0]?.archivedAt ? { archivedAt: records[0].archivedAt } : {}) }]; return { success: true, entries: records, entry: records[0] } }
      if (request.kind === 'archive') records = [{ ...entry, archivedAt: 100 }]
      return { success: true, entries: records }
    })
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { taskShelfRequest: api } })
    useTaskShelf.setState({ entries: [], bindings: {}, loaded: false, busy: {}, saveErrors: {}, error: null })
    useSessionStore.setState({ sessions: [] })
    usePaneStore.setState({ layout: { root: { type: 'leaf', id: 'p', sessions: [], activeSessionId: null, overlays: [{ kind: 'dshWeb', id: 'h', active: true, slot: null }] }, activePaneId: 'p' },
      overlayPayloads: { h: { kind: 'dshWeb', url: 'http://127.0.0.1:12345', name: 'DeepSeek' } }, hiddenTabSessions: {} })
    useWorkbenchActivity.setState({ snapshot: null })
    const dispose = initializeTaskShelf()
    try {
      useWorkbenchActivity.setState({ snapshot: { observedAt: 1, connection: 'offline', identity: null, sessions: [] } })
      await vi.advanceTimersByTimeAsync(800)
      expect(api.mock.calls.filter(([r]) => r.kind === 'capture')).toHaveLength(0)
      await useTaskShelf.getState().collect({ kind: 'harness', id: 'h' })
      await useTaskShelf.getState().archive(entry.id, true)
      useWorkbenchActivity.setState({ snapshot: { observedAt: 2, connection: 'connected', identity: { instanceId: 'backend', instanceEpoch: 1 }, sessions: [] } })
      await vi.advanceTimersByTimeAsync(800)
      expect(api.mock.calls.map(([r]) => r).filter(r => r.kind === 'capture')).toEqual([
        { kind: 'capture', resource: { kind: 'harness', id: 'h' } },
        { kind: 'capture', entryId: entry.id, resource: { kind: 'harness', id: 'h' } }
      ])
      expect(useTaskShelf.getState().entries[0].archivedAt).toBe(100)
      expect(usePaneStore.getState().getAllLeafPanes()[0].overlays[0]).toMatchObject({ id: 'h', retained: true, shelved: true })
    } finally { dispose(); await vi.runOnlyPendingTimersAsync() }
  })
})
