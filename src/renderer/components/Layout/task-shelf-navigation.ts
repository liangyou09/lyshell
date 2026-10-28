import type { ActivityNotice } from '../../stores/workbench-activity'
import { useTaskShelf } from '../../stores/task-shelf'

/** 终端按实例、Harness 按后台/会话/回合匹配，不能只按目录召回别的任务。 */
export function shelfEntryForNotice(notice: ActivityNotice): string | undefined {
  const { entries, bindings } = useTaskShelf.getState()
  if (notice.source === 'codex' || notice.source === 'claude') {
    return entries.find(entry => bindings[entry.id]?.kind === 'terminal' && bindings[entry.id]?.id === notice.sessionId)?.id
  }
  let identity: unknown
  try {
    const key = JSON.parse(notice.id) as unknown[]
    identity = notice.source === 'harness-web' ? key[1] : key[0]
  } catch { return undefined }
  if (!identity || typeof identity !== 'object') return undefined
  const backend = identity as { instanceId?: unknown; instanceEpoch?: unknown }
  if (typeof backend.instanceId !== 'string' || !backend.instanceId || typeof backend.instanceEpoch !== 'number' || !Number.isFinite(backend.instanceEpoch)) return undefined
  return entries.find(entry => entry.recovery.kind === 'harness' && entry.recovery.sessionId === notice.sessionId &&
    (!entry.recovery.taskId || entry.recovery.taskId === notice.taskId) &&
    entry.recovery.identity?.instanceId === backend.instanceId && entry.recovery.identity?.instanceEpoch === backend.instanceEpoch)?.id
}

/** 只由用户点击提醒调用；不在后台事件到来时移动任务或抢焦点。 */
export function showShelfNotice(notice: ActivityNotice): boolean {
  const id = shelfEntryForNotice(notice)
  if (!id) return false
  // 铃铛请求在小窗查看：收回原实例，仍是同一个进程和同一个网页。
  useTaskShelf.getState().hide(id)
  useTaskShelf.getState().showPanel(id)
  return true
}
