import { BrowserWindow, WebContentsView, session, webContents } from 'electron'
import type { WebContents } from 'electron'
import { WEBBAR_PARTITION } from '@shared/constants'
import { BROWSER_DEVTOOLS_PARTITION, BROWSER_DEVTOOLS_EVENT, type BrowserDevToolsRequest, type BrowserDevToolsBounds } from '@shared/browser-devtools'
import { matchWebTabShortcut } from '@shared/webtab-shortcut'

interface Inspector {
  owner: WebContents
  page: WebContents
  view: WebContentsView
  window: BrowserWindow
  close: () => void
}
const inspectors = new Map<number, Inspector>()

function layoutInspector(record: Inspector, bounds: BrowserDevToolsBounds | null): void {
  const { view, owner, window } = record
  if (!bounds) { view.setVisible(false); return }
  const zoom = owner.getZoomFactor()
  const [width, height] = window.getContentSize()
  const x = Math.max(0, Math.round(bounds.x * zoom))
  const y = Math.max(0, Math.round(bounds.y * zoom))
  const w = Math.min(width, Math.round((bounds.x + bounds.width) * zoom)) - x
  const h = Math.min(height, Math.round((bounds.y + bounds.height) * zoom)) - y
  if (w <= 0 || h <= 0) { view.setVisible(false); return }
  view.setBounds({ x, y, width: w, height: h })
  view.setVisible(true)
}

/** 原生子视图承载 DevTools；从未导航的 WebContents 才能正确建立 Chromium 调试连接。 */
export function browserDevToolsRequest(owner: WebContents, request: BrowserDevToolsRequest): { success: boolean; inspectorId?: number } {
  const current = inspectors.get(request.pageId)
  if (request.kind !== 'open') {
    if (!current || current.owner !== owner || current.view.webContents.id !== request.inspectorId) return { success: false }
    if (request.kind === 'close') current.close()
    else layoutInspector(current, request.bounds)
    return { success: true }
  }
  if (current && current.owner !== owner) return { success: false }
  current?.close()
  const page = webContents.fromId(request.pageId)
  const window = BrowserWindow.fromWebContents(owner)
  if (!page || !window || page.isDestroyed() || page.getType() !== 'webview' ||
    page.hostWebContents !== owner || page.session !== session.fromPartition(WEBBAR_PARTITION)) return { success: false }

  const view = new WebContentsView({ webPreferences: {
    partition: BROWSER_DEVTOOLS_PARTITION, sandbox: true, contextIsolation: true,
    nodeIntegration: false, webSecurity: true, devTools: false
  } })
  // Electron 的自定义前端会发 close，但 WebContents 的类型声明未列出该事件。
  const viewEvents: NodeJS.EventEmitter = view.webContents
  const notify = (kind: 'focus' | 'closed'): void => {
    if (!owner.isDestroyed()) owner.send(BROWSER_DEVTOOLS_EVENT, { kind, pageId: page.id, inspectorId: view.webContents.id })
  }
  const close = (): void => {
    if (inspectors.get(page.id) !== record) return
    inspectors.delete(page.id)
    page.removeListener('destroyed', close)
    owner.removeListener('destroyed', close)
    owner.removeListener('did-start-navigation', onOwnerNavigation)
    owner.removeListener('render-process-gone', close)
    viewEvents.removeListener('close', close)
    view.webContents.removeListener('destroyed', close)
    view.webContents.removeListener('render-process-gone', close)
    if (!page.isDestroyed()) page.closeDevTools()
    if (!window.isDestroyed()) window.contentView.removeChildView(view)
    if (!view.webContents.isDestroyed()) view.webContents.close()
    notify('closed')
  }
  const onOwnerNavigation = (_event: unknown, _url: string, isInPlace: boolean, isMainFrame: boolean): void => {
    if (isMainFrame && !isInPlace) close()
  }
  const record: Inspector = { owner, page, view, window, close }
  inspectors.set(page.id, record)
  page.once('destroyed', close)
  owner.once('destroyed', close)
  // 宿主刷新/崩溃时 WebContents 本身仍存活，但旧 DOM 已无法管理原生子视图。
  owner.on('did-start-navigation', onOwnerNavigation)
  owner.once('render-process-gone', close)
  // 自定义 DevTools 的关闭按钮只发 close，不会替调用方销毁承载视图。
  viewEvents.once('close', close)
  view.webContents.once('destroyed', close)
  view.webContents.once('render-process-gone', close)
  view.webContents.on('focus', () => notify('focus'))
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  view.webContents.on('will-navigate', event => event.preventDefault())
  view.webContents.on('will-redirect', event => event.preventDefault())
  view.webContents.on('before-input-event', (event, input) => {
    if (matchWebTabShortcut(input) !== 'toggle-devtools') return
    event.preventDefault()
    close()
  })
  try {
    window.contentView.addChildView(view)
    layoutInspector(record, request.bounds)
    if (page.isDevToolsOpened()) page.closeDevTools()
    page.setDevToolsWebContents(view.webContents)
    page.openDevTools({ mode: 'detach', activate: true })
    return { success: true, inspectorId: view.webContents.id }
  } catch {
    close()
    return { success: false }
  }
}
