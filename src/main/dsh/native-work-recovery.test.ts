import { afterAll, describe, expect, it } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
      await first.request({ kind: 'submit', sessionId: 'session-1', requestId: `request-${index}`, text: 'once' })
      first.emit('turn/start', { turn: 1 }, 101); first.emit('turn/end', { turn: 1, reason: { kind: 'completed' } }, 102)
    }
    const second = await harness('unused-memory-fixture', 2, [], journal)
    expect(await second.request({ kind: 'submit', sessionId: 'session-1', requestId: 'request-0', text: 'once' })).toMatchObject({ duplicate: true, taskState: 'completed' })
    expect(second.prompts).toEqual([])
    await expect(second.request({ kind: 'submit', sessionId: 'session-1', requestId: 'request-0', text: 'different' })).rejects.toMatchObject({ code: 'bad-request' })
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
    expect(state).toMatchObject({ status: 'offline', taskId: receipt.taskId, taskState: 'unconfirmed', approvals: [], identity: null })
    expect(await readSavedWorkState(userData, bridgeDirectory, OTHER, { kind: 'state' })).toBeNull()
    first.emit('turn/start', { turn: 1 }, 101)
    first.emit('turn/end', { turn: 1, reason: { kind: 'completed' } }, 102)
    await first.request({ kind: 'disconnect' })
    expect(await readSavedWorkState(userData, bridgeDirectory, OWNER, { kind: 'state' }))
      .toMatchObject({ sessionId: null, selectedSessionId: null, taskId: receipt.taskId, taskState: 'completed' })
  })
})
