import { app, BrowserWindow, session, shell } from 'electron'
import type { DownloadItem, Session } from 'electron'
import { existsSync, mkdirSync } from 'fs'
import { basename, extname, join } from 'path'
import { randomUUID } from 'crypto'
import { WEBBAR_PARTITION } from '@shared/constants'
import { BROWSER_DOWNLOADS_EVENT, type BrowserDownload, type BrowserDownloadAction, type BrowserDownloadsSnapshot } from '@shared/browser-downloads'
import { downloadHistory } from '../storage/download-history'

const entries = new Map<string, BrowserDownload>()
const items = new Map<string, DownloadItem>()
const reservedPaths = new Set<string>()
const installed = new WeakSet<Session>()
let notification: ReturnType<typeof setTimeout> | undefined

export function getBrowserDownloads(): BrowserDownloadsSnapshot {
  return { downloads: [...entries.values()].reverse().map(entry => ({ ...entry })), downloadDirectory: downloadHistory.getConfig().defaultDir }
}

function publish(notice?: BrowserDownloadsSnapshot['notice']): void {
  if (notification) { clearTimeout(notification); notification = undefined }
  // 活动下载不被上限挤掉；只保留最近 100 个已结束项。
  const finished = [...entries.values()].filter(value => !value.active)
  for (const old of finished.slice(0, Math.max(0, finished.length - 100))) entries.delete(old.id)
  const snapshot: BrowserDownloadsSnapshot = { ...getBrowserDownloads(), ...(notice ? { notice } : {}) }
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(BROWSER_DOWNLOADS_EVENT, snapshot)
  }
}

/** 默认目录也可从终端设置修改，通知所有已经挂载的浏览器面板。 */
export function notifyBrowserDownloadDirectoryChanged(): void { publish() }

/** 网站文件名只作文件名使用；同名文件及并行下载均不得覆盖。 */
function savePath(directory: string, rawName: string): string {
  // eslint-disable-next-line no-control-regex -- 下载文件名不能包含控制字符。
  let name = basename(rawName.replace(/\\/g, '/')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 180).replace(/[. ]+$/g, '')
  if (!name || /^\.+$/.test(name)) name = 'download'
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) name = `_${name}`
  const extension = extname(name)
  const stem = name.slice(0, name.length - extension.length)
  let target = join(directory, name)
  for (let index = 1; existsSync(target) || reservedPaths.has(target.toLowerCase()); index++) target = join(directory, `${stem} (${index})${extension}`)
  return target
}

export function initializeBrowserDownloads(): void {
  const browserSession = session.fromPartition(WEBBAR_PARTITION)
  if (installed.has(browserSession)) return
  installed.add(browserSession)
  browserSession.on('will-download', (_event, item) => {
    const entry: BrowserDownload = {
      id: randomUUID(), fileName: item.getFilename(), savePath: '',
      receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes(),
      state: 'progressing', active: true, startTime: Date.now()
    }
    entries.set(entry.id, entry)
    try {
      const directory = downloadHistory.getConfig().defaultDir
      mkdirSync(directory, { recursive: true })
      entry.savePath = savePath(directory, entry.fileName)
      entry.fileName = basename(entry.savePath)
      reservedPaths.add(entry.savePath.toLowerCase())
      item.setSavePath(entry.savePath)
    } catch {
      entry.state = 'interrupted'; entry.active = false
      reservedPaths.delete(entry.savePath.toLowerCase())
      item.cancel()
      publish({ downloadId: entry.id, kind: 'interrupted' })
      return
    }
    items.set(entry.id, item)
    item.on('updated', (_event, state) => {
      if (!entry.active) return
      entry.state = state
      entry.receivedBytes = item.getReceivedBytes()
      entry.totalBytes = item.getTotalBytes()
      if (!notification) notification = setTimeout(() => publish(), 200)
    })
    item.once('done', (_event, state) => {
      entry.state = state; entry.active = false
      entry.receivedBytes = item.getReceivedBytes()
      entry.totalBytes = item.getTotalBytes()
      items.delete(entry.id)
      reservedPaths.delete(entry.savePath.toLowerCase())
      publish(state === 'completed' || state === 'interrupted' ? { downloadId: entry.id, kind: state } : undefined)
      if (state === 'completed') {
        // 图标查询不挡完成态；晚到的结果不能恢复已移除的记录。
        void app.getFileIcon(entry.savePath, { size: 'normal' }).then(icon => {
          if (entries.get(entry.id) !== entry || icon.isEmpty()) return
          entry.iconDataUrl = icon.toDataURL()
          publish()
        }).catch(() => undefined)
      }
    })
    publish({ downloadId: entry.id, kind: 'started' })
  })
}

/** 路径始终从主进程登记的下载项解析，renderer 不能传入任意路径。 */
export function browserDownloadAction(id: string, action: BrowserDownloadAction): boolean | Promise<boolean> {
  const entry = entries.get(id)
  if (!entry) return false
  if (action === 'remove') {
    if (entry.active) return false
    entries.delete(id)
    publish()
    return true
  }
  if (action === 'cancel') {
    const item = items.get(id)
    if (!entry.active || !item) return false
    item.cancel()
    return true
  }
  if (entry.state !== 'completed' || !entry.savePath || !existsSync(entry.savePath)) return false
  if (action === 'open') return shell.openPath(entry.savePath).then(error => !error)
  shell.showItemInFolder(entry.savePath)
  return true
}

export async function openBrowserDownloadDirectory(): Promise<boolean> {
  const directory = downloadHistory.getConfig().defaultDir
  mkdirSync(directory, { recursive: true })
  return !(await shell.openPath(directory))
}
