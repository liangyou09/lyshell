import { useEffect } from 'react'
import { usePaneStore } from '../stores'
import { readHarnessRecoveredEvent } from '@shared/harness-recovery'

/** 原位更新已打开的工作台；不新建页签、不聚焦、不重开用户已关闭的视图。 */
export function useHarnessRecovery(): void {
  useEffect(() => {
    let epoch = 0
    let active = true
    const receive = (value: unknown): void => {
      const event = readHarnessRecoveredEvent(value)
      if (!active || !event || event.identity.instanceEpoch < epoch) return
      epoch = event.identity.instanceEpoch
      const store = usePaneStore.getState()
      const tab = store.getOverlayByKind('dshWeb')
      if (!tab) return
      store.updateDshWebInPane(tab.ref.id, { url: event.url, cwd: event.cwd,
        readOnly: false, petSessionId: null, workbenchKey: null })
    }
    const dispose = window.electronAPI?.onHarnessBackendRecovered?.(receive)
    const initial = window.electronAPI?.getHarnessBackend?.()
    if (initial) void initial.then(receive).catch(() => { /* 读失败不改变现有视图，等待下一次真实通知。 */ })
    return () => { active = false; dispose?.() }
  }, [])
}
