/** TUI 官方生命周期事件；回合结束不等同于用户目标已经实现。 */
export type TuiActivitySource = 'codex' | 'claude'
export type TuiActivityState = 'unknown' | 'idle' | 'running' | 'waiting-approval' | 'turn-ended' | 'failed' | 'interrupted' | 'session-ended'

export interface TuiActivitySession {
  terminalId: string
  launchId: string
  source: TuiActivitySource
  workspace: string
  cliSessionId: string | null
  turnId: string | null
  state: TuiActivityState
  updatedAt: number
  /** 最近一次 CLI 事件；不是通过终端静默时间推断。 */
  event: string | null
  active: boolean
  /** 仅指向当前待处理的审批提醒；同一回合的旧提醒不再激活。 */
  approvalEventId?: string
}

export interface TuiActivityEvent {
  id: string
  terminalId: string
  launchId: string
  source: TuiActivitySource
  workspace: string
  turnId: string
  kind: 'turn-ended' | 'failed' | 'interrupted' | 'approval'
  at: number
}

export interface TuiActivitySnapshot {
  observedAt: number
  /** 单调修订号防止同一毫秒内的旧 IPC 响应覆盖新事件。 */
  revision?: number
  sessions: TuiActivitySession[]
  events: TuiActivityEvent[]
}
