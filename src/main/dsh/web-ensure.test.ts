import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'
import type { BridgeHandshakeResult, BridgeRuntimePlan } from './bridge'

/**
 * 托管 ensure/acquire 的实例语义与租约生命周期测试。
 *
 * 与 web-lifecycle.test.ts 同一套边界替身（electron / spawn / proc IO 全部替换），
 * 保持真实的只有 web.ts 的状态机；桥的边界（定位/准备/握手/运行目录）用**注入**的假实现，
 * 这样「同键并发只 spawn 一次」「已就绪复用不调用会杀旧进程的 open」这类断言测的是真实分支，
 * 而不是自造 fixture 的逻辑。
 */

vi.mock('electron-log', () => ({
  default: { info: () => {}, error: () => {}, warn: () => {} }
}))

vi.mock('electron', () => ({
  app: { getPath: () => 'C:\\tmp\\lyshell-dsh-ensure-test', isPackaged: false },
  session: { fromPartition: () => ({ cookies: { set: async () => {} } }) }
}))

vi.mock('../env/refresh', () => ({ readSystemPath: async () => null, getCachedSystemPath: () => null }))

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

import { DshWebManager, type DshWebTargetResolver } from './web'
import {
  fingerprintLaunchConfig,
  launchConfigParts,
  launchEnvParts,
  materializeLaunchEnv,
  type ResolvedDshWebLaunch
} from './launch-resolve'
import { isLyShellDshWebCmdline } from './proc'

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

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 让挂起的 open() 走到「ready 行 → cookie 交换 → 桥握手」并落定 */
async function ready(child: FakeChild, port = 3080): Promise<void> {
  child.stdout.emit('data', `dsh web: http://127.0.0.1:${port}\n`)
  await sleep(20)
}

/**
 * 等到 open() 真正挂上 stdout 监听再喂数据。
 * open() 在 spawn 之前要先 await 两段关闭流程，提前 emit 会打在空气里（测试会假挂起）。
 */
async function waitForListener(stream: FakeStream, timeoutMs = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (stream.listenerCount('data') === 0) {
    if (Date.now() > deadline) throw new Error('stdout listener was not attached in time')
    await sleep(1)
  }
}

const PATCH_FILE = 'C:\\Users\\a b\\AppData\\Roaming\\lyshell\\dsh-bridge-runtime\\lyshell-harness.patch.yml'

function makeLaunch(cwd: string, env: Record<string, string> = { DSH_HOME: 'C:\\home' }): ResolvedDshWebLaunch {
  const dshHome = 'C:\\home'
  const launchEnv = materializeLaunchEnv({
    base: { PATH: 'C:\\base', ComSpec: 'C:\\cmd.exe', SystemRoot: 'C:\\Windows' },
    systemPath: null,
    overrides: env
  })
  return {
    workspaceId: null,
    cwd,
    env,
    dshHome,
    launchEnv,
    configFingerprint: fingerprintLaunchConfig([
      ...launchConfigParts({ workspaceId: '', cwd, dshHome, env }),
      ...launchEnvParts(launchEnv)
    ]),
    envKeyCount: env ? Object.keys(env).length : 0
  }
}

interface BridgeHarness {
  manager: DshWebManager
  plans: Array<{ cleaned: number; key: string; patchFile: string }>
  handshakes: Array<{ origin: string; cookie: string | null; key: string }>
  /** 队列：每次握手取出一个结果（缺省成功）；函数返回 null 表示挂起，由测试手动放行 */
  setHandshake: (impl: (call: number) => BridgeHandshakeResult | Promise<BridgeHandshakeResult>) => void
}

function makeManager(opts: { instanceId?: string; epoch?: number; withBridge?: boolean; recoverBackend?: boolean } = {}): BridgeHarness {
  const plans: BridgeHarness['plans'] = []
  const handshakes: BridgeHarness['handshakes'] = []
  let handshakeImpl: (call: number) => BridgeHandshakeResult | Promise<BridgeHandshakeResult> = () => ({
    ok: true,
    handshake: {
      protocolVersion: 2,
      instanceId: opts.instanceId ?? 'inst-1',
      instanceEpoch: opts.epoch ?? 1700000000000,
      cwd: 'C:\\ws',
      dshHome: 'C:\\home',
      hostBridge: true,
      clientBundle: true,
      controlPort: 0,
    }
  })
  const manager = new DshWebManager({
    recoverBackend: opts.recoverBackend,
    locateBridge: () => (opts.withBridge === false
      ? null
      : { dir: 'C:\\pkg\\dsh-bridge', entry: 'C:\\pkg\\dsh-bridge\\index.mjs', client: 'C:\\pkg\\dsh-bridge\\client.js', manifest: 'C:\\pkg\\dsh-bridge\\package.json' }),
    prepareBridge: () => {
      const state = { cleaned: 0, key: `k${plans.length + 1}`.repeat(8), patchFile: PATCH_FILE }
      plans.push(state)
      const plan: BridgeRuntimePlan = {
        key: state.key,
        patchFile: state.patchFile,
        runtimeDir: 'C:\\Users\\a b\\AppData\\Roaming\\lyshell\\dsh-bridge-runtime',
        bridgeDir: 'C:\\pkg\\dsh-bridge',
        childEnv: () => ({ LYSHELL_HARNESS_BRIDGE_KEY: state.key }),
        cleanup: () => {
          state.cleaned++
        }
      }
      return plan
    },
    handshake: async (call) => {
      handshakes.push(call)
      return handshakeImpl(handshakes.length)
    },
    bridgeRuntimeDir: () => 'C:\\Users\\a b\\AppData\\Roaming\\lyshell\\dsh-bridge-runtime'
  })
  return {
    manager,
    plans,
    handshakes,
    setHandshake: (impl) => {
      handshakeImpl = impl
    }
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

describe('LyShell 宿主持有、退出恢复与插件隔离', () => {
  it.runIf(process.platform === 'win32')('旧树未确认回收时显式 recover 也不能启动重叠后台', async () => {
    const child = fakeChild(7301)
    mocks.spawn.mockReturnValue(child as unknown as ChildProcess)
    mocks.attachJob.mockReturnValue(null)
    mocks.killPidTree.mockResolvedValue({ status: 'unverified', message: 'cannot verify old descendants' })
    mocks.listProcesses.mockResolvedValue(null)
    const h = makeManager({ recoverBackend: true })
    const started = h.manager.ensure(makeLaunch('C:\\ws'))
    await waitForListener(child.stdout); await ready(child); await started
    child.emit('exit', 1, null)
    expect(h.manager.recoveryStatus).toMatchObject({ lastExit: { recoveryBlocked: 'old-process-tree-unverified' } })
    const recovery = h.manager.recoverBackend()
    await flush()
    // 回归旧实现会错误地 spawn：让它完成握手，避免用超时替代结果断言。
    if (mocks.spawn.mock.calls.length > 1) await ready(child)
    expect(await recovery).toBe(false)
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    expect(mocks.killPidTree).toHaveBeenCalledWith(7301, undefined, expect.any(Object))
  })
  it('Pet 最后租约释放和页签关闭都保留后台；确认退出后有限恢复，退出 LyShell 不复活', async () => {
    const first = fakeChild(7101), second = fakeChild(7102)
    mocks.spawn.mockReturnValueOnce(first as unknown as ChildProcess).mockReturnValueOnce(second as unknown as ChildProcess)
    mocks.attachJob.mockImplementation(() => ({ close: () => true, terminate: () => true }))
    const h = makeManager({ recoverBackend: true })
    const recoveredEvent = vi.fn()
    h.manager.onBackendRecovered(recoveredEvent)
    h.setHandshake(call => ({ ok: true, handshake: { protocolVersion: 2, instanceId: `backend-${call}`,
      instanceEpoch: call, cwd: 'C:\\ws', dshHome: 'C:\\home', hostBridge: true, clientBundle: true, controlPort: 12000 + call } }))
    const launch = makeLaunch('C:\\ws')
    const started = h.manager.ensure(launch, { bindingId: 'exclusive:pet' })
    await waitForListener(first.stdout); await ready(first); await started
    h.manager.retainBackend('exclusive:pet')
    h.manager.unretainBackend('exclusive:pet'); h.manager.release('exclusive:pet')
    expect(h.manager.leaseCount).toBe(0)
    await h.manager.close()
    expect(h.manager.running).toBe(true)
    expect(h.manager.instanceIdentity?.instanceId).toBe('backend-1')
    expect(mocks.killPidTree).not.toHaveBeenCalled()
    first.stderr.emit('data', 'ENOMEM secret=do-not-log')
    first.emit('exit', 1, null)
    expect(h.manager.recoveryStatus).toMatchObject({ phase: 'waiting', lastExit: { code: 1, errorCodes: ['ENOMEM'] } })
    await waitForListener(second.stdout, 2500); await ready(second)
    expect(h.manager.instanceIdentity?.instanceId).toBe('backend-2')
    expect(recoveredEvent).toHaveBeenCalledWith({ identity: { instanceId: 'backend-2', instanceEpoch: 2 }, url: 'http://127.0.0.1:3080/', cwd: 'C:\\ws' })
    expect(JSON.stringify(h.manager.recoveryStatus)).not.toContain('do-not-log')
    await h.manager.closeForQuit(Date.now() + 100)
    second.emit('exit', 0, null)
    expect(h.manager.recoveryStatus.phase).toBe('stopped')
    expect(mocks.spawn).toHaveBeenCalledTimes(2)
    expect(mocks.spawn.mock.calls[0][2].env.LYSHELL_HARNESS_WORK_JOURNAL).toContain('harness-work')
  })

  it('退出时尚未触发的恢复计时器被取消', async () => {
    const child = fakeChild(7201)
    mocks.spawn.mockReturnValue(child as unknown as ChildProcess)
    mocks.attachJob.mockReturnValue({ close: () => true, terminate: () => true })
    const h = makeManager({ recoverBackend: true })
    const pending = h.manager.ensure(makeLaunch('C:\\ws'))
    await waitForListener(child.stdout); await ready(child); await pending
    child.emit('exit', 1, null)
    await h.manager.closeForQuit(Date.now() + 100)
    await sleep(1100)
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    expect(h.manager.recoveryStatus.phase).toBe('stopped')
  })
})

describe('托管 ensure/acquire：同一实例语义', () => {
  it('同键并发只 spawn 一次，两个调用拿到同一实例身份', async () => {
    const child = fakeChild(5001)
    mocks.spawn.mockReturnValue(child as unknown as ChildProcess)
    const h = makeManager({ instanceId: 'inst-A' })
    const launch = makeLaunch('C:\\ws')

    const p1 = h.manager.ensure(launch, { bindingId: 'b1' })
    const p2 = h.manager.ensure(launch, { bindingId: 'b2' })
    await flush()
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    await ready(child)
    const [r1, r2] = await Promise.all([p1, p2])

    expect(r1.ok && r2.ok).toBe(true)
    if (!r1.ok || !r2.ok) return
    expect(r1.identity.instanceId).toBe('inst-A')
    expect(r2.identity.instanceId).toBe('inst-A')
    expect(r1.reused).toBe(false)
    expect(r1.bindingId).toBe('b1')
    expect(r2.bindingId).toBe('b2')
    expect(h.manager.leaseCount).toBe(2)
  })

  it('合并进来的 caller 各拿自己的 binding：同 instance 两条租约，各自 release 互不影响', async () => {
    const child = fakeChild(5013)
    mocks.spawn.mockReturnValue(child as unknown as ChildProcess)
    const h = makeManager({ instanceId: 'inst-A', epoch: 77 })
    const launch = makeLaunch('C:\\ws')

    // 首 caller 与合并 caller 都带自己的 bindingId；第 3 个 caller 不带
    const p1 = h.manager.ensure(launch, { bindingId: 'bind-A' })
    const p2 = h.manager.ensure(launch, { bindingId: 'bind-B' })
    const p3 = h.manager.ensure(launch, {})
    await flush()
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    await ready(child)
    const [r1, r2, r3] = await Promise.all([p1, p2, p3])
    expect(r1.ok && r2.ok && r3.ok).toBe(true)
    if (!r1.ok || !r2.ok || !r3.ok) return

    // 各返回各的 id，绝不把首 caller 的绑定转手给后来者
    expect(r1.bindingId).toBe('bind-A')
    expect(r2.bindingId).toBe('bind-B')
    expect(r3.bindingId).toBeUndefined()
    // 两条租约指向**同一个**实例身份
    expect(h.manager.activeLeases().map((l) => l.bindingId).sort()).toEqual(['bind-A', 'bind-B'])
    expect(h.manager.activeLeases().every((l) => l.instanceId === r1.identity.instanceId)).toBe(true)
    expect(h.manager.leaseCount).toBe(2)

    // release bind-A 不得动 bind-B，也不得动共享后台
    expect(h.manager.release('bind-A')).toEqual({ released: true, backendStopped: false })
    expect(h.manager.leaseCount).toBe(1)
    expect(h.manager.activeLeases().map((l) => l.bindingId)).toEqual(['bind-B'])
    expect(h.manager.running).toBe(true)
    expect(mocks.killPidTree).not.toHaveBeenCalled()
    expect(h.plans[0].cleaned).toBe(0)
    // bind-B 仍可按自己的 epoch 正常释放
    expect(h.manager.release('bind-B', { instanceEpoch: 77 })).toEqual({ released: true, backendStopped: false })
    expect(h.manager.leaseCount).toBe(0)
    expect(h.manager.running).toBe(true)
  })

  it('已就绪同键复用：不再 spawn，也不调用会杀旧进程的 open（树杀 0 次）', async () => {
    const child = fakeChild(5002)
    mocks.spawn.mockReturnValue(child as unknown as ChildProcess)
    const h = makeManager({ instanceId: 'inst-A' })
    const launch = makeLaunch('C:\\ws')

    const first = h.manager.ensure(launch)
    await flush()
    await ready(child)
    expect((await first).ok).toBe(true)

    const second = await h.manager.ensure(launch)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.reused).toBe(true)
    expect(second.identity.instanceId).toBe('inst-A')
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    expect(mocks.killPidTree).not.toHaveBeenCalled()
    expect(h.plans.every((p) => p.cleaned === 0)).toBe(true)
  })

  it('异键冲突：明确 conflict + 当前权威值，且完全无副作用（不 spawn、不杀、不清理）', async () => {
    const child = fakeChild(5003)
    mocks.spawn.mockReturnValue(child as unknown as ChildProcess)
    const h = makeManager({ instanceId: 'inst-A' })
    const launch = makeLaunch('C:\\ws')

    const first = h.manager.ensure(launch)
    await flush()
    await ready(child)
    expect((await first).ok).toBe(true)
    const killsAfterReady = mocks.killPidTree.mock.calls.length

    const otherCwd = await h.manager.ensure(makeLaunch('C:\\other'))
    expect(otherCwd).toMatchObject({ ok: false, code: 'instance/conflict' })
    if (!otherCwd.ok) expect(otherCwd.current?.cwd).toBe('C:\\ws')

    const otherEnv = await h.manager.ensure(makeLaunch('C:\\ws', { DSH_HOME: 'C:\\home', DEEPSEEK_API_KEY: 'sk-x' }))
    expect(otherEnv).toMatchObject({ ok: false, code: 'instance/conflict' })

    const otherHome = await h.manager.ensure({ ...makeLaunch('C:\\ws'), dshHome: 'C:\\home2', configFingerprint: 'f'.repeat(64) })
    expect(otherHome).toMatchObject({ ok: false, code: 'instance/conflict' })

    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    expect(mocks.killPidTree.mock.calls.length).toBe(killsAfterReady)
    expect(h.plans.every((p) => p.cleaned === 0)).toBe(true)
    // 冲突信息里不得出现 env 键值（只有 id/路径/键数量）
    expect(JSON.stringify(otherEnv)).not.toContain('sk-x')
  })

  it('启动中的异键请求既不顶掉它、也不另起一个：instance/starting', async () => {
    const childA = fakeChild(5004)
    mocks.spawn.mockReturnValue(childA as unknown as ChildProcess)
    const h = makeManager({ instanceId: 'inst-A' })

    let releaseHandshake: () => void = () => {}
    h.setHandshake(
      () =>
        new Promise<BridgeHandshakeResult>((resolve) => {
          releaseHandshake = () =>
            resolve({
              ok: true,
              handshake: {
                protocolVersion: 2,
                instanceId: 'inst-A',
                instanceEpoch: 1700000000000,
                cwd: 'C:\\ws',
                dshHome: 'C:\\home',
                hostBridge: true,
      clientBundle: true,
      controlPort: 0,
              }
            })
        })
    )

    const pA = h.manager.ensure(makeLaunch('C:\\ws'))
    await flush()
    await ready(childA)  // 走到握手，握着不放

    const pB = await h.manager.ensure(makeLaunch('C:\\other'))
    expect(pB).toMatchObject({ ok: false, code: 'instance/starting' })
    expect(mocks.spawn).toHaveBeenCalledTimes(1)

    releaseHandshake()
    expect((await pA).ok).toBe(true)
  })

  it('无桥实例：明确 instance/no-bridge，不自动重启、不杀进程', async () => {
    const child = fakeChild(5005)
    mocks.spawn.mockReturnValue(child as unknown as ChildProcess)
    const h = makeManager()
    const launch = makeLaunch('C:\\ws')

    // 显式 open 且 bridge:'off' ⇒ 运行中但无桥
    const opened = h.manager.open({ cwd: 'C:\\ws', launch, bridge: 'off' })
    await flush()
    await ready(child)
    expect((await opened).ok).toBe(true)
    expect(h.manager.instanceIdentity).toBeNull()  // 无桥 ⇒ 没有实例身份

    const ensured = await h.manager.ensure(launch)
    expect(ensured).toMatchObject({ ok: false, code: 'instance/no-bridge' })
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    expect(mocks.killPidTree).not.toHaveBeenCalled()

    // 显式重开（用户在空闲时自己开）才会带桥 —— acquire 绝不自己重启
    const second = fakeChild(5006)
    mocks.spawn.mockReturnValueOnce(second as unknown as ChildProcess)
    const reopened = h.manager.open({ cwd: 'C:\\ws', launch })
    await flush()
    await ready(second, 3099)
    expect((await reopened).ok).toBe(true)
    expect(h.manager.instanceIdentity?.bridgeLoaded).toBe(true)
  })

  it('桥包不可用：required 直接 no-bridge（不 spawn），auto 退回无桥 Web（功能不退化）', async () => {
    const h = makeManager({ withBridge: false })
    const launch = makeLaunch('C:\\ws')
    const ensured = await h.manager.ensure(launch)
    expect(ensured).toMatchObject({ ok: false, code: 'instance/no-bridge' })
    expect(mocks.spawn).not.toHaveBeenCalled()

    const child = fakeChild(5007)
    mocks.spawn.mockReturnValue(child as unknown as ChildProcess)
    const opened = h.manager.open({ cwd: 'C:\\ws', launch })
    await flush()
    await ready(child)
    const result = await opened
    expect(result.ok).toBe(true)  // 显式 open 仍能开 Web（无桥），只是 acquire 会报 no-bridge
    expect(h.manager.instanceIdentity).toBeNull()
  })

  it('握手失败：清理 patch/凭据/进程登记，失败后重试能成功（不留假 ready）', async () => {
    const childA = fakeChild(5008)
    const childB = fakeChild(5009)
    mocks.spawn.mockReturnValueOnce(childA as unknown as ChildProcess)
      .mockReturnValueOnce(childB as unknown as ChildProcess)
    const h = makeManager()
    h.setHandshake(() => ({ ok: false, reason: 'bridge handshake returned status 404' }))

    const failed = h.manager.ensure(makeLaunch('C:\\ws'))
    await flush()
    await ready(childA)
    const failedResult = await failed
    expect(failedResult).toMatchObject({ ok: false, code: 'instance/no-bridge' })
    if (!failedResult.ok) expect(failedResult.error).toContain('handshake failed')
    expect(h.manager.instanceIdentity).toBeNull()
    // 失败路径：patch 被清理 + 进程被树杀（不留登记）
    expect(h.plans[0].cleaned).toBeGreaterThan(0)
    expect(mocks.killPidTree).toHaveBeenCalled()
    childA.emit('exit', 0, null)
    await flush()

    // 重试：桥这次正常 → 成功且是**新**进程
    h.setHandshake(() => ({
      ok: true,
      handshake: {
        protocolVersion: 2,
        instanceId: 'inst-retry',
        instanceEpoch: 1700000001000,
        cwd: 'C:\\ws',
        dshHome: 'C:\\home',
        hostBridge: true,
      clientBundle: true,
      controlPort: 0,
      }
    }))
    const retried = h.manager.ensure(makeLaunch('C:\\ws'))
    await flush()
    await ready(childB, 3100)
    const retriedResult = await retried
    expect(retriedResult.ok).toBe(true)
    if (retriedResult.ok) expect(retriedResult.identity.instanceId).toBe('inst-retry')
  })

  it('握手自报身份与请求不符：拒绝为 no-bridge（不把别的实例当同一个后台）', async () => {
    const child = fakeChild(5010)
    mocks.spawn.mockReturnValue(child as unknown as ChildProcess)
    const h = makeManager()
    h.setHandshake(() => ({
      ok: true,
      handshake: {
        protocolVersion: 2,
        instanceId: 'inst-other',
        instanceEpoch: 1700000002000,
        cwd: 'C:\\somewhere-else',
        dshHome: 'C:\\home',
        hostBridge: true,
      clientBundle: true,
      controlPort: 0,
      }
    }))
    const result = h.manager.ensure(makeLaunch('C:\\ws'))
    await flush()
    await ready(child)
    expect(await result).toMatchObject({ ok: false, code: 'instance/no-bridge' })
    expect(h.manager.instanceIdentity).toBeNull()
  })

  it('acquire 默认请求复用当前实例，不触发解析副作用', async () => {
    const child = fakeChild(5011)
    mocks.spawn.mockReturnValue(child as unknown as ChildProcess)
    const h = makeManager()
    let resolveCalls = 0
    const resolve: DshWebTargetResolver = async () => {
      resolveCalls++
      return { ok: true, launch: makeLaunch('C:\\ws') }
    }
    // 先起一个实例（默认目标路径）
    const first = h.manager.acquire(resolve, {})
    await flush()
    await ready(child)
    expect((await first).ok).toBe(true)
    expect(resolveCalls).toBe(1)

    const second = await h.manager.acquire(resolve, {})
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.reused).toBe(true)
    expect(resolveCalls).toBe(1)
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
  })

  it('启动中默认请求合并到同一个启动 Promise（不另起）', async () => {
    const child = fakeChild(5012)
    mocks.spawn.mockReturnValue(child as unknown as ChildProcess)
    const h = makeManager()
    const resolve = async () => ({ ok: true as const, launch: makeLaunch('C:\\ws') })
    const p1 = h.manager.acquire(resolve, {})
    await flush()
    const mustNotResolve: DshWebTargetResolver = async () => {
      throw new Error('must merge')
    }
    const p2 = h.manager.acquire(mustNotResolve, {})
    await ready(child)
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.ok && r2.ok).toBe(true)
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
  })

  it('合并的启动 promise 已成功落定、但 caller 尚未恢复时 close：明确 unavailable，不登记旧租约', async () => {
    const child = fakeChild(5014)
    mocks.spawn.mockReturnValue(child as unknown as ChildProcess)
    const h = makeManager({ instanceId: 'inst-A', epoch: 55 })
    const launch = makeLaunch('C:\\ws')

    // 首 caller 与合并 caller 同时挂上（同一个启动 promise）
    const p1 = h.manager.ensure(launch, { bindingId: 'bind-A' })
    const p2 = h.manager.ensure(launch, { bindingId: 'bind-B' })
    // open() 先 await 两段关闭流程才 spawn，stdout 监听要等它挂好
    await waitForListener(child.stdout)
    child.stdout.emit('data', 'dsh web: http://127.0.0.1:3310\n')
    // 握手就在此刻落定：p1/p2 的续体与 close 都被排进同一轮微任务队列，
    // close 排在并入 caller 的续体之前 ⇒ 它恢复时实例已被作废。
    await h.manager.close()
    await sleep(20)

    const r2 = await p2
    // 启动 promise 本身是成功的，但实例已被 close 作废 ⇒ 只能是明确失败，
    // 绝不能返回一个属于旧 epoch 的成功结果（那会让 caller 拿旧租约去 release/审批）。
    expect(r2).toMatchObject({ ok: false, code: 'instance/unavailable' })
    // 关键：不登记任何旧租约，也不重启
    expect(h.manager.leaseCount).toBe(0)
    expect(h.manager.instanceIdentity).toBeNull()
    expect(mocks.spawn).toHaveBeenCalledTimes(1)

    // 首 caller（先于 close 恢复的那条续体）看到的是被顶掉，同样不会留下旧租约
    const r1 = await p1
    expect(r1.ok).toBe(false)
    expect(h.manager.leaseCount).toBe(0)
  })
})

describe('租约与显式关闭', () => {
  it('release 只解绑：不杀进程、不清理桥资源、后台仍在跑', async () => {
    const child = fakeChild(6001)
    mocks.spawn.mockReturnValue(child as unknown as ChildProcess)
    const h = makeManager({ instanceId: 'inst-A', epoch: 42 })
    const ensured = h.manager.ensure(makeLaunch('C:\\ws'), { bindingId: 'bind-1' })
    await flush()
    await ready(child)
    expect((await ensured).ok).toBe(true)
    expect(h.manager.leaseCount).toBe(1)

    const released = h.manager.release('bind-1')
    expect(released).toEqual({ released: true, backendStopped: false })
    expect(h.manager.leaseCount).toBe(0)
    expect(mocks.killPidTree).not.toHaveBeenCalled()
    expect(h.plans[0].cleaned).toBe(0)
    expect(h.manager.instanceIdentity?.instanceId).toBe('inst-A')
    expect(h.manager.running).toBe(true)
  })

  it('release 的 epoch 校验：旧 epoch 拒绝，未知 binding 拒绝', async () => {
    const child = fakeChild(6002)
    mocks.spawn.mockReturnValue(child as unknown as ChildProcess)
    const h = makeManager({ epoch: 42 })
    const ensured = h.manager.ensure(makeLaunch('C:\\ws'), { bindingId: 'bind-1' })
    await flush()
    await ready(child)
    await ensured

    expect(h.manager.release('bind-1', { instanceEpoch: 41 })).toMatchObject({
      released: false,
      code: 'auth/epoch-stale'
    })
    expect(h.manager.release('bind-unknown')).toMatchObject({
      released: false,
      code: 'auth/binding-not-owned'
    })
    expect(h.manager.leaseCount).toBe(1)  // 两次拒绝都没动租约
    expect(mocks.killPidTree).not.toHaveBeenCalled()
  })

  it('显式 close 回收进程树并使旧 epoch/租约失效；close 之后旧 release 不再成立', async () => {
    const child = fakeChild(6003)
    mocks.spawn.mockReturnValue(child as unknown as ChildProcess)
    const h = makeManager({ epoch: 42 })
    const ensured = h.manager.ensure(makeLaunch('C:\\ws'), { bindingId: 'bind-1' })
    await flush()
    await ready(child)
    await ensured

    await h.manager.close()
    expect(mocks.killPidTree).toHaveBeenCalledTimes(1)
    expect(h.manager.instanceIdentity).toBeNull()
    expect(h.manager.leaseCount).toBe(0)
    expect(h.manager.running).toBe(false)
    expect(h.plans[0].cleaned).toBe(1)      // 桥运行资源随实例回收
    expect(h.manager.release('bind-1')).toMatchObject({ released: false, code: 'auth/binding-not-owned' })
  })

  it('closeForQuit 保留进程树回收语义，并同样作废实例/租约/桥资源', async () => {
    const child = fakeChild(6004)
    mocks.spawn.mockReturnValue(child as unknown as ChildProcess)
    const h = makeManager()
    const ensured = h.manager.ensure(makeLaunch('C:\\ws'), { bindingId: 'bind-1' })
    await flush()
    await ready(child)
    await ensured

    await h.manager.closeForQuit(Date.now() + 2000)
    expect(mocks.killPidTree).toHaveBeenCalledWith(6004, undefined, { deadline: expect.any(Number), ownedRootSpawnedAt: expect.any(Number) })
    expect(h.manager.instanceIdentity).toBeNull()
    expect(h.manager.leaseCount).toBe(0)
    expect(h.plans[0].cleaned).toBe(1)
  })

  it('迟到的旧实例握手不得污染新实例（旧代回调只报 superseded）', async () => {
    const childA = fakeChild(6005)
    const childB = fakeChild(6006)
    mocks.spawn.mockReturnValueOnce(childA as unknown as ChildProcess)
      .mockReturnValueOnce(childB as unknown as ChildProcess)
    const h = makeManager()

    let releaseOld: () => void = () => {}
    let callIndex = 0
    h.setHandshake(() => {
      callIndex++
      if (callIndex === 1) {
        // 老实例的握手挂起，等新实例就绪之后才回来
        return new Promise<BridgeHandshakeResult>((resolve) => {
          releaseOld = () =>
            resolve({
              ok: true,
              handshake: {
                protocolVersion: 2,
                instanceId: 'inst-OLD',
                instanceEpoch: 1,
                cwd: 'C:\\ws',
                dshHome: 'C:\\home',
                hostBridge: true,
      clientBundle: true,
      controlPort: 0,
              }
            })
        })
      }
      return {
        ok: true,
        handshake: {
          protocolVersion: 2,
          instanceId: 'inst-NEW',
          instanceEpoch: 2,
          cwd: 'C:\\ws',
          dshHome: 'C:\\home',
          hostBridge: true,
      clientBundle: true,
      controlPort: 0,
        }
      }
    })

    const pOld = h.manager.ensure(makeLaunch('C:\\ws'))
    await flush()
    await ready(childA, 3200)

    // 用户显式关掉老实例，随后新开一个：老实例的握手此后才回来
    await h.manager.close()
    const pNew = h.manager.ensure(makeLaunch('C:\\ws'))
    await flush()
    await ready(childB, 3201)
    const newResult = await pNew
    expect(newResult.ok).toBe(true)
    if (newResult.ok) expect(newResult.identity.instanceId).toBe('inst-NEW')

    releaseOld()
    await sleep(20)
    const oldResult = await pOld
    expect(oldResult.ok).toBe(false)
    expect(h.manager.instanceIdentity?.instanceId).toBe('inst-NEW')
    expect(h.manager.running).toBe(true)
  })

  it('真实迟到 cleanup：旧代资源收尾不删新代 patch，也不误登记为新实例的租约', async () => {
    const childA = fakeChild(6007)
    const childB = fakeChild(6008)
    mocks.spawn.mockReturnValueOnce(childA as unknown as ChildProcess)
      .mockReturnValueOnce(childB as unknown as ChildProcess)
    const h = makeManager()

    let releaseOld: () => void = () => {}
    let callIndex = 0
    h.setHandshake(() => {
      callIndex++
      if (callIndex === 1) {
        return new Promise<BridgeHandshakeResult>((resolve) => {
          releaseOld = () =>
            resolve({
              ok: true,
              handshake: {
                protocolVersion: 2,
                instanceId: 'inst-OLD',
                instanceEpoch: 1,
                cwd: 'C:\\ws',
                dshHome: 'C:\\home',
                hostBridge: true,
      clientBundle: true,
      controlPort: 0,
              }
            })
        })
      }
      return {
        ok: true,
        handshake: {
          protocolVersion: 2,
          instanceId: 'inst-NEW',
          instanceEpoch: 2,
          cwd: 'C:\\ws',
          dshHome: 'C:\\home',
          hostBridge: true,
      clientBundle: true,
      controlPort: 0,
        }
      }
    })

    // 旧代启动：握手握在手里（此时它的运行资源已经写好）
    const pOld = h.manager.ensure(makeLaunch('C:\\ws'), { bindingId: 'bind-OLD' })
    await flush()
    await ready(childA, 3300)

    // 显式关闭 + 新代启动并把新代资源写好、握手成功
    await h.manager.close()
    const pNew = h.manager.ensure(makeLaunch('C:\\ws'), { bindingId: 'bind-NEW' })
    await flush()
    await ready(childB, 3301)
    const newResult = await pNew
    expect(newResult.ok).toBe(true)
    if (newResult.ok) expect(newResult.bindingId).toBe('bind-NEW')
    expect(h.plans.length).toBe(2)
    expect(h.plans[1].cleaned).toBe(0)

    // 旧代握手此刻才回来（真实迟到）：只报 superseded；旧代自己的运行资源被回收是**正确**的
    // （它那一代的实例确实没了），关键是不能碰新代的资源。
    releaseOld()
    await sleep(20)
    const oldResult = await pOld
    expect(oldResult.ok).toBe(false)
    expect(h.plans[1].cleaned).toBe(0)
    // 新代仍是权威实例，租约只有新代那条
    expect(h.manager.instanceIdentity?.instanceId).toBe('inst-NEW')
    expect(h.manager.activeLeases().map((l) => l.bindingId)).toEqual(['bind-NEW'])
  })
})

describe('含空格 patch 路径的真实 spawn 形态', () => {
  it('argv 里 --patch 在 app flags 之前，Windows 命令行安全 quote 且仍命中清扫签名', async () => {
    const child = fakeChild(7001)
    mocks.spawn.mockReturnValue(child as unknown as ChildProcess)
    const h = makeManager()
    const ensured = h.manager.ensure(makeLaunch('C:\\ws'))
    await flush()

    const call = mocks.spawn.mock.calls[0] as unknown[]
    const args = call[1] as string[]
    if (process.platform === 'win32') {
      // cmd 包裹：/d /s /c "set /p … && dsh web --patch \"C:\a b\…yml\" --port 0 --no-open"
      expect(args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
      const line = args[3]
      expect(line).toContain(`--patch "${PATCH_FILE}"`)
      expect(line.indexOf('--patch')).toBeLessThan(line.indexOf('--port'))
      expect(isLyShellDshWebCmdline(line)).toBe(true)
    } else {
      expect(args).toEqual(['web', '--patch', PATCH_FILE, '--port', '0', '--no-open'])
    }
    // 子进程 env 里必须带 host-only key，且该 key 不出现在 patch 路径/命令行里
    const env = (call[2] as { env: Record<string, string> }).env
    expect(typeof env.LYSHELL_HARNESS_BRIDGE_KEY).toBe('string')
    expect(args.join(' ')).not.toContain(env.LYSHELL_HARNESS_BRIDGE_KEY)
    expect(h.plans[0].patchFile).not.toContain(env.LYSHELL_HARNESS_BRIDGE_KEY)

    await ready(child)
    await ensured
  })
})
