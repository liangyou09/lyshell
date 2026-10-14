/**
 * Pet 托管控制的**运行期接线**：把真实 PetLink host token 生命周期、S2 后台租约
 * 与 dsh 桥控制端点接到控制服务上。
 *
 * 为什么单独一个模块：控制服务的三个真实来源分属不同模块 ——
 *   ① 授权/启用态：mcp/auth 的 token 绑定 + pluginRepository 的 enabled；
 *   ② 后台：DshWebManager 的 acquire/release（复用或首次启动，不 restart）；
 *   ③ 桥：DshWebManager.bridgeControlEndpoint。
 * 集中在这里，避免 http-server 与 dsh 子模块互相 import。
 */

import log from 'electron-log'
import { createDshWebLaunchResolver } from './launch-resolve'
import type { ExclusiveBridgeCommand, ExclusiveBackendLease, ExclusiveControlService } from './exclusive-control'
import { getExclusiveControl, initExclusiveControl } from './exclusive-control'
import { createBridgeControlRunner } from './exclusive-bridge-client'
import { dshWebManager } from './web'
import { HARNESS_AGENTS } from '../harness/config'
import { pluginRepository } from '../storage/plugin-repository'
import { onPluginTokenRevoked } from '../mcp/auth'
import { EXCLUSIVE_CONTROLLER_PLUGIN_ID } from '@shared/exclusive-control'
import type { ExclusiveControlSnapshot, ExclusiveViewerState, ExclusiveWorkbenchDetail } from '@shared/exclusive-control'

/** Pet 绑定持有者对共享后台的 keep-alive 标记（release/revoke 时解绑；绝不 kill 后台）。 */
function exclusiveHolder(bindingId: string): string {
  return `exclusive:${bindingId}`
}

/** 共享工作台详情视图对共享后台的 keep-alive 标记（关闭 overlay 时解绑）。 */
export const WORKBENCH_DETAIL_HOLDER = 'workbench:detail'
export const WORKBENCH_DETAIL_BINDING = 'workbench:detail'

/** 当前受控 dsh 实例身份（就绪才有；未就绪返回 null）。 */
export function getDshInstanceIdentity(): { instanceId: string; instanceEpoch: number } | null {
  const identity = dshWebManager.instanceIdentity
  if (!identity) return null
  return { instanceId: identity.instanceId, instanceEpoch: identity.instanceEpoch }
}

/** 控制服务单例的读取面（IPC 只读快照用；未初始化返回 null）。 */
export { getExclusiveControl }

/** 唯一桥命令执行器（端点每次现读：实例换代后自动指向新桥，旧端点立即失效）。 */
export const runExclusiveBridge = createBridgeControlRunner(() => dshWebManager.bridgeControlEndpoint)

/**
 * 复用/首次启动 S2 后台并拿一条租约。
 * 走与 IPC 完全同一份解析服务（createDshWebLaunchResolver(HARNESS_AGENTS.dsh)），
 * 因此不会另建后台、不会多解析一次；默认目标缺省 ⇒ manager 优先复用当前实例。
 */
async function acquireBackendLease(bindingId: string): Promise<ExclusiveBackendLease | null> {
  const resolver = createDshWebLaunchResolver(HARNESS_AGENTS.dsh)
  const result = await dshWebManager.acquire((target) => resolver.resolve(target), { bindingId: exclusiveHolder(bindingId) })
  if (!result.ok) {
    log.warn(`[Exclusive] backend acquire failed: ${result.code}`)
    return null
  }
  const holder = exclusiveHolder(bindingId)
  // keep-alive 标记：持有Pet 绑定期间 dsh:web:close / dsh:web:open 都不得杀共享后台（只解绑）。
  dshWebManager.retainBackend(holder)
  if (!result.bindingId) {
    // 没有拿到租约（默认目标复用路径下 manager 不登记 binding）：仍然成功复用，
    // 解绑时按 bindingId 尝试释放；失败不影响正确性。
    log.info('[Exclusive] backend reused without a new lease')
  }
  return {
    bindingId: result.bindingId ?? exclusiveHolder(bindingId),
    release: () => {
      dshWebManager.unretainBackend(holder)
      try {
        dshWebManager.release(result.bindingId ?? exclusiveHolder(bindingId))
      } catch (err) {
        log.warn('[Exclusive] backend lease release failed:', (err as Error).message)
      }
    }
  }
}

/**
 * 共享工作台详情：**复用**同一后台（绝不走 open() 的显式重开路径，不 restart）。
 * 返回 URL/cwd/实例身份 + 当前Pet 绑定相位，供渲染层挂到现有 dshWeb 单例 overlay 上。
 */
export async function acquireWorkbenchDetail(): Promise<
  | { ok: true; url: string; cwd: string; instanceId: string; instanceEpoch: number; reused: boolean; readOnly: boolean; viewer: ExclusiveViewerState | null }
  | { ok: false; code: string; error: string }
> {
  const resolver = createDshWebLaunchResolver(HARNESS_AGENTS.dsh)
  const result = await dshWebManager.acquire((target) => resolver.resolve(target), { bindingId: WORKBENCH_DETAIL_BINDING })
  if (!result.ok) return { ok: false, code: result.code, error: result.error }
  dshWebManager.retainBackend(WORKBENCH_DETAIL_HOLDER)
  const service = getExclusiveControl()
  const snapshot = service?.getSnapshot() ?? null
  return {
    ok: true,
    url: result.url,
    cwd: result.identity.cwd,
    instanceId: result.identity.instanceId,
    instanceEpoch: result.identity.instanceEpoch,
    reused: result.reused,
    readOnly: false,
    viewer: service?.getViewerState() ?? snapshot?.viewer ?? null
  }
}

/** 关闭共享工作台详情视图：只解绑 keep-alive 与租约，**不杀**共享后台。 */
export function releaseWorkbenchDetail(): void {
  dshWebManager.unretainBackend(WORKBENCH_DETAIL_HOLDER)
  try {
    dshWebManager.release(WORKBENCH_DETAIL_BINDING)
  } catch (err) {
    log.warn('[Workbench] detail lease release failed:', (err as Error).message)
  }
}

/**
 * 详情面身份：phase + 实例代际 + 任务/会话。
 *
 * 为什么是这几个字段的组合：
 *   - epoch 换了 = 新的控制轮次（旧详情面作废，可重新导航）；
 *   - taskId 换了 = 新任务（Pet 的新回合要把工作台带到新目标）；
 *   - sessionId 换了 = 目标会话变了（工作会话切换 / 新会话）。
 * 用户自己浏览历史**不**改这个身份 —— 所以「同一实例同一会话」的重复推送不会把用户拽回。
 */
export function workbenchDetailKey(input: {
  phase: string
  epoch: number | null
  taskId: string | null
  sessionId: string | null
}): string | null {
  if (!input.epoch || !input.sessionId) return null
  return `${input.phase}:${input.epoch}:${input.taskId ?? '-'}:${input.sessionId}`
}

/** 推导详情面所需的最小服务面（真实实现由 ExclusiveControlService 满足）。 */
export interface WorkbenchDetailSource {
  getSnapshot: () => ExclusiveControlSnapshot
  isHeld: boolean
  isReleasing: boolean
}

/**
 * 当前共享工作台**详情面**（主进程 → 渲染层的窄负载；不含凭据）。
 *
 * `readOnly` 是兼容字段，在所有相位都为 false。
 * 终态任务（completed/cancelled/failed）不算「活动任务」—— 它们只留历史，不再作为导航目标。
 */
export function deriveWorkbenchDetail(source: WorkbenchDetailSource | null, now = Date.now()): ExclusiveWorkbenchDetail {
  if (!source) {
    return { key: null, phase: 'free', petSessionId: null, taskId: null, instanceEpoch: null, readOnly: false, updatedAt: now }
  }
  const snapshot = source.getSnapshot()
  const binding = snapshot.binding
  const task = snapshot.activeTask
  const openTask = task && task.state !== 'completed' && task.state !== 'cancelled' && task.state !== 'failed' ? task : null
  const sessionId = openTask?.sessionId ?? binding?.sessionIdForTask ?? null
  const key = workbenchDetailKey({
    phase: snapshot.phase,
    epoch: binding?.epoch ?? null,
    taskId: openTask?.taskId ?? null,
    sessionId
  })
  return {
    key,
    phase: snapshot.phase,
    petSessionId: sessionId,
    taskId: openTask?.taskId ?? null,
    instanceEpoch: binding?.instanceEpoch ?? null,
    readOnly: false,
    updatedAt: now
  }
}

/** 详情面（服务单例读取面）。 */
export function getWorkbenchDetail(now = Date.now()): ExclusiveWorkbenchDetail {
  return deriveWorkbenchDetail(getExclusiveControl(), now)
}

/** 上一次已发布的详情面身份（同一身份重复推送无意义；强制发布时忽略）。 */
let publishedDetailKey: string | null = null

/**
 * 计算详情面并报告**是否发生了变化**（调用方据此决定推不推 IPC 事件）。
 * `force` 用于「渲染层刚重载 / 详情页签刚打开」这类需要补一份当前状态、但状态本身没变的场景。
 */
export function publishWorkbenchDetail(force = false): { detail: ExclusiveWorkbenchDetail; changed: boolean } {
  const detail = getWorkbenchDetail()
  const changed = detail.key !== publishedDetailKey
  if (!changed && !force) return { detail, changed: false }
  publishedDetailKey = detail.key
  return { detail, changed: true }
}

/**
 * 请求官方工作台导航到某个会话（冻结 viewer/session/epoch/revision）。
 * 无 Pet 绑定 ⇒ 明确 control/not-held；普通官方 Web 不受该绑定影响。
 */
export async function requestWorkbenchNavigation(
  sessionId: string,
  forceAcknowledgement = false
): Promise<{ ok: true; skipped: boolean; viewer: ExclusiveViewerState | null } | { ok: false; code: string; error: string }> {
  const service = getExclusiveControl()
  if (!service) return { ok: false, code: 'instance/unavailable', error: 'exclusive control is not initialized' }
  const snapshot = service.getSnapshot()
  const epoch = snapshot.binding?.epoch
  if (!epoch) return { ok: false, code: 'control/not-held', error: 'exclusive control is not held' }
  const result = await service.requestViewerNavigation({ epoch, sessionId, forceAcknowledgement })
  if (!result.ok) return { ok: false, code: result.code, error: result.error }
  return { ok: true, skipped: result.skipped, viewer: result.viewer }
}

/** 外部详情请求须等官方页面真实 ack；IPC 挂载路径仍只排队，避免等待自身挂载。 */
export async function confirmWorkbenchNavigation(sessionId: string): ReturnType<typeof requestWorkbenchNavigation> {
  const service = getExclusiveControl()
  const epoch = service?.getSnapshot().binding?.epoch
  // 明确详情动作每次索取新 ack：旧 webview 关闭后的短暂 heartbeat 不能冒充新页签已加载。
  const requested = await requestWorkbenchNavigation(sessionId, true)
  if (!requested.ok || !service || !epoch) return requested
  const request = requested.viewer?.request
  if (!request && requested.viewer?.connected && requested.viewer.currentSessionId === sessionId) return requested
  if (!request) return { ok: false, code: 'viewer/unavailable', error: 'official workbench has not confirmed navigation' }
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    if (service.getSnapshot().binding?.epoch !== epoch) {
      return { ok: false, code: 'task/stale-epoch', error: 'control changed while waiting for official navigation' }
    }
    const synced = await service.syncFromBridge()
    if (!synced.ok) return synced
    const viewer = service.getViewerState()
    const ack = viewer?.lastAck
    if (ack?.requestId === request.requestId) {
      if (ack.status === 'navigated' && ack.currentSessionId === sessionId && viewer?.currentSessionId === sessionId) {
        return { ok: true, skipped: requested.skipped, viewer }
      }
      return { ok: false, code: ack.status === 'superseded' ? 'viewer/stale' : 'viewer/unavailable', error: 'official workbench did not navigate to the requested session' }
    }
    if (!viewer?.request || viewer.request.requestId !== request.requestId) {
      return { ok: false, code: 'viewer/stale', error: 'viewer navigation was superseded' }
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return { ok: false, code: 'viewer/unavailable', error: 'official workbench navigation acknowledgement timed out' }
}

/** 已接线的撤销订阅 disposer（重复 wire 只订阅一次）。 */
let revokeSubscription: (() => void) | null = null

/**
 * 构造 host token 撤销的回调（可单测）。
 *
 * 关键：**受控插件**（aipet）的 host token 被撤销时必须无条件调用 `service.revoke`，
 * 即使此刻还没有已登记的 binding —— acquire 可能正卡在后台/桥往返之间，
 * 只有 revoke 推进 `revokedEpoch` 才能让那个在飞 acquire 失效（否则它会复活成一个仍持有旧 epoch 的桥）。
 * 其他插件与自己无关，忽略。
 */
export function createPluginRevokeHandler(
  serviceOf: () => ExclusiveControlService | null,
  controllerPluginId: string
): (pluginId: string) => void {
  return (pluginId) => {
    if (pluginId !== controllerPluginId) return
    const current = serviceOf()
    if (!current) return
    current.revoke('plugin host token revoked')
  }
}

/**
 * 初始化控制服务单例（bootstrap 调用一次）。
 * 真实授权：只有已启用 aipet 插件的 **host** token（由 mcpAuth 解析）能进入控制面。
 */
export function wireExclusiveControl(): ExclusiveControlService {
  const existing = getExclusiveControl()
  if (existing) return existing
  const service = initExclusiveControl({
    runBridge: (command: ExclusiveBridgeCommand) => runExclusiveBridge(command),
    currentInstance: getDshInstanceIdentity,
    // 启用态来自真实插件仓库（禁用/卸载立即失效）；查不到即未启用（fail closed）
    isPluginEnabled: (pluginId) => pluginRepository.get(pluginId)?.enabled === true,
    acquireBackend: (bindingId) => acquireBackendLease(bindingId)
  })
  // host token 被撤销（禁用/卸载/重签）⇒ 立即撤销 Pet 绑定：拒绝旧请求 + 走桥 release
  if (!revokeSubscription) {
    revokeSubscription = onPluginTokenRevoked(createPluginRevokeHandler(getExclusiveControl, EXCLUSIVE_CONTROLLER_PLUGIN_ID))
  }
  return service
}

/** 退出路径：解除撤销订阅（服务单例由 disposeExclusiveControl 清理）。 */
export function unwireExclusiveControl(): void {
  if (revokeSubscription) {
    revokeSubscription()
    revokeSubscription = null
  }
}

/**
 * 把桥的真实状态同步进服务（任务终态、待答审批、工作输出）。
 * 读路径使用：不进变更准入链，长任务不阻塞展示。
 */
export async function syncExclusiveBridgeState(): Promise<{ ok: true } | { ok: false; code: string; error: string }> {
  const service = getExclusiveControl()
  if (!service) return { ok: true }
  return await service.syncFromBridge()
}
