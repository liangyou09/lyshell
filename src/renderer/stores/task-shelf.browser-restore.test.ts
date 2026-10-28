// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { useTaskShelf, requestShelfBrowserRestore, shelfBrowserRestoreDiagnostics } from './task-shelf'
import { usePaneStore } from './pane-store'
import { settleBrowserLoad } from './browser-load-tracker'
import type { TaskShelfEntry, TaskShelfRequest, TaskShelfResult } from '@shared/task-shelf'

describe('分类后的网页恢复接入', () => {
  it('只后台挂载四个自动驻留，真实加载串行，主区接管复用，迟到需求不创建实体', async () => {
    const entries: TaskShelfEntry[] = Array.from({ length: 6 }, (_, i) => ({ id: `restore-${i}`, resourceKey: `web:old-${i}`, title: `page ${i}`, createdAt: 1, updatedAt: 1, revision: 1, recovery: { kind: 'web', url: `https://fixture.test/${i}` }, capability: 'web' }))
    useTaskShelf.setState({ entries, bindings: {}, busy: {}, restoreErrors: {}, error: null })
    usePaneStore.setState({ layout: { activePaneId: 'pane', root: { id: 'pane', type: 'leaf', sessions: ['terminal'], activeSessionId: 'terminal', overlays: [] } }, overlayPayloads: {}, hiddenTabSessions: {} })
    let finishLate!: (result: TaskShelfResult) => void
    const api = vi.fn(async (request: TaskShelfRequest): Promise<TaskShelfResult> => {
      const entry = 'id' in request ? entries.find(item => item.id === request.id) : undefined
      if (request.kind === 'restore' && request.id === 'restore-5') return new Promise(resolve => { finishLate = resolve })
      return { success: true, entries, ...(entry ? { entry, restored: { kind: 'web', url: `https://fixture.test/${entry.id}` } as const } : {}) }
    })
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { taskShelfRequest: api } })
    const jobs = entries.slice(0, 5).map(entry => requestShelfBrowserRestore(entry.id, 'bulkVisible', () => true))
    for (let i = 0; i < 4; i++) {
      const id = `restore-${i}`
      await vi.waitFor(() => expect(useTaskShelf.getState().bindings[id]).toBeDefined())
      expect(api.mock.calls.filter(([request]) => request.kind === 'restore')).toHaveLength(i + 1)
      expect(usePaneStore.getState().getAllLeafPanes()[0].activeSessionId).toBe('terminal')
      expect(usePaneStore.getState().getAllLeafPanes()[0].overlays.every(ref => ref.shelved && !ref.active)).toBe(true)
      settleBrowserLoad(`shelf-web-${id}`)
      expect(await jobs[i]).toMatchObject({ id: `shelf-web-${id}` })
    }
    expect(await jobs[4]).toBeNull()
    expect(shelfBrowserRestoreDiagnostics()).toMatchObject({ automaticResidents: 4, running: 0 })
    const first = useTaskShelf.getState().bindings['restore-0'].id
    expect(await useTaskShelf.getState().open('restore-0')).toBe(true)
    expect(useTaskShelf.getState().bindings['restore-0'].id).toBe(first)
    expect(shelfBrowserRestoreDiagnostics().automaticResidents).toBe(3)
    expect(api.mock.calls.filter(([request]) => request.kind === 'restore')).toHaveLength(4)
    await useTaskShelf.getState().remove('restore-1')
    expect(shelfBrowserRestoreDiagnostics().automaticResidents).toBe(2)
    let valid = true
    const late = requestShelfBrowserRestore('restore-5', 'explicitShelf', () => valid)
    await vi.waitFor(() => expect(finishLate).toBeDefined())
    valid = false
    finishLate({ success: true, entries, restored: { kind: 'web', url: 'https://fixture.test/5' } })
    expect(await late).toBeNull()
    expect(useTaskShelf.getState().bindings['restore-5']).toBeUndefined()
    expect(api.mock.calls.every(([request]) => ['restore', 'remove'].includes(request.kind))).toBe(true)
  })
})
