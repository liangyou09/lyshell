// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { initializeTaskShelf, useTaskShelf } from './task-shelf'
import { usePaneStore } from './pane-store'
import { useSessionStore } from './session-store'
import type { TaskShelfEntry, TaskShelfRequest } from '@shared/task-shelf'
import { ConnectionStatus, ConnectionType } from '@shared/types'

describe('仅收纳的 SSH 跟随输出保存', () => {
  it('合并连续输出，未收纳连接不触发保存，退出时刷新剩余更新', async () => {
    vi.useFakeTimers()
    const entry: TaskShelfEntry = { id: 'saved-ssh', resourceKey: 'terminal:ssh', title: 'SSH', revision: 1, createdAt: 1, updatedAt: 1,
      capability: 'reconnect', recovery: { kind: 'terminal', sessionId: 'ssh', type: ConnectionType.SSH } }
    let onOutput!: (id: string, data: string) => void
    const off = vi.fn()
    const api = vi.fn(async (_request: TaskShelfRequest) => ({ success: true, entries: [entry], entry }))
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { taskShelfRequest: api,
      onTerminalData: (listener: typeof onOutput) => { onOutput = listener; return off } } })
    useTaskShelf.setState({ entries: [entry], bindings: { [entry.id]: { kind: 'terminal', id: 'ssh' } }, busy: {}, saveErrors: {}, error: null })
    useSessionStore.setState({ sessions: [{ id: 'ssh', status: ConnectionStatus.CONNECTED, config: { id: 'ssh', name: 'SSH', type: ConnectionType.SSH, tags: [], terminal: {} as never, createdAt: new Date(), updatedAt: new Date() } }] })
    usePaneStore.setState({ layout: { root: { type: 'leaf', id: 'p', sessions: ['ssh'], activeSessionId: 'ssh', overlays: [] }, activePaneId: 'p' }, overlayPayloads: {}, hiddenTabSessions: {} })
    const dispose = initializeTaskShelf()
    try {
      onOutput('temporary', 'not collected')
      await vi.advanceTimersByTimeAsync(4000)
      expect(api.mock.calls.filter(([r]) => r.kind === 'capture')).toHaveLength(0)
      for (let i = 0; i < 50; i++) onOutput('ssh', `output ${i}`)
      await vi.advanceTimersByTimeAsync(2900)
      expect(api.mock.calls.filter(([r]) => r.kind === 'capture')).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(800)
      expect(api.mock.calls.map(([r]) => r).filter(r => r.kind === 'capture')).toEqual([
        { kind: 'capture', entryId: entry.id, resource: { kind: 'terminal', id: 'ssh' } }
      ])
      onOutput('ssh', 'last line')
      window.dispatchEvent(new Event('pagehide'))
      await vi.advanceTimersByTimeAsync(0)
      expect(api.mock.calls.filter(([r]) => r.kind === 'capture')).toHaveLength(2)
    } finally {
      dispose(); await vi.runOnlyPendingTimersAsync(); vi.useRealTimers()
    }
    expect(off).toHaveBeenCalledTimes(1)
  })
})
