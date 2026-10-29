import { beforeEach, describe, it, expect } from 'vitest'
import type { HarnessWorkRequest } from '@shared/harness-work'
import type { WorkbenchActivitySession, WorkbenchActivitySnapshot } from '@shared/workbench-activity'
import {
  approveWorkbenchActivity,
  configureWorkbenchActivity,
  readWorkbenchActivity,
  recordWorkbenchActivityReply,
  registerWorkbenchActivityOwner,
  resetWorkbenchActivityState,
  type WorkbenchActivityBridgeReader,
  type WorkbenchActivityBridgeReply
} from './activity'

const OWNER_A = 'a'.repeat(64)
const OWNER_B = 'b'.repeat(64)
const FIXTURE_ENDPOINT = { port: 4711, key: 'fixture-bridge-key' }
const IDENTITY_1 = { instanceId: 'inst-1', instanceEpoch: 1 }
const IDENTITY_2 = { instanceId: 'inst-1', instanceEpoch: 2 }
const IDENTITY_OTHER = { instanceId: 'inst-2', instanceEpoch: 1 }

type ReplyFn = (owner: string, request: HarnessWorkRequest) => WorkbenchActivityBridgeReply

interface BridgeCall {
  owner: string
  request: HarnessWorkRequest
  timeoutMs: number
}

interface Rig {
  calls: BridgeCall[]
  replies: { fn: ReplyFn }
  clock: { value: number }
  endpoint: { present: boolean }
}

/** 纯 HTTP fixture：readBridge 被替换成可编程回执，绝不接触真实后台。 */
function createRig(fn: ReplyFn): Rig {
  const rig: Rig = {
    calls: [],
    replies: { fn },
    clock: { value: 1_700_000_000_000 },
    endpoint: { present: true }
  }
  const readBridge: WorkbenchActivityBridgeReader = async (endpoint, owner, request, options) => {
    expect(endpoint).toEqual(FIXTURE_ENDPOINT)
    rig.calls.push({ owner, request, timeoutMs: options.timeoutMs })
    return rig.replies.fn(owner, request)
  }
  configureWorkbenchActivity({
    readEndpoint: () => (rig.endpoint.present ? FIXTURE_ENDPOINT : null),
    readBridge,
    now: () => rig.clock.value
  })
  return rig
}

function ok(body: Record<string, unknown>): WorkbenchActivityBridgeReply {
  return { status: 200, body: { ok: true, ...body } }
}

/** 与 resources/dsh-bridge 的 snapshot 形状一致（无任务时空字段为 null）。 */
function idleBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    identity: { ...IDENTITY_1 },
    status: 'idle',
    sessionId: 's1',
    workspace: 'D:/ws/one',
    taskId: null,
    taskState: null,
    task: null,
    sessions: [{ sessionId: 's1', workspace: 'D:/ws/one' }],
    approvals: [],
    transcript: [],
    transcriptTruncated: false,
    ...over
  }
}

function runningBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return idleBody({
    status: 'running',
    taskId: 'task-a',
    taskState: 'running',
    task: { taskId: 'task-a', sessionId: 's1', requestId: 'req-1', state: 'running' },
    ...over
  })
}

function completedBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return idleBody({
    status: 'idle',
    taskId: 'task-a',
    taskState: 'completed',
    task: { taskId: 'task-a', sessionId: 's1', requestId: 'req-1', state: 'completed' },
    ...over
  })
}

function offlineBody(): Record<string, unknown> {
  return {
    status: 'offline',
    sessionId: null,
    taskId: null,
    taskState: null,
    sessions: [],
    approvals: [],
    transcript: [],
    recovery: 'Backend unavailable; previous task outcome is unknown'
  }
}

function toolCallChunks(callId: string, texts: string[], startSeq = 2): Array<Record<string, unknown>> {
  return texts.map((text, index) => ({
    seq: startSeq + index, kind: 'tool-call', text, at: 900 + index,
    taskId: 'task-a', sessionId: 's1', toolName: 'Bash', callId
  }))
}

function approvalBody(
  over: Record<string, unknown> = {}, chunks = ['{"command":"rm -rf ', 'build"}']
): Record<string, unknown> {
  return runningBody({
    status: 'approval',
    approvals: [{
      id: 'appr-1', taskId: 'task-a', sessionId: 's1', toolName: 'Bash', callId: 'call-1',
      reason: 'destructive command', options: ['allowed-once', 'rejected', 'cancelled'], askedAt: 903
    }],
    transcript: toolCallChunks('call-1', chunks),
    ...over
  })
}

function approveRequest(over: Record<string, unknown> = {}) {
  return {
    kind: 'approve' as const,
    identity: { ...IDENTITY_1 },
    sessionId: 's1',
    taskId: 'task-a',
    approvalId: 'appr-1',
    optionId: 'allowed-once' as const,
    ...over
  }
}

function onlySession(snapshot: WorkbenchActivitySnapshot): WorkbenchActivitySession {
  expect(snapshot.sessions).toHaveLength(1)
  return snapshot.sessions[0]
}

let rig: Rig

beforeEach(() => {
  resetWorkbenchActivityState()
  rig = createRig(() => ok(idleBody()))
})

describe('工作台活动：快照读取', () => {
  it('同一逻辑 task 的新 attempt 可以从旧终态继续；旧 attempt 迟到快照不倒退', async () => {
    let body = completedBody({ task: { taskId: 'task-a', sessionId: 's1', state: 'completed', attemptId: 'attempt-1', acceptedAt: 1 } })
    createRig(() => ok(body)); registerWorkbenchActivityOwner(OWNER_A)
    expect((await readWorkbenchActivity()).sessions[0].taskState).toBe('completed')
    body = runningBody({ task: { taskId: 'task-a', sessionId: 's1', state: 'running', attemptId: 'attempt-2', acceptedAt: 2 }, revision: 2 })
    expect((await readWorkbenchActivity()).sessions[0].taskState).toBe('running')
    body = completedBody({ task: { taskId: 'task-a', sessionId: 's1', state: 'completed', attemptId: 'attempt-1', acceptedAt: 1 }, revision: 1 })
    expect((await readWorkbenchActivity()).sessions[0].taskState).toBe('running')
  })
  it('较早快照的迟到回执不能删除新会话、清空审批或回退同毫秒的新任务', async () => {
    const current = approvalBody({ revision: 3, task: { taskId: 'task-a', sessionId: 's1', state: 'running', acceptedAt: 100 } })
    const b = runningBody({ sessionId: 's2', workspace: 'D:/ws/two', taskId: 'task-b',
      task: { taskId: 'task-b', sessionId: 's2', state: 'running', acceptedAt: 100 } })
    const views = [current, b].map(({ sessions: _sessions, identity: _identity, ...view }) => view)
    recordWorkbenchActivityReply(OWNER_A, ok({ ...current, sessions: views }))
    recordWorkbenchActivityReply(OWNER_A, ok(idleBody({ revision: 1 })))
    rig.replies.fn = () => ok(completedBody({ revision: 2, taskId: 'task-old',
      task: { taskId: 'task-old', sessionId: 's1', state: 'completed', acceptedAt: 100 } }))
    const snapshot = await readWorkbenchActivity()
    expect(snapshot.sessions).toHaveLength(2)
    expect(snapshot.sessions.find(row => row.sessionId === 's1')).toMatchObject({ taskId: 'task-a', taskState: 'running', stale: false, approvals: [{ id: 'appr-1' }] })
    expect(snapshot.sessions.find(row => row.sessionId === 's2')).toMatchObject({ taskId: 'task-b', taskState: 'running', stale: false })
  })
  it('同一凭据的不同会话保留各自运行/终态和审批，默认选择不影响聚合', async () => {
    const a = approvalBody({ task: { taskId: 'task-a', sessionId: 's1', state: 'running', acceptedAt: 100 } })
    const b = runningBody({ sessionId: 's2', workspace: 'D:/ws/two', taskId: 'task-b',
      task: { taskId: 'task-b', sessionId: 's2', state: 'running', acceptedAt: 200 } })
    const views = [a, b].map(({ sessions: _sessions, identity: _identity, ...view }) => view)
    const all = { ...b, sessions: views }
    rig.replies.fn = (_owner, request) => {
      if (request.kind === 'state' && request.taskId === 'task-a') return ok({ ...a, sessions: views })
      return ok(all)
    }
    registerWorkbenchActivityOwner(OWNER_A)
    const snapshot = await readWorkbenchActivity()
    expect(snapshot.sessions.map(session => session.taskState)).toEqual(['running', 'running'])
    expect(snapshot.sessions.find(session => session.sessionId === 's1')?.approvals[0]).toMatchObject({ id: 'appr-1' })
    // 默认为 s2，但 s1 的 fresh read 与审批仍精确定位，不依赖全局选择。
    await approveWorkbenchActivity(approveRequest({ optionId: 'rejected' }))
    expect(rig.calls.some(call => call.request.kind === 'state' && call.request.sessionId === 's1' && call.request.taskId === 'task-a')).toBe(true)
    expect(rig.calls.find(call => call.request.kind === 'approve')?.request).toMatchObject({
      id: 'appr-1', sessionId: 's1', taskId: 'task-a', optionId: 'rejected'
    })
  })

  it('多会话视图中混入错误审批归属时整份拒绝，不展示别的任务操作', async () => {
    const a = approvalBody()
    const view = { ...a }
    delete view.sessions
    delete view.identity
    rig.replies.fn = () => ok({ ...a, sessions: [{ ...view, approvals: [{
      ...(a.approvals as Array<Record<string, unknown>>)[0], sessionId: 'other'
    }] }] })
    registerWorkbenchActivityOwner(OWNER_A)
    expect((await readWorkbenchActivity()).sessions).toEqual([])
  })
  it('迟到的轮询不能覆盖期间已收到的完成回执', async () => {
    recordWorkbenchActivityReply(OWNER_A, ok(runningBody()))
    let release!: (value: WorkbenchActivityBridgeReply) => void
    const pending = new Promise<WorkbenchActivityBridgeReply>(resolve => { release = resolve })
    configureWorkbenchActivity({ readBridge: () => pending })
    const reading = readWorkbenchActivity()
    await Promise.resolve()
    await Promise.resolve()
    recordWorkbenchActivityReply(OWNER_A, ok(completedBody()))
    release(ok(runningBody()))
    expect(onlySession(await reading).taskState).toBe('completed')
  })
  it('已确认终态不会被同一任务的旧 running 回执回退', async () => {
    recordWorkbenchActivityReply(OWNER_A, ok(completedBody()))
    rig.replies.fn = () => ok(runningBody())
    expect(onlySession(await readWorkbenchActivity()).taskState).toBe('completed')
  })
  it('旧任务迟到回执不覆盖新任务或把其它会话降为未知', async () => {
    recordWorkbenchActivityReply(OWNER_A, ok(runningBody({ taskId: 'task-new', task: { taskId: 'task-new', sessionId: 's1', state: 'running', acceptedAt: 200 } })))
    rig.replies.fn = () => ok(completedBody({ task: { taskId: 'task-a', sessionId: 's1', state: 'completed', acceptedAt: 100 } }))
    expect(onlySession(await readWorkbenchActivity())).toMatchObject({ taskId: 'task-new', taskState: 'running', stale: false })
  })
  it('无后台时返回离线快照，不发起任何桥调用', async () => {
    rig.endpoint.present = false
    const snapshot = await readWorkbenchActivity()
    expect(snapshot.connection).toBe('offline')
    expect(snapshot.identity).toBeNull()
    expect(snapshot.sessions).toEqual([])
    expect(snapshot.error).toBe('Native Harness backend is not running')
    expect(rig.calls).toHaveLength(0)
  })

  it('后台可用但没有已调用任务时连接正常且内容为空', async () => {
    const snapshot = await readWorkbenchActivity()
    expect(snapshot.connection).toBe('connected')
    expect(snapshot.identity).toBeNull()
    expect(snapshot.sessions).toEqual([])
    expect(rig.calls).toHaveLength(0)
  })

  it('只发 state 读请求，绝不 acquire 或重发变更', async () => {
    rig.replies.fn = () => ok(runningBody())
    registerWorkbenchActivityOwner(OWNER_A)
    await readWorkbenchActivity()
    expect(rig.calls).toHaveLength(1)
    expect(rig.calls.every(call => call.request.kind === 'state')).toBe(true)
    expect(rig.calls[0]).toMatchObject({ owner: OWNER_A, request: { kind: 'state' }, timeoutMs: 3000 })
  })

  it('条目 key 由后台身份、会话与任务组成，且不泄露 owner', async () => {
    rig.replies.fn = () => ok(runningBody())
    registerWorkbenchActivityOwner(OWNER_A)
    const snapshot = await readWorkbenchActivity()
    const row = onlySession(snapshot)
    expect(row.key).toBe('["inst-1",1,"s1","task-a"]')
    expect(row).toMatchObject({
      sessionId: 's1', workspace: 'D:/ws/one', taskId: 'task-a', taskState: 'running',
      source: 'native-harness', stale: false, approvals: []
    })
    expect(snapshot.identity).toEqual(IDENTITY_1)
    expect(JSON.stringify(snapshot)).not.toContain(OWNER_A)
    expect(JSON.stringify(snapshot)).not.toContain('fixture-bridge-key')
  })

  it('多凭据同时可见，且 owner 互不串台', async () => {
    rig.replies.fn = (owner) => ok(owner === OWNER_A
      ? runningBody()
      : runningBody({
        taskId: 'task-b', task: { taskId: 'task-b', sessionId: 's2', state: 'running' },
        sessionId: 's2', workspace: 'D:/ws/two', sessions: [{ sessionId: 's2', workspace: 'D:/ws/two' }]
      }))
    registerWorkbenchActivityOwner(OWNER_A)
    registerWorkbenchActivityOwner(OWNER_B)
    const snapshot = await readWorkbenchActivity()
    expect(snapshot.connection).toBe('connected')
    expect(rig.calls.map(call => call.owner).sort()).toEqual([OWNER_A, OWNER_B])
    expect(snapshot.sessions.map(row => row.key).sort()).toEqual([
      '["inst-1",1,"s1","task-a"]', '["inst-1",1,"s2","task-b"]'
    ])
  })

  it('同一凭据的多个会话都显示，当前任务之外的会话不猜状态', async () => {
    rig.replies.fn = () => ok(completedBody({
      sessionId: 's2',
      workspace: 'D:/ws/two',
      task: { taskId: 'task-a', sessionId: 's2', requestId: 'req-1', state: 'completed' },
      sessions: [
        { sessionId: 's1', workspace: 'D:/ws/one' },
        { sessionId: 's2', workspace: 'D:/ws/two' }
      ]
    }))
    registerWorkbenchActivityOwner(OWNER_A)
    const snapshot = await readWorkbenchActivity()
    const bySession = new Map(snapshot.sessions.map(row => [row.sessionId, row]))
    expect(bySession.size).toBe(2)
    expect(bySession.get('s2')).toMatchObject({ taskId: 'task-a', taskState: 'completed', stale: false })
    expect(bySession.get('s1')).toMatchObject({ taskId: null, taskState: 'unknown' })
  })

  it('断线后仍把最后任务归到原会话，终态保留', async () => {
    rig.replies.fn = () => ok(completedBody({
      sessionId: null,
      workspace: null,
      task: { taskId: 'task-a', sessionId: 's1', requestId: 'req-1', state: 'completed' }
    }))
    registerWorkbenchActivityOwner(OWNER_A)
    const snapshot = await readWorkbenchActivity()
    const row = onlySession(snapshot)
    expect(row).toMatchObject({ sessionId: 's1', taskId: 'task-a', taskState: 'completed', stale: false })
  })

  it('空闲或断线不等于完成：未确认任务降级为 unknown', async () => {
    rig.replies.fn = () => ok(runningBody())
    registerWorkbenchActivityOwner(OWNER_A)
    expect(onlySession(await readWorkbenchActivity()).taskState).toBe('running')
    // 会话切换/断开后官方不再报告该任务：保留任务归属，但状态未知、条目过期。
    rig.replies.fn = () => ok(idleBody())
    const snapshot = await readWorkbenchActivity()
    expect(onlySession(snapshot)).toMatchObject({ sessionId: 's1', taskId: 'task-a', taskState: 'unknown', stale: true })
  })
})

describe('工作台活动：身份、超时与畸形快照', () => {
  it('后台身份换代时丢弃旧会话与旧审批路由', async () => {
    rig.replies.fn = () => ok(approvalBody())
    registerWorkbenchActivityOwner(OWNER_A)
    const before = await readWorkbenchActivity()
    expect(onlySession(before).approvals).toHaveLength(1)

    rig.replies.fn = () => ok(idleBody({ identity: { ...IDENTITY_2 }, sessions: [{ sessionId: 's9', workspace: 'D:/ws/new' }], sessionId: 's9', workspace: 'D:/ws/new' }))
    const after = await readWorkbenchActivity()
    expect(after.identity).toEqual(IDENTITY_2)
    expect(after.sessions).toHaveLength(1)
    expect(after.sessions[0].key).toBe('["inst-1",2,"s9",null]')
    expect(after.sessions[0].approvals).toEqual([])
  })

  it('同代际不同实例或更旧代际不会被当成同一个后台覆盖数据', async () => {
    rig.replies.fn = () => ok(runningBody({ identity: { ...IDENTITY_2 } }))
    registerWorkbenchActivityOwner(OWNER_A)
    await readWorkbenchActivity()

    rig.replies.fn = () => ok(idleBody({ identity: { ...IDENTITY_2, instanceId: 'inst-9' } }))
    const sameEpoch = await readWorkbenchActivity()
    expect(sameEpoch.identity).toEqual(IDENTITY_2)
    expect(onlySession(sameEpoch)).toMatchObject({ taskId: 'task-a', taskState: 'unknown', stale: true })

    rig.replies.fn = () => ok(idleBody({ identity: { ...IDENTITY_1 } }))
    const older = await readWorkbenchActivity()
    expect(older.identity).toEqual(IDENTITY_2)
    expect(older.connection).toBe('stale')
  })

  it('超时或抛错只把条目标为过期，不推导完成', async () => {
    rig.replies.fn = () => ok(runningBody())
    registerWorkbenchActivityOwner(OWNER_A)
    await readWorkbenchActivity()

    rig.replies.fn = () => { throw new Error('socket hang up') }
    const snapshot = await readWorkbenchActivity()
    expect(snapshot.connection).toBe('stale')
    expect(snapshot.error).toContain('unavailable')
    expect(onlySession(snapshot)).toMatchObject({ taskId: 'task-a', taskState: 'unknown', stale: true })
  })

  it('官方离线回执让所有条目过期并保留最后确认的身份', async () => {
    rig.replies.fn = () => ok(runningBody())
    registerWorkbenchActivityOwner(OWNER_A)
    await readWorkbenchActivity()

    rig.replies.fn = () => ok(offlineBody())
    const snapshot = await readWorkbenchActivity()
    expect(snapshot.connection).toBe('offline')
    expect(snapshot.identity).toEqual(IDENTITY_1)
    expect(onlySession(snapshot)).toMatchObject({ taskState: 'unknown', stale: true })
    expect(snapshot.error).toBe('Native Harness backend is not running')
  })

  it('一个凭据过期不影响其它凭据的实时数据', async () => {
    rig.replies.fn = (owner) => {
      if (owner === OWNER_B) throw new Error('timeout')
      return ok(runningBody())
    }
    registerWorkbenchActivityOwner(OWNER_A)
    registerWorkbenchActivityOwner(OWNER_B)
    rig.replies.fn = (owner) => {
      if (owner === OWNER_B) return ok(runningBody({
        sessionId: 's2', workspace: 'D:/ws/two', sessions: [{ sessionId: 's2', workspace: 'D:/ws/two' }],
        taskId: 'task-b', task: { taskId: 'task-b', sessionId: 's2', state: 'running' }
      }))
      return ok(runningBody())
    }
    await readWorkbenchActivity()
    rig.replies.fn = (owner) => {
      if (owner === OWNER_B) throw new Error('timeout')
      return ok(runningBody())
    }
    const snapshot = await readWorkbenchActivity()
    expect(snapshot.connection).toBe('stale')
    const bySession = new Map(snapshot.sessions.map(row => [row.sessionId, row]))
    expect(bySession.get('s1')?.stale).toBe(false)
    expect(bySession.get('s2')?.stale).toBe(true)
  })

  it('拒绝畸形快照且不覆盖已有可信状态', async () => {
    rig.replies.fn = () => ok(runningBody())
    registerWorkbenchActivityOwner(OWNER_A)
    await readWorkbenchActivity()

    const malformed: Array<Record<string, unknown>> = [
      // 任务与会话归属不一致
      runningBody({ transcript: [{ seq: 1, kind: 'user', text: 'x', at: 1, taskId: 'task-a', sessionId: 's2' }] }),
      // 任务态非终态却有审批
      completedBody({
        status: 'approval',
        approvals: [{ id: 'appr-1', taskId: 'task-a', sessionId: 's1', toolName: 'Bash', reason: '', options: ['rejected'], askedAt: 5 }]
      }),
      // 选中的会话不在 sessions 里
      runningBody({ sessions: [] }),
      // 任务字段与 taskId 不一致
      runningBody({ task: { taskId: 'task-z', sessionId: 's1', state: 'running' } }),
      // 非法状态值
      runningBody({ taskState: 'approved' }),
      // 审批选项超出官方三种
      approvalBody({ approvals: [{ id: 'appr-1', taskId: 'task-a', sessionId: 's1', toolName: 'Bash', reason: '', options: ['always'], askedAt: 5 }] }),
      // taskId 缺失但 taskState 已进终态
      idleBody({ taskId: null, taskState: 'completed' }),
      // 非法的通话记录类型
      runningBody({ transcript: [{ seq: 1, kind: '', text: 'x', at: 1, taskId: 'task-a', sessionId: 's1' }] })
    ]
    for (const body of malformed) {
      rig.replies.fn = () => ok(body)
      const snapshot = await readWorkbenchActivity()
      const row = onlySession(snapshot)
      expect(row.taskId).toBe('task-a')
      expect(row.taskState).toBe('unknown')
      expect(row.stale).toBe(true)
    }
    // 恢复可信快照后又可以更新
    rig.replies.fn = () => ok(runningBody())
    expect(onlySession(await readWorkbenchActivity()).taskState).toBe('running')
  })

  it('ok:false 与缺少身份的回执都不被当成状态', async () => {
    rig.replies.fn = () => ok(runningBody())
    registerWorkbenchActivityOwner(OWNER_A)
    await readWorkbenchActivity()

    rig.replies.fn = () => ({ status: 409, body: { ok: false, code: 'task/busy' } })
    expect((await readWorkbenchActivity()).connection).toBe('stale')

    rig.replies.fn = () => ok(runningBody({ identity: null }))
    const snapshot = await readWorkbenchActivity()
    expect(snapshot.connection).toBe('stale')
    expect(onlySession(snapshot).stale).toBe(true)
  })

  it('登记回执忽略非 200 与非法 owner', async () => {
    recordWorkbenchActivityReply('not-a-hashed-owner', { status: 200, body: idleBody() })
    recordWorkbenchActivityReply(OWNER_A, { status: 409, body: { ...runningBody() } })
    expect(rig.calls).toHaveLength(0)
    const snapshot = await readWorkbenchActivity()
    expect(snapshot.sessions).toEqual([])
  })

  it('重复的会话条目只保留一条，避免相同的 key 出现两次', async () => {
    rig.replies.fn = () => ok(runningBody())
    registerWorkbenchActivityOwner(OWNER_A)
    registerWorkbenchActivityOwner(OWNER_B)
    const snapshot = await readWorkbenchActivity()
    expect(snapshot.sessions).toHaveLength(1)
    expect(snapshot.sessions[0].key).toBe('["inst-1",1,"s1","task-a"]')
  })

  it('登记处按最后触达淘汰，不会无界增长', async () => {
    rig.replies.fn = () => ok(idleBody())
    for (let index = 0; index < 70; index += 1) {
      registerWorkbenchActivityOwner(`${index.toString(16).padStart(2, '0')}${'c'.repeat(62)}`)
    }
    await readWorkbenchActivity()
    expect(rig.calls).toHaveLength(64)
    expect(rig.calls.map(call => call.owner)).not.toContain('00'.padEnd(64, 'c'))
  })
})

describe('工作台活动：审批路由', () => {
  it('审批前 fresh read，只转发官方审批 ID 与官方声明的选项', async () => {
    rig.replies.fn = (_owner, request) => ok(request.kind === 'approve'
      ? runningBody()
      : approvalBody())
    registerWorkbenchActivityOwner(OWNER_A)
    await readWorkbenchActivity()
    rig.calls.length = 0

    const snapshot = await approveWorkbenchActivity(approveRequest())
    expect(snapshot.error).toBeUndefined()
    expect(rig.calls.map(call => call.request.kind)).toEqual(['state', 'approve'])
    expect(rig.calls[1]).toMatchObject({ owner: OWNER_A, request: { kind: 'approve', id: 'appr-1', optionId: 'allowed-once' } })
  })

  it('拒绝旧后台身份的审批，且不向任何 owner 发送', async () => {
    rig.replies.fn = () => ok(approvalBody())
    registerWorkbenchActivityOwner(OWNER_A)
    await readWorkbenchActivity()
    rig.calls.length = 0
    rig.clock.value += 1000

    // 后台已换代：旧身份的审批路由必须作废（同实例更大代际）。
    rig.replies.fn = () => ok(approvalBody({ identity: { ...IDENTITY_2 } }))
    await readWorkbenchActivity()
    rig.calls.length = 0

    const stale = await approveWorkbenchActivity(approveRequest())
    expect(stale.error).toContain('no longer available')
    expect(rig.calls.filter(call => call.request.kind === 'approve')).toHaveLength(0)
  })

  it('拒绝请求身份与后台身份不一致的审批', async () => {
    rig.replies.fn = () => ok(approvalBody())
    registerWorkbenchActivityOwner(OWNER_A)
    await readWorkbenchActivity()
    rig.calls.length = 0

    const snapshot = await approveWorkbenchActivity(approveRequest({ identity: { ...IDENTITY_OTHER } }))
    expect(snapshot.error).toBeTruthy()
    expect(rig.calls).toHaveLength(0)
  })

  it('拒绝错任务的审批，也不跨 owner 路由', async () => {
    rig.replies.fn = (owner) => ok(owner === OWNER_A
      ? approvalBody()
      : approvalBody({
        sessionId: 's2', workspace: 'D:/ws/two',
        sessions: [{ sessionId: 's1', workspace: 'D:/ws/one' }, { sessionId: 's2', workspace: 'D:/ws/two' }],
        approvals: [{ id: 'appr-2', taskId: 'task-b', sessionId: 's2', toolName: 'Bash', reason: 'r', options: ['rejected'], askedAt: 6 }],
        taskId: 'task-b', task: { taskId: 'task-b', sessionId: 's1', state: 'approval' },
        transcript: toolCallChunks('call-2', ['{"command":"x"}']).map(entry => ({ ...entry, taskId: 'task-b' }))
      }))
    registerWorkbenchActivityOwner(OWNER_A)
    registerWorkbenchActivityOwner(OWNER_B)
    await readWorkbenchActivity()
    rig.calls.length = 0

    // 任务 ID 对不上
    const wrongTask = await approveWorkbenchActivity(approveRequest({ taskId: 'task-b' }))
    expect(wrongTask.error).toContain('no longer available')

    // 审批 ID 属于另一个 owner 的会话
    const crossOwner = await approveWorkbenchActivity(approveRequest({ sessionId: 's2', approvalId: 'appr-2' }))
    expect(crossOwner.error).toContain('no longer available')
    expect(rig.calls.filter(call => call.request.kind === 'approve')).toHaveLength(0)
  })

  it('审批已不存在或选项不在官方列表时拒绝发送', async () => {
    rig.replies.fn = () => ok(approvalBody({
      approvals: [{ id: 'appr-1', taskId: 'task-a', sessionId: 's1', toolName: 'Bash', reason: 'r', options: ['allowed-once'], askedAt: 3 }]
    }))
    registerWorkbenchActivityOwner(OWNER_A)
    await readWorkbenchActivity()
    rig.calls.length = 0

    const missingOption = await approveWorkbenchActivity(approveRequest({ optionId: 'rejected' }))
    expect(missingOption.error).toContain('not offered')
    expect(rig.calls.filter(call => call.request.kind === 'approve')).toHaveLength(0)
  })

  it('fresh read 发现审批已被官方清除时不再发送', async () => {
    rig.replies.fn = () => ok(approvalBody())
    registerWorkbenchActivityOwner(OWNER_A)
    await readWorkbenchActivity()

    rig.replies.fn = () => ok(runningBody())
    rig.calls.length = 0
    const snapshot = await approveWorkbenchActivity(approveRequest())
    expect(snapshot.error).toBeTruthy()
    expect(rig.calls.filter(call => call.request.kind === 'approve')).toHaveLength(0)
    expect(rig.calls.map(call => call.request.kind)).toEqual(['state'])
  })

  it('fresh read 发现后台换代时不把旧审批发给新实例', async () => {
    rig.replies.fn = () => ok(approvalBody())
    registerWorkbenchActivityOwner(OWNER_A)
    await readWorkbenchActivity()

    rig.replies.fn = () => ok(approvalBody({ identity: { ...IDENTITY_2 } }))
    rig.calls.length = 0
    const snapshot = await approveWorkbenchActivity(approveRequest())
    expect(snapshot.error).toContain('identity changed')
    expect(rig.calls.filter(call => call.request.kind === 'approve')).toHaveLength(0)
    expect(snapshot.identity).toEqual(IDENTITY_2)
    expect(snapshot.sessions.every(row => row.key.startsWith('["inst-1",2,'))).toBe(true)
  })

  it('审批转发失败时明确返回未知结果而不是抛错', async () => {
    rig.replies.fn = (_owner, request) => {
      if (request.kind === 'approve') throw new Error('bridge closed')
      return ok(approvalBody())
    }
    registerWorkbenchActivityOwner(OWNER_A)
    await readWorkbenchActivity()
    const snapshot = await approveWorkbenchActivity(approveRequest())
    expect(snapshot.error).toContain('failed')
    expect(onlySession(snapshot).stale).toBe(true)
  })

  it('真实传输层返回 503 时，审批结果未知且旧选项失效', async () => {
    rig.replies.fn = (_owner, request) => request.kind === 'approve'
      ? { status: 503, body: { ok: false, code: 'bridge/unavailable' } }
      : ok(approvalBody())
    registerWorkbenchActivityOwner(OWNER_A)
    await readWorkbenchActivity()
    const snapshot = await approveWorkbenchActivity(approveRequest())
    expect(snapshot.connection).toBe('stale')
    expect(snapshot.error).toContain('unknown')
    expect(onlySession(snapshot)).toMatchObject({ stale: true, taskState: 'unknown', approvals: [] })
  })

  it('拒绝非法审批选项与缺失字段', async () => {
    rig.replies.fn = () => ok(approvalBody())
    registerWorkbenchActivityOwner(OWNER_A)
    await readWorkbenchActivity()
    rig.calls.length = 0
    const invalid = await approveWorkbenchActivity(
      approveRequest({ optionId: 'always' }) as unknown as ReturnType<typeof approveRequest>
    )
    expect(invalid.error).toBe('Invalid approval request')
    expect(rig.calls).toHaveLength(0)
  })
})

describe('工作台活动：操作文本还原', () => {
  it('只拼接同 callId 的完整 tool-call 文本', async () => {
    rig.replies.fn = () => ok(approvalBody({}, ['{"command":"rm -rf ', 'build"}']))
    registerWorkbenchActivityOwner(OWNER_A)
    const snapshot = await readWorkbenchActivity()
    expect(onlySession(snapshot).approvals[0]).toMatchObject({
      id: 'appr-1', toolName: 'Bash', callId: 'call-1', operation: '{"command":"rm -rf build"}'
    })
  })

  it('工具结果与其它调用不能冒充操作文本', async () => {
    rig.replies.fn = () => ok(approvalBody({
      transcript: [
        ...toolCallChunks('call-9', ['{"command":"ls"}']),
        { seq: 20, kind: 'tool-result', text: '{"command":"rm -rf build"}', at: 910, taskId: 'task-a', sessionId: 's1', callId: 'call-1' }
      ]
    }))
    registerWorkbenchActivityOwner(OWNER_A)
    const snapshot = await readWorkbenchActivity()
    expect(onlySession(snapshot).approvals[0].operation).toBeUndefined()
  })

  it('输出被截断时不提供操作文本', async () => {
    rig.replies.fn = () => ok(approvalBody({ transcriptTruncated: true }))
    registerWorkbenchActivityOwner(OWNER_A)
    const snapshot = await readWorkbenchActivity()
    const approval = onlySession(snapshot).approvals[0]
    expect(approval.operation).toBeUndefined()
    expect(approval.callId).toBe('call-1')
  })
  it('输出被截断时，即使直接调用 IPC 也不能允许一次；拒绝仍可显式操作', async () => {
    rig.replies.fn = () => ok(approvalBody({ transcriptTruncated: true }))
    registerWorkbenchActivityOwner(OWNER_A)
    await readWorkbenchActivity()
    rig.calls.length = 0
    const result = await approveWorkbenchActivity(approveRequest())
    expect(result.error).toContain('operation details are incomplete')
    expect(rig.calls.some(call => call.request.kind === 'approve')).toBe(false)
    await approveWorkbenchActivity(approveRequest({ optionId: 'rejected' }))
    expect(rig.calls.some(call => call.request.kind === 'approve')).toBe(true)
  })

  it('分块不连续或过长时不提供操作文本', async () => {
    const gapped = toolCallChunks('call-1', ['a', 'b']).map((entry, index) => ({ ...entry, seq: index === 1 ? 9 : entry.seq }))
    rig.replies.fn = () => ok(approvalBody({ transcript: gapped }))
    registerWorkbenchActivityOwner(OWNER_A)
    expect(onlySession(await readWorkbenchActivity()).approvals[0].operation).toBeUndefined()

    const oversized = Array.from({ length: 5 }, () => 'x'.repeat(1024))
    rig.replies.fn = () => ok(approvalBody({}, oversized))
    expect(onlySession(await readWorkbenchActivity()).approvals[0].operation).toBeUndefined()
  })

  it('审批缺少 callId 时不猜测操作文本', async () => {
    rig.replies.fn = () => ok(approvalBody({
      approvals: [{ id: 'appr-1', taskId: 'task-a', sessionId: 's1', toolName: 'Bash', reason: 'r', options: ['rejected'], askedAt: 3 }]
    }))
    registerWorkbenchActivityOwner(OWNER_A)
    const snapshot = await readWorkbenchActivity()
    const approval = onlySession(snapshot).approvals[0]
    expect(approval.operation).toBeUndefined()
    expect(approval.callId).toBeUndefined()
  })
})
