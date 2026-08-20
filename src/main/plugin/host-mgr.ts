/**
 * Plugin Host Manager（主进程侧）
 *
 * 负责 contributor 插件的激活与生命周期，按 runtime 分流：
 *
 *   node  -- 单 host 子进程承载所有 node 插件（VS Code Extension Host 式）。
 *            start() 对每个 enabled node 插件 bindPluginToken，收集 PluginSpec，
 *            child_process.spawn(process.execPath) 起 pluginHost.js 子进程（ELECTRON_RUN_AS_NODE 纯 Node 模式）。
 *            端口经 env 注入；PluginSpec（含 per-plugin token）经 IPC（child.send）下发 --
 *            token 不落 env，防插件 process.env 窃取其他插件 token 越权（§7 per-plugin 能力绑定）。
 *
 *   python -- persistent 经 engine.ts spawnScript() 长期运行；oneshot 经 execute() 独立运行一次。
 *            显式 oneshot 仅手动触发；未声明 lifecycle 的旧 Python 清单兼容为启动时运行一次。
 *            LYSHELL_API 前置注入（lyshell 全局可用），env 只注入该插件自身 token + pluginDir，
 *            单插件单进程，无跨插件 token 泄漏（不同于 node host 多插件共享进程）。
 *
 *   stop() -- kill node host / node oneshot / python persistent 子进程 + abort python oneshot，
 *            并逐个 revokePluginToken（§8.4 三步撤销的第 1/2 步）。
 *
 * token 粒度：per-plugin。grantedCapabilities 是安装时按插件批准的（§8.2），
 * 故 token 也 per-plugin。鉴权由 http-server 按 pluginId 路由到 grantedCapabilities（兜底 gate）。
 *
 * HTTP 尚未就绪时（HTTP server 未启动），start() 经 getMcpHttpPort() 返回 null 短路。
 */
import { spawn, type ChildProcess } from 'child_process'
import { join, isAbsolute, dirname } from 'path'
import { existsSync, readFileSync } from 'fs'
import { app } from 'electron'
import log from 'electron-log'
import { pluginRepository, getPluginsDir } from '@main/storage/plugin-repository'
import { bindPluginToken, revokePluginToken } from '@main/mcp/auth'
import { getMcpHttpPort } from '@main/mcp/http-server'
import { pythonEngine } from '@main/python/engine'
import {
  validateManifest,
  isUnsafeRelativePath,
  normalizeLifecycle,
  isLegacyPythonStartup,
  shouldActivateOnStartup,
  type PluginSpec,
  type LyShellPluginManifest
} from '@shared/plugin-types'

/**
 * pluginHost.js 脚本路径。与 getMcpServerScriptPath(http-server.ts)同构。
 * dev 用 __dirname(dist/main);打包用 resources/app.asar/dist/main/(asar 内)。
 *
 * dist:win + asar 探针实测(ELECTRON_RUN_AS_NODE=1 跑打包版 LyShell.exe):
 *   - ELECTRON_RUN_AS_NODE 保留 asar 支持,spawn/require asar 内脚本可用 ✅;
 *   - 打包后 app 在 resources/app.asar(无 app/ 目录),故须用 'app.asar' 而非 'app' -- 后者 ENOENT,
 *     曾是 host 与 mcpServer 共有 bug(打包版 node 插件 host / MCP server 静默起不来),现修。
 *   - 插件 main 恒为真实路径(dev 绝对 / {userData}/plugins/,asar 外),require 无 asar 顾虑。
 */
function getHostScriptPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'app.asar', 'dist', 'main', 'pluginHost.js')
  }
  return join(__dirname, 'pluginHost.js')
}

function getOneshotHostScriptPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'app.asar', 'dist', 'main', 'pluginHostOneshot.js')
  }
  return join(__dirname, 'pluginHostOneshot.js')
}

class PluginHostManager {
  private child: ChildProcess | null = null
  private activePluginIds: string[] = []
  /** python 子进程的取消控制器(per pluginId)--oneshot execute 与 persistent 启动阶段共用,stop()/restart() 时 abort 主动 SIGTERM。 */
  private pythonControllers = new Map<string, AbortController>()
  /** node oneshot 子进程句柄(per pluginId)--stop()/restart() 时主动 kill,防孤儿。 */
  private nodeOneshotChildren = new Map<string, ChildProcess>()
  /** python persistent 子进程句柄(per pluginId)--stop()/restart() 时主动 kill。 */
  private pythonPersistentProcesses = new Map<string, ChildProcess>()
  /** oneshot 运行中插件集合(per pluginId)--防止用户重复点击「运行」导致 token 串扰/孤儿进程。 */
  private oneshotRuns = new Set<string>()
  /** oneshot 本次运行颁发的 token(per pluginId)--用于运行结束时安全撤销,避免被后一次运行的 .finally 误杀。 */
  private activeOneshotTokens = new Map<string, string>()

  /** host 子进程是否存活（killed 仅表示已发信号，用 exitCode/signalCode 判进程是否已退出） */
  isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null && this.child.signalCode === null
  }

  /**
   * 启动 plugin host。无 enabled node contributor 插件时为 no-op。
   * 须在 MCP HTTP server 起来之后调用（依赖 getMcpHttpPort）。
   */
  start(): void {
    if (this.child) {
      log.warn('[plugin-host] Already started')
      return
    }

    const port = getMcpHttpPort()
    if (!port) {
      // HTTP server 尚未就绪
      log.info('[plugin-host] Skipped: MCP HTTP server not available')
      return
    }

    // 收集 enabled contributor 插件：node 进 host 子进程，python 经 engine.ts 独立 spawn
    const enabled = pluginRepository.getEnabled()
    const specs: PluginSpec[] = []
    const legacyPythonStartupIds: string[] = []
    // 立即激活（onStartup/*）的 persistent python，启动时 spawn 长驻进程
    const pythonPersistentPlugins: Array<{ id: string; token: string; pluginDir: string; main: string }> = []
    // 所有已绑定 token 的 persistent python id（含不立即激活的），供 stop() 统一撤销 token
    const pythonPersistentIds: string[] = []
    for (const entry of enabled) {
      const manifest = this.loadManifest(entry.id, entry.path)
      if (!manifest) continue
      if (!manifest.main) {
        // consumer 插件（纯消费 API，无贡献入口）：不需要运行时
        log.info(`[plugin-host] Plugin ${entry.id} has no main entry (consumer); not loaded`)
        continue
      }
      const lifecycle = normalizeLifecycle(manifest.runtime, manifest.lifecycle)
      if (lifecycle === 'oneshot') {
        if (isLegacyPythonStartup(manifest.runtime, manifest.lifecycle)) {
          // 向后兼容：旧版 Python manifest 没有 lifecycle，当时语义是 LyShell 启动时执行一次。
          // 显式 lifecycle='oneshot' 仍采用新语义，仅用户手动「运行」。
          log.info(`[plugin-host] Legacy python plugin ${entry.id} has no lifecycle; scheduling one startup run`)
          legacyPythonStartupIds.push(entry.id)
        } else {
          log.info(`[plugin-host] Plugin ${entry.id} is explicit oneshot; skipping auto-start (run on demand)`)
        }
        continue
      }
      const pluginDir = isAbsolute(entry.path) ? entry.path : join(getPluginsDir(), entry.path)
      const token = bindPluginToken(entry.id, entry.grantedCapabilities)
      if (manifest.runtime === 'node') {
        specs.push({
          pluginId: entry.id,
          token,
          grantedCapabilities: entry.grantedCapabilities,
          manifestPath: join(pluginDir, 'lyshell-plugin.json'),
          pluginDir,
          main: manifest.main,
          runtime: manifest.runtime,
          lifecycle
        })
      } else {
        // python：每插件独立 python 子进程（engine.ts spawn），env 只含该插件自身 token。
        // 不同于 node host（多插件共享进程需 IPC 下发 token 防 env 互窃），python 单插件单进程，
        // token 落 env 安全——该进程内不存在兄弟插件可读他者 token。
        // 入口包围(评审 containment,防御纵深):main 必须相对插件目录,防指向插件目录外读取/执行他处代码。
        if (isUnsafeRelativePath(manifest.main)) {
          log.error(
            `[plugin-host] python plugin ${entry.id} main "${manifest.main}" escapes plugin directory; refusing to load`
          )
          revokePluginToken(entry.id)
          continue
        }
        const mainPath = join(pluginDir, manifest.main)
        if (!existsSync(mainPath)) {
          log.error(`[plugin-host] python plugin ${entry.id} main not found: ${mainPath}`)
          revokePluginToken(entry.id)
          continue
        }
        // 此处 lifecycle 必为 'persistent'：显式 oneshot 与 legacy Python startup 均已在上方分流。
        // 与 Node host 一致：仅 onStartup/* 立即激活；activationEvents:[] / onCommand:* 不自动启动进程。
        // 不立即激活的仍保留已绑定的 token 并纳入 activePluginIds，供后续事件分发（MVP 暂无 Python 事件源）。
        if (shouldActivateOnStartup(manifest.activationEvents ?? [])) {
          pythonPersistentPlugins.push({ id: entry.id, token, pluginDir, main: manifest.main })
        } else {
          log.info(`[plugin-host] Python persistent plugin ${entry.id} waits for activation events (${(manifest.activationEvents ?? []).join(', ') || 'none'}); not auto-started`)
        }
        pythonPersistentIds.push(entry.id)
      }
    }

    // activePluginIds 必须在 no-op return 前设置：延迟激活的 Python persistent 插件
    // （pythonPersistentIds 非空但 pythonPersistentPlugins 为空）已绑定 token，
    // 即使本次不启动任何进程，stop()/restart() 仍需能撤销这些 token。
    this.activePluginIds = [
      ...specs.map((s) => s.pluginId),
      ...pythonPersistentIds
    ]

    if (specs.length === 0 && pythonPersistentPlugins.length === 0 && legacyPythonStartupIds.length === 0) {
      log.info('[plugin-host] No enabled contributor plugins to start; nothing to spawn')
      return
    }

    // ---- node persistent 插件：单 host 子进程承载（VS Code Extension Host 式）----
    if (specs.length > 0) {
      this.spawnNodeHost(specs, port)
    }

    // ---- python persistent 插件：长期保持子进程----
    for (const p of pythonPersistentPlugins) {
      this.activatePythonPersistent(p, port)
    }

    // ---- legacy python（未声明 lifecycle）：兼容旧版「启动时运行一次」语义----
    // 复用统一 runOneshot 路径，避免恢复已删除的 activatePython 重复实现；
    // runOneshot 会临时绑定 token，并在完成/失败后自动撤销。
    for (const id of legacyPythonStartupIds) {
      const result = this.runOneshot(id)
      if (!result.success) {
        log.error(`[plugin-host] Failed to auto-start legacy python plugin ${id}: ${result.error}`)
      }
    }
  }

  /**
   * spawn node plugin host 子进程并经 IPC 下发 PluginSpec（含 per-plugin token）。
   * token 不落 env（多插件共享进程，防 process.env 互窃越权），仅 host 内存持有；
   * 插件只能通过 host 注入的 api 对象代理调用（api 不暴露 token）。
   */
  private spawnNodeHost(specs: PluginSpec[], port: number): void {
    const hostPath = getHostScriptPath()
    if (!existsSync(hostPath)) {
      log.error(`[plugin-host] pluginHost.js not found at ${hostPath}`)
      for (const s of specs) revokePluginToken(s.pluginId)
      return
    }

    log.info(
      `[plugin-host] Spawning node host for ${specs.length} plugin(s): ${specs.map((s) => s.pluginId).join(', ')}`
    )
    try {
      // spawn(process.execPath) + ELECTRON_RUN_AS_NODE:以纯 Node 模式跑 pluginHost.js(不弹 Electron 窗口)。
      // 不用 child_process.fork:fork 强制要求 stdio 含 IPC 通道;本进程用 spawn + 显式 'ipc' 项。
      // LYSHELL_MCP_SERVER_SCRIPT:mcpServer.js 权威路径(与 hostPath 同目录,兄弟 entry)。
      //   下发给 host,spawnControlled 读此 env 而非 __dirname 重算 -- 防 api.ts 被多 entry
      //   引用变 chunk 后 __dirname 漂到 chunks/ 路径错、静默退化(评审 robustness)。
      this.child = spawn(process.execPath, [hostPath], {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          LYSHELL_MCP_PORT: String(port),
          LYSHELL_MCP_SERVER_SCRIPT: join(dirname(hostPath), 'mcpServer.js')
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
      })
    } catch (e) {
      log.error('[plugin-host] Failed to spawn host:', e)
      for (const s of specs) revokePluginToken(s.pluginId)
      this.child = null
      return
    }

    // 经 IPC 下发 PluginSpec(含 per-plugin token):token 不落 env,仅 host 内存持有。
    try {
      this.child.send({ type: 'specs', specs })
    } catch (e) {
      // send 失败:host 已 spawn 却收不到 specs,会 5s 超时退出,期间 token 残留。
      // 立即撤 node 插件 token + kill host,不留无主 token。
      // (revokePluginToken 幂等;python 插件 token 仍由 activePluginIds 统一管,stop 时撤。)
      log.error('[plugin-host] Failed to send specs via IPC; revoking node tokens + killing host:', e)
      for (const s of specs) revokePluginToken(s.pluginId)
      try {
        this.child?.kill('SIGTERM')
      } catch {
        /* 进程可能已退出 */
      }
      this.child = null
      return
    }

    // 闭包捕获当前 child 引用:restart() 时旧 child 被 SIGTERM 后异步退出触发 exit,
    // 必须判 `this.child === child` 才置 null,否则会误 null 掉已重新 spawn 的新 child
    // (restart = stop+start,start 会立即把 this.child 指向新进程)。
    const child = this.child
    // 转发子进程 stderr 到主日志（host 用 console.error 输出进度）。
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trimEnd()
      if (text) log.info(text)
    })
    child.on('exit', (code, signal) => {
      log.info(`[plugin-host] Host process exited (code=${code}, signal=${signal})`)
      if (this.child === child) this.child = null
    })
    child.on('error', (err) => {
      log.error('[plugin-host] Host process error:', err)
      if (this.child === child) this.child = null
    })
  }

  /**
   * spawn node oneshot 插件子进程并经 IPC 下发单个 PluginSpec（含 per-plugin token）。
   * oneshot runner 在 activate() 完成后自动退出；host-mgr 跟踪进程句柄供 stop()/restart() 兜底 kill。
   * @returns 同步启动是否成功（spawn/send 失败返回 false，进程后续异步退出仍视为启动成功）
   */
  private spawnNodeOneshot(spec: PluginSpec, port: number, onExit?: () => void): boolean {
    const hostPath = getOneshotHostScriptPath()
    if (!existsSync(hostPath)) {
      log.error(`[plugin-host] pluginHostOneshot.js not found at ${hostPath}`)
      return false
    }

    log.info(`[plugin-host] Spawning oneshot node host for ${spec.pluginId}`)
    let child: ChildProcess
    try {
      child = spawn(process.execPath, [hostPath], {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          LYSHELL_MCP_PORT: String(port),
          LYSHELL_MCP_SERVER_SCRIPT: join(dirname(hostPath), 'mcpServer.js')
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
      })
    } catch (e) {
      log.error('[plugin-host] Failed to spawn oneshot host:', e)
      return false
    }

    this.nodeOneshotChildren.set(spec.pluginId, child)

    try {
      child.send({ type: 'spec', spec })
    } catch (e) {
      log.error(`[plugin-host] Failed to send spec to oneshot host for ${spec.pluginId}; killing:`, e)
      this.nodeOneshotChildren.delete(spec.pluginId)
      try {
        child.kill('SIGTERM')
      } catch {
        /* 进程可能已退出 */
      }
      return false
    }

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trimEnd()
      if (text) log.info(text)
    })
    // 闭包捕获 child：stop() kill 旧 child 后异步 exit，若用户已重跑 set 新 child，
    // 仅当 map 仍是本 child 才删除并回调，避免误清新 run 的句柄 + finishRun 撤错 token。
    child.on('exit', (code, signal) => {
      log.info(`[plugin-host] Oneshot host for ${spec.pluginId} exited (code=${code}, signal=${signal})`)
      if (this.nodeOneshotChildren.get(spec.pluginId) === child) {
        this.nodeOneshotChildren.delete(spec.pluginId)
        onExit?.()
      }
    })
    child.on('error', (err) => {
      log.error(`[plugin-host] Oneshot host for ${spec.pluginId} error:`, err)
      if (this.nodeOneshotChildren.get(spec.pluginId) === child) {
        this.nodeOneshotChildren.delete(spec.pluginId)
        onExit?.()
      }
    })
    return true
  }

  /**
   * 激活 python persistent 插件：长期保持子进程，直到禁用/卸载/退出。
   * MVP 仅支持 onStartup/* 激活一次；onCommand/onConnectionType 事件分发留待后续。
   */
  private activatePythonPersistent(
    p: { id: string; token: string; pluginDir: string; main: string },
    port: number
  ): void {
    if (isUnsafeRelativePath(p.main)) {
      log.error(`[plugin-host] python persistent plugin ${p.id} main "${p.main}" escapes plugin directory; refusing to load`)
      revokePluginToken(p.id)
      return
    }
    const mainPath = join(p.pluginDir, p.main)
    if (!existsSync(mainPath)) {
      log.error(`[plugin-host] python persistent plugin ${p.id} main not found: ${mainPath}`)
      revokePluginToken(p.id)
      return
    }
    log.info(`[plugin-host] Activating python persistent plugin ${p.id} (cwd=${p.pluginDir})`)
    try {
      const { proc } = pythonEngine.spawnScript(mainPath, {
        cwd: p.pluginDir,
        env: {
          LYSHELL_MCP_PORT: String(port),
          LYSHELL_PLUGIN_TOKEN: p.token,
          LYSHELL_PLUGIN_ID: p.id,
          LYSHELL_PLUGIN_DIR: p.pluginDir
        }
      })
      this.pythonPersistentProcesses.set(p.id, proc)
      // 闭包捕获 proc：restart() kill 旧 proc 后异步 exit，若 start() 已 spawn 新 proc 并 set，
      // 仅当 map 仍是本 proc 才删除，否则误删新 proc 句柄导致后续 stop()/禁用无法 kill。
      proc.on('exit', (code, signal) => {
        log.info(`[plugin-host] python persistent plugin ${p.id} exited (code=${code}, signal=${signal})`)
        if (this.pythonPersistentProcesses.get(p.id) === proc) {
          this.pythonPersistentProcesses.delete(p.id)
        }
      })
      proc.on('error', (err) => {
        log.error(`[plugin-host] python persistent plugin ${p.id} error:`, err)
        if (this.pythonPersistentProcesses.get(p.id) === proc) {
          this.pythonPersistentProcesses.delete(p.id)
        }
      })
    } catch (e) {
      log.error(`[plugin-host] Failed to spawn python persistent plugin ${p.id}:`, e)
      revokePluginToken(p.id)
    }
  }

  /**
   * 手动运行一次 oneshot 插件（用户点击“运行”触发）。
   * 运行时临时绑定 token，进程退出/完成后撤销；不进入 activePluginIds（不在 LyShell 启动时自动运行）。
   * 同 pluginId 运行未结束时再次调用会直接拒绝，避免 token 串扰与孤儿进程。
   */
  runOneshot(pluginId: string): { success: boolean; error?: string } {
    const port = getMcpHttpPort()
    if (!port) {
      return { success: false, error: 'MCP HTTP server not available' }
    }
    const entry = pluginRepository.get(pluginId)
    if (!entry) {
      return { success: false, error: 'Plugin not found' }
    }
    if (!entry.enabled) {
      return { success: false, error: 'Plugin is disabled' }
    }
    const manifest = this.loadManifest(pluginId, entry.path)
    if (!manifest || !manifest.main) {
      return { success: false, error: 'Invalid manifest or no main entry' }
    }
    const lifecycle = normalizeLifecycle(manifest.runtime, manifest.lifecycle)
    if (lifecycle !== 'oneshot') {
      return { success: false, error: 'Plugin is not oneshot' }
    }
    if (this.oneshotRuns.has(pluginId)) {
      return { success: false, error: 'Plugin is already running' }
    }

    const pluginDir = isAbsolute(entry.path) ? entry.path : join(getPluginsDir(), entry.path)
    const token = bindPluginToken(pluginId, entry.grantedCapabilities)
    this.activeOneshotTokens.set(pluginId, token)
    this.oneshotRuns.add(pluginId)

    const finishRun = (): void => {
      this.oneshotRuns.delete(pluginId)
      if (this.activeOneshotTokens.get(pluginId) === token) {
        this.activeOneshotTokens.delete(pluginId)
        revokePluginToken(pluginId)
      }
    }

    if (manifest.runtime === 'node') {
      if (isUnsafeRelativePath(manifest.main)) {
        finishRun()
        return { success: false, error: 'main escapes plugin directory' }
      }
      const spec: PluginSpec = {
        pluginId,
        token,
        grantedCapabilities: entry.grantedCapabilities,
        manifestPath: join(pluginDir, 'lyshell-plugin.json'),
        pluginDir,
        main: manifest.main,
        runtime: manifest.runtime,
        lifecycle
      }
      const started = this.spawnNodeOneshot(spec, port, finishRun)
      if (!started) {
        finishRun()
        return { success: false, error: 'Failed to start oneshot plugin' }
      }
      return { success: true }
    }

    // python oneshot：按 engine.ts oneshot 模型执行一次，完成后撤销 token。
    if (isUnsafeRelativePath(manifest.main)) {
      finishRun()
      return { success: false, error: 'main escapes plugin directory' }
    }
    const mainPath = join(pluginDir, manifest.main)
    if (!existsSync(mainPath)) {
      finishRun()
      return { success: false, error: 'main not found' }
    }
    log.info(`[plugin-host] Running python oneshot plugin ${pluginId} on demand`)
    const controller = new AbortController()
    this.pythonControllers.set(pluginId, controller)
    try {
      pythonEngine
        .runScript(mainPath, undefined, {
          cwd: pluginDir,
          timeout: manifest.pythonTimeoutMs ?? 120000,
          signal: controller.signal,
          env: {
            LYSHELL_MCP_PORT: String(port),
            LYSHELL_PLUGIN_TOKEN: token,
            LYSHELL_PLUGIN_ID: pluginId,
            LYSHELL_PLUGIN_DIR: pluginDir
          }
        })
        .then((result) => {
          const message = `[plugin-host] python oneshot plugin ${pluginId} exited (code=${result.exitCode}, signal=${result.signal || 'none'}, ${result.duration}ms)`
          if (result.exitCode === 0) log.info(message)
          else log.error(message)
        })
        .catch((err) => {
          log.error(`[plugin-host] python oneshot plugin ${pluginId} failed:`, err)
        })
        .finally(() => {
          // 闭包捕获 controller：stop() clear() 后用户可立即重跑，旧 run 的 finally 不得
          // 删新 run 的 controller / oneshotRuns / token。仅当本 run 仍是当前活跃 run 时才清场；
          // stop() 已清场（controller 不在 map）时跳过，不重复 finishRun。
          if (this.pythonControllers.get(pluginId) === controller) {
            this.pythonControllers.delete(pluginId)
            finishRun()
          }
        })
    } catch (error) {
      this.pythonControllers.delete(pluginId)
      finishRun()
      log.error(`[plugin-host] Failed to start python oneshot plugin ${pluginId}:`, error)
      return { success: false, error: (error as Error).message }
    }
    return { success: true }
  }

  /**
   * 停止 plugin host：kill 子进程 + 撤销所有 plugin token。
   * §8.4 三步撤销的第 1（停进程）/第 2（撤 token）步；第 3 步（删文件夹）属卸载流程，不在此。
   */
  stop(): void {
    if (this.child && !this.child.killed) {
      log.info('[plugin-host] Stopping host process (SIGTERM)')
      this.child.kill('SIGTERM')
      this.child = null
    }
    // node oneshot 进程：主动 SIGTERM kill，防 deactivate 漏杀 / Windows 不级联 -> 孤儿。
    if (this.nodeOneshotChildren.size > 0) {
      log.info(`[plugin-host] Stopping ${this.nodeOneshotChildren.size} oneshot node plugin process(es)`)
      for (const [id, child] of this.nodeOneshotChildren) {
        try {
          child.kill('SIGTERM')
        } catch {
          /* 进程可能已退出 */
        }
        this.nodeOneshotChildren.delete(id)
      }
    }
    // python oneshot 进程:abort 取消信号 -> engine SIGTERM 主动 kill(§8.4 第 1 步「停进程」)。
    // 此前仅撤 token 靠 401 自退,纯计算中(无 HTTP 调用)的进程会滞留至 pythonTimeoutMs。
    if (this.pythonControllers.size > 0) {
      log.info(`[plugin-host] Aborting ${this.pythonControllers.size} python plugin process(es)`)
      for (const [, controller] of this.pythonControllers) {
        controller.abort()
      }
      this.pythonControllers.clear()
    }
    // python persistent 进程：主动 kill，避免禁用/退出后仍常驻。
    if (this.pythonPersistentProcesses.size > 0) {
      log.info(`[plugin-host] Stopping ${this.pythonPersistentProcesses.size} python persistent plugin process(es)`)
      for (const [id, proc] of this.pythonPersistentProcesses) {
        try {
          proc.kill('SIGTERM')
        } catch {
          /* 进程可能已退出 */
        }
        this.pythonPersistentProcesses.delete(id)
      }
    }
    // oneshot 运行中的临时 token：兜底撤销（正常路径已由 exit/finally 处理，但 stop 可能在中途被调用）。
    if (this.activeOneshotTokens.size > 0) {
      for (const [id] of this.activeOneshotTokens) {
        revokePluginToken(id)
      }
      this.activeOneshotTokens.clear()
      this.oneshotRuns.clear()
    }
    this.revokeActiveTokens()
  }

  /**
   * 重启 plugin host:stop()(kill node host + abort python + 撤全部 token)再 start()(重读 getEnabled 重绑 token + 重 spawn)。
   * install/enable/disable/uninstall 后调用,使 registry 变更生效(对齐 VS Code Extension Host「重载窗口」)。
   *
   * 取舍:每次变更全量重启(kill 整个 node host + 撤全部 token + 重 spawn),插件多时开销偏大,
   * 快速来回切换靠下方闭包捕获保证正确性但仍有瞬时状态。此为 VS Code 式刻意取舍(简单 + 无残留状态),
   * 不做增量 -- exit handler 闭包捕获逻辑较 delicate,增量改造风险高于收益(问题定性「低/可接受」)。
   * TODO(优化):仅 python 插件变更时不重启 node host(python oneshot 单独 activate/revoke token);
   * 进一步可经 host IPC 对 node 插件单独 deactivate,免整 host 重启。
   *
   * exit handler 闭包捕获 child 引用(见 spawnNodeHost),故 restart 间旧 host 异步退出不会误清新 host。
   * HTTP 未就绪时 start() 短路(getMcpHttpPort=null),restart 仍安全 -- registry 已更新,下次真启动加载。
   */
  restart(): void {
    this.stop()
    this.start()
  }

  private revokeActiveTokens(): void {
    for (const id of this.activePluginIds) revokePluginToken(id)
    this.activePluginIds = []
  }

  /**
   * 读取并校验插件 manifest。dev 插件 entry.path 为绝对路径；否则相对 {userData}/plugins/。
   */
  private loadManifest(pluginId: string, relPath: string): LyShellPluginManifest | null {
    const pluginDir = isAbsolute(relPath) ? relPath : join(getPluginsDir(), relPath)
    const manifestPath = join(pluginDir, 'lyshell-plugin.json')
    if (!existsSync(manifestPath)) {
      log.warn(`[plugin-host] Manifest not found for ${pluginId}: ${manifestPath}`)
      return null
    }
    try {
      const raw = JSON.parse(readFileSync(manifestPath, 'utf-8'))
      const result = validateManifest(raw)
      if (!result.ok || !result.manifest) {
        log.warn(`[plugin-host] Invalid manifest for ${pluginId}: ${result.errors.join('; ')}`)
        return null
      }
      return result.manifest
    } catch (e) {
      log.warn(`[plugin-host] Failed to read manifest for ${pluginId}:`, e)
      return null
    }
  }
}

export const pluginHostManager = new PluginHostManager()
