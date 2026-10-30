import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_THEME_DARK } from '@shared/constants'
import { ConnectionType, type SessionConfig, type TerminalConfig } from '@shared/types/session'
import type { TaskShelfEntry } from '@shared/task-shelf'
import {
  createTaskShelfService,
  type ShelfSessionView,
  type ShelfSpawnResult,
  type TaskShelfDeps,
  type TaskShelfService
} from './task-shelf'
import { TaskShelfRepository } from '../storage/task-shelf-repository'

/**
 * 独立回归：本地 PTY 宿主失联时，Tasks 保存区的「移除」仍必须可用。
 *
 * 语义边界（本文件只断言这些）：
 * - 移除 = 取消保存，不是终止进程；probe/reattach/释放保留标记失败都不能卡住删除；
 * - 失联宿主上的移除不新建替代 shell、不运行旧命令、不重新连接；
 * - 未知宿主状态不得伪造「已终止」：结果不得带 restored；
 * - 正常 live 宿主仍先接回主区并返回 restored sessionId；
 * - 删盘失败必须保留记录并如实报告失败；
 * - 回收站里的未保存记录只删记录，从不 probe / attach / 改保留标记。
 */

const HOST_ID = 'a93bb4f0-0d44-44f8-8418-d7f479251728'
/** 与截图一致的宿主失联文案：宿主管道 ENOENT。 */
const NO_HOST_MESSAGE = 'cannot reach the local PTY host: connect ENOENT \\\\.\\pipe\\lyshell-pty-host-6f1d'

const disk = vi.hoisted(() => ({ failWrite: false }))

vi.mock('../storage/repository', async () => {
  const fs = await import('node:fs')
  return {
    getConfigDir: () => '.',
    atomicWriteFileSync: (filePath: string, data: string): void => {
      if (disk.failWrite) throw new Error('disk full')
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

interface RemoveTestState {
  sessions: Map<string, ShelfSessionView>
  spawns: SpawnCall[]
  created: SessionConfig[]
  connects: string[]
}

interface RemoveTestHarness {
  service: TaskShelfService
  repository: TaskShelfRepository
  state: RemoveTestState
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lyshell-shelf-remove-offline-'))
  disk.failWrite = false
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
    name: '本地终端',
    type: ConnectionType.SSH,
    ssh: { host: 'example.com', port: 22, username: 'me' },
    terminal: terminalConfig(),
    tags: [],
    createdAt: new Date(0),
    updatedAt: new Date(0)
  }
  return { ...base, ...overrides }
}

/** 带独立 PTY 宿主身份的本地终端配置：capture 会写入 recovery.localHostId。 */
function localHostConfig(id = 't1'): SessionConfig {
  return sessionConfig({ id, type: ConnectionType.LOCAL, local: { cwd: dir, terminalHostId: HOST_ID } })
}

function setup(options: { localHost?: TaskShelfDeps['localHost']; retainSession?: TaskShelfDeps['retainSession'] } = {}): RemoveTestHarness {
  const repository = new TaskShelfRepository(join(dir, 'task-shelf.json'))
  const state: RemoveTestState = {
    sessions: new Map<string, ShelfSessionView>(),
    spawns: [],
    created: [],
    connects: []
  }
  const deps: TaskShelfDeps = {
    repository,
    session: id => state.sessions.get(id),
    createSession: async config => {
      state.created.push(config)
      state.sessions.set(config.id, { alive: false, config })
      return { id: config.id }
    },
    connectSession: async id => {
      state.connects.push(id)
      const live = state.sessions.get(id)
      if (live) live.alive = true
    },
    savedSession: () => null,
    tui: () => ({ observedAt: 0, sessions: [], events: [] }),
    // 移除路径绝不应走到这里；一旦发生就记录，供断言「不启动替代 shell」。
    spawn: async (name, command, tags, opts) => {
      state.spawns.push({ name, command, tags, opts })
      return { success: true, id: `spawned-${state.spawns.length}` }
    },
    harness: {
      workspace: () => undefined,
      launch: async () => ({ ok: false, error: '移除回归不启动 Agent' })
    },
    now: () => 1000
  }
  if (options.localHost) deps.localHost = options.localHost
  if (options.retainSession) deps.retainSession = options.retainSession
  return { service: createTaskShelfService(deps), repository, state }
}

/** 收纳一个仍活着的本地终端，返回保存记录；随后调用方按需清掉 runtime。 */
async function captureLocal(f: RemoveTestHarness, id = 't1'): Promise<TaskShelfEntry> {
  f.state.sessions.set(id, { alive: true, config: localHostConfig(id) })
  const result = await f.service.request({ kind: 'capture', resource: { kind: 'terminal', id } })
  if (!result.success || !result.entry) {
    throw new Error(`capture failed: ${result.success ? 'missing entry' : result.error}`)
  }
  expect(result.entry.recovery).toMatchObject({ localHostId: HOST_ID })
  return result.entry
}

function restoredOf(result: Awaited<ReturnType<TaskShelfService['request']>>): unknown {
  return result.success ? result.restored : undefined
}

const PROBE_FAILURES: ReadonlyArray<{ label: string; error: () => Error }> = [
  { label: '宿主管道 ENOENT', error: () => Object.assign(new Error(NO_HOST_MESSAGE), { code: 'ENOENT' }) },
  { label: 'host-unreachable', error: () => new Error('host-unreachable') }
]

const RESTORE_FAILURES: ReadonlyArray<{ label: string; restore: () => Promise<ShelfSpawnResult> }> = [
  {
    label: '附着抛错',
    restore: async () => {
      throw new Error(NO_HOST_MESSAGE)
    }
  },
  {
    label: '附着返回失败结果',
    restore: async () => ({ success: false, error: NO_HOST_MESSAGE })
  }
]

describe('移除保存记录：本地宿主失联', () => {
  for (const failure of PROBE_FAILURES) {
    it(`探测失败（${failure.label}）后仍删除记录，不新建替代 shell`, async () => {
      const probe = vi.fn().mockRejectedValue(failure.error())
      const restore = vi.fn()
      const f = setup({ localHost: { probe, restore } })
      const entry = await captureLocal(f)
      f.state.sessions.clear()

      const result = await f.service.request({ kind: 'remove', id: entry.id })

      // 取消保存成功：结果里没有任何伪造的运行状态。
      expect(result).toMatchObject({ success: true, entries: [] })
      expect(restoredOf(result)).toBeUndefined()
      expect(f.repository.get(entry.id)).toBeUndefined()
      expect(f.repository.list()).toEqual([])
      // 删除已经落盘，重启后不会复活这条失联记录。
      expect(new TaskShelfRepository(join(dir, 'task-shelf.json')).list()).toEqual([])
      // 只探测、不附着；绝不启动替代 shell 或新建会话。
      expect(probe).toHaveBeenCalledWith(HOST_ID)
      expect(restore).not.toHaveBeenCalled()
      expect(f.state.spawns).toEqual([])
      expect(f.state.created).toEqual([])
      expect(f.state.connects).toEqual([])
    })
  }

  for (const failure of RESTORE_FAILURES) {
    it(`宿主探测为 running 但 attach 失败（${failure.label}）后仍可移除，且不启动替代 shell`, async () => {
      const probe = vi.fn().mockResolvedValue({ running: true })
      const restore = vi.fn(failure.restore)
      const retain = vi.fn().mockResolvedValue(undefined)
      const f = setup({ localHost: { probe, restore }, retainSession: retain })
      const entry = await captureLocal(f)
      f.state.sessions.clear()

      const result = await f.service.request({ kind: 'remove', id: entry.id })

      expect(result).toMatchObject({ success: true, entries: [] })
      // 宿主是否已结束仍是未知：不得返回 restored 假装接回或已终止。
      expect(restoredOf(result)).toBeUndefined()
      expect(f.repository.get(entry.id)).toBeUndefined()
      expect(f.repository.list()).toEqual([])
      expect(restore).toHaveBeenCalledTimes(1)
      // 不新建 shell、不建会话、不重连。
      expect(f.state.spawns).toEqual([])
      expect(f.state.created).toEqual([])
      expect(f.state.connects).toEqual([])
    })
  }

  it('当前 runtime 仍在但释放保留标记失败时仍删除记录，且不终止该终端', async () => {
    const retain = vi.fn(async (_id: string, retained: boolean): Promise<void> => {
      if (!retained) throw new Error('release failed: local PTY host unreachable')
    })
    const f = setup({ retainSession: retain })
    const entry = await captureLocal(f)

    const result = await f.service.request({ kind: 'remove', id: entry.id })

    expect(result).toMatchObject({ success: true, entries: [] })
    expect(restoredOf(result)).toBeUndefined()
    expect(f.repository.get(entry.id)).toBeUndefined()
    expect(retain).toHaveBeenCalledWith('t1', false)
    // 取消保存不等同于终止进程：真实活终端仍在，可交回主区。
    expect(f.state.sessions.get('t1')?.alive).toBe(true)
    expect(f.state.spawns).toEqual([])
    expect(f.state.connects).toEqual([])
  })

  it('探测与释放保留标记同时失败时仍删除记录', async () => {
    const probe = vi.fn().mockRejectedValue(new Error(NO_HOST_MESSAGE))
    const retain = vi.fn(async (_id: string, retained: boolean): Promise<void> => {
      if (!retained) throw new Error('release failed')
    })
    const f = setup({ localHost: { probe, restore: vi.fn() }, retainSession: retain })
    const entry = await captureLocal(f)
    f.state.sessions.clear()

    const result = await f.service.request({ kind: 'remove', id: entry.id })

    expect(result).toMatchObject({ success: true, entries: [] })
    expect(f.repository.list()).toEqual([])
    expect(f.state.spawns).toEqual([])
    expect(f.state.created).toEqual([])
  })

  it('正常 live 宿主仍先接回主区并返回 restored sessionId', async () => {
    // 只探测一次后直接附着；再次走通用恢复会误把状态变化当作新建 shell 的理由。
    const probe = vi.fn().mockResolvedValueOnce({ running: true }).mockResolvedValue({ running: false })
    const restore = vi.fn().mockResolvedValue({ success: true, id: 'restored-host' })
    const retain = vi.fn().mockResolvedValue(undefined)
    const f = setup({ localHost: { probe, restore }, retainSession: retain })
    const entry = await captureLocal(f)
    f.state.sessions.clear()
    retain.mockClear()

    const result = await f.service.request({ kind: 'remove', id: entry.id })

    expect(result).toMatchObject({ success: true, entries: [], restored: { kind: 'terminal', sessionId: 'restored-host' } })
    expect(f.repository.list()).toEqual([])
    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenCalledWith(HOST_ID)
    expect(restore).toHaveBeenCalledWith(HOST_ID, entry.title, dir)
    expect(retain).toHaveBeenCalledWith('restored-host', false)
    expect(f.state.spawns).toEqual([])
    expect(f.state.connects).toEqual([])
  })

  it('删盘失败保留记录并报告失败，恢复写盘后可重试', async () => {
    const retain = vi.fn().mockResolvedValue(undefined)
    const f = setup({ retainSession: retain })
    const entry = await captureLocal(f)
    f.state.sessions.clear()

    disk.failWrite = true
    const failed = await f.service.request({ kind: 'remove', id: entry.id })
    expect(failed.success).toBe(false)
    if (!failed.success) expect(failed.error).toMatch(/保存区写入失败/)
    // 记录与落盘内容都必须原样保留，不能假装删除成功。
    expect(f.repository.get(entry.id)?.id).toBe(entry.id)
    expect(f.repository.list().map(item => item.id)).toEqual([entry.id])
    expect(new TaskShelfRepository(join(dir, 'task-shelf.json')).list().map(item => item.id)).toEqual([entry.id])
    expect(f.state.spawns).toEqual([])

    disk.failWrite = false
    expect(await f.service.request({ kind: 'remove', id: entry.id })).toMatchObject({ success: true, entries: [] })
    expect(f.repository.list()).toEqual([])
  })

  it('回收站记录移除只删记录：不 probe、不附着、不改变运行资源', async () => {
    const probe = vi.fn().mockRejectedValue(new Error(NO_HOST_MESSAGE))
    const restore = vi.fn()
    const retain = vi.fn()
    const f = setup({ localHost: { probe, restore }, retainSession: retain })
    f.state.sessions.set('unsaved', { alive: true, config: localHostConfig('unsaved') })

    const [entry] = f.service.recycleUnsavedTerminals(['unsaved'])
    expect(entry).toMatchObject({ resourceKey: 'terminal:unsaved', trashedAt: 1000 })
    f.state.sessions.clear()

    const result = await f.service.request({ kind: 'remove', id: entry.id })

    expect(result).toMatchObject({ success: true, entries: [] })
    expect(restoredOf(result)).toBeUndefined()
    expect(f.repository.list()).toEqual([])
    expect(probe).not.toHaveBeenCalled()
    expect(restore).not.toHaveBeenCalled()
    expect(retain).not.toHaveBeenCalled()
    expect(f.state.spawns).toEqual([])
    expect(f.state.connects).toEqual([])
  })
})
