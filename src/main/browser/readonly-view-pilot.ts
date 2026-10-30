import { BrowserWindow, WebContentsView, session, type WebContents, type WebPreferences } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { OperationError } from '@shared/operation'
import { READONLY_PARTITION, applyReadonlyPreferences, classifyReadonlyRequest, initializeReadonlySession, isReadonlyGuest, readonlyProtection } from './shelf-readonly-contract'
import type { BrowserHostOwner, BrowserHostPort } from './browser-host'
import type { BrowserHostBounds } from '@shared/browser-host'

/** 试点只创建全新的内存态只读分区，不迁移账号或接管 shelf 实例。 */
export function createReadonlyViewPilotPort(owner: BrowserHostOwner): BrowserHostPort {
  const sender = owner.sender as WebContents
  const window = BrowserWindow.fromWebContents(sender)
  if (!window || window.isDestroyed() || window.webContents !== sender) throw new OperationError('FORBIDDEN', 'The readonly pilot requires its application window')
  const partition = READONLY_PARTITION + ':' + randomUUID()
  const readonlySession = session.fromPartition(partition, { cache: false })
  initializeReadonlySession(readonlySession)
  const preferences: WebPreferences = { session: readonlySession, partition, preload: join(__dirname, '../preload/shelfReadonly.js') }
  applyReadonlyPreferences(preferences)
  const view = new WebContentsView({ webPreferences: preferences })
  const page = view.webContents
  let attached = false
  view.setVisible(false)
  const allowed = (url: string) => classifyReadonlyRequest({ url, method: 'GET', resourceType: 'mainFrame' }).allowed
  page.setWindowOpenHandler(() => ({ action: 'deny' }))
  const denyNavigation = (event: Electron.Event, url: string) => { if (!allowed(url)) event.preventDefault() }
  page.on('will-navigate', denyNavigation)
  page.on('will-redirect', denyNavigation)
  const detached = () => !attached || window.isDestroyed() || !window.contentView.children.includes(view)
  const clampBounds = (bounds: BrowserHostBounds) => {
    if (window.isDestroyed()) throw new OperationError('STALE_GENERATION', 'The browser owner has closed')
    const [width, height] = window.getContentSize()
    const x = Math.min(width, bounds.x), y = Math.min(height, bounds.y)
    view.setBounds({ x, y, width: Math.min(bounds.width, width - x), height: Math.min(bounds.height, height - y) })
  }
  return {
    state: () => ({ url: page.getURL(), loading: page.isLoading(), canGoBack: page.navigationHistory.canGoBack(), canGoForward: page.navigationHistory.canGoForward(), visible: !detached() && view.getVisible(), bounds: view.getBounds(), protection: readonlyProtection(page).decision }),
    verified: () => page.session === readonlySession && isReadonlyGuest(page),
    destroyed: () => page.isDestroyed(),
    detached,
    attach: () => { if (window.isDestroyed()) throw new OperationError('STALE_GENERATION', 'The browser owner has closed'); if (detached()) window.contentView.addChildView(view); attached = true },
    detach: () => { view.setVisible(false); if (!window.isDestroyed()) window.contentView.removeChildView(view); if (window.isDestroyed() || !window.contentView.children.includes(view)) attached = false },
    navigate: url => page.loadURL(url),
    back: () => { if (page.navigationHistory.canGoBack()) page.navigationHistory.goBack() },
    forward: () => { if (page.navigationHistory.canGoForward()) page.navigationHistory.goForward() },
    reload: ignoreCache => { if (ignoreCache) page.reloadIgnoringCache(); else page.reload() },
    stop: () => page.stop(),
    focus: () => page.focus(),
    setBounds: clampBounds,
    setVisible: visible => { const bounds = view.getBounds(); view.setVisible(visible && !detached() && bounds.width > 0 && bounds.height > 0) },
    capture: async () => {
      // 首帧或导航后的 compositor 可能尚未给出可截图表面；只读采集最多重试一次。
      for (let attempt = 0; attempt < 2; attempt++) {
        if (page.isDestroyed()) throw new OperationError('STALE_GENERATION', 'The browser host closed before preview capture')
        try { return (await page.capturePage(undefined, { stayHidden: true })).toDataURL() }
        catch {
          if (attempt === 1) throw new OperationError('RESOURCE_LIMIT', 'The browser preview is not ready', 'safe')
          await new Promise(resolve => setTimeout(resolve, 150))
        }
      }
      throw new OperationError('RESOURCE_LIMIT', 'The browser preview is not ready', 'safe')
    },
    close: () => page.close({ waitForBeforeUnload: false }),
    subscribe: listener => {
      const changed = () => listener('changed')
      const crashed = () => { view.setVisible(false); listener('crashed') }
      const destroyed = () => listener('destroyed')
      page.on('did-navigate', changed); page.on('did-navigate-in-page', changed)
      page.on('did-start-loading', changed); page.on('did-stop-loading', changed)
      page.on('render-process-gone', crashed); page.on('preload-error', crashed)
      page.on('destroyed', destroyed)
      return () => {
        page.removeListener('did-navigate', changed); page.removeListener('did-navigate-in-page', changed)
        page.removeListener('did-start-loading', changed); page.removeListener('did-stop-loading', changed)
        page.removeListener('render-process-gone', crashed); page.removeListener('preload-error', crashed)
        page.removeListener('destroyed', destroyed)
        if (page.isDestroyed()) { page.removeListener('will-navigate', denyNavigation); page.removeListener('will-redirect', denyNavigation) }
      }
    }
  }
}
