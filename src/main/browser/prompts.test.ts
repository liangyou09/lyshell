import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { BROWSER_PROMPT_ACTION, BROWSER_PROMPT_GET } from '@shared/browser-prompt'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => unknown>(),
  created: [] as Array<{ window: unknown; options: Record<string, unknown> }>,
  load: vi.fn(), nextId: 200
}))
class WindowStub extends EventEmitter {
  destroyed = false
  shown = false
  bounds = { x: 100, y: 100, width: 520, height: 450 }
  webContents = Object.assign(new EventEmitter(), { id: mocks.nextId++, mainFrame: {}, isDestroyed: () => this.destroyed, setWindowOpenHandler: vi.fn(), send: vi.fn() })
  constructor(options: Record<string, unknown>) { super(); mocks.created.push({ window: this, options }) }
  isDestroyed = () => this.destroyed
  getBounds = () => this.bounds
  setBounds = (bounds: typeof this.bounds) => { this.bounds = bounds }
  showInactive = () => { this.shown = true }
  setPosition = vi.fn()
  setBackgroundColor = vi.fn()
  loadFile = mocks.load
  loadURL = mocks.load
  destroy = () => { this.destroyed = true; this.emit('closed') }
  static fromWebContents = () => Object.assign(new EventEmitter(), { isDestroyed: () => false, getBounds: () => ({ x: 0, y: 0, width: 900, height: 600 }) })
}
vi.mock('electron', () => ({
  BrowserWindow: WindowStub, screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 } }) },
  ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => mocks.handlers.set(name, handler), on: (name: string, handler: (...args: unknown[]) => unknown) => mocks.listeners.set(name, handler) }
}))
vi.mock('../storage/repository', () => ({ preferencesRepository: { get: () => 'zh' } }))
vi.mock('../ui-theme', () => ({ getRendererThemeMode: () => 'dark' }))

function guest() { return Object.assign(new EventEmitter(), { id: 1, hostWebContents: { id: 100 }, isDestroyed: () => false }) as unknown as Electron.WebContents }
const content = { kind: 'password' as const, origin: 'https://example.com', username: 'alice' }
function opened() {
  const win = mocks.created.at(-1)!.window as WindowStub
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame }
  const action = (raw: unknown, source = event) => mocks.handlers.get(BROWSER_PROMPT_ACTION)!(source, raw) as Promise<{ success: boolean; error?: string }>
  return { win, event, action }
}
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); mocks.handlers.clear(); mocks.listeners.clear(); mocks.created.length = 0; mocks.load.mockResolvedValue(undefined); vi.stubEnv('ELECTRON_RENDERER_URL', '') })
afterEach(() => { vi.unstubAllEnvs() })

describe('浏览器独立确认窗口', () => {
  it('隔离 preload 和 session；只有该确认页顶层框架能读内容和回答', async () => {
    const service = await import('./prompts')
    const confirm = vi.fn()
    const result = service.requestBrowserPrompt(guest(), content, { current: () => true, confirm })
    const { win, event, action } = opened()
    expect(mocks.created[0].options).toMatchObject({ modal: false, frame: false, show: false, width: 320, height: 204, x: 564, y: 64, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'browser-prompts' } })
    expect(mocks.handlers.get(BROWSER_PROMPT_GET)!(event)).toMatchObject({ content, locale: 'zh', theme: 'dark' })
    const foreign = { sender: { ...win.webContents, id: 1 }, senderFrame: win.webContents.mainFrame }
    expect(mocks.handlers.get(BROWSER_PROMPT_GET)!(foreign)).toBeNull()
    expect((await action({ kind: 'confirm' }, foreign)).success).toBe(false)
    expect((await action({ kind: 'confirm' }, { ...event, senderFrame: {} })).success).toBe(false)
    expect((await action({ kind: 'confirm' })).success).toBe(false)
    await action({ kind: 'ready' }); expect(win.shown).toBe(true)
    await action({ kind: 'confirm' })
    expect(confirm).toHaveBeenCalledOnce(); expect(await result).toBe(true); expect(win.destroyed).toBe(true)
    expect(mocks.handlers.get(BROWSER_PROMPT_GET)!(event)).toBeNull()
  })
  it('保存失败不关窗，保留重试；一次只执行一个保存操作', async () => {
    const service = await import('./prompts')
    const confirm = vi.fn().mockRejectedValueOnce(new Error('private details must not leave main')).mockResolvedValue(undefined)
    const result = service.requestBrowserPrompt(guest(), content, { current: () => true, confirm })
    const { win, action } = opened(); await action({ kind: 'ready' })
    expect(await action({ kind: 'confirm' })).toEqual({ success: false, error: 'saveFailed' })
    expect(win.destroyed).toBe(false)
    await action({ kind: 'confirm' }); expect(await result).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(2)
  })
  it('深浅色实时跟随所属主窗口，其他窗口不能改变提示卡主题', async () => {
    const service = await import('./prompts')
    const result = service.requestBrowserPrompt(guest(), content, { current: () => true, confirm: vi.fn() })
    const { win, event, action } = opened()
    const frame = {}
    const theme = mocks.listeners.get('ui:theme-mode')!
    theme({ sender: { id: 999, mainFrame: frame }, senderFrame: frame }, 'light')
    expect(win.setBackgroundColor).not.toHaveBeenCalled()
    theme({ sender: { id: 100, mainFrame: frame }, senderFrame: frame }, 'light')
    expect(win.setBackgroundColor).toHaveBeenCalledWith('#ffffff')
    expect(win.webContents.send).toHaveBeenCalledWith('browser:prompt:theme', 'light')
    expect(mocks.handlers.get(BROWSER_PROMPT_GET)!(event)).toMatchObject({ theme: 'light' })
    await action({ kind: 'cancel' }); expect(await result).toBe(false)
  })
  it('登录后的同源导航保留提示，换站才取消', async () => {
    const service = await import('./prompts')
    const wc = guest(); const confirm = vi.fn()
    const result = service.requestBrowserPrompt(wc, content, { current: () => true, confirm })
    const { win, action } = opened()
    wc.emit('did-start-navigation', {}, 'https://example.com/account', false, true)
    expect(win.destroyed).toBe(false)
    await action({ kind: 'ready' }); await action({ kind: 'confirm' })
    expect(await result).toBe(true); expect(confirm).toHaveBeenCalledOnce()
  })
  it.each(['navigation', 'destroyed', 'closed', 'cancel'])('%s 作为取消，绝不调用保存', async reason => {
    const service = await import('./prompts')
    const wc = guest(); const confirm = vi.fn()
    const result = service.requestBrowserPrompt(wc, content, { current: () => true, confirm })
    const { win, action } = opened()
    if (reason === 'navigation') wc.emit('did-start-navigation', {}, 'https://other.example', false, true)
    if (reason === 'destroyed') wc.emit('destroyed')
    if (reason === 'closed') win.destroy()
    if (reason === 'cancel') await action({ kind: 'cancel' })
    expect(await result).toBe(false); expect(confirm).not.toHaveBeenCalled()
  })
  it('不堆叠同一宿主的确认框，页面失效后拒绝确认', async () => {
    const service = await import('./prompts')
    let current = true
    const confirm = vi.fn()
    const wc = guest()
    const first = service.requestBrowserPrompt(wc, content, { current: () => current, confirm })
    expect(await service.requestBrowserPrompt(wc, content, { current: () => true, confirm })).toBe(false)
    const { action } = opened(); current = false
    expect((await action({ kind: 'confirm' })).success).toBe(false)
    expect(await first).toBe(false); expect(confirm).not.toHaveBeenCalled()
  })
  it('确认期间关闭来源会取消在途操作，完成回执不能复活弹窗', async () => {
    const service = await import('./prompts')
    const wc = guest(); let complete!: () => void
    const confirm = vi.fn(() => new Promise<void>(r => { complete = r }))
    const result = service.requestBrowserPrompt(wc, content, { current: () => true, confirm })
    const { action } = opened(); await action({ kind: 'ready' })
    const pending = action({ kind: 'confirm' })
    expect((await action({ kind: 'confirm' })).success).toBe(false)
    wc.emit('destroyed'); expect(await result).toBe(false)
    complete(); expect((await pending).success).toBe(false)
  })
})
