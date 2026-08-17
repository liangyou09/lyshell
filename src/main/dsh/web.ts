import { spawn, type ChildProcess } from 'child_process'
import log from 'electron-log'

/**
 * DeepSeek Harness Web UI 进程管理 —— spawn `dsh web --port 0`，解析 stdout 回显的真实端口，
 * 拿到 URL 后交给渲染层 <webview> 加载。关闭时 tree-kill 子进程，回收内存。
 *
 * 关键事实（源码 + 实测双确认，见 memory/dsh-web-port-process-behavior.md）：
 *   - `dsh web` = `dsh --profile web`，无独立二进制；
 *   - `--port 0` → OS 随机分配；stdout 单行 `dsh web: http://127.0.0.1:PORT` 即 ready 信号；
 *   - 冷启动 ~18s（加载 ~200 插件），故 ready 超时给足 60s；单前台 node 进程，不自动开浏览器。
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
      let stdoutBuf = ''
      let stderrBuf = ''

      const finish = (result: DshWebLaunchResult): void => {
        if (settled || generation !== this.generation) return
        settled = true
        clearTimeout(timer)
        this.url = result.ok ? result.url : null
        resolve(result)
      }

      const child = spawn('dsh', ['web', '--port', '0'], {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
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
        log.info(`dsh web ready: ${url}`)
        finish({ ok: true, url })
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
