import type { BrowserWindow, WebContents } from 'electron'
import { matchShelfShortcut } from '@shared/task-shelf'
import { taskShelfRepository } from './storage/task-shelf-repository'

/** 主窗口与直接网页客体共用配置；不注册系统全局热键。 */
export function registerTaskShelfShortcuts(owner: Pick<BrowserWindow, 'isDestroyed' | 'webContents'>): void {
  const attach = (source: WebContents): void => {
    source.on('before-input-event', (event, input) => {
      if (owner.isDestroyed() || owner.webContents.isDestroyed()) return
      try {
        const action = matchShelfShortcut(input, taskShelfRepository.getPreferences())
        if (!action) return
        event.preventDefault()
        owner.webContents.send('task-shelf:shortcut', action)
      } catch { /* 配置读取失败时不拦截用户按键 */ }
    })
  }
  attach(owner.webContents)
  owner.webContents.on('did-attach-webview', (_event, guest) => attach(guest))
}
