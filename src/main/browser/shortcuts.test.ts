import { describe, expect, it, vi } from 'vitest'
import { handleBrowserShortcut } from './shortcuts'
import type { ShortcutInputShape } from '@shared/webtab-shortcut'

const input = (patch: Partial<ShortcutInputShape> = {}): ShortcutInputShape => ({
  type: 'keyDown', key: 'F5', control: false, alt: false, shift: false, isAutoRepeat: false, ...patch
})

describe('网页 guest 快捷键目标', () => {
  it('小窗 F5 和 Shift+F5 只刷新自身，不转发到完整页签', () => {
    const guest = { reload: vi.fn(), reloadIgnoringCache: vi.fn() }
    const event = { preventDefault: vi.fn() }
    const forward = vi.fn()
    handleBrowserShortcut(guest, event, input(), 'mini', forward)
    expect(guest.reload).toHaveBeenCalledOnce()
    handleBrowserShortcut(guest, event, input({ shift: true, type: 'rawKeyDown' }), 'mini', forward)
    expect(guest.reloadIgnoringCache).toHaveBeenCalledOnce()
    expect(event.preventDefault).toHaveBeenCalledTimes(2)
    expect(forward).not.toHaveBeenCalled()
  })

  it.each([{ key: 'F12' }, { key: 'l', control: true }, { control: true }, { isAutoRepeat: true }, { isComposing: true }])('小窗保留其他按键行为：%j', patch => {
    const guest = { reload: vi.fn(), reloadIgnoringCache: vi.fn() }
    const event = { preventDefault: vi.fn() }
    const forward = vi.fn()
    handleBrowserShortcut(guest, event, input(patch), 'mini', forward)
    expect(guest.reload).not.toHaveBeenCalled()
    expect(guest.reloadIgnoringCache).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(forward).not.toHaveBeenCalled()
  })

  it('完整页签继续转发，工作台仅转发查找', () => {
    const guest = { reload: vi.fn(), reloadIgnoringCache: vi.fn() }
    const event = { preventDefault: vi.fn() }
    const forward = vi.fn()
    handleBrowserShortcut(guest, event, input(), 'tab', forward)
    expect(forward).toHaveBeenCalledWith('reload')
    forward.mockClear()
    handleBrowserShortcut(guest, event, input(), 'dsh', forward)
    expect(forward).not.toHaveBeenCalled()
    handleBrowserShortcut(guest, event, input({ key: 'f', control: true }), 'dsh', forward)
    expect(forward).toHaveBeenCalledWith('find')
    expect(guest.reload).not.toHaveBeenCalled()
  })
})
