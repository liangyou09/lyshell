/**
 * 退出清理的分组执行与确认断言。
 *
 * 目的：一组清理（如多个传输 Worker、多台浏览器宿主）**全部执行完之后**再统一判断结果；
 * 任何一项失败都必须以固定说明 reject，让生命周期把它记入 `unconfirmed`，而不是
 * 「只写一条 warn 然后当作 completed」——那会让退出日志谎报全部成功。
 */

import { describeShutdownError } from '../quit-cleanup'

export interface CleanupTask {
  /** 稳定名称，用于固定失败说明（不要放会话 id/路径等易变内容）。 */
  readonly name: string
  readonly run: () => unknown
}

const MAX_REPORTED_FAILURES = 8

function failureSummary(label: string, failures: readonly { name: string; error: unknown }[]): Error {
  const names = failures.slice(0, MAX_REPORTED_FAILURES).map(failure => failure.name)
  if (failures.length > MAX_REPORTED_FAILURES) names.push(`+${failures.length - MAX_REPORTED_FAILURES} more`)
  const first = failures[0]
  const detail = first ? `; first failure: ${first.name}: ${describeShutdownError(first.error)}` : ''
  return new Error(`${label} was not confirmed (${names.join(', ')})${detail}`)
}

/** 顺序执行全部任务（互不阻断），最后若有失败则抛固定说明。 */
export async function runSequentialCleanup(label: string, tasks: readonly CleanupTask[]): Promise<void> {
  const failures: { name: string; error: unknown }[] = []
  for (const task of tasks) {
    try {
      await task.run()
    } catch (error) {
      failures.push({ name: task.name, error })
    }
  }
  if (failures.length > 0) throw failureSummary(label, failures)
}

/** 并发执行全部任务（allSettled，互不阻断），最后若有失败则抛固定说明。 */
export async function runConcurrentCleanup(label: string, tasks: readonly CleanupTask[]): Promise<void> {
  const results = await Promise.allSettled(tasks.map(task => Promise.resolve().then(task.run)))
  const failures: { name: string; error: unknown }[] = []
  results.forEach((result, index) => {
    if (result.status === 'rejected') failures.push({ name: tasks[index]?.name ?? `task-${index}`, error: result.reason })
  })
  if (failures.length > 0) throw failureSummary(label, failures)
}

/**
 * 浏览器宿主关闭确认：任何一台未达到 `closed` 都视为未确认。
 * 只读取固定 `phase` 字段，不调用宿主额外方法。
 */
export function assertBrowserHostsClosed(snapshots: readonly { phase?: unknown }[]): void {
  const unconfirmed = snapshots.filter(snapshot => snapshot.phase !== 'closed')
  if (unconfirmed.length === 0) return
  const phases = unconfirmed.slice(0, MAX_REPORTED_FAILURES).map(snapshot => String(snapshot.phase))
  throw new Error(`Browser host shutdown was not confirmed (${unconfirmed.length} host(s) not closed: ${phases.join(', ')})`)
}
