import type { TokenBinding } from './auth'
import { EXCLUSIVE_CONTROL_ROUTES } from '@shared/exclusive-control'

/** 仅保留协调器已发起的插件 deactivate 释放；不从外部正文授予清理权限。 */
export function allowsShutdownRelease(
  phase: string,
  method: string | undefined,
  pathname: string,
  binding: TokenBinding | null,
  isDeactivating: (pluginId: string) => boolean
): boolean {
  return phase === 'draining' && method === 'POST' && pathname === EXCLUSIVE_CONTROL_ROUTES.release
    && binding?.kind === 'plugin' && binding.tokenSource === 'host' && !!binding.pluginId
    && isDeactivating(binding.pluginId)
}
