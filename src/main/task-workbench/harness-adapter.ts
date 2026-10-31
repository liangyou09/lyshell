import { resolve } from 'path'
import type { NativeExecutionRef } from '@shared/task-workbench'
import type { WorkbenchBackendIdentity, WorkbenchTaskState } from '@shared/workbench-activity'

export interface TaskHarnessReply { status: number; body: Record<string, unknown> }
export interface NativeTaskView {
  ref: NativeExecutionRef
  identity: WorkbenchBackendIdentity
  requestId: string
  state: WorkbenchTaskState
  lastConfirmedState?: string
  recoveryRequired: boolean
  revision?: number
  approvals: Array<{ id: string; options: string[] }>
}

export function sameBackend(left: WorkbenchBackendIdentity, right: WorkbenchBackendIdentity): boolean {
  return left.instanceId === right.instanceId && left.instanceEpoch === right.instanceEpoch
}

export function sameExecution(left: NativeExecutionRef, right: NativeExecutionRef): boolean {
  return left.sessionId === right.sessionId && left.taskId === right.taskId &&
    left.attemptId === right.attemptId && left.executionSessionId === right.executionSessionId &&
    sameBackend(left.executionIdentity, right.executionIdentity)
}

export function isTerminal(state: string): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled'
}

export function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}

function identity(value: unknown): WorkbenchBackendIdentity | null {
  if (!record(value) || !id(value.instanceId) || !Number.isSafeInteger(value.instanceEpoch) || Number(value.instanceEpoch) < 1) return null
  return { instanceId: value.instanceId, instanceEpoch: Number(value.instanceEpoch) }
}

/** 只解释原生结构化身份；自然语言输出绝不作为执行事实。 */
export function parseNativeTask(reply: TaskHarnessReply): NativeTaskView | null {
  const body = reply.body
  if (reply.status !== 200 || body.ok !== true || body.status === 'offline' || body.stale === true) return null
  const currentIdentity = identity(body.identity)
  const task = body.task
  if (!currentIdentity || !record(task) || !id(task.sessionId) || !id(task.taskId) || !id(task.requestId)) return null
  if (body.taskId !== task.taskId || body.sessionId !== task.sessionId || body.taskState !== task.state) return null
  const states: WorkbenchTaskState[] = ['accepted', 'running', 'completed', 'failed', 'cancelled', 'unconfirmed', 'unknown']
  if (!states.includes(task.state as WorkbenchTaskState)) return null
  if (task.attemptId !== undefined && !id(task.attemptId)) return null
  if (task.executionSessionId !== undefined && !id(task.executionSessionId)) return null
  // 新后台可以冷读旧执行，但必须给出该执行自己的身份。
  const executionIdentity = task.executionIdentity === undefined ? currentIdentity : identity(task.executionIdentity)
  if (!executionIdentity) return null
  const approvals: NativeTaskView['approvals'] = []
  if (!Array.isArray(body.approvals) || body.approvals.length > 128) return null
  for (const item of body.approvals) {
    if (!record(item) || !id(item.id) || !Array.isArray(item.options) || !item.options.every(id)) return null
    if (item.sessionId !== undefined && item.sessionId !== task.sessionId || item.taskId !== undefined && item.taskId !== task.taskId) return null
    approvals.push({ id: item.id, options: item.options as string[] })
  }
  if (isTerminal(String(task.state)) && approvals.length) return null
  return {
    ref: { sessionId: task.sessionId, taskId: task.taskId,
      ...(typeof task.attemptId === 'string' ? { attemptId: task.attemptId } : {}),
      ...(typeof task.executionSessionId === 'string' ? { executionSessionId: task.executionSessionId } : {}), executionIdentity },
    identity: currentIdentity, requestId: task.requestId, state: task.state as WorkbenchTaskState,
    ...(typeof task.lastConfirmedState === 'string' && states.includes(task.lastConfirmedState as WorkbenchTaskState) &&
      !['unconfirmed', 'unknown'].includes(task.lastConfirmedState) ? { lastConfirmedState: task.lastConfirmedState } : {}),
    recoveryRequired: task.recoveryRequired === true || body.recoveryRequired === true,
    ...(Number.isSafeInteger(body.revision) ? { revision: Number(body.revision) } : {}), approvals
  }
}

export function parseCreatedSession(reply: TaskHarnessReply, workspace: string): string | null {
  if (reply.status !== 200 || reply.body.ok !== true || !identity(reply.body.identity) ||
    !id(reply.body.sessionId) || typeof reply.body.workspace !== 'string') return null
  const normalize = (value: string): string => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)
  return normalize(reply.body.workspace) === normalize(workspace) ? reply.body.sessionId : null
}

export function submissionRejected(reply: TaskHarnessReply): boolean {
  // 该原生错误来自派发前的会话 busy 校验；其余调用后失败一律保留未知。
  return reply.status === 409 && reply.body.ok === false && reply.body.code === 'task/busy'
}
