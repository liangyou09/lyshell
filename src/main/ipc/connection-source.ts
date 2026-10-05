import type { SessionConfig } from '@shared/types'
import { ValidationError } from './validation'

/** 归属只从 main 保存项/运行时取；普通克隆必须给出仍存活的源会话。 */
export function resolveConnectionSource(config: SessionConfig, options: {
  sourceSessionId?: string; pluginId?: string
}, hooks: {
  getSaved(id: string): SessionConfig | null | undefined
  getLive(id: string): { config: SessionConfig } | undefined
  owner(id: string): string | undefined
  isPluginEnabled(id: string): boolean
}): { ownerPluginId?: string; saved?: SessionConfig; originSavedSessionId?: string } {
  const { sourceSessionId, pluginId } = options
  let originSavedSessionId = config.originSavedSessionId
  let sourceOwner: string | undefined
  if (sourceSessionId !== undefined) {
    if (config.id || pluginId) throw new ValidationError('Clone requires a new runtime session')
    const source = hooks.getLive(sourceSessionId)
    if (!source) throw new ValidationError('Source session no longer exists')
    originSavedSessionId = source.config.originSavedSessionId
    sourceOwner = hooks.owner(sourceSessionId) ?? source.config.ownerPluginId
  }
  const existingSaved = config.id ? hooks.getSaved(config.id) : undefined
  const existingLive = config.id ? hooks.getLive(config.id) : undefined
  if (config.id?.trim() && !existingSaved && !existingLive) throw new ValidationError('Session no longer exists')
  const saved = originSavedSessionId ? hooks.getSaved(originSavedSessionId) ?? undefined : undefined
  if ((originSavedSessionId && sourceSessionId === undefined && !saved) || (pluginId && !saved)) {
    throw new ValidationError('Session no longer exists')
  }
  const ownerPluginId = pluginId ?? sourceOwner ?? saved?.ownerPluginId
    ?? existingSaved?.ownerPluginId ?? existingLive?.config.ownerPluginId
    ?? hooks.owner(config.id)
  if (ownerPluginId && !hooks.isPluginEnabled(ownerPluginId)) throw new ValidationError('Plugin is disabled')
  return { ownerPluginId, saved, originSavedSessionId }
}
