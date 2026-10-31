import { create } from 'zustand'
import type { TaskWorkbenchReply, TaskWorkbenchRequest, TaskWorkbenchSnapshot } from '@shared/task-workbench'

interface TaskWorkbenchStore {
  snapshot: TaskWorkbenchSnapshot | null
  error: string | null
  busy: boolean
  pending: TaskWorkbenchRequest | null
  refresh: () => Promise<void>
  execute: (request: TaskWorkbenchRequest) => Promise<TaskWorkbenchReply>
  retry: () => Promise<TaskWorkbenchReply | undefined>
}

function accept(snapshot?: TaskWorkbenchSnapshot): void {
  if (!snapshot) return
  const current = useTaskWorkbench.getState().snapshot
  if (!current || snapshot.revision >= current.revision) useTaskWorkbench.setState({ snapshot })
}

/** 只订阅宿主业务摘要；观察沿用已有活动轮询，不新增定时器。 */
export const useTaskWorkbench = create<TaskWorkbenchStore>((set, get) => ({
  snapshot: null, error: null, busy: false, pending: null,
  refresh: async () => {
    if (!window.electronAPI?.taskWorkbenchRequest) return
    try {
      const reply = await window.electronAPI.taskWorkbenchRequest({ kind: 'list' })
      accept(reply.snapshot)
      if (!reply.ok) set({ error: reply.error ?? 'Task workbench unavailable' })
    } catch (error) { set({ error: (error as Error).message }) }
  },
  execute: async request => {
    if (get().busy) return { ok: false, error: 'An operation is in progress' }
    const mutation = 'operationId' in request
    if (mutation && get().pending && JSON.stringify(get().pending) !== JSON.stringify(request)) {
      return { ok: false, error: 'Check the previous operation before starting another one' }
    }
    set({ busy: true, error: null, ...(mutation ? { pending: request } : {}) })
    try {
      const reply = await window.electronAPI.taskWorkbenchRequest(request)
      accept(reply.snapshot)
      // 明确收到业务回执；传输失败才保留原操作身份供查询/重试，避免换键重复执行。
      set({ error: reply.ok ? null : reply.error ?? 'Task operation failed', ...(mutation && !reply.operationUnconfirmed ? { pending: null } : {}) })
      return reply
    } catch (error) {
      const message = (error as Error).message
      set({ error: message })
      return { ok: false, error: message }
    } finally { set({ busy: false }) }
  },
  retry: async () => { const request = get().pending; return request ? get().execute(request) : undefined }
}))

export function startTaskWorkbenchSubscription(): () => void {
  const unsubscribe = window.electronAPI?.onTaskWorkbenchChanged?.(snapshot => accept(snapshot))
  void useTaskWorkbench.getState().refresh()
  return () => unsubscribe?.()
}
