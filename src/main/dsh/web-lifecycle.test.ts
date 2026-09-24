import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'
import type { RecordedPid } from './proc'

/**
 * DshWebManager 的生命周期 / 留档回归测试。
 *
 * 这里只跑状态机本身，故把外部世界全部替换掉：electron（app/session）、系统 PATH 读取
 * （会真去读注册表）、child_process.spawn、以及 proc.ts 里所有会碰进程表的 IO。
 * 保持真实的只有 web.ts 自己的状态机与留档读写顺序。
 */

vi.mock('electron-log', () => ({
  default: { info: () => {}, error: () => {}, warn: () => {} }
}))

vi.mock('electron', () => ({
  app: { getPath: () => 'C:\\tmp\\lyshell-dsh-test' },
  session: { fromPartition: () => ({ cookies: { set: async () => {} } }) }
}))

vi.mock('../env/refresh', () => ({ readSystemPath: () => null }))

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  sweep: vi.fn(),
  killPidTree: vi.fn(),
  readPidRecord: vi.fn(),
  writePidRecord: vi.fn(),
  lookupImageName: vi.fn(),
  attachJob: vi.fn(),
  listProcesses: vi.fn(),
  isPidAlive: vi.fn(),
  recoverRecordedPids: vi.fn()
}))

vi.mock('child_process', () => ({ spawn: mocks.spawn, execFile: vi.fn() }))
vi.mock('./windows-job', () => ({ attachDshProcessJob: mocks.attachJob }))

vi.mock('./proc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./proc')>()
  return {
    ...actual,
    sweepOrphanDshWeb: mocks.sweep,
    killPidTree: mocks.killPidTree,
    readPidRecord: mocks.readPidRecord,
    writePidRecord: mocks.writePidRecord,
    lookupImageName: mocks.lookupImageName,
    listProcesses: mocks.listProcesses,
    isPidAlive: mocks.isPidAlive,
    recoverRecordedPids: mocks.recoverRecordedPids
  }
})

import { DshWebManager } from './web'

interface FakeStream extends EventEmitter {
  setEncoding: (encoding: string) => void
}

interface FakeChild extends EventEmitter {
  pid: number
  stdin: FakeStream & { end: (text: string) => void }
  stdout: FakeStream
  stderr: FakeStream
  kill: () => void
}

function fakeChild(pid: number): FakeChild {
  const stream = (): FakeStream => {
    const s = new EventEmitter() as FakeStream
    s.setEncoding = () => {}
    return s
  }
  const child = new EventEmitter() as FakeChild
  child.pid = pid
  child.stdin = Object.assign(stream(), { end: vi.fn() })
  child.stdout = stream()
  child.stderr = stream()
  child.kill = () => {}
  return child
}

/** 让 open()/close() 链上的微任务全部跑完（比数 tick 稳） */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await sleep(10)
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.lookupImageName.mockResolvedValue('node.exe')
  mocks.attachJob.mockReturnValue(null)
  mocks.listProcesses.mockResolvedValue(null)
  mocks.isPidAlive.mockReturnValue(true)
  mocks.readPidRecord.mockResolvedValue([])
  mocks.writePidRecord.mockResolvedValue(undefined)
  mocks.killPidTree.mockResolvedValue({ status: 'killed', targets: [] })
  mocks.sweep.mockResolvedValue([])
  mocks.recoverRecordedPids.mockResolvedValue({ killed: [], dropped: [] })
})

describe('DshWebManager 生命周期', () => {
  it('Windows Job 已绑定时关闭整棵树，不再按 PID 执行 taskkill', async () => {
    const child = fakeChild(4242)
    const terminate = vi.fn(() => true)
    const closeJob = vi.fn(() => true)
    mocks.spawn.mockReturnValue(child as unknown as ChildProcess)
    mocks.attachJob.mockReturnValue({ terminate, close: closeJob })

    const manager = new DshWebManager()
    const openPromise = manager.open({ cwd: 'C:\\ws' })
    await flush()
    if (process.platform === 'win32') {
      expect(mocks.spawn).toHaveBeenCalledWith(expect.stringMatching(/cmd\.exe$/i),
        expect.arrayContaining(['/d', '/s', '/c']), expect.objectContaining({ shell: false }))
      expect(child.stdin.end).toHaveBeenCalledWith('start\n')
    }
    await manager.close()

    expect(terminate).toHaveBeenCalledTimes(1)
    expect(closeJob).toHaveBeenCalledTimes(1)
    expect(mocks.killPidTree).not.toHaveBeenCalled()
    child.emit('exit', 0, null)
    await openPromise
  })

  it('关窗后 Job 先触发 exit、排队 close 后执行时不会留下假待清理状态', async () => {
    const first = fakeChild(4242)
    const second = fakeChild(4243)
    mocks.spawn.mockReturnValueOnce(first as unknown as ChildProcess)
      .mockReturnValueOnce(second as unknown as ChildProcess)
    mocks.attachJob.mockImplementation(() => ({ terminate: () => true, close: () => true }))

    const manager = new DshWebManager()
    const firstOpen = manager.open({ cwd: 'C:\\ws' })
    await flush()
    const closing = manager.close()
    first.emit('exit', 0, null)
    await closing
    await firstOpen

    const secondOpen = manager.open({ cwd: 'C:\\ws' })
    await flush()
    expect(mocks.spawn).toHaveBeenCalledTimes(2)
    second.emit('exit', 0, null)
    await secondOpen
  })

  it('树杀未确认时保留待清理状态，禁止启动占同一会话锁的新实例', async () => {
    const child = fakeChild(4242)
    mocks.spawn.mockReturnValue(child as unknown as ChildProcess)
    mocks.killPidTree.mockResolvedValue({ status: 'unverified', message: 'identity unavailable', targets: [] })

    const manager = new DshWebManager()
    const firstOpen = manager.open({ cwd: 'C:\\ws' })
    await flush()
    await manager.close()
    const secondOpen = await manager.open({ cwd: 'C:\\ws' })

    expect(secondOpen.ok).toBe(false)
    if (!secondOpen.ok) expect(secondOpen.error).toContain('still being cleaned up')
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    child.emit('exit', 0, null)
    await firstOpen
  })

  it('旧树后来确认已消失时解除待清理状态，允许重开', async () => {
    const first = fakeChild(4242)
    const second = fakeChild(4243)
    mocks.spawn.mockReturnValueOnce(first as unknown as ChildProcess)
      .mockReturnValueOnce(second as unknown as ChildProcess)
    mocks.killPidTree.mockResolvedValue({ status: 'unverified', message: 'identity unavailable', targets: [] })

    const manager = new DshWebManager()
    const firstOpen = manager.open({ cwd: 'C:\\ws' })
    await flush()
    await manager.close()
    mocks.listProcesses.mockResolvedValue([])
    mocks.isPidAlive.mockReturnValue(false)

    const secondOpen = manager.open({ cwd: 'C:\\ws' })
    await flush()
    expect(mocks.spawn).toHaveBeenCalledTimes(2)
    first.emit('exit', 0, null)
    second.emit('exit', 0, null)
    await Promise.all([firstOpen, secondOpen])
  })

  it('open() 在 await 期间收到 close() → 不再 spawn（否则关窗/退出后残留 dsh 进程）', async () => {
    let releaseSweep: () => void = () => {}
    let markEnteredSweep: () => void = () => {}
    const enteredSweep = new Promise<void>((resolve) => {
      markEnteredSweep = resolve
    })
    mocks.sweep.mockImplementation(() => {
      markEnteredSweep()
      return new Promise<void>((resolve) => {
        releaseSweep = resolve
      })
    })

    const manager = new DshWebManager()
    const openPromise = manager.open({ cwd: 'C:\\ws' })
    await enteredSweep  // open() 已越过第一次 await，正卡在孤儿清扫上

    // 关窗 / 退出：一条 close() 请求插进来。旧实现不推进代际，这次 open 醒来照旧 spawn
    await manager.close()

    releaseSweep()
    const result = await openPromise

    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('superseded')
    expect(manager.running).toBe(false)
  })

  it('close() 推进代际并树杀当前 child（带默认预算）；迟到的 exit 不得回写状态或误报成功', async () => {
    const child = fakeChild(4242)
    mocks.spawn.mockReturnValue(child as unknown as ChildProcess)

    const manager = new DshWebManager()
    const openPromise = manager.open({ cwd: 'C:\\ws' })
    await flush()
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    expect(manager.running).toBe(true)

    await manager.close()
    expect(mocks.killPidTree).toHaveBeenCalledWith(4242, undefined, { deadline: expect.any(Number), ownedRootSpawnedAt: expect.any(Number) })
    expect(manager.running).toBe(false)

    child.emit('exit', 0, null)
    const result = await openPromise
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('superseded')
  })

  it('closeForQuit 抢跑：不排队等已在跑的那一轮慢树杀，且带自己的硬预算', async () => {
    const child = fakeChild(4242)
    mocks.spawn.mockReturnValue(child as unknown as ChildProcess)

    const manager = new DshWebManager()
    const openPromise = manager.open({ cwd: 'C:\\ws' })
    await flush()

    // 关窗：起一轮树杀，卡在「进程表枚举」里（模拟最坏情况的长步骤）
    let releaseSlowKill: () => void = () => {}
    mocks.killPidTree.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseSlowKill = () => resolve({ status: 'killed', targets: [] })
        })
    )
    const windowClose = manager.close()
    await flush()
    expect(mocks.killPidTree).toHaveBeenCalledTimes(1)

    // 退出：必须立刻再发一轮（this.child 已被慢的那轮清空，只能靠 killingPid 找到目标）
    const deadline = Date.now() + 2500
    await manager.closeForQuit(deadline)

    expect(mocks.killPidTree).toHaveBeenCalledTimes(2)
    expect(mocks.killPidTree).toHaveBeenLastCalledWith(4242, undefined, { deadline, ownedRootSpawnedAt: expect.any(Number) })

    // 慢的那轮还没结束 —— 退出路径确实没有等它
    releaseSlowKill()
    await windowClose
    child.emit('exit', 0, null)
    await openPromise
  })

  it('留档写盘失败被吞掉：未处理 rejection 会打挂主进程，且不得影响启动流程', async () => {
    const child = fakeChild(777)
    mocks.spawn.mockReturnValue(child as unknown as ChildProcess)
    mocks.writePidRecord.mockRejectedValue(new Error('EACCES: permission denied'))

    const manager = new DshWebManager()
    const openPromise = manager.open({ cwd: 'C:\\ws' })
    await flush()

    // 镜像名查询带重试，故等它真正走到写盘，再断言没逃逸成未处理 rejection（真逃逸 vitest 会判失败）
    await waitFor(() => mocks.writePidRecord.mock.calls.length > 0)
    expect(manager.running).toBe(true)

    const closing = manager.close()
    child.emit('exit', 0, null)
    await closing
    expect((await openPromise).ok).toBe(false)
  })

  it('子进程自然退出时清掉自己的留档（否则 PID 复用后会拿旧记录去核对并误杀）', async () => {
    const child = fakeChild(5150)
    mocks.spawn.mockReturnValue(child as unknown as ChildProcess)
    mocks.readPidRecord.mockResolvedValue([{ pid: 5150, name: 'node.exe', cmdline: null, recordedAt: 1 }])

    const manager = new DshWebManager()
    const openPromise = manager.open({ cwd: 'C:\\ws' })
    await flush()

    child.emit('exit', 0, null)
    await waitFor(() => mocks.writePidRecord.mock.calls.some((c) => (c[1] as unknown[]).length === 0))
    expect(mocks.writePidRecord).toHaveBeenCalledWith(expect.any(String), [])

    await openPromise
  })

  it('留档读改写互斥：并发的记录不会互相覆盖（无锁时后写的会盖掉前一条）', async () => {
    let store: RecordedPid[] = []
    mocks.readPidRecord.mockImplementation(async () => {
      await sleep(5)  // 放大读改写之间的窗口
      return store.map((e) => ({ ...e }))
    })
    mocks.writePidRecord.mockImplementation(async (_path: string, entries: RecordedPid[]) => {
      await sleep(5)
      store = entries.map((e) => ({ ...e }))
    })

    // recordPids 是私有方法：这里直接验证「同一条留档链上的并发写不丢记录」这一不变量
    const manager = new DshWebManager() as unknown as {
      recordPids(items: Array<{ pid: number; name: string; cmdline: string | null }>): Promise<void>
    }
    await Promise.all([
      manager.recordPids([{ pid: 11, name: 'a.exe', cmdline: null }]),
      manager.recordPids([{ pid: 22, name: 'b.exe', cmdline: null }])
    ])

    expect(store.map((e) => e.pid).sort((a, b) => a - b)).toEqual([11, 22])
  })

  it('启动恢复：杀掉的与判定为「已不是我们那个进程」的记录都清档，拿不到证据的留着', async () => {
    const entries: RecordedPid[] = [
      { pid: 1, name: 'cmd.exe', cmdline: null, recordedAt: 1 },
      { pid: 2, name: '', cmdline: null, recordedAt: 1 },
      { pid: 3, name: 'cmd.exe', cmdline: null, recordedAt: 1 }
    ]
    mocks.readPidRecord.mockResolvedValue(entries)
    mocks.recoverRecordedPids.mockResolvedValue({ killed: [1], dropped: [3] })

    const manager = new DshWebManager()
    await manager.recoverFromRecord()

    expect(mocks.writePidRecord).toHaveBeenCalledWith(expect.any(String), [entries[1]])
  })

  it('启动恢复：只处理「上次遗留」的记录，本会话写下的一个都不碰', async () => {
    const sessionRecord: RecordedPid = { pid: 7, name: 'cmd.exe', cmdline: null, recordedAt: Date.now() }
    mocks.readPidRecord.mockResolvedValue([sessionRecord])

    const manager = new DshWebManager()
    await manager.recoverFromRecord()

    // 一条候选都没有 → 连核对都不发起（本会话刚 spawn 的进程不可能被当成遗留物）
    expect(mocks.recoverRecordedPids).not.toHaveBeenCalled()
    expect(mocks.writePidRecord).not.toHaveBeenCalled()
  })

  it('启动恢复：把「本会话拥有的 pid」告知恢复流程，并做版本核对后再清档', async () => {
    const stale: RecordedPid = { pid: 8, name: 'cmd.exe', cmdline: null, recordedAt: 1 }
    mocks.readPidRecord.mockResolvedValue([stale])
    mocks.recoverRecordedPids.mockImplementation(async (_entries, deps) => {
      expect(deps?.isProtectedPid?.(8)).toBe(false)
      return { killed: [8], dropped: [] }
    })

    const manager = new DshWebManager()
    await manager.recoverFromRecord()
    expect(mocks.writePidRecord).toHaveBeenCalledWith(expect.any(String), [])

    // 同一条记录在核对期间被本会话重新写过（recordedAt 变了）→ 它已经不是判定时那一版，保留
    mocks.writePidRecord.mockClear()
    let reads = 0
    mocks.readPidRecord.mockImplementation(async () => {
      reads++
      return reads === 1 ? [{ ...stale }] : [{ ...stale, recordedAt: Date.now() }]
    })
    await manager.recoverFromRecord()
    expect(mocks.writePidRecord).toHaveBeenCalledWith(expect.any(String), [
      expect.objectContaining({ pid: 8 })
    ])
  })

  it('启动恢复：空档不写盘（不做无谓的 IO）', async () => {
    mocks.readPidRecord.mockResolvedValue([])
    const manager = new DshWebManager()
    await manager.recoverFromRecord()
    expect(mocks.writePidRecord).not.toHaveBeenCalled()
  })

  it('spawn error 后 exit 不再发时也要清掉归属与留档（错误路径不能留下过期归属）', async () => {
    let store: RecordedPid[] = []
    mocks.readPidRecord.mockImplementation(async () => store.map((e) => ({ ...e })))
    mocks.writePidRecord.mockImplementation(async (_path: string, entries: RecordedPid[]) => {
      store = entries.map((e) => ({ ...e }))
    })
    const child = fakeChild(9001)
    mocks.spawn.mockReturnValue(child as unknown as ChildProcess)

    const manager = new DshWebManager()
    const openPromise = manager.open({ cwd: 'C:\\ws' })
    await waitFor(() => store.some((e) => e.pid === 9001))

    // Node：error 之后 exit 可能不发 —— 只发 error，验证兜底清理
    child.emit('error', new Error('EACCES'))

    const result = await openPromise
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('Failed to spawn dsh')
    expect(manager.running).toBe(false)
    await waitFor(() => store.length === 0)
    expect((manager as unknown as { ownedPids: Map<number, number> }).ownedPids.has(9001)).toBe(false)
  })
})

describe('留档记录的写入时机', () => {
  /** 最后一次写盘的条目（写盘会先落「空身份」再落「查到镜像名」的两版） */
  const lastWritten = (): RecordedPid[] =>
    (mocks.writePidRecord.mock.calls.at(-1)?.[1] ?? []) as RecordedPid[]

  beforeEach(() => {
    mocks.lookupImageName.mockResolvedValue('cmd.exe')
  })

  it('spawn 后立刻留档 root pid，随后补上当场查到的镜像名', async () => {
    const child = fakeChild(6001)
    mocks.spawn.mockReturnValue(child as unknown as ChildProcess)

    const manager = new DshWebManager()
    const openPromise = manager.open({ cwd: 'C:\\ws' })
    // 第一版不等镜像名就落盘（退出/崩溃随时可能发生），第二版把名字补上
    await waitFor(() => lastWritten().some((e) => e.name === 'cmd.exe'))
    expect(lastWritten().map((e) => e.pid)).toEqual([6001])

    const closing = manager.close()
    child.emit('exit', 0, null)
    await closing
    await openPromise
  })

  it('镜像名一次查不到会重试，查到就刷新进档里', async () => {
    mocks.lookupImageName.mockReset()
    mocks.lookupImageName
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue('node.exe')
    const child = fakeChild(6002)
    mocks.spawn.mockReturnValue(child as unknown as ChildProcess)

    const manager = new DshWebManager()
    const openPromise = manager.open({ cwd: 'C:\\ws' })
    await waitFor(() => lastWritten().some((e) => e.name === 'node.exe'))

    expect(mocks.lookupImageName).toHaveBeenCalledTimes(3)
    expect(lastWritten()[0].pid).toBe(6002)

    const closing = manager.close()
    child.emit('exit', 0, null)
    await closing
    await openPromise
  })

  it('查不到镜像名时写空串而不是猜测值（不再猜 cmd.exe/dsh）', async () => {
    mocks.lookupImageName.mockResolvedValue(null)
    const child = fakeChild(6003)
    mocks.spawn.mockReturnValue(child as unknown as ChildProcess)

    const manager = new DshWebManager()
    const openPromise = manager.open({ cwd: 'C:\\ws' })
    await waitFor(() => mocks.writePidRecord.mock.calls.length > 0)
    // 等重试链跑完（预算封顶），档里仍应是空身份而不是猜出来的名字
    await sleep(50)

    expect(lastWritten()[0].name).toBe('')

    const closing = manager.close()
    child.emit('exit', 0, null)
    await closing
    await openPromise
  })

  it('树杀未确认时把 target 留档，给下次启动兜底', async () => {
    const child = fakeChild(6004)
    mocks.spawn.mockReturnValue(child as unknown as ChildProcess)
    mocks.killPidTree.mockResolvedValue({
      status: 'unverified',
      message: 'budget exhausted',
      targets: [{ pid: 6004, name: 'cmd.exe', cmdline: null }]
    })

    const manager = new DshWebManager()
    const openPromise = manager.open({ cwd: 'C:\\ws' })
    // 先等 spawn 期那两版留档落定，之后唯一的写盘来源就是关闭流程
    await waitFor(() => lastWritten().some((e) => e.name === 'cmd.exe'))
    mocks.writePidRecord.mockClear()

    const closing = manager.close()
    child.emit('exit', 0, null)
    await closing

    expect(mocks.writePidRecord).toHaveBeenCalled()
    expect(lastWritten().map((e) => e.pid)).toContain(6004)

    await openPromise
  })

  it('留档只记 root，不记子孙（子孙是推导出来的线索，写进档会在 PID 复用时变成误杀面）', async () => {
    const child = fakeChild(6005)
    mocks.spawn.mockReturnValue(child as unknown as ChildProcess)
    mocks.killPidTree.mockResolvedValue({
      status: 'unverified',
      message: 'process table unavailable',
      targets: [
        { pid: 6005, name: 'cmd.exe', cmdline: null },
        { pid: 6008, name: 'node.exe', cmdline: 'node .../dsh/lib/bin.js web --port 0 --no-open' }
      ]
    })

    const manager = new DshWebManager()
    const openPromise = manager.open({ cwd: 'C:\\ws' })
    await waitFor(() => lastWritten().some((e) => e.name === 'cmd.exe'))
    mocks.writePidRecord.mockClear()

    const closing = manager.close()
    child.emit('exit', 0, null)
    await closing

    // 即使枚举失败、子孙身份也不为空，档里也只有我们真正 spawn 的那个 root
    expect(lastWritten().map((e) => e.pid)).toEqual([6005])
    await openPromise
  })

  it('树杀失败后的留档写入不推进 recordedAt（时间戳是 PID 复用判据的基准）', async () => {
    let store: RecordedPid[] = []
    mocks.readPidRecord.mockImplementation(async () => store.map((e) => ({ ...e })))
    mocks.writePidRecord.mockImplementation(async (_path: string, entries: RecordedPid[]) => {
      store = entries.map((e) => ({ ...e }))
    })
    const child = fakeChild(8001)
    mocks.spawn.mockReturnValue(child as unknown as ChildProcess)
    // 树杀未确认 → settlePidRecord 会「确保记录在」，但不得改动已有记录
    mocks.killPidTree.mockResolvedValue({
      status: 'unverified',
      message: 'process table unavailable',
      targets: [{ pid: 8001, name: '', cmdline: null }]
    })

    const manager = new DshWebManager()
    const openPromise = manager.open({ cwd: 'C:\\ws' })
    await waitFor(() => store.some((e) => e.name === 'cmd.exe'))
    const recordedAt = store[0].recordedAt

    await sleep(20)  // 让「现在」明显晚于记录的写入时刻
    const closing = manager.close()
    child.emit('exit', 0, null)
    await closing

    expect(store).toHaveLength(1)
    expect(store[0].recordedAt).toBe(recordedAt)  // 没被推到「现在」
    expect(store[0].name).toBe('cmd.exe')         // 也没被空身份覆盖
    await openPromise
  })

  it('spawn 期补镜像名的 upsert 不推进 recordedAt（时间基准只在出生时定格一次）', async () => {
    let store: RecordedPid[] = []
    mocks.readPidRecord.mockImplementation(async () => store.map((e) => ({ ...e })))
    mocks.writePidRecord.mockImplementation(async (_path: string, entries: RecordedPid[]) => {
      store = entries.map((e) => ({ ...e }))
    })
    // 镜像名查询拖慢 30ms：补写那版一定落在首版之后（超过 Date.now 的毫秒分辨率）
    mocks.lookupImageName.mockImplementation(async () => {
      await sleep(30)
      return 'cmd.exe'
    })
    const child = fakeChild(8003)
    mocks.spawn.mockReturnValue(child as unknown as ChildProcess)

    const manager = new DshWebManager()
    const openPromise = manager.open({ cwd: 'C:\\ws' })
    await waitFor(() => store.length > 0)  // 第一版（空身份）已落
    const bornAt = store[0].recordedAt
    await waitFor(() => store.some((e) => e.name !== ''))  // 补写也落了
    expect(store[0].name).toBe('cmd.exe')
    expect(store[0].recordedAt).toBe(bornAt)  // 没被「补写那一刻」顶掉

    const closing = manager.close()
    child.emit('exit', 0, null)
    await closing
    await openPromise
  })

  it('树杀失败后兜底插入的记录用出生观察点，不用树杀失败那一刻', async () => {
    let store: RecordedPid[] = []
    mocks.readPidRecord.mockImplementation(async () => {
      await sleep(5)
      return store.map((e) => ({ ...e }))
    })
    // spawn 期两版写盘都失败 → 记录不存在 → 树杀失败后的 insertOnly 是唯一建档机会
    mocks.writePidRecord.mockRejectedValue(new Error('EACCES'))
    const child = fakeChild(8004)
    mocks.spawn.mockReturnValue(child as unknown as ChildProcess)
    mocks.killPidTree.mockResolvedValue({
      status: 'unverified',
      message: 'process table unavailable',
      targets: [{ pid: 8004, name: '', cmdline: null }]
    })

    const bornAfter = Date.now()
    const manager = new DshWebManager()
    const openPromise = manager.open({ cwd: 'C:\\ws' })
    await flush()
    await sleep(60)  // 拉开「出生」与「树杀失败」的距离
    mocks.writePidRecord.mockImplementation(async (_path: string, entries: RecordedPid[]) => {
      store = entries.map((e) => ({ ...e }))
    })
    const settleAfter = Date.now()

    const closing = manager.close()
    child.emit('exit', 0, null)
    await closing

    expect(store).toHaveLength(1)
    expect(store[0].recordedAt).toBeGreaterThanOrEqual(bornAfter)
    expect(store[0].recordedAt).toBeLessThan(settleAfter)  // 不是树杀失败那一刻
    await openPromise
  })

  it('自清理路径里进程已自然退出并清档 → 兜底插入被 guard 拦下，死 pid 不回档', async () => {
    let store: RecordedPid[] = []
    mocks.readPidRecord.mockImplementation(async () => store.map((e) => ({ ...e })))
    mocks.writePidRecord.mockImplementation(async (_path: string, entries: RecordedPid[]) => {
      store = entries.map((e) => ({ ...e }))
    })
    const child = fakeChild(8005)
    mocks.spawn.mockReturnValue(child as unknown as ChildProcess)

    // 树杀挂起，控制 settle 的时机
    let releaseKill: () => void = () => {}
    mocks.killPidTree.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseKill = () =>
            resolve({
              status: 'unverified',
              message: 'process table unavailable',
              targets: [{ pid: 8005, name: '', cmdline: null }]
            })
        })
    )

    const manager = new DshWebManager()
    const openPromise = manager.open({ cwd: 'C:\\ws' })
    await waitFor(() => store.some((e) => e.pid === 8005))

    // 非法 URL → 自清理 enqueueClose（不推进代际）→ 树杀挂起中
    child.stdout.emit('data', 'dsh web: http://evil.example.com/\n')
    await flush()
    // 树杀还没落定，进程「自然退出」：exit 处理器此时会清 ownedPids 并清档
    child.emit('exit', 0, null)
    await waitFor(() => store.length === 0)
    expect((manager as unknown as { ownedPids: Map<number, number> }).ownedPids.has(8005)).toBe(false)

    releaseKill()
    await sleep(30)  // 等 settle 跑完
    expect(store).toHaveLength(0)  // guard 拦下：没有把死 pid 重新建档

    await openPromise
  })

  it('新写的记录带 kind: root 归属标记（区分留档来源，便于排查）', async () => {
    let store: RecordedPid[] = []
    mocks.readPidRecord.mockImplementation(async () => store.map((e) => ({ ...e })))
    mocks.writePidRecord.mockImplementation(async (_path: string, entries: RecordedPid[]) => {
      store = entries.map((e) => ({ ...e }))
    })
    const child = fakeChild(8002)
    mocks.spawn.mockReturnValue(child as unknown as ChildProcess)

    const manager = new DshWebManager()
    const openPromise = manager.open({ cwd: 'C:\\ws' })
    await waitFor(() => store.some((e) => e.pid === 8002))

    expect(store[0].kind).toBe('root')

    const closing = manager.close()
    child.emit('exit', 0, null)
    await closing
    await openPromise
  })

  it('不跨会话继承身份：旧记录里的镜像名不会挂到复用了该 pid 的新进程上', async () => {
    let store: RecordedPid[] = [{ pid: 7001, name: 'cmd.exe', cmdline: null, recordedAt: 1 }]
    mocks.readPidRecord.mockImplementation(async () => store.map((e) => ({ ...e })))
    mocks.writePidRecord.mockImplementation(async (_path: string, entries: RecordedPid[]) => {
      store = entries.map((e) => ({ ...e }))
    })
    mocks.lookupImageName.mockResolvedValue(null)  // 镜像名查询失败 → 档里只该留下空身份
    const child = fakeChild(7001)
    mocks.spawn.mockReturnValue(child as unknown as ChildProcess)

    const manager = new DshWebManager()
    const openPromise = manager.open({ cwd: 'C:\\ws' })
    await waitFor(() => store[0] !== undefined && store[0].recordedAt !== 1)

    expect(store).toHaveLength(1)
    expect(store[0].name).toBe('')  // 不是上个进程的 'cmd.exe'
    expect(store[0].recordedAt).toBeGreaterThan(1)

    const closing = manager.close()
    child.emit('exit', 0, null)
    await closing
    await openPromise
  })

  it('留档写盘前再过一次归属：期间已退出/被清档的 pid 不会被迟到写回', async () => {
    const child = fakeChild(6006)
    mocks.spawn.mockReturnValue(child as unknown as ChildProcess)
    // 让镜像名查询慢到子进程退出之后才回来
    mocks.lookupImageName.mockImplementation(async () => {
      await sleep(80)
      return 'node.exe'
    })
    mocks.readPidRecord.mockResolvedValue([{ pid: 6006, name: '', cmdline: null, recordedAt: 0 }])

    const manager = new DshWebManager()
    const openPromise = manager.open({ cwd: 'C:\\ws' })
    await waitFor(() => mocks.writePidRecord.mock.calls.length > 0)
    mocks.writePidRecord.mockClear()

    // 子进程自然退出：清档 + 从 ownedPids 摘掉
    child.emit('exit', 0, null)
    await waitFor(() => mocks.writePidRecord.mock.calls.some((c) => (c[1] as unknown[]).length === 0))
    const writesAfterUnrecord = mocks.writePidRecord.mock.calls.length

    // 迟到的镜像名回来了，但 pid 已不属于本会话 → 不许再写回档里
    await sleep(120)
    expect(mocks.writePidRecord.mock.calls.length).toBe(writesAfterUnrecord)

    await openPromise
  })

  it('树杀失败时只「确保记录在」，不覆盖已有记录（空身份 target 抹不掉 spawn 时的镜像名）', async () => {
    let store: RecordedPid[] = []
    mocks.readPidRecord.mockImplementation(async () => store.map((e) => ({ ...e })))
    mocks.writePidRecord.mockImplementation(async (_path: string, entries: RecordedPid[]) => {
      store = entries.map((e) => ({ ...e }))
    })
    const child = fakeChild(6007)
    mocks.spawn.mockReturnValue(child as unknown as ChildProcess)
    // 关闭时枚举失败 → targets 里没有任何身份信息
    mocks.killPidTree.mockResolvedValue({
      status: 'unverified',
      message: 'process table unavailable',
      targets: [{ pid: 6007, name: '', cmdline: null }]
    })

    const manager = new DshWebManager()
    const openPromise = manager.open({ cwd: 'C:\\ws' })
    await waitFor(() => store.some((e) => e.name === 'cmd.exe'))

    const closing = manager.close()
    child.emit('exit', 0, null)
    await closing

    expect(store.find((e) => e.pid === 6007)?.name).toBe('cmd.exe')
    await openPromise
  })

  it('旧 spawn 的迟到补写不得覆盖复用同 pid 的新进程建档（身份令牌对不上就收手）', async () => {
    let store: RecordedPid[] = []
    mocks.readPidRecord.mockImplementation(async () => store.map((e) => ({ ...e })))
    mocks.writePidRecord.mockImplementation(async (_path: string, entries: RecordedPid[]) => {
      store = entries.map((e) => ({ ...e }))
    })
    // 第一个进程的镜像名查询挂起，迟到到「第二个进程（复用同 pid）建档之后」才回来
    let releaseFirstLookup: () => void = () => {}
    const firstLookupGate = new Promise<void>((resolve) => {
      releaseFirstLookup = resolve
    })
    let lookups = 0
    mocks.lookupImageName.mockImplementation(async () => {
      lookups++
      if (lookups === 1) await firstLookupGate
      return 'node.exe'
    })

    const childA = fakeChild(9100)
    mocks.spawn.mockReturnValueOnce(childA as unknown as ChildProcess)
    const manager = new DshWebManager()
    const openA = manager.open({ cwd: 'C:\\ws' })
    await waitFor(() => store.some((e) => e.pid === 9100))
    const bornAAt = store[0].recordedAt

    // 进程 A 自然退出：清档 + 摘掉归属令牌（此时 A 的补写还挂在查询上）
    childA.emit('exit', 0, null)
    await waitFor(() => store.length === 0)

    // 新一轮 open：OS 复用了同一个 pid 9100，B 用自己的出生观察点重新建档
    const openBStartedAt = Date.now()
    const childB = fakeChild(9100)
    mocks.spawn.mockReturnValueOnce(childB as unknown as ChildProcess)
    const openB = manager.open({ cwd: 'C:\\ws' })
    await waitFor(() => store.some((e) => e.pid === 9100 && e.name === 'node.exe'))

    // A 的迟到补写此刻才回来：令牌（A 的出生观察点）已对不上 → 不得覆盖 B 的建档
    releaseFirstLookup()
    await flush()
    await sleep(30)

    expect(store).toHaveLength(1)
    // recordedAt 必须还是 B 的出生观察点 —— 被 A 的旧观察点覆盖就等于把 B 的
    // PID 复用判据基准往回拨，多出一截冒充窗口
    expect(store[0].recordedAt).toBeGreaterThanOrEqual(openBStartedAt)
    expect(store[0].recordedAt).toBeGreaterThan(bornAAt)

    const closing = manager.close()
    childB.emit('exit', 0, null)
    await closing
    await Promise.all([openA, openB])
  })

  it('close() 树杀确认清干净时按「出生观察点令牌」清档（target 含 root 时整条移除）', async () => {
    let store: RecordedPid[] = []
    mocks.readPidRecord.mockImplementation(async () => store.map((e) => ({ ...e })))
    mocks.writePidRecord.mockImplementation(async (_path: string, entries: RecordedPid[]) => {
      store = entries.map((e) => ({ ...e }))
    })
    const child = fakeChild(9200)
    mocks.spawn.mockReturnValue(child as unknown as ChildProcess)
    mocks.killPidTree.mockResolvedValue({
      status: 'killed',
      targets: [{ pid: 9200, name: 'cmd.exe', cmdline: null }]
    })

    const manager = new DshWebManager()
    const openPromise = manager.open({ cwd: 'C:\\ws' })
    await waitFor(() => store.some((e) => e.pid === 9200))

    const closing = manager.close()
    child.emit('exit', 0, null)
    await closing

    expect(store).toHaveLength(0)
    await openPromise
  })

  it('unrecordPids 的 onlyIfRecordedAt 令牌：只清自己写的那一版，时间戳换人的不动', async () => {
    const store: RecordedPid[] = [
      { pid: 11, name: 'a.exe', cmdline: null, recordedAt: 111 },
      { pid: 22, name: 'b.exe', cmdline: null, recordedAt: 222 }
    ]
    mocks.readPidRecord.mockResolvedValue(store.map((e) => ({ ...e })))
    let written: RecordedPid[] = []
    mocks.writePidRecord.mockImplementation(async (_path: string, entries: RecordedPid[]) => {
      written = entries.map((e) => ({ ...e }))
    })

    const manager = new DshWebManager() as unknown as {
      unrecordPids(pids: readonly number[], opts?: { onlyIfRecordedAt?: number }): Promise<void>
    }
    await manager.unrecordPids([11, 22], { onlyIfRecordedAt: 222 })

    // 11 的记录时间戳不是我们写的那一版（期间已被复用进程重新建档）→ 保留；22 对上 → 清掉
    expect(written.map((e) => e.pid)).toEqual([11])
  })
})
