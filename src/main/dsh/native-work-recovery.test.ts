import { afterAll, describe, expect, it } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { persistentGlobalWorkOwner, readSavedWorkState } from './work-history'

type Data = Record<string, unknown>
interface View { taskId: string; acceptedTaskId: string; taskState: string; sessionId: string;
  duplicate?: boolean; accepted?: boolean; task: Data; approvals: Array<{ id: string }>; sessions: View[] }
interface Controller { request: (owner: string, request: Data) => Promise<View> }
interface Journal { save: (owner: string, data: unknown) => void; loadAll: () => unknown[] }
const root = mkdtempSync(join(tmpdir(), 'lyshell-recovery-'))
writeFileSync(join(root, 'loader.cjs'), 'module.exports = url => import(url)')
const importEsm = createRequire(import.meta.url)(join(root, 'loader.cjs')) as (url: string) => Promise<{
  createNativeWorkController: (ctx: unknown, identity: () => unknown, options: { journal: Journal }) => Controller
  openWorkJournal: (dir: string) => Journal
}>
const bridgeDirectory = join(process.cwd(), 'resources/dsh-bridge')
const bridgeModule = importEsm(pathToFileURL(join(bridgeDirectory, 'index.mjs')).href)
const journalModule = importEsm(pathToFileURL(join(bridgeDirectory, 'work-journal.mjs')).href)
const OWNER = 'a'.repeat(64), OTHER = 'b'.repeat(64)
afterAll(() => rmSync(root, { recursive: true, force: true }))

async function harness(directory: string, epoch: number, history: Data[] = [], journalOverride?: Journal) {
  const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>()
  const prompts: Data[] = [], agents = new Map<string, { session: { seq: number }; status: string }>()
  const controller = {
    create: async () => ({ sessionId: 'session-1' }),
    fork: async () => ({ sessionId: `continued-${epoch}-${prompts.length}` }),
    resolveAgent: async () => ({ agent: agents.get('session-1') ?? { session: { seq: 100 }, status: 'idle' } }),
    prompt: async (request: Data) => { prompts.push(request) },
    cancel: async (): Promise<void> => { throw new Error('unexpected cancel') }
  }
  const journal = journalOverride ?? (await journalModule).openWorkJournal(directory)
  const native = (await bridgeModule).createNativeWorkController({
    effect: (fn: () => unknown) => fn(),
    on: (name: string, fn: (...args: unknown[]) => unknown) => { hooks.set(name, [...hooks.get(name) ?? [], fn]); return () => {} },
    get: (name: string) => name === 'sessionQuery' ? { observeSession: async () => ({ header: { id: 'session-1', cwd: process.cwd() }, events: history }) } : controller
  }, () => ({ instanceId: `backend-${epoch}`, instanceEpoch: epoch }), { journal })
  const request = (data: Data, owner = OWNER) => native.request(owner, data)
  const emit = (type: string, data: Data, seq: number, sessionId = 'session-1') => {
    for (const fn of hooks.get('session/event') ?? []) fn({ id: sessionId }, { type, data, seq, time: Date.now() })
  }
  return { native, request, emit, prompts, journal, hooks, controller }
}

describe('原生任务跨进程恢复与副作用保护', () => {
  it('运行中日志失效仍允许停止原任务，同时拒绝派发新工作', async () => {
    let failed = false
    const journal: Journal = { save: () => { if (failed) throw new Error('disk unavailable') }, loadAll: () => [] }
    const f = await harness('unused', 1, [], journal)
    await f.request({ kind: 'new', workspace: process.cwd() })
    const receipt = await f.request({ kind: 'submit', sessionId: 'session-1', requestId: 'work', text: 'work' })
    f.emit('turn/start', { turn: 1 }, 101)
    const approval = f.hooks.get('approval/request')![0]({ agent: { session: { id: 'session-1' } }, toolName: 'write', callId: 'call' }, () => 'cancelled')
    const approvalId = (await f.request({ kind: 'state' })).approvals[0].id
    failed = true
    f.emit('tool/call', { callId: 'call', name: 'write', arguments: '{}' }, 102)
    await expect(f.request({ kind: 'submit', sessionId: 'session-1', requestId: 'new', text: 'must not run' }))
      .rejects.toMatchObject({ code: 'journal/unavailable' })
    await expect(f.request({ kind: 'approve', id: approvalId, optionId: 'allowed-once' }))
      .rejects.toMatchObject({ code: 'journal/unavailable' })
    await f.request({ kind: 'approve', id: approvalId, optionId: 'rejected' })
    expect(await approval).toBe('rejected')
    f.controller.cancel = async () => { f.emit('turn/end', { turn: 1, reason: { kind: 'aborted' } }, 103) }
    expect(await f.request({ kind: 'cancel', taskId: receipt.taskId })).toMatchObject({ taskState: 'cancelled' })
    expect(f.prompts).toHaveLength(1)
  })
  it('淘汰旧 attempt 时保留同一逻辑任务当前 attempt 的精确查询索引', async () => {
    const values = new Map<string, unknown>()
    const journal: Journal = { save: (owner, value) => { values.set(owner, structuredClone(value)) },
      loadAll: () => [...values].map(([owner, value]) => ({ owner, value: structuredClone(value) })) }
    const first = await harness('unused', 1, [], journal)
    await first.request({ kind: 'new', workspace: process.cwd() })
    const original = await first.request({ kind: 'submit', sessionId: 'session-1', requestId: 'original', text: 'work' })
    first.emit('turn/start', { turn: 1 }, 101)
    const second = await harness('unused', 2, [
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } }, seq: 102 }
    ], journal)
    const resumed = await second.request({ kind: 'resume', sessionId: 'session-1', taskId: original.taskId, requestId: 'resume', text: 'finish checked work' })
    second.emit('turn/start', { turn: 2 }, 101, String(resumed.task.executionSessionId))
    second.emit('turn/end', { turn: 2, reason: { kind: 'completed' } }, 102, String(resumed.task.executionSessionId))
    second.controller.create = async () => ({ sessionId: 'session-other' })
    await second.request({ kind: 'new', workspace: process.cwd() })
    for (let index = 0; index < 255; index++) {
      await second.request({ kind: 'submit', sessionId: 'session-other', requestId: `fill-${index}`, text: 'once' })
      second.emit('turn/start', { turn: 1 }, 101, 'session-other')
      second.emit('turn/end', { turn: 1, reason: { kind: 'completed' } }, 102, 'session-other')
    }
    expect(await second.request({ kind: 'state', taskId: original.taskId })).toMatchObject({
      taskState: 'completed', task: { attemptId: resumed.task.attemptId }
    })
  })
  it('完整请求记录淘汰后保留持久去重摘要，重启仍不重复执行', async () => {
    const values = new Map<string, unknown>()
    const journal: Journal = { save: (owner, value) => { values.set(owner, structuredClone(value)) },
      loadAll: () => [...values].map(([owner, value]) => ({ owner, value: structuredClone(value) })) }
    const first = await harness('unused-memory-fixture', 1, [], journal)
    await first.request({ kind: 'new', workspace: process.cwd() })
    for (let index = 0; index < 258; index++) {
      await first.request({ kind: 'submit', sessionId: 'session-1', requestId: `request-${index}`, text: 'once',
        ...(index === 0 ? { idempotencyKey: 'first-key' } : {}) })
      if (index === 0) await first.request({ kind: 'submit', sessionId: 'session-1', requestId: 'alias-first', text: 'once', idempotencyKey: 'first-key' })
      first.emit('turn/start', { turn: 1 }, 101); first.emit('turn/end', { turn: 1, reason: { kind: 'completed' } }, 102)
    }
    const second = await harness('unused-memory-fixture', 2, [], journal)
    expect(await second.request({ kind: 'submit', sessionId: 'session-1', requestId: 'request-0', text: 'once' })).toMatchObject({ duplicate: true, taskState: 'completed' })
    expect(await second.request({ kind: 'submit', sessionId: 'session-1', requestId: 'alias-first', text: 'once' })).toMatchObject({ duplicate: true, taskState: 'completed' })
    expect(second.prompts).toEqual([])
    await expect(second.request({ kind: 'submit', sessionId: 'session-1', requestId: 'request-0', text: 'different' })).rejects.toMatchObject({ code: 'bad-request' })
    await expect(second.request({ kind: 'submit', sessionId: 'session-1', requestId: 'alias-first', text: 'different' })).rejects.toMatchObject({ code: 'bad-request' })
  })

  it('未知任务的重试 requestId 持久关联原记录，重启后省略键仍不能再次派发', async () => {
    const directory = join(root, 'alias-restart')
    const first = await harness(directory, 1)
    await first.request({ kind: 'new', workspace: process.cwd() })
    const original = await first.request({ kind: 'submit', sessionId: 'session-1', requestId: 'original', text: 'once', idempotencyKey: 'K' })
    await first.request({ kind: 'submit', sessionId: 'session-1', requestId: 'alias', text: 'once', idempotencyKey: 'K' })
    const second = await harness(directory, 2)
    expect(await second.request({ kind: 'submit', sessionId: 'session-1', requestId: 'alias', text: 'once' }))
      .toMatchObject({ duplicate: true, taskId: original.taskId, taskState: 'unconfirmed' })
    await expect(second.request({ kind: 'submit', sessionId: 'session-1', requestId: 'alias', text: 'changed' }))
      .rejects.toMatchObject({ code: 'bad-request' })
    expect(second.prompts).toEqual([])
  })
  it('重建后保留身份/进度/请求指纹；不自动 prompt，旧凭据和旧审批不能接管', async () => {
    const directory = join(root, 'restart')
    const first = await harness(directory, 1)
    await first.request({ kind: 'new', workspace: process.cwd() })
    const receipt = await first.request({ kind: 'submit', sessionId: 'session-1', requestId: 'request-1', text: 'execute once' })
    first.emit('turn/start', { turn: 8 }, 101)
    first.emit('tool/call', { callId: 'call', name: 'write', arguments: 'changed-file' }, 102)
    const recovered = await harness(directory, 2)
    const state = await recovered.request({ kind: 'state', taskId: receipt.taskId })
    expect(state).toMatchObject({ taskId: receipt.taskId, taskState: 'unconfirmed', task: { recoveryRequired: true, executionIdentity: { instanceId: 'backend-1' } }, approvals: [] })
    const duplicate = await recovered.request({ kind: 'submit', sessionId: 'session-1', requestId: 'request-1', text: 'execute once' })
    expect(duplicate.duplicate).toBe(true)
    expect(recovered.prompts).toEqual([])
    await expect(recovered.request({ kind: 'state', taskId: receipt.taskId }, OTHER)).rejects.toMatchObject({ code: 'task/not-found' })
    await expect(recovered.request({ kind: 'approve', id: 'old-approval', optionId: 'allowed-once' })).rejects.toMatchObject({ code: 'approval/not-pending' })
    await expect(recovered.request({ kind: 'submit', sessionId: 'session-1', requestId: 'request-new', text: 'blind retry' })).rejects.toMatchObject({ code: 'task/busy' })
    const resumed = await recovered.request({ kind: 'resume', sessionId: 'session-1', taskId: receipt.taskId, requestId: 'resume-1', text: 'I verified the file; finish remaining work only' })
    expect(resumed.taskId).toBe(receipt.taskId)
    expect(resumed.task.attemptId).not.toBe(receipt.task.attemptId)
    expect(resumed.task.attempt).toBe(2)
    expect(resumed.task.executionSessionId).toBe('continued-2-0')
    expect((await recovered.request({ kind: 'resume', sessionId: 'session-1', taskId: receipt.taskId, requestId: 'resume-1', text: 'I verified the file; finish remaining work only' })).duplicate).toBe(true)
    expect(recovered.prompts).toHaveLength(1)
  })

  it('只用官方持久化的同一回合终态恢复 completed，忽略其他回合', async () => {
    const directory = join(root, 'terminal')
    const first = await harness(directory, 1)
    await first.request({ kind: 'new', workspace: process.cwd() })
    const receipt = await first.request({ kind: 'submit', sessionId: 'session-1', requestId: 'request', text: 'work' })
    first.emit('turn/start', { turn: 7 }, 101)
    const history = [{ type: 'turn/end', data: { turn: 88, reason: { kind: 'completed' } }, seq: 102 }]
    const second = await harness(directory, 2, history)
    expect((await second.request({ kind: 'state', taskId: receipt.taskId })).taskState).toBe('unconfirmed')
    history.push({ type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } }, seq: 103 })
    expect((await second.request({ kind: 'state', taskId: receipt.taskId })).taskState).toBe('completed')
    expect(second.prompts).toEqual([])
    const third = await harness(directory, 3)
    expect((await third.request({ kind: 'state', taskId: receipt.taskId })).taskState).toBe('completed')
  })

  it('磁盘写失败先于 dispatch，损坏日志不回落为空任务', async () => {
    const directory = join(root, 'broken'), first = await harness(directory, 1)
    await first.request({ kind: 'new', workspace: process.cwd() })
    mkdirSync(join(directory, `${OWNER}.json.block`))
    // 事务目标变成目录：模拟持久化不可用，不能发模型或工具。
    const original = readFileSync(join(directory, `${OWNER}.json`))
    rmSync(join(directory, `${OWNER}.json`)); mkdirSync(join(directory, `${OWNER}.json`))
    await expect(first.request({ kind: 'submit', sessionId: 'session-1', requestId: 'x', text: 'must not dispatch' })).rejects.toMatchObject({ code: 'journal/unavailable' })
    expect(first.prompts).toEqual([])
    rmSync(join(directory, `${OWNER}.json`), { recursive: true })
    writeFileSync(join(directory, `${OWNER}.json`), original)
    appendFileSync(join(directory, `${OWNER}.json`), 'corruption')
    await expect(harness(directory, 2)).rejects.toMatchObject({ code: 'journal/corrupt' })
  })

  it('真实进程执行副作用后被强杀，重建与重复请求不会再次执行', async () => {
    const directory = join(root, 'killed'), marker = join(root, 'side-effects.txt')
    const worker = join(root, 'kill-worker.mjs')
    writeFileSync(worker, `import {createNativeWorkController} from ${JSON.stringify(pathToFileURL(join(bridgeDirectory, 'index.mjs')).href)};
import {openWorkJournal} from ${JSON.stringify(pathToFileURL(join(bridgeDirectory, 'work-journal.mjs')).href)};
import {appendFileSync} from 'node:fs';
const c={create:async()=>({sessionId:'session-1'}),resolveAgent:async()=>({agent:{session:{seq:0},status:'idle'}}),prompt:async()=>{appendFileSync(${JSON.stringify(marker)},'once\\n');process.kill(process.pid,'SIGKILL')}};
const n=createNativeWorkController({effect:f=>f(),on:()=>()=>{},get:()=>c},()=>({instanceId:'crashed',instanceEpoch:1}),{journal:openWorkJournal(${JSON.stringify(directory)})});
await n.request('${OWNER}',{kind:'new',workspace:${JSON.stringify(process.cwd())}});
await n.request('${OWNER}',{kind:'submit',sessionId:'session-1',requestId:'once',text:'side effect'});`)
    const killed = spawnSync(process.execPath, [worker], { timeout: 10000, windowsHide: true })
    expect(killed.status).not.toBe(0)
    expect(readFileSync(marker, 'utf8')).toBe('once\n')
    const recovered = await harness(directory, 2)
    const result = await recovered.request({ kind: 'submit', sessionId: 'session-1', requestId: 'once', text: 'side effect' })
    expect(result).toMatchObject({ duplicate: true, taskState: 'unconfirmed' })
    expect(recovered.prompts).toEqual([])
    expect(readFileSync(marker, 'utf8')).toBe('once\n')
  })

  it('全局身份不依赖轮换 token，离线读取可保留任务且无启动动作', async () => {
    const userData = join(root, 'offline'); mkdirSync(userData)
    expect(persistentGlobalWorkOwner(userData)).toBe(persistentGlobalWorkOwner(userData))
    const first = await harness(join(userData, 'harness-work', 'c'.repeat(64)), 1)
    await first.request({ kind: 'new', workspace: process.cwd() })
    const receipt = await first.request({ kind: 'submit', sessionId: 'session-1', requestId: 'saved', text: 'work' })
    const state = await readSavedWorkState(userData, bridgeDirectory, OWNER, { kind: 'state', taskId: receipt.taskId })
    expect(state).toMatchObject({ status: 'offline', taskId: receipt.taskId, taskState: 'unconfirmed', approvals: [], identity: null,
      // 离线保留最后确认的提交/执行事实，而不是用 unconfirmed 覆盖它。
      task: { state: 'unconfirmed', lastConfirmedState: 'accepted' } })
    expect(await readSavedWorkState(userData, bridgeDirectory, OTHER, { kind: 'state' })).toBeNull()
    first.emit('turn/start', { turn: 1 }, 101)
    first.emit('turn/end', { turn: 1, reason: { kind: 'completed' } }, 102)
    await first.request({ kind: 'disconnect' })
    expect(await readSavedWorkState(userData, bridgeDirectory, OWNER, { kind: 'state' }))
      .toMatchObject({ sessionId: null, selectedSessionId: null, taskId: receipt.taskId, taskState: 'completed' })
  })

  it('取消先持久化意图；官方 cancel 回执没有 turn/end 不释放名额', async () => {
    const directory = join(root, 'cancel-intent')
    const f = await harness(directory, 1)
    await f.request({ kind: 'new', workspace: process.cwd() })
    const receipt = await f.request({ kind: 'submit', sessionId: 'session-1', requestId: 'run', text: 'work' })
    f.emit('turn/start', { turn: 1 }, 101)
    let intentPersisted = false
    f.controller.cancel = async () => {
      // 官方 cancel 被调用时，取消意图必须已经在磁盘上。
      const saved = JSON.parse(readFileSync(join(directory, `${OWNER}.json`), 'utf8')) as {
        value: { records: Array<{ task: Record<string, unknown> }> } }
      intentPersisted = saved.value.records.some(record =>
        record.task.taskId === receipt.taskId && typeof record.task.cancelRequestedAt === 'number')
    }
    const view = await f.request({ kind: 'cancel', taskId: receipt.taskId })
    expect(intentPersisted).toBe(true)
    expect(view).toMatchObject({ taskState: 'running', task: { cancelRequestedAt: expect.any(Number) } })
    // 回执成功但没有权威终态：名额仍被占用，不能被当成已取消。
    await expect(f.request({ kind: 'submit', sessionId: 'session-1', requestId: 'next', text: 'next' }))
      .rejects.toMatchObject({ code: 'task/busy' })
    f.emit('turn/end', { turn: 1, reason: { kind: 'aborted' } }, 102)
    expect((await f.request({ kind: 'state', taskId: receipt.taskId })).taskState).toBe('cancelled')
    expect((await f.request({ kind: 'submit', sessionId: 'session-1', requestId: 'next', text: 'next' })))
      .toMatchObject({ accepted: true })
    expect(f.prompts).toHaveLength(2)
  })

  it('恢复视图区分提交/观测/最后确认状态，同键重放不重发且迟到进度不回退终态', async () => {
    const directory = join(root, 'metadata')
    const first = await harness(directory, 1)
    await first.request({ kind: 'new', workspace: process.cwd() })
    const receipt = await first.request({ kind: 'submit', sessionId: 'session-1', requestId: 'meta', text: 'work', idempotencyKey: 'M' })
    first.emit('turn/start', { turn: 1 }, 101)
    // 重启后只能通过官方冷读核对终态；内存中的活动表不跨进程恢复。
    const history: Data[] = []
    const second = await harness(directory, 2, history)
    expect(await second.request({ kind: 'state', taskId: receipt.taskId })).toMatchObject({
      taskState: 'unconfirmed',
      task: { submissionState: 'accepted', observationState: 'stale', lastConfirmedState: 'running', attempt: 1 }
    })
    const replay = await second.request({ kind: 'submit', sessionId: 'session-1', requestId: 'meta-retry', text: 'work', idempotencyKey: 'M' })
    expect(replay).toMatchObject({ duplicate: true, accepted: true, acceptedTaskId: receipt.taskId })
    expect(second.prompts).toEqual([])
    history.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, seq: 102 })
    expect((await second.request({ kind: 'state', taskId: receipt.taskId })).taskState).toBe('completed')
    // 迟到的 turn/start 不能把已确认终态改回运行中。
    second.emit('turn/start', { turn: 2 }, 103)
    expect(await second.request({ kind: 'state', taskId: receipt.taskId })).toMatchObject({
      taskState: 'completed', task: { submissionState: 'accepted', lastConfirmedState: 'completed' }
    })
  })

  it('显式幂等键在请求记录退役并重启后仍去重，同键不同参拒绝', async () => {
    const values = new Map<string, unknown>()
    const journal: Journal = { save: (owner, value) => { values.set(owner, structuredClone(value)) },
      loadAll: () => [...values].map(([owner, value]) => ({ owner, value: structuredClone(value) })) }
    const first = await harness('unused-key-retire', 1, [], journal)
    await first.request({ kind: 'new', workspace: process.cwd() })
    await first.request({ kind: 'submit', sessionId: 'session-1', requestId: 'keyed-0', text: 'once', idempotencyKey: 'K' })
    first.emit('turn/start', { turn: 1 }, 101); first.emit('turn/end', { turn: 1, reason: { kind: 'completed' } }, 102)
    for (let index = 0; index < 258; index++) {
      await first.request({ kind: 'submit', sessionId: 'session-1', requestId: `fill-${index}`, text: 'once' })
      first.emit('turn/start', { turn: 1 }, 101); first.emit('turn/end', { turn: 1, reason: { kind: 'completed' } }, 102)
    }
    const second = await harness('unused-key-retire', 2, [], journal)
    expect(await second.request({ kind: 'submit', sessionId: 'session-1', requestId: 'keyed-new', text: 'once', idempotencyKey: 'K' }))
      .toMatchObject({ duplicate: true, taskState: 'completed', acceptedTaskId: expect.any(String) })
    expect(second.prompts).toEqual([])
    await expect(second.request({ kind: 'submit', sessionId: 'session-1', requestId: 'keyed-other', text: 'changed', idempotencyKey: 'K' }))
      .rejects.toMatchObject({ code: 'bad-request' })
  })

  it('别名达到持久预算后拒绝新增关联，已有请求仍可去重', async () => {
    let saved: Data | undefined
    const journal: Journal = { save: (_owner, value) => { saved = structuredClone(value) as Data },
      loadAll: () => saved ? [{ owner: OWNER, value: structuredClone(saved) }] : [] }
    const first = await harness('unused-alias-budget', 1, [], journal)
    await first.request({ kind: 'new', workspace: process.cwd() })
    const receipt = await first.request({ kind: 'submit', sessionId: 'session-1', requestId: 'canonical', text: 'once', idempotencyKey: 'K' })
    first.emit('turn/start', { turn: 1 }, 101)
    first.emit('turn/end', { turn: 1, reason: { kind: 'completed' } }, 102)
    saved!.aliases = Array.from({ length: 10000 }, (_, index) => [`alias-${index}`, 'canonical'])
    const second = await harness('unused-alias-budget', 2, [], journal)
    expect(await second.request({ kind: 'submit', sessionId: 'session-1', requestId: 'alias-0', text: 'once' }))
      .toMatchObject({ duplicate: true, acceptedTaskId: receipt.taskId })
    await expect(second.request({ kind: 'submit', sessionId: 'session-1', requestId: 'new-alias', text: 'once', idempotencyKey: 'K' }))
      .rejects.toMatchObject({ code: 'journal/capacity' })
    expect(second.prompts).toEqual([])
  })

  it.each([
    [['alias', 'missing']],
    [['canonical', 'canonical']],
    [['alias', 'canonical'], ['alias', 'canonical']],
    [['alias', 'canonical', 'extra']]
  ])('持久别名损坏时 fail closed：%j', async (...aliases) => {
    let saved: Data | undefined
    const journal: Journal = { save: (_owner, value) => { saved = structuredClone(value) as Data },
      loadAll: () => saved ? [{ owner: OWNER, value: structuredClone(saved) }] : [] }
    const first = await harness('unused-alias-invalid', 1, [], journal)
    await first.request({ kind: 'new', workspace: process.cwd() })
    await first.request({ kind: 'submit', sessionId: 'session-1', requestId: 'canonical', text: 'once', idempotencyKey: 'K' })
    saved!.aliases = aliases
    await expect(harness('unused-alias-invalid', 2, [], journal)).rejects.toThrow('journal/invalid-state')
  })

  it('旧记录缺少新增字段仍可读，未来 schema 版本 fail closed', async () => {
    const attemptId = 'legacy-attempt', taskId = 'legacy-task'
    const legacy = { schema: 1, sessionId: 'session-1', lastTask: attemptId,
      sessions: [{ sessionId: 'session-1', workspace: process.cwd(), executionSessionId: 'session-1', current: attemptId }],
      records: [{ task: { taskId, sessionId: 'session-1', state: 'running', acceptedAt: 1, requestId: 'legacy',
        attemptId, executionSessionId: 'session-1' }, digest: createHash('sha256').update('same text').digest('hex'), accepted: true,
        floor: 100, eventSeq: 101, turn: 1, seq: 0, transcript: [], truncated: false }],
      tasks: [[taskId, attemptId]], requests: [['legacy', attemptId]], retired: [] }
    const journal = { save: () => {}, loadAll: () => [{ owner: OWNER, value: legacy }] }
    const f = await harness('unused-legacy', 1, [], journal)
    // 旧记录没有提交/确认元数据：按 accepted 与恢复前的权威状态推导，而不是凭空降级。
    expect(await f.request({ kind: 'state', taskId })).toMatchObject({ taskState: 'unconfirmed',
      task: { submissionState: 'accepted', observationState: 'stale', lastConfirmedState: 'running' } })
    // 旧调用（未给键）继续按 requestId 去重，不重新执行。
    expect(await f.request({ kind: 'submit', sessionId: 'session-1', requestId: 'legacy', text: 'same text' }))
      .toMatchObject({ duplicate: true })
    expect(f.prompts).toEqual([])
    await expect(harness('unused-version', 1, [], { save: () => {}, loadAll: () => [{ owner: OWNER, value: { schema: 2 } }] }))
      .rejects.toThrow('journal/unsupported-version')
  })
})
