/**
 * 插件界面视图 UI token 生命周期（main 侧编排）
 *
 * 准则（docs/plugin-ui-views-plan.md §二「UI 专用凭据」）：
 *   - 对每个已启用且有视图（声明式或运行时）的插件建立 UI token，包括无 main
 *     和 oneshot 插件 —— 声明式视图不要求宿主进程，凭据必须独立于 host token。
 *   - 动态注册首个视图时同步建立；注销最后一个视图时撤销。
 *   - 权限变更（grantedCapabilities 重签）= 整插件撤销后按新授权重建。
 *   - 禁用/卸载 = 整插件撤销（host + UI token 一起，三步撤销）。
 *   - host-mgr.stop()/restart() 只撤 host token，不动这里的 UI token。
 *
 * token 只留在 main（经 mcp/auth.ts），不传给 renderer、guest、preload 或插件宿主。
 */
import log from 'electron-log'
import { pluginRepository } from '@main/storage/plugin-repository'
import { bindPluginUiToken, hasPluginUiToken, revokeAllPluginTokens, revokePluginUiToken } from '@main/mcp/auth'
import type { PluginViewRegistry } from '@main/plugin/view-registry'

/** 单插件：有视图且已启用则确保 UI token 存在（无则建，有则跳过 ——
 *  权限快照的新鲜度由 refreshAllPluginUiTokens 在安装/启用等授权变更路径统一重签保证） */
export function ensurePluginUiToken(viewRegistry: PluginViewRegistry, pluginId: string): void {
  const entry = pluginRepository.get(pluginId)
  if (!entry || !entry.enabled) return
  if (viewRegistry.listViewsForPlugin(pluginId).length === 0) return
  if (!hasPluginUiToken(pluginId)) {
    bindPluginUiToken(pluginId, [...entry.grantedCapabilities])
  }
}

/** 单插件：无视图（或插件已禁用/卸载）则撤销其 UI token */
export function maybeRevokePluginUiToken(viewRegistry: PluginViewRegistry, pluginId: string): void {
  if (!hasPluginUiToken(pluginId)) return
  const entry = pluginRepository.get(pluginId)
  const stillValid = entry !== undefined && entry.enabled && viewRegistry.listViewsForPlugin(pluginId).length > 0
  if (!stillValid) {
    revokePluginUiToken(pluginId)
  }
}

/**
 * 全量同步：UI token 集合 ↔ 「已启用且有视图」的插件集合。启动初始化、安装/
 * 启用/禁用/卸载/权限重签后调用；权限重签即「撤销旧 token + 按新授权重建」。
 */
export function refreshAllPluginUiTokens(viewRegistry: PluginViewRegistry): void {
  const enabled = pluginRepository.getEnabled()
  const withViews = new Set(
    enabled.filter((e) => viewRegistry.listViewsForPlugin(e.id).length > 0).map((e) => e.id)
  )
  for (const e of withViews) {
    const entry = pluginRepository.get(e)
    if (!entry) continue
    // 无条件按当前授权重签（撤销旧 token + 按新授权重建）：token 挂的是签发时的
    // 权限快照，安装会覆盖 grantedCapabilities（如同 ID 重装减权），只补签会让
    // 已有视图的 callApi 继续用旧（更宽）权限。token 只在 main 内存，重签对外部
    // 不可见；重签窗口内在途的一次 loopback 调用可能 401，由调用方按失败回显。
    if (hasPluginUiToken(e)) revokePluginUiToken(e)
    bindPluginUiToken(e, [...entry.grantedCapabilities])
  }
  // 撤销「有 token 但已无资格」的插件 UI token（禁用/卸载/视图清空）。
  // 这里不枚举 token 表（auth.ts 不暴露迭代），用注册表全量对账。
  for (const entry of pluginRepository.getAll()) {
    if (!withViews.has(entry.id)) {
      maybeRevokePluginUiToken(viewRegistry, entry.id)
    }
  }
}

/**
 * 权限重签：整插件撤销（host + UI）后按新授权重建两种 token。
 * 由 handlers 的权限变更路径调用（先变更/撤权，再重签、再广播）。
 * 返回新 UI token（若该插件有视图），无视图时为 null。
 */
export function reSignPluginTokens(
  viewRegistry: PluginViewRegistry,
  pluginId: string,
  rebindHost: () => void
): void {
  revokeAllPluginTokens(pluginId)
  rebindHost()
  const entry = pluginRepository.get(pluginId)
  if (entry && entry.enabled && viewRegistry.listViewsForPlugin(pluginId).length > 0) {
    bindPluginUiToken(pluginId, [...entry.grantedCapabilities])
    log.info(`[plugin][view] re-signed UI token for ${pluginId}`)
  }
}
