import { randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, rmdirSync, lstatSync } from 'fs'
import http from 'http'
import { join, resolve } from 'path'
import { pathToFileURL } from 'url'

/**
 * LyShell 拥有的 dsh 双端桥（host 半 + client 半）的**宿主侧**运行资源管理。
 *
 * 分工（契约 contract-v1 §2/§6/§13）：
 *   - 桥包本身是随 LyShell 安装包发布的静态产品包（`resources/dsh-bridge/`，
 *     host 半 index.mjs + client 半 client.js + package.json），**不安装进用户的
 *     dsh profile、不修改已安装 dsh**；
 *   - 装载方式 = 运行期写一个 `--patch` 文件（insert 段落指向桥包的**绝对 file: URL**），
 *     由 `dsh web --patch <abs> --port 0 --no-open` 装载（argv 顺序是启动可行性约束，
 *     见 proc.ts 的 buildDshWebSpawnArgs 与 contract §13）；
 *   - 宿主侧凭据 = **运行期随机** host-only key，只经 spawn env 注入 dsh 子进程 +
 *     留在本进程内存里；**绝不**写文件、进 query、进日志，也**不**交给插件/Pet。
 *
 * 本模块不 import Electron：桥包定位、patch 写盘、握手请求全部可注入，便于单测。
 */

/** 桥包目录名（随安装包发布的静态产品包，位于 resources/dsh-bridge） */
export const BRIDGE_PACKAGE_DIR_NAME = 'dsh-bridge'
/** 桥包 package.json 的 name（= dsh client 段 id，官方 clientModules graph 用它做键） */
export const BRIDGE_PACKAGE_NAME = 'lyshell-harness-bridge'
/** patch 文件名 —— **确定性**（契约 §13.2：不随时间戳漂移），位于宿主 owned 运行目录 */
export const BRIDGE_PATCH_FILE_NAME = 'lyshell-harness.patch.yml'
/** 宿主 owned 运行目录名（userData 下；底下每次启动一个 `run-*` 子目录，绝不写进 DSH_HOME / 工作区） */
export const BRIDGE_RUNTIME_DIR_NAME = 'dsh-bridge-runtime'
/**
 * run 目录的归属标记文件名。内容只有 `{ version, pid, owner }`：
 * pid 用于启动时判断「这一代进程是否还活着」，owner 是本代独有 UUID（不是凭据、不可派生自凭据）。
 * 没有这份标记的旧版 run 目录一律视为归属不明，**不自动回收**。
 */
export const BRIDGE_RUN_OWNER_FILE_NAME = '.lyshell-run-owner.json'
/** 握手路由（host 半在 dsh 进程内注册；必须与 resources/dsh-bridge/index.mjs 一致） */
export const BRIDGE_HANDSHAKE_PATH = '/__lyshell/harness/handshake'
/** host-only 凭据的请求头名（不经 query，不进 URL） */
export const BRIDGE_KEY_HEADER = 'x-lyshell-harness-key'
/** host-only 凭据的注入环境变量名（只由 LyShell 主进程在 spawn 时写） */
export const BRIDGE_KEY_ENV = 'LYSHELL_HARNESS_BRIDGE_KEY'
/** 桥协议版本（与 resources/dsh-bridge/index.mjs 的 HARNESS_PROTOCOL_VERSION 一致） */
export const BRIDGE_PROTOCOL_VERSION = 2
/** patch insert 行的 id（稳定值，便于 --dump-config 排障） */
export const BRIDGE_PATCH_ENTRY_ID = 'lyshell-harness-bridge'
/** 每次启动的运行目录名前缀（见 prepareBridgeRuntime） */
export const BRIDGE_RUN_DIR_PREFIX = 'run-'
/**
 * 本模块 patch 文件的**内容标记**（判据：这份 patch 出自我这个模块，而不是别的什么）。
 * 注意：这只是「是不是本模块形态」的判据，**不是**代际归属证明 —— 同一模块的两次运行内容相同，
 * 所以真正的代际隔离靠**每次一个独有 run 目录**，本标记只用于「内容已被别人改写 ⇒ 不动手」。
 */
export const BRIDGE_PATCH_MARKER = `"id": ${JSON.stringify(BRIDGE_PATCH_ENTRY_ID)}`

export interface BridgePackageLocation {
  /** 桥包目录绝对路径 */
  dir: string
  /** host 半入口绝对路径 */
  entry: string
  /** client 半绝对路径 */
  client: string
  /** package.json 绝对路径 */
  manifest: string
}

export interface LocateBridgeOptions {
  isPackaged: boolean
  /** 打包态：process.resourcesPath */
  resourcesPath?: string
  /** 开发态：仓库根（由调用方按 __dirname 推导） */
  devRoot: string
  exists?: (path: string) => boolean
}

/**
 * 定位随包发布的桥包目录。找不到就返回 null —— 调用方据此走「无桥」路径
 * （显式 open 仍可正常开 Web；托管 acquire 明确报 no-bridge），**不猜路径、不降级造桥**。
 */
export function locateBridgePackage(opts: LocateBridgeOptions): BridgePackageLocation | null {
  const exists = opts.exists ?? existsSync
  const base = opts.isPackaged
    ? opts.resourcesPath
      ? join(opts.resourcesPath, BRIDGE_PACKAGE_DIR_NAME)
      : null
    : join(opts.devRoot, 'resources', BRIDGE_PACKAGE_DIR_NAME)
  if (!base) return null
  const location: BridgePackageLocation = {
    dir: base,
    entry: join(base, 'index.mjs'),
    client: join(base, 'client.js'),
    manifest: join(base, 'package.json')
  }
  if (!exists(location.entry) || !exists(location.client) || !exists(location.manifest)) return null
  return location
}

/**
 * patch 里的 insert 行 name —— **规范 file: URL**（空格转义为 %20）。
 *
 * 依据（S1 P4 第 2 版真实启动失败）：`applyEntryPatches` 会把绝对路径形式的 name 规范化成
 * `pathToFileURL(...)`（`dsh-app-boot/lib/index.js:3540`），而它不做百分号转义；直接写裸
 * 绝对路径在含空格时可能与官方规范化结果不一致。这里直接写入与官方一致的规范 URL。
 */
export function bridgePackageSpecifier(entry: string): string {
  return pathToFileURL(resolve(entry)).href
}

/**
 * 生成 `--patch` 文件内容。
 * 形状沿用 S1 已实测通过的形态（JSON 是合法 YAML；`insert` 段落是官方 patch 层语义）：
 *   [{ "insert": [{ "id": "...", "name": "<file: URL>" }] }
 * **只**含桥包路径与固定 id —— 不含 token、不含端口、不含任何运行期凭据。
 */
export function buildBridgePatchFile(entry: string, id: string = BRIDGE_PATCH_ENTRY_ID): string {
  return JSON.stringify([{ insert: [{ id, name: bridgePackageSpecifier(entry) }] }], null, 2)
}

/** Windows cmd 里**不安全**的字符：会破坏引号包裹或被 cmd 二次解释（% 会展开环境变量）。 */
const CMD_UNSAFE_RE = /["%^&|<>]/

export class UnsafeBridgePathError extends Error {}

/**
 * Windows `cmd.exe /d /s /c "<整行>"` 里安全 quote 一个参数。
 * 路径由我们自己拼（userData 下），但仍逐字符把关：含 `"`/`%`/`^`/`&`/`|`/`<`/`>` 时
 * **拒绝**而不是「尽力转义」—— 猜错的代价是把宿主的 token 交给一个解析错的命令行。
 * 需要 quote 时一律用双引号包裹（cmd 会剥掉引号，dsh 收到原路径）。
 */
export function quoteWindowsCmdArg(arg: string): string {
  if (CMD_UNSAFE_RE.test(arg)) {
    throw new UnsafeBridgePathError('bridge path contains characters unsafe for cmd.exe')
  }
  if (arg.length === 0) return '""'
  return /[\s]/.test(arg) ? `"${arg}"` : arg
}

/** 用给定引号规则拼一条命令行（Windows 用 quoteWindowsCmdArg，POSIX 不用 —— 数组传参不经过 shell）。 */
export function buildLaunchLine(command: string, args: readonly string[], quote: (a: string) => string): string {
  return [command, ...args.map(quote)].join(' ')
}

export interface BridgeHandshake {
  protocolVersion: number
  instanceId: string
  instanceEpoch: number
  cwd: string
  /** 桥进程自报的 DSH_HOME（`process.env.DSH_HOME`） */
  dshHome: string
  hostBridge: boolean
  clientBundle: boolean
  /**
   * 桥的Pet 托管控制回环端口（0 = 本桥没起来 / 旧版桥）。
   * 控制通道走桥自己的监听，不经过 dsh 的 `/api`（那条链有官方会话鉴权且沿用原官方处理链）。
   */
  controlPort: number
}

/** 由**真实 dsh 进程**铸造的实例身份（LyShell 只核对，不臆造）。 */
export interface DshInstanceIdentity {
  instanceId: string
  instanceEpoch: number
  cwd: string
  dshHome: string
  workspaceId: string | null
  bridgeLoaded: boolean
  clientBundle: boolean
}

export const MAX_INSTANCE_ID_CHARS = 128
const MAX_HANDSHAKE_BYTES = 16 * 1024

/** 解析握手响应体。形状不对（缺字段/类型错/超长）一律 null —— 不猜、不部分接受。 */
export function parseBridgeHandshake(payload: unknown): BridgeHandshake | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const p = payload as Record<string, unknown>
  const instanceId = p.instanceId
  const instanceEpoch = p.instanceEpoch
  if (typeof p.protocolVersion !== 'number' || !Number.isInteger(p.protocolVersion)) return null
  if (typeof instanceId !== 'string' || instanceId.length === 0 || instanceId.length > MAX_INSTANCE_ID_CHARS) return null
  if (typeof instanceEpoch !== 'number' || !Number.isInteger(instanceEpoch) || instanceEpoch <= 0) return null
  if (typeof p.cwd !== 'string' || p.cwd.length === 0) return null
  if (typeof p.dshHome !== 'string' || p.dshHome.length === 0) return null
  if (p.hostBridge !== true) return null
  if (typeof p.controlPort !== 'number' || !Number.isInteger(p.controlPort) || p.controlPort < 0 || p.controlPort > 65535) {
    return null
  }
  return {
    protocolVersion: p.protocolVersion,
    instanceId,
    instanceEpoch,
    cwd: p.cwd,
    dshHome: p.dshHome,
    hostBridge: true,
    clientBundle: p.clientBundle === true,
    controlPort: p.controlPort
  }
}

/** 路径比较口径（Windows 大小写无关） */
function samePath(a: string, b: string): boolean {
  const na = resolve(a)
  const nb = resolve(b)
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb
}

export type BridgeIdentityCheck = { ok: true } | { ok: false; reason: string }

/**
 * 核对握手自报身份的**启动身份**是否与我们要求的一致。
 * 这是「同后台」判据的证据：instanceId/epoch 由 dsh 进程铸造，cwd/DSH_HOME 由它自报；
 * 与请求值不符即视为换了实例/换了环境 —— 明确失败，不悄悄复用。
 */
export function checkBridgeIdentity(
  handshake: BridgeHandshake,
  expect: { cwd: string; dshHome: string }
): BridgeIdentityCheck {
  if (handshake.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
    return { ok: false, reason: `bridge protocol version mismatch (${handshake.protocolVersion})` }
  }
  if (!samePath(handshake.cwd, expect.cwd)) return { ok: false, reason: 'bridge reported a different cwd' }
  if (!samePath(handshake.dshHome, expect.dshHome)) return { ok: false, reason: 'bridge reported a different DSH_HOME' }
  return { ok: true }
}

/** 常量时间比较 host-only key（长度不同直接 false，不泄露长度差之外的时序信息）。 */
export function bridgeKeyMatches(expected: string, provided: string | undefined | null): boolean {
  if (!provided) return false
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(provided, 'utf8')
  if (a.length !== b.length || a.length === 0) return false
  return timingSafeEqual(a, b)
}

export interface BridgeHandshakeRequest {
  /** dsh web 的 origin（回环 + 显式端口，**不含** token/query） */
  origin: string
  /** dsh 认证 cookie（内存内一次性使用，绝不落盘/打日志） */
  cookie?: string | null
  key: string
  timeoutMs?: number
}

export type BridgeHandshakeResult =
  | { ok: true; handshake: BridgeHandshake }
  | { ok: false; reason: string }

export interface BridgeHandshakeDeps {
  request?: (
    origin: string,
    headers: Record<string, string>,
    timeoutMs: number
  ) => Promise<{ status: number; body: string } | null>
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000

function defaultHandshakeRequest(
  origin: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<{ status: number; body: string } | null> {
  return new Promise((resolvePromise) => {
    let settled = false
    const done = (value: { status: number; body: string } | null): void => {
      if (settled) return
      settled = true
      resolvePromise(value)
    }
    let target: URL
    try {
      target = new URL(BRIDGE_HANDSHAKE_PATH, origin)
    } catch {
      done(null)
      return
    }
    const req = http.request(target, { method: 'GET', headers, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_HANDSHAKE_BYTES) {
          req.destroy()
          done(null)
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => done({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', () => done(null))
    req.on('timeout', () => {
      req.destroy()
      done(null)
    })
    req.end()
  })
}

/**
 * 向 dsh 进程内的桥发一次 host-only 握手。
 * 凭据只放请求头（**不**进 query/URL）；失败原因只给固定分类字符串，绝不回显响应体
 * （响应体来自子进程，可能含它自己的诊断文本）或凭据。
 */
export async function requestBridgeHandshake(
  request: BridgeHandshakeRequest,
  deps: BridgeHandshakeDeps = {}
): Promise<BridgeHandshakeResult> {
  const doRequest = deps.request ?? defaultHandshakeRequest
  const headers: Record<string, string> = {
    [BRIDGE_KEY_HEADER]: request.key,
    accept: 'application/json',
    'cache-control': 'no-store'
  }
  if (request.cookie) headers.cookie = request.cookie
  const response = await doRequest(request.origin, headers, request.timeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS).catch(
    () => null
  )
  if (!response) return { ok: false, reason: 'bridge handshake request failed' }
  if (response.status === 401) return { ok: false, reason: 'bridge rejected the host-only credential' }
  if (response.status !== 200) return { ok: false, reason: `bridge handshake returned status ${response.status}` }
  let parsed: unknown
  try {
    parsed = JSON.parse(response.body)
  } catch {
    return { ok: false, reason: 'bridge handshake returned malformed JSON' }
  }
  const handshake = parseBridgeHandshake(parsed)
  if (!handshake) return { ok: false, reason: 'bridge handshake payload is incomplete' }
  return { ok: true, handshake }
}

export interface BridgeRuntimePlan {
  /** host-only 凭据（仅内存；cleanup 后失效） */
  readonly key: string
  /** 本次启动的运行目录（每次一个，绝不与其他代共用） */
  readonly runtimeDir: string
  /** patch 文件绝对路径（--patch 的取值） */
  readonly patchFile: string
  /** 桥包目录（诊断用） */
  readonly bridgeDir: string
  /** 子进程要注入的 env（只含 host-only key，绝不落盘） */
  childEnv(): Record<string, string>
  /** 回收本次运行的 patch 文件；**只删本代写下的那份**（见 reclaimPatchFile） */
  cleanup(): void
}

export interface PrepareBridgeOptions {
  /** 宿主 owned 运行目录（userData 下；调用方提供，便于测试与打包态区分） */
  runtimeDir: string
  location: BridgePackageLocation
  /** 必须独占创建新的 run 目录，已存在时抛错。 */
  mkdir?: (dir: string) => void
  writeFile?: (file: string, data: string) => void
  /** 默认实现必须「文件不存在即成功」；自定义实现同样要容忍 ENOENT（cleanup 幂等） */
  removeFile?: (file: string) => void
  randomKey?: () => string
  /** 本次 run 的隔离标识（默认独立随机；**绝不**派生自 host key，见 prepareBridgeRuntime） */
  randomRunId?: () => string
}

const RUN_OWNER_FILE = BRIDGE_RUN_OWNER_FILE_NAME

/** 只回收有本模块标记、拥有者已确认退出且没有外来文件的目录。PID 仍在则保守保留。 */
function reclaimExpiredRuns(runtimeDir: string): void {
  let names: string[]
  try { names = readdirSync(runtimeDir).slice(0, 256) } catch { return }
  for (const name of names) {
    if (!/^run-[\w-]+$/.test(name)) continue
    const dir = join(runtimeDir, name)
    try {
      if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) continue
      const ownerFile = join(dir, RUN_OWNER_FILE)
      const owner = JSON.parse(readFileSync(ownerFile, 'utf8'))
      if (owner.version !== 1 || !Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.owner !== 'string') continue
      try { process.kill(owner.pid, 0); continue } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue }
      if (readdirSync(dir).some(file => file !== RUN_OWNER_FILE && file !== BRIDGE_PATCH_FILE_NAME)) continue
      const patch = join(dir, BRIDGE_PATCH_FILE_NAME)
      reclaimPatchFile(patch)
      // patch 被外部改写时保留整个目录，避免误判归属。
      if (existsSync(patch)) continue
      rmSync(ownerFile)
      rmdirSync(dir)
    } catch { /* 归属或权限不明确时保留 */ }
  }
}

/**
 * 回收 patch 文件，但**先核对归属再删**。
 *
 * 背景（真实迟到 cleanup 风险）：若旧代与新代共用同一个 patch 路径，旧代的迟到 cleanup
 * （superseded 的 open 落定、或旧 plan 随旧实例收尾）会把**新代刚写好**的 patch 一起删掉，
 * 新实例下一次启动就没有 `--patch` 了。
 * 这里只做一道**弱**保底：内容不再是本模块形态（已被别人改写）就一律不动手；
 * 内容读不到（已被删/无权限）同样不动手。真正的代际隔离由**每次一个独有 run 目录**保证
 * ——同一模块两次运行的 patch 内容是一样的，所以内容标记不能用来区分代际。
 */
export function reclaimPatchFile(patchFile: string, opts: { readFile?: (file: string) => string; removeFile?: (file: string) => void } = {}): void {
  const readFile = opts.readFile ?? ((file: string) => readFileSync(file, 'utf8'))
  const removeFile = opts.removeFile ?? ((file: string) => rmSync(file, { force: true }))
  let content: string
  try {
    content = readFile(patchFile)
  } catch {
    return
  }
  if (!content.includes(BRIDGE_PATCH_MARKER)) return
  try {
    removeFile(patchFile)
  } catch {
    /* 清理失败只影响下次重写，不影响正确性 */
  }
}

/**
 * 回滚一次**未返回 plan** 的 prepare 已经写下的部分资源（F3：mkdir 成功后 owner/patch 写盘失败，
 * 调用方拿不到 plan，也就永远没人调用 cleanup —— 孤儿 run 目录会一直留着）。
 *
 * 归属证明：run 目录由**本次调用独占新建**（已存在的同名目录在写盘前就被拒绝，见 prepareBridgeRuntime），
 * 即便独占创建目录，写入期间也可能被外部接管，因此先核对 owner，再逐项核对内容：
 * 只有「本次内容的前缀」（空文件 / 截断的部分内容 / 完整内容）才认定归属并删除；
 * 内容被改成别的什么，就保留文件、保留目录 —— 宁可留一个可诊断的残留，也不删归属不确定的资源。
 * 目录只用**非递归** rmdir：里面还有任何别的东西就保留（rmdir 会失败，绝不递归删除）。
 */
function rollbackAbortedRun(params: {
  dir: string
  ownerFile: string
  owner: string
  ownerWritten: boolean
  /** 本次调用尝试写入的文件与应写内容（顺序只是尽力而为，先 patch 后 owner，与 cleanup 一致） */
  writes: ReadonlyArray<readonly [file: string, content: string]>
  removeFile: (file: string) => void
}): void {
  const removable: string[] = []
  for (const [file, expected] of params.writes) {
    let actual: string
    try {
      const stat = lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink()) return
      actual = readFileSync(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return
      // owner 已完整落盘后又消失，不能再证明目录仍属本代。
      if (file === params.ownerFile && params.ownerWritten) return
      continue
    }
    if (file === params.ownerFile && params.ownerWritten && actual !== params.owner) return
    // 允许当前失败写入留下的部分内容；任意文件归属不明则保留整个 run。
    if (!expected.startsWith(actual)) return
    removable.push(file)
  }
  for (const file of removable.reverse()) {
    try {
      params.removeFile(file)
    } catch {
      return // patch 删不掉时也保留 owner，避免丢失归属证据。
    }
  }
  try {
    rmdirSync(params.dir)
  } catch {
    /* 非空/权限不足：保留目录，绝不递归删除 */
  }
}

/**
 * 准备一次桥启动所需的**隔离运行资源**：本次独有的运行目录 + 确定性文件名的 patch + 随机 key。
 * patch 内容只引用随包发布的桥包绝对路径，不写 DSH_HOME、不写工作区、不含任何凭据。
 *
 * 每次调用都用自己的 `run-<独立随机>` 子目录：即便旧代的 cleanup 迟到、甚至落在新一代写完
 * patch 之后，它也碰不到新一代的文件。
 * run id 与 host-only key **必须相互独立**：run 目录名会落盘、会出现在命令行与进程表里，
 * 绝不能由凭据派生（哪怕只取前缀）—— 否则凭据的一部分就被写进了路径。
 *
 * 失败路径：写 owner/patch 任一步失败都先回滚本次新建的部分资源再**原样抛出原错误**
 * （见 rollbackAbortedRun）；run 目录若已存在则直接拒绝，绝不覆盖/删除别人的运行资源。
 */
export function prepareBridgeRuntime(opts: PrepareBridgeOptions): BridgeRuntimePlan {
  const mkdir = opts.mkdir ?? ((dir: string) => {
    mkdirSync(opts.runtimeDir, { recursive: true })
    mkdirSync(dir) // 原子地拒绝已存在的目录，不能用 recursive 复用另一代目录。
  })
  const writeFile = opts.writeFile ?? ((file: string, data: string) => writeFileSync(file, data, { encoding: 'utf8', flag: 'wx' }))
  const removeFile = opts.removeFile ?? ((file: string) => rmSync(file, { force: true }))
  const randomKey = opts.randomKey ?? (() => randomBytes(32).toString('hex'))
  const randomRunId = opts.randomRunId ?? (() => randomBytes(8).toString('hex'))

  const key = randomKey()
  reclaimExpiredRuns(opts.runtimeDir)
  const runId = randomRunId()
  if (!/^[\w-]+$/.test(runId)) throw new Error('Invalid bridge run id')
  const dir = join(opts.runtimeDir, `${BRIDGE_RUN_DIR_PREFIX}${runId}`)
  // 本代目录必须由这次调用独占新建：它一旦已经存在，里面可能是另一代（或用户）的资源。
  // 这时既不写入（不覆盖别人的 owner/patch），也不删除 —— 明确失败，由调用方按「无桥」处理。
  // （默认 run id 是 8 字节随机，正常路径不可能撞；这个判据只在注入固定 id 或极端巧合时生效。）
  if (existsSync(dir)) throw new Error(`bridge run directory already exists: ${dir}`)
  const ownerFile = join(dir, RUN_OWNER_FILE)
  const owner = JSON.stringify({ version: 1, pid: process.pid, owner: randomUUID() })
  const patchFile = join(dir, BRIDGE_PATCH_FILE_NAME)
  const patch = buildBridgePatchFile(opts.location.entry)
  mkdir(dir)
  let ownerWritten = false
  try {
    writeFile(ownerFile, owner)
    ownerWritten = true
    writeFile(patchFile, patch)
  } catch (error) {
    // wx 遇到外来同名文件时不拥有它；保留整个目录供诊断。
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      rollbackAbortedRun({
        dir, ownerFile, owner, ownerWritten,
        writes: ownerWritten ? [[ownerFile, owner], [patchFile, patch]] : [[ownerFile, owner]],
        removeFile
      })
    }
    throw error // 原错误原样上抛：调用方的降级/报错判据不因回滚而改变
  }
  return {
    key,
    runtimeDir: dir,
    patchFile,
    bridgeDir: opts.location.dir,
    childEnv: () => ({ [BRIDGE_KEY_ENV]: key }),
    cleanup: () => {
      try { if (readFileSync(ownerFile, 'utf8') !== owner) return } catch { return }
      reclaimPatchFile(patchFile, { removeFile })
      if (existsSync(patchFile)) return
      try { removeFile(ownerFile); rmdirSync(dir) } catch { /* 非空目录不递归删除 */ }
    }
  }
}

/** 生成一个桥实例 id（宿主侧只用它做日志关联；真正的实例身份由 dsh 进程铸造）。 */
export function newBridgeRunId(): string {
  return randomUUID()
}
