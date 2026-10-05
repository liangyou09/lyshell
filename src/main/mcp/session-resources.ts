import type { SessionConfig } from '@shared/types'
import { ConnectionStatus } from '@shared/types'
import type { PluginResourceRegistry } from '../plugin/resource-registry'

export interface SessionResourceOwner {
  pluginId?: string
  generation: number
  saved: boolean
}

/** 保存项的持久化归属优先；用户保存项只在启动新连接时归属于请求插件。 */
export function resolveSessionResourceOwner(
  registry: PluginResourceRegistry,
  config: Pick<SessionConfig, 'id' | 'ownerPluginId'>,
  requestingPluginId?: string
): SessionResourceOwner {
  const pluginId = config.ownerPluginId ?? registry.owner(config.id) ?? requestingPluginId
  return { pluginId, generation: pluginId ? registry.generation(pluginId) : 0, saved: !!config.ownerPluginId }
}

/** 检查资源原主人的状态与代次，归属冲突必须返回失败，不能继续创建连接。 */
export function trackSessionResource(
  registry: PluginResourceRegistry,
  sessionId: string,
  owner: SessionResourceOwner,
  isPluginEnabled: (pluginId: string) => boolean
): boolean {
  return !owner.pluginId || (isPluginEnabled(owner.pluginId)
    && registry.track(owner.pluginId, sessionId, owner.generation, owner.saved))
}

/** 新建/重新连接统一登记；已有活动连接只复用，不认领用户正在使用的终端。 */
export function trackSessionConnectionResource(
  registry: PluginResourceRegistry,
  sessionId: string,
  owner: SessionResourceOwner,
  currentStatus: ConnectionStatus | undefined,
  isPluginEnabled: (pluginId: string) => boolean
): boolean {
  if (currentStatus === ConnectionStatus.CONNECTED || currentStatus === ConnectionStatus.CONNECTING
    || currentStatus === ConnectionStatus.RECONNECTING) return true
  return trackSessionResource(registry, sessionId, owner, isPluginEnabled)
}

/** 首次 await 前登记新运行时，失败清理只处理仍属于本次创建的对象。 */
export async function createTrackedSession<T extends { id: string }>(
  registry: PluginResourceRegistry,
  config: SessionConfig,
  owner: SessionResourceOwner,
  hooks: {
    isRequestActive(): boolean
    isPluginEnabled(pluginId: string): boolean
    isSessionDeleting(sessionId: string): boolean
    getSession(sessionId: string): T | undefined
    createSession(config: SessionConfig): Promise<T>
    deleteSession(sessionId: string): Promise<unknown>
  }
): Promise<T | undefined> {
  if (!hooks.isRequestActive() || hooks.isSessionDeleting(config.id) || hooks.getSession(config.id)
    || !trackSessionResource(registry, config.id, owner, hooks.isPluginEnabled)) return undefined

  let created: T
  try {
    created = await hooks.createSession(config)
  } catch (error) {
    // 创建失败且没有运行时落位时撤销本代预登记；保存项归属仍由 registry 保留。
    if (!hooks.getSession(config.id) && owner.pluginId && registry.isCurrent(owner.pluginId, owner.generation)
      && registry.owner(config.id) === owner.pluginId) registry.forgetLiveSession(config.id)
    throw error
  }

  if (hooks.getSession(created.id) === created && !hooks.isSessionDeleting(created.id)
    && hooks.isRequestActive() && trackSessionResource(registry, created.id, owner, hooks.isPluginEnabled)) return created

  // 等待期间同 ID 可能被删除后重建，或已由其他插件认领；不得按旧 ID 删除新资源。
  const currentOwner = registry.owner(created.id)
  if (hooks.getSession(created.id) === created && (!currentOwner || currentOwner === owner.pluginId)) {
    await hooks.deleteSession(created.id)
  }
  return undefined
}
