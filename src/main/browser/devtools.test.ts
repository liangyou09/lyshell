import { EventEmitter } from 'events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'

const mocks = vi.hoisted(() => ({
  browser: {}, contents: new Map<number, unknown>(), createContents: vi.fn(),
  views: [] as { webContents: WebContents; setBounds: ReturnType<typeof vi.fn>; setVisible: ReturnType<typeof vi.fn> }[],
  window: { isDestroyed: () => false, getContentSize: () => [1200, 800], contentView: { addChildView: vi.fn(), removeChildView: vi.fn() } }
}))
vi.mock('electron', () => ({
  session: { fromPartition: () => mocks.browser },
  webContents: { fromId: (id: number) => mocks.contents.get(id) },
  BrowserWindow: { fromWebContents: () => mocks.window },
  WebContentsView: class {
    webContents = mocks.createContents()
    setBounds = vi.fn()
    setVisible = vi.fn()
    constructor() { mocks.views.push(this) }
  }
}))
import { browserDevToolsRequest } from './devtools'

let nextId = 1
function guest(owner?: object) {
  const contents = Object.assign(new EventEmitter(), {
    id: nextId++, hostWebContents: owner, session: mocks.browser, isDestroyed: (): boolean => false,
    getType: () => 'webview', getZoomFactor: (): number => 1, send: vi.fn(),
    setWindowOpenHandler: vi.fn(), setDevToolsWebContents: vi.fn(),
    openDevTools: vi.fn(), closeDevTools: vi.fn(), isDevToolsOpened: () => false,
    close: vi.fn(() => {
      const event = { preventDefault: vi.fn() }
      contents.emit('close', event)
      if (!event.preventDefault.mock.calls.length) {
        contents.isDestroyed = () => true
        contents.emit('destroyed')
      }
    })
  })
  mocks.contents.set(contents.id, contents)
  return contents
}
const wc = (contents: object): WebContents => contents as WebContents
const bounds = { x: 200, y: 500, width: 900, height: 280 }
beforeEach(() => {
  mocks.views.length = 0
  mocks.createContents.mockImplementation(() => guest())
})

describe('内嵌 DevTools 归属、布局与清理', () => {
  it('全新的原生子视图直接绑定网页，不创建窗口；F12 关闭并销毁子视图', () => {
    const owner = guest()
    const page = guest(owner)
    expect(browserDevToolsRequest(wc(owner), { kind: 'open', pageId: page.id, bounds }).success).toBe(true)
    const view = mocks.views[0]
    expect(page.setDevToolsWebContents).toHaveBeenCalledWith(view.webContents)
    expect(page.openDevTools).toHaveBeenCalledWith({ mode: 'detach', activate: true })
    expect(view.setBounds).toHaveBeenCalledWith(bounds)
    const event = { preventDefault: vi.fn() }
    const input = { type: 'keyDown', key: 'F12', control: false, alt: false, shift: false, isAutoRepeat: false }
    view.webContents.emit('before-input-event', event, { ...input, control: true })
    expect(event.preventDefault).not.toHaveBeenCalled()
    view.webContents.emit('before-input-event', event, input)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(view.webContents.isDestroyed()).toBe(true)
    expect(page.closeDevTools).toHaveBeenCalledOnce()
    expect(owner.send).toHaveBeenCalledWith('web-tab:devtools-event', { kind: 'closed', pageId: page.id, inspectorId: view.webContents.id })
    expect(page.listenerCount('destroyed')).toBe(0)
  })

  it('拒绝未知、跨宿主和非网页会话的目标或控制请求', () => {
    const owner = guest()
    const page = guest(owner)
    expect(browserDevToolsRequest(wc(owner), { kind: 'open', pageId: -1, bounds }).success).toBe(false)
    expect(browserDevToolsRequest(wc(guest()), { kind: 'open', pageId: page.id, bounds }).success).toBe(false)
    page.session = {}
    expect(browserDevToolsRequest(wc(owner), { kind: 'open', pageId: page.id, bounds }).success).toBe(false)
    expect(mocks.views).toHaveLength(0)
    page.session = mocks.browser
    browserDevToolsRequest(wc(owner), { kind: 'open', pageId: page.id, bounds })
    const oldId = mocks.views[0].webContents.id
    expect(browserDevToolsRequest(wc(guest()), { kind: 'close', pageId: page.id, inspectorId: oldId }).success).toBe(false)
    expect(browserDevToolsRequest(wc(owner), { kind: 'open', pageId: page.id, bounds }).success).toBe(true)
    expect(browserDevToolsRequest(wc(owner), { kind: 'close', pageId: page.id, inspectorId: oldId }).success).toBe(false)
    browserDevToolsRequest(wc(owner), { kind: 'close', pageId: page.id, inspectorId: mocks.views[1].webContents.id })
  })

  it('页签隐藏、宿主缩放和销毁同步到子视图', () => {
    const owner = guest()
    const page = guest(owner)
    browserDevToolsRequest(wc(owner), { kind: 'open', pageId: page.id, bounds })
    const view = mocks.views[0]
    browserDevToolsRequest(wc(owner), { kind: 'layout', pageId: page.id, inspectorId: view.webContents.id, bounds: null })
    expect(view.setVisible).toHaveBeenLastCalledWith(false)
    owner.getZoomFactor = () => 2
    browserDevToolsRequest(wc(owner), { kind: 'layout', pageId: page.id, inspectorId: view.webContents.id, bounds: { x: 100, y: 100, width: 1000, height: 1000 } })
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 200, y: 200, width: 1000, height: 600 })
    expect(view.setVisible).toHaveBeenLastCalledWith(true)
    owner.emit('destroyed')
    expect(view.webContents.isDestroyed()).toBe(true)
  })

  it('DevTools 自身请求关闭时也销毁承载视图，且只通知一次', () => {
    const owner = guest()
    const page = guest(owner)
    browserDevToolsRequest(wc(owner), { kind: 'open', pageId: page.id, bounds })
    const view = mocks.views[0]
    view.webContents.emit('close', { preventDefault: vi.fn() })
    expect(view.webContents.isDestroyed()).toBe(true)
    expect(owner.send).toHaveBeenCalledTimes(1)
    expect(page.listenerCount('destroyed')).toBe(0)
    expect(owner.listenerCount('did-start-navigation')).toBe(0)
  })

  it('宿主只有主框架文档导航才释放视图，页内/子框架导航保留', () => {
    const owner = guest()
    const page = guest(owner)
    browserDevToolsRequest(wc(owner), { kind: 'open', pageId: page.id, bounds })
    const view = mocks.views[0]
    owner.emit('did-start-navigation', {}, 'https://example.com/#anchor', true, true)
    owner.emit('did-start-navigation', {}, 'https://example.com/frame', false, false)
    expect(view.webContents.isDestroyed()).toBe(false)
    owner.emit('did-start-navigation', {}, 'https://example.com/', false, true)
    expect(view.webContents.isDestroyed()).toBe(true)
    expect(owner.listenerCount('render-process-gone')).toBe(0)
  })

  it.each(['owner', 'inspector'])('%s 渲染进程崩溃后释放视图与监听器', target => {
    const owner = guest()
    const page = guest(owner)
    browserDevToolsRequest(wc(owner), { kind: 'open', pageId: page.id, bounds })
    const view = mocks.views[0]
    ;(target === 'owner' ? owner : view.webContents).emit('render-process-gone', {}, { reason: 'crashed' })
    expect(view.webContents.isDestroyed()).toBe(true)
    expect(page.listenerCount('destroyed')).toBe(0)
    expect(owner.listenerCount('destroyed')).toBe(0)
    expect(owner.listenerCount('did-start-navigation')).toBe(0)
  })
})
