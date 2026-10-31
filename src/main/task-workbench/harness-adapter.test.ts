import { describe, expect, it } from 'vitest'
import { parseCreatedSession, parseNativeTask, sameExecution } from './harness-adapter'

const identity = { instanceId: 'backend', instanceEpoch: 100 }
const old = { instanceId: 'old-backend', instanceEpoch: 90 }
const reply = (over: Record<string, unknown> = {}) => ({ status: 200, body: { ok: true, identity, status: 'idle',
  sessionId: 'session', taskId: 'task', taskState: 'completed',
  task: { sessionId: 'session', taskId: 'task', requestId: 'request', attemptId: 'attempt', state: 'completed', executionIdentity: old },
  approvals: [], ...over } })

describe('task workbench native identity adapter', () => {
  it('keeps response identity distinct from the identity of a cold-read execution', () => {
    const view = parseNativeTask(reply())!
    expect(view.identity).toEqual(identity)
    expect(view.ref.executionIdentity).toEqual(old)
    expect(sameExecution(view.ref, { ...view.ref, executionIdentity: identity })).toBe(false)
    expect(sameExecution(view.ref, { ...view.ref, attemptId: 'new-attempt' })).toBe(false)
  })
  it('rejects offline, mismatched task/session, and impossible terminal approval facts', () => {
    expect(parseNativeTask(reply({ status: 'offline' }))).toBeNull()
    expect(parseNativeTask(reply({ sessionId: 'different-session' }))).toBeNull()
    expect(parseNativeTask(reply({ taskId: 'different-task' }))).toBeNull()
    expect(parseNativeTask(reply({ approvals: [{ id: 'approval', options: ['allowed-once'] }] }))).toBeNull()
    expect(parseNativeTask(reply({ task: { sessionId: 'session', taskId: 'task', requestId: 'request', state: 'completed', executionIdentity: 'wrong' } }))).toBeNull()
  })
  it('accepts only the actual new-session workspace and backend identity', () => {
    expect(parseCreatedSession({ status: 200, body: { ok: true, identity, sessionId: 'new', workspace: 'D:/work/project' } }, 'D:/work/project')).toBe('new')
    expect(parseCreatedSession({ status: 200, body: { ok: true, identity, sessionId: 'new', workspace: 'D:/other' } }, 'D:/work/project')).toBeNull()
    expect(parseCreatedSession({ status: 200, body: { ok: true, sessionId: 'new', workspace: 'D:/work/project' } }, 'D:/work/project')).toBeNull()
  })
})
