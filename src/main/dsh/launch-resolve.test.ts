import { describe, it, expect, vi } from 'vitest'

// launch-resolve 经 harness/config 间接引入仓库实例（electron.app.getPath），测试环境 mock 掉
// （对齐 harness/config.test.ts 与 dsh/web-lifecycle.test.ts 的做法）
vi.mock('electron-log', () => ({
  default: { info: () => {}, error: () => {}, warn: () => {} }
}))
vi.mock('electron', () => ({
  app: { getPath: () => 'C:\\tmp\\lyshell-launch-resolve-test' }
}))

import { normalizeDshHomeEnv, resolveDshHome } from './env'
import {
  buildChildEnv,
  createDshWebLaunchResolver,
  describeLaunch,
  fingerprintLaunchConfig,
  fingerprintSaltForTest,
  launchConfigParts,
  launchEnvParts,
  launchInstanceKey,
  materializeLaunchEnv,
  type DshWebLaunchResolveDeps
} from './launch-resolve'
import { createTaskSerializer } from '../harness/task-serializer'
import type { HarnessWorkspace } from '@shared/harness'
import type { HarnessAgentRuntime } from '../harness/config'

const WS: HarnessWorkspace = {
  id: 'ws-1',
  name: 'My Repo',
  cwd: '~/repo',
  envProfileId: undefined,
  isolation: 'shared',
  createdAt: 0,
  updatedAt: 0
} as unknown as HarnessWorkspace

interface Harness {
  resolver: ReturnType<typeof createDshWebLaunchResolver>
  calls: {
    serializeKeys: string[]
    worktrees: number
    ensuredDirs: string[]
    persistedKeys: Array<string | undefined>
  }
}

function makeHarness(opts: {
  workspace?: HarnessWorkspace | undefined
  normalizedEnv?: { ok: true; env?: Record<string, string> } | { ok: false; error: string }
  dshInstalled?: boolean
  cwdResolvable?: boolean
  worktreeFail?: boolean
} = {}): Harness {
  const calls: Harness['calls'] = { serializeKeys: [], worktrees: 0, ensuredDirs: [], persistedKeys: [] }
  const workspace = 'workspace' in opts ? opts.workspace : WS
  const repository = {
    get: (id: string) => (workspace && workspace.id === id ? workspace : undefined),
    update: (ws: HarnessWorkspace) => {
      calls.persistedKeys.push(ws.worktreeKey)
      return true
    }
  }
  const runtime = { kind: 'dsh', repository } as unknown as HarnessAgentRuntime
  const overrides: Partial<DshWebLaunchResolveDeps> = {
    serialize: Object.assign(
      <T,>(key: string, task: () => Promise<T>): Promise<T> => {
        calls.serializeKeys.push(key)
        return task()
      },
      { pending: 0 }
    ) as ReturnType<typeof createTaskSerializer>,
    resolveCwd: (input) =>
      opts.cwdResolvable === false
        ? { ok: false, error: 'workspace.cwd does not exist' }
        : { ok: true, path: input.replace(/^~[\\/]?/, 'C:\\Users\\u\\') },
    resolveWorktree: (async (repoCwd: string) => {
      calls.worktrees++
      return opts.worktreeFail
        ? { ok: false as const, error: 'workspace.cwd is not inside a git repository' }
        : { ok: true as const, path: `${repoCwd}\\.lyshell-worktrees\\dsh-1`, key: 'dsh-1', migrated: false }
    }) as unknown as DshWebLaunchResolveDeps['resolveWorktree'],
    resolveWorkspaceEnv: () => ({ DEEPSEEK_API_KEY: 'sk-secret-from-workspace', DSH_HOME: 'C:\\home\\space dir' }),
    resolveActiveProfileEnv: () => ({ DEEPSEEK_API_KEY: 'sk-secret-from-active', DSH_HOME: 'C:\\home\\active' }),
    normalizeEnv: opts.normalizedEnv
      ? () => opts.normalizedEnv as ReturnType<typeof normalizeDshHomeEnv>
      : normalizeDshHomeEnv,
    isDshInstalled: () => opts.dshInstalled !== false,
    resolveDshHome,
    ensureDir: (dir) => calls.ensuredDirs.push(dir),
    fingerprint: fingerprintLaunchConfig
  }
  return { resolver: createDshWebLaunchResolver(runtime, overrides), calls }
}

describe('dsh Web 启动解析服务（open 与托管 acquire 共用）', () => {
  it('默认使用 Harness 的运行时归一化，工具 PATH 进入冻结的启动环境', async () => {
    const h = makeHarness()
    const normalizeEnv = vi.fn(() => ({ ok: true as const, env: { PATH: 'managed-tools', DSH_HOME: 'C:\\home' } }))
    const overrides = { ...h.resolver.deps }
    delete (overrides as Partial<DshWebLaunchResolveDeps>).normalizeEnv
    const resolver = createDshWebLaunchResolver({ normalizeEnv } as unknown as HarnessAgentRuntime, overrides)
    const result = await resolver.resolve({ cwd: 'C:\\work' })
    expect(normalizeEnv).toHaveBeenCalledOnce()
    expect(result.ok).toBe(true)
    if (result.ok) expect(buildChildEnv(result.launch.launchEnv, resolveDshHome).PATH).toBe('managed-tools')
  })
  it('显式 cwd：用该目录 + 全局启用组的 env（与 TUI 启动同一份物化）', async () => {
    const h = makeHarness()
    const r = await h.resolver.resolve({ cwd: 'C:\\work' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.launch.cwd).toBe('C:\\work')
    expect(r.launch.workspaceId).toBeNull()
    expect(r.launch.env?.DEEPSEEK_API_KEY).toBe('sk-secret-from-active')
    expect(r.launch.dshHome).toBe('C:\\home\\active')
    expect(h.calls.ensuredDirs).toEqual([])  // 显式 cwd 不建默认目录
  })

  it('工作区 + worktree 隔离：走共享串行器与同一个 resolveLaunchWorktree', async () => {
    const ws = { ...WS, isolation: 'worktree' } as HarnessWorkspace
    const h = makeHarness({ workspace: ws })
    const r = await h.resolver.resolve({ workspaceId: 'ws-1' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(h.calls.serializeKeys).toEqual(['dsh:ws-1'])
    expect(h.calls.worktrees).toBe(1)
    expect(r.launch.cwd).toBe('C:\\Users\\u\\repo\\.lyshell-worktrees\\dsh-1')
    expect(r.launch.env?.DEEPSEEK_API_KEY).toBe('sk-secret-from-workspace')
  })

  it('缺省目标：落 $DSH_HOME/web 并确保目录存在（env 归一化之后）', async () => {
    const h = makeHarness()
    const r = await h.resolver.resolve({})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.launch.cwd).toBe('C:\\home\\active\\web')
    expect(h.calls.ensuredDirs).toEqual(['C:\\home\\active\\web'])
    expect(r.launch.workspaceId).toBeNull()
    expect(r.launch.envKeyCount).toBe(2)
  })

  it('DSH_HOME 归一化先于默认 cwd：字面 ~ 必须展开成绝对路径，不能落到字面目录', async () => {
    const h = makeHarness()
    const r = await h.resolver.resolve({})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.launch.dshHome).not.toContain('~')
    expect(r.launch.cwd.startsWith(r.launch.dshHome)).toBe(true)
  })

  it('互斥与前置失败都给出明确错误码（不静默丢参数、不猜）', async () => {
    const h = makeHarness()
    const both = await h.resolver.resolve({ workspaceId: 'ws-1', cwd: 'C:\\x' })
    expect(both).toMatchObject({ ok: false, code: 'bad-request' })

    const missingWs = await h.resolver.resolve({ workspaceId: 'nope' })
    expect(missingWs).toMatchObject({ ok: false, code: 'workspace-not-found' })

    const noDsh = makeHarness({ dshInstalled: false })
    expect(await noDsh.resolver.resolve({})).toMatchObject({ ok: false, code: 'dsh-missing' })

    const badEnv = makeHarness({ normalizedEnv: { ok: false, error: 'DSH_HOME must be an absolute path' } })
    expect(await badEnv.resolver.resolve({})).toMatchObject({ ok: false, code: 'env-invalid' })

    const badCwd = makeHarness({ cwdResolvable: false })
    expect(await badCwd.resolver.resolve({ cwd: 'C:\\nope' })).toMatchObject({ ok: false, code: 'invalid-cwd' })

    const wtFail = makeHarness({ workspace: { ...WS, isolation: 'worktree' } as HarnessWorkspace, worktreeFail: true })
    expect(await wtFail.resolver.resolve({ workspaceId: 'ws-1' })).toMatchObject({ ok: false, code: 'invalid-cwd' })
  })
})

describe('启动配置摘要与实例键（凭据不得出现在状态/日志里）', () => {
  const launch = (over: Partial<{
    workspaceId: string | null
    cwd: string
    dshHome: string
    env: Record<string, string>
    systemPath: string | null
  }> = {}) => {
    const workspaceId = over.workspaceId ?? null
    const cwd = over.cwd ?? 'C:\\ws'
    const dshHome = over.dshHome ?? 'C:\\home'
    const env = over.env ?? { DEEPSEEK_API_KEY: 'sk-a' }
    const launchEnv = materializeLaunchEnv({
      base: { PATH: 'C:\\base-path', ComSpec: 'C:\\cmd.exe' },
      systemPath: over.systemPath === undefined ? 'C:\\sys-path' : over.systemPath,
      overrides: env
    })
    return {
      workspaceId,
      cwd,
      dshHome,
      env,
      launchEnv,
      configFingerprint: fingerprintLaunchConfig([
        ...launchConfigParts({ workspaceId: workspaceId ?? '', cwd, dshHome, env }),
        ...launchEnvParts(launchEnv)
      ]),
      envKeyCount: Object.keys(env).length
    }
  }

  it('同配置同键；cwd / DSH_HOME / workspaceId / env 任一变化即异键', () => {
    const base = launch()
    expect(launchInstanceKey(base)).toBe(launchInstanceKey(launch()))
    expect(launchInstanceKey(base)).not.toBe(launchInstanceKey(launch({ cwd: 'C:\\other' })))
    expect(launchInstanceKey(base)).not.toBe(launchInstanceKey(launch({ dshHome: 'C:\\other' })))
    expect(launchInstanceKey(base)).not.toBe(launchInstanceKey(launch({ workspaceId: 'ws' })))
    expect(launchInstanceKey(base)).not.toBe(
      launchInstanceKey(launch({ env: { DEEPSEEK_API_KEY: 'sk-b' } }))
    )
  })

  it('Windows 上路径大小写无关（同一个实例不该因为大小写被判冲突）', () => {
    const a = launchInstanceKey(launch({ cwd: 'C:\\WS' }))
    const b = launchInstanceKey(launch({ cwd: 'c:\\ws' }))
    if (process.platform === 'win32') expect(a).toBe(b)
    else expect(a).not.toBe(b)
  })

  it('摘要不可逆且不包含凭据明文；权威值视图只给 id/路径/键数量', () => {
    const l = launch({ env: { DEEPSEEK_API_KEY: 'sk-super-secret' } })
    expect(l.configFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(l.configFingerprint).not.toContain('sk-super-secret')
    expect(fingerprintSaltForTest()).not.toBe('')
    const view = describeLaunch(l)
    expect(view).toEqual({ workspaceId: null, cwd: 'C:\\ws', dshHome: 'C:\\home', envKeyCount: 1 })
    expect(JSON.stringify(view)).not.toContain('sk-super-secret')
    expect(JSON.stringify(view)).not.toContain('DEEPSEEK_API_KEY')
  })

  it('摘要含**实际启动环境**：覆盖相同但系统 PATH / 父进程环境不同 ⇒ 异键', () => {
    const base = launch()
    // 只改「即时系统 PATH」的实际取值：override 完全一样，仍必须是不同实例
    expect(launchInstanceKey(base)).not.toBe(launchInstanceKey(launch({ systemPath: 'C:\\other-path' })))
    // 系统 PATH 从有到无（读不到）
    expect(launchInstanceKey(launch({ systemPath: null }))).not.toBe(launchInstanceKey(launch({ systemPath: 'C:\\sys-path' })))
    // 同一份快照 ⇒ 同键（这条是「不漂移」的反向保证）
    expect(launchInstanceKey(base)).toBe(launchInstanceKey(launch()))
  })

  it('**值**变化（仍非空）也必须是异键：父环境 PATH 与继承的 provider 键值都参与摘要', () => {
    const launchWith = (over: {
      systemPath?: string | null
      base?: Record<string, string | undefined>
      overrides?: Record<string, string>
    } = {}) => {
      const env = over.overrides ?? { DEEPSEEK_API_KEY: 'sk-a' }
      const launchEnv = materializeLaunchEnv({
        base: over.base ?? { PATH: 'C:\\base-path', ComSpec: 'C:\\cmd.exe' },
        systemPath: over.systemPath === undefined ? 'C:\\sys-path' : over.systemPath,
        overrides: Object.keys(env).length > 0 ? env : undefined
      })
      return {
        workspaceId: null,
        cwd: 'C:\\ws',
        dshHome: 'C:\\home',
        env: Object.keys(env).length > 0 ? env : undefined,
        launchEnv,
        // 与 resolve() 同一套组合（配置部分 + 启动环境部分），这样实例键的差异只可能来自启动环境
        configFingerprint: fingerprintLaunchConfig([
          ...launchConfigParts({ workspaceId: '', cwd: 'C:\\ws', dshHome: 'C:\\home', env }),
          ...launchEnvParts(launchEnv)
        ]),
        envKeyCount: Object.keys(env).length
      }
    }
    // set/unset 完全相同，只有**值**不同 ⇒ 必须是两个不同实例
    const p1 = launchWith({ systemPath: 'C:\\path-a' })
    const p2 = launchWith({ systemPath: 'C:\\path-b' })
    expect(launchEnvParts(p1.launchEnv)).not.toEqual(launchEnvParts(p2.launchEnv))
    expect(launchInstanceKey(p1)).not.toBe(launchInstanceKey(p2))

    // 父进程 env 里的 provider endpoint/key 变化同样要改键（此前被 set/unset 口径漏掉）。
    // 这里 overrides 传空：父环境就是实际启动环境，只有「值」在变。
    const inherited1 = launchWith({ overrides: {}, base: { PATH: 'C:\\base-path', DEEPSEEK_BASE_URL: 'https://a.example' } })
    const inherited2 = launchWith({ overrides: {}, base: { PATH: 'C:\\base-path', DEEPSEEK_BASE_URL: 'https://b.example' } })
    expect(launchEnvParts(inherited1.launchEnv)).not.toEqual(launchEnvParts(inherited2.launchEnv))
    const key1 = launchWith({ overrides: {}, base: { PATH: 'C:\\base-path', DEEPSEEK_API_KEY: 'sk-1' } })
    const key2 = launchWith({ overrides: {}, base: { PATH: 'C:\\base-path', DEEPSEEK_API_KEY: 'sk-2' } })
    expect(launchEnvParts(key1.launchEnv)).not.toEqual(launchEnvParts(key2.launchEnv))
    // 走完整实例键也要变（不只是启动环境部分）
    expect(launchInstanceKey(inherited1)).not.toBe(launchInstanceKey(inherited2))
    expect(launchInstanceKey(key1)).not.toBe(launchInstanceKey(key2))
    // 摘要里不得出现值的明文（只有加盐摘要）
    expect(JSON.stringify(launchEnvParts(inherited1.launchEnv))).not.toContain('a.example')
    expect(JSON.stringify(launchEnvParts(key1.launchEnv))).not.toContain('sk-1')
    // 同一份快照两次算出来必须一致（否则「同键复用」会被摘要抖动破坏）
    expect(launchEnvParts(inherited1.launchEnv)).toEqual(launchEnvParts(inherited1.launchEnv))
  })
})

describe('启动环境快照（解析与 spawn 同一次结果）', () => {
  const paths: Record<string, string | undefined> = { PATH: 'C:\\base-path', ComSpec: 'C:\\cmd.exe', USERPROFILE: 'C:\\u' }

  it('launchEnv 物化：系统 PATH 覆盖 base.PATH，配置 env 覆盖两者，base 是复制件', () => {
    const base = { ...paths }
    const launchEnv = materializeLaunchEnv({ base, systemPath: 'C:\\sys', overrides: { DSH_HOME: 'C:\\home' } })
    const child = buildChildEnv(launchEnv, resolveDshHome)
    expect(child.PATH).toBe('C:\\sys')
    expect(child.USERPROFILE).toBe('C:\\u')       // 父进程环境仍继承
    expect(child.DSH_HOME).toBe('C:\\home')       // 配置 env 最后覆盖
    base.PATH = 'MUTATED'
    expect(launchEnv.base.PATH).toBe('C:\\base-path')  // 快照与外部引用解耦
  })

  it('解析结果带走实际启动环境快照，spawn 不再二次读系统环境', async () => {
    const h = makeHarness()
    const r = await h.resolver.resolve({ cwd: 'C:\\work' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const child = buildChildEnv(r.launch.launchEnv, resolveDshHome)
    // 解析时物化的覆盖值确实进入实际启动环境（不是只进摘要）
    expect(child.DEEPSEEK_API_KEY).toBe('sk-secret-from-active')
    expect(child.DSH_HOME).toBe('C:\\home\\active')
    // 快照不携带桥的 host-only key（它只在 spawn 那一刻注入）
    expect(Object.keys(child)).not.toContain('LYSHELL_HARNESS_BRIDGE_KEY')
  })

  it('解析后修改父环境**不影响已解析的启动环境**（快照已冻结，不再读 process.env）', async () => {
    const parentEnv: Record<string, string | undefined> = { PATH: 'C:\\p1', KEEP: 'v1' }
    const h = makeHarness()
    h.resolver.deps.parentEnv = () => ({ ...parentEnv })
    h.resolver.deps.readSystemPath = () => 'C:\\sys-1'

    const first = await h.resolver.resolve({ cwd: 'C:\\work' })
    expect(first.ok).toBe(true)
    if (!first.ok) return

    // 解析之后父环境整体换掉（含 provider key）
    parentEnv.PATH = 'C:\\p2'
    parentEnv.DEEPSEEK_API_KEY = 'sk-mutated'
    delete parentEnv.KEEP

    const child = buildChildEnv(first.launch.launchEnv, resolveDshHome)
    expect(child.PATH).toBe('C:\\sys-1')            // 系统 PATH 也在快照里，不再重读
    expect(child.KEEP).toBe('v1')
    expect(child.DEEPSEEK_API_KEY).toBe('sk-secret-from-active')  // 配置覆盖值按快照走
    expect(first.launch.launchEnv.base.PATH).toBe('C:\\p1')

    // 同一份输入重新解析（父环境已变）⇒ 键必须不同，说明父环境值真的参与摘要
    const second = await h.resolver.resolve({ cwd: 'C:\\work' })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.launch.configFingerprint).not.toBe(first.launch.configFingerprint)
  })

  it('Windows 大小写别名：PATH / Path 视为同一个变量，覆盖后不留重复键', () => {
    const launchEnv = materializeLaunchEnv({
      base: { Path: 'C:\\from-base' },
      systemPath: 'C:\\from-system',
      overrides: { path: 'C:\\from-override' }
    })
    const child = buildChildEnv(launchEnv, resolveDshHome)
    const pathKeys = Object.keys(child).filter((k) => k.toLowerCase() === 'path')
    if (process.platform === 'win32') {
      expect(pathKeys.length).toBe(1)
      expect(child[pathKeys[0]]).toBe('C:\\from-override')
    } else {
      // POSIX 区分大小写：三个不同名变量各自保留
      expect(child.Path).toBe('C:\\from-base')
      expect(child.PATH).toBe('C:\\from-system')
      expect(child.path).toBe('C:\\from-override')
    }
  })
})
