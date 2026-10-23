import { EventEmitter } from 'events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContextMenuParams, WebContents } from 'electron'
import type { BrowserMenuAction } from '@shared/browser-context-menu'
import type { BrowserMenuWindowData } from '@shared/browser-menu-style'

const mocks = vi.hoisted(() => ({
  session: {}, parent: { isDestroyed: () => false }, locale: 'en', engine: 'bing',
  show: vi.fn(), write: vi.fn(), saveDialog: vi.fn(), close: vi.fn()
}))
vi.mock('electron', () => ({
  session: { fromPartition: () => mocks.session }, BrowserWindow: { fromWebContents: () => mocks.parent },
  clipboard: { writeText: mocks.write }, dialog: { showSaveDialog: mocks.saveDialog, showMessageBox: vi.fn() }
}))
vi.mock('../storage/repository', () => ({ preferencesRepository: { get: () => mocks.locale } }))
vi.mock('../ui-theme', () => ({ getRendererThemeMode: () => 'dark' }))
vi.mock('./service', () => ({ getBrowserSettings: () => ({ searchEngine: mocks.engine }) }))
vi.mock('./context-menu-window', () => ({ showBrowserContextMenu: mocks.show }))
import { setupBrowserContextMenu } from './context-menu'

function fixture() {
  const owner = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: vi.fn(),
    executeJavaScript: vi.fn().mockResolvedValue({ locale: 'zh-CN', palette: { surface: '#161b20' } }) })
  const guest = Object.assign(new EventEmitter(), {
    id: 12, hostWebContents: owner, session: mocks.session, getType: () => 'webview', isDestroyed: () => false,
    getURL: () => 'https://page.test/', getTitle: () => '文档', focus: vi.fn(),
    copyImageAt: vi.fn(), downloadURL: vi.fn(), inspectElement: vi.fn(), savePage: vi.fn().mockResolvedValue(undefined),
    cut: vi.fn(), copy: vi.fn(), paste: vi.fn(), selectAll: vi.fn(), undo: vi.fn(), redo: vi.fn(), reload: vi.fn(),
    navigationHistory: { canGoBack: () => true, canGoForward: () => false, goBack: vi.fn(), goForward: vi.fn() }
  })
  const inspect = vi.fn()
  setupBrowserContextMenu(guest as unknown as WebContents, inspect)
  const emit = async (patch: Partial<ContextMenuParams> = {}) => {
    guest.emit('context-menu', { preventDefault: vi.fn() }, {
      linkURL: '', linkText: '', srcURL: '', mediaType: 'none', hasImageContents: false,
      isEditable: false, formControlType: 'none', selectionText: '', x: 12, y: 34,
      editFlags: { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: true, canSelectAll: true }, ...patch
    })
    await new Promise(resolve => setImmediate(resolve))
  }
  return { guest, owner, emit, inspect }
}
function shown() {
  const args = mocks.show.mock.calls.at(-1)!
  return { data: args[1] as BrowserMenuWindowData, actions: args[2] as Map<BrowserMenuAction, () => void>, current: args[3] as () => boolean }
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.engine = 'bing'; mocks.show.mockReturnValue(mocks.close)
  mocks.saveDialog.mockResolvedValue({ canceled: false, filePath: 'D:/fixture/page.html' })
})

describe('网页右键菜单动作与来源', () => {
  it('优先采用宿主当前语言和配色，导航工具栏在链接上也保留', async () => {
    const { emit, owner } = fixture()
    await emit({ linkURL: 'https://example.com/', linkText: '示例' })
    expect(shown().data).toMatchObject({ locale: 'zh', palette: { surface: '#161b20' } })
    expect(shown().data.toolbar.map(item => item.id)).toEqual(['back', 'forward', 'reload'])
    expect(owner.executeJavaScript).toHaveBeenCalledOnce()
  })
  it('链接后台打开保留来源，链接保存进入现有下载管理', async () => {
    const { guest, owner, emit } = fixture()
    await emit({ linkURL: 'https://example.com/', linkText: '示例' })
    const { actions } = shown()
    actions.get('open-link')!()
    expect(owner.send).toHaveBeenCalledWith('web-tab:popup', { url: 'https://example.com/', sourceWebContentsId: 12, sourceUrl: 'https://page.test/', background: true })
    actions.get('copy-link-text')!(); expect(mocks.write).toHaveBeenCalledWith('示例')
    actions.get('save-link')!(); expect(guest.downloadURL).toHaveBeenCalledWith('https://example.com/')
  })
  it('图片操作保留原始落点，非法协议不会注册执行动作', async () => {
    const { guest, emit } = fixture()
    await emit({ mediaType: 'image', hasImageContents: true, srcURL: 'https://cdn.test/a.png' })
    shown().actions.get('copy-image')!(); expect(guest.copyImageAt).toHaveBeenCalledWith(12, 34)
    shown().actions.get('save-image')!(); expect(guest.downloadURL).toHaveBeenCalledWith('https://cdn.test/a.png')
    await emit({ mediaType: 'image', hasImageContents: true, srcURL: 'file:///secret.png' })
    expect(shown().actions.has('copy-image')).toBe(false)
    expect(shown().actions.has('save-image')).toBe(false)
  })
  it('编辑命令作用于 guest，密码字段没有剪切/复制动作', async () => {
    const { guest, emit } = fixture()
    await emit({ isEditable: true })
    shown().actions.get('undo')!(); expect(guest.undo).toHaveBeenCalledOnce()
    expect(shown().actions.has('redo')).toBe(false)
    await emit({ isEditable: true, formControlType: 'input-password', selectionText: 'private' })
    expect(shown().actions.has('copy')).toBe(false)
    expect(shown().actions.has('cut')).toBe(false)
    shown().actions.get('paste')!(); expect(guest.paste).toHaveBeenCalledOnce()
    expect(JSON.stringify(shown().data)).not.toContain('private')
  })
  it('搜索使用当前配置的引擎，所选文字只作为查询参数', async () => {
    const { owner, emit } = fixture()
    mocks.engine = 'google'
    await emit({ selectionText: 'example.com & 文本' })
    shown().actions.get('search-selection')!()
    expect(owner.send.mock.calls[0][1].url).toBe('https://www.google.com/search?q=example.com%20%26%20%E6%96%87%E6%9C%AC')
    mocks.engine = 'none'; await emit({ selectionText: '文本' })
    expect(shown().actions.has('search-selection')).toBe(false)
  })
  it('网页保存等待选择路径，来源已跳转时不能保存新文档', async () => {
    const { guest, emit } = fixture()
    await emit(); shown().actions.get('save-page')!()
    expect(mocks.saveDialog).toHaveBeenCalledOnce()
    await new Promise(resolve => setImmediate(resolve))
    expect(guest.savePage).toHaveBeenCalledWith('D:/fixture/page.html', 'HTMLComplete')
    let choose!: (value: unknown) => void
    mocks.saveDialog.mockImplementation(() => new Promise(resolve => { choose = resolve }))
    await emit(); shown().actions.get('save-page')!()
    guest.emit('did-start-navigation', {}, 'https://next.test/', false, true)
    choose({ canceled: false, filePath: 'D:/fixture/late.html' })
    await Promise.resolve(); await Promise.resolve()
    expect(guest.savePage).toHaveBeenCalledTimes(1)
  })
  it('检查复用内嵌工具回调', async () => {
    const { emit, inspect } = fixture()
    await emit(); shown().actions.get('inspect')!()
    expect(inspect).toHaveBeenCalledWith(12, 34)
  })
})

describe('网页菜单生命周期', () => {
  it('主导航/崩溃关闭浮层，使旧菜单动作失效', async () => {
    const { guest, emit } = fixture()
    await emit(); const previous = shown()
    guest.emit('did-start-navigation', {}, 'https://next.test/', false, true)
    expect(mocks.close).toHaveBeenCalledOnce(); expect(previous.current()).toBe(false)
    previous.actions.get('reload')!(); expect(guest.reload).not.toHaveBeenCalled()
    await emit(); guest.emit('render-process-gone')
    expect(shown().current()).toBe(false)
  })
  it('新菜单使旧操作失效，销毁时摘除监听', async () => {
    const { guest, owner, emit } = fixture()
    await emit(); const old = shown()
    await emit(); expect(old.current()).toBe(false)
    owner.emit('destroyed')
    expect(guest.listenerCount('context-menu')).toBe(0)
    expect(guest.listenerCount('did-start-navigation')).toBe(0)
  })
  it('异步读取外观期间导航，不得弹出迟到的菜单', async () => {
    const { guest, owner, emit } = fixture()
    let resolve!: (value: unknown) => void
    owner.executeJavaScript.mockImplementation(() => new Promise(done => { resolve = done }))
    await emit(); guest.emit('did-start-navigation', {}, 'https://next.test/', false, true)
    resolve({ locale: 'zh' }); await Promise.resolve(); await Promise.resolve()
    expect(mocks.show).not.toHaveBeenCalled()
  })
  it('重复安装不叠加，非浏览器 guest 不接管', () => {
    const { guest } = fixture()
    setupBrowserContextMenu(guest as unknown as WebContents)
    expect(guest.listenerCount('context-menu')).toBe(1)
    const other = Object.assign(new EventEmitter(), { isDestroyed: () => false, getType: () => 'webview', session: {} })
    setupBrowserContextMenu(other as unknown as WebContents)
    expect(other.listenerCount('context-menu')).toBe(0)
  })
})
