import { spawn, type ChildProcess } from 'child_process'
import { session, app } from 'electron'
import http from 'http'
import https from 'https'
import { join } from 'path'
import log from 'electron-log'
import { DSH_WEB_PARTITION } from '@shared/constants'
import { readSystemPath, getCachedSystemPath } from '../env/refresh'
import { resolveDshHome } from './env'
import { attachDshProcessJob, type DshProcessJob } from './windows-job'
import {
  BRIDGE_RUNTIME_DIR_NAME,
  buildLaunchLine,
  checkBridgeIdentity,
  locateBridgePackage,
  prepareBridgeRuntime,
  quoteWindowsCmdArg,
  requestBridgeHandshake,
  UnsafeBridgePathError,
  type BridgeHandshakeResult,
  type BridgePackageLocation,
  type BridgeRuntimePlan,
  type DshInstanceIdentity
} from './bridge'
import {
  buildChildEnv,
  describeLaunch,
  fingerprintLaunchConfig,
  launchConfigParts,
  launchEnvParts,
  launchInstanceKey,
  materializeLaunchEnv,
  type DshWebLaunchResolveResult,
  type DshWebLaunchTarget,
  type ResolvedDshWebLaunch
} from './launch-resolve'
import {
  DSH_WEB_COMMAND,
  buildDshWebSpawnArgs,
  killPidTree,
  collectDescendantPids,
  findOrphanDshWebPids,
  isLyShellDshWebCmdline,
  isPidAlive,
  listProcesses,
  lookupImageName,
  readPidRecord,
  recoverRecordedPids,
  sweepOrphanDshWeb,
  writePidRecord,
  type KillTreeResult,
  type ProcDeps
} from './proc'

/**
 * DeepSeek Harness Web UI 进程管理 —— spawn `dsh web --port 0`，解析 stdout 回显的真实端口，
 * 拿到 URL 后交给渲染层 <webview> 加载。Windows 上先将 cmd 包裹层加入 Job，
 * 再放行 dsh 启动；关闭 Job 时由内核终止整棵子进程树。
 *
 * 关键事实（源码 + 实测双确认，见 memory/dsh-web-port-process-behavior.md）：
 *   - `dsh web` = `dsh --profile web`，无独立二进制；
 *   - `--port 0` → OS 随机分配；stdout 单行 `dsh web: http://127.0.0.1:PORT` 即 ready 信号；
 *   - 冷启动 ~18s（加载 ~200 插件），故 ready 超时给足 60s；单前台 node 进程。
 *   - `dsh web` 默认会在启动后调起系统默认浏览器（web-app 的 openBrowser 默认 true），
 *     但 LyShell 把 UI 嵌在自家 <webview> 里，无需系统浏览器，故 spawn 时固定追加 `--no-open`。
 *
 * spawn 签名（`DSH_WEB_COMMAND` + `DSH_WEB_SPAWN_ARGS`）与 proc.ts 的孤儿 matcher 同源，
 * 改参数只改 proc.ts 那一处常量 —— 两边各写一份字面量的话 sweep 会静默失效。
 */

const READY_TIMEOUT_MS = 60_000
const READY_RE = /dsh web:\s+(https?:\/\/\S+)/i
// ready 行很短，60s 超时窗口内 stdout 缓冲封顶，防止静默期无限增长
const READY_MAX_BUF = 8192

/**
 * 交互路径（关窗、切工作区、IPC 关闭）树杀的时间上界。
 *
 * 这些调用方不等结果，但 close() 是**串行**的：一轮卡住会把后续的 open/close 全堵在队列里。
 * 给个上界，最坏情况也只是「少补几刀 + 留档给下次启动兜底」，而不是把队列永久钉住。
 * （退出路径另走 closeForQuit，它用更硬的预算抢跑，不排这条队列。）
 */
const DEFAULT_CLOSE_BUDGET_MS = 15_000

/** spawn 后查镜像名的重试次数 / 间隔 / 总预算：刚 spawn 完偶尔会瞬时查不到，查不到就只能留空身份。 */
const IDENTITY_LOOKUP_ATTEMPTS = 3
const IDENTITY_LOOKUP_RETRY_MS = 200
/** 整条「查镜像名」链路的预算上限。它是 best-effort，拖太久只会让留档迟迟不落盘。 */
const IDENTITY_LOOKUP_BUDGET_MS = 1200

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 失败分类 —— 供托管 acquire 映射到协议错误码（`instance/no-bridge` 501 / `instance/unavailable` 503 …）。
 * `superseded`/`starting` 只在管理器内部出现，不映射到「需要用户重启」的语义。
 */
export type DshWebFailureCode = 'no-bridge' | 'unavailable' | 'superseded' | 'managed'

export type DshWebLaunchResult =
  | { ok: true; url: string }
  | { ok: false; error: string; code?: DshWebFailureCode }

/**
 * 桥装载模式：
 *   - `auto`（显式 open 的默认）：桥包可用就带桥启动**且必须握手成功**才算 ready；
 *     桥包不可用（开发环境未随包、路径不安全）则照旧不开桥 —— Web UI 功能不退化。
 *   - `required`（托管 acquire）：桥不可用/握手失败一律失败（`no-bridge`），**绝不**降级成
 *     一个没有桥的实例。
 *   - `off`：显式不要桥（诊断/回归用）。
 */
export type DshBridgeMode = 'auto' | 'required' | 'off'

export interface DshWebOpenOptions {
  cwd: string
  env?: Record<string, string>
  bridge?: DshBridgeMode
  /** 已解析的启动目标：用于「同键」判据与冲突报错；缺省时按 cwd/env 现算一个等价键 */
  launch?: ResolvedDshWebLaunch
}

/** 管理器对外可注入的边界（测试与打包态区分）；生产走 defaultDshWebManagerDeps()。 */
export interface DshWebManagerDeps {
  /** 定位随包发布的桥包；null ⇒ 无桥 */
  locateBridge?: () => BridgePackageLocation | null
  /** 准备宿主 owned 运行资源（确定性 patch 文件 + 运行期随机 host-only key） */
  prepareBridge?: (opts: {
    cwd: string
    runtimeDir: string
    location: BridgePackageLocation
  }) => BridgeRuntimePlan
  /** 桥握手（host-only；真实实现是回环 HTTP + 内存 cookie） */
  handshake?: (opts: { origin: string; cookie: string | null; key: string }) => Promise<BridgeHandshakeResult>
  /** 宿主 owned 运行目录（userData 下；绝不写进 DSH_HOME / 工作区） */
  bridgeRuntimeDir?: () => string
}

/**
 * 生产默认边界。**没有真实 Electron app 就不启用桥**：桥包的定位依赖安装布局
 * （`app.isPackaged` + `process.resourcesPath` / `app.getAppPath()`），拿不到这些事实时
 * 只能判「无桥」—— 而不是猜一个路径。单测因此天然走无桥分支，可用构造参数注入假边界。
 */
export function defaultDshWebManagerDeps(): DshWebManagerDeps {
  return {
    locateBridge: () => {
      if (typeof app?.isPackaged !== 'boolean') return null
      return locateBridgePackage({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        devRoot: app.getAppPath()
      })
    },
    prepareBridge: prepareBridgeRuntime,
    handshake: (opts) => requestBridgeHandshake({ origin: opts.origin, cookie: opts.cookie, key: opts.key }),
    bridgeRuntimeDir: () => join(app.getPath('userData'), BRIDGE_RUNTIME_DIR_NAME)
  }
}

/** 从 dsh stdout 的 ready 行解析回显 URL（未校验）。纯函数，便于单测；无匹配返回 null。 */
export function parseReadyUrl(stdout: string): string | null {
  const match = READY_RE.exec(stdout)
  return match ? match[1] : null
}

/**
 * 校验 dsh 回显的 URL 必须是本机回环地址 + 显式端口，且不带内嵌凭证。
 * 通过则返回归一化 URL（host 小写、剥离 path/query/hash），否则 null。
 * 纯函数 —— webview 初始 src 与主进程导航白名单都依赖它，绝不放行外站。
 */
export function validateLoopbackUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username || url.password) return null
  const host = url.hostname.toLowerCase()
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') return null
  if (!url.port) return null
  url.pathname = '/'
  url.search = ''
  url.hash = ''
  return url.toString()
}

const COOKIE_EXCHANGE_TIMEOUT_MS = 5_000

/** 一条 set-cookie 头的解析结果。纯数据，值都不脱/不编码，原样透传。 */
export interface ParsedCookie {
  name: string
  value: string
  path: string
  httpOnly: boolean
  sameSite: 'strict' | 'lax' | 'no_restriction'
  maxAge?: number
}

/** ParsedCookie → Electron cookies.set() 入参的一对一映射结果。纯数据，不含电子层的引用。 */
export interface CookieDetails {
  url: string
  name: string
  value: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite: 'strict' | 'lax' | 'no_restriction'
  expirationDate?: number
}

/**
 * 将 ParsedCookie 映射为 Electron session.cookies.set() 的入参。
 * 纯函数，便于单测 —— origin 拼接、secure 透传、Max-Age → expirationDate 的算术都在此。
 */
export function toCookieDetails(
  entry: ParsedCookie,
  origin: string,
  secure: boolean,
  nowSec: number
): CookieDetails {
  const result: CookieDetails = {
    url: origin + (entry.path.startsWith('/') ? entry.path : '/' + entry.path),
    name: entry.name,
    value: entry.value,
    path: entry.path,
    secure,
    httpOnly: entry.httpOnly,
    sameSite: entry.sameSite
  }
  if (entry.maxAge !== undefined) {
    result.expirationDate = nowSec + entry.maxAge
  }
  return result
}

/**
 * 解析单条 set-cookie 头字符串（如 `dsh-auth-xxx=v1.yyy; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`）。
 * 纯函数，便于单测；解析失败返回 null。
 */
export function parseSetCookieEntry(header: string): ParsedCookie | null {
  const parts = header.split(';')
  const first = parts[0]
  if (!first) return null
  const eqIdx = first.indexOf('=')
  if (eqIdx <= 0) return null
  const name = first.slice(0, eqIdx).trim()
  const value = first.slice(eqIdx + 1).trim()
  if (!name) return null

  let path = '/'
  let httpOnly = false
  // 缺省 'strict' 是有意收窄:浏览器缺省 'lax'(Chrome 80+),但 dsh web 的 auth cookie
  // 仅用于本地回环,不需要跨站导航携带,用 Strict 更安全。
  let sameSite: ParsedCookie['sameSite'] = 'strict'
  let maxAge: number | undefined
  // 注:未解析 Expires 属性。当前 dsh 用 Max-Age,若未来出现只带 Expires 的 cookie,
  // 缺失 maxAge 字段会使其退化成会话 cookie(关闭 webview 即失效)。如需支持,
  // 可解析 Expires 并转为 expirationDate,但 parseSetCookieEntry 只返回 maxAge,
  // 需在 toCookieDetails 里再转。

  for (let i = 1; i < parts.length; i++) {
    const attr = parts[i].trim()
    const aeq = attr.indexOf('=')
    const key = (aeq === -1 ? attr : attr.slice(0, aeq)).toLowerCase()
    const val = aeq === -1 ? '' : attr.slice(aeq + 1).trim()

    switch (key) {
      case 'path':
        if (val) path = val
        break
      case 'httponly':
        httpOnly = true
        break
      case 'max-age':
        if (val) {
          const n = parseInt(val, 10)
          if (!isNaN(n)) maxAge = n
        }
        break
      case 'samesite':
        if (val) {
          const v = val.toLowerCase()
          if (v === 'lax') sameSite = 'lax'
          else if (v === 'none') sameSite = 'no_restriction'
          // strict 为默认,其他值忽略
        }
        break
    }
  }

  return { name, value, path, httpOnly, sameSite, ...(maxAge !== undefined ? { maxAge } : {}) }
}

/**
 * 从**最终 childEnv** 取 cmd.exe：Windows 上大小写无关（ComSpec / COMSPEC / comspec 同名），
 * 且必须在 overrides 合入之后取 —— 否则命令行用的 shell 与子进程 env 里的 ComSpec 可以不一致。
 */
export function comSpecFromEnv(env: Record<string, string | undefined>): string | undefined {
  for (const [name, value] of Object.entries(env)) {
    if (name.toLowerCase() === 'comspec') {
      const trimmed = typeof value === 'string' ? value.trim() : ''
      if (trimmed) return trimmed
    }
  }
  return undefined
}

/**
 * 缺省解析结果下的等价启动键（显式 open 没走解析服务时用）。
 * env 参与摘要但**不回显** —— 与解析服务同一份 fingerprintLaunchConfig（加盐），
 * 并且同样把**实际启动环境快照**计入：否则「解析出来的键」与「直接 open 出来的键」
 * 会在系统 PATH 变化时各算各的，同一个后台被判成两个配置。
 */
function synthesizeLaunch(cwd: string, env?: Record<string, string>): ResolvedDshWebLaunch {
  const launchEnv = materializeLaunchEnv({
    base: { ...process.env },
    systemPath: getCachedSystemPath(),
    overrides: env
  })
  const dshHome = resolveDshHome(env?.DSH_HOME ?? process.env.DSH_HOME)
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

/** 托管 acquire 的错误码：与 protocol-v1.ts §2 的错误码同名，S3 直接映射到 HTTP 状态。 */
export type DshAcquireErrorCode =
  | 'bad-request'
  | 'workspace-not-found'
  | 'invalid-cwd'
  | 'env-invalid'
  | 'dsh-missing'
  | 'instance/conflict'
  | 'instance/no-bridge'
  | 'instance/starting'
  | 'instance/unavailable'

/** 冲突/无桥时报给调用方的**当前实例权威值**（只有 id 与路径，没有 env 键值、没有凭据）。 */
export interface DshInstanceAuthoritativeView {
  workspaceId: string | null
  cwd: string
  dshHome: string
  envKeyCount: number
}

export type DshEnsureResult =
  | {
      ok: true
      /** true = 复用了既有实例（此路径**没有**调用 open()，也就没有 kill 旧进程） */
      reused: boolean
      url: string
      identity: DshInstanceIdentity
      bindingId?: string
    }
  | {
      ok: false
      code: DshAcquireErrorCode
      error: string
      /** 明示当前实例的权威值，便于调用方判断是「要显式重开」还是「请求错了」 */
      current?: DshInstanceAuthoritativeView
    }

export type DshReleaseResult =
  | { released: true; backendStopped: false }
  | { released: false; code: 'auth/epoch-stale' | 'auth/binding-not-owned' | 'instance/unavailable'; error: string }

/** 目标 → 启动参数解析（由 dsh/launch-resolve.ts 提供；open 与 acquire 共用同一实现）。 */
export type DshWebTargetResolver = (target: DshWebLaunchTarget) => Promise<DshWebLaunchResolveResult>

export class DshWebManager {
  private child: ChildProcess | null = null
  private url: string | null = null
  /** 代际计数器：每次 open() 自增；旧进程的异步回调据此判废，避免误清新进程指针。 */
  private generation = 0
  /**
   * close() 排队链。并发调用排在前一次后面，而不是立刻返回 —— 否则 handlers 的
   * 「等树杀落定再回」（dsh:web:close）与 open() 的「close 完再 spawn」在并发下都不成立。
   */
  private closing: Promise<void> = Promise.resolve()
  /**
   * 正在被树杀的 pid（doClose 已经把 this.child 清空，退出路径只能从这里拿到目标）。
   * 没有它，closeForQuit 在「关窗先起了一轮树杀、随后才退出」时就找不到该抢跑杀谁。
   */
  private killingPid: number | null = null
  /** Windows 内核 Job 按进程实例持有；关闭 handle 会终止整个子进程树。 */
  private readonly jobs = new Map<number, DshProcessJob>()
  /** 树杀未确认时保留目标；下一次 open 必须先回收它，不能直接再起一个占同一会话锁的实例。 */
  private pendingPid: number | null = null
  /**
   * pid 留档的串行队列。留档是 read-modify-write（readPidRecord → 改 → writePidRecord），
   * 而它同时会被三条路径碰：启动恢复、spawn 留档、关闭清档。不互斥就会互相覆盖 ——
   * 典型后果是新 spawn 的 root pid 记录被并发的清档整体覆盖掉，下次启动无从兜底。
   * （进程内互斥足够：留档文件在 userData 下，同一 userData 同时跑两个实例不是本项目的形态。）
   *
   * 注意它只保证「写的原子性」，不保证生命周期顺序 —— 迟到的写仍可能把刚清掉的 pid 写回去，
   * 所以每条写都带 ownedPids 守卫（见 recordPids 的 guard）。
   */
  private recordLock: Promise<void> = Promise.resolve()
  /**
   * 本会话 spawn 出来的（或正在被树杀的）pid → 该进程的「出生观察点」（spawn 前一刻取的
   * 时钟）。启动恢复必须跳过这些 pid：恢复读到的旧记录里若有一个 pid 恰好被本会话的新进程
   * 复用（镜像名还一样），不设这道门就会把刚起来的 dsh 杀掉。
   *
   * 值（出生观察点）同时是后续异步归属操作的**身份令牌**，也是 recordedAt 的唯一定格时刻：
   * 留档无论写几次（空身份先落、镜像名补上、树杀失败再兜底插入），时间戳都必须回到这一个点
   * —— 它是下次启动「PID 复用」判据的基准，写晚一秒，复用进程就多一秒的冒充窗口（镜像名
   * 同名时时间判据是唯一的拦路闸）。
   *
   * 更要紧的是归属判定本身：ownedPids.has(pid) 挡不住「旧进程的 pid 被新 spawn 复用」——
   * Set 语义下，旧异步任务（recordSpawnedPid 的迟到补写、settlePidRecord 的迟到清档）手里
   * 的 pid 分不清新旧进程，迟到的写会把新进程的建档按旧观察点覆盖（伪造它的复用判据基准），
   * 迟到的清档会把新进程的留档整条删掉。Map 值让每条归属操作核对「这个 pid 的出生观察点
   * 还是不是我 spawn 时的那一个」，对不上就说明期间换过人，旧任务一律收手。
   */
  private readonly ownedPids = new Map<number, number>()
  /**
   * 本会话的起始时刻。留档里 recordedAt 不早于它的记录都是**本会话**写下的，
   * 不属于「上次遗留」，启动恢复不该碰（幂等，也免得和刚 spawn 的进程赛跑）。
   * 唯一失真是系统时钟被回拨：旧记录可能被误判成本会话的 —— 那是「漏杀」，不是误杀。
   */
  private readonly sessionStartedAt = Date.now()

  /** 可注入边界（桥定位/准备/握手、宿主运行目录）；不传即生产默认。 */
  private readonly deps: DshWebManagerDeps

  /**
   * 当前**已就绪**实例（ready = 子进程活着 **且** 桥握手成功）。
   * 只有它就是「可以被 acquire 复用的同一实例」；没有它时 acquire 决不调用 open()
   * （open() 会先杀旧实例 —— 复用路径绝不能走它）。
   */
  private readyInstance: {
    generation: number
    key: string
    url: string
    launch: ResolvedDshWebLaunch
    identity: DshInstanceIdentity
    plan: BridgeRuntimePlan | null
    /** 桥自报的Pet 托管控制回环端口（0/缺省 = 本桥没有控制面） */
    controlPort: number
  } | null = null

  /**
   * 正在启动中的实例：`promise` 是**同一个**启动 Promise，同键并发请求全部合并到它，
   * 异键请求既不排队顶掉它、也不另起一个（明确 `instance/starting`）。
   */
  private starting: {
    key: string
    promise: Promise<DshEnsureResult>
    /** 本次启动的目标（合并请求要拿它重试，不能靠猜当前实例） */
    launch: ResolvedDshWebLaunch
    currentView: DshInstanceAuthoritativeView
  } | null = null

  /**
   * 运行中实例的启动键（**即使没有桥**也登记）：用于把「运行中但无桥」与「运行中且键不同」
   * 分开 —— 前者明确 `instance/no-bridge`（不自动重启），后者明确 `instance/conflict`。
   */
  private runningLaunch: { key: string; launch: ResolvedDshWebLaunch } | null = null

  /**
   * 租约（bindingId → 该绑定看到的实例身份）。`release` 只解绑，**绝不** kill 共享后台；
   * epoch 在实例换代后失效（旧 epoch 的 release / 迟到回执一律拒绝）。
   */
  private readonly leases = new Map<string, { instanceId: string; instanceEpoch: number; key: string }>()

  /**
   * 托管 keep-alive 持有者（S4）：只要有持有者，就不允许通过 close()/open() 关闭或重启
   * 这个共享后台。持有者是具名集合（幂等），解绑只影响这一个名字。
   */
  private readonly backendHolders = new Set<string>()
  /** profile 写入锁独立于后台代际，旧实例清理不得把安装中的锁一起清除。 */
  private profileMutationHolder: string | null = null

  constructor(deps: DshWebManagerDeps = defaultDshWebManagerDeps()) {
    this.deps = deps
  }

  get running(): boolean {
    return this.child !== null
  }

  get currentUrl(): string | null {
    return this.url
  }

  /** 当前就绪实例的身份（未就绪返回 null）。凭据与 env 值都不在这里。 */
  get instanceIdentity(): DshInstanceIdentity | null {
    return this.readyInstance ? { ...this.readyInstance.identity } : null
  }

  /**
   * 当前实例的启动配置（cwd / DSH_HOME），未运行返回 null。
   *
   * 用量读数需要用它把「哪个目录的会话」定位到 `$DSH_HOME/sessions` 下的日志：
   * 先取就绪实例的 launch，启动中/无桥实例退到 runningLaunch —— 都是真实启动过的目标，
   * 没有运行时就交给调用方按默认目标解析，绝不在这里猜路径。
   */
  get currentLaunch(): ResolvedDshWebLaunch | null {
    return this.readyInstance?.launch ?? this.runningLaunch?.launch ?? null
  }

  /**
   * 桥的Pet 托管控制端点（回环端口 + host-only key，**只内存**）。
   * 未就绪/旧版桥（没报 controlPort）返回 null ⇒ Pet 托管控制明确报 bridge/unavailable，不降级。
   */
  get bridgeControlEndpoint(): { port: number; key: string } | null {
    const ready = this.readyInstance
    if (!ready || !this.child || !ready.plan) return null
    if (!ready.controlPort) return null
    return { port: ready.controlPort, key: ready.plan.key }
  }

  /** 是否有任何租约持有该后台（页签关闭/释放判定用；S4 会读它）。 */
  get leaseCount(): number {
    return this.leases.size
  }

  /**
   * 托管 keep-alive 持有者（宿主模块登记的「这条后台有活的任务/视图在用它」）。
   *
   * S4 语义：只要还有持有者，`close()` / `dsh:web:open` 都**不得**杀这个共享后台 ——
   * 关闭详情 overlay 只 detach 视图，显式重开也会被明确拒绝（官方 Web 写操作保持可用）。
   * 退出路径不受影响：`closeForQuit` 仍走原 Job/进程树回收。
   */
  retainBackend(holderId: string): void {
    if (!holderId) return
    this.backendHolders.add(holderId)
  }

  /** 解除一个 keep-alive 持有者（只解绑，绝不 kill）。 */
  unretainBackend(holderId: string): void {
    this.backendHolders.delete(holderId)
  }

  beginProfileMutation(holderId: string): boolean {
    if (!holderId || this.running || this.isManaged || this.killingPid !== null || this.pendingPid !== null) return false
    this.profileMutationHolder = holderId
    return true
  }

  endProfileMutation(holderId: string): void {
    if (this.profileMutationHolder === holderId) this.profileMutationHolder = null
  }

  /** 当前是否有托管持有者（Pet 托管控制 / 共享工作台详情）。 */
  get isManaged(): boolean {
    return this.backendHolders.size > 0 || this.profileMutationHolder !== null
  }

  /** 当前 keep-alive 持有者快照（诊断/测试；不含凭据）。 */
  managedHolders(): string[] {
    return [...this.backendHolders, ...(this.profileMutationHolder ? [this.profileMutationHolder] : [])]
  }

  /**
   * 启动 `dsh web [--patch <abs>] --port 0 --no-open`，解析 stdout 拿 URL；
   * 已运行则先关闭旧的（同一时刻至多一个 web 实例）—— 这是**显式重开**语义，
   * 复用路径（ensure/acquire）绝不走它。
   *
   * 带桥启动时：**bridge handshake 成功之后**才 resolve `{ok:true}`；任何失败路径都会
   * 清掉启动登记、临时 patch 与内存凭据，不留「假 ready」。
   */
  async open(opts: DshWebOpenOptions): Promise<DshWebLaunchResult> {
    // 托管期间（Pet 托管控制 / 共享工作台详情持有）绝不走显式重开：open() 会先杀旧实例，
    // 那会打断 Pet 正在跑的任务。明确拒绝，调用方改走 acquire 复用路径。
    if (this.isManaged) {
      log.warn(`[dsh web] explicit reopen refused while managed by: ${this.managedHolders().join(', ')}`)
      return { ok: false, error: 'the shared dsh web backend has active consumers; disconnect them before reopening', code: 'managed' }
    }
    // 先推进代际再关闭旧实例：旧进程退出时其 exit/error 回调因 generation 不匹配被忽略，
    // 不会把随后 spawn 的新进程 this.child 清成 null（快速切换工作区导致的孤儿进程根因）。
    const generation = ++this.generation
    // 这里刻意走 enqueueClose() 而不是 close()：close() 会推进 generation 来作废「在飞的 open」，
    // 在这里用它等于当场把自己作废，永远走不到 spawn。
    await this.enqueueClose()
    // 兜底清扫崩溃/强杀遗留的孤儿 dsh web —— DSH 的会话写锁不过期，孤儿不死锁不放，
    // 不清新实例一起来就撞「当前会话已被占用」。只杀「签名命中 + 父进程链已断」的；
    // 另一个活着的 LyShell 实例托管的**通常**不动（残余误杀面见 isAnchoredProcess 的说明）。
    // 顺带自愈：close() 万一只杀掉 cmd.exe 包裹层、漏了 node 孙进程，此刻它的父已死，
    // 正好落进孤儿定义里被收掉。
    await sweepOrphanDshWeb()
    await this.clearPendingIfGone()
    if (this.pendingPid !== null) {
      return { ok: false, error: 'Previous dsh web process is still being cleaned up; try again later', code: 'unavailable' }
    }
    // 这一段 await 期间可能已被顶掉，且顶掉它的**可能是 close() 而不是新的 open()** ——
    // 关窗 / 退出时来一条 close() 请求，若这里不认它，醒来照样 spawn，进程就再没人回收了。
    // 故 close() 也会推进 generation，两种顶替在这里一视同仁。
    if (generation !== this.generation) {
      return { ok: false, error: 'dsh web open was superseded by a newer request', code: 'superseded' }
    }
    // 清理旧进程期间可能开始安装市场：安装持有者先于 CLI 写盘认领后台，
    // 此时不得再启动一个读同一 profile 的实例。
    if (this.isManaged) {
      return { ok: false, error: 'the shared dsh backend is in use; try again after the current operation', code: 'managed' }
    }

    // 桥的隔离运行资源（本次独有的运行目录 + 运行期随机 host-only key）必须在 spawn 之前备好：
    // key 只经 env 进子进程，patch 只写宿主 owned 目录。任一步失败按模式降级/报错，绝不半开。
    const bridgeMode: DshBridgeMode = opts.bridge ?? 'auto'
    let plan: BridgeRuntimePlan | null = null
    if (bridgeMode !== 'off') {
      try {
        const location = this.deps.locateBridge?.() ?? null
        if (location) {
          const runtimeDir = this.deps.bridgeRuntimeDir
            ? this.deps.bridgeRuntimeDir()
            : join(app.getPath('userData'), BRIDGE_RUNTIME_DIR_NAME)
          plan = (this.deps.prepareBridge ?? prepareBridgeRuntime)({
            cwd: opts.cwd,
            runtimeDir,
            location
          })
        }
      } catch (error) {
        // 路径不安全（cmd 元字符）或写盘失败：明确按「桥不可用」处理，绝不带着半成品启动
        plan = null
        log.warn('dsh web bridge preparation failed:', (error as Error).message)
      }
      if (!plan && bridgeMode === 'required') {
        return { ok: false, error: 'harness bridge package is unavailable', code: 'no-bridge' }
      }
    }

    const onWindows = process.platform === 'win32'
    let launchCommand = ''
    let spawnArgs: string[] = []
    try {
      spawnArgs = buildDshWebSpawnArgs(plan ? plan.patchFile : null)
      // Windows 走 cmd.exe /c「整行」，含空格路径必须安全 quote（POSIX 是数组传参，不经 shell）
      launchCommand = buildLaunchLine(DSH_WEB_COMMAND, spawnArgs, onWindows ? quoteWindowsCmdArg : (a) => a)
    } catch (error) {
      plan?.cleanup()
      const reason = error instanceof UnsafeBridgePathError ? 'bridge patch path is not cmd-safe' : 'failed to build launch command'
      log.warn('dsh web launch line rejected:', reason)
      return { ok: false, error: reason, code: 'no-bridge' }
    }

    // 启动键：同键 = 同一实例配置（workspaceId/cwd/DSH_HOME/有效启动配置摘要）。
    // 没有解析结果时按 cwd+env 现算一个等价键 —— 显式 open 也能被 acquire 正确判「同键/异键」。
    if (!opts.launch) await readSystemPath()
    if (generation !== this.generation) { plan?.cleanup(); return { ok: false, error: 'dsh web open was superseded', code: 'superseded' } }
    const launch: ResolvedDshWebLaunch = opts.launch ?? synthesizeLaunch(opts.cwd, opts.env)
    const launchKey = launchInstanceKey(launch)
    // 期望的 DSH_HOME：调用方给了已解析目标就以它为准（与解析服务同一份决定），
    // 否则按子进程 env 现算 —— 桥自报的 DSH_HOME 必须与这个值一致才算「同一个后台」。
    const expectedDshHome = opts.launch ? opts.launch.dshHome : resolveDshHome(opts.env?.DSH_HOME ?? process.env.DSH_HOME)

    return new Promise<DshWebLaunchResult>((resolve) => {
      let settled = false
      let readyHandled = false  // 命中 ready 行即刻锁门，不等 exchange/handshake 结束才防重入
      let stdoutBuf = ''
      let stderrBuf = ''

      /** 失败路径统一的桥资源回收：删 patch + 丢弃 key（内存），不留半个桥。 */
      const dropBridge = (): void => {
        if (!plan) return
        try {
          plan.cleanup()
        } catch (err) {
          log.warn('dsh web bridge cleanup failed:', (err as Error).message)
        }
      }

      const finish = (result: DshWebLaunchResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (generation !== this.generation) {
          // 被更新的 open()/close() 顶掉：不碰 this.url/this.child（那是新一代的指针），
          // 但 promise 必须落定 —— 否则渲染层那个 openDshWeb 会一直挂着
          dropBridge()
          resolve({ ok: false, error: 'dsh web open was superseded by a newer request', code: 'superseded' })
          return
        }
        this.url = result.ok ? result.url : null
        if (!result.ok) {
          this.runningLaunch = null
          this.readyInstance = null
          dropBridge()
        }
        resolve(result)
      }

      // 子进程 env 一律取自**解析时冻结的启动环境快照**（没有快照才现算），
      // 不再二次读 process.env / 系统 PATH —— 否则摘要里的配置与实际启动环境会漂移。
      const launchEnv = launch.launchEnv ?? materializeLaunchEnv({
        base: { ...process.env },
        systemPath: getCachedSystemPath(),
        overrides: opts.env
      })
      const childEnvBase = buildChildEnv(launchEnv, resolveDshHome)
      // host-only 凭据**最后**注入：工作区 env 里的同名键不能覆盖/伪造它。
      const bridgeEnv = plan ? plan.childEnv() : undefined
      const childEnv = bridgeEnv ? { ...childEnvBase, ...bridgeEnv } : childEnvBase

      // 出生观察点必须取在 spawn 之前：spawn 到落盘之间进程可能已经死过一轮，取晚了
      // 会把复用进程的出生时刻包进「不晚于记录」的冒充窗口里（见 ownedPids 注释）。
      const spawnedAt = Date.now()
      // cmd.exe 取自**最终 childEnv**（含配置 overrides，大小写无关）：否则「决定启动方式的
      // 环境」与摘要/实际子进程环境可以指向不同的 shell。
      const comSpec = comSpecFromEnv(childEnv) ?? 'cmd.exe'
      // cmd 先阻塞在 stdin，等主进程把它加入 Job 后才执行 dsh。
      // 这样 dsh/node 不会抢在 AssignProcessToJobObject 前出生并漏出 Job。
      const child = spawn(onWindows ? comSpec : DSH_WEB_COMMAND,
        onWindows ? ['/d', '/s', '/c', `set /p LYSHELL_DSH_GATE= && ${launchCommand}`] : spawnArgs, {
        cwd: opts.cwd,
        env: childEnv,
        shell: false,
        // launchCommand 已按 cmd 规则引用参数；禁止 Node 再把内部双引号转成 \"。
        windowsVerbatimArguments: onWindows,
        windowsHide: true,
        stdio: [onWindows ? 'pipe' : 'ignore', 'pipe', 'pipe']
      })
      this.child = child
      this.runningLaunch = { key: launchKey, launch }
      // 新实例开始启动：上一代的就绪登记与租约立即作废（旧 epoch 不再可用）。
      this.readyInstance = null
      this.leases.clear()
      // 先登记「这个 pid 是本会话的」（值 = 出生观察点，兼作后续归属操作的身份令牌），
      // 再留档 —— 启动恢复可能正并发跑着，这道门保证它绝不会把这个刚 spawn 的进程当成遗留物收掉。
      if (child.pid) this.ownedPids.set(child.pid, spawnedAt)
      let jobForChild: DshProcessJob | null = null
      if (child.pid) {
        try {
          const job = attachDshProcessJob(child.pid, spawnedAt)
          if (job) {
            jobForChild = job
            this.jobs.set(child.pid, job)
          }
          else if (process.platform === 'win32') log.warn('dsh web Job Object unavailable; using verified PID cleanup')
        } catch (err) {
          log.warn('dsh web Job Object setup failed:', err)
        }
      }
      // Job 成功与否都要放行：失败时由核对过身份的 PID 回收路径兜底。
      if (onWindows) {
        child.stdin?.on('error', () => { /* cmd 已提前退出，后续 exit/error 事件负责清理 */ })
        child.stdin?.end('start\n')
      }
      // 留档 root pid：崩溃/强杀后 WMI 枚举若也读不出进程表，下次启动还能靠
      // recoverRecordedPids 核对身份后重试回收；无法读取命令行/父链时会保留记录。
      // 但必须吞掉 rejection —— writePidRecord 的磁盘/权限错误若逃逸成未处理 rejection，
      // 在 main 进程里足以把整个 app 打挂（dev 下 uncaughtException 直接退出）。
      if (child.pid) {
        void this.recordSpawnedPid(child.pid, spawnedAt).catch((err) =>
          log.warn('dsh web pid record failed:', (err as Error).message)
        )
      }

      const timer = setTimeout(() => {
        log.warn('dsh web ready timeout, killing child')
        // 自清理走 enqueueClose()：不推进 generation，否则下面的 finish 会被当成「被顶掉」，
        // 把「启动超时」误报成 superseded。close() 不 reject（doClose 全程吞错），.catch 只是保险丝
        void this.enqueueClose().catch((err) => log.warn('dsh web close after ready timeout failed:', err))
        finish({ ok: false, error: 'Timed out waiting for dsh web to start' })
      }, READY_TIMEOUT_MS)

      child.stdout?.setEncoding('utf-8')
      child.stdout?.on('data', (chunk: string) => {
        // readyHandled: 命中 ready 行立刻置位，锁住 exchange 期间的 5s 重入窗口。
        // settled: 失败收尾路径（非法 URL close() 后 finish 已置位），缓冲里那条非法
        //   匹配会一直留着，之后每个 stdout chunk 都重新命中——用 settled 兜底短路。
        if (readyHandled || settled) return
        stdoutBuf = (stdoutBuf + chunk).slice(-READY_MAX_BUF)
        const raw = parseReadyUrl(stdoutBuf)
        if (!raw) return
        // 回显 URL 必须通过 loopback+port 校验 —— 恶意/异常 dsh stdout 注入外站时在此拦截
        const url = validateLoopbackUrl(raw)
        if (!url) {
          log.warn('dsh web emitted a non-loopback URL, rejected:', raw)
          // 同上：自清理不推进代际，失败原因才不会被误报成 superseded
          void this.enqueueClose().catch((err) => log.warn('dsh web close after bad url failed:', err))
          finish({ ok: false, error: 'dsh web emitted an unexpected URL' })
          return
        }
        readyHandled = true
        log.info(`dsh web ready: ${url}`)
        // dsh web 的鉴权是 cookie 模型：GET /?token=… → 303 + Set-Cookie → GET /(带 cookie) → 200。
        // validateLoopbackUrl 会剥掉 ?token=…，若直接交给 webview 加载就是永久 401。因此先由
        // 主进程用 raw URL（含 token）发一次请求把 cookie 换进 persist:dshweb 这个 partition
        // 的 cookie jar，再照旧把干净的 origin-only URL 交给渲染层。
        // 注意：exchange 的 http 请求（≤5s）会推迟 ready IPC 的 resolve，但仍在 60s 总超时窗口内。
        void (async () => {
          const cookie = await this.exchangeTokenForCookie(raw)
          if (!plan) {
            finish({ ok: true, url })
            return
          }
          // 带桥启动：**必须完成 host-only 握手**才算 ready —— 否则就是「假 ready」
          // （后台起来了但没有桥，S3 的任务/审批面根本不存在）。
          const result = await (this.deps.handshake ?? ((o) =>
            requestBridgeHandshake({ origin: o.origin, cookie: o.cookie, key: o.key })))({
            origin: url,
            cookie,
            key: plan.key
          })
          if (!result.ok) {
            // 失败：清 patch、丢 key、树杀进程，绝不留登记为「就绪」的实例
            log.warn(`dsh web bridge handshake failed: ${result.reason}`)
            void this.enqueueClose().catch((err) => log.warn('dsh web close after bridge failure failed:', err))
            finish({ ok: false, error: `harness bridge handshake failed: ${result.reason}`, code: 'no-bridge' })
            return
          }
          const identity = checkBridgeIdentity(result.handshake, { cwd: opts.cwd, dshHome: expectedDshHome })
          if (!identity.ok) {
            log.warn(`dsh web bridge identity mismatch: ${identity.reason}`)
            void this.enqueueClose().catch((err) => log.warn('dsh web close after identity mismatch failed:', err))
            finish({ ok: false, error: `harness bridge identity mismatch: ${identity.reason}`, code: 'no-bridge' })
            return
          }
          if (generation === this.generation) {
            this.readyInstance = {
              generation,
              key: launchKey,
              url,
              launch,
              identity: {
                instanceId: result.handshake.instanceId,
                instanceEpoch: result.handshake.instanceEpoch,
                cwd: result.handshake.cwd,
                dshHome: result.handshake.dshHome,
                workspaceId: launch.workspaceId,
                bridgeLoaded: true,
                clientBundle: result.handshake.clientBundle
              },
              plan,
              controlPort: result.handshake.controlPort
            }
          }
          finish({ ok: true, url })
        })()
      })
      // stderr 仅用于失败诊断（保留尾部），不参与 ready 判定
      child.stderr?.setEncoding('utf-8')
      child.stderr?.on('data', (chunk: string) => {
        stderrBuf = (stderrBuf + chunk).slice(-4000)
      })

      child.on('error', (err) => {
        if (child.pid) this.closeJob(child.pid, jobForChild)
        log.error('dsh web spawn error:', err)
        // 新代指针不能动；promise 无论如何都要落定（finish 内部按代际分流）
        if (generation === this.generation) this.child = null
        // spawn 失败后 'exit' 不一定再发（Node：error 之后 exit 可能不发），归属与留档必须
        // 在这里兜底清掉，错误路径不能留下过期归属（否则下次启动的恢复会拿它去核对）。
        // 与 exit 的清理幂等：两边都到也只是各 no-op 一次。
        if (generation === this.generation && child.pid) {
          this.releaseOwnedPid(child.pid, spawnedAt)
          void this.unrecordPids([child.pid]).catch((unrecordErr) =>
            log.warn('dsh web pid unrecord after spawn error failed:', (unrecordErr as Error).message)
          )
        }
        finish({ ok: false, error: `Failed to spawn dsh: ${err.message}` })
      })
      child.on('exit', (code, signal) => {
        const jobClosed = child.pid ? this.closeJob(child.pid, jobForChild) : false
        if (jobClosed && child.pid && generation !== this.generation) {
          // close() 已推进代际、但排队的 doClose 可能还没跑：Job 关闭已收完整棵树。
          // 只清当前这代的指针与留档，避免下一次 open 被一个已结束的 pid 挡住。
          if (this.child === child) this.child = null
          if (this.pendingPid === child.pid && this.ownedPids.get(child.pid) === spawnedAt) {
            this.pendingPid = null
          }
          this.releaseOwnedPid(child.pid, spawnedAt)
          void this.unrecordPids([child.pid], { onlyIfRecordedAt: spawnedAt }).catch((err) =>
            log.warn('dsh web pid unrecord after Job close failed:', err)
          )
        }
        if (generation === this.generation) {
          this.child = null
          this.url = null
          // 实例没了：就绪登记、运行登记与租约一并失效（旧 epoch 的迟到回执不得再被接受）
          this.readyInstance = null
          this.runningLaunch = null
          this.leases.clear()
          // 托管 keep-alive 持有者随实例消失失效，否则会永久挡住显式重开
          this.backendHolders.clear()
          if (child.pid) {
            this.releaseOwnedPid(child.pid, spawnedAt)
          }
          // 自然退出（用户在 UI 里关掉 dsh、或 dsh 自己崩了）也要清档：留着一个已经不属于
          // 我们的 pid，下次启动的恢复会拿它去核对，PID 复用后就是实打实的误杀面。
          // 由 close() 触发的退出不走这里（close 已推进 generation），那次留档由
          // settlePidRecord 按树杀结果决定「清档还是留给下次兜底」。
          if (child.pid) {
            void this.unrecordPids([child.pid]).catch((err) =>
              log.warn('dsh web pid unrecord failed:', (err as Error).message)
            )
          }
        }
        // 即使被顶掉也要 finish：否则被 close() 杀掉的旧 open 永不 resolve
        const detail = stderrBuf.trim() || (code != null ? `exit code ${code}` : `signal ${signal}`)
        finish({ ok: false, error: `dsh web exited before ready: ${detail}` })
      })
    })
  }

  /**
   * 托管 acquire：**同一实例语义**的唯一入口。
   *
   *   - 默认请求（既无 workspaceId 也无 cwd）：复用当前实例（就绪或启动中），
   *     这样「打开详情」这类无参数调用不会另起一个后台，也不会触发解析副作用；
   *   - 显式目标：先经解析服务得到启动参数，再走 ensure；
   *   - 一切失败都带明确错误码（conflict / no-bridge / starting / unavailable），
   *     **不自动重启**、**不静默切换**工作区或 DSH_HOME。
   */
  async acquire(
    resolve: DshWebTargetResolver,
    opts: { target?: DshWebLaunchTarget; bindingId?: string } = {}
  ): Promise<DshEnsureResult> {
    const target = opts.target
    const isDefaultTarget = target === undefined || (target.workspaceId === undefined && target.cwd === undefined)
    if (isDefaultTarget) {
      // 启动中：默认请求直接并到同一个启动 Promise 上（不解析、不另起）
      if (this.starting) return this.mergeStarting(opts.bindingId, this.starting.key, this.starting.launch)
      // 已就绪：按当前实例自己的键 ensure ⇒ 命中「同键复用」分支，不调用 open()
      if (this.readyInstance) return this.ensure(this.readyInstance.launch, { bindingId: opts.bindingId })
      // 运行中但无桥：显式 no-bridge（不自动重启）
      if (this.child && this.runningLaunch) return this.noBridgeResult(this.runningLaunch.launch)
    }
    const resolved = await resolve(target ?? {})
    if (!resolved.ok) return { ok: false, code: resolved.code, error: resolved.error }
    return this.ensure(resolved.launch, { bindingId: opts.bindingId })
  }

  /**
   * ensure：保证「这组启动配置」有一个就绪实例，并返回它的**真实身份**。
   *
   *   1. 同键并发 ⇒ 合并到**同一个**启动 Promise（只 spawn 一次）；
   *   2. 已就绪且同键 ⇒ 直接复用（**不调用 open()** —— open() 会先杀旧实例）；
   *   3. 已就绪但异键 ⇒ `instance/conflict`（附当前权威值，无副作用）；
   *   4. 运行中但无桥 ⇒ `instance/no-bridge`（明确不支持，**不自动 restart**）；
   *   5. 启动中的异键 ⇒ `instance/starting`（不顶掉正在启动的那个）；
   *   6. 其余 ⇒ 带桥启动，**握手成功才算成功**；失败清理登记/临时 patch/内存凭据后返回错误。
   */
  async ensure(launch: ResolvedDshWebLaunch, opts: { bindingId?: string } = {}): Promise<DshEnsureResult> {
    const key = launchInstanceKey(launch)

    // 1. 启动中：同键合并到同一个启动 Promise（只 spawn 一次），异键明确拒绝（绝不顶掉正在启动的实例）
    if (this.starting) {
      if (this.starting.key === key) return this.mergeStarting(opts.bindingId, key, launch)
      return {
        ok: false,
        code: 'instance/starting',
        error: 'a dsh web instance is already starting with a different launch configuration',
        current: this.starting.currentView
      }
    }

    // 2/3. 已就绪
    if (this.readyInstance && this.child) {
      if (this.readyInstance.key === key) {
        const bindingId = this.registerLease(opts.bindingId, this.readyInstance.identity, key)
        return {
          ok: true,
          reused: true,
          url: this.readyInstance.url,
          identity: { ...this.readyInstance.identity },
          ...(bindingId ? { bindingId } : {})
        }
      }
      return {
        ok: false,
        code: 'instance/conflict',
        error: 'a dsh web instance is already running with a different workspace/cwd/DSH_HOME/launch configuration',
        current: describeLaunch(this.readyInstance.launch)
      }
    }

    // 4. 运行中但还没有桥（老实例、或桥启动失败后残留）：明确不支持，等用户显式重开
    if (this.child && this.runningLaunch) {
      if (this.runningLaunch.key === key) return this.noBridgeResult(this.runningLaunch.launch)
      return {
        ok: false,
        code: 'instance/conflict',
        error: 'a dsh web instance is already running with a different workspace/cwd/DSH_HOME/launch configuration',
        current: describeLaunch(this.runningLaunch.launch)
      }
    }

    // 5. 启动；启动 promise 自己登记自己，落定时只在「还是我这一代」时才清空登记
    const start = this.startInstance(launch, key, opts)
    const pending = start.finally(() => {
      if (this.starting && this.starting.promise === pending) this.starting = null
    })
    this.starting = { key, promise: pending, launch, currentView: describeLaunch(launch) }
    return pending
  }

  /** 启动一个带桥的实例；失败时登记/临时 patch/内存凭据全部清理，不留「假 ready」。 */
  private async startInstance(
    launch: ResolvedDshWebLaunch,
    key: string,
    opts: { bindingId?: string }
  ): Promise<DshEnsureResult> {
    const result = await this.open({ cwd: launch.cwd, env: launch.env, launch, bridge: 'required' })
    if (!result.ok) {
      return {
        ok: false,
        code: result.code === 'no-bridge' ? 'instance/no-bridge' : 'instance/unavailable',
        error: result.error
      }
    }
    const ready = this.readyInstance
    if (!ready || ready.key !== key) {
      // 握手成功但登记对不上（被更新的请求顶掉）：不谎报成功，也不复用
      return { ok: false, code: 'instance/unavailable', error: 'dsh web instance became unavailable during startup' }
    }
    const bindingId = this.registerLease(opts.bindingId, ready.identity, key)
    return {
      ok: true,
      reused: false,
      url: ready.url,
      identity: { ...ready.identity },
      ...(bindingId ? { bindingId } : {})
    }
  }

  /**
   * 释放一个绑定：**只解绑**，绝不 kill 共享后台（契约 §12.2 / 决定 12.2）。
   * 旧 epoch 的 release 一律拒绝（`auth/epoch-stale`），避免旧绑定把新实例的租约解掉。
   */
  release(bindingId: string, opts: { instanceEpoch?: number } = {}): DshReleaseResult {
    const lease = this.leases.get(bindingId)
    if (!lease) {
      return { released: false, code: 'auth/binding-not-owned', error: 'no such binding' }
    }
    if (opts.instanceEpoch !== undefined && opts.instanceEpoch !== lease.instanceEpoch) {
      return { released: false, code: 'auth/epoch-stale', error: 'binding belongs to a stale instance epoch' }
    }
    this.leases.delete(bindingId)
    return { released: true, backendStopped: false }
  }

  /** 当前租约快照（诊断/测试；不含凭据）。 */
  activeLeases(): Array<{ bindingId: string; instanceId: string; instanceEpoch: number }> {
    return [...this.leases.entries()].map(([bindingId, lease]) => ({
      bindingId,
      instanceId: lease.instanceId,
      instanceEpoch: lease.instanceEpoch
    }))
  }

  /**
   * 把调用方并到**正在进行的**同键启动上：只等那一个 spawn，绝不另起、绝不顶掉它。
   *
   * 关键点：合并的是**启动动作**，不是身份登记。启动 promise 只认「一个实例」，
   * 但每个 caller 都拿自己的 bindingId 独立登记一条租约并各拿各的返回；
   * 把首 caller 的 bindingId 转手给后来者，会让后来者 release 掉别人的绑定
   * （同键重复 acquire 的正确性靠的就是「一 caller 一租约」）。
   *
   * await 之后、登记租约之前必须**再核对一次**：这段窗口里 close()/restart 完全可能已经发生，
   * 那时启动 promise 虽已成功落定，但它描述的那个实例已经没了 —— 此时登记租约就是把旧 epoch
   * 的绑定发给调用方（随后它 release/审批都会打到已经不存在的实例上）。宁可明确 unavailable。
   */
  private async mergeStarting(
    bindingId: string | undefined,
    expectedKey: string,
    launch: ResolvedDshWebLaunch
  ): Promise<DshEnsureResult> {
    const inFlight = this.starting
    // 读到 starting 与真正 await 之间可能已被清空；那说明启动已落定，拿**同一个目标**重新 ensure 一次
    if (!inFlight || inFlight.key !== expectedKey) return this.ensure(launch, { bindingId })
    const result = await inFlight.promise
    // 失败就把原样的错误（含错误码与当前权威值）交给每个 caller —— 不伪造成功、不登记租约
    if (!result.ok) return result
    // 成功落定 ≠ 实例还在：close()/新代 open() 会清掉就绪登记、推进代际并作废旧租约。
    // 判据取「就绪登记仍是同一个实例身份 + 子进程还在 + 键没变」，任一不成立就不再登记。
    const ready = this.readyInstance
    const stillCurrent =
      ready !== null &&
      this.child !== null &&
      ready.key === expectedKey &&
      ready.identity.instanceId === result.identity.instanceId &&
      ready.identity.instanceEpoch === result.identity.instanceEpoch
    if (!stillCurrent) {
      return {
        ok: false,
        code: 'instance/unavailable',
        error: 'dsh web instance was closed or replaced before the merged acquire completed'
      }
    }
    // 必须**覆盖** result 上的 bindingId（首 caller 的那条），否则没带 binding 的后来者会被登记成
    // 首 caller 的绑定 —— 那正是「共享首 caller 绑定」的错误语义。
    const binding = this.registerLease(bindingId, result.identity, inFlight.key)
    return { ...result, bindingId: binding }
  }

  private noBridgeResult(launch: ResolvedDshWebLaunch): DshEnsureResult {
    return {
      ok: false,
      code: 'instance/no-bridge',
      error: 'the running dsh web instance has no harness bridge; reopen it explicitly while idle',
      current: describeLaunch(launch)
    }
  }

  private registerLease(
    bindingId: string | undefined,
    identity: DshInstanceIdentity,
    key: string
  ): string | undefined {
    if (!bindingId) return undefined
    this.leases.set(bindingId, {
      instanceId: identity.instanceId,
      instanceEpoch: identity.instanceEpoch,
      key
    })
    return bindingId
  }

  /**
   * 用 dsh web 的 ready URL（含 ?token=…）做一次 HTTP 请求，把 303 下发的会话 cookie
   *  写进 persist:dshweb 的 partition cookie jar。这样 webview 加载干净 origin URL 时
   *  浏览器自动带 cookie，鉴权通过。失败静默放行（打一条 warn）：最多回到 401 白页。
   *
   *  返回值 = 这次交换拿到的 `name=value; …` 头（**仅供内存内一次性使用**：桥的 host-only
   *  握手要带 dsh 自身的鉴权 cookie，而 dsh token 绝不能出现在请求 URL/query 里）。
   *  该字符串**绝不**进日志、状态或任何返回值。 */
  private exchangeTokenForCookie(rawUrl: string): Promise<string | null> {
    let parsed: URL
    try {
      parsed = new URL(rawUrl)
    } catch {
      return Promise.resolve(null)
    }
    const mod = parsed.protocol === 'https:' ? https : http

    return new Promise<string | null>((resolve) => {
      // 传 URL 对象而非手动构造 options：
      // Node 的 urlToHttpOptions 会剥离 IPv6 hostname 的方括号（如 [::1] → ::1），
      // 并补上默认端口 —— 直接用 parsed.hostname 会带方括号，http.request 解不了。
      const req = mod.request(
        parsed,
        {
          method: 'GET',
          timeout: COOKIE_EXCHANGE_TIMEOUT_MS
        },
        (res) => {
          // 消费响应体避免 socket 泄漏（303 无 body，但 res 不消费则连接无法回池）
          res.resume()
          const rawCookies = res.headers['set-cookie']
          if (!rawCookies || rawCookies.length === 0) {
            resolve(null)
            return
          }
          const entries = (Array.isArray(rawCookies) ? rawCookies : [rawCookies])
            .map(h => parseSetCookieEntry(h))
            .filter((e): e is ParsedCookie => e !== null)
          if (entries.length === 0) {
            resolve(null)
            return
          }
          const header = entries.map((e) => `${e.name}=${e.value}`).join('; ')
          const dshSession = session.fromPartition(DSH_WEB_PARTITION)
          const origin = parsed.origin
          const secure = parsed.protocol === 'https:'
          const nowSec = Math.floor(Date.now() / 1000)
          Promise.all(entries.map(e =>
            dshSession.cookies.set(toCookieDetails(e, origin, secure, nowSec))
              .catch(() => { /* 单条写入失败不阻塞其余 */ })
          )).then(
            () => resolve(header),
            () => resolve(header)
          )
        }
      )
      req.on('error', (err) => {
        log.warn('dsh web cookie exchange request failed:', err.message)
        resolve(null)
      })
      req.on('timeout', () => {
        req.destroy()
        log.warn('dsh web cookie exchange timed out')
        resolve(null)
      })
      req.end()
    })
  }

  /**
   * 关闭并清理子进程（交互路径：关窗、切工作区、IPC）。返回 Promise —— 调用方可以等它完成。
   *
   * 此前是 fire-and-forget 的 `spawn('taskkill')`，app 退出会把它截断：实测只杀掉
   * shell 包裹层（cmd.exe）就返回，真正长驻的 node 孙进程活着，占着 DSH 会话写锁
   * （不过期），下次开 dsh 报「当前会话已被占用」。现在优先关闭 Windows Job；
   * Job 不可用时才用 killPidTree 核对身份后树杀、补刀，详见 proc.ts。
   *
   * **同时推进 generation**：close() 一被调用，所有在飞的 open() 就此作废，绝不允许它在
   * await 醒来之后再 spawn 一个新实例。否则「open() 在 await 期间收到关闭请求」这条路径
   * 会绕过代际检查，关窗 / 退出后照样留下一个没人接管的 dsh 进程。
   *
   * 并发调用排队而不是立刻返回：每个调用方等到「自己这次关心的那次回收」落定才 resolve。
   * 树杀用 DEFAULT_CLOSE_BUDGET_MS 兜住时长；需要「硬预算 + 抢跑」的退出路径用 closeForQuit。
   * **绝不 reject**（killChildTree 全程吞错）—— 调用方的 .catch 只是保险丝。
   */
  close(): Promise<void> {
    // S4：托管期间（held/releasing 或详情视图持有）关闭页签只 **detach 视图**，绝不杀共享后台。
    // 关窗（macOS）也走这里 —— 后台留给正在跑的任务；退出仍走 closeForQuit 的原 Job 树回收。
    if (this.isManaged) {
      log.info(`[dsh web] close requested while managed (${this.managedHolders().join(', ')}); view detached, backend kept`)
      return Promise.resolve()
    }
    this.generation++
    this.invalidateInstance()
    // 显式关闭也作废「正在启动」的登记：旧启动的 open() 会因代际不符返回 superseded，
    // 之后的 ensure 该起一个新实例，而不是被一个注定失败的启动挡住。
    this.starting = null
    return this.enqueueClose()
  }

  /**
   * 退出路径专用：**不排队**，立刻对「当前 child 或正在被树杀的那个 pid」发起一轮带硬预算的
   * 树杀，然后 resolve（与可能仍在跑的那一轮并行 —— 对同一 pid 的 taskkill / 信号是幂等的）。
   *
   * 为什么不能只调 `close()`：它是串行的，退出请求会排在「关窗时已启动的那一轮」后面；那一轮
   * 可能正卡在 8s 的进程表枚举里，等它落定，外层计时器早就 app.exit() 了 —— 预算等于没设。
   * 抢跑一轮让身份核对和树杀尽早开始；若预算不足或无法确认 PID 归属，则保留留档待下次恢复。
   *
   * 被 app.exit() 截断的只会是**上一轮**；本轮若已核实身份就发树杀，否则 root pid
   * 早在 spawn 时就已留档，由下次启动的恢复流程接手。
   */
  closeForQuit(deadline: number): Promise<void> {
    this.generation++
    const pid = this.child?.pid ?? this.killingPid ?? this.pendingPid
    this.child = null
    this.url = null
    this.invalidateInstance()
    this.starting = null
    if (!pid) return Promise.resolve()
    return this.killChildTree(pid, { deadline })
  }

  /**
   * 实例失效：就绪登记、运行登记与全部租约一起作废，并回收桥的宿主 owned 运行资源
   * （删确定性 patch 文件 + 释放内存里的 host-only key）。
   *
   * 这是「旧 epoch 失效」的落点：显式 close/quit 之后，任何按旧身份到达的请求都必须
   * 被拒（`auth/epoch-stale`），也**不**能污染随后起来的新实例。
   */
  private invalidateInstance(): void {
    const plan = this.readyInstance?.plan ?? null
    this.readyInstance = null
    this.runningLaunch = null
    this.leases.clear()
    // 实例租约随后台失效；独立的 profile 写入锁仍由安装方在 finally 中释放。
    this.backendHolders.clear()
    if (!plan) return
    try {
      plan.cleanup()
    } catch (err) {
      log.warn('dsh web bridge cleanup on close failed:', (err as Error).message)
    }
  }

  /**
   * 只排队关闭、不推进代际。给两类「自己关自己」的调用方用：
   *   - open() 的「先关旧实例再开新实例」—— 推进代际会把自己也作废；
   *   - 启动超时 / 回显非法 URL 的自清理 —— 推进代际会把真实失败原因误报成 superseded。
   * 外部调用方（关窗、退出、IPC）一律用 close() / closeForQuit()。
   */
  private enqueueClose(): Promise<void> {
    // 前一次失败不阻断后续（.catch 吞掉再接 doClose），否则整条链会永久卡死
    this.closing = this.closing.catch(() => {}).then(() => this.doClose())
    return this.closing
  }

  private async doClose(): Promise<void> {
    try {
      const child = this.child
      this.child = null
      this.url = null
      // 关闭即失效：就绪登记/租约/桥运行资源在动手树杀之前先作废 —— 任何并发的
      // acquire 都不会在这段窗口里把「正在被杀的实例」当成可复用的同一实例。
      this.invalidateInstance()
      if (!child && !this.pendingPid) return
      const pid = child?.pid ?? this.pendingPid
      if (!pid) {
        try {
          child?.kill()
        } catch (err) {
          log.warn('Failed to kill dsh web child:', err)
        }
        return
      }
      await this.killChildTree(pid, { deadline: Date.now() + DEFAULT_CLOSE_BUDGET_MS })
    } catch (error) {
      log.warn('dsh web close failed:', (error as Error).message)
    }
  }

  /** 树杀一个 pid 并按结果落定留档。绝不抛（退出路径调用，抛=退不掉）。 */
  private async killChildTree(pid: number, budget: ProcDeps): Promise<void> {
    const previousKilling = this.killingPid
    this.killingPid = pid
    this.pendingPid = pid
    // 出生观察点（归属令牌）在树杀前取好：等待期间可能被并发的 settle 清掉，map 里就只剩兜底基准了
    const spawnedAt = this.ownedPids.get(pid) ?? this.sessionStartedAt
    try {
      const job = this.jobs.get(pid)
      let result: KillTreeResult
      let jobTerminated = false
      if (job) {
        try {
          jobTerminated = job.terminate()
        } catch (error) {
          log.warn('dsh web Job Object termination failed:', error)
        } finally {
          jobTerminated = this.closeJob(pid, job) || jobTerminated
        }
      }
      if (jobTerminated) {
        result = { status: 'killed', targets: [{ pid, name: '', cmdline: null }] }
      } else {
        result = await killPidTree(pid, undefined, { ...budget, ownedRootSpawnedAt: spawnedAt })
      }
      await this.settlePidRecord(pid, result, spawnedAt)
      if (result.status === 'killed' && this.pendingPid === pid) this.pendingPid = null
    } catch (error) {
      log.warn('dsh web tree kill failed:', (error as Error).message)
    } finally {
      if (this.killingPid === pid) this.killingPid = previousKilling
    }
  }

  private closeJob(pid: number, job: DshProcessJob | null): boolean {
    if (!job) return false
    try {
      const closed = job.close()
      if (closed && this.jobs.get(pid) === job) this.jobs.delete(pid)
      return closed
    } catch (error) {
      log.warn('dsh web Job Object close failed:', error)
      return false
    }
  }

  /** 身份核对失败后只在确认旧 root 和 DSH 子孙都已消失时解除阻塞。 */
  private async clearPendingIfGone(): Promise<void> {
    const pid = this.pendingPid
    if (pid === null) return
    const spawnedAt = this.ownedPids.get(pid)
    if (spawnedAt === undefined) return
    const procs = await listProcesses()
    if (procs === null) return
    if (isPidAlive(pid)) return
    const byPid = new Map(procs.map((p) => [p.pid, p]))
    if (collectDescendantPids(procs, pid).some((p) => isLyShellDshWebCmdline(byPid.get(p)?.cmdline))) return
    if (findOrphanDshWebPids(procs).length > 0) return
    if (this.pendingPid !== pid || this.ownedPids.get(pid) !== spawnedAt) return
    this.pendingPid = null
    this.releaseOwnedPid(pid, spawnedAt)
    await this.unrecordPids([pid], { onlyIfRecordedAt: spawnedAt }).catch((error) =>
      log.warn('dsh web pid unrecord after verified disappearance failed:', error)
    )
  }

  /** 按「出生观察点令牌」解除 pid 归属：令牌对不上说明 pid 已被新一轮 spawn 复用，不能动它的登记。 */
  private releaseOwnedPid(pid: number, spawnedAt: number): void {
    if (this.ownedPids.get(pid) === spawnedAt) this.ownedPids.delete(pid)
  }

  /**
   * 树杀结果 → 留档：整棵确认清除就清档，漏杀/未确认就留档给下次启动兜底。
   * `spawnedAt` 是该 pid 的出生观察点（见 ownedPids）——兜底插入也必须用它，
   * 绝不能拿树杀失败那一刻的「现在」当时间基准。
   */
  private async settlePidRecord(pid: number, result: KillTreeResult, spawnedAt: number): Promise<void> {
    if (result.status === 'killed') {
      this.releaseOwnedPid(pid, spawnedAt)
      await this.unrecordPids(
        result.targets.map((t) => t.pid),
        // 身份令牌核对：树杀这几秒里 pid 若被新一轮 spawn 复用并重新建档（时间戳已换人），
        // 这次迟到的清档绝不能把新进程的留档一并删掉。
        { onlyIfRecordedAt: spawnedAt }
      ).catch(() => {
        /* 留档失败只是下次多一次 recover 尝试，不影响关闭 */
      })
      return
    }
    if (result.status === 'survivors') {
      log.warn(`dsh web pid ${pid} survived tree kill:`, result.pids.join(', '))
    } else {
      log.warn(`dsh web pid ${pid} tree kill unverified:`, result.message)
    }
    // 只留 **root**（我们 spawn 的那个 pid），**不记子孙**：一条记录的全部权威来自
    // 「这个 pid 是我们起来的」；子孙 pid 只是从进程表推导出来的，把它按同样身份写进档，
    // 会在「新会话里这个 pid 被新进程树复用」时变成误杀面（ownedPids 只认得住 root）。
    // 子孙由下次启动按 root 的 ppid 血缘 + 命令行签名找回，见 recoverRecordedPids。
    //
    // `insertOnly`：这条记录通常已经由 recordSpawnedPid 写过（带真实镜像名）。树杀失败时
    // 再写一遍只该保证「它在」，绝不能拿这次的空身份/更晚的时间戳覆盖 —— 那会同时伪造身份
    // 与 PID 复用判据的基准。
    const rootTarget = result.targets.find((t) => t.pid === pid)
    await this.recordPids(
      [{ pid, name: rootTarget?.name ?? '', cmdline: rootTarget?.cmdline ?? null, recordedAt: spawnedAt }],
      {
        insertOnly: true,
        // 记录不存在时才插入，插入也只发生在「pid 仍归属本会话且是同一个进程」时：
        // 期间若已自然退出并被 unrecordPids 清掉（令牌已摘除），或 pid 已被新一轮 spawn
        // 复用（令牌换人），都不该被这次迟到写重新建档。
        guard: () => this.ownedPids.get(pid) === spawnedAt
      }
    ).catch(() => {
      /* 留档失败只是少一层兜底 */
    })
  }

  /** 启动兜底：核对镜像名、命令行和父链后，回收上次崩溃/强杀遗留的 dsh web。 */
  async recoverFromRecord(): Promise<void> {
    try {
      const path = this.pidRecordFile()
      // 锁里只做「取一份快照」：核对/杀进程这些慢 IO（每个条目一次 tasklist / 一次进程表枚举）
      // 放到锁外，否则会长时间占着留档锁 —— 退出路径要写留档时会被它堵到 app.exit() 之后。
      const entries = await this.withRecordLock(() => readPidRecord(path))
      if (entries.length === 0) return
      // 本会话写下的记录不属于「上次遗留」：既不该回收，也不能和刚 spawn 的进程赛跑
      const candidates = entries.filter((e) => e.recordedAt < this.sessionStartedAt)
      if (candidates.length === 0) return
      const { killed, dropped } = await recoverRecordedPids(candidates, {
        // 本会话自己 spawn / 正在树杀的 pid 一律不碰（旧 pid 被新进程复用 + 同名时的误杀面）
        isProtectedPid: (pid: number) => this.ownedPids.has(pid)
      })
      const gone = new Set([...killed, ...dropped])
      await this.withRecordLock(async () => {
        // 重新读一次并**按版本**应用结果：核对期间被本会话重新记录过的条目（recordedAt 变了）
        // 已经不属于我们判定时那一版，保留。
        const current = await readPidRecord(path)
        const version = new Map(entries.map((e) => [e.pid, e.recordedAt]))
        const left = current.filter((e) => !gone.has(e.pid) || version.get(e.pid) !== e.recordedAt)
        await writePidRecord(path, left)
      })
      if (killed.length > 0) log.info('recovered recorded dsh web pids:', killed.join(', '))
    } catch (error) {
      log.warn('dsh web pid record recovery failed:', (error as Error).message)
    }
  }

  private pidRecordFile(): string {
    return join(app.getPath('userData'), 'dsh-web-pids.json')
  }

  /** 留档的 read-modify-write 一律走这里，保证同一时刻只有一条读改写链。 */
  private withRecordLock<T>(task: () => Promise<T>): Promise<T> {
    const run = this.recordLock.catch(() => {}).then(task)
    // 队列只关心「前一个跑完」，失败由调用方拿到的 run 处理，不污染后续
    this.recordLock = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async recordSpawnedPid(pid: number, spawnedAt: number): Promise<void> {
    // 先把「本会话 spawn 了这个 pid」落盘，不等镜像名 —— 退出/崩溃随时可能发生，
    // 留档要在最短路径上可见（退出路径的兜底完全依赖它）。
    // recordedAt 用出生观察点：它是下次启动 PID 复用判据的基准（见 ownedPids）。
    // guard：写之前再核对身份令牌。期间可能已经自然退出并被 unrecordPids 清掉 —— 迟到的写
    // 会把死 pid 又写回档里；也可能 pid 已被新一轮 spawn 复用 —— 迟到的写会拿旧观察点覆盖
    // 新进程的建档，把它的复用判据基准往回拨。两样都不许发生。
    await this.recordPids([{ pid, name: '', cmdline: null, recordedAt: spawnedAt }], {
      guard: () => this.ownedPids.get(pid) === spawnedAt
    }).catch(() => {
      /* 留档失败不影响启动 */
    })
    // 再补一次镜像名（当场查一次，失败重试几次）—— 为下次启动的恢复提供一项排除证据。
    // 整条链路有预算上限：它是 best-effort，卡住只会让留档迟迟不落盘（并且期间子进程随时可能退出）。
    // upsert 时 recordedAt 仍回写出生观察点：镜像名可以刷新，时间基准一次定格。
    const name = await this.lookupSpawnedImageName(pid)
    if (!name) return
    await this.recordPids([{ pid, name, cmdline: null, recordedAt: spawnedAt }], {
      guard: () => this.ownedPids.get(pid) === spawnedAt
    }).catch(() => {
      /* 留档失败不影响启动 */
    })
  }

  /**
   * 查刚 spawn 的 pid 的镜像名：失败重试几次，整条链路不超过 IDENTITY_LOOKUP_BUDGET_MS。
   * 查不到返回 null —— 留档会写空串（身份未知），**绝不写猜测值**：猜 cmd.exe/dsh 两头都错
   * （POSIX 上真实镜像是 node，核对必然不符；Windows 上可能撞上复用出来的同名 cmd.exe）。
   */
  private async lookupSpawnedImageName(pid: number): Promise<string | null> {
    const deadline = Date.now() + IDENTITY_LOOKUP_BUDGET_MS
    let name: string | null = null
    for (let attempt = 0; attempt < IDENTITY_LOOKUP_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        if (Date.now() >= deadline) break
        await delay(IDENTITY_LOOKUP_RETRY_MS)
      }
      name = await lookupImageName(pid, { deadline })
      if (name) break
    }
    return name
  }

  /**
   * 写/刷新留档条目。
   *
   * - 默认（upsert）：同一个 pid 再观察一次就整条替换（身份 + `recordedAt`）—— 用于
   *   spawn 期「先写空身份、查到镜像名再刷新」两版，**同一个进程**的两次观察。
   * - `insertOnly`：只保证「这条记录在」，已存在就一个字节都不改。给 settlePidRecord 用。
   *
   * `recordedAt` 的铁律：它必须是调用方带来的**进程出生观察点**（ownedPids 里的
   * spawnedAt）。recordPids 自己的「现在」只在全新条目且调用方不知道出生时刻时兜底；
   * 覆盖旧条目时调用方没带就保留旧值。绝不能拿「这次写盘的时刻」顶上 —— recordedAt 是
   * PID 复用判据的基准（进程启动晚于它 = 号已被别人拿走），时间戳推晚一秒，复用进程就
   * 多一秒的冒充窗口；推到树杀失败那一刻的话，一个 pid 期间换过人，这条记录就同时伪造了
   * 身份和时间，下次启动两条判据都拦不住它。
   *
   * `guard` 在锁内求值：进程若已不属于本会话（自然退出 / 已被清档）就别写，这是挡住
   * 「迟到的写把死 pid 写回去」的关键 —— 留档锁只保证写的原子性，不保证生命周期顺序。
   */
  private recordPids(
    items: Array<{ pid: number; name: string; cmdline: string | null; recordedAt?: number }>,
    opts?: { guard?: () => boolean; insertOnly?: boolean }
  ): Promise<void> {
    return this.withRecordLock(async () => {
      if (opts?.guard && !opts.guard()) return
      const path = this.pidRecordFile()
      const entries = await readPidRecord(path)
      const now = Date.now()
      const next = [...entries]
      for (const item of items) {
        if (item.pid <= 0) continue
        const idx = next.findIndex((e) => e.pid === item.pid)
        if (idx === -1) {
          // 全新条目：时间基准认调用方的出生观察点，没有才退回「现在」。
          // 我们只会为「自己 spawn 的 pid」写档 —— 归属标记写死 root。
          next.push({
            pid: item.pid,
            name: item.name,
            cmdline: item.cmdline,
            kind: 'root',
            recordedAt: item.recordedAt ?? now
          })
          continue
        }
        if (opts?.insertOnly) continue
        next[idx] = {
          pid: item.pid,
          name: item.name,
          cmdline: item.cmdline,
          kind: 'root',
          // 覆盖旧条目：调用方带来出生观察点就用它（同一个进程的再次观察）；没带就保留
          // 旧基准 —— 时间只能来自出生那一刻，绝不能来自「这次写盘」。
          recordedAt: item.recordedAt ?? (next[idx].recordedAt > 0 ? next[idx].recordedAt : now)
        }
      }
      if (next.length === 0) return
      await writePidRecord(path, next)
    })
  }

  private unrecordPids(pids: readonly number[], opts?: { onlyIfRecordedAt?: number }): Promise<void> {
    return this.withRecordLock(async () => {
      const path = this.pidRecordFile()
      const entries = await readPidRecord(path)
      const drop = new Set(pids)
      // onlyIfRecordedAt：只清「我们写的那一版」（recordedAt = 出生观察点令牌）。期间 pid 若被
      // 新一轮 spawn 复用并重新建档（时间戳换了人），这次迟到的清档就不能把它一并带走。
      const keep = entries.filter(
        (e) =>
          !drop.has(e.pid) ||
          (opts?.onlyIfRecordedAt !== undefined && e.recordedAt !== opts.onlyIfRecordedAt)
      )
      if (keep.length === entries.length) return
      await writePidRecord(path, keep)
    })
  }
}

export const dshWebManager = new DshWebManager()
