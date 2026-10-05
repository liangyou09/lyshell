import type { WebTabPopupRequest } from '@shared/types'
import { pluginWebOwner } from '@shared/plugin-web-resources'
import { usePaneStore } from '../../stores/pane-store'
import { usePluginStore } from '../../stores/plugin-store'
import { webTabPopupSource } from './web-tab-controls'
import { gateWebTabPopup, recordWebTabPopup } from './web-tab-popup-gate'

/** 来源存活与归属校验先于频控；禁用后的迟到 IPC 不得创建无归属页签。 */
export function openWebTabPopup({ url, background, postToken, sourceWebContentsId, sourceUrl }: WebTabPopupRequest): boolean {
  const source = webTabPopupSource(sourceWebContentsId)
  if (!source) return false
  const panes = usePaneStore.getState()
  const payload = source.kind === 'tab' ? panes.overlayPayloads[source.id] : undefined
  if (source.kind === 'tab' && !payload) return false
  const ownerPluginId = payload?.ownerPluginId ?? pluginWebOwner(sourceUrl ?? '',
    usePluginStore.getState().items.filter(p => p.enabled).flatMap(p => p.views))
  const isPost = !!postToken
  if (!gateWebTabPopup(url, isPost)) return false
  if (!panes.openWebTab(url, undefined, { background, postToken, ownerPluginId }).ok) return false
  recordWebTabPopup(url, isPost)
  return true
}
