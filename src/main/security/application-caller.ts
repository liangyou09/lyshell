import { randomUUID } from 'crypto'
import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import { OperationError, type CallContext } from '@shared/operation'

function documentUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw)
    url.hash = ''
    return url.href
  } catch { return undefined }
}

/** 只有 main 创建并登记的应用文档拥有主界面 API；普通 BrowserWindow 也不自动获权。 */
export class ApplicationCallerRegistry {
  private entries = new Map<number, { sender: WebContents; url: string; active: boolean }>()

  register(sender: WebContents, entryUrl: string): () => void {
    const url = documentUrl(entryUrl)
    if (!url) throw new Error('Invalid application entry URL')
    const entry = { sender, url, active: false }
    this.entries.set(sender.id, entry)
    const deactivate = (_event?: unknown, _url?: string, inPlace?: boolean, mainFrame?: boolean): void => {
      if (mainFrame !== false && !inPlace) entry.active = false
    }
    const activate = (): void => {
      entry.active = !sender.isDestroyed() && documentUrl(sender.getURL()) === url
    }
    const crashed = (): void => { entry.active = false }
    const revoke = (): void => {
      if (this.entries.get(sender.id) === entry) this.entries.delete(sender.id)
      sender.removeListener('did-start-navigation', deactivate)
      sender.removeListener('did-navigate', activate)
      sender.removeListener('did-finish-load', activate)
      sender.removeListener('render-process-gone', crashed)
      sender.removeListener('destroyed', revoke)
    }
    sender.on('did-start-navigation', deactivate)
    sender.on('did-navigate', activate)
    sender.on('did-finish-load', activate)
    sender.on('render-process-gone', crashed)
    sender.once('destroyed', revoke)
    return revoke
  }

  isTrusted(sender: WebContents): boolean {
    const entry = this.entries.get(sender.id)
    return !!entry && entry.sender === sender && entry.active && !sender.isDestroyed()
      && documentUrl(sender.getURL()) === entry.url
  }

  isPrincipalCurrent(principalId: string): boolean {
    const id = /^gui:(\d+)$/.exec(principalId)?.[1]
    const sender = id ? this.entries.get(Number(id))?.sender : undefined
    return !!sender && this.isTrusted(sender)
  }

  context(event: Pick<IpcMainEvent | IpcMainInvokeEvent, 'sender' | 'senderFrame'>): CallContext {
    if (!this.isTrusted(event.sender) || !event.senderFrame || event.senderFrame !== event.sender.mainFrame
      || documentUrl(event.senderFrame.url) !== this.entries.get(event.sender.id)?.url) {
      throw new OperationError('FORBIDDEN', 'This operation requires the current application window')
    }
    return { requestId: randomUUID(), principalId: `gui:${event.sender.id}`, source: 'gui', receivedAt: Date.now() }
  }
}

export const applicationCallers = new ApplicationCallerRegistry()
