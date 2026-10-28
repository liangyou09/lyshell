import { externalBrowserUrl } from '@shared/browser-launch'

/** 首次启动等待主窗口就绪后主动认领；通知只负责唤醒，不携带网址。 */
export class BrowserLaunchQueue {
  consumerId: number | null = null
  private urls: string[] = []

  enqueue(value: unknown): void {
    const url = externalBrowserUrl(value)
    if (url && this.urls.length < 128) this.urls.push(url)
  }

  takeAll(): string[] { return this.urls.splice(0) }
}

export const browserLaunchQueue = new BrowserLaunchQueue()
