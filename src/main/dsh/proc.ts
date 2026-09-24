import { execFile } from 'child_process'
import { promises as fsp } from 'fs'
import { join } from 'path'
import log from 'electron-log'

/**
 * dsh web 进程树的可靠终止与孤儿清扫。
 *
 * 背景（源码 + 实测双确认）：Windows 上 `dsh web` 经 cmd.exe 包裹启动时，
 * Windows 上 Node 的 `child.pid` 是 npm 的 dsh.cmd shim 外面那层 cmd.exe，真正长驻的是
 * 它的子进程 `node …/@deepseek-ai/dsh/lib/bin.js`。退出路径若 fire-and-forget 地
 * `spawn('taskkill', ['/F','/T','/PID', child.pid])`，app 退出会把 taskkill 本身截断 ——
 * 实测只杀掉 cmd.exe 包裹层就没了，留下 node 孙进程一直活着。DSH 的会话写锁
 * （Windows 命名信号量 / POSIX session.lock flock）**不过期**，持有者进程不死锁就不放，
 * 于是孤儿占着会话，下次开 dsh 就报「当前会话已被占用」。
 *
 * 这里提供三层防护，覆盖面递增、依赖递减：
 *   1. `killPidTree` —— 等树杀真正完成，并对 `taskkill /T` 漏掉的子孙逐个补刀。
 *      覆盖「本次 LyShell 自己起的实例」（close() 时 root pid 还在手）。
 *   2. `sweepOrphanDshWeb` —— 按 LyShell 的 spawn 签名（见 DSH_WEB_SPAWN_ARGS）找
 *      「父进程链已断」的孤儿并杀掉。覆盖崩溃/强杀遗留（root pid 已随 Electron 丢失）。
 *      依赖进程表枚举（Windows 上走 WMI）。
 *   3. `recoverRecordedPids` —— 启动时把 spawn 出的 pid 留档，重启核对镜像名、
 *      命令行及孤儿状态后回收。镜像名可由 tasklist 读取；Windows 上若 WMI 进程表
 *      不可用，就无法安全确认命令行与父链，只保留记录等待下次重试。
 *
 * 误杀防护：只认签名 + 孤儿两个条件 —— 用户手动起的 `dsh web --port 18123` 不匹配签名。
 * 跨实例的残余误杀面见 isAnchoredProcess 的说明。
 */

/**
 * LyShell spawn `dsh web` 的固定签名 —— web.ts 的 spawn 与这里的孤儿 matcher 共用同一份，
 * 改参数只改这一处。两处各写一份字面量的话，将来给 dsh web 加个参数 sweep 会静默失效。
 */
export const DSH_WEB_COMMAND = 'dsh'
export const DSH_WEB_SPAWN_ARGS = ['web', '--port', '0', '--no-open'] as const

/** 由 DSH_WEB_SPAWN_ARGS 拼出一条示意命令行（测试用：必须被 isLyShellDshWebCmdline 命中）。 */
export function buildDshWebCmdline(
  command: string = DSH_WEB_COMMAND,
  args: readonly string[] = DSH_WEB_SPAWN_ARGS
): string {
  return [command, ...args].join(' ')
}

/** 进程表一行。name/cmdline 来自 Win32_Process（或 ps 的 comm/args）；cmdline 可能为 null（受保护进程）。 */
export interface ProcInfo {
  pid: number
  ppid: number
  name: string
  cmdline: string | null
}

/**
 * 树杀结果。
 *   - `killed` —— 目标整棵树都确认消失了；
 *   - `survivors` —— 杀完仍有活着的（pids 是名单）；
 *   - `unverified` —— 读不出进程表，**不能**把「root 没了」当成「整棵树没了」。
 *     这正是 killPidTree 要修的场景：枚举失败时静默报成功会盖住漏掉的 node 孙进程。
 */
export type KillTreeResult = {
  /** 本次尝试清除的 pid 及其身份（补刀核对 / 失败时留档给 recoverRecordedPids） */
  targets: Array<{ pid: number; name: string; cmdline: string | null }>
} & (
  | { status: 'killed' }
  | { status: 'survivors'; pids: number[] }
  | { status: 'unverified'; message: string }
)

/** pid 留档条目：spawn 时写入 userData，下次启动据此查找并核对遗留进程。 */
export interface RecordedPid {
  pid: number
  /**
   * 写入时的**实测**镜像名。回收前核对，防 PID 复用把无关进程杀掉。
   * 空串 = 当时确实没查到（**绝不写猜测值**：猜出来的名字在 POSIX 上与真实镜像 node 不符
   * 会让回收永远被跳过，在 Windows 上又可能撞上复用成同名 cmd.exe 的无关进程而误杀）。
   * 空串的语义是「身份未知」，回收侧会要求更强的证据（启动时刻 / 命令行签名），
   * 见 recoverRecordedPids。
   */
  name: string
  cmdline: string | null
  /**
   * 这条记录什么时候写下的，**也是 PID 复用判据的基准**（进程启动晚于它 = 这个号已经被
   * 别人拿走）。因此它只能表示「我们观察到该进程的时刻」，绝不能在进程可能已经换人之后
   * 往前推 —— 见 recoverRecordedPids 的时间判据。
   */
  recordedAt: number
  /**
   * 归属：'root' = 这个 pid 是我们自己 spawn 的进程（记录权威来自「我们起的」）。
   * `undefined` = 旧格式记录（当时还会把进程表里推导出来的子孙 pid 一并写档，
   * 无法区分 root 与子孙）。回收侧对两者同口径：没有启动时刻证据时都要
   * 「签名命中 + 孤儿确认」双条件才动手（旧格式记录不因缺归属标记而永久滞留）。
   * 保留该字段是为了区分留档来源，便于排查。
   */
  kind?: 'root'
}

/**
 * 可注入的 IO 面 —— killPidTree / sweepOrphanDshWeb / recoverRecordedPids 全是
 * 「纯逻辑 + 少量 IO」，IO 面抽出来才能测「根先死→子孙补刀」「枚举失败→不许报成功」
 * 这两条最关键的路径（模块直接 import child_process 是没法 stub 的）。
 */
export interface ProcDeps {
  /** 枚举进程表；null = 枚举失败（区别于空表 = 无进程） */
  listProcesses?: () => Promise<ProcInfo[] | null>
  isPidAlive?: (pid: number) => boolean
  execFile?: (file: string, args: string[], opts: { timeout: number; maxBuffer?: number }) => Promise<string>
  signalPid?: (pid: number, signal: NodeJS.Signals) => void
  sleep?: (ms: number) => Promise<void>
  /**
   * 绝对截止时间（`now()` 的毫秒时间戳）。给了就按「剩余预算」收窄每一步的超时，并在
   * 预算耗尽时提前收手（返回 unverified + targets，让调用方留档给下次启动兜底）。
   * 退出路径的等待预算是硬的：killPidTree 的串行上界（枚举 8s + 树杀 5s + 补刀枚举 8s +
   * 补刀 5s）远超它，不收窄就等于让 app.exit() 把还在飞的 taskkill 截断。
   * 单步超时有 1.5s 下限，故实际最多比 deadline 多花一步的时间。
   */
  deadline?: number
  /** 当前时间（毫秒）。默认 Date.now；测试注入假钟用。 */
  now?: () => number
  /** 查 pid 的命令行（身份签名证据）。默认走 lookupCmdline；无此能力的平台返回 null。 */
  lookupCmdline?: (pid: number) => Promise<string | null>
  /** 查 pid 的进程启动时刻（毫秒时间戳，判断 PID 是否被复用的硬证据）。默认走 lookupProcessStartTime。 */
  lookupStartTime?: (pid: number) => Promise<number | null>
  /**
   * 「这个 pid 属于当前会话，别碰」的判据。恢复流程在动手前（以及核对期间）都要问一次：
   * 恢复与新的 open() 是并发的，旧留档里的 pid 可能恰好被本会话刚 spawn 的进程复用，
   * 镜像名还一样 —— 不设这道门，恢复会把刚起来的 dsh 杀掉。
   */
  isProtectedPid?: (pid: number) => boolean
  /**
   * 查 pid 的镜像名。默认走 lookupImageName（tasklist / ps，不依赖 WMI 全表枚举）。
   * killPidTree 的主力树杀前核对用它做**轻量**身份比对 —— 刻意不为核对再拉一遍全表：
   * sweep 传快照进来就是为了避免 N+1 次全表枚举，补刀阶段的 sameIdentity（Name+CommandLine）
   * 仍走全表，两道闸分工不同。
   */
  lookupImageName?: (pid: number) => Promise<string | null>
  /** 管理器 spawn 前的观察时刻；关闭该 root 前必须再次核对进程启动时刻。 */
  ownedRootSpawnedAt?: number
  /** 孤儿清扫刚核实的 root 启动时刻；树杀前再次比对，缩小最后一段 PID 复用窗口。 */
  expectedRootStartTime?: number
}

/**
 * 解析 PowerShell `ConvertTo-Json` 的进程表输出。
 * 纯函数。PS 对空结果/单结果/多结果三种形状输出不一致（null、裸对象、数组），这里都收；
 * 字段缺失或类型不对的行直接丢弃。
 * **整体解析失败返回 null**（区别于空表的 []）—— 调用方要按「枚举失败」降级，
 * 不能把「读不出」当成「没有孤儿」。
 */
export function parseWin32ProcessJson(text: string): ProcInfo[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const rows: unknown[] =
    Array.isArray(parsed) ? parsed : parsed === null || parsed === undefined ? [] : [parsed]
  const out: ProcInfo[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) continue
    const r = row as Record<string, unknown>
    const pid = Number(r.ProcessId)
    if (!Number.isInteger(pid) || pid <= 0) continue
    const ppid = Number(r.ParentProcessId)
    out.push({
      pid,
      // ppid 允许为 0 / 缺失（System Idle 等）：统一置 0，向上走父链时按「找不到父」处理
      ppid: Number.isInteger(ppid) && ppid > 0 ? ppid : 0,
      name: typeof r.Name === 'string' ? r.Name : '',
      cmdline: typeof r.CommandLine === 'string' ? r.CommandLine : null
    })
  }
  return out
}

/**
 * 解析 `ps -eo pid=,ppid=,args=` 的输出。纯函数。
 * name 取 args 首 token 的 basename —— 不用 comm= 列（macOS 上可含空格，切分不稳）。
 * 解析不了的行直接跳过；整体不抛（ps 的行格式是稳定的，坏行跳过即可）。
 */
export function parsePsOutput(text: string): ProcInfo[] {
  const out: ProcInfo[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    const ppid = Number(m[2])
    const args = m[3]
    if (!Number.isInteger(pid) || pid <= 0) continue
    const first = tokenizeCmdline(args)[0] ?? ''
    // / 与 \ 都切：POSIX 主用 /，但 ps 行里也可能混进 Windows 风格路径
    const name = first.split(/[\\/]/).pop() ?? first
    out.push({
      pid,
      ppid: Number.isInteger(ppid) && ppid > 0 ? ppid : 0,
      name,
      cmdline: args || null
    })
  }
  return out
}

/**
 * 把命令行切成 argv（双引号包裹段视为一个 token，引号本身去掉，不处理转义）。
 * 纯函数。不能用空白直接 split：`"C:\Program Files\node.exe"` 会被拆散；
 * 也不能走 wmic 的 CSV（CommandLine 里的逗号/换行会把列切碎）—— 进程表只能拿
 * PowerShell JSON，再在这里手工分词。
 */
export function tokenizeCmdline(cmdline: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < cmdline.length; i++) {
    const c = cmdline[i]
    if (c === '"') {
      inQuote = !inQuote
      continue
    }
    if (!inQuote && (c === ' ' || c === '\t')) {
      if (cur) {
        out.push(cur)
        cur = ''
      }
      continue
    }
    cur += c
  }
  if (cur) out.push(cur)
  return out
}

/** 命令行里是否出现 dsh 可执行入口（`dsh` / `dsh.cmd` / `…\dsh\lib\bin.js`）。纯函数。 */
function looksLikeDshArgv(argv: readonly string[]): boolean {
  return argv.some((t) => {
    const lower = t.toLowerCase().replace(/\//g, '\\')
    return (
      lower === 'dsh' ||
      lower === 'dsh.cmd' ||
      lower === 'dsh.exe' ||
      lower.endsWith('\\dsh') ||
      lower.endsWith('\\dsh.cmd') ||
      lower.endsWith('\\dsh.exe') ||
      (lower.endsWith('\\bin.js') && lower.includes('\\dsh'))
    )
  })
}

/**
 * argv 里是否出现 `web` **子命令**。纯函数。
 * 位置判定：`web` 的前一个 token 不能是 flag —— 否则它只是 flag 的值
 * （`dsh --profile web …` 里的 web 就是 `--profile` 的取值，不是子命令）。
 */
function hasWebSubcommand(argv: readonly string[]): boolean {
  return argv.some((a, i) => a === 'web' && (i === 0 || !argv[i - 1].startsWith('-')))
}

/**
 * 是否 LyShell 自己 spawn 的 `dsh web`。纯函数，便于单测。
 *
 * 签名收得很死：dsh 入口 + `web` 子命令 + `--port 0` + `--no-open`，四项齐全才算。
 * 刻意不放宽到任意 `dsh web` —— 用户手动起的 `dsh web --no-open --port 18123`、
 * `dsh web --port 8080` 等都不在清扫范围，误杀等于毁掉用户自己开的会话。
 * 判据与 DSH_WEB_SPAWN_ARGS 同源语义（测试见 buildDshWebCmdline）。
 */
export function isLyShellDshWebCmdline(cmdline: string | null | undefined): boolean {
  if (!cmdline) return false
  const argv = tokenizeCmdline(cmdline)
  if (argv.length === 0) return false
  if (!looksLikeDshArgv(argv)) return false
  if (!hasWebSubcommand(argv)) return false
  if (!argv.includes('--no-open')) return false
  const portIdx = argv.findIndex((a) => a === '--port' || a.toLowerCase().startsWith('--port='))
  if (portIdx === -1) return false
  const raw = argv[portIdx]
  // `--port 0` 是 LyShell 的 OS 随机端口签名；`--port=0` 一并收
  const portVal = raw === '--port' ? argv[portIdx + 1] : raw.slice(raw.indexOf('=') + 1)
  return portVal === '0'
}

/** shell 包裹层：向上找祖先时跳过这些，再判断「最终祖先是否还活着」。 */
const SHELL_WRAPPER_RE = /^(cmd|conhost|powershell|pwsh|windowsterminal|sh|bash|zsh|dash|fish|ksh|csh|tcsh)(\.exe)?$/i

/**
 * 孤儿收尸者：POSIX 上父进程一死，内核会把子进程 reparent 给 PID 1（init / launchd / systemd）。
 * **它在进程表里活着 ≠ 有人托管** —— 不特判的话，被收养的 dsh web 会被当成「挂在活根上」
 * 而跳过清扫，这正是 POSIX 下孤儿清扫一直静默失效的根因。
 *
 * 不会误伤正常实例：POSIX 上 LyShell 用 shell:false spawn，dsh node 的父链是
 * node → LyShell（非 shell）→ ……，走到 LyShell 就判定为有托管、根本到不了 PID 1；
 * 只有整条父链只剩 shell 包裹层、最终落到 init 时（= 原父链已断、被收养）才会被判为孤儿。
 * Windows 上 PID 1 不是有效进程（PID 从 4 起、均为 4 的倍数），此分支不命中，行为不变。
 */
const REAPER_PID = 1

/**
 * 进程是否仍挂在一棵有活根的进程树上（= 不是孤儿）。
 * 纯函数，输入是同一时刻的进程表快照。
 *
 * 向上走父链、跳过 shell 包裹层（cmd.exe 等）：
 *   - 某一环的父进程不在表里 → 父已死 → 孤儿（实测里 4 个遗留 dsh web 全是这一形态：
 *     taskkill 杀掉了 cmd.exe 包裹层，node 的 ppid 指向已消失的 pid）；
 *   - 父进程是 PID 1（POSIX 的 init/launchd）→ 被收养 = 原父链已断 → 孤儿；
 *   - 走到一个「存活的非 shell 祖先」→ 还有人托管（比如活着的 LyShell / 用户的终端）→ 不孤儿。
 * 深度上限兜住 PID 复用造成的环；环按「仍被活树挂着」保守处理（宁可漏杀不误杀）。
 *
 * 已知残余面：若父进程死后被 reparent 给某个**非 1** 的 subreaper（systemd --user、
 * docker-init 等），这里仍会把它当成活根 —— 属于漏杀，不影响正确性。
 *
 * 跨实例的残余误杀面（说准确点，不是「不可能」）：dev 与正式版 LyShell 可并存，各有各的
 * dsh web。若某实例的 cmd.exe 包裹层先退出、node 仍活着，它在 sweep 眼里与崩溃遗留
 * 无法区分（父链已断、签名命中），会被另一个实例收掉。窗口很窄（包裹层通常不比 node
 * 先单独死），但确实存在 —— 误判后果是那个实例的 Web 页签掉线，重开即可，不丢数据。
 */
export function isAnchoredProcess(start: ProcInfo, byPid: ReadonlyMap<number, ProcInfo>): boolean {
  const seen = new Set<number>([start.pid])
  let cur: ProcInfo = start
  for (let depth = 0; depth < 32; depth++) {
    const parent = byPid.get(cur.ppid)
    if (!parent) return false
    // 收尸者不算「托管」：放在环判断之前 —— 被 init 收养就是孤儿，与它是否出现过无关
    if (parent.pid === REAPER_PID) return false
    if (seen.has(parent.pid)) return true
    seen.add(parent.pid)
    if (!SHELL_WRAPPER_RE.test(parent.name)) return true
    cur = parent
  }
  return true
}

/**
 * 找出需要清扫的 dsh web 孤儿 pid。
 * 纯函数：签名命中且未挂活根（见 isAnchoredProcess）才收，升序返回。
 */
export function findOrphanDshWebPids(procs: readonly ProcInfo[]): number[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  const out: number[] = []
  for (const p of procs) {
    if (!isLyShellDshWebCmdline(p.cmdline)) continue
    if (isAnchoredProcess(p, byPid)) continue
    out.push(p.pid)
  }
  return out.sort((a, b) => a - b)
}

/**
 * 收集 rootPid 的全部子孙 pid（不含 root 自己）。纯函数。
 * `taskkill /T` 是「从 root 往下走」，root 已死时它直接失败、整棵子树全漏 —— 先记下
 * 名单，杀完再按名单补刀，不依赖 /T 的树遍历。
 */
export function collectDescendantPids(procs: readonly ProcInfo[], rootPid: number): number[] {
  const childrenOf = new Map<number, number[]>()
  for (const p of procs) {
    const list = childrenOf.get(p.ppid)
    if (list) list.push(p.pid)
    else childrenOf.set(p.ppid, [p.pid])
  }
  const out: number[] = []
  const seen = new Set<number>([rootPid])
  const queue = [rootPid]
  while (queue.length > 0) {
    const cur = queue.pop() as number
    for (const child of childrenOf.get(cur) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      out.push(child)
      queue.push(child)
    }
  }
  return out
}

/**
 * 身份是否同一个进程。补刀前核对用，防 PID 复用把 /F 砸到无关进程上。
 * Name 必须一致；CommandLine 两边都读得到才比（受保护进程读不到，降级到只比 Name）。
 */
function sameIdentity(a: ProcInfo, b: ProcInfo): boolean {
  if (a.name.toLowerCase() !== b.name.toLowerCase()) return false
  if (a.cmdline !== null && b.cmdline !== null && a.cmdline !== b.cmdline) return false
  return true
}

/**
 * 主力树杀前的身份核对：从候选名单里挑出「确认可以动手」的 pid。纯函数。
 *
 * 补刀阶段的 sameIdentity 挡不住**主力树杀**那一段：名单落定（尤其是 sweep 传进来的
 * 旧快照）到 taskkill /signal 之间，pid 可能已经退出并被别人拿走。这里用 lookupImageName
 * 做一次轻量名比对，把复用进程挡在第一轮之外。
 *
 * 判据（与补刀阶段同一安全偏好：宁可漏杀不误杀）：
 *   - 查得到名字且与快照一致 → 动手；
 *   - 名字对不上 = 已被复用 → 一律不动手；
 *   - 查不到名字（已退出 / 查询失败）或快照里没身份 → 不凭裸 pid 猜测归属。
 */
export function selectFirstRoundPids(opts: {
  candidates: readonly number[]
  rootPid: number
  beforeById: ReadonlyMap<number, { name: string }>
  /** lookupImageName 的结果：pid → 当前镜像名（null = 查不到；**缺失**视为没查过，跳过） */
  liveNameByPid: ReadonlyMap<number, string | null>
}): number[] {
  const out: number[] = []
  for (const p of opts.candidates) {
    const before = opts.beforeById.get(p)
    const liveName = opts.liveNameByPid.get(p)
    if (liveName === undefined) continue  // 没查过：无从核对，也不该当「查不到」处理
    if (liveName === null || !before?.name) continue
    if (before.name.toLowerCase() !== liveName.toLowerCase()) {
      log.warn(`skip first-round pid ${p}: identity changed (${before.name} → ${liveName}), likely pid reuse`)
      continue
    }
    out.push(p)
  }
  return out
}

/** 定位 Windows PowerShell 5.1（全路径，不依赖 PATH —— 对齐 env/refresh.ts 的做法）。 */
function powershellPath(): string {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
  return join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/** Windows 系统工具全路径（不依赖 PATH，与 powershellPath 同一风格）。 */
function systemTool(name: string): string {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
  return join(systemRoot, 'System32', name)
}

function execFileAsync(
  file: string,
  args: string[],
  opts: { timeout: number; maxBuffer?: number }
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    // 不走 shell（避免 Windows 引号问题，对齐 worktree.ts 的 git 封装）
    execFile(
      file,
      args,
      { encoding: 'utf8', windowsHide: true, ...opts },
      (error, stdout) => {
        if (error) rejectPromise(error)
        else resolvePromise(stdout)
      }
    )
  })
}

function defaultSignalPid(pid: number, signal: NodeJS.Signals): void {
  process.kill(pid, signal)
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

/**
 * 单个步骤（枚举 / taskkill / 镜像名查询）的最低超时。
 *
 * 预算收窄不能把已经发出的 taskkill 截成半途而废 —— 一次走不完的树杀比超一点预算更糟，
 * 所以哪怕剩余预算已经见底，这一步仍给 1.5s 的下限。
 *
 * **导出给退出路径用**：killPidTree 最多比 deadline 多花「一步」的时间，调用方的等待余量
 * （index.ts 的 QUIT_DSH_EXIT_GRACE_MS）必须严格大于这个下限，否则 app.exit() 会赶在
 * 「最后一步 taskkill + 写留档」之前触发。
 */
export const KILL_STEP_TIMEOUT_FLOOR_MS = 1500

const MIN_STEP_TIMEOUT_MS = KILL_STEP_TIMEOUT_FLOOR_MS

/** POSIX 树杀里 SIGTERM → SIGKILL 之间的收尾窗口（进程退出后 isPidAlive 的可见延迟）。 */
const POSIX_KILL_GRACE_MS = 200

/** 距 deadline 还剩多少毫秒；未设 deadline 时为 Infinity。纯函数。 */
function remainingMs(deps?: ProcDeps): number {
  if (deps?.deadline === undefined) return Number.POSITIVE_INFINITY
  const now = deps.now ?? Date.now
  return Math.max(0, deps.deadline - now())
}

/**
 * 按剩余预算收窄一步 IO 的超时：min(desired, max(剩余, 下限))。
 * 没设 deadline 时原样返回 desired（历史行为不变）。纯函数。
 */
function clampTimeout(desired: number, deps?: ProcDeps): number {
  const left = remainingMs(deps)
  if (left === Number.POSITIVE_INFINITY) return desired
  return Math.min(desired, Math.max(left, MIN_STEP_TIMEOUT_MS))
}

/**
 * 枚举本机进程表。返回 null 表示枚举失败（区别于空表 = 确实没有进程）——
 * 调用方必须区分：失败时「没找到孤儿」≠「没有孤儿」，不许静默当成功。
 * 绝不抛。
 *
 * Windows：PowerShell Get-CimInstance。不用 wmic：其 CSV 会把 CommandLine 里的
 *   逗号/换行当分隔符，列是碎的。
 * POSIX：`ps -eo pid=,ppid=,args=`（dist:mac 是正式目标，不能只活在 win32 分支里）。
 */
export async function listProcesses(deps?: ProcDeps): Promise<ProcInfo[] | null> {
  const exec = deps?.execFile ?? execFileAsync
  try {
    if (process.platform === 'win32') {
      const script = [
        // 中文 Windows 上控制台默认 GBK，不显式置 UTF-8 会把中文路径/参数按 GBK 解坏（对齐 refresh.ts）
        '$OutputEncoding=[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;',
        'Get-CimInstance Win32_Process|Select-Object ProcessId,ParentProcessId,Name,CommandLine|ConvertTo-Json -Compress'
      ].join('')
      const stdout = await exec(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', script], {
        timeout: clampTimeout(8000, deps),
        maxBuffer: 8 * 1024 * 1024
      })
      return parseWin32ProcessJson(stdout)
    }
    const stdout = await exec('ps', ['-eo', 'pid=,ppid=,args='], {
      timeout: clampTimeout(8000, deps),
      maxBuffer: 8 * 1024 * 1024
    })
    return parsePsOutput(stdout)
  } catch (error) {
    log.warn('listProcesses failed:', (error as Error).message)
    return null
  }
}

/** pid 是否还在。EPERM（在但无权限）算存活；ESRCH 才算不在。 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 查 pid 的镜像名。**不依赖 WMI**（tasklist / ps 都能走），是 recoverRecordedPids 在
 * 进程表枚举退化时的核对手段。找不到（已退出）返回 null。绝不抛。
 */
export async function lookupImageName(pid: number, deps?: ProcDeps): Promise<string | null> {
  const exec = deps?.execFile ?? execFileAsync
  try {
    if (process.platform === 'win32') {
      const stdout = await exec(systemTool('tasklist.exe'), ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        timeout: clampTimeout(5000, deps)
      })
      // 有进程: "node.exe","1234","Console","1","12,345 K"
      // 无进程: INFO: No tasks are running which match the specified criteria.
      const line = stdout
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.startsWith('"'))
      if (!line) return null
      const m = /^"([^"]+)"/.exec(line)
      return m ? m[1] : null
    }
    const stdout = await exec('ps', ['-p', String(pid), '-o', 'comm='], { timeout: clampTimeout(5000, deps) })
    const name = stdout.trim()
    return name || null
  } catch {
    return null
  }
}

/**
 * 查 pid 的命令行，用于给「没有镜像名可核对」的留档补**签名证据**。绝不抛。
 *
 * POSIX 用 `ps -p pid -o args=`（轻量、不需要 WMI，与第三层防护「不依赖进程表枚举」的
 * 定位一致）；Windows 上非 WMI 路径拿不到 CommandLine（tasklist 只给镜像名），返回 null。
 */
export async function lookupCmdline(pid: number, deps?: ProcDeps): Promise<string | null> {
  if (process.platform === 'win32') return null
  const exec = deps?.execFile ?? execFileAsync
  try {
    const stdout = await exec('ps', ['-p', String(pid), '-o', 'args='], { timeout: clampTimeout(5000, deps) })
    const cmdline = stdout.trim()
    return cmdline || null
  } catch {
    return null
  }
}

/**
 * 查 pid 的进程启动时刻（毫秒时间戳）——**判断「PID 是否已被复用」的硬证据**。
 * 留档里的 name/cmdline 都可能撞上同名/同命令行的无关进程，而「这个进程比我们的记录还晚
 * 才启动」是决定性的：记录写下时它就已经在跑，不可能比记录晚出生。
 *
 * **不依赖 WMI**：Windows 走 PowerShell 的 `Get-Process`（.NET/PDH，不是 CIM 查询），
 * POSIX 走 `ps -o lstart=`。拿不到（命令不可用 / 超时 / 进程已退出）返回 null，
 * 调用方按「无法判定」处理（回到 name / 签名核对，不做时间判断）。绝不抛。
 */
export async function lookupProcessStartTime(pid: number, deps?: ProcDeps): Promise<number | null> {
  const exec = deps?.execFile ?? execFileAsync
  try {
    if (process.platform === 'win32') {
      const script = [
        // 中文 Windows 上控制台默认 GBK，显式置 UTF-8（对齐 listProcesses）
        '$OutputEncoding=[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;',
        `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`
      ].join('')
      const stdout = await exec(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', script], {
        timeout: clampTimeout(5000, deps)
      })
      return parseProcessStartTime(stdout)
    }
    const stdout = await exec('ps', ['-p', String(pid), '-o', 'lstart='], { timeout: clampTimeout(5000, deps) })
    return parseProcessStartTime(stdout)
  } catch {
    return null
  }
}

/** 解析进程启动时刻文本（PowerShell 的 ISO 串 / ps 的 lstart 格式）。纯函数，解析不了返回 null。 */
export function parseProcessStartTime(text: string): number | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const ms = Date.parse(trimmed)
  return Number.isFinite(ms) ? ms : null
}

/**
 * 判定「记录写下之后这个 pid 才被别的进程拿去用」的时间容差。
 *
 * 新记录的 recordedAt 取在 spawn 前；旧格式可能在进程启动后才写入。
 * 留 5s 余量吸收 spawn 延迟、lstart 的秒级粒度与时钟抖动。超过它才判定 PID 复用；
 * 容差内仍须核对命令行和孤儿状态，不能把时间接近当作归属证明。
 */
const PID_REUSE_TOLERANCE_MS = 5000
// ps -o lstart= 只有秒精度；超出这个窗口就不能把当前 PID 当成刚 spawn 的 root。
const OWNED_ROOT_START_TOLERANCE_MS = 1000

/**
 * 树杀 pid 及其全部子孙，**等它真正完成**。
 *
 * 顺序：先枚举子孙名单 → `taskkill /F /T` → 名单里还活着的补刀。补刀是关键：
 * /T 从 root 往下走，root（cmd.exe 包裹层）一旦先死，树遍历就断了，node 孙进程全漏
 * —— 实测遗留的孤儿就是这么来的。
 *
 * 两个安全阀：
 *   - **枚举失败不许报成功**：读不出进程表时「root 没了」≠「整棵树没了」，返回
 *     `unverified`，让调用方告警并走 recoverRecordedPids 兜底；
 *   - **动手前核对身份**：名单来自可能已过期数秒的旧快照（PowerShell 枚举本身就要
 *     0.5–3s），直接按裸 pid taskkill /F 有 PID 复用误杀面。主力树杀前用 lookupImageName
 *     做轻量名比对（不拉全表，保住 sweep 传快照省下的 N+1 枚举），补刀前再取新快照比
 *     Name/CommandLine（见 selectFirstRoundPids / sameIdentity）。
 *
 * `snapshot` 可选：调用方手里已有一份进程表（如 sweep 收了一批孤儿）时传进来，
 * 避免每个 pid 再各枚举一遍全表。
 *
 * `deps.deadline` 可选：退出路径的等待预算是硬的，给了就按剩余预算收窄每一步超时；预算
 * 已不足以核对身份时不再按裸 PID 树杀，返回 unverified + targets 留档给下次启动兜底。
 * 绝不抛（补刀路径调用，抛=开不了 Web / 关不掉）。
 */
export async function killPidTree(
  pid: number,
  snapshot?: readonly ProcInfo[],
  deps?: ProcDeps
): Promise<KillTreeResult> {
  const listProcs = deps?.listProcesses ?? (() => listProcesses(deps))
  const alive = deps?.isPidAlive ?? isPidAlive
  const exec = deps?.execFile ?? execFileAsync
  const signal = deps?.signalPid ?? defaultSignalPid
  const sleep = deps?.sleep ?? defaultSleep
  const getImageName =
    deps?.lookupImageName ?? ((p: number): Promise<string | null> => lookupImageName(p, deps))
  const getStartTime =
    deps?.lookupStartTime ?? ((p: number): Promise<number | null> => lookupProcessStartTime(p, deps))

  try {
    // 预算已不足一步时跳过枚举；随后身份无法核对就收手，由留档恢复处理。
    const budgetTooTight = remainingMs(deps) < MIN_STEP_TIMEOUT_MS
    const procs = snapshot !== undefined ? snapshot : budgetTooTight ? null : await listProcs()
    const enumerated = procs !== null
    const byPid = new Map((procs ?? []).map((p) => [p.pid, p]))
    const descendantPids = procs !== null ? collectDescendantPids(procs, pid) : []
    const allPids = [pid, ...descendantPids]
    const targets = allPids.map((p) => {
      const info = byPid.get(p)
      return { pid: p, name: info?.name ?? '', cmdline: info?.cmdline ?? null }
    })

    // --- 主力树杀前的身份核对 ---
    // 名单落定（尤其是 sweep 传进来的旧快照）到 taskkill/signal 之间 PID 可能被复用，
    // 补刀阶段的 sameIdentity 保护不到这一段。用 lookupImageName（tasklist/ps，不拉全表）
    // 做轻量名比对，通过的才进第一轮 —— 详见 selectFirstRoundPids。
    // 枚举本身也会消耗预算，必须在它结束后重新检查。剩余不足一步时不能跳过核对
    // 直接树杀：持有 ChildProcess 只证明过去的归属，PID 此刻可能已被复用。
    // Windows 的 /T 从 root 走活树、不按名单杀子孙，故只需核对 root；POSIX 是按名单逐个
    // signal，名单里每个 pid 都要核对。
    const canCheckIdentity = !budgetTooTight && remainingMs(deps) > MIN_STEP_TIMEOUT_MS
    let firstRoundPids: number[] = []
    if (canCheckIdentity) {
      const checkPids = process.platform === 'win32' ? [pid] : allPids
      // 并发查询：每个查询的超时都带 1.5s 下限（clampTimeout），串行的话 N 个候选能把
      // deadline 拖穿 N 步 —— 退出路径会在主力 kill 发出前被 app.exit() 截断。并发把
      // 超额压回「至多一步」，与 deadline 注释承诺的不变量一致。
      const liveNameByPid = new Map<number, string | null>()
      const [rootStartTime] = await Promise.all([
        deps?.ownedRootSpawnedAt === undefined && deps?.expectedRootStartTime === undefined
          ? Promise.resolve(null) : getStartTime(pid),
        Promise.all(checkPids.map(async (p) => {
          liveNameByPid.set(p, await getImageName(p))
        }))
      ])
      firstRoundPids = selectFirstRoundPids({
        candidates: checkPids,
        rootPid: pid,
        beforeById: byPid,
        liveNameByPid
      })
      if (deps?.ownedRootSpawnedAt !== undefined && (
        rootStartTime === null ||
        Math.abs(rootStartTime - deps.ownedRootSpawnedAt) > OWNED_ROOT_START_TOLERANCE_MS
      )) {
        firstRoundPids = firstRoundPids.filter((p) => p !== pid)
      }
      if (deps?.expectedRootStartTime !== undefined && rootStartTime !== deps.expectedRootStartTime) {
        firstRoundPids = firstRoundPids.filter((p) => p !== pid)
      }
    }

    // root 未通过核对时不能进入补刀：否则第二轮仍可能按旧快照把同一个裸 pid 杀掉。
    if (!firstRoundPids.includes(pid)) {
      return { status: 'unverified', message: `root ${pid} identity unverified; skipped tree kill`, targets }
    }

    // --- 第一轮：整树清除 ---
    // 这一步是主力手段，一定发出去（哪怕预算已见底，clampTimeout 也会给它一个下限）；
    // 但被核对挡掉的 pid（root 已被复用）一个都不碰。
    if (process.platform === 'win32') {
      if (firstRoundPids.includes(pid)) {
        try {
          // /T 树杀：root 还活着时这一步就能收掉大部分子孙
          await exec(systemTool('taskkill.exe'), ['/F', '/T', '/PID', String(pid)], {
            timeout: clampTimeout(5000, deps)
          })
        } catch {
          // taskkill 对已退出的进程返回非 0（"没有找到进程"）—— 结果已达成，下面统一以存活与否判定
        }
      }
    } else {
      // POSIX 下 shell:false，child.pid 就是 dsh shim exec 出来的 node 自己；先清子孙再清根。
      // SIGTERM 起步，给个收尾窗口再 SIGKILL —— 立刻 isPidAlive 通常仍 true，那不是「杀不掉」。
      // 信号本身是同步调用、不花时间，收窄预算只收窄收尾窗口（进程刚死时的 reap 延迟）。
      const grace = Math.min(POSIX_KILL_GRACE_MS, remainingMs(deps))
      for (const p of firstRoundPids) {
        if (p === pid) continue
        try {
          signal(p, 'SIGTERM')
        } catch {
          // 已不在
        }
      }
      if (firstRoundPids.includes(pid)) {
        try {
          signal(pid, 'SIGTERM')
        } catch {
          // 已不在
        }
      }
      await sleep(grace)
      for (const p of firstRoundPids) {
        if (!alive(p)) continue
        try {
          signal(p, 'SIGKILL')
        } catch {
          // 已不在
        }
      }
      await sleep(grace)
    }

    const survivors = allPids.filter((p) => alive(p))
    if (survivors.length === 0) {
      if (!enumerated) {
        return {
          status: 'unverified',
          message: budgetTooTight
            ? `kill budget too tight to enumerate; root ${pid} is gone but the tree is unconfirmed`
            : `process table unavailable; root ${pid} is gone but the tree is unconfirmed`,
          targets
        }
      }
      return { status: 'killed', targets }
    }

    // --- 第二轮：补刀 ---
    if (process.platform !== 'win32') {
      // POSIX 上面已 SIGKILL 过一轮，还活着的是真杀不掉（或 PID 复用）—— 别再盲补
      return { status: 'survivors', pids: survivors, targets }
    }

    if (remainingMs(deps) <= 0) {
      // 预算见底：主力树杀已经发过了，不再开新的枚举/补刀轮次 —— 交回 targets 让调用方留档，
      // 下次启动走 recoverRecordedPids 再试；若 WMI 仍不可用，保留记录等待恢复。
      return {
        status: 'unverified',
        message: `kill budget exhausted; left ${survivors.join(',')} for next-launch recovery`,
        targets
      }
    }

    const fresh = await listProcs()
    if (fresh === null) {
      // 核对用的快照都拿不到，就没有「确认是同一个进程」的依据 —— 不盲杀
      return {
        status: 'unverified',
        message: `cannot verify pid identity before mop-up; left ${survivors.join(',')} alone`,
        targets
      }
    }
    const freshById = new Map(fresh.map((p) => [p.pid, p]))
    const verified: number[] = []
    for (const p of survivors) {
      const before = byPid.get(p)
      const now = freshById.get(p)
      if (!now) continue  // 名单落定后已退出 —— 结果已达成
      if (!before) continue  // 旧快照里没身份，无法核对 → 不盲杀
      if (!sameIdentity(before, now)) {
        log.warn(`skip mop-up pid ${p}: identity changed (${before.name} → ${now.name}), likely pid reuse`)
        continue
      }
      verified.push(p)
    }

    if (remainingMs(deps) <= 0) {
      // 核对枚举把最后的预算也吃掉了 —— 别再发并发补刀：每一次超时都有 1.5s 下限，
      // 再起一轮就可能超出调用方的等待余量（退出路径的余量是按「最多多花一步」定的）。
      return {
        status: 'unverified',
        message: `kill budget exhausted before mop-up; left ${verified.join(',')} for next-launch recovery`,
        targets
      }
    }

    // 并发补刀：串行的话每个 5s 上限，积几个孤儿就够把 will-quit 卡住
    await Promise.all(
      verified.map(async (p) => {
        try {
          await exec(systemTool('taskkill.exe'), ['/F', '/PID', String(p)], {
            timeout: clampTimeout(5000, deps)
          })
        } catch {
          // 同上
        }
      })
    )

    const left = allPids.filter((p) => alive(p))
    if (left.length === 0) return { status: 'killed', targets }
    return { status: 'survivors', pids: left, targets }
  } catch (error) {
    // 兜底：任何意外都降级成 unverified，绝不 reject
    return {
      status: 'unverified',
      message: `killPidTree failed: ${(error as Error).message}`,
      targets: [{ pid, name: '', cmdline: null }]
    }
  }
}

/**
 * 清扫孤儿 `dsh web` 进程（崩溃/强杀遗留，root pid 已随 Electron 一起没了）。
 * 返回实际杀掉的 pid 列表。best-effort：枚举或单个 kill 失败只告警，绝不抛 ——
 * 启动路径与 open() 都在调，抛出去等于启动失败 / 开不了 Web。
 *
 * 孤儿名单来自首次快照；每个候选动手前再核对一次命令行、父链和启动时间，
 * 避免旧快照里的 PID 已被同名的正常进程复用时误杀。
 * 枚举失败返回 [] 并告警 —— 此时「没找到孤儿」≠「没有孤儿」，由 recoverRecordedPids 兜底。
 */
export async function sweepOrphanDshWeb(deps?: ProcDeps): Promise<number[]> {
  const listProcs = deps?.listProcesses ?? (() => listProcesses(deps))
  const getStartTime =
    deps?.lookupStartTime ?? ((pid: number): Promise<number | null> => lookupProcessStartTime(pid, deps))
  try {
    const procs = await listProcs()
    if (procs === null) {
      log.warn('orphan dsh web sweep skipped: process table unavailable (see recoverRecordedPids fallback)')
      return []
    }
    const pids = findOrphanDshWebPids(procs)
    const killed: number[] = []
    for (const pid of pids) {
      const before = procs.find((p) => p.pid === pid)
      const startedAt = await getStartTime(pid)
      const fresh = await listProcs()
      const current = fresh?.find((p) => p.pid === pid)
      if (!before || !fresh || !current || startedAt === null ||
          !sameIdentity(before, current) || before.ppid !== current.ppid ||
          !isLyShellDshWebCmdline(current.cmdline) ||
          isAnchoredProcess(current, new Map(fresh.map((p) => [p.pid, p])))) {
        log.warn(`orphan dsh web pid ${pid} changed or could not be verified; skipped`)
        continue
      }
      const currentStartedAt = await getStartTime(pid)
      if (currentStartedAt === null || currentStartedAt !== startedAt) {
        log.warn(`orphan dsh web pid ${pid} start time changed; skipped`)
        continue
      }
      const result = await killPidTree(pid, fresh, { ...deps, expectedRootStartTime: startedAt })
      if (result.status === 'killed') {
        killed.push(pid)
      } else if (result.status === 'survivors') {
        log.warn(`orphan dsh web pid ${pid} survived tree kill:`, result.pids.join(', '))
      } else {
        log.warn(`orphan dsh web pid ${pid} tree kill unverified:`, result.message)
      }
    }
    if (killed.length > 0) log.info('swept orphan dsh web processes:', killed.join(', '))
    return killed
  } catch (error) {
    log.warn('orphan dsh web sweep failed:', (error as Error).message)
    return []
  }
}

/** 读 pid 留档。文件不存在 / 坏了都当空档（留档是增强手段，坏了就当没有）。绝不抛。 */
export async function readPidRecord(path: string): Promise<RecordedPid[]> {
  try {
    const text = await fsp.readFile(path, 'utf8')
    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed)) return []
    const out: RecordedPid[] = []
    for (const row of parsed) {
      if (typeof row !== 'object' || row === null) continue
      const r = row as Record<string, unknown>
      const pid = Number(r.pid)
      if (!Number.isInteger(pid) || pid <= 0) continue
      out.push({
        pid,
        name: typeof r.name === 'string' ? r.name : '',
        cmdline: typeof r.cmdline === 'string' ? r.cmdline : null,
        recordedAt: typeof r.recordedAt === 'number' ? r.recordedAt : 0,
        // 旧格式（没有 kind）原样读进来：回收侧与 root 同口径（签名 + 孤儿双确认才动手），
        // 不做基于猜测的迁移
        ...(r.kind === 'root' ? { kind: 'root' as const } : {})
      })
    }
    return out
  } catch {
    return []
  }
}

/**
 * 写 pid 留档（整体覆盖）。原子写：先写同目录 .tmp 再 rename —— 留档是崩溃恢复的唯一
 * 线索，直接 writeFile 中途崩溃会留下截断 JSON，下次启动按空档处理，遗留孤儿就再也
 * 收不回来了。rename 在同一卷上原子（Windows 走 MoveFileEx REPLACE_EXISTING），崩溃时
 * 盘上要么旧档要么新档，没有中间态；rename 失败清掉 .tmp 再抛。对齐 repository.ts 的
 * atomicWriteFileSync（这里本来就是 async 链，用 fsp 版本）。
 */
export async function writePidRecord(path: string, entries: readonly RecordedPid[]): Promise<void> {
  const tmpPath = `${path}.tmp`
  await fsp.writeFile(tmpPath, JSON.stringify(entries), 'utf8')
  try {
    await fsp.rename(tmpPath, path)
  } catch (error) {
    await fsp.rm(tmpPath, { force: true })
    throw error
  }
}

/** recoverRecordedPids 的结果：谁被杀了、谁该从留档里清掉。 */
export interface RecoverResult {
  /**
   * 确认是本 app 的 dsh web，且已确认消失的 pid —— **root 只有在子孙也确认清干净后**
   * 才会出现在这里（见 recoverRecordedPids 的「杀了 root ≠ 可以清档」）。调用方拿它清档。
   */
  killed: number[]
  /**
   * 应从留档里清掉的 pid —— 两类：
   *   - 进程已经不在了，且它的子孙也确认清干净了（记录已完成使命）；
   *   - 身份核对证明它**已经不是**我们当初记录的那个进程（启动时刻晚于记录 = PID 复用，
    *     或能读到名字/命令行且明显对不上）—— 同样要先查旧 root 的存活孤儿，
    *     确认清干净了才清（复用只说明 root 换人了，子孙可能还活着）。
   * 留着这类记录是实打实的误杀面：PID 再次复用成同名进程时，名核对会「通过」。
   * 注意：**没清掉子孙**的记录既不在 killed 也不在 dropped 里 —— 它是下次启动唯一的线索。
   */
  dropped: number[]
}

/**
 * 「当初记录的那个进程已经没了」之后的统一收尾 —— 三种形态同走此路：root 已死（我们杀的、
 * 或核对期间发现它已经没了）、或 pid 已被别的进程复用（身份核对确证换人了）。
 * 按 ppid 找回存活子孙并收掉，**确认清干净了**才把 root 的留档交出去清掉。
 *
 * `rootOutcome` 决定 root 落进哪个列表：'killed' = 我们亲手杀掉的（调用方日志与语义上
 * 都算「回收成功」），'dropped' = 本来就已经没了（或确认已被复用）、只是把这条过期记录清掉。
  * 注意：root 已被复用时它本体是**别人的活进程**，当前 ppid 指向它的进程也可能是
  * 它新托管的子孙；只有签名命中且父链已断的孤儿才能收，绝不碰活树。
 */
async function disposeDeadRoot(
  entry: RecordedPid,
  rootOutcome: 'killed' | 'dropped',
  ctx: {
    snapshot: () => Promise<ProcInfo[] | null>
    alive: (pid: number) => boolean
    isProtected: (pid: number) => boolean
    lookupStartTime: (pid: number) => Promise<number | null>
    exec: (file: string, args: string[], opts: { timeout: number; maxBuffer?: number }) => Promise<string>
    signal: (pid: number, sig: NodeJS.Signals) => void
    deps?: ProcDeps
    killed: number[]
    dropped: number[]
  }
): Promise<void> {
  const descendants = await recoverRecordedDescendants(entry.pid, ctx)
  ctx.killed.push(...descendants.killed)
  if (descendants.complete) {
    ctx[rootOutcome].push(entry.pid)
  } else {
    // 子孙没清完（或进程表读不出、根本没法清）：root 记录是下次启动找回它们的唯一线索，
    // 不能清。清掉等于把下次唯一的机会也扔掉 —— taskkill /T 漏掉的 node 子孙正是靠
    // 「ppid 指向这个已死 root」才找得回来。
    log.warn(`recorded pid ${entry.pid} is gone but its descendants were not swept — kept for next launch`)
  }
}

/**
 * 回收留档里仍存活的 pid —— 崩溃/强杀遗留的第三层防护。
 * 镜像名与启动时刻查询不依赖 WMI；Windows 上执行树杀仍须读取命令行和父链，
 * 进程表不可用时保留记录，不凭同名或时间接近的进程直接动手。
 *
 * 判据按证据强度排序，最后一道是**动手的门槛**：
 *   1. **启动时刻**：启动晚于 recordedAt 超出容差 → 号已被别人拿走：先按 ppid 收一遍
 *      旧 root 的存活子孙，清干净才丢弃。落在容差内只能说明「可能是原进程」—— 即使
 *      只晚几毫秒，也可能是原进程很快退出后 PID 被复用，不能单独授权杀进程。
 *   2. **镜像名（弱证据）**：对不上 → 先按 ppid 收一遍旧 root 的存活子孙，清干净才丢弃；
 *      查不到又还活着则保留（查询失败 ≠ 进程不存在）。
 *   3. **命令行签名（硬证据）**：读得到就要求命中 LyShell 的 dsh web spawn 签名
 *      （POSIX 走 `ps -o args=`，Windows 走进程表快照 = CIM/WMI）。对不上 → 同上收完子孙再丢。
 *   4. **动手门槛**：「命令行签名命中 + 孤儿确认」双条件一起顶上 —— 旧格式记录
 *      （无 kind 归属标记）也一样，
 *      否则升级前的旧档在 WMI/启动时刻不可用时就永远无法回收。两条硬证据都没有 →
 *      **保留不动手**：单凭镜像名杀一个同名复用进程是实打实的误杀，宁可留给下次
 *      （或交给 sweepOrphanDshWeb）。
 *
 * 记录的 pid 已经不在了**不等于**这条记录没用：`killPidTree` 枚举失败时只能记下 root，
 * 而「root（cmd.exe 包裹层）已死、真正长驻的 node 孙进程还活着」正是本兜底要覆盖的形态 ——
 * Windows 上子进程的 ppid 仍指着这个已死的 root，于是这条死记录是找回子孙的唯一线索。
 * 因此死者会先按 ppid 找回其**签名命中**的存活子孙并收掉；只有确实清干净了才清档，
 * 清不干净（进程表读不出 / 杀不动）就**保留**这条记录给下次启动。
 * 同一原则也适用于**我们亲手杀掉 root** 的路径：`taskkill /T` 先杀 root 就会断树、漏掉
 * node 子孙，POSIX 的 killOnePid 也只 signal root 一个 —— 杀掉 root ≠ 整棵树没了，
 * 子孙确认清干净之前不许清档（否则下次启动连 ppid 线索都没了）。
 *
 * `deps.isProtectedPid` 是本会话自己 spawn / 正在处理的 pid：一律不碰（恢复与新的 open()
 * 并发，旧 pid 被新进程复用且同名时，不设这道门就会误杀刚起来的 dsh）。
 * 绝不抛。
 */
export async function recoverRecordedPids(
  entries: readonly RecordedPid[],
  deps?: ProcDeps
): Promise<RecoverResult> {
  const alive = deps?.isPidAlive ?? isPidAlive
  const exec = deps?.execFile ?? execFileAsync
  const signal = deps?.signalPid ?? defaultSignalPid
  const getCmdline = deps?.lookupCmdline ?? ((pid: number): Promise<string | null> => lookupCmdline(pid, deps))
  const getStartTime =
    deps?.lookupStartTime ?? ((pid: number): Promise<number | null> => lookupProcessStartTime(pid, deps))
  const isProtected = deps?.isProtectedPid ?? ((): boolean => false)
  // 每次取新快照。留档可能有多个 root，回收前一条时杀进程耗费数秒；复用旧快照会让
  // 后一条按过期的 cmdline/ppid 对一个已复用的裸 pid 动手。
  const snapshot = deps?.listProcesses ?? (() => listProcesses(deps))
  const killed: number[] = []
  const dropped: number[] = []
  const disposeCtx = { snapshot, alive, isProtected, lookupStartTime: getStartTime, exec, signal, deps, killed, dropped }
  for (const entry of entries) {
    try {
      if (isProtected(entry.pid)) continue  // 本会话的进程：不是遗留物
      if (!alive(entry.pid)) {
        // 记录已死 —— 但它的子孙可能还活着（见函数头注释）
        await disposeDeadRoot(entry, 'dropped', disposeCtx)
        continue
      }

      // 1) 启动时刻：判「这个号是不是已经被别人拿走了」
      //    recordedAt 是判据的基准，缺失/非法（<=0）时等于没有基准 —— 只能按「无时间证据」处理，
      //    不能拿 0 去比（那会把每一条都判成复用，白白丢掉线索）。
      const hasRecordTime = entry.recordedAt > 0
      const startedAt = await getStartTime(entry.pid)
      if (hasRecordTime && startedAt !== null && startedAt > entry.recordedAt + PID_REUSE_TOLERANCE_MS) {
        log.warn(
          `recorded pid ${entry.pid} belongs to a process started at ${new Date(startedAt).toISOString()}, ` +
            `after the record (${new Date(entry.recordedAt).toISOString()}) — dropping (pid reuse)`
        )
        // 复用确证 ≠ 可以直接清档：当初记录的那个 root 死了，它的存活子孙可能还挂在
        // 这个 pid 名下（Windows 上 ppid 仍指向已死的 root）—— 与「死者收尾」同一约束，
        // 子孙确认清干净了才把这条线索交出去。
        await disposeDeadRoot(entry, 'dropped', disposeCtx)
        continue
      }
      // 2) 镜像名：弱证据，用来快速排除「明显不是它」的情况
      if (entry.name) {
        const name = await lookupImageName(entry.pid, deps)
        if (name === null) {
          // 查询失败 ≠ 进程不存在：tasklist/ps 超时或不可用时也会返回 null。
          // 只要它还活着，就不能按「PID 复用」把它清掉 —— 那会白白丢掉一条有效的兜底记录。
          if (alive(entry.pid)) {
            log.warn(`recorded pid ${entry.pid}: image name lookup failed while it is alive — kept`)
            continue
          }
          // 查询期间 root 已经死了 —— 与「进来就发现已死」同一条路：子孙可能还活着
          // （taskkill /T 漏掉的 node、POSIX 只杀 root 的路径），不能直接清档。
          await disposeDeadRoot(entry, 'dropped', disposeCtx)
          continue
        }
        if (name.toLowerCase() !== entry.name.toLowerCase()) {
          log.warn(`recorded pid ${entry.pid} is now ${name}, expected ${entry.name} — dropping (pid reuse)`)
          // 同上：旧 root 的存活子孙先收一遍，确认清干净了才清档
          await disposeDeadRoot(entry, 'dropped', disposeCtx)
          continue
        }
      }

      // 3) 命令行签名：读得到就当作硬证据。旧格式记录（没有 kind，可能是当年从进程表
      //    推导出来的子孙 pid）与 root 同口径 —— 无归属标记不再是「永不回收」的理由，
      //    否则升级前的旧档在启动时刻也查不到时就永远无法清掉，孤儿会一直占着会话锁。
      // 签名只能证明「它是个 dsh web」，不能证明「它就是当初那条记录」——本会话刚 spawn 的
      // 子孙同样命中签名。所以这里再要求它是**无人托管的遗留物**：挂在任何活进程树上的
      // （父链未断、没被 init 收养）都不动，与 sweepOrphanDshWeb 同一口径。
      const procs = await snapshot()
      const snapshotAt = (deps?.now ?? Date.now)()
      const info = procs?.find((p) => p.pid === entry.pid)
      const liveCmdline = (await getCmdline(entry.pid)) ?? info?.cmdline ?? null
      if (liveCmdline === null) {
        // 启动时刻与命令行都拿不到：单凭镜像名不足以动手
        log.warn(`recorded pid ${entry.pid} has no cmdline evidence — kept`)
        continue
      }
      if (!isLyShellDshWebCmdline(liveCmdline)) {
        log.warn(`recorded pid ${entry.pid} is not a dsh web (cmdline mismatch) — dropping (pid reuse)`)
        // 同上：旧 root 的存活子孙先收一遍，确认清干净了才清档
        await disposeDeadRoot(entry, 'dropped', disposeCtx)
        continue
      }
      if (procs === null || info === undefined) {
        log.warn(`recorded pid ${entry.pid}: cannot confirm it is an orphan — kept`)
        continue
      }
      if (isAnchoredProcess(info, new Map(procs.map((p) => [p.pid, p])))) {
        log.warn(`recorded pid ${entry.pid} is still attached to a live process tree — kept`)
        continue
      }

      // 4) 快照/命令行查询期间 PID 可能换人。动手前再取一份进程表，核对身份与父链。
      const fresh = await snapshot()
      const current = fresh?.find((p) => p.pid === entry.pid)
      if (!fresh || !current || !sameIdentity(info, current) || info.ppid !== current.ppid ||
          !isLyShellDshWebCmdline(current.cmdline) ||
          isAnchoredProcess(current, new Map(fresh.map((p) => [p.pid, p])))) {
        log.warn(`recorded pid ${entry.pid} changed during verification — kept`)
        continue
      }
      const currentStartedAt = await getStartTime(entry.pid)
      if (currentStartedAt !== null && (currentStartedAt > snapshotAt ||
          (startedAt !== null && startedAt !== currentStartedAt))) {
        log.warn(`recorded pid ${entry.pid} start time changed during verification — kept`)
        continue
      }
      // 本会话可能刚 spawn 出一个复用该 pid 的进程 —— 动手前最后再问一次
      if (isProtected(entry.pid)) {
        log.warn(`recorded pid ${entry.pid} became owned by this session during verification — skipped`)
        continue
      }
      await killOnePid(entry.pid, exec, signal, deps)
      if (alive(entry.pid)) {
        // 没杀掉 —— 记录留着下次再试（既不进 killed 也不进 dropped）
        log.warn(`recorded pid ${entry.pid} survived kill attempt — kept for next launch`)
        continue
      }
      // root 已确认死，但**不等于**整棵树没了：taskkill /T 先杀 root 就断树、漏掉 node 子孙，
      // POSIX 的 killOnePid 也只 signal root。子孙清干净之前不许清档 —— 见 disposeDeadRoot。
      await disposeDeadRoot(entry, 'killed', disposeCtx)
    } catch (error) {
      log.warn(`failed to recover recorded pid ${entry.pid}:`, (error as Error).message)
    }
  }
  return { killed, dropped }
}

/** 杀单个 pid（Windows 连子树）。绝不抛。 */
async function killOnePid(
  pid: number,
  exec: (file: string, args: string[], opts: { timeout: number; maxBuffer?: number }) => Promise<string>,
  signal: (pid: number, sig: NodeJS.Signals) => void,
  deps?: ProcDeps
): Promise<void> {
  if (process.platform === 'win32') {
    try {
      await exec(systemTool('taskkill.exe'), ['/F', '/T', '/PID', String(pid)], {
        timeout: clampTimeout(5000, deps)
      })
    } catch {
      // 已退出也算达成
    }
    return
  }
  try {
    signal(pid, 'SIGKILL')
  } catch {
    // 已不在
  }
}

/**
 * 记录里的 root 已死时，按 ppid 找回它仍存活的子孙并收掉 —— 枚举不可用时的唯一补救。
 *
 * 身份判据是**命令行签名 + 孤儿确认**：单凭「ppid 指向这个 pid」只是线索（PID 复用后
 * 可能指向别的活进程），签名也可能与新托管的 dsh web 相同。
 *
 * `complete` 表示「子孙确实清干净了」：只有它为 true，调用方才可以清掉 root 记录。
 * 进程表读不出（WMI 不可用）、有关键子孙没杀掉、**或存活子孙的身份无法确认**（命令行
 * 读不到）时为 false —— 那时 root 记录是下次启动唯一的线索，必须留着。
 */
async function recoverRecordedDescendants(
  rootPid: number,
  ctx: {
    snapshot: () => Promise<ProcInfo[] | null>
    alive: (pid: number) => boolean
    isProtected: (pid: number) => boolean
    lookupStartTime: (pid: number) => Promise<number | null>
    exec: (file: string, args: string[], opts: { timeout: number; maxBuffer?: number }) => Promise<string>
    signal: (pid: number, sig: NodeJS.Signals) => void
    deps?: ProcDeps
  }
): Promise<{ killed: number[]; complete: boolean }> {
  try {
    const procs = await ctx.snapshot()
    const snapshotAt = (ctx.deps?.now ?? Date.now)()
    if (procs === null) return { killed: [], complete: false }
    const byPid = new Map(procs.map((p) => [p.pid, p]))
    const out: number[] = []
    let complete = true
    for (const pid of collectDescendantPids(procs, rootPid)) {
      if (!ctx.alive(pid) || ctx.isProtected(pid)) continue
      const info = byPid.get(pid)
      if (info !== undefined && info.cmdline === null) {
        // 命令行读不到（受保护进程 / 读取失败）：既不能确认它是 DSH，也不能排除 ——
        // 按「没清干净」保守处理，root 记录留给下次启动。若直接跳过还标 complete，
        // 万一它真是漏掉的 dsh web，root 这条唯一的恢复线索就被清掉了。
        complete = false
        continue
      }
      if (!isLyShellDshWebCmdline(info?.cmdline)) continue
      // root PID 可能已被别的活进程复用。此时 ppid 指向 rootPid 的 dsh web 也可能是
      // 复用者新启动、仍由它托管的进程；签名只能证明用途，不能证明属于旧 root。
      // 只回收父链确已断开的孤儿，无法确认的留档保留供后续重试。
      if (info && isAnchoredProcess(info, byPid)) {
        complete = false
        continue
      }
      // snapshot 可能来自上一条留档的处理，甚至在这条回收期间就已过期。
      // 每个子孙动手前重读进程表、启动时刻和父链；无法确认仍是同一个孤儿就保留 root 留档。
      const startedAt = await ctx.lookupStartTime(pid)
      const fresh = await ctx.snapshot()
      const current = fresh?.find((p) => p.pid === pid)
      if (!fresh || !current || !info || !sameIdentity(info, current) ||
          info.ppid !== current.ppid || !isLyShellDshWebCmdline(current.cmdline) ||
          isAnchoredProcess(current, new Map(fresh.map((p) => [p.pid, p])))) {
        complete = false
        continue
      }
      const currentStartedAt = await ctx.lookupStartTime(pid)
      if (currentStartedAt !== null && (currentStartedAt > snapshotAt ||
          (startedAt !== null && startedAt !== currentStartedAt))) {
        complete = false
        continue
      }
      if (!ctx.alive(pid) || ctx.isProtected(pid)) continue
      await killOnePid(pid, ctx.exec, ctx.signal, ctx.deps)
      if (ctx.alive(pid)) complete = false  // 没杀掉 → root 记录留着，下次接着收
      else out.push(pid)
    }
    if (out.length > 0) {
      log.info(`recovered surviving dsh web descendants of recorded pid ${rootPid}:`, out.join(', '))
    }
    return { killed: out, complete }
  } catch (error) {
    log.warn(`failed to recover descendants of recorded pid ${rootPid}:`, (error as Error).message)
    return { killed: [], complete: false }
  }
}
