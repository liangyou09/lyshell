import { BrowserWindow, screen } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { join } from 'path'
import type { BrowserMenuAction, BrowserMenuRequest } from '@shared/browser-context-menu'
import type { BrowserMenuWindowData } from '@shared/browser-menu-style'

interface OpenMenu {
  window: BrowserWindow
  data: BrowserMenuWindowData
  ready: boolean
  current: () => boolean
  actions: Map<BrowserMenuAction, () => void>
  close: () => void
}
const menus = new Map<number, OpenMenu>()

/** 独立 sandbox 窗口专属 IPC；宿主、普通网页和子框架都不能执行菜单动作。 */
export function browserMenuRequest(event: IpcMainInvokeEvent, request: BrowserMenuRequest): BrowserMenuWindowData | boolean | null {
  const menu = menus.get(event.sender.id)
  if (!menu || event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame) return null
  if (request.kind === 'dismiss') { menu.close(); return true }
  if (!menu.current()) { menu.close(); return null }
  if (request.kind === 'get') return menu.data
  if (request.kind === 'ready') {
    menu.ready = true
    menu.window.show()
    menu.window.focus()
    return true
  }
  const item = [...menu.data.toolbar, ...menu.data.groups.flat()].find(value => value.id === request.id)
  const action = menu.actions.get(request.id)
  if (!menu.ready || !item?.enabled || !action) return false
  menu.close()
  action()
  return true
}

/** 原生子窗口覆盖 webview；位置限制在鼠标所在显示器，长菜单在窗口内部滚动。 */
export function showBrowserContextMenu(parent: BrowserWindow, data: BrowserMenuWindowData, actions: Map<BrowserMenuAction, () => void>, current: () => boolean): () => void {
  const point = screen.getCursorScreenPoint()
  const area = screen.getDisplayNearestPoint(point).workArea
  const width = Math.min(292, area.width)
  // 标题 60、导航 48、各操作 32、组间 13、外边距 16。
  const idealHeight = 124 + data.groups.reduce((sum, group) => sum + group.length * 32 + 13, 0)
  const height = Math.min(idealHeight, Math.max(160, area.height - 16))
  const x = Math.max(area.x, Math.min(point.x, area.x + area.width - width))
  const y = Math.max(area.y, Math.min(point.y, area.y + area.height - height))
  const win = new BrowserWindow({
    parent, show: false, width, height, x, y, frame: false, resizable: false,
    minimizable: false, maximizable: false, skipTaskbar: true, autoHideMenuBar: true,
    backgroundColor: data.theme === 'dark' ? '#161b20' : '#ffffff',
    title: data.locale === 'zh' ? 'LyShell · 网页菜单' : 'LyShell · Page menu',
    webPreferences: { preload: join(__dirname, '../preload/browserMenu.js'), partition: 'browser-menus',
      sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false }
  })
  const popupId = win.webContents.id
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    clearTimeout(timeout)
    menus.delete(popupId)
    parent.removeListener('move', close)
    parent.removeListener('resize', close)
    parent.removeListener('hide', close)
    if (!win.isDestroyed()) win.destroy()
  }
  const timeout = setTimeout(close, 10000)
  menus.set(popupId, { window: win, data, actions, current: () => !closed && !parent.isDestroyed() && current(), close, ready: false })
  win.once('show', () => clearTimeout(timeout))
  win.on('blur', close)
  win.once('closed', close)
  win.webContents.once('render-process-gone', close)
  win.webContents.on('will-navigate', event => event.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  parent.on('move', close)
  parent.on('resize', close)
  parent.on('hide', close)
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  const load = rendererUrl ? win.loadURL(new URL('browser-menu.html', rendererUrl.endsWith('/') ? rendererUrl : rendererUrl + '/').href) : win.loadFile(join(__dirname, '../renderer/browser-menu.html'))
  void load.catch(close)
  return close
}
