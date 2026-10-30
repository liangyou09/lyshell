import type { IpcMainInvokeEvent, WebContents, WebFrameMain } from 'electron'
import { applicationIpc } from '../ipc/application-ipc'
import { applicationCallers } from '../security/application-caller'
import { OperationError } from '@shared/operation'
import { BROWSER_HOST_CHANNEL, type BrowserHostResult } from '@shared/browser-host'
import { BrowserHostService, type BrowserHostOwner } from './browser-host'
import { createReadonlyViewPilotPort } from './readonly-view-pilot'
import { classifyReadonlyRequest } from './shelf-readonly-contract'
import { validateBrowserHostRequest } from './browser-host-validation'

interface OwnerDocument extends BrowserHostOwner { sender: WebContents; document: WebFrameMain; active: boolean }
/** 注册不启动宿主；默认关闭。只读试点的唯一新 IPC 入口。 */
export function registerBrowserHostIpc(): { shutdown: () => Promise<unknown> } {
  const documents = new WeakMap<WebContents, OwnerDocument>()
  const current = (owner: BrowserHostOwner): boolean => {
    const known = documents.get(owner.sender as WebContents)
    return !!known && known === owner && known.active && known.document === known.sender.mainFrame && applicationCallers.isTrusted(known.sender)
  }
  const service = new BrowserHostService({
    enabled: () => process.env.LYSHELL_READONLY_VIEW_PILOT === '1',
    isOwnerCurrent: current,
    create: createReadonlyViewPilotPort,
    validateUrl: url => classifyReadonlyRequest({ url, method: 'GET', resourceType: 'mainFrame' }).allowed
  })
  const ownerOf = (event: IpcMainInvokeEvent): OwnerDocument => {
    applicationCallers.context(event)
    let owner = documents.get(event.sender)
    if (!owner || !owner.active || owner.document !== event.senderFrame) {
      owner = { sender: event.sender, document: event.senderFrame!, active: true }
      documents.set(event.sender, owner)
      const captured = owner
      const revoke = () => {
        if (!captured.active) return
        captured.active = false
        event.sender.removeListener('did-start-navigation', navigation)
        event.sender.removeListener('render-process-gone', revoke)
        event.sender.removeListener('destroyed', revoke)
        void service.releaseOwner(event.sender).catch(() => undefined)
      }
      const navigation = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
        if (!inPlace && mainFrame !== false) revoke()
      }
      event.sender.on('did-start-navigation', navigation)
      event.sender.on('render-process-gone', revoke)
      event.sender.once('destroyed', revoke)
    }
    return owner
  }
  applicationIpc.handle(BROWSER_HOST_CHANNEL, async (event, raw): Promise<BrowserHostResult> => {
    try { return await service.request(ownerOf(event), validateBrowserHostRequest(raw)) }
    catch (error) {
      if (error instanceof OperationError) return { success: false, code: error.code, error: error.message, retryDisposition: error.retryDisposition }
      return { success: false, code: 'OUTCOME_UNKNOWN', error: 'The browser host operation could not be confirmed', retryDisposition: 'reconcile-first' }
    }
  })
  return { shutdown: () => service.shutdown() }
}
