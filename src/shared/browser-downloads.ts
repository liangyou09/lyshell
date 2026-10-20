export const BROWSER_DOWNLOADS_EVENT = 'browser:downloads-changed'
export type BrowserDownloadAction = 'cancel' | 'reveal' | 'open' | 'remove'

export interface BrowserDownload {
  id: string
  fileName: string
  savePath: string
  receivedBytes: number
  totalBytes: number
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  /** updated 的 interrupted 仍可取消；只有 done 后才释放下载项。 */
  active: boolean
  startTime: number
  /** 系统文件关联图标，只由主进程生成。 */
  iconDataUrl?: string
}

export interface BrowserDownloadsSnapshot {
  downloads: BrowserDownload[]
  downloadDirectory: string
  /** 仅实时事件携带；查询历史、目录和图标更新不触发提醒。 */
  notice?: { downloadId: string; kind: 'started' | 'completed' | 'interrupted' }
}
