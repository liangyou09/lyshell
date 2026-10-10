import { EventEmitter } from 'events'
import { describe, expect, it, vi } from 'vitest'
import { PluginDialogManager } from './view-dialogs'
import { setupPluginDialogInput } from './view-dialog-input'

function setupDialog(guestId = 99) {
  const sendToGuest = vi.fn()
  const closeGuest = vi.fn()
  const dialogs = new PluginDialogManager({ sendToGuest, closeGuest })
  const guest = Object.assign(new EventEmitter(), { id: guestId })
  const attach = (id: number) => {
    const opts = { invokerContentsId: 11, pluginId: 'p1', viewId: 'dialog', entryPath: 'dialog.html', ownerWindowId: 7 }
    const record = dialogs.create(opts)
    dialogs.consumeForAttach(record.dialogId, opts)
    return dialogs.completeAttach(record.dialogId, id)!
  }
  const dialog = attach(guestId)
  setupPluginDialogInput(guest, dialogs)
  return { dialogs, guest, dialog, attach, sendToGuest, closeGuest }
}

describe('插件弹窗 guest 键盘关闭', () => {
  it('guest 获得焦点时 Esc 取消弹窗，只通知发起方，销毁回调不重复推送', () => {
    const { dialogs, guest, dialog, sendToGuest, closeGuest } = setupDialog()
    const event = { preventDefault: vi.fn() }
    guest.emit('before-input-event', event, { type: 'keyDown', key: 'Escape' })
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(dialogs.getAttached(dialog.dialogId)).toBeNull()
    expect(closeGuest).toHaveBeenCalledOnce()
    expect(closeGuest).toHaveBeenCalledWith(99)
    expect(sendToGuest).toHaveBeenCalledOnce()
    expect(sendToGuest).toHaveBeenCalledWith(11, {
      type: 'dialogCancelled', dialogId: dialog.dialogId, reason: 'dialog-destroyed'
    })
    dialogs.cancelByGuestDestroyed(99)
    guest.emit('before-input-event', event, { type: 'keyDown', key: 'Escape' })
    expect(sendToGuest).toHaveBeenCalledOnce()
    expect(closeGuest).toHaveBeenCalledOnce()
  })

  it('只关闭当前 guest 对应的弹窗，其他弹窗保留', () => {
    const { dialogs, guest, attach, closeGuest } = setupDialog()
    const other = attach(100)
    guest.emit('before-input-event', { preventDefault() {} }, { type: 'keyDown', key: 'Escape' })
    expect(dialogs.getAttached(other.dialogId)).not.toBeNull()
    expect(closeGuest).toHaveBeenCalledOnce()
    expect(closeGuest).toHaveBeenCalledWith(99)
    dialogs.clearAll()
  })

  it('其他按键和 keyUp 不取消弹窗，不拦截页面输入', () => {
    const { dialogs, guest, dialog, sendToGuest } = setupDialog()
    const event = { preventDefault: vi.fn() }
    guest.emit('before-input-event', event, { type: 'keyDown', key: 'Enter' })
    guest.emit('before-input-event', event, { type: 'keyUp', key: 'Escape' })
    expect(dialogs.getAttached(dialog.dialogId)).not.toBeNull()
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(sendToGuest).not.toHaveBeenCalled()
    dialogs.clearAll()
  })

  it('未登记的 guest 不影响已挂弹窗', () => {
    const { dialogs, dialog, closeGuest } = setupDialog()
    const guest = Object.assign(new EventEmitter(), { id: 101 })
    const event = { preventDefault: vi.fn() }
    setupPluginDialogInput(guest, dialogs)
    guest.emit('before-input-event', event, { type: 'keyDown', key: 'Escape' })
    expect(dialogs.getAttached(dialog.dialogId)).not.toBeNull()
    expect(closeGuest).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
    dialogs.clearAll()
  })
})
