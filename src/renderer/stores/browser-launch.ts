import { externalBrowserUrl } from '@shared/browser-launch'
import { useBrowserSettingsStore } from './browser-settings-store'
import { usePaneStore } from './pane-store'

/** 先订阅再主动拉取，串行消费，避免 renderer 尚未挂载时的系统链接丢失。 */
export function initializeBrowserLaunches(): () => void {
  const api = window.electronAPI
  if (!api?.takeBrowserLaunches || !api.onBrowserLaunchPending) return () => {}
  let disposed = false
  let pending = Promise.resolve()
  const ready = useBrowserSettingsStore.getState().load()
  const drain = () => {
    pending = pending.then(async () => {
      await ready
      if (disposed) return
      const urls = await api.takeBrowserLaunches()
      // take 已取出的批次必须落地；React effect 清理不能丢掉已认领的链接。
      for (const raw of urls) {
        const url = externalBrowserUrl(raw)
        if (!url) continue
        const result = usePaneStore.getState().openWebTab(url)
        if (!result.ok) console.error('Browser link could not be opened:', result.error)
      }
    }).catch(() => console.error('Browser launch requests could not be read'))
  }
  const off = api.onBrowserLaunchPending(drain)
  drain()
  return () => { disposed = true; off() }
}
