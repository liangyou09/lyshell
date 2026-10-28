import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { registerTaskShelfShortcuts } from './task-shelf-shortcut'
vi.mock('./storage/task-shelf-repository', () => ({ taskShelfRepository: { getPreferences: () => ({ toggleShortcut: 'Ctrl+Shift+U', collectShortcut: 'Ctrl+Shift+S' }) } }))

describe('窗口与网页客体的保存区快捷键', () => {
  it('网页持有焦点时转发配置动作，未匹配按键留给网页', () => {
    const host = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: vi.fn() })
    registerTaskShelfShortcuts({ isDestroyed: () => false, webContents: host } as unknown as Parameters<typeof registerTaskShelfShortcuts>[0])
    const guest = new EventEmitter(), event = { preventDefault: vi.fn() }
    host.emit('did-attach-webview', {}, guest)
    guest.emit('before-input-event', event, { type: 'keyDown', key: 'u', control: true, shift: true })
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(host.send).toHaveBeenLastCalledWith('task-shelf:shortcut', 'toggle')
    guest.emit('before-input-event', event, { type: 'keyDown', key: 'j', control: true, shift: true })
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
  })
})
