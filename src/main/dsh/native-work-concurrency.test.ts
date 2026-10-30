import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

type Data = Record<string, unknown>
interface Transcript { sessionId: string; text: string }
interface Approval { id: string; taskId: string; sessionId: string }
interface TaskView {
  sessionId: string; taskId: string; taskState: string; status: string
  approvals: Approval[]; transcript: Transcript[]; transcriptTruncated: boolean
}
interface Snapshot extends TaskView {
  revision: number
  task: Data
  identity: { instanceId: string; instanceEpoch: number }
  selectedSessionId: string | null; sessions: TaskView[]; activeTaskIds: string[]
  acceptedTaskId: string; accepted?: boolean; duplicate?: boolean
}
type Listener = (...args: unknown[]) => unknown
const temp = mkdtempSync(join(tmpdir(), 'lyshell-native-parallel-'))
writeFileSync(join(temp, 'import.cjs'), 'module.exports = specifier => import(specifier)')
const importEsm = createRequire(import.meta.url)(join(temp, 'import.cjs')) as (path: string) => Promise<{
  createNativeWorkController: (ctx: unknown, identity: () => unknown) => { request: (owner: string, request: Data) => Promise<Snapshot>; isActive: (sessionId: string) => boolean }
}>
const bridge = importEsm(pathToFileURL(join(process.cwd(), 'resources/dsh-bridge/index.mjs')).href)
afterAll(() => rmSync(temp, { recursive: true, force: true }))
const OWNER = 'a'.repeat(64), OTHER = 'b'.repeat(64)

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function harness(options: { prompt?: (sessionId: string) => Promise<void>; resolve?: (sessionId: string) => Promise<void>; epoch?: number } = {}) {
  const hooks = new Map<string, Listener[]>()
  const cleanups: Array<() => void> = []
  const agents = new Map<string, { session: { seq: number }; status: string }>()
  const prompts: string[] = [], cancels: string[] = []
  let next = 0
  const controller = (await bridge).createNativeWorkController({
    effect: (run: () => unknown) => { const dispose = run(); if (typeof dispose === 'function') cleanups.push(dispose as () => void) },
    on: (name: string, listener: Listener) => { hooks.set(name, [...hooks.get(name) ?? [], listener]); return () => {} },
    get: () => ({
      create: async () => { const sessionId = `s${++next}`; agents.set(sessionId, { session: { seq: 0 }, status: 'idle' }); return { sessionId } },
      resolveAgent: async (sessionId: string) => { await options.resolve?.(sessionId); return { agent: agents.get(sessionId) } },
      prompt: async ({ sessionId }: { sessionId: string }) => { prompts.push(sessionId); await options.prompt?.(sessionId); return { accepted: true } },
      cancel: async ({ sessionId }: { sessionId: string }) => { cancels.push(sessionId) }
    })
  }, () => ({ instanceId: `instance-${options.epoch ?? 1}`, instanceEpoch: options.epoch ?? 1 }))
  const request = (input: Data, owner = OWNER) => controller.request(owner, input)
  const state = (sessionId?: string, taskId?: string) => request({ kind: 'state', ...(sessionId ? { sessionId } : {}), ...(taskId ? { taskId } : {}) })
  const create = async (owner = OWNER) => (await request({ kind: 'new', workspace: process.cwd() }, owner)).sessionId as string
  const submit = (sessionId: string, requestId = sessionId, owner = OWNER) => request({ kind: 'submit', sessionId, requestId, text: `task ${requestId}` }, owner)
  const emit = (sessionId: string, type: string, data: Data) => {
    const agent = agents.get(sessionId)!
    agent.session.seq++
    if (type === 'turn/start') agent.status = 'running'
    if (type === 'turn/end') agent.status = 'idle'
    for (const hook of hooks.get('session/event') ?? []) hook({ id: sessionId }, { seq: agent.session.seq, type, data })
  }
  const start = (sessionId: string, turn = 1) => emit(sessionId, 'turn/start', { turn })
  const end = (sessionId: string, turn = 1, kind = 'completed') => emit(sessionId, 'turn/end', { turn, reason: { kind } })
  const approval = (sessionId: string, callId = 'same-call') => hooks.get('approval/request')![0]({
    agent: { session: { id: sessionId } }, toolName: 'pwsh', callId, reason: 'fixture'
  }, () => 'not-native') as Promise<string>
  return { request, state, create, submit, emit, start, end, approval, prompts, cancels, agents,
    dispose: () => cleanups.reverse().forEach(run => run()), controller }
}

describe('原生同凭据多会话并行', () => {
  it('全凭据快照 revision 随生成顺序递增，精确读和重复请求也共享此序列', async () => {
    const h = await harness()
    try {
      const a = await h.create()
      const receipt = await h.submit(a)
      const read = await h.state(a)
      const duplicate = await h.submit(a)
      expect(receipt.revision).toBeGreaterThan(0)
      expect(read.revision).toBeGreaterThan(receipt.revision)
      expect(duplicate.revision).toBeGreaterThan(read.revision)
      expect(duplicate.acceptedTaskId).toBe(receipt.acceptedTaskId)
    } finally { h.dispose() }
  })
  it('慢解析不阻塞另一会话；同会话忙态立即拒绝，读/新建/切换不改变任务归属', async () => {
    const blocked = deferred(), entered = deferred()
    const h = await harness({ resolve: async id => { if (id === 's1') { entered.resolve(); await blocked.promise } } })
    try {
      const a = await h.create(), b = await h.create()
      const first = h.submit(a)
      await entered.promise
      const second = await h.submit(b)
      expect(second).toMatchObject({ sessionId: b, accepted: true })
      await expect(h.submit(a, 'another')).rejects.toMatchObject({ code: 'task/busy' })
      await expect(h.request({ kind: 'disconnect' })).rejects.toMatchObject({ code: 'task/busy' })
      const c = await h.create()
      expect((await h.state()).sessionId).toBe(c)
      await h.request({ kind: 'select', sessionId: b })
      blocked.resolve()
      const receipt = await first
      expect(receipt.sessionId).toBe(a)
      expect(receipt.selectedSessionId).toBe(b)
      expect((await h.state()).taskId).toBe(second.acceptedTaskId)
      expect((await h.state(undefined, receipt.acceptedTaskId)).sessionId).toBe(a)
      expect((await h.state()).sessions.map((row: TaskView) => row.taskState)).toEqual(['accepted', 'accepted', null])
      expect(h.prompts).toEqual([b, a])
    } finally { blocked.resolve(); h.dispose() }
  })

  it('并行审批按会话/任务/审批ID关联；拒绝和取消只影响目标会话', async () => {
    const h = await harness()
    try {
      const a = await h.create(), b = await h.create()
      const ta = (await h.submit(a)).acceptedTaskId, tb = (await h.submit(b)).acceptedTaskId
      h.start(a); h.start(b)
      for (const id of [a, b]) h.emit(id, 'tool/call', { name: 'pwsh', callId: 'same-call', arguments: `command-${id}` })
      const pa = h.approval(a), pb = h.approval(b)
      const aa = (await h.state(a)).approvals[0], ab = (await h.state(b)).approvals[0]
      expect(aa).toMatchObject({ sessionId: a, taskId: ta, callId: 'same-call' })
      expect(ab).toMatchObject({ sessionId: b, taskId: tb, callId: 'same-call' })
      await expect(h.request({ kind: 'approve', id: aa.id, sessionId: b, taskId: tb, optionId: 'rejected' })).rejects.toMatchObject({ code: 'approval/not-pending' })
      await expect(h.request({ kind: 'approve', id: aa.id, optionId: 'rejected' }, OTHER)).rejects.toMatchObject({ code: 'approval/not-pending' })
      await expect(h.request({ kind: 'cancel', sessionId: b, taskId: ta })).rejects.toMatchObject({ code: 'task/not-found' })
      await h.request({ kind: 'cancel', sessionId: a, taskId: ta })
      expect(await pa).toBe('cancelled')
      expect(h.cancels).toEqual([a])
      expect((await h.state(b)).approvals).toEqual([ab])
      expect((await h.state(a)).taskState).toBe('running')
      h.end(a, 1, 'aborted')
      await h.request({ kind: 'approve', id: ab.id, taskId: tb, sessionId: b, optionId: 'rejected' })
      expect(await pb).toBe('rejected')
      await expect(h.request({ kind: 'approve', id: ab.id, optionId: 'rejected' })).rejects.toMatchObject({ code: 'approval/not-pending' })
      expect((await h.state(b)).transcript[0].text).toBe(`command-${b}`)
      h.end(b)
      expect((await h.state(a)).taskState).toBe('cancelled')
      expect((await h.state(b)).taskState).toBe('completed')
    } finally { h.dispose() }
  })

  it('凭据隔离覆盖精确读取、提交、停止和会话切换；不存在回退到默认会话', async () => {
    const h = await harness()
    try {
      const a = await h.create(), b = await h.create(OTHER)
      const receipt = await h.submit(a)
      h.start(a)
      for (const input of [{ kind: 'state', sessionId: a }, { kind: 'state', taskId: receipt.acceptedTaskId },
        { kind: 'select', sessionId: a }, { kind: 'cancel', taskId: receipt.acceptedTaskId },
        { kind: 'submit', sessionId: a, requestId: 'other', text: 'wrong' }]) {
        await expect(h.request(input, OTHER)).rejects.toMatchObject({ code: 'task/not-found' })
      }
      await expect(h.state(b, receipt.acceptedTaskId)).rejects.toMatchObject({ code: 'task/not-found' })
      expect((await h.request({ kind: 'targets' }, OTHER)).sessions.map((row: TaskView) => row.sessionId)).toEqual([b])
      expect(h.cancels).toEqual([])
      expect(h.prompts).toEqual([a])
    } finally { h.dispose() }
  })

  it('requestId 在凭据内去重且不能跨会话重用；旧请求始终返回自己的结果', async () => {
    const blocked = deferred(), entered = deferred()
    const h = await harness({ resolve: async id => { if (id === 's1') { entered.resolve(); await blocked.promise } } })
    try {
      const a = await h.create(), b = await h.create()
      const first = h.submit(a, 'shared')
      await entered.promise
      const duplicate = h.submit(a, 'shared')
      await expect(h.submit(b, 'shared')).rejects.toMatchObject({ code: 'bad-request' })
      blocked.resolve()
      const [one, two] = await Promise.all([first, duplicate])
      expect(two).toMatchObject({ duplicate: true, acceptedTaskId: one.acceptedTaskId })
      h.start(a); h.end(a)
      const next = await h.submit(a, 'next')
      const old = await h.submit(a, 'shared')
      expect(old).toMatchObject({ taskId: one.acceptedTaskId, acceptedTaskId: one.acceptedTaskId, taskState: 'completed' })
      expect(old.sessions[0].taskId).toBe(next.acceptedTaskId)
      expect((await h.state(undefined, one.acceptedTaskId)).taskState).toBe('completed')
      expect(h.prompts).toEqual([a, a])
    } finally { blocked.resolve(); h.dispose() }
  })

  it('一个提交结果未知不封锁其他会话，也不能被断开/重发伪装为完成', async () => {
    const h = await harness({ prompt: async id => { if (id === 's1') throw Error('transport lost') } })
    try {
      const a = await h.create(), b = await h.create()
      await expect(h.submit(a)).rejects.toMatchObject({ code: 'bridge/unavailable' })
      const unknown = await h.state(a)
      expect(unknown).toMatchObject({ taskState: 'unconfirmed', status: 'error' })
      expect(await h.submit(a)).toMatchObject({ accepted: false, duplicate: true, acceptedTaskId: unknown.taskId })
      await h.submit(b)
      await expect(h.request({ kind: 'cancel', taskId: unknown.taskId })).rejects.toMatchObject({ code: 'task/busy' })
      await expect(h.request({ kind: 'disconnect' })).rejects.toMatchObject({ code: 'task/busy' })
      h.start(b); h.end(b)
      expect((await h.state(a)).taskState).toBe('unconfirmed')
      h.start(a); h.end(a)
      expect((await h.state(undefined, unknown.taskId)).taskState).toBe('completed')
      expect((await h.submit(a)).accepted).toBe(true)
      expect(h.prompts).toEqual([a, b])
    } finally { h.dispose() }
  })

  it('prompt 回执挂起时另一会话与本任务的审批/取消仍可进行', async () => {
    const blocked = deferred(), entered = deferred()
    const h = await harness({ prompt: async id => { if (id === 's1') { entered.resolve(); await blocked.promise } } })
    try {
      const a = await h.create(), b = await h.create()
      const inFlight = h.submit(a)
      await entered.promise
      h.start(a)
      const taskId = (await h.state(a)).taskId
      const approval = h.approval(a)
      await h.submit(b)
      await h.request({ kind: 'cancel', taskId })
      expect(await approval).toBe('cancelled')
      h.end(a, 1, 'aborted')
      blocked.resolve()
      expect(await inFlight).toMatchObject({ taskState: 'cancelled', acceptedTaskId: taskId })
      expect((await h.state(b)).taskState).toBe('accepted')
    } finally { blocked.resolve(); h.dispose() }
  })

  it('输出总量有界，分会话返回且不会串流；旧回合 end 不能终结当前任务', async () => {
    const h = await harness()
    try {
      const a = await h.create(), b = await h.create()
      await h.submit(a); await h.submit(b); h.start(a); h.start(b)
      for (let i = 0; i < 150; i++) for (const id of [a, b]) {
        h.emit(id, 'assistant/message', { message: { content: [{ type: 'text', text: `${id}-${i}` }] } })
      }
      const all = await h.state()
      expect(all.sessions.reduce((n, row) => n + row.transcript.length, 0)).toBe(256)
      for (const row of all.sessions) {
        expect(row.transcript.every((entry: Transcript) => entry.sessionId === row.sessionId && entry.text.startsWith(row.sessionId))).toBe(true)
        expect(row.transcriptTruncated).toBe(true)
      }
      h.end(a, 7)
      expect((await h.state(a)).taskState).toBe('running')
      h.end(a)
      expect((await h.state(a)).taskState).toBe('completed')
      expect((await h.state(b)).taskState).toBe('running')
    } finally { h.dispose() }
  })

  it('后台换代丢失原生控制权，旧任务/审批不会作用于新实例；清理不推测完成', async () => {
    const old = await harness(), fresh = await harness({ epoch: 2 })
    try {
      const a = await old.create(), b = await old.create()
      const task = await old.submit(a); await old.submit(b); old.start(a); old.start(b)
      const approval = old.approval(a), id = (await old.state(a)).approvals[0].id
      old.dispose()
      expect(await approval).toBe('cancelled')
      expect((await old.state(a)).taskState).toBe('running')
      expect(await fresh.state()).toMatchObject({ identity: { instanceEpoch: 2 }, sessions: [], taskId: null })
      await expect(fresh.state(undefined, task.acceptedTaskId)).rejects.toMatchObject({ code: 'task/not-found' })
      await expect(fresh.request({ kind: 'approve', id, optionId: 'rejected' })).rejects.toMatchObject({ code: 'approval/not-pending' })
      await expect(fresh.request({ kind: 'cancel', taskId: task.acceptedTaskId })).rejects.toMatchObject({ code: 'task/not-found' })
    } finally { fresh.dispose() }
  })

  it('缓存淘汰只移除终态请求，保留活动任务去重和其精确定位', async () => {
    const h = await harness()
    try {
      const a = await h.create(), b = await h.create()
      const active = await h.submit(a)
      let first: Snapshot | undefined
      for (let i = 0; i < 260; i++) {
        const receipt = await h.submit(b, `r${i}`)
        first ??= receipt
        h.start(b, i); h.end(b, i)
      }
      expect(await h.submit(a)).toMatchObject({ duplicate: true, acceptedTaskId: active.acceptedTaskId })
      expect((await h.state(undefined, active.acceptedTaskId)).taskState).toBe('accepted')
      await expect(h.state(undefined, first!.acceptedTaskId)).rejects.toMatchObject({ code: 'task/not-found' })
      expect(h.prompts).toHaveLength(261)
    } finally { h.dispose() }
  })

  it('requestId 淘汰后仍保留会话最新任务，直到该会话被下一任务替换', async () => {
    const h = await harness()
    try {
      const a = await h.create(), b = await h.create()
      const latestA = await h.submit(a, 'reused-after-eviction')
      h.start(a); h.end(a)
      for (let i = 0; i < 257; i++) { await h.submit(b, `evict-${i}`); h.start(b, i); h.end(b, i) }
      expect((await h.state(a, latestA.acceptedTaskId)).taskState).toBe('completed')
      // 过期 ID 被另一会话复用后，也不能让旧任务在 tasks 缓存永久残留。
      await h.submit(b, 'reused-after-eviction'); h.start(b, 258); h.end(b, 258)
      await h.submit(a, 'replace-latest')
      await expect(h.state(undefined, latestA.acceptedTaskId)).rejects.toMatchObject({ code: 'task/not-found' })
    } finally { h.dispose() }
  })

  it('每凭据会话数有界，容量不会通过并发 new 突破，也不影响其他凭据', async () => {
    const h = await harness()
    try {
      const results = await Promise.allSettled(Array.from({ length: 65 }, () => h.create()))
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(64)
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
      expect((await h.request({ kind: 'targets' })).sessions).toHaveLength(64)
      expect(await h.create(OTHER)).toBeTruthy()
      expect((await h.request({ kind: 'targets' }, OTHER)).sessions).toHaveLength(1)
    } finally { h.dispose() }
  })
})

describe('原生工作幂等键与状态契约', () => {
  it('幂等键不能绕过另一个提交已占用的 requestId', async () => {
    const h = await harness()
    try {
      const a = await h.create(), b = await h.create()
      await h.request({ kind: 'submit', sessionId: a, requestId: 'r1', text: 'first', idempotencyKey: 'K1' })
      await h.request({ kind: 'submit', sessionId: b, requestId: 'r2', text: 'second', idempotencyKey: 'K2' })
      await expect(h.request({ kind: 'submit', sessionId: b, requestId: 'r1', text: 'second', idempotencyKey: 'K2' }))
        .rejects.toMatchObject({ code: 'bad-request' })
      expect(h.prompts).toHaveLength(2)
    } finally { h.dispose() }
  })

  it('同键重试的新 requestId 也须永久关联原提交，省略键不能重放或换正文', async () => {
    const h = await harness()
    try {
      const a = await h.create()
      const first = await h.request({ kind: 'submit', sessionId: a, requestId: 'original', text: 'same', idempotencyKey: 'K' })
      await h.request({ kind: 'submit', sessionId: a, requestId: 'alias', text: 'same', idempotencyKey: 'K' })
      h.start(a); h.end(a)
      await expect(h.request({ kind: 'submit', sessionId: a, requestId: 'alias', text: 'changed' }))
        .rejects.toMatchObject({ code: 'bad-request' })
      expect(await h.request({ kind: 'submit', sessionId: a, requestId: 'alias', text: 'same' }))
        .toMatchObject({ duplicate: true, acceptedTaskId: first.acceptedTaskId })
      expect(h.prompts).toHaveLength(1)
    } finally { h.dispose() }
  })

  it('同键并发重试在原提交解析期间也立即占用其 requestId', async () => {
    const blocked = deferred(), entered = deferred()
    const h = await harness({ resolve: async id => { if (id === 's1') { entered.resolve(); await blocked.promise } } })
    try {
      const a = await h.create(), b = await h.create()
      const first = h.request({ kind: 'submit', sessionId: a, requestId: 'original', text: 'same', idempotencyKey: 'K' })
      await entered.promise
      const duplicate = h.request({ kind: 'submit', sessionId: a, requestId: 'alias', text: 'same', idempotencyKey: 'K' })
      await expect(h.request({ kind: 'submit', sessionId: b, requestId: 'alias', text: 'changed' }))
        .rejects.toMatchObject({ code: 'bad-request' })
      blocked.resolve()
      await Promise.all([first, duplicate])
      expect(h.prompts).toEqual([a])
    } finally { blocked.resolve(); h.dispose() }
  })

  it('同键同参不同 requestId 只 prompt 一次；正文/会话/模式冲突拒绝', async () => {
    const h = await harness()
    try {
      const a = await h.create(), b = await h.create()
      const first = await h.request({ kind: 'submit', sessionId: a, requestId: 'r1', text: 'same', idempotencyKey: 'K' })
      const second = await h.request({ kind: 'submit', sessionId: a, requestId: 'r2', text: 'same', idempotencyKey: 'K' })
      expect(second).toMatchObject({ duplicate: true, accepted: true, acceptedTaskId: first.acceptedTaskId })
      expect(h.prompts).toEqual([a])
      await expect(h.request({ kind: 'submit', sessionId: a, requestId: 'r3', text: 'changed', idempotencyKey: 'K' }))
        .rejects.toMatchObject({ code: 'bad-request' })
      // 同一文本但不同 API 会话仍是不同参数。
      await expect(h.request({ kind: 'submit', sessionId: b, requestId: 'r4', text: 'same', idempotencyKey: 'K' }))
        .rejects.toMatchObject({ code: 'bad-request' })
      h.start(a); h.end(a)
      // submit 键不能复用为 resume（操作模式属于参数）。
      await expect(h.request({ kind: 'resume', sessionId: a, taskId: first.acceptedTaskId, requestId: 'r5', text: 'same', idempotencyKey: 'K' }))
        .rejects.toMatchObject({ code: 'bad-request' })
      expect(h.prompts).toEqual([a])
    } finally { h.dispose() }
  })

  it('同键并发重试等待同一提交，不重复 prompt', async () => {
    const blocked = deferred(), entered = deferred()
    const h = await harness({ resolve: async id => { if (id === 's1') { entered.resolve(); await blocked.promise } } })
    try {
      const a = await h.create()
      const first = h.request({ kind: 'submit', sessionId: a, requestId: 'r1', text: 'x', idempotencyKey: 'K' })
      await entered.promise
      const second = h.request({ kind: 'submit', sessionId: a, requestId: 'r2', text: 'x', idempotencyKey: 'K' })
      blocked.resolve()
      const [one, two] = await Promise.all([first, second])
      expect(two).toMatchObject({ duplicate: true, acceptedTaskId: one.acceptedTaskId })
      expect(h.prompts).toEqual([a])
    } finally { blocked.resolve(); h.dispose() }
  })

  it('提交结果未知时同键重放返回原记录，旧 requestId 行为不变', async () => {
    const h = await harness({ prompt: async () => { throw new Error('receipt lost') } })
    try {
      const a = await h.create()
      await expect(h.request({ kind: 'submit', sessionId: a, requestId: 'r1', text: 'x', idempotencyKey: 'K' }))
        .rejects.toMatchObject({ code: 'bridge/unavailable' })
      const unknown = await h.state(a)
      expect(unknown).toMatchObject({ taskState: 'unconfirmed',
        task: { submissionState: 'unknown', observationState: 'stale', lastConfirmedState: null } })
      // 已占用但结果未知：同键重放只返回原记录，不能再执行一次。
      expect(await h.request({ kind: 'submit', sessionId: a, requestId: 'r2', text: 'x', idempotencyKey: 'K' }))
        .toMatchObject({ duplicate: true, accepted: false, taskState: 'unconfirmed' })
      // 未提供键的旧调用继续按 requestId 去重。
      expect(await h.request({ kind: 'submit', sessionId: a, requestId: 'r1', text: 'x' }))
        .toMatchObject({ duplicate: true, accepted: false })
      expect(h.prompts).toHaveLength(1)
    } finally { h.dispose() }
  })

  it('终态不被迟到进度回退，旧审批不能用于新任务', async () => {
    const h = await harness()
    try {
      const a = await h.create()
      const receipt = await h.submit(a, 'once')
      h.start(a, 1)
      const pendingApproval = h.approval(a)
      const approvalId = (await h.state(a)).approvals[0].id
      h.end(a, 1, 'completed')
      expect(await pendingApproval).toBe('cancelled')
      await expect(h.request({ kind: 'approve', id: approvalId, optionId: 'allowed-once' }))
        .rejects.toMatchObject({ code: 'approval/not-pending' })
      // 终态之后到达的普通进度与回合开始都必须被忽略。
      h.start(a, 2)
      h.emit(a, 'assistant/message', { message: { content: [{ type: 'text', text: 'late progress' }] } })
      const after = await h.state(undefined, receipt.acceptedTaskId)
      expect(after).toMatchObject({ taskState: 'completed',
        task: { submissionState: 'accepted', observationState: 'live', lastConfirmedState: 'completed' } })
      expect(after.transcript).toEqual([])
      // 新任务可以用自己的 requestId 正常执行；旧终态不影响名额。
      h.agents.get(a)!.status = 'idle'
      const next = await h.submit(a, 'next')
      expect(next).toMatchObject({ accepted: true, taskState: 'accepted' })
      expect(h.prompts).toEqual([a, a])
    } finally { h.dispose() }
  })

  it('审批超时自动取消，迟到的批准不能作用于任务', async () => {
    vi.useFakeTimers()
    const h = await harness()
    try {
      const a = await h.create()
      await h.submit(a)
      h.start(a)
      const pending = h.approval(a)
      const id = (await h.state(a)).approvals[0].id
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
      expect(await pending).toBe('cancelled')
      expect((await h.state(a)).approvals).toEqual([])
      await expect(h.request({ kind: 'approve', id, optionId: 'allowed-once' }))
        .rejects.toMatchObject({ code: 'approval/not-pending' })
      expect((await h.state(a)).taskState).toBe('running')
    } finally { h.dispose(); vi.useRealTimers() }
  })
})
