import { createHash, randomBytes } from 'crypto'
import { mkdirSync } from 'fs'
import { resolve } from 'path'
import type { HarnessWorkspace } from '@shared/harness'
import type { HarnessAgentRuntime } from '../harness/config'
import { resolveActiveProfileEnv, resolveWorkspaceEnv } from '../harness/config'
import { resolveWorkspaceCwd, type ResolvedCwd } from '../harness/cwd'
import { detectDependencies } from '../harness/detect'
import { launchResolveSerializer, type TaskSerializer } from '../harness/task-serializer'
import { resolveLaunchWorktree, type LaunchWorktreeResult } from '../harness/worktree'
import { readSystemPath } from '../env/refresh'
import { childEnvironment } from '../env/child-environment'
import { normalizeDshHomeEnv, resolveDshHome, type NormalizedEnvResult } from './env'

/**
 * dsh Web 后台的「启动配置解析」服务 —— `dsh:web:open`（显式重开）与托管 acquire/ensure
 * 共用同一份解析，禁止各自再拼一套环境。
 *
 * 解析链（与 TUI 启动同语义，逐条见 handlers 旧实现）：
 *   cwd：工作区目录 → 显式 cwd → `$DSH_HOME/web` 默认目录（不存在则建）
 *   env：工作区绑定组 → 全局启用组 → legacy ws.env → 系统环境变量（kind 物化）
 *   worktree：仅 `isolation === 'worktree'` 的工作区，走与 TUI 同一个串行器 + 存量迁移
 *   DSH_HOME：经 normalizeDshHomeEnv 归一化后再据此解析默认 cwd（顺序不能反）
 *
 * 本模块不直接 import Electron；仓库/依赖探测/目录创建都可注入，便于单测。
 */

export interface DshWebLaunchTarget {
  /** 工作区 id；与 cwd 互斥（同传 ⇒ bad-request） */
  workspaceId?: string
  /** 显式工作目录；与 workspaceId 互斥 */
  cwd?: string
}

/**
 * 解析结果。
 *
 * **不可跨边界**：本对象内部持有 `launchEnv`（**含 env 明文值**，可能是 DEEPSEEK_API_KEY 等凭据），
 * 只在主进程内传给 DshWebManager。不得经 HTTP / IPC / 状态 / 日志暴露它；
 * `configFingerprint` 是加盐摘要（不可逆、含随机盐），但它同样只用于进程内两两比较。
 * 需要给外部看的权威值一律走 `describeLaunch()`（只有 id/路径/键数量）。
 */
export interface ResolvedDshWebLaunch {
  readonly workspaceId: string | null
  readonly cwd: string
  readonly env?: Record<string, string>
  readonly dshHome: string
  /**
   * **实际启动环境快照**（唯一权威值）：解析时物化，spawn 时直接照用，不再二次读 process.env。
   * 否则「摘要里的配置」和「真正给子进程的环境」会各读一次系统环境而漂移。
   * 桥的 host-only key **不在**这里（它只在 spawn 那一刻注入，见 web.ts open()）。
   */
  readonly launchEnv: MaterializedLaunchEnv
  readonly configFingerprint: string
  /** env 键数量（诊断用；**不**回显键名与值） */
  readonly envKeyCount: number
}

/** 物化后的启动环境（键值可能来自 process.env，故值为 string | undefined）。 */
export interface MaterializedLaunchEnv {
  /** 父进程环境快照（复制，不持有引用） */
  readonly base: Record<string, string | undefined>
  /** 即时读到的系统 PATH（读不到时为 null，表示沿用 base 里的 PATH 别名） */
  readonly systemPath: string | null
  /** 叠加的配置 env（工作区/启用组物化结果） */
  readonly overrides: Record<string, string> | undefined
}

/**
 * 物化实际启动环境快照：父进程环境 + 即时系统 PATH + 配置 env（覆盖顺序即 buildChildEnv 的顺序）。
 * 这是「启动环境」的唯一定义处：解析时算一次并冻结，spawn 直接照用（不再二次读系统环境）。
 */
export function materializeLaunchEnv(input: {
  base: Record<string, string | undefined>
  systemPath?: string | null
  overrides?: Record<string, string>
}): MaterializedLaunchEnv {
  return {
    base: childEnvironment(input.base),
    systemPath: input.systemPath ?? null,
    overrides: input.overrides ? { ...input.overrides } : undefined
  }
}

/** 环境变量名比较口径：Windows 大小写无关（PATH / Path 是同一个变量）。 */
function envKeyKey(name: string): string {
  return process.platform === 'win32' ? name.toLowerCase() : name
}

/**
 * 由快照展开子进程 env（**不含**桥的 host-only key —— 那个由调用方在 spawn 前最后注入）。
 * 覆盖顺序：父进程 env → 系统 PATH → 配置 env；DSH_HOME 的字面 `~` 在此展开。
 * 大小写口径：Windows 上后写者直接覆盖同名（不论大小写）的既有条目，不留重复键。
 */
export function buildChildEnv(
  launchEnv: MaterializedLaunchEnv,
  resolveDshHome: (raw?: string) => string
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = {}
  const put = (name: string, value: string | undefined): void => {
    if (value === undefined) return
    if (process.platform === 'win32') {
      const existing = Object.keys(merged).find((k) => envKeyKey(k) === envKeyKey(name))
      if (existing !== undefined && existing !== name) delete merged[existing]
    }
    merged[name] = value
  }
  for (const [name, value] of Object.entries(launchEnv.base)) put(name, value)
  if (launchEnv.systemPath) put('PATH', launchEnv.systemPath)
  if (launchEnv.overrides) {
    for (const [name, value] of Object.entries(launchEnv.overrides)) put(name, value)
  }
  if (merged.DSH_HOME) merged.DSH_HOME = resolveDshHome(merged.DSH_HOME)
  return merged
}

/**
 * 参与「同键」比较的启动环境部分：对**最终实际 childEnv**（即 buildChildEnv 的结果，
 * 不含 host 随机 key）的**键值**做加盐摘要。
 *
 * 为什么必须含值：继承自父进程的 provider endpoint / key、以及系统 PATH 的实际取值，
 * 都决定子进程真正跑在哪个环境里 —— 父环境改了值（哪怕仍非空）就不再是同一个启动环境。
 * 摘要不可逆且带进程内随机盐，故值不会以明文进入 key/状态/日志。
 */
export function launchEnvParts(launchEnv: MaterializedLaunchEnv | undefined): string[] {
  if (!launchEnv) return []
  const childEnv = buildChildEnv(launchEnv, resolveDshHome)
  const names = Object.keys(childEnv).sort()
  const values: string[] = [`count=${names.length}`]
  for (const name of names) values.push(`env:${name}=${childEnv[name] ?? ''}`)
  return [`launchEnvDigest=${fingerprintLaunchConfig(values)}`]
}

export type DshWebLaunchErrorCode =
  | 'bad-request'
  | 'workspace-not-found'
  | 'invalid-cwd'
  | 'env-invalid'
  | 'dsh-missing'

export type DshWebLaunchResolveResult =
  | { ok: true; launch: ResolvedDshWebLaunch }
  | { ok: false; code: DshWebLaunchErrorCode; error: string }

export interface DshWebLaunchResolveDeps {
  /** 工作区解析串行器：与 TUI 启动共用同一实例，否则并发双启动会撞 worktree 迁移 */
  serialize: TaskSerializer
  resolveCwd: (input: string) => ResolvedCwd
  resolveWorktree: typeof resolveLaunchWorktree
  resolveWorkspaceEnv: (
    runtime: HarnessAgentRuntime,
    workspace: HarnessWorkspace
  ) => Record<string, string> | undefined
  resolveActiveProfileEnv: (runtime: HarnessAgentRuntime) => Record<string, string> | undefined
  normalizeEnv: (env?: Record<string, string>) => NormalizedEnvResult
  isDshInstalled: () => boolean | Promise<boolean>
  resolveDshHome: (raw?: string) => string
  /**
   * 即时读系统 PATH（与 spawn 侧 readSystemPath 同一来源）。
   * 解析时读一次并**冻结进快照**，spawn 不再读第二次。
   */
  readSystemPath: () => string | null | Promise<string | null>
  /** 父进程环境快照（生产 = process.env 的复制） */
  parentEnv: () => Record<string, string | undefined>
  /** 确保默认目录存在（$DSH_HOME/web） */
  ensureDir: (dir: string) => void
  /** 有效启动配置 → 加盐摘要（不含凭据明文） */
  fingerprint: (parts: readonly string[]) => string
}

/**
 * 摘要盐：每次主进程启动随机生成。
 * 目的：即便某处误把 fingerprint 写进日志/状态，也无法离线枚举比对出凭据取值
 * （而进程内两两比较仍然成立 —— 这正是唯一需要的用途）。
 */
const FINGERPRINT_SALT = randomBytes(16).toString('hex')

/** 有效启动配置 → 加盐摘要。纯计算，不落盘、不打日志。 */
export function fingerprintLaunchConfig(parts: readonly string[]): string {
  const hash = createHash('sha256')
  hash.update(FINGERPRINT_SALT)
  for (const part of parts) {
    hash.update('\u0000')
    hash.update(part)
  }
  return hash.digest('hex')
}

/** 供测试断言「盐确实参与摘要」用；生产代码不得依赖其取值。 */
export function fingerprintSaltForTest(): string {
  return FINGERPRINT_SALT
}

export function defaultDshWebResolveDeps(): DshWebLaunchResolveDeps {
  return {
    serialize: launchResolveSerializer,
    resolveCwd: resolveWorkspaceCwd,
    resolveWorktree: resolveLaunchWorktree,
    resolveWorkspaceEnv,
    resolveActiveProfileEnv,
    normalizeEnv: normalizeDshHomeEnv,
    isDshInstalled: async () => detectDependencies(['dsh'], (await readSystemPath()) ?? undefined).dsh,
    resolveDshHome,
    readSystemPath: () => readSystemPath(),
    parentEnv: () => ({ ...process.env }),
    ensureDir: (dir) => {
      mkdirSync(dir, { recursive: true })
    },
    fingerprint: fingerprintLaunchConfig
  }
}

export interface DshWebLaunchResolver {
  resolve: (target: DshWebLaunchTarget) => Promise<DshWebLaunchResolveResult>
  deps: DshWebLaunchResolveDeps
}

/**
 * 构造启动解析服务。`runtime` 由调用方传入（handler 用 HARNESS_AGENTS.dsh），
 * 因此本模块不必知道三元运行时注册表，也就不引入 electron 依赖。
 */
export function createDshWebLaunchResolver(
  runtime: HarnessAgentRuntime,
  overrides: Partial<DshWebLaunchResolveDeps> = {}
): DshWebLaunchResolver {
  const deps: DshWebLaunchResolveDeps = {
    ...defaultDshWebResolveDeps(),
    // 与工作区 CLI 共用环境归一化，包含 LyShell 自有 pnpm 的 PATH。
    normalizeEnv: runtime.normalizeEnv ?? normalizeDshHomeEnv,
    ...overrides
  }

  const resolveTarget = async (target: DshWebLaunchTarget): Promise<DshWebLaunchResolveResult> => {
    const { workspaceId, cwd: rawCwd } = target
    // workspaceId 与 cwd 互斥：同传时目录与 env 语义歧义（目录取工作区还是 cwd？env 取工作区链
    // 还是已启用组？），明确拒绝而非静默丢 cwd（旧实现 workspaceId 分支会直接忽略 rawCwd）。
    if (workspaceId !== undefined && rawCwd !== undefined) {
      return { ok: false, code: 'bad-request', error: 'workspaceId and cwd are mutually exclusive' }
    }

    // 启动前复核 dsh 是否仍在 PATH 上（仅 dsh，不依赖 dsh-tui，故只扫 dsh 一个二进制）
    if (!await deps.isDshInstalled()) {
      return { ok: false, code: 'dsh-missing', error: 'dsh not installed' }
    }

    let envSource: Record<string, string> | undefined
    let cwdPath: string | undefined
    if (workspaceId !== undefined) {
      const workspace = runtime.repository.get(workspaceId)
      if (!workspace) return { ok: false, code: 'workspace-not-found', error: 'Workspace not found' }
      const cwd = deps.resolveCwd(workspace.cwd)
      if (!cwd.ok) return { ok: false, code: 'invalid-cwd', error: cwd.error }
      cwdPath = cwd.path
      // worktree 隔离与 TUI 启动同语义：Web 也在专属 worktree 里跑；key 决策与存量迁移
      // 同 TUI 启动（共享名优先，缺省生成可读 key 并回填持久化），且共用同一串行化器
      if (workspace.isolation === 'worktree') {
        const wt: LaunchWorktreeResult = await deps.serialize(`dsh:${workspaceId}`, async () => {
          const fresh = runtime.repository.get(workspaceId)
          if (!fresh) return { ok: false as const, error: 'Workspace not found' }
          return deps.resolveWorktree(cwd.path, 'dsh', fresh, (key) =>
            runtime.repository.update({ ...fresh, worktreeKey: key })
          )
        })
        if (!wt.ok) return { ok: false, code: 'invalid-cwd', error: wt.error }
        cwdPath = wt.path
      }
      // 与 TUI 启动同一份解析结果（绑定组 → 已启用组 → legacy → 系统）
      envSource = deps.resolveWorkspaceEnv(runtime, workspace)
    } else {
      // 无工作区可绑：env 走「全局启用组（按 dsh 映射物化）→ 系统」—— 与 TUI 启动同一份解析
      envSource = deps.resolveActiveProfileEnv(runtime)
      if (rawCwd !== undefined) {
        const cwd = deps.resolveCwd(rawCwd)
        if (!cwd.ok) return { ok: false, code: 'invalid-cwd', error: cwd.error }
        cwdPath = cwd.path
      }
    }

    // 先归一化 DSH_HOME（相对/空白兜底），再据其解析默认 cwd —— 否则默认分支会拿到未展开
    // 的 ~ 或相对路径，在错误位置 mkdir。
    const envResult = deps.normalizeEnv(envSource)
    if (!envResult.ok) return { ok: false, code: 'env-invalid', error: envResult.error }

    const dshHome = deps.resolveDshHome(envResult.env?.DSH_HOME ?? process.env.DSH_HOME)

    // 默认分支（既无 workspaceId 也无 cwd）才落 $DSH_HOME/web，且必须在 env 归一化之后
    if (cwdPath === undefined) {
      const dir = resolve(dshHome, 'web')
      deps.ensureDir(dir)
      cwdPath = dir
    }

    const workspaceKey = workspaceId ?? ''
    const env = envResult.env
    // 实际启动环境在这一刻定型：父进程 env + 即时系统 PATH + 配置 env。
    // 摘要与 spawn 都取这份快照 —— 否则「解析时看到的配置」与「真正启动的环境」会各读一次
    // process.env / 系统 PATH（用户中途改环境变量就漂移成两个不同实例）。
    const launchEnv = materializeLaunchEnv({
      base: deps.parentEnv(),
      systemPath: await deps.readSystemPath(),
      overrides: env
    })
    return {
      ok: true,
      launch: {
        workspaceId: workspaceId ?? null,
        cwd: cwdPath,
        env,
        dshHome,
        launchEnv,
        configFingerprint: deps.fingerprint([
          ...launchConfigParts({ workspaceId: workspaceKey, cwd: cwdPath, dshHome, env }),
          ...launchEnvParts(launchEnv)
        ]),
        envKeyCount: env ? Object.keys(env).length : 0
      }
    }
  }

  return { resolve: resolveTarget, deps }
}

/**
 * 参与「是不是同一个实例配置」比较的字段（顺序固定）。
 * 只放配置事实，不放凭据明文之外的任何东西 —— env 的值本身会进摘要输入，但摘要不可逆。
 */
export function launchConfigParts(input: {
  workspaceId: string
  cwd: string
  dshHome: string
  env?: Record<string, string>
}): string[] {
  const parts = [`workspaceId=${input.workspaceId}`, `cwd=${pathKey(input.cwd)}`, `dshHome=${pathKey(input.dshHome)}`]
  const env = input.env
  if (env) {
    for (const key of Object.keys(env).sort()) parts.push(`env:${key}=${env[key]}`)
  }
  return parts
}

/** 路径比较口径：Windows 大小写无关，POSIX 区分。 */
export function pathKey(input: string): string {
  const normalized = resolve(input)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/**
 * 实例「同键」判据：workspaceId + cwd + DSH_HOME + 有效启动配置摘要。
 * 两个请求同键 ⇒ 可以复用同一后台；不同键 ⇒ conflict（不静默切换）。
 */
export function launchInstanceKey(launch: ResolvedDshWebLaunch): string {
  return [
    launch.workspaceId ?? '',
    pathKey(launch.cwd),
    pathKey(launch.dshHome),
    launch.configFingerprint
  ].join('|')
}

/** 供状态/日志的**权威值**摘要：只含路径与 id，不含 env 键值。 */
export function describeLaunch(launch: ResolvedDshWebLaunch): {
  workspaceId: string | null
  cwd: string
  dshHome: string
  envKeyCount: number
} {
  return {
    workspaceId: launch.workspaceId,
    cwd: launch.cwd,
    dshHome: launch.dshHome,
    envKeyCount: launch.envKeyCount
  }
}
