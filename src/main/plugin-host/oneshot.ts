/**
 * Node 插件 oneshot runner。
 *
 * 每插件独立子进程：通过 IPC 从 host-mgr 接收单个 PluginSpec，加载 main 后调用 activate()，
 * 待 activate 完成（或超时）后 best-effort 调 deactivate() 并退出。
 *
 * 与共享 plugin-host 的区别：
 *   - 只处理一个 PluginSpec；
 *   - activate 完成后自动 process.exit(0)，不常驻；
 *   - 不支持 onCommand/onConnectionType 延迟激活（oneshot 仅响应 onStartup/*）。
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import type { ChildProcess } from 'child_process'
import { LyShellHttpClient } from '@main/mcp-server/http-client'
import { validateManifest, isUnsafeRelativePath } from '@shared/plugin-types'
import type { PluginSpec, LyShellPluginManifest } from '@shared/plugin-types'
import type { PluginModule } from '@shared/plugin-api'
import { createPluginApi } from './api'

interface LoadedPlugin {
  spec: PluginSpec
  manifest: LyShellPluginManifest
  module: PluginModule
  activated: boolean
}

let activePlugin: LoadedPlugin | null = null
const spawnedChildren = new Set<ChildProcess>()
let cleanupPromise: Promise<void> | null = null
let shuttingDown = false

function cleanup(): Promise<void> {
  if (cleanupPromise) return cleanupPromise
  cleanupPromise = (async () => {
    const deactivate = activePlugin?.module.deactivate
    if (typeof deactivate === 'function') {
      try {
        await Promise.race([
          Promise.resolve(deactivate()),
          new Promise<void>((resolve) => setTimeout(resolve, 2000))
        ])
        console.error(`[plugin-host:oneshot] Deactivated ${activePlugin?.spec.pluginId}`)
      } catch (e) {
        console.error(`[plugin-host:oneshot] deactivate error for ${activePlugin?.spec.pluginId}:`, e)
      }
    }

    for (const child of spawnedChildren) {
      try {
        child.kill('SIGTERM')
      } catch {
        /* 进程可能已退出 */
      }
    }
    spawnedChildren.clear()
  })()
  return cleanupPromise
}

/**
 * 读 manifest + require(main)。失败返回 null 并打印原因。
 * 与 plugin-host/index.ts 重复，但 oneshot runner 作为独立 entry 不便共享入口级代码；
 * 后续若持续演进可抽公共 loader（docs/plugin-system-design.md §5）。
 */
function loadPlugin(spec: PluginSpec): LoadedPlugin | null {
  let manifest: LyShellPluginManifest
  try {
    const raw = JSON.parse(readFileSync(spec.manifestPath, 'utf-8'))
    const v = validateManifest(raw)
    if (!v.ok || !v.manifest) {
      console.error(`[plugin-host:oneshot] Invalid manifest for ${spec.pluginId}: ${v.errors.join('; ')}`)
      return null
    }
    manifest = v.manifest
  } catch (e) {
    console.error(`[plugin-host:oneshot] Failed to read manifest for ${spec.pluginId}:`, e)
    return null
  }

  if (!spec.main) {
    console.error(`[plugin-host:oneshot] Plugin ${spec.pluginId} has no main entry`)
    return null
  }
  if (isUnsafeRelativePath(spec.main)) {
    console.error(
      `[plugin-host:oneshot] Plugin ${spec.pluginId} main "${spec.main}" escapes plugin directory; refusing to load`
    )
    return null
  }
  const mainPath = join(spec.pluginDir, spec.main)
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(mainPath) as PluginModule
    if (typeof mod.activate !== 'function') {
      console.error(`[plugin-host:oneshot] Plugin ${spec.pluginId} main does not export activate()`)
      return null
    }
    return { spec, manifest, module: mod, activated: false }
  } catch (e) {
    console.error(`[plugin-host:oneshot] Failed to load main for ${spec.pluginId}:`, e)
    return null
  }
}

/**
 * 执行单个 oneshot 插件。
 * @returns 进程退出码（0 成功，1 失败）。函数本身不退出进程，由入口统一 exit。
 */
async function runOnce(port: number, spec: PluginSpec): Promise<number> {
  console.error(`[plugin-host:oneshot] Loading ${spec.pluginId}`)
  const loaded = loadPlugin(spec)
  if (!loaded) return 1

  activePlugin = loaded
  const api = createPluginApi(spec, new LyShellHttpClient(port, spec.token), {
    onSpawn: (child) => {
      if (shuttingDown) {
        try { child.kill('SIGTERM') } catch { /* 进程可能已退出 */ }
        return
      }
      spawnedChildren.add(child)
      child.on('close', () => spawnedChildren.delete(child))
    }
  })

  // 显式触发运行：oneshot runner 被点击“运行”调起，直接 activate，不依赖 activationEvents。
  // 默认 30s；可在 manifest 中通过 oneshotTimeoutMs 覆盖（Stage 2 暂不开放文档）。
  const ONESHOT_ACTIVATE_TIMEOUT_MS = 30000
  const activateTimeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`activate() timed out after ${ONESHOT_ACTIVATE_TIMEOUT_MS}ms`))
    }, ONESHOT_ACTIVATE_TIMEOUT_MS)
    timer.unref?.()
  })

  try {
    await Promise.race([loaded.module.activate(api), activateTimeout])
    loaded.activated = true
    console.error(`[plugin-host:oneshot] Activated ${spec.pluginId}`)
  } catch (e) {
    console.error(`[plugin-host:oneshot] Failed to activate ${spec.pluginId}:`, e)
    return 1
  } finally {
    shuttingDown = true
    await cleanup()
  }

  return 0
}

// ====================== 入口 ======================
const portRaw = process.env.LYSHELL_MCP_PORT
if (!portRaw) {
  console.error('[plugin-host:oneshot] Missing LYSHELL_MCP_PORT env; cannot start.')
  process.exit(1)
}
const port = Number.parseInt(portRaw, 10)
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`[plugin-host:oneshot] Invalid LYSHELL_MCP_PORT="${portRaw}"`)
  process.exit(1)
}

const shutdown = (signal: NodeJS.Signals): void => {
  if (shuttingDown) return
  shuttingDown = true
  console.error(`[plugin-host:oneshot] Received ${signal}, cleaning up...`)
  void cleanup().finally(() => process.exit(0))
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

let started = false
const startupTimeout = setTimeout(() => {
  if (!started) {
    console.error('[plugin-host:oneshot] Timed out waiting for spec via IPC; exiting.')
    process.exit(1)
  }
}, 5000)

process.on('message', (msg: unknown) => {
  if (started) return
  if (msg && typeof msg === 'object' && (msg as { type?: string }).type === 'spec') {
    started = true
    clearTimeout(startupTimeout)
    const payload = msg as { spec: unknown }
    if (!payload.spec || typeof payload.spec !== 'object') {
      console.error('[plugin-host:oneshot] Invalid spec payload via IPC; exiting.')
      process.exit(1)
    }
    runOnce(port, payload.spec as PluginSpec)
      .then((code) => process.exit(code))
      .catch((err) => {
        console.error('[plugin-host:oneshot] Fatal:', err)
        process.exit(1)
      })
  }
})
