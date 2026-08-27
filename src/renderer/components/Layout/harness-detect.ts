/**
 * Harness 依赖检测的应用级缓存(dsh / codex / claude 共用)。
 *
 * 检测只在软件启动时跑一次(startAllHarnessDetects,MainWindow 挂载时预热),
 * 之后切页签直接读缓存,不再重复打 IPC —— HarnessPanel 每次挂载(切到对应页签)
 * 只做 getCachedDetect / ensureDetected,数据早已就位。
 *
 * 缓存是模块级单例:组件卸载(切走页签)不丢;in-flight Promise 去重,
 * 启动预热与首帧面板挂载并发时共享同一次请求。
 * 「重新检测」按钮与启动失败后的复核走 redetectHarness,强制刷新并覆盖缓存
 * (在途请求存在时复用,避免同帧双发)。
 */
import { HARNESS_AGENT_VIEWS, type HarnessAgentKind } from '@shared/harness'

/** 每 kind 的检测 IPC —— 只需要 detect 一项,列表/增删改仍由 HarnessPanel 自己走 */
const DETECTORS: Record<HarnessAgentKind, () => Promise<Record<string, unknown>>> = {
  dsh: () => window.electronAPI.detectDsh(),
  codex: () => window.electronAPI.detectCodex(),
  claude: () => window.electronAPI.detectClaude(),
}

/** 已落地的检测结果(kind → 依赖 → 就绪) */
const cache = new Map<HarnessAgentKind, Record<string, boolean>>()

/** 在途检测请求(去重用;落地即删) */
const inflight = new Map<HarnessAgentKind, Promise<Record<string, boolean> | null>>()

async function detectOnce(agent: HarnessAgentKind): Promise<Record<string, boolean> | null> {
  try {
    const res = await DETECTORS[agent]()
    if (!res || typeof res !== 'object') return null
    const next: Record<string, boolean> = {}
    for (const dep of HARNESS_AGENT_VIEWS[agent].dependencies) next[dep] = Boolean(res[dep])
    return next
  } catch (err) {
    console.error(`Failed to detect ${agent}:`, err)
    return null
  }
}

/** 发起(或复用在途的)一次检测并落地缓存;已有缓存时直接返回缓存 */
function request(agent: HarnessAgentKind): Promise<Record<string, boolean> | null> {
  const cached = cache.get(agent)
  if (cached) return Promise.resolve(cached)
  const running = inflight.get(agent)
  if (running) return running
  const p = detectOnce(agent)
    .then((next) => {
      if (next) cache.set(agent, next)
      return next
    })
    .finally(() => { inflight.delete(agent) })
  inflight.set(agent, p)
  return p
}

/** 同步读缓存;没有(还没测/测失败)返回 null。不发起任何请求 */
export function getCachedDetect(agent: HarnessAgentKind): Record<string, boolean> | null {
  return cache.get(agent) ?? null
}

/** 拿检测结果:有缓存用缓存,没有则兜底发起一次(启动预热漏掉时面板的保险) */
export function ensureDetected(agent: HarnessAgentKind): Promise<Record<string, boolean> | null> {
  return request(agent)
}

/** 强制重检(手动「重新检测」/启动失败复核):绕过缓存,落地后覆盖 */
export function redetectHarness(agent: HarnessAgentKind): Promise<Record<string, boolean> | null> {
  // 已有在途请求时复用 —— 同一时刻同 kind 最多一次 IPC
  const running = inflight.get(agent)
  if (running) return running
  const p = detectOnce(agent)
    .then((next) => {
      if (next) cache.set(agent, next)
      return next
    })
    .finally(() => { inflight.delete(agent) })
  inflight.set(agent, p)
  return p
}

/** 软件启动预热:三个 kind 并行各测一次,用户还没点开页签结果就已就位 */
export function startAllHarnessDetects(): void {
  for (const agent of Object.keys(DETECTORS) as HarnessAgentKind[]) void request(agent)
}
