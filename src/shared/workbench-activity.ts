/**
 * 工作台活动快照：原生 Harness 权威状态与独立的 TUI 官方事件来源分开记录。
 *
 * 这里刻意不包含 owner、凭据或桥内 key：main 只按 session/task/approval 路由，
 * 渲染进程拿到的任何字段都可用于跳转和展示，但不能凭它操控别的凭据。
 */

/** 连接状态；空闲或断线都不等于任务完成。 */
export type WorkbenchActivityConnection = 'connected' | 'offline' | 'stale'

/** 任务状态，只来自原生 Harness 官方状态；'unknown' 表示来源不可用或未确认。 */
export type WorkbenchTaskState =
  | 'accepted' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unconfirmed' | 'unknown'

/** 审批选项必须来自官方提供的 options，界面不得自行扩展。 */
export type WorkbenchApprovalOption = 'allowed-once' | 'rejected' | 'cancelled'

export interface WorkbenchBackendIdentity {
  instanceId: string
  instanceEpoch: number
}

export interface WorkbenchActivityApproval {
  id: string
  toolName: string
  callId?: string
  reason: string
  options: WorkbenchApprovalOption[]
  askedAt: number
  /**
   * 与本次审批同 taskId/sessionId/callId 的完整 tool-call 文本。
   * 输出被截断或无法核对时省略，界面此时只能跳转官方工作台，不得猜测操作。
   */
  operation?: string
}

export interface WorkbenchActivitySession {
  /** JSON.stringify([instanceId, instanceEpoch, sessionId, taskId])；不含 owner/token。 */
  key: string
  sessionId: string
  workspace: string
  taskId: string | null
  taskState: WorkbenchTaskState
  source: 'native-harness'
  updatedAt: number
  /** 过期或无法确认时为 true；过期条目只展示，不可作为完成或审批依据。 */
  stale: boolean
  approvals: WorkbenchActivityApproval[]
}

export interface WorkbenchActivitySnapshot {
  observedAt: number
  connection: WorkbenchActivityConnection
  identity: WorkbenchBackendIdentity | null
  sessions: WorkbenchActivitySession[]
  error?: string
  /** 独立 CLI 事件源；原生后台离线不影响它。 */
  tui?: import('./tui-activity').TuiActivitySnapshot
  /** 官方内置聊天的回合观察；审批仍在官方工作台处理。 */
  web?: import('./harness-web-activity').HarnessWebActivitySnapshot
}

export type WorkbenchActivityRequest =
  | { kind: 'snapshot' }
  | {
    kind: 'approve'
    identity: WorkbenchBackendIdentity
    sessionId: string
    taskId: string
    approvalId: string
    optionId: WorkbenchApprovalOption
  }

export const WORKBENCH_APPROVAL_OPTIONS: readonly WorkbenchApprovalOption[] =
  ['allowed-once', 'rejected', 'cancelled']

export function isWorkbenchApprovalOption(value: unknown): value is WorkbenchApprovalOption {
  return typeof value === 'string' && (WORKBENCH_APPROVAL_OPTIONS as readonly string[]).includes(value)
}

/** 会话/任务条目的稳定身份；只取后台实例、代际、会话与任务，不接受额外字段。 */
export function workbenchActivityKey(
  identity: WorkbenchBackendIdentity, sessionId: string, taskId: string | null
): string {
  return JSON.stringify([identity.instanceId, identity.instanceEpoch, sessionId, taskId])
}
