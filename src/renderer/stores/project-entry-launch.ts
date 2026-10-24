import type { OverlayPayload } from '@shared/types'
import { ConnectionStatus } from '@shared/types'
import { usePaneStore } from './pane-store'
import { useSessionStore } from './session-store'
import { registerSceneSession } from './project-scene'

/** 显式启动回执之后，只落位同一 sessionId；失败重试不得再次启动进程。 */
export async function attachProjectEntrySession(overlayId: string, payload: Extract<OverlayPayload, { kind: 'projectEntry' }>, sessionId: string): Promise<void> {
  const existing = useSessionStore.getState().sessions.find(session => session.id === sessionId)
  const config = existing?.config ?? await window.electronAPI.getSession(sessionId)
  if (!config) throw new Error('进程已创建，但尚未取得终端信息。可重试定位，不会再次启动。')
  // 先建立 entry，使延迟到达的主窗口 fetch 不再把它移动到别的活动分屏。
  const latest = useSessionStore.getState().sessions.find(session => session.id === sessionId)
  if (!latest) useSessionStore.getState().addTemporarySession({ id: sessionId, config, status: ConnectionStatus.CONNECTING, skipAutoAddToPane: true })
  const panes = usePaneStore.getState()
  const paneId = panes.getOverlayPaneId(overlayId) ?? panes.getPaneBySessionId(sessionId)?.id ?? panes.layout.activePaneId
  if (!paneId) throw new Error('终端已创建；当前没有可用分屏，请重新定位。')
  panes.addSessionToPane(paneId, sessionId)
  usePaneStore.getState().insertSessionAtOverlaySlot(overlayId, paneId, sessionId)
  registerSceneSession(payload.projectSceneId, sessionId)
  usePaneStore.getState().closeOverlay(overlayId)
  usePaneStore.getState().setActiveSessionInPane(paneId, sessionId)
}
