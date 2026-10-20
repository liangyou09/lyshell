import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { DEFAULT_BROWSER_SETTINGS } from '@shared/browser-settings'

const mocks = vi.hoisted(() => ({
  setProxy: vi.fn(), close: vi.fn(), clearCache: vi.fn(), clearData: vi.fn(), write: vi.fn(),
  check: vi.fn(), request: vi.fn(), dialog: vi.fn(), find: vi.fn(), savePassword: vi.fn(),
  available: vi.fn(), list: vi.fn(),
  handlers: new Map<string, (...args: unknown[]) => unknown>(), listeners: new Map<string, (...args: unknown[]) => unknown>()
}))
const ses = vi.hoisted(() => ({
  on: vi.fn(),
  setProxy: mocks.setProxy, closeAllConnections: mocks.close, clearCache: mocks.clearCache,
  clearStorageData: mocks.clearData, setPermissionCheckHandler: mocks.check, setPermissionRequestHandler: mocks.request
}))
vi.mock('electron', () => ({
  session: { fromPartition: (partition: string) => { expect(partition).toBe('persist:webbar'); return ses } },
  webContents: { getAllWebContents: () => [] },
  BrowserWindow: { fromWebContents: () => null }, dialog: { showMessageBox: mocks.dialog },
  ipcMain: { handle: (name: string, fn: (...args: unknown[]) => unknown) => mocks.handlers.set(name, fn), on: (name: string, fn: (...args: unknown[]) => unknown) => mocks.listeners.set(name, fn) }
}))
vi.mock('fs', () => ({ existsSync: () => false, readFileSync: vi.fn() }))
vi.mock('../storage/repository', () => ({ getConfigDir: () => 'D:/fixture', atomicWriteFileSync: mocks.write, preferencesRepository: { get: () => 'en' } }))
vi.mock('./passwords', () => ({ BrowserPasswords: class {
  available = mocks.available
  find = mocks.find
  save = mocks.savePassword
  list = mocks.list
  delete = vi.fn()
} }))
vi.mock('./prompts', () => ({ initializeBrowserPrompts: vi.fn(), requestBrowserPrompt: async (_guest: unknown, content: unknown, options: { current: () => boolean; confirm: () => void }) => {
  const result = await mocks.dialog(content)
  if (result.response !== 1 || !options.current()) return false
  options.confirm()
  return true
} }))

function guest() {
  return Object.assign(new EventEmitter(), { id: 1, session: ses, mainFrame: { url: 'https://example.com/login' }, getURL: () => 'https://example.com/login', isDestroyed: () => false, getType: () => 'webview', setZoomFactor: vi.fn(), hostWebContents: null })
}
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); mocks.handlers.clear(); mocks.listeners.clear()
  mocks.setProxy.mockResolvedValue(undefined); mocks.close.mockResolvedValue(undefined)
  mocks.clearCache.mockResolvedValue(undefined); mocks.clearData.mockResolvedValue(undefined)
  mocks.dialog.mockResolvedValue({ response: 0 }); mocks.find.mockReturnValue(null)
  mocks.available.mockReturnValue(true); mocks.list.mockReturnValue([])
})

describe('浏览器主进程会话隔离', () => {
  it('代理失败后恢复旧代理，不落盘新设置', async () => {
    const service = await import('./service')
    await service.initializeBrowser()
    mocks.setProxy.mockRejectedValueOnce(new Error('fixture failure'))
    const result = await service.browserRequest({ kind: 'save', settings: { ...DEFAULT_BROWSER_SETTINGS, proxyMode: 'direct' } })
    expect(result.success).toBe(false)
    expect(mocks.setProxy).toHaveBeenLastCalledWith({ mode: 'system' })
    expect(mocks.write).not.toHaveBeenCalled()
    expect(service.getBrowserSettings().proxyMode).toBe('system')
  })
  it('磁盘写入失败回退已生效代理，缓存与站点数据清理分开', async () => {
    const service = await import('./service')
    await service.initializeBrowser()
    mocks.write.mockImplementationOnce(() => { throw new Error('disk failure') })
    expect((await service.browserRequest({ kind: 'save', settings: { ...DEFAULT_BROWSER_SETTINGS, proxyMode: 'direct' } })).success).toBe(false)
    expect(mocks.setProxy).toHaveBeenLastCalledWith({ mode: 'system' })
    await service.browserRequest({ kind: 'clear', target: 'cache' })
    expect(mocks.clearCache).toHaveBeenCalledOnce()
    expect(mocks.clearData).not.toHaveBeenCalled()
    await service.browserRequest({ kind: 'clear', target: 'siteData' })
    expect(mocks.clearData).toHaveBeenCalledOnce()
  })
  it('密码只交付给浏览器顶层 guest，按选定 ID 精确填充，其他会话与子框架不能读取', async () => {
    const service = await import('./service')
    await service.initializeBrowser()
    const fill = mocks.handlers.get('browser:password-fill')!
    const wc = guest()
    const id = 'account-1'
    mocks.find.mockReturnValue({ username: 'a', password: 'fixture' })
    expect(fill({ sender: wc, senderFrame: wc.mainFrame }, { kind: 'fill', id })).toEqual({ username: 'a', password: 'fixture' })
    expect(mocks.find).toHaveBeenCalledWith('https://example.com', id)
    expect(fill({ sender: wc, senderFrame: { url: wc.mainFrame.url } }, { kind: 'fill', id })).toBeNull()
    expect(fill({ sender: { ...wc, session: {} }, senderFrame: wc.mainFrame }, { kind: 'fill', id })).toBeNull()
    await service.browserRequest({ kind: 'save', settings: { ...DEFAULT_BROWSER_SETTINGS, savePasswords: false } })
    expect(fill({ sender: wc, senderFrame: wc.mainFrame }, { kind: 'fill', id })).toBeNull()
  })
  it('候选阶段只返回当前站点账号元数据，按最近使用排序，不触发解密', async () => {
    const service = await import('./service')
    await service.initializeBrowser()
    const fill = mocks.handlers.get('browser:password-fill')!
    const wc = guest()
    const now = Date.now()
    mocks.list.mockReturnValue([
      { id: 'old', origin: 'https://example.com', username: 'alice', updatedAt: now - 2000 },
      { id: 'foreign', origin: 'https://other.example', username: 'mallory', updatedAt: now },
      { id: 'recent', origin: 'https://example.com', username: 'bob', updatedAt: now - 1000 }
    ])
    expect(fill({ sender: wc, senderFrame: wc.mainFrame }, { kind: 'suggestions' })).toEqual([
      { id: 'recent', username: 'bob' },
      { id: 'old', username: 'alice' }
    ])
    expect(mocks.find).not.toHaveBeenCalled()
  })
  it('缺少或非法请求、非法 ID 一律拒绝且不解密', async () => {
    const service = await import('./service')
    await service.initializeBrowser()
    const fill = mocks.handlers.get('browser:password-fill')!
    const wc = guest()
    const ev = { sender: wc, senderFrame: wc.mainFrame }
    expect(fill(ev)).toBeNull()
    expect(fill(ev, null)).toBeNull()
    expect(fill(ev, 'nope')).toBeNull()
    expect(fill(ev, {})).toBeNull()
    expect(fill(ev, { kind: 'fill' })).toBeNull()
    expect(fill(ev, { kind: 'fill', id: '' })).toBeNull()
    expect(fill(ev, { kind: 'fill', id: 123 })).toBeNull()
    expect(fill(ev, { kind: 'fill', id: 'x'.repeat(129) })).toBeNull()
    expect(mocks.find).not.toHaveBeenCalled()
  })
  it('选定账号被删除或不存在时返回空', async () => {
    const service = await import('./service')
    await service.initializeBrowser()
    const fill = mocks.handlers.get('browser:password-fill')!
    const wc = guest()
    const ev = { sender: wc, senderFrame: wc.mainFrame }
    expect(fill(ev, { kind: 'fill', id: 'deleted' })).toBeNull()
    expect(mocks.find).toHaveBeenCalledWith('https://example.com', 'deleted')
  })
  it('关闭保存或系统加密不可用时候选与填充均不返回', async () => {
    const service = await import('./service')
    await service.initializeBrowser()
    const fill = mocks.handlers.get('browser:password-fill')!
    const wc = guest()
    const ev = { sender: wc, senderFrame: wc.mainFrame }
    await service.browserRequest({ kind: 'save', settings: { ...DEFAULT_BROWSER_SETTINGS, savePasswords: false } })
    expect(fill(ev, { kind: 'suggestions' })).toBeNull()
    expect(fill(ev, { kind: 'fill', id: 'x' })).toBeNull()
    await service.browserRequest({ kind: 'save', settings: { ...DEFAULT_BROWSER_SETTINGS, savePasswords: true } })
    mocks.available.mockReturnValue(false)
    expect(fill(ev, { kind: 'suggestions' })).toBeNull()
    expect(fill(ev, { kind: 'fill', id: 'x' })).toBeNull()
  })
  it('跨站权限请求直接拒绝，禁止项不弹确认框', async () => {
    const service = await import('./service')
    await service.initializeBrowser()
    const handler = mocks.request.mock.calls[0][0]
    const callback = vi.fn()
    handler(guest(), 'geolocation', callback, { requestingUrl: 'https://evil.example' })
    expect(callback).toHaveBeenCalledWith(false)
    await service.browserRequest({ kind: 'save', settings: { ...DEFAULT_BROWSER_SETTINGS, permissions: { ...DEFAULT_BROWSER_SETTINGS.permissions, camera: 'deny' } } })
    handler(guest(), 'media', callback, { requestingUrl: 'https://example.com', mediaTypes: ['video'] })
    expect(mocks.dialog).not.toHaveBeenCalled()
    expect(callback).toHaveBeenLastCalledWith(false)
  })
  it('保存密码按实际发送文档校验来源，换站竞态不把密码写到目标站', async () => {
    const service = await import('./service')
    await service.initializeBrowser()
    const wc = guest()
    const capture = mocks.listeners.get('browser:password-capture')!
    capture({ sender: wc, senderFrame: wc.mainFrame }, { origin: 'https://other.example', username: 'alice', password: 'fixture-secret' })
    expect(mocks.dialog).not.toHaveBeenCalled()
    mocks.dialog.mockResolvedValueOnce({ response: 1 })
    capture({ sender: wc, senderFrame: wc.mainFrame }, { origin: 'https://example.com', username: 'alice', password: 'fixture-secret' })
    await new Promise(r => setTimeout(r, 0))
    expect(mocks.savePassword).toHaveBeenCalledWith('https://example.com', 'alice', 'fixture-secret')
    const options = mocks.dialog.mock.calls[0][0]
    expect(JSON.stringify(options)).not.toContain('fixture-secret')
    expect(options).toEqual({ kind: 'password', origin: 'https://example.com', username: 'alice' })
  })
  it('同源换页也让旧权限确认失效', async () => {
    const service = await import('./service')
    await service.initializeBrowser()
    const wc = guest(); service.setupBrowserGuest(wc as unknown as Electron.WebContents)
    let resolve!: (result: { response: number }) => void
    mocks.dialog.mockImplementationOnce(() => new Promise(r => { resolve = r }))
    const callback = vi.fn()
    mocks.request.mock.calls[0][0](wc, 'geolocation', callback, { requestingUrl: 'https://example.com' })
    wc.emit('did-start-navigation', {}, wc.getURL(), false, true)
    resolve({ response: 1 })
    await new Promise(r => setTimeout(r, 0))
    expect(callback).toHaveBeenCalledWith(false)
  })
})
