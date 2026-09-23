import { spawn, type ChildProcess } from 'child_process'
import { session } from 'electron'
import http from 'http'
import https from 'https'
import log from 'electron-log'
import { DSH_WEB_PARTITION } from '@shared/constants'
import { readSystemPath } from '../env/refresh'
import { resolveDshHome } from './env'

/**
 * DeepSeek Harness Web UI 进程管理 —— spawn `dsh web --port 0`，解析 stdout 回显的真实端口，
 * 拿到 URL 后交给渲染层 <webview> 加载。关闭时 tree-kill 子进程，回收内存。
 *
 * 关键事实（源码 + 实测双确认，见 memory/dsh-web-port-process-behavior.md）：
 *   - `dsh web` = `dsh --profile web`，无独立二进制；
 *   - `--port 0` → OS 随机分配；stdout 单行 `dsh web: http://127.0.0.1:PORT` 即 ready 信号；
 *   - 冷启动 ~18s（加载 ~200 插件），故 ready 超时给足 60s；单前台 node 进程。
 *   - `dsh web` 默认会在启动后调起系统默认浏览器（web-app 的 openBrowser 默认 true），
 *     但 LyShell 把 UI 嵌在自家 <webview> 里，无需系统浏览器，故 spawn 时固定追加 `--no-open`。
 */

const READY_TIMEOUT_MS = 60_000
const READY_RE = /dsh web:\s+(https?:\/\/\S+)/i
// ready 行很短，60s 超时窗口内 stdout 缓冲封顶，防止静默期无限增长
const READY_MAX_BUF = 8192

export type DshWebLaunchResult =
  | { ok: true; url: string }
  | { ok: false; error: string }

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

class DshWebManager {
  private child: ChildProcess | null = null
  private url: string | null = null
  /** 代际计数器：每次 open() 自增；旧进程的异步回调据此判废，避免误清新进程指针。 */
  private generation = 0

  get running(): boolean {
    return this.child !== null
  }

  get currentUrl(): string | null {
    return this.url
  }

  /** 启动 `dsh web --port 0`，解析 stdout 拿 URL；已运行则先关闭旧的（同一时刻至多一个 web 实例）。 */
  open(opts: { cwd: string; env?: Record<string, string> }): Promise<DshWebLaunchResult> {
    // 先推进代际再关闭旧实例：旧进程退出时其 exit/error 回调因 generation 不匹配被忽略，
    // 不会把随后 spawn 的新进程 this.child 清成 null（快速切换工作区导致的孤儿进程根因）。
    const generation = ++this.generation
    this.close()

    return new Promise<DshWebLaunchResult>((resolve) => {
      let settled = false
      let readyHandled = false  // 命中 ready 行即刻锁门，不等 exchange 结束才防重入
      let stdoutBuf = ''
      let stderrBuf = ''

      const finish = (result: DshWebLaunchResult): void => {
        if (settled || generation !== this.generation) return
        settled = true
        clearTimeout(timer)
        this.url = result.ok ? result.url : null
        resolve(result)
      }

      // 即时读取系统 PATH（用户改环境变量后无需重启 app），再叠加工作区 env。
      const systemPath = readSystemPath()
      // 复制 process.env 再展开 DSH_HOME 的字面 ~（与 cwd 侧 defaultDshWebCwd 的 resolveDshHome 对齐），
      // 避免 cwd 已展开而子进程 DSH_HOME 仍是字面 ~ 导致两边目录错位；不直接改 process.env 引用。
      const baseEnv: Record<string, string | undefined> = { ...process.env }
      if (systemPath) baseEnv.PATH = systemPath
      if (baseEnv.DSH_HOME) baseEnv.DSH_HOME = resolveDshHome(baseEnv.DSH_HOME)

      const child = spawn('dsh', ['web', '--port', '0', '--no-open'], {
        cwd: opts.cwd,
        env: opts.env ? { ...baseEnv, ...opts.env } : baseEnv,
        // Windows：经 shell 解析 npm 的 dsh.cmd shim；POSIX 直接执行 dsh 软链
        shell: process.platform === 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      this.child = child

      const timer = setTimeout(() => {
        log.warn('dsh web ready timeout, killing child')
        this.close()
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
          this.close()
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
        this.exchangeTokenForCookie(raw).finally(() => {
          finish({ ok: true, url })
        })
      })
      // stderr 仅用于失败诊断（保留尾部），不参与 ready 判定
      child.stderr?.setEncoding('utf-8')
      child.stderr?.on('data', (chunk: string) => {
        stderrBuf = (stderrBuf + chunk).slice(-4000)
      })

      child.on('error', (err) => {
        if (generation !== this.generation) return
        log.error('dsh web spawn error:', err)
        this.child = null
        finish({ ok: false, error: `Failed to spawn dsh: ${err.message}` })
      })
      child.on('exit', (code, signal) => {
        if (generation !== this.generation) return
        this.child = null
        this.url = null
        if (!settled) {
          const detail = stderrBuf.trim() || (code != null ? `exit code ${code}` : `signal ${signal}`)
          finish({ ok: false, error: `dsh web exited before ready: ${detail}` })
        }
      })
    })
  }

  /** 用 dsh web 的 ready URL（含 ?token=…）做一次 HTTP 请求，把 303 下发的会话 cookie
   *  写进 persist:dshweb 的 partition cookie jar。这样 webview 加载干净 origin URL 时
   *  浏览器自动带 cookie，鉴权通过。失败静默放行（打一条 warn）：最多回到 401 白页。 */
  private exchangeTokenForCookie(rawUrl: string): Promise<void> {
    let parsed: URL
    try {
      parsed = new URL(rawUrl)
    } catch {
      return Promise.resolve()
    }
    const mod = parsed.protocol === 'https:' ? https : http

    return new Promise<void>((resolve) => {
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
            resolve()
            return
          }
          const entries = (Array.isArray(rawCookies) ? rawCookies : [rawCookies])
            .map(h => parseSetCookieEntry(h))
            .filter((e): e is ParsedCookie => e !== null)
          if (entries.length === 0) {
            resolve()
            return
          }
          const dshSession = session.fromPartition(DSH_WEB_PARTITION)
          const origin = parsed.origin
          const secure = parsed.protocol === 'https:'
          const nowSec = Math.floor(Date.now() / 1000)
          Promise.all(entries.map(e =>
            dshSession.cookies.set(toCookieDetails(e, origin, secure, nowSec))
              .catch(() => { /* 单条写入失败不阻塞其余 */ })
          )).then(
            () => resolve(),
            () => resolve()
          )
        }
      )
      req.on('error', (err) => {
        log.warn('dsh web cookie exchange request failed:', err.message)
        resolve()
      })
      req.on('timeout', () => {
        req.destroy()
        log.warn('dsh web cookie exchange timed out')
        resolve()
      })
      req.end()
    })
  }

  /** 关闭并清理子进程。Windows 用 taskkill /T 树杀（shell 包裹 cmd.exe，须连 node 子进程一起清）。 */
  close(): void {
    const child = this.child
    this.child = null
    this.url = null
    if (!child) return
    try {
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true })
      } else {
        child.kill('SIGTERM')
      }
    } catch (err) {
      log.warn('Failed to kill dsh web child:', err)
    }
  }
}

export const dshWebManager = new DshWebManager()
