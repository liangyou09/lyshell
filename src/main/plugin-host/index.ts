/**
 * LyShell Plugin Host 入口
 *
 * 独立 Node.js 子进程，承载所有 enabled 的 node 运行时插件
 * (docs/plugin-system-design.md §4 进程模型 / §8 生命周期)。
 *
 * 与 main 的通信：回连 main 的 HTTP API(127.0.0.1)，复用 mcp-server 的
 * LyShellHttpClient(纯 Node，不依赖 electron)。
 *   - LYSHELL_MCP_PORT env:HTTP API 端口（端口非敏感，经 env 传递）
 *   - PluginSpec（含 per-plugin token）经 IPC（process.on('message')）下发：
 *     token 不落 env（防插件 process.env 窃取其他插件 token 越权，§7），host 内存持有。
 *
 * 鉴权：每插件持自己的 plugin token(bindPluginToken 颁发)，capability 按
 * grantedCapabilities 限定。host 调 API 时按 pluginId 路由对应 token(见 api.ts)；
 * api 对象不暴露 token，插件只能通过 api.call 代理调用。
 *
 * 生命周期(C2)：读 manifest -> require(main) -> 注入 LyShellPluginApi ->
 *   按 activationEvents 激活(onStartup/* 立即；onCommand/onConnectionType 标记 pending，
 *   等 C4 事件源)。退出时 best-effort 调 deactivate。
 *
 * 本文件不依赖 Electron，仅用 Node 内置模块 + @main/mcp-server/http-client。
 * 由 main 进程 child_process.spawn(process.execPath) 以 ELECTRON_RUN_AS_NODE=1 启动。
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import type { ChildProcess } from 'child_process'
import { LyShellHttpClient } from '@main/mcp-server/http-client'
import { validateManifest, isUnsafeRelativePath, shouldActivateOnStartup } from '@shared/plugin-types'
import type { PluginSpec, LyShellPluginManifest } from '@shared/plugin-types'
import type { PluginModule } from '@shared/plugin-api'
import { createPluginApi } from './api'

interface LoadedPlugin {
  spec: PluginSpec
  manifest: LyShellPluginManifest
  module: PluginModule
  activated: boolean
}

/**
 * 读 manifest + require(main)。失败返回 null 并打印原因（不影响其他插件）。
 * require 用 cjs：pluginHost bundle 是 cjs，插件 main 暂假定 cjs（ESM 支持留后续）。
 */
function loadPlugin(spec: PluginSpec): LoadedPlugin | null {
  let manifest: LyShellPluginManifest
  try {
    const raw = JSON.parse(readFileSync(spec.manifestPath, 'utf-8'))
    const v = validateManifest(raw)
    if (!v.ok || !v.manifest) {
      console.error(`[plugin-host] Invalid manifest for ${spec.pluginId}: ${v.errors.join('; ')}`)
      return null
    }
    manifest = v.manifest
  } catch (e) {
    console.error(`[plugin-host] Failed to read manifest for ${spec.pluginId}:`, e)
    return null
  }

  if (!spec.main) {
    // contributor 无 main 不该进 host（host-mgr 已过滤）；防御性跳过
    return null
  }
  // 入口包围(评审 containment,防御纵深):main 必须相对插件目录,防指向插件目录外执行他处代码。
  // validateManifest 安装时已拒,此为 host 重读 manifest 后对 spec.main 的兜底。
  if (isUnsafeRelativePath(spec.main)) {
    console.error(
      `[plugin-host] Plugin ${spec.pluginId} main "${spec.main}" escapes plugin directory; refusing to load`
    )
    return null
  }
  const mainPath = join(spec.pluginDir, spec.main)
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(mainPath) as PluginModule
    if (typeof mod.activate !== 'function') {
      console.error(`[plugin-host] Plugin ${spec.pluginId} main does not export activate()`)
      return null
    }
    return { spec, manifest, module: mod, activated: false }
  } catch (e) {
    console.error(`[plugin-host] Failed to load main for ${spec.pluginId}:`, e)
    return null
  }
}

async function runHost(port: number, specs: PluginSpec[]): Promise<void> {
  // 仅处理 node 运行时(python 走 engine.ts，不经本 host)
  const nodeSpecs = specs.filter((s) => s.runtime === 'node')
  if (nodeSpecs.length === 0) {
    console.error('[plugin-host] No node-runtime plugins; host should not have been spawned.')
    process.exit(0)
  }

  // 回连 main HTTP。/api/health 不鉴权(http-server.ts:394)，token 实际未参与握手，
  // 仅用于构造 client（后续 api.call 才用各插件 token 真正鉴权）。
  const healthClient = new LyShellHttpClient(port, nodeSpecs[0].token)
  const healthy = await healthClient.healthCheck()
  if (!healthy) {
    console.error(`[plugin-host] LyShell API not responding on port ${port}; aborting.`)
    process.exit(1)
  }
  console.error(`[plugin-host] Connected to LyShell on port ${port}; loading ${nodeSpecs.length} node plugin(s)`)

  // 加载 + 激活
  const loaded: LoadedPlugin[] = []
  for (const spec of nodeSpecs) {
    const result = loadPlugin(spec)
    if (result) loaded.push(result)
  }

  // 插件经 api.spawnControlled 拉起的孙进程登记表(跨插件共享):退出时兜底 kill,
  // 防插件 deactivate 漏杀 / 超过 2s grace / Windows 不级联孙进程 -> 孤儿。
  // 子进程 'close' 时移出集合(含坏 exe 的报错子进程);shutdown 只杀仍存活的。
  const spawnedChildren = new Set<ChildProcess>()

  // activate() 限时:防止某个插件的 activate() 返回永不 resolve 的 promise 把
  // 激活循环卡死,导致其后所有 node 插件永远激活不了(与 oneshot runner 的 30s
  // 超时同思路;shared host 取更短的 15s,激活慢的插件不应拖累别的插件)。
  const ACTIVATE_TIMEOUT_MS = 15_000

  let activatedCount = 0
  for (const p of loaded) {
    // 每插件独立 client（token 不同），api 内部按 pluginId 路由 + capability gate
    const api = createPluginApi(p.spec, new LyShellHttpClient(port, p.spec.token), {
      onSpawn: (child) => {
        spawnedChildren.add(child)
        // 'close' 而非 'exit':坏 exe(ENOENT)只发 'error'+'close' 不发 'exit',
        // 听 'close' 才能把报错子进程也移出集合,长跑 host 下 Set 更干净。
        child.on('close', () => spawnedChildren.delete(child))
      }
    })
    // activationEvents 可能缺省（纯声明式清单）——按空数组处理，不自动激活
    const activationEvents = p.manifest.activationEvents ?? []
    if (shouldActivateOnStartup(activationEvents)) {
      try {
        await Promise.race([
          Promise.resolve(p.module.activate(api)),
          new Promise<never>((_, reject) => {
            const timer = setTimeout(
              () => reject(new Error(`activate() timed out after ${ACTIVATE_TIMEOUT_MS}ms`)),
              ACTIVATE_TIMEOUT_MS
            )
            timer.unref?.()
          })
        ])
        p.activated = true
        activatedCount++
        console.error(`[plugin-host] Activated ${p.spec.pluginId} (${p.spec.lifecycle})`)
      } catch (e) {
        // 抛错/超时都只影响本插件。超时分支 activate 可能仍在后台执行,照样标记
        // activated —— shutdown 时 best-effort deactivate 是它唯一的清理机会;
        // deactivate 自身有 try/catch + 限时,插件没写好也不会拖垮退出。
        p.activated = true
        console.error(`[plugin-host] Failed to activate ${p.spec.pluginId}:`, e)
      }
    } else {
      const waits =
        activationEvents.length > 0
          ? activationEvents.join(', ')
          : 'none (declarative contributes only)'
      console.error(`[plugin-host] Pending ${p.spec.pluginId} (${p.spec.lifecycle}, waits for: ${waits})`)
    }
  }

  console.error(
    `[plugin-host] Ready: ${loaded.length} loaded, ${activatedCount} activated, ${loaded.length - activatedCount} pending`
  )

  // 优雅退出：best-effort await 各插件 deactivate(每插件限时,超时强退,避免截断 async 清理)。
  const DEACTIVATE_GRACE_MS = 2000
  const shutdown = async (sig: string): Promise<void> => {
    console.error(`[plugin-host] Received ${sig}, deactivating...`)
    for (const p of loaded) {
      if (!p.activated) continue
      const deactivate = p.module.deactivate
      if (typeof deactivate !== 'function') continue
      // 限时等待 deactivate 完成:超时或异常都 resolve 继续,不阻塞退出
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          console.error(`[plugin-host] deactivate timeout for ${p.spec.pluginId} (${DEACTIVATE_GRACE_MS}ms)`)
          resolve()
        }, DEACTIVATE_GRACE_MS)
        Promise.resolve().then(() => deactivate()).then(
          () => { clearTimeout(timer); resolve() },
          (e) => { clearTimeout(timer); console.error(`[plugin-host] deactivate error for ${p.spec.pluginId}:`, e); resolve() }
        )
      })
    }
    // 兜底:杀插件 spawn 的孙进程。已退出的经 'close' 监听移出集合;
    // 仍存活的(deactivate 漏杀 / 超时 / Windows 不级联)在此 SIGTERM,防孤儿。
    for (const child of spawnedChildren) {
      try {
        child.kill('SIGTERM')
      } catch {
        /* 进程可能已退出 */
      }
    }
    spawnedChildren.clear()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

// ====================== 入口 ======================
// 插件容器进程免疫声明:本进程唯一职责是承载插件代码。插件在定时器回调 /
// EventEmitter / 裸 promise 里抛出的异步异常,Node 默认语义会杀死整个 host ——
// 那会同时带走所有 node 插件。这里捕获后仅记录、进程继续:host 自身致命错误
// (端口缺失 / 回连失败)仍走下方显式 process.exit 路径。
process.on('uncaughtException', (err) => {
  console.error('[plugin-host] Uncaught exception (host kept alive):', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[plugin-host] Unhandled rejection (host kept alive):', reason)
})

// 端口经 env（非敏感）；PluginSpec（含 token）经 IPC 下发（token 不落 env，防插件窃取）。
const portRaw = process.env.LYSHELL_MCP_PORT
if (!portRaw) {
  console.error('[plugin-host] Missing LYSHELL_MCP_PORT env; cannot start.')
  process.exit(1)
}
const port = Number.parseInt(portRaw, 10)
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`[plugin-host] Invalid LYSHELL_MCP_PORT="${portRaw}"`)
  process.exit(1)
}

let started = false
const startupTimeout = setTimeout(() => {
  if (!started) {
    console.error('[plugin-host] Timed out waiting for specs via IPC; exiting.')
    process.exit(1)
  }
}, 5000)

process.on('message', (msg: unknown) => {
  if (started) return
  if (msg && typeof msg === 'object' && (msg as { type?: string }).type === 'specs') {
    started = true
    clearTimeout(startupTimeout)
    const payload = msg as { specs: unknown }
    if (!Array.isArray(payload.specs)) {
      console.error('[plugin-host] Invalid specs payload via IPC (not an array); exiting.')
      process.exit(1)
    }
    runHost(port, payload.specs as PluginSpec[]).catch((err) => {
      console.error('[plugin-host] Fatal:', err)
      process.exit(1)
    })
  }
})
