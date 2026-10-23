import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { buildBrowserMenu, type BrowserMenuContext } from '@shared/browser-context-menu'

const mocks = vi.hoisted(() => ({ windows: [] as WindowStub[], options: [] as Record<string, unknown>[], nextId: 100 }))
class WindowStub extends EventEmitter {
  destroyed = false
  webContents = Object.assign(new EventEmitter(), { id: mocks.nextId++, mainFrame: {}, isDestroyed: () => this.destroyed, setWindowOpenHandler: vi.fn() })
  constructor(options: Record<string, unknown>) { super(); mocks.windows.push(this); mocks.options.push(options) }
  isDestroyed = () => this.destroyed
  show = vi.fn(() => this.emit('show'))
  focus = vi.fn()
  loadURL = vi.fn().mockResolvedValue(undefined)
  loadFile = vi.fn().mockResolvedValue(undefined)
  destroy = () => { this.destroyed = true; this.emit('closed') }
}
vi.mock('electron', () => ({ BrowserWindow: class { constructor(options: Record<string, unknown>) { return new WindowStub(options) } }, screen: {
  getCursorScreenPoint: () => ({ x: 1185, y: 780 }),
  getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 } })
} }))
import { browserMenuRequest, showBrowserContextMenu } from './context-menu-window'
const context: BrowserMenuContext = {
  locale: 'zh', theme: 'dark', pageUrl: 'https://example.com', canGoBack: false, canGoForward: false,
  linkUrl: 'https://example.com/docs', linkText: '文档', srcUrl: '', mediaType: 'none', hasImageContents: false,
  isEditable: false, isPassword: false, selectionText: '', canSearch: true,
  editFlags: { canUndo: false, canRedo: false, canCopy: false, canCut: false, canPaste: false, canSelectAll: false }
}
function opened() {
  const parent = Object.assign(new EventEmitter(), { isDestroyed: () => false })
  const action = vi.fn()
  const current = vi.fn(() => true)
  const close = showBrowserContextMenu(parent as unknown as BrowserWindow, buildBrowserMenu(context), new Map([['open-link', action], ['back', action]]), current)
  const win = mocks.windows.at(-1)!
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame } as unknown as IpcMainInvokeEvent
  return { parent, win, close, event, action, current }
}
beforeEach(() => { vi.clearAllMocks(); mocks.windows.length = 0; mocks.options.length = 0; vi.stubEnv('ELECTRON_RENDERER_URL', '') })
afterEach(() => { for (const win of mocks.windows) win.destroy(); vi.unstubAllEnvs() })
describe('网页菜单独立窗口', () => {
  it('在屏幕边缘向内定位，隔离 preload/session，不允许网站开窗', () => {
    const { win } = opened()
    const options = mocks.options[0]
    expect(Number(options.x) + Number(options.width)).toBeLessThanOrEqual(1200)
    expect(Number(options.y) + Number(options.height)).toBeLessThanOrEqual(800)
    expect(options).toMatchObject({ frame: false, show: false, skipTaskbar: true, webPreferences: { partition: 'browser-menus', sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false } })
    expect(win.webContents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: 'deny' })
  })
  it('只允许专属窗口的顶层框架读取模型和执行已启用操作', () => {
    const { event, win, action } = opened()
    expect(browserMenuRequest(event, { kind: 'get' })).toMatchObject({ locale: 'zh' })
    expect(browserMenuRequest({ ...event, senderFrame: {} } as IpcMainInvokeEvent, { kind: 'get' })).toBeNull()
    expect(browserMenuRequest({ ...event, sender: { id: 1 } } as IpcMainInvokeEvent, { kind: 'get' })).toBeNull()
    expect(browserMenuRequest(event, { kind: 'action', id: 'open-link' })).toBe(false)
    browserMenuRequest(event, { kind: 'ready' }); expect(win.show).toHaveBeenCalledOnce()
    expect(browserMenuRequest(event, { kind: 'action', id: 'back' })).toBe(false)
    expect(browserMenuRequest(event, { kind: 'action', id: 'open-link' })).toBe(true)
    expect(action).toHaveBeenCalledOnce(); expect(win.destroyed).toBe(true)
    expect(browserMenuRequest(event, { kind: 'action', id: 'open-link' })).toBeNull()
  })
  it('失焦关闭，来源失效后拒绝点击，关闭时清理父窗口监听', () => {
    const first = opened(); first.win.emit('blur')
    expect(first.win.destroyed).toBe(true)
    expect(first.parent.listenerCount('move')).toBe(0)
    const second = opened(); second.current.mockReturnValue(false)
    expect(browserMenuRequest(second.event, { kind: 'ready' })).toBeNull()
    expect(second.win.destroyed).toBe(true)
    expect(second.action).not.toHaveBeenCalled()
  })
  it('父窗口移动、隐藏时收起菜单', () => {
    const { parent, win } = opened(); parent.emit('move')
    expect(win.destroyed).toBe(true)
  })
})
