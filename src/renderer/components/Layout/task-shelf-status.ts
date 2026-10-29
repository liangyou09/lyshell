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
 * 'accepted' 只表示官方已接收但还没有运行证据，'connectionError' 只表示连接异常而任务结果仍未知；
 * 两者都不冒充 'running' / 'failed'。
 */
export type ShelfTaskStatus =
  | 'accepted' | 'running' | 'idle' | 'approval' | 'completed' | 'turnEnded'
  | 'failed' | 'interrupted' | 'connectionError' | 'disconnected' | 'unknown'

/** TUI 生命周期状态 → 缩略图状态；unknown/session-ended 没有可信结论。 */
const TUI_STATE_STATUS: Partial<Record<TuiActivityState, ShelfTaskStatus>> = {
  idle: 'idle',
  running: 'running',
  'waiting-approval': 'approval',
  'turn-ended': 'turnEnded',
  failed: 'failed',
  interrupted: 'interrupted'
}

/** 原生任务状态 → 缩略图状态；accepted 只是已接收，unconfirmed/unknown 保持未知。 */
const NATIVE_TASK_STATUS: Partial<Record<WorkbenchTaskState, ShelfTaskStatus>> = {
  accepted: 'accepted',
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
  // 连接异常时任务结果未知：仍可能成功的任务不能记成 failed。
  if (status === ConnectionStatus.ERROR) return 'connectionError'
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
  // 连接错误/断开优先于任何任务推断：断线既不是完成也不是运行，旧事件也不再可信。
  const connection = connectionStatusOf(connectionStatus)
  if (connection) return connection
  const tui: TuiActivitySnapshot | undefined = snapshot?.tui
  if (!tui || !tuiActivityFresh(tui, now)) return 'unknown'
  // 只认当前启动且仍活跃的行；旧启动或已失活的行不提供状态。
  const row = tui.sessions.find(item => item.terminalId === bindingId && item.active)
  // session-ended 等状态没有可信任务结果，由映射表回落为未知。
  return row ? TUI_STATE_STATUS[row.state] ?? 'unknown' : 'unknown'
}

/**
 * 单个终端的任务状态（状态灯公共接口）。
 *
 * 只认新鲜 TUI 快照中同一 terminalId 且仍 active 的行；连接断开/异常覆盖旧任务事件，
 * 因为没有连接就无法证明那之后的任务结果。session-ended 本身没有可信任务结果，保持 unknown。
 *
 * @param bindingId 终端会话 id；必须与 TUI 行、调用方绑定指向同一终端。
 * @param snapshot 工作台活动快照；只读取其中的 tui 部分。
 * @param connectionStatus 该终端的 ConnectionStatus 值（允许历史 'closed'）。
 * @param now 判定新鲜度的当前时间，便于测试注入。
 */
export function resolveTerminalTaskStatus(
  bindingId: string,
  snapshot: WorkbenchActivitySnapshot | null,
  connectionStatus?: string,
  now: number = Date.now()
): ShelfTaskStatus {
  return resolveTerminalStatus(bindingId, snapshot, connectionStatus, now)
}

/**
 * 单个原生任务的阶段状态（状态灯公共接口），由 Sessions 传入当前快照行。
 *
 * 快照必须新鲜（含后台已连接、身份存在、未过期）且行本身不过期，否则旧阶段和旧审批都不能作为依据。
 * 待审批优先于任务阶段：审批未处理时阶段值不能代表用户可忽略的进度。
 *
 * @param row 当前快照里的原生任务行。
 * @param snapshot 该行所属的工作台活动快照。
 * @param now 判定新鲜度的当前时间，便于测试注入。
 */
export function resolveNativeTaskStatus(
  row: WorkbenchActivitySession,
  snapshot: WorkbenchActivitySnapshot | null,
  now: number = Date.now()
): ShelfTaskStatus {
  if (!activityFresh(snapshot, now)) return 'unknown'
  // 过期或无法确认的行只可展示，不能当作完成或审批依据。
  if (row.stale) return 'unknown'
  if (row.approvals.length > 0) return 'approval'
  return NATIVE_TASK_STATUS[row.taskState] ?? 'unknown'
}

/**
 * 单个官方 Web 回合的状态（状态灯公共接口）。
 *
 * 只认新鲜且已连接的官方 Web 快照；回合结束只能映射为 turnEnded，不能升级成 completed。
 *
 * @param row 当前快照里的官方 Web 回合行。
 * @param snapshot 该行所属的官方 Web 活动快照。
 * @param now 判定新鲜度的当前时间，便于测试注入。
 */
export function resolveWebTaskStatus(
  row: HarnessWebActivitySession,
  snapshot: HarnessWebActivitySnapshot | undefined,
  now: number = Date.now()
): ShelfTaskStatus {
  if (!webActivityFresh(snapshot, now)) return 'unknown'
  return WEB_STATE_STATUS[row.state] ?? 'unknown'
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
    if (row) return resolveWebTaskStatus(row, web, now)
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
  return resolveNativeTaskStatus(row, snapshot, now)
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
  return resolveTerminalTaskStatus(binding.id, snapshot, connectionStatus, now)
}
