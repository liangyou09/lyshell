import { ConnectionStatus, type SessionConfig } from '@shared/types'
import { useSessionStore } from './session-store'
import { usePaneStore } from './pane-store'
import { waitForShelfTerminalRestores } from './shelf-terminal-placement'

interface StatusUpdate { id: string; status: ConnectionStatus; error?: string }

/** 状态立即入库；自动落位须等侧栏恢复完成，不能抢在恢复回执前显示到主区。 */
export function createConnectionStatusHandler(
  pendingFetches: Map<string, symbol>,
  getSession: (id: string) => Promise<SessionConfig | null | undefined>
): (data: StatusUpdate) => void {
  return data => {
    const store = useSessionStore.getState()
    const placementReady = waitForShelfTerminalRestores()
    const existing = store.sessions.find(session => session.id === data.id)
    store.updateSessionStatus(data.id, data.status, data.error)
    if (!existing) {
      if (data.status === ConnectionStatus.DISCONNECTED || data.status === ConnectionStatus.ERROR) {
        pendingFetches.delete(data.id)
        return
      }
      const fetchId = Symbol(data.id)
      pendingFetches.set(data.id, fetchId)
      void getSession(data.id).then(async config => {
        await placementReady
        if (pendingFetches.get(data.id) !== fetchId) return
        pendingFetches.delete(data.id)
        if (!config) return
        const current = useSessionStore.getState().sessions.find(session => session.id === data.id)
        if (current) {
          if (current.status === ConnectionStatus.CONNECTING && data.status === ConnectionStatus.CONNECTED) store.updateSessionStatus(data.id, data.status, data.error)
          return
        }
        store.addTemporarySession({ id: data.id, config, status: data.status, skipAutoAddToPane: false })
        const pane = usePaneStore.getState()
        if (pane.layout.activePaneId) pane.addSessionToPane(pane.layout.activePaneId, data.id)
      }).catch(() => {
        if (pendingFetches.get(data.id) === fetchId) pendingFetches.delete(data.id)
      })
      return
    }
    if (data.status !== ConnectionStatus.CONNECTED) return
    void placementReady.then(() => {
      const current = useSessionStore.getState().sessions.find(session => session.id === data.id)
      if (!current || current.status !== ConnectionStatus.CONNECTED) return
      if (current.skipAutoAddToPane) { store.clearSkipAutoAddToPane(data.id); return }
      const pane = usePaneStore.getState()
      if (!pane.getPaneBySessionId(data.id) && pane.layout.activePaneId) pane.addSessionToPane(pane.layout.activePaneId, data.id)
    })
  }
}
