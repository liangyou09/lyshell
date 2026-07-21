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
 *   python -- 每插件经 engine.ts execute() 起独立 python 子进程（oneshot 脚本模型）。
 *            LYSHELL_API 前置注入（lyshell 全局可用），env 注入 port + 该插件 token + pluginDir。
 *            单插件单进程 -> env 只含自身 token，无跨插件泄漏（不同于 node host 多插件共享进程）。
 *            fire-and-forget，不阻塞 start()；长驻/事件驱动 python 插件留待后续。
 *
 *   stop() -- kill node host 子进程 + abort python oneshot 进程（经 AbortSignal -> engine SIGTERM）+ 逐个 revokePluginToken
 *            （node + python 统一撤销，§8.4 三步撤销的第 1/2 步）。python 经 AbortController 主动 kill,
 *            不再只靠 token 撤销 401 自退（纯计算中无 HTTP 调用的进程会滞留至 pythonTimeoutMs）。
 *
 * token 粒度：per-plugin。grantedCapabilities 是安装时按插件批准的（§8.2），
 * 故 token 也 per-plugin。鉴权由 http-server 按 pluginId 路由到 grantedCapabilities（兜底 gate）。
 *
 * disableMcp 构建下 HTTP 不可用，start() 经 getMcpHttpPort() 返回 null 短路
 * （noop getMcpHttpPort 恒返回 null；__DISABLE_MCP__ 全局不在此直接引用）。
 */
import { spawn, type ChildProcess } from 'child_process'
import { join, isAbsolute } from 'path'
import { existsSync, readFileSync } from 'fs'
import { app } from 'electron'
import log from 'electron-log'
import { pluginRepository, getPluginsDir } from '@main/storage/plugin-repository'
import { bindPluginToken, revokePluginToken } from '@main/mcp/auth'
import { getMcpHttpPort } from '@main/mcp/http-server'
import { pythonEngine } from '@main/python/engine'
import { validateManifest, type PluginSpec, type LyShellPluginManifest } from '@shared/plugin-types'

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

class PluginHostManager {
  private child: ChildProcess | null = null
  private activePluginIds: string[] = []
  /** python oneshot 子进程的取消控制器(per pluginId)--stop()/restart() 时 abort 主动 SIGTERM,免滞留至 timeout。 */
  private pythonControllers = new Map<string, AbortController>()

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
      // disableMcp 构建，或 HTTP server 未就绪
      log.info('[plugin-host] Skipped: MCP HTTP server not available')
      return
    }

    // 收集 enabled contributor 插件：node 进 host 子进程，python 经 engine.ts 独立 spawn
    const enabled = pluginRepository.getEnabled()
    const specs: PluginSpec[] = []
    const pythonPlugins: Array<{ id: string; token: string; pluginDir: string; code: string; timeoutMs: number }> = []
    for (const entry of enabled) {
      const manifest = this.loadManifest(entry.id, entry.path)
      if (!manifest) continue
      if (!manifest.main) {
        // consumer 插件（纯消费 API，无贡献入口）：不需要运行时
        log.info(`[plugin-host] Plugin ${entry.id} has no main entry (consumer); not loaded`)
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
          runtime: manifest.runtime
        })
      } else {
        // python：每插件独立 python 子进程（engine.ts spawn），env 只含该插件自身 token。
        // 不同于 node host（多插件共享进程需 IPC 下发 token 防 env 互窃），python 单插件单进程，
        // token 落 env 安全——该进程内不存在兄弟插件可读他者 token。
        const mainPath = join(pluginDir, manifest.main)
        if (!existsSync(mainPath)) {
          log.error(`[plugin-host] python plugin ${entry.id} main not found: ${mainPath}`)
          revokePluginToken(entry.id)
          continue
        }
        pythonPlugins.push({ id: entry.id, token, pluginDir, code: readFileSync(mainPath, 'utf-8'), timeoutMs: manifest.pythonTimeoutMs ?? 120000 })
      }
    }

    if (specs.length === 0 && pythonPlugins.length === 0) {
      log.info('[plugin-host] No enabled contributor plugins; nothing to start')
      return
    }

    // activePluginIds 覆盖 node + python，供 stop() 统一撤销 token
    this.activePluginIds = [...specs.map((s) => s.pluginId), ...pythonPlugins.map((p) => p.id)]

    // ---- node 插件：单 host 子进程承载（VS Code Extension Host 式）----
    if (specs.length > 0) {
      this.spawnNodeHost(specs, port)
    }

    // ---- python 插件：每插件独立 spawn（fire-and-forget，不阻塞启动）----
    for (const p of pythonPlugins) {
      this.activatePython(p, port)
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
      this.child = spawn(process.execPath, [hostPath], {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          LYSHELL_MCP_PORT: String(port)
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
   * 激活 python 插件：经 engine.ts execute() 起独立 python 子进程。
   * LYSHELL_API 前置注入（lyshell 全局可用），env 注入 port + 该插件 token + pluginId + pluginDir。
   * 子进程 env 继承 caveat:插件自己 spawn 的第三方子进程可继承 env 读到本插件 token -- 但该 token
   * 绑定本插件 grantedCapabilities,泄漏不越权(插件自身已能调用同等能力,非权限升级)。
   *
   * 进程模型：oneshot 脚本（main.py 运行至结束即退出）。onStartup/* 指「启动跑一次」而非常驻 --
   * python 不支持长驻/事件驱动（需改用 node 运行时）。超时取 manifest.pythonTimeoutMs（默认 120000，
   * 上限 600000，见 @shared/plugin-types validateManifest），到点子进程被杀。fire-and-forget：不阻塞 start()。
   */
  private activatePython(
    p: { id: string; token: string; pluginDir: string; code: string; timeoutMs: number },
    port: number
  ): void {
    log.info(`[plugin-host] Activating python plugin ${p.id} (cwd=${p.pluginDir}, timeout=${p.timeoutMs}ms)`)
    // 取消控制器:stop()/restart() 时 abort -> engine 经 SIGTERM 主动 kill python oneshot 进程,
    // 不再只靠 token 撤销 401 自退(纯计算中无 HTTP 调用的进程会滞留至 pythonTimeoutMs,上限 10min)。
    const controller = new AbortController()
    this.pythonControllers.set(p.id, controller)
    pythonEngine
      .execute(p.code, {
        cwd: p.pluginDir,
        timeout: p.timeoutMs,
        signal: controller.signal,
        env: {
          LYSHELL_MCP_PORT: String(port),
          LYSHELL_PLUGIN_TOKEN: p.token,
          LYSHELL_PLUGIN_ID: p.id,
          LYSHELL_PLUGIN_DIR: p.pluginDir
        }
      })
      .then((result) => {
        this.pythonControllers.delete(p.id)
        log.info(
          `[plugin-host] python plugin ${p.id} exited (code=${result.exitCode}, ${result.duration}ms)`
        )
        if (result.stdout.trim()) log.info(`[plugin-host] ${p.id} stdout: ${result.stdout.trim()}`)
        if (result.stderr.trim()) log.info(`[plugin-host] ${p.id} stderr: ${result.stderr.trim()}`)
      })
      .catch((err) => {
        this.pythonControllers.delete(p.id)
        log.error(`[plugin-host] python plugin ${p.id} failed:`, err)
      })
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
    // python oneshot 进程:abort 取消信号 -> engine SIGTERM 主动 kill(§8.4 第 1 步「停进程」)。
    // 此前仅撤 token 靠 401 自退,纯计算中(无 HTTP 调用)的进程会滞留至 pythonTimeoutMs。
    if (this.pythonControllers.size > 0) {
      log.info(`[plugin-host] Aborting ${this.pythonControllers.size} python plugin process(es)`)
      for (const [, controller] of this.pythonControllers) {
        controller.abort()
      }
      this.pythonControllers.clear()
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
   * disableMcp 构建下 start() 短路(getMcpHttpPort=null),restart 仍安全 -- registry 已更新,下次真启动加载。
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
