import type { WorkbenchBackendIdentity, WorkbenchTaskState } from './workbench-activity'
import type { ActivityNavigationResult } from './activity-navigation'

export type TaskApprovalPolicy = 'auto-allow' | 'manual'
export type TaskHandoffState = 'waiting' | 'sending' | 'bound' | 'unknown' | 'rejected' | 'withdrawn'
export interface PerformanceMetric {
  name: string
  unit: string
  direction: 'higher' | 'lower'
  baseline: number
  current: number
  samples: number
  thresholdPercent: number
}
export interface PerformanceInput {
  component: string
  baselineVersion: string
  currentVersion: string
  environment: string
  workload: string
  metrics: PerformanceMetric[]
}
export interface TaskDefinition {
  title: string
  goal: string
  workspace: string
  templateId: 'general' | 'component-performance'
  acceptanceCriteria: string
  resourceIds: string[]
  approvalPolicy: TaskApprovalPolicy
  performance?: PerformanceInput
}
export interface TaskEntry extends TaskDefinition {
  id: string
  revision: number
  createdAt: number
  updatedAt: number
}
export interface NativeExecutionRef {
  sessionId: string
  taskId: string
  attemptId?: string
  executionSessionId?: string
  executionIdentity: WorkbenchBackendIdentity
}
export interface TaskNativeObservation {
  state: WorkbenchTaskState
  stale: boolean
  observedAt: number
  identity: WorkbenchBackendIdentity | null
  executionIdentity?: WorkbenchBackendIdentity
  attemptId?: string
  lastConfirmedState?: string
}
export interface TaskNote { id: string; text: string; at: number; kind: 'note' | 'resource-release' | 'approval' }
export interface TaskResumeIntent {
  enqueueSeq?: number
  operationId: string
  requestId: string
  text: string
  sourceAttemptId?: string
  state: 'waiting' | 'sending' | 'unknown'
}
export interface TaskSubmission {
  id: string
  taskEntryId: string
  taskRevision: number
  clientOperationId: string
  queueMode: 'host'
  enqueueSeq: number
  frozenDefinition: TaskDefinition
  frozenInputRef: string
  frozenInputHash: string
  workspaceFingerprint?: string
  templateVersion: 1
  requestId: string
  handoffState: TaskHandoffState
  sessionCreate?: { state: 'sending' | 'bound' | 'unknown'; workspace: string; sessionId?: string }
  nativeExecutionRef?: NativeExecutionRef
  /** 当前 attempt 的原生请求 ID；报告必须声明这一执行关联。 */
  executionRequestId?: string
  observation?: TaskNativeObservation
  executionHistory: NativeExecutionRef[]
  resumeIntent?: TaskResumeIntent
  slotHeld: boolean
  resourcesHeld: string[]
  cancelRequestedAt?: number
  error?: string
  notes: TaskNote[]
  createdAt: number
  updatedAt: number
}
export interface TaskArtifact {
  artifactId: string
  submissionId: string
  name: string
  relativePath: string
  format: 'markdown' | 'json' | 'text'
  bytes: number
  sha256: string
  collectedAt: number
  frozenInputHash: string
  templateVersion: 1
  source: 'host-check' | 'agent-file' | 'user-input'
  nativeExecutionRef?: NativeExecutionRef
}
export interface TaskVerificationCheck { name: string; passed: boolean; detail: string }
export interface TaskResultBundle {
  id: string
  submissionId: string
  artifacts: TaskArtifact[]
  decision: 'pending' | 'passed' | 'failed' | 'needs-human'
  checks: TaskVerificationCheck[]
  businessOutcome: 'normal' | 'regression' | 'not-comparable' | 'not-evaluated'
  frozenInputHash: string
  nativeExecutionRef?: NativeExecutionRef
  verifierVersion: 1
  verifiedAt: number
  reviewer?: string
}
export interface TaskOperationReceipt {
  id: string
  fingerprint: string
  entityId: string
  at: number
}
/** 主进程唯一写者保存的业务清单；不保存 owner 或任何连接凭据。 */
export interface TaskWorkbenchManifest {
  schemaVersion: 1
  revision: number
  queueEnabled: boolean
  maxActive: number
  nextEnqueueSeq: number
  entries: TaskEntry[]
  submissions: TaskSubmission[]
  results: TaskResultBundle[]
  operations: TaskOperationReceipt[]
}
export interface TaskWorkbenchSnapshot {
  revision: number
  queueEnabled: boolean
  maxActive: number
  entries: TaskEntry[]
  submissions: TaskSubmission[]
  results: TaskResultBundle[]
  storageError?: string
}
type Mutation = { operationId: string }
export type TaskWorkbenchRequest =
  | { kind: 'list' }
  | ({ kind: 'save'; definition: TaskDefinition; entryId?: string; expectedRevision?: number } & Mutation)
  | ({ kind: 'start'; entryId: string; expectedRevision: number } & Mutation)
  | ({ kind: 'withdraw' | 'cancel' | 'verify'; submissionId: string } & Mutation)
  | ({ kind: 'setQueueEnabled'; enabled: boolean; maxActive?: number } & Mutation)
  | { kind: 'inspect'; submissionId: string }
  | ({ kind: 'addNote' | 'releaseResources'; submissionId: string; text: string } & Mutation)
  | ({ kind: 'resume'; submissionId: string; text: string } & Mutation)
  | ({ kind: 'accept'; submissionId: string; text: string } & Mutation)
  | { kind: 'recover' }
  | { kind: 'openNative'; submissionId: string }
  | { kind: 'readArtifact'; artifactId: string }
  | { kind: 'exportArtifact'; artifactId: string }
export interface TaskWorkbenchReply {
  ok: boolean
  snapshot?: TaskWorkbenchSnapshot
  entityId?: string
  error?: string
  artifactContent?: string
  navigation?: ActivityNavigationResult
  operationUnconfirmed?: boolean
}
