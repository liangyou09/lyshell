// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskWorkbenchRequest, TaskWorkbenchSnapshot } from '@shared/task-workbench'
import { startTaskWorkbenchSubscription, useTaskWorkbench } from './task-workbench'

const snapshot = (revision: number): TaskWorkbenchSnapshot => ({ revision, queueEnabled: false, maxActive: 2, entries: [], submissions: [], results: [] })
const start: TaskWorkbenchRequest = { kind: 'start', entryId: 'entry', expectedRevision: 1, operationId: 'original-operation' }
const request = vi.fn()
let changed: (value: TaskWorkbenchSnapshot) => void
const unsubscribe = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  useTaskWorkbench.setState({ snapshot: null, error: null, busy: false, pending: null })
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    taskWorkbenchRequest: request,
    onTaskWorkbenchChanged: (listener: typeof changed) => { changed = listener; return unsubscribe }
  } })
})
describe('business task operation delivery', () => {
  it('keeps the same operation after lost IPC receipt and blocks a different execution intent', async () => {
    request.mockRejectedValueOnce(new Error('IPC receipt lost'))
    await useTaskWorkbench.getState().execute(start)
    expect(useTaskWorkbench.getState().pending).toEqual(start)
    await useTaskWorkbench.getState().execute({ ...start, operationId: 'different' })
    expect(request).toHaveBeenCalledTimes(1)
    request.mockResolvedValueOnce({ ok: true, entityId: 'submission', snapshot: snapshot(1) })
    await useTaskWorkbench.getState().retry()
    expect(request.mock.calls[1][0]).toEqual(start)
    expect(useTaskWorkbench.getState().pending).toBeNull()
  })
  it('retains an explicitly unknown storage result but permits correcting a confirmed refusal', async () => {
    request.mockResolvedValueOnce({ ok: false, operationUnconfirmed: true, error: 'Storage outcome unknown' })
    await useTaskWorkbench.getState().execute(start)
    expect(useTaskWorkbench.getState().pending).toEqual(start)
    request.mockResolvedValueOnce({ ok: false, error: 'Task revision changed', snapshot: snapshot(2) })
    await useTaskWorkbench.getState().retry()
    expect(useTaskWorkbench.getState().pending).toBeNull()
    expect(useTaskWorkbench.getState().snapshot?.revision).toBe(2)
  })
  it('does not roll back a newer host notification when a slow read finishes', async () => {
    let resolve!: (reply: unknown) => void
    request.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const stop = startTaskWorkbenchSubscription()
    changed(snapshot(5))
    resolve({ ok: true, snapshot: snapshot(4) })
    await Promise.resolve(); await Promise.resolve()
    expect(useTaskWorkbench.getState().snapshot?.revision).toBe(5)
    expect(request).toHaveBeenCalledWith({ kind: 'list' })
    stop()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
