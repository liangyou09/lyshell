import { spawn } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'
import { session } from 'electron'
import { DSH_WEB_PARTITION } from '@shared/constants'
import { DSH_MARKET_PACKAGE, type DshMarketAction, type DshMarketResult } from '@shared/dsh-market'
import { HARNESS_AGENTS } from '../harness/config'
import { buildChildEnv, createDshWebLaunchResolver, type ResolvedDshWebLaunch } from './launch-resolve'
import { resolveDshHome } from './env'
import { comSpecFromEnv, dshWebManager } from './web'
import { commandExists } from '../harness/detect'
import { buildLaunchLine, quoteWindowsCmdArg } from './bridge'
import { marketToolsDirectory, withMarketToolPath } from './market-tools'
import { attachDshProcessJob, type DshProcessJob } from './windows-job'

const HOLDER = 'sidebar:dsh-market'

export function marketViewUrl(raw: string): string {
  const url = new URL(raw)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.port || url.username || url.password) {
    throw new Error('Invalid DSH market origin')
  }
  // 不传播启动 token、路径或原工作台的会话导航。
  return `${url.origin}/?lyshellView=market`
}

export function hasMarketDependency(dshHome: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(dshHome, 'profiles', 'web', 'package.json'), 'utf8'))
    return typeof manifest.dependencies?.dshmarket === 'string'
  } catch { return false }
}

/** 固定 CLI 与参数；环境沿用 Web 启动解析，不接收任何渲染层 shell 内容。 */
export function runMarketTool(tool: 'npm' | 'pnpm' | 'dsh', toolArgs: string[], launch: ResolvedDshWebLaunch, env: Record<string, string | undefined>): Promise<void> {
  const windows = process.platform === 'win32'
  const command = windows ? (comSpecFromEnv(env) || 'cmd.exe') : tool
  const args = windows
    ? ['/d', '/s', '/c', `set /p LYSHELL_MARKET_GATE= && ${buildLaunchLine(tool, toolArgs, quoteWindowsCmdArg)}`]
    : toolArgs
  return new Promise((resolve, reject) => {
    const spawnedAt = Date.now()
    const child = spawn(command, args, {
      cwd: launch.cwd, env, detached: !windows, windowsHide: true,
      windowsVerbatimArguments: windows, stdio: ['pipe', 'pipe', 'pipe']
    })
    let job: DshProcessJob | null = null
    let failure: string | null = null
    let output = ''
    let outputBytes = 0
    let settled = false
    const stopTree = (): void => {
      if (job) { job.terminate(); job.close() }
      else if (!windows && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL') } catch { /* 进程组已退出 */ }
      } else child.kill()
    }
    const timer = setTimeout(() => { failure = 'timeout'; stopTree() }, 300_000)
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // 包管理器由 shell 派生：超时/输出超限必须回收整棵树，不能只杀 cmd 后释放安装锁。
      stopTree()
      // 仅提取固定形态的错误码，绝不回传环境、完整 CLI 输出或 error.cmd。
      const diagnostic = output.match(/ERR_PNPM_[A-Z_]+|\b(?:ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EACCES|EPERM)\b/)?.[0]
      if (failure || code !== 0) reject(new Error(`${tool} 执行失败 (${diagnostic || failure || `exit ${code ?? 'unknown'}`})。请检查 Node.js、npm 和网络后重试。 / Failed to run ${tool}. Check Node.js, npm and the network.`))
      else resolve()
    }
    const collect = (chunk: Buffer): void => {
      outputBytes += chunk.length
      if (outputBytes <= 2 * 1024 * 1024) output += chunk.toString()
      else { failure = 'output limit'; stopTree() }
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.once('error', () => { failure = 'spawn error'; finish(null) })
    child.once('close', finish)
    child.stdin?.on('error', () => { failure = 'stdin error'; stopTree() })
    if (windows && child.pid) {
      try { job = attachDshProcessJob(child.pid, spawnedAt) } catch { /* 无安全回收能力时不放行命令 */ }
      if (!job) { failure = 'process containment unavailable'; child.kill(); return }
      child.stdin?.end('start\n')
    } else child.stdin?.end()
  })
}

export async function installMarket(launch: ResolvedDshWebLaunch): Promise<void> {
  let env = buildChildEnv(launch.launchEnv, resolveDshHome)
  const path = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || ''
  if (!commandExists('pnpm', path)) {
    const directory = marketToolsDirectory()
    await runMarketTool('npm', ['install', '--prefix', directory, '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', 'pnpm@10.28.2'], launch, env)
    // 安装目录包含空格时同样走参数引用；不依赖 Codex 终端额外注入的 PATH。
    env = withMarketToolPath(env as Record<string, string>, join(directory, 'node_modules', '.bin'))
  }
  await runMarketTool('pnpm', ['--version'], launch, env)
  await runMarketTool('dsh', ['plugin', '--profile', 'web', 'add', DSH_MARKET_PACKAGE], launch, env)
}

export interface MarketDependencies {
  running: () => boolean
  installed: () => Promise<boolean>
  open: () => Promise<string>
  install: () => Promise<void>
  release: () => void
}

/** 开启/安装串行互斥；release 等在途 open 落定，避免卸载后补出泄漏租约。 */
export function createMarketService(deps: MarketDependencies) {
  let pending: Promise<DshMarketResult> | null = null
  return async (action: DshMarketAction): Promise<DshMarketResult> => {
    if (action === 'release') {
      await pending
      deps.release()
      return { success: true }
    }
    if (pending) return { success: false, error: 'DSH Market is busy. Please wait.' }
    const operation = async (): Promise<DshMarketResult> => {
      try {
        if (action === 'install') {
          // 不在运行中的 profile 下变更组合，也绝不重启共享后台。
          if (deps.running()) return { success: true, restartRequired: true }
          // 后台意外退出后，侧栏可能还持有旧代连接；不让自己的旧 holder 挡住重装。
          deps.release()
          await deps.install()
        }
        if (!deps.running() && !await deps.installed()) return { success: true, needsInstall: true }
        return { success: true, url: marketViewUrl(await deps.open()) }
      } catch (error) {
        deps.release()
        return { success: false, error: error instanceof Error ? error.message : 'DSH Market unavailable' }
      }
    }
    pending = operation()
    try { return await pending } finally { pending = null }
  }
}

const resolver = createDshWebLaunchResolver(HARNESS_AGENTS.dsh)
async function resolveLaunch(): Promise<ResolvedDshWebLaunch> {
  const result = await resolver.resolve({})
  if (!result.ok) throw new Error(result.error)
  return result.launch
}

export const requestDshMarket = createMarketService({
  running: () => dshWebManager.running,
  installed: async () => hasMarketDependency((await resolveLaunch()).dshHome),
  install: async () => {
    const installationHolder = 'sidebar:dsh-market:install'
    if (!dshWebManager.beginProfileMutation(installationHolder)) throw new Error('DSH 后台正在使用中，请结束任务并关闭工作台后安装市场。')
    try { await installMarket(await resolveLaunch()) }
    finally { dshWebManager.endProfileMutation(installationHolder) }
  },
  open: async () => {
    const result = await dshWebManager.acquire(target => resolver.resolve(target), { bindingId: HOLDER })
    if (!result.ok) throw new Error(result.error)
    dshWebManager.retainBackend(HOLDER)
    try {
      const response = await session.fromPartition(DSH_WEB_PARTITION).fetch(`${new URL(result.url).origin}/dsh-market/status`, {
        signal: AbortSignal.timeout(10_000), redirect: 'error'
      })
      await response.body?.cancel().catch(() => {})
      if (!response.ok) throw new Error('当前 DSH 后台尚未加载插件市场。可安装市场后重新连接；共享后台正在使用时请先结束任务并关闭工作台。')
      return result.url
    } catch (error) {
      // 首次连接若只是启动了一个缺市场的后台，回收自己的空实例，允许直接重装。
      // 已有后台以及后来取得租约的任务一律保留。
      dshWebManager.unretainBackend(HOLDER)
      dshWebManager.release(HOLDER)
      if (!result.reused && !dshWebManager.isManaged && dshWebManager.leaseCount === 0) await dshWebManager.close()
      throw error
    }
  },
  release: () => {
    dshWebManager.unretainBackend(HOLDER)
    dshWebManager.release(HOLDER)
  }
})
