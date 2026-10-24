import type { BrowserWindow, WebContents } from 'electron'
import { IPC_CHANNELS } from '@shared/constants'
import { matchSidebarShortcutAction } from '@shared/sidebar-shortcut'

/** 只监听本窗口及其直接嵌入的网页，不注册操作系统全局快捷键。 */
export function registerSidebarShortcuts(owner: Pick<BrowserWindow, 'isDestroyed' | 'webContents'>): void {
  const attach = (source: WebContents): void => {
    source.on('before-input-event', (event, input) => {
      if (owner.isDestroyed() || owner.webContents.isDestroyed()) return
      const action = matchSidebarShortcutAction(input)
      if (!action) return
      // 阻止终端、网页和菜单再次处理同一按键，再由宿主路由导航。
      event.preventDefault()
      owner.webContents.send(IPC_CHANNELS.SIDEBAR_SHORTCUT, action)
    })
  }
  attach(owner.webContents)
  owner.webContents.on('did-attach-webview', (_event, guest) => attach(guest))
}
