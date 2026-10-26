import type { WorkbenchBackendIdentity, WorkbenchActivityConnection } from './workbench-activity'

/** 官方 Web 手动回合的只读证据；不授予 native work 控制权。 */
export interface HarnessWebActivitySession {
  sessionId: string
  workspace: string
  turnId: string
  state: 'running' | 'waiting-approval' | 'turn-ended' | 'failed' | 'interrupted'
  updatedAt: number
  approvalIds: string[]
}
export interface HarnessWebActivityEvent {
  id: string
  sessionId: string
  workspace: string
  turnId: string
  kind: 'turn-ended' | 'failed' | 'interrupted' | 'approval'
  at: number
}
export interface HarnessWebActivitySnapshot {
  observedAt: number
  connection: WorkbenchActivityConnection
  identity: WorkbenchBackendIdentity | null
  revision: number
  sessions: HarnessWebActivitySession[]
  events: HarnessWebActivityEvent[]
}
