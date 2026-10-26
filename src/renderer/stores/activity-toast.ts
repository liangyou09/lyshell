import type { ActivityNotice } from './workbench-activity'

/** 右上角活动提醒的默认停留时长；审批需要用户处理，不自动消失。 */
export const ACTIVITY_TOAST_DURATION_MS = 8000

/** 已见 ID 容量；超过后淘汰最早已见，避免长时间运行无限增长。 */
const SEEN_CAPACITY = 512

export function activityToastTimeout(kind: ActivityNotice['kind']): number | null {
  return kind === 'approval' ? null : ACTIVITY_TOAST_DURATION_MS
}

export interface ActivityToastTracker {
  take: (notices: readonly ActivityNotice[]) => ActivityNotice[]
}

/**
 * 跟踪已提醒过的活动事件。构造时把 initial 记为已见，界面重新挂载不会重播历史。
 * take 只返回新事件并保持输入次序（调用方传来的数组最新在前），不修改输入。
 */
export function createActivityToastTracker(initial: readonly ActivityNotice[] = []): ActivityToastTracker {
  const seen = new Set<string>()
  const remember = (id: string): void => {
    if (seen.has(id)) return
    seen.add(id)
    while (seen.size > SEEN_CAPACITY) {
      const oldest = seen.values().next()
      if (oldest.done) break
      seen.delete(oldest.value)
    }
  }
  for (const notice of initial) remember(notice.id)
  return {
    take: notices => {
      const fresh: ActivityNotice[] = []
      const batch = new Set<string>()
      for (const notice of notices) {
        if (batch.has(notice.id)) continue
        batch.add(notice.id)
        if (seen.has(notice.id)) continue
        // 先记忆再输出：同一次输入中的重复 ID 只出现一次，且无论是否输出都算已见。
        remember(notice.id)
        fresh.push(notice)
      }
      return fresh
    }
  }
}

/**
 * 合并待展示提醒：按 ID 去重（incoming 覆盖 current），审批优先，同类按 at 降序且保持稳定。
 * 只按 kind 与 at 排序，不因审批结束推断任务状态变化；返回新数组，不修改输入。
 */
export function mergeActivityToasts(
  current: readonly ActivityNotice[],
  incoming: readonly ActivityNotice[],
  limit = 3
): ActivityNotice[] {
  if (!(limit > 0)) return []
  const merged = new Map<string, ActivityNotice>()
  for (const notice of current) merged.set(notice.id, notice)
  for (const notice of incoming) merged.set(notice.id, notice)
  const ordered = [...merged.values()].map((notice, index) => ({ notice, index }))
  ordered.sort((left, right) => {
    const leftApproval = left.notice.kind === 'approval' ? 0 : 1
    const rightApproval = right.notice.kind === 'approval' ? 0 : 1
    if (leftApproval !== rightApproval) return leftApproval - rightApproval
    if (left.notice.at !== right.notice.at) return right.notice.at - left.notice.at
    return left.index - right.index
  })
  return ordered.slice(0, Math.floor(limit)).map(item => item.notice)
}
