import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HarnessWorkspace } from '@shared/harness'
import { DEFAULT_THEME_DARK } from '@shared/constants'
import { ConnectionType, type SessionConfig, type TerminalConfig } from '@shared/types/session'
import type { TuiActivitySession } from '@shared/tui-activity'
import type { TaskShelfEntry, TaskShelfResult } from '@shared/task-shelf'
import { createTaskShelfService, type ShelfAgentKind, type ShelfSessionView, type ShelfSpawnResult, type TaskShelfDeps, type TaskShelfService } from './task-shelf'

describe('Codex 集成边界', () => {
  it('移除回收项只删除记录，不探测或重新附着旧宿主，也不更改运行资源的保留状态', async () => {
    const probe = vi.fn().mockRejectedValue(new Error('old host unavailable'))
    const restore = vi.fn()
    const retain = vi.fn()
    const f = setup({ localHost: { probe, restore }, retainSession: retain })
    f.state.sessions.set('unsaved', { alive: true, config: sessionConfig({ type: ConnectionType.LOCAL, local: { cwd: dir } }), localHostId: '01234567-89ab-cdef-0123-456789abcdef' })
    const [entry] = f.service.recycleUnsavedTerminals(['unsaved'])
    f.state.sessions.clear()
    expect(await f.service.request({ kind: 'remove', id: entry.id })).toMatchObject({ success: true, entries: [] })
    expect(probe).not.toHaveBeenCalled()
    expect(restore).not.toHaveBeenCalled()
    expect(retain).not.toHaveBeenCalled()
    expect(f.state.spawns).toHaveLength(0)
    expect(f.state.connects).toHaveLength(0)
  })
  it('退出仅回收登记的未保存终端，保留安全目录信息且不执行命令或保活', () => {
    const retain = vi.fn()
    const f = setup({ retainSession: retain })
    f.state.sessions.set('open', { alive: true, config: sessionConfig({ type: ConnectionType.LOCAL, local: { cwd: dir, env: { PRIVATE_TOKEN: 'secret-value' } }, startupCommands: ['old-business-command'] }), cwd: join(dir, 'current') })
    f.state.sessions.set('closed', { alive: true, config: sessionConfig({ type: ConnectionType.LOCAL, local: { cwd: dir } }) })
    f.state.sessions.set('plugin', { alive: true, config: sessionConfig({ type: ConnectionType.LOCAL, ownerPluginId: 'plugin', local: { cwd: dir } }) })
    const entries = f.service.recycleUnsavedTerminals(['open', 'open', 'plugin', 'missing'])
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ resourceKey: 'terminal:open', trashedAt: 1000, recovery: { cwd: join(dir, 'current') } })
    expect(entries[0].archivedAt).toBeUndefined()
    const stored = readFileSync(join(dir, 'task-shelf.json'), 'utf8')
    expect(stored).not.toContain('secret-value')
    expect(stored).not.toContain('old-business-command')
    expect(f.state.spawns).toHaveLength(0)
    expect(f.state.connects).toHaveLength(0)
    expect(retain).not.toHaveBeenCalled()
  })
  it('退出不重复回收已保存或归档的原实例，重复退出幂等', async () => {
    const f = setup()
    for (const id of ['saved', 'archived', 'unsaved']) f.state.sessions.set(id, { alive: true, config: sessionConfig({ type: ConnectionType.LOCAL, local: { cwd: dir } }) })
    await f.service.request({ kind: 'capture', resource: { kind: 'terminal', id: 'saved' } })
    const archived = entryOf(await f.service.request({ kind: 'capture', resource: { kind: 'terminal', id: 'archived' } }))
    await f.service.request({ kind: 'archive', id: archived.id, archived: true })
    f.service.recycleUnsavedTerminals(['saved', 'archived', 'unsaved'])
    const revision = f.repository.getRevision()
    f.service.recycleUnsavedTerminals(['saved', 'archived', 'unsaved'])
    expect(f.repository.getRevision()).toBe(revision)
    expect(f.repository.list().filter(entry => entry.trashedAt).map(entry => entry.resourceKey)).toEqual(['terminal:unsaved'])
    f.repository.archiveAll(2000)
    expect(f.repository.list().filter(entry => entry.trashedAt)).toHaveLength(1)
    expect(f.repository.get(archived.id)?.archivedAt).toBe(1000)
  })
  it('同一退出批次优先保留最近创建的十二个页签，不依赖分屏遍历顺序', () => {
    const f = setup()
    for (let index = 0; index < 14; index++) f.state.sessions.set(`t${index}`, { alive: true, config: sessionConfig({ type: ConnectionType.LOCAL, createdAt: new Date(index + 1), local: { cwd: dir } }) })
    const ids = Array.from({ length: 14 }, (_, index) => `t${13 - index}`)
    f.service.recycleUnsavedTerminals(ids)
    expect(f.repository.list().map(entry => entry.resourceKey)).toEqual(Array.from({ length: 12 }, (_, index) => `terminal:t${index + 2}`))
    const revision = f.repository.getRevision()
    f.service.recycleUnsavedTerminals(ids)
    expect(f.repository.getRevision()).toBe(revision)
    expect(f.repository.list().map(entry => entry.resourceKey)).toEqual(Array.from({ length: 12 }, (_, index) => `terminal:t${index + 2}`))
  })
  it('回收记录必须先激活；分类不启动，之后显式打开按原目录新建普通终端', async () => {
    const f = setup()
    f.state.sessions.set('open', { alive: true, config: sessionConfig({ type: ConnectionType.LOCAL, local: { cwd: dir }, startupCommands: ['do-not-replay'] }) })
    const [entry] = f.service.recycleUnsavedTerminals(['open'])
    f.state.sessions.clear()
    expect(await f.service.request({ kind: 'restore', id: entry.id })).toMatchObject({ success: false, error: expect.stringContaining('先激活') })
    expect(f.state.spawns).toHaveLength(0)
    const list = await f.service.request({ kind: 'list' })
    if (!list.success || !list.startup) throw new Error('Expected startup')
    expect(await f.service.request({ kind: 'activate', bootId: list.startup.bootId, scopeId: list.startup.scopeId, requestId: 'trash-activation', items: [{ taskId: entry.id, expectedRevision: entry.revision }] })).toMatchObject({ success: true, activation: { moved: 1 } })
    expect(f.state.spawns).toHaveLength(0)
    expect(await f.service.request({ kind: 'restore', id: entry.id })).toMatchObject({ success: true })
    expect(f.state.spawns[0]).toMatchObject({ command: undefined, opts: { cwd: dir } })
    expect(f.repository.get(entry.id)?.trashedAt).toBeUndefined()
  })
  it('退出回收落盘失败整体保留原记录并向退出流程报告错误', () => {
    const f = setup()
    f.state.sessions.set('one', { alive: true, config: sessionConfig({ type: ConnectionType.LOCAL, local: { cwd: dir } }) })
    f.service.recycleUnsavedTerminals(['one'])
    const before = readFileSync(join(dir, 'task-shelf.json'), 'utf8')
    f.state.sessions.set('two', { alive: true, config: sessionConfig({ type: ConnectionType.LOCAL, local: { cwd: dir } }) })
    disk.failWrite = true
    expect(() => f.service.recycleUnsavedTerminals(['one', 'two'])).toThrow()
    expect(readFileSync(join(dir, 'task-shelf.json'), 'utf8')).toBe(before)
    expect(f.repository.list()).toHaveLength(1)
  })
  it('首次请求先补归档上次 Tasks，本次新收纳的任务不受后续读取影响', async () => {
    const { service, repository, state } = setup({ archiveOnStart: true, seedRepository: repository => { repository.capture({ resourceKey: 'web:old', title: 'Previous task', capability: 'web', recovery: { kind: 'web', url: 'https://example.org/' } }, 10) } })
    const previous = repository.list()[0]
    const listed = await service.request({ kind: 'list' })
    expect(listed).toMatchObject({ success: true, entries: [{ id: previous.id, archivedAt: 1000 }] })
    const current = entryOf(await service.request({ kind: 'capture', resource: { kind: 'web', id: 'current', title: 'New task', url: 'https://example.com/' } }))
    await service.request({ kind: 'list' })
    expect(repository.get(current.id)?.archivedAt).toBeUndefined()
    expect(state.spawns).toHaveLength(0)
    expect(state.connects).toHaveLength(0)
  })
  it('启动补归档写盘失败保留真实分类，显式权威重试后归档', async () => {
    const { service, repository } = setup({ archiveOnStart: true, seedRepository: repository => { repository.capture({ resourceKey: 'web:old', title: 'Previous task', capability: 'web', recovery: { kind: 'web', url: 'https://example.org/' } }, 10) }, beforeCreate: () => { disk.failWrite = true } })
    const previous = repository.list()[0]
    const blocked = await service.request({ kind: 'list' })
    expect(blocked).toMatchObject({ success: true, startup: { status: 'blocked' } })
    expect(repository.get(previous.id)?.archivedAt).toBeUndefined()
    disk.failWrite = false
    if (!blocked.success || !blocked.startup) throw Error('Expected startup')
    await service.request({ kind: 'retryInitialization', bootId: blocked.startup.bootId, scopeId: blocked.startup.scopeId })
    expect(await service.request({ kind: 'list' })).toMatchObject({ success: true, entries: [{ id: previous.id, archivedAt: 1000 }] })
  })
  it.each([true, false])('SSH 恢复先准备历史，重复打开不再注入；原运行记录存在=%s', async sameRuntime => {
    const order: string[] = []
    const f = setup({
      retainSession: async (_id, _retained, history) => { if (history) order.push('history:' + history) },
      connectSession: async id => { order.push('connect'); f.state.sessions.get(id)!.alive = true }
    })
    f.state.saved.set('saved', sessionConfig({ id: 'saved' }))
    f.state.sessions.set('t1', { alive: true, config: sessionConfig({ originSavedSessionId: 'saved' }), output: 'saved output' })
    const saved = entryOf(await f.service.request({ kind: 'capture', resource: { kind: 'terminal', id: 't1' } }))
    f.state.sessions.get('t1')!.alive = false
    if (!sameRuntime) f.state.sessions.clear()
    order.length = 0
    expect(await f.service.request({ kind: 'restore', id: saved.id })).toMatchObject({ success: true })
    expect(order).toEqual(['history:saved output', 'connect'])
    expect(await f.service.request({ kind: 'restore', id: saved.id })).toMatchObject({ success: true })
    expect(order).toEqual(['history:saved output', 'connect'])
  })
  it('SSH 无法识别目录仍可重连，旧上下文在输出暂不可读时保留且不重复写盘', async () => {
    const { service, state } = setup()
    state.saved.set('saved', sessionConfig({ id: 'saved', startupCommands: ['business-command'] }))
    state.sessions.set('t1', { alive: true, config: sessionConfig({ originSavedSessionId: 'saved' }), cwd: '/srv/current', output: 'result 1\nresult 2' })
    const saved = entryOf(await service.request({ kind: 'capture', resource: { kind: 'terminal', id: 't1' } }))
    const live = state.sessions.get('t1')!; live.output = ''; live.cwd = undefined; live.alive = false
    const again = entryOf(await service.request({ kind: 'capture', entryId: saved.id, resource: { kind: 'terminal', id: 't1' } }))
    expect(again.context).toEqual(saved.context)
    expect(again.revision).toBe(saved.revision)
    state.sessions.clear()
    expect(await service.request({ kind: 'restore', id: saved.id })).toMatchObject({ success: true })
    expect(state.created[0].startupCommands).toBeUndefined()
    expect(state.created[0].ssh?.resumeDirectory).toBe('/srv/current')
  })
  it('未上报目录的 SSH 只重连，不猜提示符，也不引入 Telnet 上下文', async () => {
    const { service, state } = setup()
    state.saved.set('saved', sessionConfig({ id: 'saved' }))
    state.sessions.set('t1', { alive: true, config: sessionConfig({ originSavedSessionId: 'saved' }), output: 'user@host:/guess$' })
    const saved = entryOf(await service.request({ kind: 'capture', resource: { kind: 'terminal', id: 't1' } }))
    state.sessions.clear()
    expect(await service.request({ kind: 'restore', id: saved.id })).toMatchObject({ success: true })
    expect(state.created[0].ssh?.resumeDirectory).toBeUndefined()
    state.sessions.set('telnet', { alive: true, config: sessionConfig({ type: ConnectionType.TELNET, telnet: { host: 'device', port: 23 } }), cwd: '/ignored', output: 'unchanged telnet' })
    const telnet = entryOf(await service.request({ kind: 'capture', resource: { kind: 'terminal', id: 'telnet' } }))
    expect(telnet.context).toBeUndefined()
    expect(telnet.recovery).not.toHaveProperty('cwd')
  })
  it('Harness 记录官方会话与后端身份，暂时离线不抹掉已有引用', async () => {
    let online = true
    const identity = { instanceId: 'backend-original', instanceEpoch: 10 }
    const { service, repository } = setup({ harnessView: async () => online ? { recovery: { kind: 'harness', sessionId: 'official-session', taskId: 'official-task', identity, lastState: 'running' }, workspace: dir } : undefined })
    const saved = entryOf(await service.request({ kind: 'capture', resource: { kind: 'harness', id: '__dsh_web__' } }))
    expect(saved.recovery).toMatchObject({ sessionId: 'official-session', taskId: 'official-task', identity })
    online = false
    const again = entryOf(await service.request({ kind: 'capture', entryId: saved.id, resource: { kind: 'harness', id: '__dsh_web__' } }))
    expect(again.revision).toBe(saved.revision)
    expect(repository.get(saved.id)?.recovery).toEqual(saved.recovery)
    expect(await service.request({ kind: 'restore', id: saved.id })).toMatchObject({ restored: { kind: 'harness', sessionId: 'official-session', identity } })
  })
  it('SSH 只保存本地上下文和目录，重启恢复普通连接而不依赖 tmux', async () => {
    const { service, state, repository } = setup()
    state.saved.set('saved', sessionConfig({ id: 'saved' }))
    state.sessions.set('t1', { alive: true, config: sessionConfig({ originSavedSessionId: 'saved' }), tmuxSession: 'lyshell-unique', cwd: '/srv/a b', output: '\u001b[32mwork result\u001b[0m\r\n' })
    const saved = entryOf(await service.request({ kind: 'capture', resource: { kind: 'terminal', id: 't1' } }))
    expect(saved).toMatchObject({ capability: 'reconnect', recovery: { cwd: '/srv/a b', connectionKey: expect.any(String) }, context: { text: 'work result' } })
    expect(saved.recovery).not.toHaveProperty('tmuxSession')
    state.sessions.set('t1', { alive: false, config: sessionConfig({ originSavedSessionId: 'saved', ssh: { host: 'example.com', port: 22, username: 'me', keepSessionAlive: true, resumeSessionName: 'lyshell-unique' } }) })
    const disconnected = entryOf(await service.request({ kind: 'capture', entryId: saved.id, resource: { kind: 'terminal', id: 't1' } }))
    expect(disconnected).toMatchObject({ capability: 'reconnect', recovery: { cwd: '/srv/a b' }, context: { text: 'work result' } })
    expect(repository.get(saved.id)?.context).toEqual(saved.context)
    state.sessions.clear()
    expect(await service.request({ kind: 'restore', id: saved.id })).toMatchObject({ success: true })
    expect(state.created[0].ssh).toMatchObject({ keepSessionAlive: false, resumeDirectory: '/srv/a b' })
    expect(state.created[0].ssh?.resumeSessionName).toBeUndefined()
    expect(state.created[0].startupCommands).toBeUndefined()
  })
  it('保存本地终端当前目录，避免恢复到最初启动目录', async () => {
    const { service, state } = setup()
    state.sessions.set('t1', { alive: true, config: sessionConfig({ type: ConnectionType.LOCAL, local: { cwd: dir } }), cwd: join(dir, 'current') })
    const saved = entryOf(await service.request({ kind: 'capture', resource: { kind: 'terminal', id: 't1' } }))
    expect(saved.recovery).toMatchObject({ cwd: join(dir, 'current') })
  })
  it('保存配置改成另一台主机后拒绝重连，不创建新连接', async () => {
    const { service, state } = setup()
    state.saved.set('saved', sessionConfig({ id: 'saved' }))
    state.sessions.set('t1', { alive: true, config: sessionConfig({ originSavedSessionId: 'saved' }) })
    const saved = entryOf(await service.request({ kind: 'capture', resource: { kind: 'terminal', id: 't1' } }))
    state.sessions.clear()
    state.saved.set('saved', sessionConfig({ id: 'saved', ssh: { host: 'other.example', port: 22, username: 'me' } }))
    expect(await service.request({ kind: 'restore', id: saved.id })).toMatchObject({ success: false, error: expect.stringContaining('目标已变更') })
    expect(state.created).toHaveLength(0)
  })
  it('同步失败也释放恢复锁，修复后可重试', async () => {
    const { service, repository } = setup()
    const saved = entryOf(await service.request({ kind: 'capture', resource: { kind: 'web', id: 'web', title: 'Page', url: 'https://example.org/' } }))
    vi.spyOn(repository, 'get').mockReturnValueOnce(undefined)
    expect(await service.request({ kind: 'restore', id: saved.id })).toMatchObject({ success: false })
    expect(await service.request({ kind: 'restore', id: saved.id })).toMatchObject({ success: true, restored: { kind: 'web', url: 'https://example.org/' } })
  })
})
import { TaskShelfRepository } from '../storage/task-shelf-repository'

describe('本地独立宿主集成', () => {
  const hostId = 'a93bb4f0-0d44-44f8-8418-d7f479251728'
  const localConfig = () => sessionConfig({ type: ConnectionType.LOCAL, local: { cwd: dir, terminalHostId: hostId } })
  it('精确历史恢复的新宿主在返回前落盘，首个 CLI hook 到达前不丢已指定 ID', async () => {
    const { service, state, repository } = setup({ spawn: async (_name, _command, tags, opts) => {
      state.sessions.set('resumed', { alive: true, config: sessionConfig({ id: 'resumed', type: ConnectionType.LOCAL, tags, local: { cwd: opts.cwd, terminalHostId: hostId } }) })
      return { success: true, id: 'resumed' }
    } })
    state.sessions.set('t1', { alive: true, config: sessionConfig({ type: ConnectionType.LOCAL, tags: ['claude:a1'], local: { cwd: dir } }) })
    state.tuiRows = [tuiRow()]; state.workspaces.set('claude:a1', workspace('a1', dir))
    const saved = entryOf(await service.request({ kind: 'capture', resource: { kind: 'terminal', id: 't1' } }))
    state.sessions.clear(); state.tuiRows = []
    expect(await service.request({ kind: 'restore', id: saved.id })).toMatchObject({ success: true, restored: { kind: 'terminal', sessionId: 'resumed' } })
    expect(repository.get(saved.id)).toMatchObject({ resourceKey: 'terminal:resumed', capability: 'cli-resume', recovery: { localHostId: hostId, cliSessionId: 'cli-session-1' } })
    state.tuiRows = [tuiRow({ terminalId: 'resumed', cliSessionId: 'new-official-id' })]
    await service.request({ kind: 'capture', entryId: saved.id, resource: { kind: 'terminal', id: 'resumed' } })
    expect(repository.get(saved.id)?.recovery).toMatchObject({ cliSessionId: 'new-official-id' })
  })
  it('保留确认失败不落盘；写盘失败撤回本次保留', async () => {
    const retain = vi.fn().mockRejectedValueOnce(new Error('host unreachable')).mockResolvedValue(undefined)
    const { service, state, repository } = setup({ retainSession: retain })
    state.sessions.set('t1', { alive: true, config: localConfig() })
    expect(await service.request({ kind: 'capture', resource: { kind: 'terminal', id: 't1' } })).toMatchObject({ success: false })
    expect(repository.list()).toEqual([])
    disk.failWrite = true
    expect(await service.request({ kind: 'capture', resource: { kind: 'terminal', id: 't1' } })).toMatchObject({ success: false })
    expect(retain.mock.calls).toEqual([['t1', true], ['t1', true], ['t1', false]])
    expect(repository.list()).toEqual([])
  })
  it('只附着原宿主，并发打开只附着一次；探测失败不新建', async () => {
    const probe = vi.fn().mockResolvedValue({ running: true }), restore = vi.fn().mockResolvedValue({ success: true, id: 'restored' })
    const { service, state } = setup({ localHost: { probe, restore } })
    state.sessions.set('t1', { alive: true, config: localConfig() })
    const saved = entryOf(await service.request({ kind: 'capture', resource: { kind: 'terminal', id: 't1' } }))
    expect(saved.capability).toBe('local-live')
    state.sessions.clear()
    const results = await Promise.all([service.request({ kind: 'restore', id: saved.id }), service.request({ kind: 'restore', id: saved.id })])
    expect(results.every(r => r.success)).toBe(true)
    expect(restore).toHaveBeenCalledTimes(1)
    expect(restore).toHaveBeenCalledWith(hostId, saved.title, dir)
    probe.mockRejectedValueOnce(new Error('unreachable'))
    expect(await service.request({ kind: 'restore', id: saved.id })).toMatchObject({ success: false, error: 'unreachable' })
    expect(state.spawns).toEqual([])
  })
  it('普通本地宿主结束后在保存目录新建 shell', async () => {
    const restore = vi.fn()
    const { service, state } = setup({ localHost: { probe: async () => null, restore } })
    state.sessions.set('t1', { alive: true, config: localConfig() })
    const saved = entryOf(await service.request({ kind: 'capture', resource: { kind: 'terminal', id: 't1' } }))
    state.sessions.clear()
    expect(await service.request({ kind: 'restore', id: saved.id })).toMatchObject({ success: true, restored: { kind: 'terminal', sessionId: 'spawned-1' } })
    expect(restore).not.toHaveBeenCalled()
    expect(state.spawns).toEqual([{ name: saved.title, command: undefined, tags: [], opts: { cwd: dir, awaitConnection: true } }])
    state.sessions.set('spawned-1', { alive: true, config: { ...localConfig(), id: 'spawned-1' } })
    expect(await service.request({ kind: 'restore', id: saved.id })).toMatchObject({ success: true })
    expect(state.spawns).toHaveLength(1)
  })
  it.each(['dsh', 'claude', 'codex'] as const)('Agent 本地宿主结束后新建 shell，%s 不重跑旧任务', async kind => {
    const { service, state } = setup({ localHost: { probe: async () => ({ running: false }), restore: vi.fn() } })
    state.sessions.set('t1', { alive: true, config: { ...localConfig(), tags: [kind + ':a1'] } })
    const saved = entryOf(await service.request({ kind: 'capture', resource: { kind: 'terminal', id: 't1' } }))
    state.sessions.clear()
    expect(await service.request({ kind: 'restore', id: saved.id })).toMatchObject({ success: true })
    expect(state.spawns).toEqual([{ name: saved.title, command: undefined, tags: [], opts: { cwd: dir, awaitConnection: true } }])
    expect(state.launches).toEqual([])
  })
  it('CLI 原进程重接后保留身份，并将旧 hook 观察标记为最后已知信息', async () => {
    const { service, state, repository } = setup({ localHost: { probe: async () => ({ running: true }), restore: async () => ({ success: true, id: 'restored' }) } })
    state.sessions.set('t1', { alive: true, config: { ...localConfig(), tags: ['claude:a1'] } })
    state.tuiRows = [tuiRow()]
    const saved = entryOf(await service.request({ kind: 'capture', resource: { kind: 'terminal', id: 't1' } }))
    state.sessions.clear(); state.tuiRows = []
    expect(await service.request({ kind: 'restore', id: saved.id })).toMatchObject({ success: true })
    state.sessions.set('restored', { alive: true, config: { ...localConfig(), id: 'restored' } })
    const current = entryOf(await service.request({ kind: 'capture', entryId: saved.id, resource: { kind: 'terminal', id: 'restored' } }))
    expect(current).toMatchObject({ capability: 'local-live', recovery: { agentKind: 'claude', agentId: 'a1', cliSessionId: 'cli-session-1', cliObservationLost: true } })
    expect(new TaskShelfRepository(join(dir, 'task-shelf.json')).get(saved.id)).toEqual(repository.get(saved.id))
  })
  it('移除尚未展开的宿主时先接回运行实例，删除失败恢复保留标记', async () => {
    const retain = vi.fn().mockResolvedValue(undefined)
    const { service, state, repository } = setup({ retainSession: retain, localHost: { probe: async () => ({ running: true }), restore: async () => ({ success: true, id: 'restored' }) } })
    state.sessions.set('t1', { alive: true, config: localConfig() })
    const saved = entryOf(await service.request({ kind: 'capture', resource: { kind: 'terminal', id: 't1' } }))
    state.sessions.clear(); disk.failWrite = true
    expect(await service.request({ kind: 'remove', id: saved.id })).toMatchObject({ success: false })
    expect(retain.mock.calls.slice(-2)).toEqual([['restored', false], ['restored', true]])
    expect(repository.get(saved.id)).toBeTruthy()
    disk.failWrite = false
    expect(await service.request({ kind: 'remove', id: saved.id })).toMatchObject({ success: true, restored: { kind: 'terminal', sessionId: 'restored' } })
    expect(repository.list()).toEqual([])
  })
})

/** 仓储落盘走真实文件的 tmp+rename；这里只接住「写失败」开关，并统计真实写入次数。 */
const disk = vi.hoisted(() => ({ failWrite: false, writes: 0 }))

vi.mock('../storage/repository', async () => {
  const fs = await import('node:fs')
  return {
    getConfigDir: () => '.',
    atomicWriteFileSync: (filePath: string, data: string): void => {
      if (disk.failWrite) throw new Error('disk full')
      disk.writes += 1
      fs.writeFileSync(`${filePath}.tmp`, data, 'utf8')
      fs.renameSync(`${filePath}.tmp`, filePath)
    }
  }
})

interface SpawnCall {
  name: string
  command: string | undefined
  tags: string[]
  opts: { cwd?: string; env?: Record<string, string> }
}

interface ShelfTestState {
  sessions: Map<string, ShelfSessionView>
  saved: Map<string, SessionConfig>
  tuiRows: TuiActivitySession[]
  spawns: SpawnCall[]
  created: SessionConfig[]
  connects: string[]
  workspaces: Map<string, HarnessWorkspace>
  launches: string[]
  commands: Partial<Record<ShelfAgentKind, string>>
  env: Record<string, string> | undefined
  spawnResult: ShelfSpawnResult | undefined
  spawnGate: Promise<void> | undefined
}

interface ShelfTestHarness {
  service: TaskShelfService
  repository: TaskShelfRepository
  state: ShelfTestState
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lyshell-shelf-service-'))
  disk.failWrite = false
  disk.writes = 0
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function terminalConfig(): TerminalConfig {
  return {
    fontFamily: 'monospace',
    fontSize: 14,
    theme: DEFAULT_THEME_DARK,
    cursorStyle: 'block',
    cursorBlink: false,
    scrollback: 1000,
    encoding: 'utf-8'
  }
}

function sessionConfig(overrides: Partial<SessionConfig> = {}): SessionConfig {
  const base: SessionConfig = {
    id: 't1',
    name: '终端 1',
    type: ConnectionType.SSH,
    ssh: { host: 'example.com', port: 22, username: 'me' },
    terminal: terminalConfig(),
    tags: [],
    createdAt: new Date(0),
    updatedAt: new Date(0)
  }
  return { ...base, ...overrides }
}

function tuiRow(overrides: Partial<TuiActivitySession> = {}): TuiActivitySession {
  const base: TuiActivitySession = {
    terminalId: 't1',
    launchId: 'launch-1',
    source: 'claude',
    workspace: dir,
    cliSessionId: 'cli-session-1',
    turnId: null,
    state: 'idle',
    updatedAt: 0,
    event: null,
    active: true
  }
  return { ...base, ...overrides }
}

function workspace(id: string, cwd: string, extra: Partial<HarnessWorkspace> = {}): HarnessWorkspace {
  const base: HarnessWorkspace = { id, name: 'Claude', cwd, order: 0 }
  return { ...base, ...extra }
}

/** 断言捕获成功并取回记录：契约里 entry 是可选字段，测试里一律走这条断言。 */
function entryOf(result: TaskShelfResult): TaskShelfEntry {
  if (!result.success || !result.entry) {
    throw new Error(`expected captured entry, got: ${result.success ? 'missing entry' : result.error}`)
  }
  return result.entry
}

function entryIdOf(result: TaskShelfResult): string {
  return entryOf(result).id
}

function setup(options: { archiveOnStart?: boolean; commands?: Partial<Record<ShelfAgentKind, string>>; env?: Record<string, string>; harnessView?: TaskShelfDeps['harnessView']; localHost?: TaskShelfDeps['localHost']; retainSession?: TaskShelfDeps['retainSession']; spawn?: TaskShelfDeps['spawn']; connectSession?: TaskShelfDeps['connectSession']; startupArchiveEnabled?: boolean; seedRepository?: (repository: TaskShelfRepository) => void; beforeCreate?: () => void } = {}): ShelfTestHarness {
  const repository = new TaskShelfRepository(join(dir, 'task-shelf.json'))
  const state: ShelfTestState = {
    sessions: new Map<string, ShelfSessionView>(),
    saved: new Map<string, SessionConfig>(),
    tuiRows: [],
    spawns: [],
    created: [],
    connects: [],
    workspaces: new Map<string, HarnessWorkspace>(),
    launches: [],
    commands: { codex: 'codex --model gpt-5', claude: 'claude --permission-mode acceptEdits', dsh: 'dsh-tui', ...options.commands },
    env: options.env,
    spawnResult: undefined,
    spawnGate: undefined
  }

  const deps: TaskShelfDeps = {
    repository,
    archiveOnStart: options.archiveOnStart,
    session: id => state.sessions.get(id),
    createSession: async config => {
      state.created.push(config)
      state.sessions.set(config.id, { alive: false, config })
      return { id: config.id }
    },
    connectSession: options.connectSession ?? (async id => {
      state.connects.push(id)
      const live = state.sessions.get(id)
      if (live) live.alive = true
    }),
    savedSession: id => state.saved.get(id) ?? null,
    harnessView: options.harnessView,
    localHost: options.localHost,
    retainSession: options.retainSession,
    tui: () => ({ observedAt: 0, sessions: state.tuiRows, events: [] }),
    spawn: options.spawn ?? (async (name, command, tags, opts) => {
      state.spawns.push({ name, command, tags, opts })
      if (state.spawnGate) await state.spawnGate
      if (state.spawnResult) return state.spawnResult
      return { success: true, id: `spawned-${state.spawns.length}` }
    }),
    harness: {
      workspace: (kind, id) => state.workspaces.get(`${kind}:${id}`),
      launch: async (kind, target) => {
        state.launches.push(`${kind}:${target.id}`)
        const command = state.commands[kind]
        if (!command) return { ok: false, error: 'missing command' }
        return state.env ? { ok: true, command, env: state.env } : { ok: true, command }
      }
    },
    now: () => 1000
  }
  if (options.startupArchiveEnabled !== undefined) deps.startupArchiveEnabled = options.startupArchiveEnabled
  options.seedRepository?.(repository)
  options.beforeCreate?.()

  return { service: createTaskShelfService(deps), repository, state }
}

describe('任务保存区 capture', () => {
  it('只收纳当前仍运行的终端', async () => {
    const { service } = setup()
    const result = await service.request({ kind: 'capture', resource: { kind: 'terminal', id: 'gone' } })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toMatch(/该终端已不在运行/)
  })

  it('Claude 会话按可信 CLI 身份关联，且收纳不启动任何进程', async () => {
    const harness = setup()
    harness.state.sessions.set('t1', { alive: true, config: sessionConfig({ type: ConnectionType.LOCAL, local: { cwd: dir }, tags: ['claude:ws1'] }) })
    harness.state.tuiRows.push(tuiRow({ terminalId: 't1', source: 'claude', workspace: dir, cliSessionId: 'cli-session-1' }))

    const result = await harness.service.request({ kind: 'capture', resource: { kind: 'terminal', id: 't1' } })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.entry).toMatchObject({
      resourceKey: 'terminal:t1',
      title: '终端 1',
      workspace: dir,
      capability: 'cli-resume',
      revision: 1
    })
    expect(entryOf(result).recovery).toEqual({
      kind: 'terminal',
      sessionId: 't1',
      type: ConnectionType.LOCAL,
      cwd: dir,
      agentKind: 'claude',
      agentId: 'ws1',
      cliSessionId: 'cli-session-1'
    })
    expect(harness.state.spawns).toHaveLength(0)
    expect(harness.state.created).toHaveLength(0)
  })

  it('没有可信 CLI 会话 ID 时标记「需手动选择历史」', async () => {
    const harness = setup()
    harness.state.sessions.set('t1', { alive: true, config: sessionConfig({ type: ConnectionType.LOCAL, local: { cwd: dir }, tags: ['codex:ws1'] }) })
    harness.state.tuiRows.push(tuiRow({ terminalId: 't1', source: 'codex', cliSessionId: null }))

    const result = await harness.service.request({ kind: 'capture', resource: { kind: 'terminal', id: 't1' } })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(entryOf(result).capability).toBe('cli-history')
    expect(entryOf(result).recovery).not.toHaveProperty('cliSessionId')
  })

  it('本地目录终端记 directory，带启动命令的只记 live-only', async () => {
    const harness = setup()
    harness.state.sessions.set('plain', { alive: true, config: sessionConfig({ id: 'plain', name: '目录', type: ConnectionType.LOCAL, local: { cwd: dir } }) })
    harness.state.sessions.set('cmd', { alive: true, config: sessionConfig({ id: 'cmd', name: '命令', type: ConnectionType.LOCAL, local: { cwd: dir }, startupCommands: ['npm run dev'] }) })

    const plain = await harness.service.request({ kind: 'capture', resource: { kind: 'terminal', id: 'plain' } })
    const cmd = await harness.service.request({ kind: 'capture', resource: { kind: 'terminal', id: 'cmd' } })
    expect(entryOf(plain).capability).toBe('directory')
    expect(entryOf(cmd).capability).toBe('live-only')
    expect(readFileSync(join(dir, 'task-shelf.json'), 'utf8')).not.toContain('npm run dev')
  })

  it('普通远端只在有已保存连接引用时记 reconnect', async () => {
    const harness = setup()
    harness.state.sessions.set('saved', { alive: true, config: sessionConfig({ id: 'saved', originSavedSessionId: 'saved-1' }) })
    harness.state.sessions.set('adhoc', { alive: true, config: sessionConfig({ id: 'adhoc' }) })

    const saved = await harness.service.request({ kind: 'capture', resource: { kind: 'terminal', id: 'saved' } })
    const adhoc = await harness.service.request({ kind: 'capture', resource: { kind: 'terminal', id: 'adhoc' } })
    expect(entryOf(saved).capability).toBe('reconnect')
    expect(entryOf(saved).recovery).toMatchObject({ sessionConfigId: 'saved-1' })
    expect(entryOf(adhoc).capability).toBe('live-only')
  })

  it('web 安全地址可重放；POST 结果只记 live-only 且不落原 URL', async () => {
    const harness = setup()
    const safe = await harness.service.request({
      kind: 'capture',
      resource: { kind: 'web', id: 'w1', url: 'https://example.com/docs/guide', title: '  文档  ' }
    })
    expect(safe.success && safe.entry).toMatchObject({ title: '文档', capability: 'web', resourceKey: 'web:w1' })
    expect(entryOf(safe).recovery).toEqual({ kind: 'web', url: 'https://example.com/docs/guide' })

    const post = await harness.service.request({
      kind: 'capture',
      resource: { kind: 'web', id: 'w2', url: 'https://example.com/compose?draft=secret', title: '结果页', post: true }
    })
    expect(entryOf(post).capability).toBe('live-only')
    expect(entryOf(post).recovery).toEqual({ kind: 'web' })
    expect(readFileSync(join(dir, 'task-shelf.json'), 'utf8')).not.toContain('draft=secret')
    expect(readFileSync(join(dir, 'task-shelf.json'), 'utf8')).not.toContain('example.com/compose')
  })

  it('harness 只存固定类型与标题', async () => {
    const harness = setup()
    const captured = await harness.service.request({ kind: 'capture', resource: { kind: 'harness', id: 'dshWeb' } })
    expect(captured.success && captured.entry).toMatchObject({
      resourceKey: 'harness:dshWeb',
      title: 'DeepSeek Harness',
      capability: 'harness-history',
      recovery: { kind: 'harness' }
    })
    const restored = await harness.service.request({ kind: 'restore', id: entryIdOf(captured) })
    expect(restored.success && restored.restored).toEqual({ kind: 'harness' })
  })

  it('重复收纳同一实例保持同一条记录', async () => {
    const harness = setup()
    harness.state.sessions.set('t1', { alive: true, config: sessionConfig({ type: ConnectionType.LOCAL, local: { cwd: dir } }) })
    const first = await harness.service.request({ kind: 'capture', resource: { kind: 'terminal', id: 't1' } })
    const second = await harness.service.request({ kind: 'capture', resource: { kind: 'terminal', id: 't1' } })
    expect(entryOf(first).id).toBe(entryIdOf(second))
    expect(second.success && second.entries).toHaveLength(1)
    expect(entryOf(second).revision).toBe(1)
  })
})

describe('任务保存区 restore', () => {
  it('原运行实例仍活着时直接复用，不重复启动', async () => {
    const harness = setup()
    harness.state.sessions.set('t1', { alive: true, config: sessionConfig({ type: ConnectionType.LOCAL, local: { cwd: dir } }) })
    const captured = await harness.service.request({ kind: 'capture', resource: { kind: 'terminal', id: 't1' } })
    const restored = await harness.service.request({ kind: 'restore', id: entryIdOf(captured) })

    expect(restored.success && restored.restored).toEqual({ kind: 'terminal', sessionId: 't1' })
    expect(harness.state.spawns).toHaveLength(0)
    expect(harness.state.connects).toHaveLength(0)
  })

  it('目录终端在原实例失活后按保存目录重建', async () => {
    const harness = setup()
    harness.state.sessions.set('t1', { alive: true, config: sessionConfig({ type: ConnectionType.LOCAL, local: { cwd: dir } }) })
    const captured = await harness.service.request({ kind: 'capture', resource: { kind: 'terminal', id: 't1' } })
    harness.state.sessions.delete('t1')

    const restored = await harness.service.request({ kind: 'restore', id: entryIdOf(captured) })
    expect(restored.success && restored.restored).toEqual({ kind: 'terminal', sessionId: 'spawned-1' })
    expect(harness.state.spawns).toEqual([{ name: '终端 1', command: undefined, tags: [], opts: { cwd: dir, awaitConnection: true } }])
  })

  it('并发恢复同一记录只启动一次', async () => {
    const harness = setup()
    harness.state.sessions.set('t1', { alive: true, config: sessionConfig({ type: ConnectionType.LOCAL, local: { cwd: dir } }) })
    const captured = await harness.service.request({ kind: 'capture', resource: { kind: 'terminal', id: 't1' } })
    harness.state.sessions.delete('t1')

    let release: () => void = () => {}
    harness.state.spawnGate = new Promise<void>(resolve => {
      release = resolve
    })
    const id = entryIdOf(captured)
    const first = harness.service.request({ kind: 'restore', id })
    const second = harness.service.request({ kind: 'restore', id })
    release()
    const [one, two] = await Promise.all([first, second])

    expect(harness.state.spawns).toHaveLength(1)
    expect(one.success && one.restored).toEqual({ kind: 'terminal', sessionId: 'spawned-1' })
    expect(two.success && two.restored).toEqual({ kind: 'terminal', sessionId: 'spawned-1' })
  })

  it('失活的已保存连接按保存配置克隆重连', async () => {
    const harness = setup()
    harness.state.sessions.set('t1', { alive: true, config: sessionConfig({ originSavedSessionId: 'saved-1', ssh: { host: 'prod.example.com', port: 22, username: 'me' } }) })
    harness.state.saved.set('saved-1', sessionConfig({ id: 'saved-1', name: '生产机', ssh: { host: 'prod.example.com', port: 22, username: 'me' } }))
    const captured = await harness.service.request({ kind: 'capture', resource: { kind: 'terminal', id: 't1' } })
    harness.state.sessions.delete('t1')

    const restored = await harness.service.request({ kind: 'restore', id: entryIdOf(captured) })
    expect(restored.success).toBe(true)
    expect(harness.state.created).toHaveLength(1)
    const [config] = harness.state.created
    expect(config).toMatchObject({ name: '生产机', originSavedSessionId: 'saved-1' })
    expect(config.id).not.toBe('saved-1')
    expect(config.createdAt.getTime()).toBe(1000)
    expect(harness.state.connects).toEqual([config.id])
    expect(harness.state.spawns).toHaveLength(0)
  })

  it('已保存连接被删除时明确拒绝', async () => {
    const harness = setup()
    harness.state.sessions.set('t1', { alive: true, config: sessionConfig({ originSavedSessionId: 'saved-1' }) })
    const captured = await harness.service.request({ kind: 'capture', resource: { kind: 'terminal', id: 't1' } })
    harness.state.sessions.delete('t1')

    const restored = await harness.service.request({ kind: 'restore', id: entryIdOf(captured) })
    expect(restored.success).toBe(false)
    if (!restored.success) expect(restored.error).toMatch(/原已保存连接已被删除/)
  })

  it('Claude 续接只拼接本机 --help 确认过的精确参数', async () => {
    const harness = setup({ env: { SHELF_TEST: '1' } })
    harness.state.workspaces.set('claude:ws1', workspace('ws1', dir))
    harness.state.sessions.set('t1', { alive: true, config: sessionConfig({ type: ConnectionType.LOCAL, local: { cwd: dir }, tags: ['claude:ws1'] }) })
    harness.state.tuiRows.push(tuiRow({ terminalId: 't1', source: 'claude', workspace: dir, cliSessionId: 'cli-session-1' }))
    const captured = await harness.service.request({ kind: 'capture', resource: { kind: 'terminal', id: 't1' } })
    harness.state.sessions.delete('t1')

    const restored = await harness.service.request({ kind: 'restore', id: entryIdOf(captured) })
    expect(restored.success && restored.restored).toEqual({ kind: 'terminal', sessionId: 'spawned-1' })
    expect(harness.state.spawns).toEqual([
      {
        name: '终端 1 · 续接',
        command: 'claude --permission-mode acceptEdits --resume cli-session-1',
        tags: ['claude:ws1'],
        opts: { cwd: dir, env: { SHELF_TEST: '1' }, awaitConnection: true }
      }
    ])
  })

  it('Codex 续接用 codex resume <ID>', async () => {
    const harness = setup()
    harness.state.workspaces.set('codex:ws1', workspace('ws1', dir))
    harness.state.sessions.set('t1', { alive: true, config: sessionConfig({ type: ConnectionType.LOCAL, local: { cwd: dir }, tags: ['codex:ws1'] }) })
    harness.state.tuiRows.push(tuiRow({ terminalId: 't1', source: 'codex', workspace: dir, cliSessionId: '0192-abc' }))
    const captured = await harness.service.request({ kind: 'capture', resource: { kind: 'terminal', id: 't1' } })
    harness.state.sessions.delete('t1')

    await harness.service.request({ kind: 'restore', id: entryIdOf(captured) })
    expect(harness.state.spawns[0].command).toBe('codex resume --model gpt-5 0192-abc')
    expect(harness.state.spawns[0].opts).toEqual({ cwd: dir, awaitConnection: true })
  })

  it('Agent 目录改绑后拒绝在另一个目录恢复', async () => {
    const harness = setup()
    const otherDir = join(dir, 'other')
    mkdirSync(otherDir, { recursive: true })
    harness.state.workspaces.set('claude:ws1', workspace('ws1', dir))
    harness.state.sessions.set('t1', { alive: true, config: sessionConfig({ type: ConnectionType.LOCAL, local: { cwd: dir }, tags: ['claude:ws1'] }) })
    harness.state.tuiRows.push(tuiRow({ terminalId: 't1', source: 'claude', workspace: dir }))
    const captured = await harness.service.request({ kind: 'capture', resource: { kind: 'terminal', id: 't1' } })
    harness.state.sessions.delete('t1')
    harness.state.workspaces.set('claude:ws1', workspace('ws1', otherDir))

    const restored = await harness.service.request({ kind: 'restore', id: entryIdOf(captured) })
    expect(restored.success).toBe(false)
    if (!restored.success) expect(restored.error).toMatch(/已变更/)
    expect(harness.state.spawns).toHaveLength(0)
  })

  it('Agent 配置被删除后拒绝恢复', async () => {
    const harness = setup()
    harness.state.workspaces.set('claude:ws1', workspace('ws1', dir))
    harness.state.sessions.set('t1', { alive: true, config: sessionConfig({ type: ConnectionType.LOCAL, local: { cwd: dir }, tags: ['claude:ws1'] }) })
    harness.state.tuiRows.push(tuiRow({ terminalId: 't1', source: 'claude', workspace: dir }))
    const captured = await harness.service.request({ kind: 'capture', resource: { kind: 'terminal', id: 't1' } })
    harness.state.sessions.delete('t1')
    harness.state.workspaces.clear()

    const restored = await harness.service.request({ kind: 'restore', id: entryIdOf(captured) })
    expect(restored.success).toBe(false)
    if (!restored.success) expect(restored.error).toMatch(/已删除/)
    expect(harness.state.spawns).toHaveLength(0)
  })

  it('没有可信 CLI 会话 ID 时打开普通 shell，不猜历史或重跑 Agent', async () => {
    const harness = setup()
    harness.state.sessions.set('t1', { alive: true, config: sessionConfig({ type: ConnectionType.LOCAL, local: { cwd: dir }, tags: ['claude:ws1'] }) })
    harness.state.tuiRows.push(tuiRow({ terminalId: 't1', source: 'claude', cliSessionId: null }))
    const captured = await harness.service.request({ kind: 'capture', resource: { kind: 'terminal', id: 't1' } })
    harness.state.sessions.delete('t1')

    const restored = await harness.service.request({ kind: 'restore', id: entryIdOf(captured) })
    expect(restored.success).toBe(true)
    expect(harness.state.spawns).toEqual([{ name: expect.any(String), command: undefined, tags: [], opts: { cwd: dir, awaitConnection: true } }])
    expect(harness.state.launches).toHaveLength(0)
  })

  it('带启动命令的普通终端结束后只新建 shell，不重放命令', async () => {
    const harness = setup()
    harness.state.sessions.set('t1', { alive: true, config: sessionConfig({ type: ConnectionType.LOCAL, local: { cwd: dir }, startupCommands: ['npm run dev'] }) })
    const captured = await harness.service.request({ kind: 'capture', resource: { kind: 'terminal', id: 't1' } })
    harness.state.sessions.delete('t1')

    const restored = await harness.service.request({ kind: 'restore', id: entryIdOf(captured) })
    expect(restored.success).toBe(true)
    expect(harness.state.spawns).toEqual([{ name: expect.any(String), command: undefined, tags: [], opts: { cwd: dir, awaitConnection: true } }])
  })

  it('POST 网页恢复时明确拒绝重放', async () => {
    const harness = setup()
    const captured = await harness.service.request({
      kind: 'capture',
      resource: { kind: 'web', id: 'w1', url: 'https://example.com/compose', title: '结果页', post: true }
    })
    const restored = await harness.service.request({ kind: 'restore', id: entryIdOf(captured) })
    expect(restored.success).toBe(false)
    if (!restored.success) expect(restored.error).toMatch(/只在当前实例有效/)
  })

  it('安全网页恢复只返回 URL', async () => {
    const harness = setup()
    const captured = await harness.service.request({
      kind: 'capture',
      resource: { kind: 'web', id: 'w1', url: 'https://example.com/docs/guide', title: '文档' }
    })
    const restored = await harness.service.request({ kind: 'restore', id: entryIdOf(captured) })
    expect(restored.success && restored.restored).toEqual({ kind: 'web', url: 'https://example.com/docs/guide' })
  })
})

describe('任务保存区维护', () => {
  it('list / rename / remove', async () => {
    const harness = setup()
    expect(await harness.service.request({ kind: 'list' })).toMatchObject({ success: true, entries: [], preferences: { toggleShortcut: 'Ctrl+`' } })
    harness.state.sessions.set('t1', { alive: true, config: sessionConfig({ type: ConnectionType.LOCAL, local: { cwd: dir } }) })
    const captured = await harness.service.request({ kind: 'capture', resource: { kind: 'terminal', id: 't1' } })
    const id = entryIdOf(captured)

    const renamed = await harness.service.request({ kind: 'rename', id, title: '  改过的名字  ' })
    expect(entryOf(renamed).title).toBe('改过的名字')
    expect(entryOf(renamed).revision).toBe(2)

    const removed = await harness.service.request({ kind: 'remove', id })
    expect(removed.success && removed.entries).toEqual([])
    const missing = await harness.service.request({ kind: 'remove', id })
    expect(missing.success).toBe(false)
    if (!missing.success) expect(missing.error).toBe('保存记录不存在')
  })

  it('恢复后重新收纳用 entryId 改绑到新实例', async () => {
    const harness = setup()
    harness.state.sessions.set('t1', { alive: true, config: sessionConfig({ type: ConnectionType.LOCAL, local: { cwd: dir } }) })
    const captured = await harness.service.request({ kind: 'capture', resource: { kind: 'terminal', id: 't1' } })
    const entryId = entryIdOf(captured)
    harness.state.sessions.delete('t1')

    const restored = await harness.service.request({ kind: 'restore', id: entryId })
    expect(restored.success && restored.restored).toEqual({ kind: 'terminal', sessionId: 'spawned-1' })
    harness.state.sessions.set('spawned-1', { alive: true, config: sessionConfig({ id: 'spawned-1', type: ConnectionType.LOCAL, local: { cwd: dir } }) })

    const recaptured = await harness.service.request({ kind: 'capture', resource: { kind: 'terminal', id: 'spawned-1' }, entryId })
    expect(recaptured.success).toBe(true)
    if (!recaptured.success) return
    expect(recaptured.entries).toHaveLength(1)
    expect(recaptured.entry).toMatchObject({ id: entryId, resourceKey: 'terminal:spawned-1', revision: 2 })
  })

  it('写盘失败时返回失败并保留旧清单', async () => {
    const harness = setup()
    harness.state.sessions.set('t1', { alive: true, config: sessionConfig({ type: ConnectionType.LOCAL, local: { cwd: dir } }) })
    const first = await harness.service.request({ kind: 'capture', resource: { kind: 'terminal', id: 't1' } })
    expect(first.success).toBe(true)

    disk.failWrite = true
    harness.state.sessions.set('t2', { alive: true, config: sessionConfig({ id: 't2', type: ConnectionType.LOCAL, local: { cwd: dir } }) })
    const failed = await harness.service.request({ kind: 'capture', resource: { kind: 'terminal', id: 't2' } })
    expect(failed.success).toBe(false)
    if (!failed.success) expect(failed.error).toMatch(/保存区写入失败/)

    const listed = await harness.service.request({ kind: 'list' })
    expect(listed.success && listed.entries).toHaveLength(1)
  })

  it('未知请求被拒绝而不是静默成功', async () => {
    const harness = setup()
    const result = await harness.service.request({ kind: 'nope' } as unknown as Parameters<TaskShelfService['request']>[0])
    expect(result.success).toBe(false)
  })
})

/** 归档区「全部移回 Tasks」：只改列表归属，绝不恢复/启动任何实例。 */
describe('任务保存区 unarchiveAll', () => {
  it('只改列表归属：整批移回不触发恢复、启动、连接或保活', async () => {
    const retain = vi.fn().mockResolvedValue(undefined)
    const harness = setup({ retainSession: retain })
    harness.state.sessions.set('t1', { alive: true, config: sessionConfig({ type: ConnectionType.LOCAL, local: { cwd: dir } }) })
    const active = await harness.service.request({ kind: 'capture', resource: { kind: 'terminal', id: 't1' } })
    const web = await harness.service.request({ kind: 'capture', resource: { kind: 'web', id: 'w1', url: 'https://example.com/docs/guide', title: '文档' } })
    await harness.service.request({ kind: 'archive', id: entryIdOf(web), archived: true })
    const before = { spawns: harness.state.spawns.length, created: harness.state.created.length, connects: harness.state.connects.length, launches: harness.state.launches.length, retains: retain.mock.calls.length }

    const result = await harness.service.request({ kind: 'unarchiveAll' })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.entries.map(item => item.id)).toEqual([entryIdOf(active), entryIdOf(web)])
    expect(result.entries.map(item => item.archivedAt)).toEqual([undefined, undefined])
    expect(result.entries.find(item => item.id === entryIdOf(web))).toMatchObject({ revision: 3 })
    expect(result.entries.find(item => item.id === entryIdOf(web))!.updatedAt).toBeGreaterThan(1001)
    // 一条运行资源行为都不能发生：不 spawn、不建会话、不连接、不跑续接、不改保留标记。
    expect(harness.state.spawns).toHaveLength(before.spawns)
    expect(harness.state.created).toHaveLength(before.created)
    expect(harness.state.connects).toHaveLength(before.connects)
    expect(harness.state.launches).toHaveLength(before.launches)
    expect(retain.mock.calls).toHaveLength(before.retains)
    expect(harness.state.sessions.get('t1')?.alive).toBe(true)
    // 返回的是列表，不是恢复结果：界面不能借这次调用导航到任何实例。
    expect(result).not.toHaveProperty('restored')
  })

  it('无归档项时幂等，重建仓储后保持移回结果，之后仍可再次归档与移回', async () => {
    const harness = setup()
    const web = await harness.service.request({ kind: 'capture', resource: { kind: 'web', id: 'w1', url: 'https://example.com/docs/guide', title: '文档' } })
    await harness.service.request({ kind: 'archive', id: entryIdOf(web), archived: true })

    const first = await harness.service.request({ kind: 'unarchiveAll' })
    const second = await harness.service.request({ kind: 'unarchiveAll' })
    expect(first.success && second.success).toBe(true)
    if (!first.success || !second.success) return
    expect(first.entries.map(item => item.archivedAt)).toEqual([undefined])
    expect(second.entries).toEqual(first.entries)
    expect(new TaskShelfRepository(join(dir, 'task-shelf.json')).list()).toEqual(first.entries)

    expect(await harness.service.request({ kind: 'archive', id: entryIdOf(web), archived: true })).toMatchObject({ success: true, entry: { archivedAt: 1000 } })
    const again = await harness.service.request({ kind: 'unarchiveAll' })
    expect(again.success && again.entries.map(item => item.archivedAt)).toEqual([undefined])
  })

  it('写盘失败返回失败并保留归档状态，恢复后可重试', async () => {
    const harness = setup()
    const one = await harness.service.request({ kind: 'capture', resource: { kind: 'web', id: 'w1', url: 'https://example.com/docs/guide', title: '文档' } })
    const two = await harness.service.request({ kind: 'capture', resource: { kind: 'web', id: 'w2', url: 'https://example.com/docs/api', title: '接口' } })
    await harness.service.request({ kind: 'archive', id: entryIdOf(one), archived: true })
    await harness.service.request({ kind: 'archive', id: entryIdOf(two), archived: true })
    const diskBefore = readFileSync(join(dir, 'task-shelf.json'), 'utf8')

    disk.failWrite = true
    const failed = await harness.service.request({ kind: 'unarchiveAll' })
    expect(failed.success).toBe(false)
    if (!failed.success) expect(failed.error).toMatch(/保存区写入失败/)
    expect(readFileSync(join(dir, 'task-shelf.json'), 'utf8')).toBe(diskBefore)
    const listed = await harness.service.request({ kind: 'list' })
    expect(listed.success && listed.entries.every(entry => entry.archivedAt === 1000)).toBe(true)

    disk.failWrite = false
    const moved = await harness.service.request({ kind: 'unarchiveAll' })
    expect(moved.success).toBe(true)
    if (!moved.success) return
    expect(moved.entries.map(entry => entry.archivedAt)).toEqual([undefined, undefined])
    expect(new TaskShelfRepository(join(dir, 'task-shelf.json')).list()).toEqual(moved.entries)
  })

  it('指向已结束本地宿主的归档记录只移回列表，不探测、不附着、不新建', async () => {
    const hostId = 'a93bb4f0-0d44-44f8-8418-d7f479251728'
    const probe = vi.fn().mockResolvedValue({ running: true })
    const restoreHost = vi.fn().mockResolvedValue({ success: true, id: 'restored' })
    const retain = vi.fn().mockResolvedValue(undefined)
    const harness = setup({ localHost: { probe, restore: restoreHost }, retainSession: retain })
    harness.state.sessions.set('t1', { alive: true, config: sessionConfig({ type: ConnectionType.LOCAL, local: { cwd: dir, terminalHostId: hostId } }) })
    const saved = await harness.service.request({ kind: 'capture', resource: { kind: 'terminal', id: 't1' } })
    expect(entryOf(saved).capability).toBe('local-live')
    await harness.service.request({ kind: 'archive', id: entryIdOf(saved), archived: true })
    harness.state.sessions.clear()
    retain.mockClear()

    const result = await harness.service.request({ kind: 'unarchiveAll' })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.entries[0].archivedAt).toBeUndefined()
    expect(probe).not.toHaveBeenCalled()
    expect(restoreHost).not.toHaveBeenCalled()
    expect(retain).not.toHaveBeenCalled()
    expect(harness.state.spawns).toHaveLength(0)
    expect(harness.state.created).toHaveLength(0)
    expect(harness.state.sessions.size).toBe(0)
  })
})

describe('启动归档与分类命令（IPC 面）', () => {
  /** 启动前遗留的 Tasks 记录：启动归档要把它移入 Archive。 */
  const seedLegacyTask = (repository: TaskShelfRepository): void => {
    const { entry } = repository.capture(
      {
        resourceKey: 'terminal:legacy',
        title: '旧任务',
        recovery: { kind: 'terminal', sessionId: 'legacy', type: ConnectionType.LOCAL },
        capability: 'directory'
      },
      500
    )
    expect(entry.archivedAt).toBeUndefined()
  }

  it('list 成功总是携带 startup（默认关闭归档时 ready）', async () => {
    const harness = setup()
    const listed = await harness.service.request({ kind: 'list' })
    expect(listed.success && listed.startup).toMatchObject({ status: 'ready', archiveOnBoot: false })
  })

  it('启动归档把启动前记录移入 Archive，之后新保存直接是 Tasks；activate 只分类不启动任何东西', async () => {
    const harness = setup({ startupArchiveEnabled: true, seedRepository: seedLegacyTask })
    const listed = await harness.service.request({ kind: 'list' })
    if (!listed.success || !listed.startup) throw new Error('缺少 startup')
    expect(listed.startup).toMatchObject({ status: 'ready', archiveOnBoot: true })
    expect(listed.entries).toHaveLength(1)
    expect(listed.entries[0].archivedAt).toBeDefined()

    harness.state.sessions.set('t1', { alive: true, config: sessionConfig({ type: ConnectionType.LOCAL, local: { cwd: dir } }) })
    const captured = await harness.service.request({ kind: 'capture', resource: { kind: 'terminal', id: 't1' } })
    const id = entryIdOf(captured)
    // 启动之后新建的保存记录直接是 Tasks，不进入旧启动批次
    expect(entryOf(captured).archivedAt).toBeUndefined()

    const archived = await harness.service.request({ kind: 'archive', id, archived: true })
    if (!archived.success) throw new Error(archived.error)
    const current = harness.repository.get(id)!
    const spawned = harness.state.spawns.length

    const result = await harness.service.request({
      kind: 'activate',
      bootId: listed.startup.bootId,
      scopeId: listed.startup.scopeId,
      requestId: 'r-1',
      items: [{ taskId: id, expectedRevision: current.revision }]
    })
    if (!result.success || !result.activation) throw new Error(result.success ? '缺少 activation' : result.error)
    expect(result.activation).toMatchObject({ total: 1, moved: 1, alreadyTasks: 0, conflict: 0, missing: 0, failed: 0 })
    expect(result.entries.find(entry => entry.id === id)?.archivedAt).toBeUndefined()
    expect(harness.state.spawns).toHaveLength(spawned)
    expect(harness.state.created).toEqual([])
    expect(harness.state.connects).toEqual([])
    expect(harness.state.launches).toEqual([])

    const stale = await harness.service.request({ kind: 'retryInitialization', bootId: 'old-boot', scopeId: listed.startup.scopeId })
    expect(stale).toMatchObject({ success: false, code: 'STALE_BOOT' })
  })

  it('初始化持久保存失败：list 给真实原记录 + blocked，变更命令与 restore 都被拒且不写盘，重试后 ready', async () => {
    const harness = setup({
      startupArchiveEnabled: true,
      seedRepository: seedLegacyTask,
      beforeCreate: () => {
        disk.failWrite = true
      }
    })
    const listed = await harness.service.request({ kind: 'list' })
    if (!listed.success || !listed.startup) throw new Error('缺少 startup')
    expect(listed.startup.status).toBe('blocked')
    expect(listed.startup.error).toMatch(/保存区写入失败/)
    expect(listed.entries).toHaveLength(1)
    // 保存失败不伪装成功：保留真实原分类（仍是 Tasks）
    expect(listed.entries[0].archivedAt).toBeUndefined()

    harness.state.sessions.set('t1', { alive: true, config: sessionConfig({ type: ConnectionType.LOCAL, local: { cwd: dir } }) })
    const blockedCapture = await harness.service.request({ kind: 'capture', resource: { kind: 'terminal', id: 't1' } })
    expect(blockedCapture).toMatchObject({ success: false, code: 'INITIALIZATION_BLOCKED' })
    const blockedActivate = await harness.service.request({
      kind: 'activate',
      bootId: listed.startup.bootId,
      scopeId: listed.startup.scopeId,
      requestId: 'r-1',
      items: []
    })
    expect(blockedActivate).toMatchObject({ success: false, code: 'INITIALIZATION_BLOCKED' })
    const blockedArchive = await harness.service.request({ kind: 'archive', id: listed.entries[0].id, archived: false })
    expect(blockedArchive).toMatchObject({ success: false, code: 'INITIALIZATION_BLOCKED' })
    const blockedRename = await harness.service.request({ kind: 'rename', id: listed.entries[0].id, title: 'x' })
    expect(blockedRename).toMatchObject({ success: false, code: 'INITIALIZATION_BLOCKED' })

    // restore 不是只读：恢复成功会改绑 resourceKey 并写盘，初始化未完成时同样必须拒绝。
    const entriesBefore = harness.repository.list()
    const writesBefore = disk.writes
    const blockedRestore = await harness.service.request({ kind: 'restore', id: listed.entries[0].id })
    expect(blockedRestore).toMatchObject({ success: false, code: 'INITIALIZATION_BLOCKED' })
    // 0 创建 / 0 连接 / 0 启动 / 0 写盘 / 保存区记录一个字节都没动
    expect(harness.state.created).toHaveLength(0)
    expect(harness.state.connects).toHaveLength(0)
    expect(harness.state.spawns).toHaveLength(0)
    expect(disk.writes).toBe(writesBefore)
    expect(harness.repository.list()).toEqual(entriesBefore)
    expect(harness.repository.get(listed.entries[0].id)?.revision).toBe(entriesBefore[0].revision)

    disk.failWrite = false
    const retried = await harness.service.request({ kind: 'retryInitialization', bootId: listed.startup.bootId, scopeId: listed.startup.scopeId })
    if (!retried.success || !retried.startup) throw new Error(retried.success ? '缺少 startup' : retried.error)
    expect(retried.startup.status).toBe('ready')
    // 重试归档成功：启动前那条记录进入 Archive，原记录未丢
    expect(retried.entries.find(entry => entry.id === listed.entries[0].id)?.archivedAt).toBeDefined()
  })
})
