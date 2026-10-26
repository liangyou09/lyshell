import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import type { HarnessWebActivitySnapshot } from '@shared/harness-web-activity'

const temp = mkdtempSync(join(tmpdir(), 'lyshell-web-observer-'))
writeFileSync(join(temp, 'import.cjs'), 'module.exports = specifier => import(specifier)')
const importEsm = createRequire(import.meta.url)(join(temp, 'import.cjs')) as (path: string) => Promise<{ createWebActivityObserver: (ctx: unknown, identity: () => unknown, excluded: (id: string) => boolean) => { snapshot: () => HarnessWebActivitySnapshot; has: (id: string) => boolean } }>
const bridge = importEsm(pathToFileURL(join(process.cwd(), 'resources/dsh-bridge/index.mjs')).href)
afterAll(() => rmSync(temp, { recursive: true, force: true }))

async function harness() {
  let listener!: (session: unknown, event: unknown) => void
  const hooks: string[] = []
  const excluded = new Set<string>(['native', 'pet'])
  const mod = await bridge
  const observer = mod.createWebActivityObserver({
    effect: (run: () => unknown) => run(),
    on: (name: string, fn: typeof listener) => { hooks.push(name); listener = fn; return () => {} }
  }, () => ({ instanceId: 'backend-a', instanceEpoch: 1 }), id => excluded.has(id))
  const seq = new Map<string, number>()
  const emit = (sessionId: string, type: string, data: Record<string, unknown>, meta: Record<string, unknown> = {}) => {
    const next = (seq.get(sessionId) ?? -1) + 1
    seq.set(sessionId, next)
    listener({ id: sessionId, header: { cwd: process.cwd() }, ...meta }, { seq: next, type, data })
  }
  return { observer, hooks, emit, listener, excluded }
}

describe('官方 Web live 回合只读桥', () => {
  it('手动回合后自动任务在两次读取之间结束，也会撤销旧手动会话证据', async () => {
    const h = await harness()
    h.emit('manual', 'turn/start', { turn: 0 })
    h.emit('manual', 'approval/asked', { id: 'old-approval' })
    expect(h.observer.snapshot().sessions).toHaveLength(1)
    h.excluded.add('manual')
    h.emit('manual', 'turn/start', { turn: 1 })
    h.excluded.delete('manual')
    h.emit('manual', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(h.observer.snapshot()).toMatchObject({ sessions: [], events: [] })
    h.emit('manual', 'turn/start', { turn: 2 })
    expect(h.observer.snapshot().sessions).toMatchObject([{ state: 'running', approvalIds: [] }])
  })
  it('只登记已观察开始的回合，end同turn匹配，重复/旧事件不生成提醒', async () => {
    const h = await harness()
    h.emit('web', 'turn/end', { turn: 0, reason: { kind: 'completed' } })
    expect(h.observer.snapshot().events).toEqual([])
    h.emit('web', 'turn/start', { turn: 1 })
    h.emit('web', 'turn/end', { turn: 0, reason: { kind: 'completed' } })
    expect(h.observer.snapshot().sessions[0].state).toBe('running')
    h.emit('web', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    h.emit('web', 'turn/start', { turn: 1 })
    h.emit('web', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    h.listener({ id: 'web' }, { seq: 0, type: 'turn/start', data: { turn: 100 } })
    expect(h.observer.snapshot()).toMatchObject({ sessions: [{ state: 'turn-ended', turnId: '1:1' }], events: [{ kind: 'turn-ended' }] })
    expect(h.observer.snapshot().events).toHaveLength(1)
  })
  it('审批沿官方 asked/decided 配对；并行审批与撤销不会代答或影响别的会话', async () => {
    const h = await harness()
    expect(h.hooks).toEqual(['session/event'])
    h.emit('a', 'turn/start', { turn: 0 })
    h.emit('b', 'turn/start', { turn: 0 })
    h.emit('a', 'approval/asked', { id: 'approval-1', reason: 'secret command', toolName: 'secret tool' })
    h.emit('a', 'approval/asked', { id: 'approval-2' })
    h.emit('a', 'approval/decided', { id: 'wrong', outcome: 'allowed-once' })
    h.emit('a', 'approval/decided', { id: 'approval-1', outcome: 'rejected' })
    expect(h.observer.snapshot().sessions).toMatchObject([{ state: 'waiting-approval', approvalIds: ['approval-2'] }, { state: 'running', approvalIds: [] }])
    h.emit('a', 'approval/decided', { id: 'approval-2', outcome: 'cancelled' })
    expect(h.observer.snapshot().sessions[0]).toMatchObject({ state: 'running', approvalIds: [] })
    expect(JSON.stringify(h.observer.snapshot())).not.toContain('secret')
  })
  it('失败/中断按官方终态区分，终态清空审批且agent错误/进程退出不推测完成', async () => {
    const h = await harness()
    for (const [index, reason] of ['completed', 'error', 'aborted', 'interrupted', 'forked', 'unknown'].entries()) {
      h.emit('web', 'turn/start', { turn: index })
      h.emit('web', 'approval/asked', { id: `approval-${index}` })
      h.emit('web', 'turn/end', { turn: index, reason: { kind: reason } })
      expect(h.observer.snapshot().sessions[0].approvalIds).toEqual([])
    }
    expect(h.observer.snapshot().events.filter(e => e.kind !== 'approval').map(e => e.kind)).toEqual(['turn-ended', 'failed', 'interrupted', 'interrupted', 'interrupted', 'failed'])
  })
  it('排除native/Pet/子代理以及历史事件；只取官方header.cwd，缺失时不猜目录', async () => {
    const h = await harness()
    for (const id of ['native', 'pet']) h.emit(id, 'turn/start', { turn: 0 })
    h.emit('child', 'turn/start', { turn: 0 }, { header: { origin: 'subagent', cwd: process.cwd() } })
    h.emit('history', 'turn/start', { turn: 0 }, { firstLiveSeq: 100 })
    h.emit('missing', 'turn/start', { turn: 0 }, { header: {}, cwd: process.cwd() })
    expect(h.observer.snapshot().sessions).toMatchObject([{ sessionId: 'missing', workspace: '' }])
    expect(h.observer.has('native')).toBe(false)
    h.excluded.add('missing')
    expect(h.observer.has('missing')).toBe(false)
    expect(h.observer.snapshot().sessions).toEqual([])
  })
  it('会话和事件日志有界，返回快照不泄露可变内部引用', async () => {
    const h = await harness()
    for (let i = 0; i < 150; i++) {
      h.emit(`web-${i}`, 'turn/start', { turn: 0 })
      h.emit(`web-${i}`, 'turn/end', { turn: 0, reason: { kind: 'completed' } })
    }
    const snapshot = h.observer.snapshot()
    expect(snapshot.sessions).toHaveLength(128)
    expect(snapshot.events).toHaveLength(100)
    snapshot.sessions[0].approvalIds.push('forged')
    snapshot.events[0].kind = 'failed'
    expect(h.observer.snapshot().sessions[0].approvalIds).toEqual([])
    expect(h.observer.snapshot().events[0].kind).toBe('turn-ended')
  })
})
