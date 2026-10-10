import type { Input } from 'electron'
import type { PluginDialogManager } from './view-dialogs'

interface DialogInputSource {
  readonly id: number
  on(event: 'before-input-event', listener: (event: { preventDefault(): void }, input: Pick<Input, 'type' | 'key'>) => void): unknown
}

/**
 * webview 内的按键不会冒泡到 renderer window。由 main 拦截 Esc，只取消当前
 * guest 对应的弹窗，通知发起方；destroyed 链路负责卸载 UI 和嵌套弹窗清理。
 */
export function setupPluginDialogInput(guest: DialogInputSource, dialogs: PluginDialogManager): void {
  guest.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'Escape') return
    const dialog = dialogs.getByDialogContentsId(guest.id)
    if (!dialog) return
    event.preventDefault()
    dialogs.cancel(dialog.dialogId, 'dialog-destroyed')
  })
}
