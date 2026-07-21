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
import { LyShellHttpClient } from '@main/mcp-server/http-client'
import { validateManifest } from '@shared/plugin-types'
import type { PluginSpec, LyShellPluginManifest, ActivationEvent } from '@shared/plugin-types'
import type { PluginModule } from '@shared/plugin-api'
import { createPluginApi } from './api'

interface LoadedPlugin {
  spec: PluginSpec
  manifest: LyShellPluginManifest
  module: PluginModule
  activated: boolean
}

/** activationEvents 含 onStartup 或 * -> host 启动即激活 */
function shouldActivateOnStartup(events: ActivationEvent[]): boolean {
  return events.includes('onStartup') || events.includes('*')
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

  let activatedCount = 0
  for (const p of loaded) {
    // 每插件独立 client（token 不同），api 内部按 pluginId 路由 + capability gate
    const api = createPluginApi(p.spec, new LyShellHttpClient(port, p.spec.token))
    if (shouldActivateOnStartup(p.manifest.activationEvents)) {
      try {
        await p.module.activate(api)
        p.activated = true
        activatedCount++
        console.error(`[plugin-host] Activated ${p.spec.pluginId}`)
      } catch (e) {
        console.error(`[plugin-host] Failed to activate ${p.spec.pluginId}:`, e)
      }
    } else {
      const waits =
        p.manifest.activationEvents.length > 0
          ? p.manifest.activationEvents.join(', ')
          : 'none (declarative contributes only)'
      console.error(`[plugin-host] Pending ${p.spec.pluginId} (waits for: ${waits})`)
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
        Promise.resolve(deactivate()).then(
          () => { clearTimeout(timer); resolve() },
          (e) => { clearTimeout(timer); console.error(`[plugin-host] deactivate error for ${p.spec.pluginId}:`, e); resolve() }
        )
      })
    }
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

// ====================== 入口 ======================
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
