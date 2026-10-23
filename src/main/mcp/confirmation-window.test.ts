import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import type { McpConfirmationContent, McpConfirmationRequest } from '@shared/mcp-confirmation'

const mocks = vi.hoisted(() => ({ created: [] as Array<{ win: unknown; options: Record<string, unknown> }>, load: vi.fn(), copy: vi.fn(), nextId: 300 }))
class WindowStub extends EventEmitter {
  destroyed = false
  shown = false
  webContents = Object.assign(new EventEmitter(), { id: mocks.nextId++, mainFrame: {}, isDestroyed: () => this.destroyed, setWindowOpenHandler: vi.fn(), send: vi.fn() })
  constructor(options: Record<string, unknown>) { super(); mocks.created.push({ win: this, options }) }
  isDestroyed = () => this.destroyed
  getBounds = () => ({ x: 100, y: 100, width: 1000, height: 800 })
  show = () => { this.shown = true }
  focus = vi.fn()
  setBackgroundColor = vi.fn()
  loadFile = mocks.load
  loadURL = mocks.load
  destroy = () => { this.destroyed = true; this.emit('closed') }
}
vi.mock('electron', () => ({ BrowserWindow: WindowStub, clipboard: { writeText: mocks.copy }, screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 900 } }) } }))
vi.mock('../storage/repository', () => ({ preferencesRepository: { get: () => 'zh' } }))
vi.mock('../ui-theme', () => ({ getRendererThemeMode: () => 'light' }))
vi.mock('electron-log', () => ({ default: { warn: vi.fn() } }))
const content: McpConfirmationContent = { title: '确认命令', message: '是否允许？', operation: 'execute_command', source: 'MCP', targets: [{ name: 'server', type: 'ssh' }], contentKind: 'command', content: 'echo first\n' + 'x'.repeat(1000) + '\nreboot' }
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); mocks.created.length = 0; mocks.load.mockResolvedValue(undefined); vi.stubEnv('ELECTRON_RENDERER_URL', '') })
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs() })

async function setup() {
  const service = await import('./confirmation-window')
  const parent = new WindowStub({})
  mocks.created.length = 0
  service.setMcpConfirmationWindow(parent as unknown as Electron.BrowserWindow)
  const opened = () => {
    const win = mocks.created.at(-1)!.win as WindowStub
    const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame } as unknown as Electron.IpcMainInvokeEvent
    const request = (kind: McpConfirmationRequest['kind'], from = event) => service.mcpConfirmationRequest(from, { kind })
    return { win, event, request }
  }
  return { service, parent, opened }
}

describe('MCP 独立确认窗口', () => {
  it('完整保留长命令；隔离权限、复制与确认仅接受本窗口顶层页', async () => {
    const { service, opened } = await setup()
    const result = service.requestMcpConfirmation(content)
    await Promise.resolve()
    const { win, event, request } = opened()
    expect(mocks.created[0].options).toMatchObject({ modal: true, show: false, frame: false, backgroundColor: '#ffffff', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false, partition: 'mcp-confirmations' } })
    expect(request('get')).toMatchObject({ content: content.content, locale: 'zh', theme: 'light' })
    expect(request('get', { ...event, senderFrame: {} } as Electron.IpcMainInvokeEvent)).toBeNull()
    expect(request('allow', { ...event, sender: { ...win.webContents, id: 99 } } as unknown as Electron.IpcMainInvokeEvent)).toBeNull()
    expect(request('allow')).toBe(false)
    expect(request('copy')).toBe(false)
    expect(win.shown).toBe(false)
    expect(request('ready')).toBe(true); expect(win.shown).toBe(true)
    expect(request('copy')).toBe(true); expect(mocks.copy).toHaveBeenCalledWith(content.content)
    expect(request('allow')).toBe(true); expect(await result).toBe(true)
    expect(win.destroyed).toBe(true); expect(request('allow')).toBeNull()
  })
  it.each(['reject', 'close', 'parent', 'crash', 'stale'] as const)('%s 始终拒绝，回执不能复活请求', async reason => {
    const { service, parent, opened } = await setup()
    let current = true
    const result = service.requestMcpConfirmation(content, () => current)
    await Promise.resolve()
    const { win, request } = opened()
    request('ready')
    if (reason === 'reject') request('reject')
    if (reason === 'close') win.destroy()
    if (reason === 'parent') parent.destroy()
    if (reason === 'crash') win.webContents.emit('render-process-gone')
    if (reason === 'stale') { current = false; expect(request('allow')).toBe(false) }
    expect(await result).toBe(false); expect(request('allow')).toBeNull()
  })
  it('并发确认排队，旧父窗口关闭后排队请求不转移到新窗口', async () => {
    const { service, parent, opened } = await setup()
    const first = service.requestMcpConfirmation(content)
    const second = service.requestMcpConfirmation({ ...content, content: 'second' })
    await Promise.resolve()
    expect(mocks.created).toHaveLength(1)
    opened().request('reject'); parent.destroy()
    expect(await first).toBe(false)
    expect(await second).toBe(false)
    expect(mocks.created).toHaveLength(1)
  })
  it('主题实时更新；加载失败或未就绪超时拒绝', async () => {
    const { service, opened } = await setup()
    vi.useFakeTimers()
    const result = service.requestMcpConfirmation(content)
    await Promise.resolve()
    const { win, request } = opened()
    service.updateMcpConfirmationTheme('dark')
    expect(win.setBackgroundColor).toHaveBeenCalledWith('#20252b')
    expect(request('get')).toMatchObject({ theme: 'dark' })
    await vi.advanceTimersByTimeAsync(15000)
    expect(await result).toBe(false)
    mocks.load.mockRejectedValueOnce(new Error('load failed'))
    expect(await service.requestMcpConfirmation(content)).toBe(false)
  })
  it('仅接受白名单请求，不能从 renderer 指定内容或批准其他请求', async () => {
    const { validateMcpConfirmationRequest } = await import('../ipc/validation')
    for (const kind of ['get', 'ready', 'reject', 'allow', 'copy']) expect(validateMcpConfirmationRequest({ kind, content: 'injected', id: 'other' })).toEqual({ kind })
    for (const raw of [null, [], 'allow', { kind: 'execute' }, { kind: {} }]) expect(() => validateMcpConfirmationRequest(raw)).toThrow()
  })
})
