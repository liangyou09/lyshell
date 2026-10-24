import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { registerSidebarShortcuts } from './sidebar-shortcut'

function setup() {
  const host = Object.assign(new EventEmitter(), { isDestroyed: vi.fn(() => false), send: vi.fn() })
  const owner = { isDestroyed: vi.fn(() => false), webContents: host }
  registerSidebarShortcuts(owner as unknown as Parameters<typeof registerSidebarShortcuts>[0])
  const guest = Object.assign(new EventEmitter(), { send: vi.fn() })
  host.emit('did-attach-webview', {}, guest)
  return { host, owner, guest }
}

const input = { type: 'keyDown', key: '1', code: 'Digit1', alt: true }

describe('窗口内侧栏快捷键', () => {
  it('宿主输入焦点和嵌入网页均拦截一次，并只发送给所属宿主', () => {
    const { host, guest } = setup()
    for (const source of [host, guest]) {
      const event = { preventDefault: vi.fn() }
      source.emit('before-input-event', event, input)
      expect(event.preventDefault).toHaveBeenCalledOnce()
    }
    expect(host.send.mock.calls).toEqual([
      ['sidebar:shortcut', 'agents'], ['sidebar:shortcut', 'agents']
    ])
    expect(guest.send).not.toHaveBeenCalled()
  })

  it('宿主和网页的 Alt+反引号只发出一次开合动作，不触发数字导航', () => {
    const { host, guest } = setup()
    for (const source of [host, guest]) {
      const event = { preventDefault: vi.fn() }
      source.emit('before-input-event', event, { ...input, key: '`', code: 'Backquote' })
      expect(event.preventDefault).toHaveBeenCalledOnce()
    }
    expect(host.send.mock.calls).toEqual([
      ['sidebar:shortcut', 'toggle'], ['sidebar:shortcut', 'toggle']
    ])
    expect(guest.send).not.toHaveBeenCalled()
  })

  it('未嵌入此窗口的网页不会被监听或劫持', () => {
    const { host } = setup()
    const unrelated = new EventEmitter()
    const event = { preventDefault: vi.fn() }
    unrelated.emit('before-input-event', event, input)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(host.send).not.toHaveBeenCalled()
  })

  it.each([{ control: true }, { shift: true }, { meta: true }, { type: 'keyUp' }, { isComposing: true }])(
    '非导航事件不吞键：%j', patch => {
      const { host, guest } = setup()
      const event = { preventDefault: vi.fn() }
      guest.emit('before-input-event', event, { ...input, ...patch })
      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(host.send).not.toHaveBeenCalled()
    }
  )

  it.each(['window', 'contents'])('所属窗口销毁后不再发送（%s）', destroyed => {
    const { host, owner, guest } = setup()
    if (destroyed === 'window') owner.isDestroyed.mockReturnValue(true)
    else host.isDestroyed.mockReturnValue(true)
    const event = { preventDefault: vi.fn() }
    guest.emit('before-input-event', event, input)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(host.send).not.toHaveBeenCalled()
  })
})
