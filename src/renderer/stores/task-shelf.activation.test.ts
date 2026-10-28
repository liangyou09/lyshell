// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTaskShelf } from './task-shelf'
import type { TaskShelfEntry, TaskShelfRequest, TaskShelfResult } from '@shared/task-shelf'

const saved = (id: string, revision = 1): TaskShelfEntry => ({ id, resourceKey: `web:${id}`, title: id, revision, createdAt: 1, updatedAt: 1, archivedAt: 1, recovery: { kind: 'web', url: 'https://example.org/' }, capability: 'web' })
const startup = { bootId: 'boot', scopeId: 'scope', status: 'ready' as const, archiveOnBoot: true }
let entries: TaskShelfEntry[]
const api = vi.fn<[TaskShelfRequest], Promise<TaskShelfResult>>()
const succeed = (request: Extract<TaskShelfRequest, { kind: 'activate' }>): TaskShelfResult => {
  const items = request.items.map(item => ({ taskId: item.taskId, status: 'moved' as const }))
  entries = entries.map(entry => { if (!items.some(item => item.taskId === entry.id)) return entry; const next = { ...entry, revision: entry.revision + 1 }; delete next.archivedAt; return next })
  return { success: true, entries, startup, activation: { requestId: request.requestId, items, total: items.length, moved: items.length, alreadyTasks: 0, conflict: 0, missing: 0, failed: 0 } }
}
beforeEach(() => {
  entries = [saved('a'), saved('b')]
  useTaskShelf.setState({ entries, startup, activating: false, activation: null, uiIntentRevision: 0, panelVisible: true, viewRequest: null, error: null, loaded: true })
  api.mockReset(); api.mockImplementation(async request => request.kind === 'activate' ? succeed(request) : { success: true, entries, startup })
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { taskShelfRequest: api } })
})

describe('分类命令与界面意图分离', () => {
  it('全部激活固定点击时快照，后续归档不加入本批，绝不调用恢复', async () => {
    let release!: (value: TaskShelfResult) => void
    let submitted!: Extract<TaskShelfRequest, { kind: 'activate' }>
    api.mockImplementation(request => {
      if (request.kind !== 'activate') return Promise.resolve({ success: true, entries, startup })
      submitted = request
      return new Promise(resolve => { release = resolve })
    })
    const pending = useTaskShelf.getState().activate()
    await vi.waitFor(() => expect(submitted).toBeDefined())
    entries = [...entries, saved('new')]; useTaskShelf.setState({ entries })
    release(succeed(submitted)); await pending
    expect(submitted.items.map(item => item.taskId)).toEqual(['a', 'b'])
    expect(useTaskShelf.getState().entries.find(entry => entry.id === 'new')?.archivedAt).toBe(1)
    expect(api.mock.calls.map(([request]) => request.kind)).toEqual(['activate'])
    expect(useTaskShelf.getState().viewRequest).toMatchObject({ view: 'tasks', entryId: 'a', open: true })
  })
  it('分类持久化完成前用户切栏，仍同步分类但不回抢界面', async () => {
    let release!: (value: TaskShelfResult) => void
    let submitted!: Extract<TaskShelfRequest, { kind: 'activate' }>
    api.mockImplementation(request => { submitted = request as typeof submitted; return new Promise(resolve => { release = resolve }) })
    const pending = useTaskShelf.getState().activate(['a'])
    await vi.waitFor(() => expect(submitted).toBeDefined())
    useTaskShelf.getState().invalidateIntent()
    release(succeed(submitted)); await pending
    expect(useTaskShelf.getState().entries[0].archivedAt).toBeUndefined()
    expect(useTaskShelf.getState().viewRequest).toBeNull()
  })
  it('重复点击期间只提交一次，不重复执行分类或恢复', async () => {
    let release!: (value: TaskShelfResult) => void
    let submitted!: Extract<TaskShelfRequest, { kind: 'activate' }>
    api.mockImplementation(request => { submitted = request as typeof submitted; return new Promise(resolve => { release = resolve }) })
    const first = useTaskShelf.getState().activate(['a'])
    expect(await useTaskShelf.getState().activate(['a'])).toBeNull()
    await vi.waitFor(() => expect(submitted).toBeDefined())
    release(succeed(submitted)); await first
    expect(api).toHaveBeenCalledTimes(1)
    expect(useTaskShelf.getState().activating).toBe(false)
  })
  it('失败重试重新读取版本，只提交仍归档的失败项', async () => {
    entries = [saved('a', 7), saved('b', 8)]
    useTaskShelf.setState({ activation: { requestId: 'old', items: [{ taskId: 'a', status: 'failed' }, { taskId: 'b', status: 'conflict' }], total: 2, moved: 0, alreadyTasks: 0, missing: 0, conflict: 1, failed: 1 } })
    await useTaskShelf.getState().retryActivation()
    expect(api.mock.calls.map(([r]) => r.kind)).toEqual(['list', 'activate'])
    expect(api.mock.calls[1][0]).toMatchObject({ items: [{ taskId: 'a', expectedRevision: 7 }] })
    expect(useTaskShelf.getState().entries.find(entry => entry.id === 'b')?.archivedAt).toBe(1)
  })
  it('初始化保存失败不发送分类命令，保留原始记录供只读访问', async () => {
    useTaskShelf.setState({ startup: { ...startup, status: 'blocked', error: 'disk full' } })
    expect(await useTaskShelf.getState().activate()).toBeNull()
    expect(api).not.toHaveBeenCalled()
    expect(useTaskShelf.getState().entries).toEqual(entries)
    expect(useTaskShelf.getState().error).toBe('disk full')
  })
  it('首次读取损坏也保留 bootId，修复文件后重试走权威初始化入口', async () => {
    useTaskShelf.setState({ startup: null, loaded: false })
    api.mockResolvedValueOnce({ success: false, error: 'damaged', code: 'INITIALIZATION_BLOCKED', startup: { ...startup, status: 'blocked', error: 'damaged' } })
    await useTaskShelf.getState().load()
    expect(useTaskShelf.getState().startup?.status).toBe('blocked')
    await useTaskShelf.getState().retry()
    expect(api.mock.calls.map(([request]) => request.kind)).toEqual(['list', 'retryInitialization', 'list'])
    expect(useTaskShelf.getState().startup?.status).toBe('ready')
  })
})
