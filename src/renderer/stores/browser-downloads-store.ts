import { useEffect } from 'react'
import { create } from 'zustand'
import type { BrowserDownloadsSnapshot } from '@shared/browser-downloads'
import { requestBrowser } from './browser-settings-store'

interface DownloadsStore extends BrowserDownloadsSnapshot {
  loaded: boolean
  error: boolean
  popupRequest: number
  popupDownloadIds: string[]
  refresh: () => Promise<void>
}
let revision = 0
let subscribers = 0
let unsubscribe: (() => void) | undefined
export const useBrowserDownloadsStore = create<DownloadsStore>((set) => ({
  downloads: [], downloadDirectory: '', loaded: false, error: false, popupRequest: 0, popupDownloadIds: [],
  refresh: async () => {
    const before = ++revision
    const result = await requestBrowser({ kind: 'downloads' })
    // IPC 初始快照返回前到达的实时事件优先，避免进度倒退。
    if (before !== revision) return
    set(result.success && result.downloadSnapshot
      ? { ...result.downloadSnapshot, loaded: true, error: false }
      : { loaded: true, error: true })
  }
}))

/** 侧栏和设置共用一次订阅；卸载全部消费者后清理 bridge listener。 */
export function useBrowserDownloads(): DownloadsStore {
  const store = useBrowserDownloadsStore()
  useEffect(() => {
    if (subscribers++ === 0) {
      unsubscribe = window.electronAPI?.onBrowserDownloadsChanged?.(snapshot => {
        revision++
        const current = useBrowserDownloadsStore.getState()
        useBrowserDownloadsStore.setState({ ...snapshot, loaded: true, error: false, ...(snapshot.notice ? {
          popupRequest: current.popupRequest + 1,
          popupDownloadIds: [snapshot.notice.downloadId, ...current.popupDownloadIds.filter(id => id !== snapshot.notice?.downloadId)]
            .filter(id => snapshot.downloads.some(download => download.id === id)).slice(0, 3)
        } : {}) })
      })
      void useBrowserDownloadsStore.getState().refresh()
    }
    return () => { if (--subscribers === 0) { unsubscribe?.(); unsubscribe = undefined; revision++ } }
  }, [])
  return store
}
