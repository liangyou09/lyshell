import type { HarnessWebActivitySession, HarnessWebActivitySnapshot } from '@shared/harness-web-activity'
import type { TaskShelfEntry } from '@shared/task-shelf'
import type { TuiActivitySnapshot, TuiActivityState } from '@shared/tui-activity'
import type { WorkbenchActivitySession, WorkbenchActivitySnapshot, WorkbenchBackendIdentity, WorkbenchTaskState } from '@shared/workbench-activity'
import { ConnectionStatus } from '@shared/types'
import { activityFresh, tuiActivityFresh, webActivityFresh } from '../../stores/workbench-activity'

/**
 * 保存区缩略图的权威状态。
 *
 * 每个值都必须来自官方来源（TUI 生命周期事件 / 原生任务视图 / 官方 Web 回合观察），
 * 不从连接状态推断「运行」、不从输出静默推断「空闲」、不把断线或跨代恢复当成「完成」。
 */
export type ShelfTaskStatus =
  | 'running' | 'idle' | 'approval' | 'completed' | 'turnEnded'
  | 'failed' | 'interrupted' | 'disconnected' | 'unknown'

/** TUI 生命周期状态 → 缩略图状态；unknown/session-ended 没有可信结论。 */
const TUI_STATE_STATUS: Partial<Record<TuiActivityState, ShelfTaskStatus>> = {
  idle: 'idle',
  running: 'running',
  'waiting-approval': 'approval',
  'turn-ended': 'turnEnded',
  failed: 'failed',
  interrupted: 'interrupted'
}

/** 原生任务状态 → 缩略图状态；unconfirmed/unknown 保持未知。 */
const NATIVE_TASK_STATUS: Partial<Record<WorkbenchTaskState, ShelfTaskStatus>> = {
  accepted: 'running',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'interrupted'
}

/** 官方 Web 回合状态 → 缩略图状态；回合结束只表示回合结束，不是目标完成。 */
const WEB_STATE_STATUS: Record<HarnessWebActivitySession['state'], ShelfTaskStatus> = {
  running: 'running',
  'waiting-approval': 'approval',
  'turn-ended': 'turnEnded',
  failed: 'failed',
  interrupted: 'interrupted'
}

/** 后台身份必须同时匹配实例和代际；缺任一侧都不算匹配。 */
function sameIdentity(
  left: WorkbenchBackendIdentity | null | undefined,
  right: WorkbenchBackendIdentity | undefined
): boolean {
  return !!left && !!right && left.instanceId === right.instanceId && left.instanceEpoch === right.instanceEpoch
}

/** 连接状态只表达「能否继续」，从不据此推断运行、空闲或完成。 */
function connectionStatusOf(status: string | undefined): ShelfTaskStatus | undefined {
  if (status === ConnectionStatus.ERROR) return 'failed'
  // ConnectionStatus 枚举没有 closed；外部历史调用方可能传旧值，与断线同义。
  if (status === ConnectionStatus.DISCONNECTED || status === 'closed') return 'disconnected'
  return undefined
}

function resolveTerminalStatus(
  bindingId: string,
  snapshot: WorkbenchActivitySnapshot | null,
  connectionStatus: string | undefined,
  now: number
): ShelfTaskStatus {
  // 连接错误/断开优先于任何任务推断：断线既不是完成也不是运行。
  const connection = connectionStatusOf(connectionStatus)
  if (connection) return connection
  const tui: TuiActivitySnapshot | undefined = snapshot?.tui
  if (!tui || !tuiActivityFresh(tui, now)) return 'unknown'
  // 只认当前启动且仍活跃的行；旧启动或已失活的行不提供状态。
  const row = tui.sessions.find(item => item.terminalId === bindingId && item.active)
  return row ? TUI_STATE_STATUS[row.state] ?? 'unknown' : 'unknown'
}

type HarnessRecovery = Extract<TaskShelfEntry['recovery'], { kind: 'harness' }>

function resolveHarnessStatus(
  recovery: HarnessRecovery,
  snapshot: WorkbenchActivitySnapshot | null,
  now: number
): ShelfTaskStatus {
  const identity = recovery.identity
  const sessionId = recovery.sessionId
  // 没有会话身份就无法证明这条记录仍属于当前后台；持久化的 lastState 不作为证据。
  if (!snapshot || !identity || !sessionId) return 'unknown'

  // 官方 Web 回合观察优先：同一会话的精确回合比原生任务视图更直接。
  const web: HarnessWebActivitySnapshot | undefined = snapshot.web
  if (web && webActivityFresh(web, now) && sameIdentity(web.identity, identity)) {
    const row = web.sessions.find(item => item.sessionId === sessionId &&
      (!recovery.taskId || item.turnId === recovery.taskId))
    if (row) return WEB_STATE_STATUS[row.state] ?? 'unknown'
  }

  // 原生后台：快照必须新鲜且属于同一后台代际，过期条目不能当作完成或审批依据。
  if (!activityFresh(snapshot, now) || !sameIdentity(snapshot.identity, identity)) return 'unknown'
  const rows = snapshot.sessions.filter(item => item.sessionId === sessionId && !item.stale &&
    (!recovery.taskId || item.taskId === recovery.taskId))
  // 同一会话可能残留多个任务视图；优先待审批，其次取最新更新的一条。
  const latest = rows.reduce<WorkbenchActivitySession | undefined>(
    (best, item) => !best || item.updatedAt > best.updatedAt ? item : best, undefined)
  const row = rows.find(item => item.approvals.length > 0) ?? latest
  if (!row) return 'unknown'
  if (row.approvals.length > 0) return 'approval'
  return NATIVE_TASK_STATUS[row.taskState] ?? 'unknown'
}

/**
 * 解析保存区任务缩略图的权威状态（纯函数，无副作用、无凭据、无远程请求）。
 *
 * @param entry 保存区条目；只读取 recovery，持久化的 lastState 不参与判断。
 * @param binding 当前窗口的实时绑定；终端必须匹配 binding.id，否则没有可信来源。
 * @param snapshot 工作台活动快照（原生 + TUI + 官方 Web）。
 * @param connectionStatus 绑定终端的连接状态（ConnectionStatus 值）。
 * @param now 判定新鲜度的当前时间，便于测试注入。
 */
export function resolveShelfTaskStatus(
  entry: TaskShelfEntry,
  binding: { kind: string; id: string } | undefined,
  snapshot: WorkbenchActivitySnapshot | null,
  connectionStatus?: string,
  now: number = Date.now()
): ShelfTaskStatus {
  const recovery = entry.recovery
  if (recovery.kind === 'harness') return resolveHarnessStatus(recovery, snapshot, now)
  // 普通网页没有任务活动源；终端还必须同时具备本地绑定与连接状态。
  if (recovery.kind !== 'terminal' || !binding || binding.kind !== 'terminal') return 'unknown'
  // 绑定必须指向条目自己的终端会话；别的会话的连接状态不能替它下结论。
  if (recovery.sessionId !== binding.id) return 'unknown'
  return resolveTerminalStatus(binding.id, snapshot, connectionStatus, now)
}
