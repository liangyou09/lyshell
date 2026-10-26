// @vitest-environment jsdom
/**
 * WebPanel 浏览器模式交互回归 —— store 单测锁不住的「面板渲染层」行为：
 * 1) 地址栏编辑守卫：editing 期间的导航回写（redirect/SPA 跳转）不得冲掉输入；
 *    非编辑态则跟随导航同步（Chrome omnibox 语义）；
 * 2) Ctrl+L 聚焦请求令牌：请求先于挂载到达（侧栏收起/别的页签时切过来的
 *    竞态）与挂载后实时到达两条路径都消费，消费后归零防二次进页签误聚焦；
 * 3) Enter 提交读取输入框当前值，候选选择与普通输入共用导航；组合输入期间不触发。
 * 4) 重新激活页签时补读 canGoBack/canGoForward（onNav 只在活动态同步读
 *    IPC，后台停驻的导航靠这一步校正）；
 * 5) 写轮眼小窗（栏底迷你浏览器）：合法地址开眼挂载/非法走 notice/did-navigate
 *    落点回写/Esc 复位/升格开完整页签/关页回空态（webview 摘树销毁 guest、
 *    localStorage 存档清掉，再输入即全新首航）/Ctrl+点击历史行预览与行上
 *    「在小窗打开」按钮/dom-ready 门（webview
 *    方法面在 guest 挂载前调用会抛错 —— 真机曾炸于此，门开前不得调 loadURL/getURL）/
 *    dom-ready 后把 webContentsId 登记给主进程（小窗与完整页签共用 webbar
 *    partition 共享登录态，主进程快捷键转发凭登记排除小窗）/存档与高度防毒
 *    （畸形存档落空态、离谱高度夹到绝对上限）。主地址栏与小窗使用简洁输入框。
 * 7) 最近访问保持全局最近顺序，不按域名重排；历史重排不混淆 favicon。
 * 6) 小窗关闭/恢复（保活）：合卷不卸载 webview —— 同一元素留树（guest 存活）、
 *    src 恒冻结、恢复零重挂零重载，恢复轨出现；关闭态经 config 存档；存档
 *    关闭态起渲染即关（写门：读档未成功不写，默认 false 不冲掉存档的 true
 *    —— 防抖/卸载补写两条路都拦）；小窗关闭时 Ctrl+点击历史行 = 预览意图，
 *    顺手重开而非静默无反馈。
 *    jsdom 里 <webview> 是未知元素（名字无连字符，customElements 注册不了）——
 *    在其原型上补方法面（loadURL 等 mock），渲染后的元素即可被组件调用、被断言。
 * 完整页签的 webview 用注册表替身（jsdom 承载不了真实 guest），历史置空避开
 * favicon 代取（用例自带历史时走 electronAPI 桩）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, act, fireEvent, waitFor, within } from '@testing-library/react'
import type { WebviewTag } from 'electron'
import { usePaneStore } from '../../stores/pane-store'
import { useUiStore } from '../../stores/ui-store'
import { BROWSER_BOOKMARKS_KEY, useBrowserBookmarksStore } from '../../stores/browser-bookmarks-store'
import { registerWebview, unregisterWebview } from './web-tab-controls'
import type { OverlayPayload, WebTabNav } from '@shared/types'
import { WEBBAR_PARTITION } from '@shared/constants'
import WebPanel from './WebPanel'
import { useBrowserDownloadsStore } from '../../stores/browser-downloads-store'
import PaneTabBar from './PaneTabBar'
import '../../i18n'

const navOf = (patch: Partial<WebTabNav>): WebTabNav => ({
  url: 'https://example.com/',
  canGoBack: false,
  canGoForward: false,
  loading: false,
  ...patch
})

/** 单 pane + 活动 web 覆盖层 = WebPanel 进入浏览器模式的完整前置 */
const setupBrowserMode = (nav: WebTabNav = navOf({})): void => {
  usePaneStore.setState({
    layout: {
      root: {
        id: 'pane-1',
        type: 'leaf',
        sessions: [],
        activeSessionId: null,
        overlays: [{ id: 'web-1', kind: 'web', active: true, slot: null }]
      },
      activePaneId: 'pane-1'
    },
    overlayPayloads: {
      'web-1': { kind: 'web', url: 'https://example.com/', title: 'example', nav }
    } as Record<string, OverlayPayload>,
    webTabHistory: [],
    webTabTitles: {},
    webTabFavicons: {},
    draggingOverlayId: null,
    draggingSessionId: null,
    hiddenTabSessions: {}
  })
}

/** webview 替身：canGoBack/canGoForward 供激活补读，其余供控制层调用断言 */
const makeWebview = (): {
  loadURL: ReturnType<typeof vi.fn>
  goBack: ReturnType<typeof vi.fn>
  goForward: ReturnType<typeof vi.fn>
  reload: ReturnType<typeof vi.fn>
  reloadIgnoringCache: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  canGoBack: () => boolean
  canGoForward: () => boolean
} => ({
  loadURL: vi.fn(),
  goBack: vi.fn(),
  goForward: vi.fn(),
  reload: vi.fn(),
  reloadIgnoringCache: vi.fn(),
  stop: vi.fn(),
  canGoBack: () => true,
  canGoForward: () => false
})

/** 地址栏元素：地址输入显式提供 combobox 角色与主题化候选列表。
 *  小窗工具条还有第二个 combobox —— DOM 序在前的是主地址栏，在后的是小窗地址 */
const inputOf = (): HTMLInputElement => screen.getAllByRole('combobox')[0] as HTMLInputElement
const miniInputOf = (): HTMLInputElement => screen.getAllByRole('combobox')[1] as HTMLInputElement

/** jsdom 的 <webview> 原型桩 —— 未知元素拿不到真实 guest 方法面，这里补上
 *  mock（模块级一次性挂原型，逐例 mockClear 重置计数） */
const webviewProto = document.createElement('webview').constructor.prototype as Record<string, unknown>
if (!webviewProto['loadURL']) {
  webviewProto['loadURL'] = vi.fn()
  webviewProto['reload'] = vi.fn()
  webviewProto['reloadIgnoringCache'] = vi.fn()
  webviewProto['goBack'] = vi.fn()
  webviewProto['goForward'] = vi.fn()
  webviewProto['stop'] = vi.fn()
  webviewProto['getURL'] = vi.fn(() => '')
  webviewProto['canGoBack'] = vi.fn(() => false)
  webviewProto['canGoForward'] = vi.fn(() => false)
  // 小窗 dom-ready 后报给主进程的 webContentsId（真机取自 guest,桩给固定值,
  // 与 registerWebbarMini 桩断言配对 —— 快捷键转发排除判据的契约测试）
  webviewProto['getWebContentsId'] = vi.fn(() => 4242)
}
type MiniWebviewStub = HTMLUnknownElement & {
  loadURL: ReturnType<typeof vi.fn>
  reload: ReturnType<typeof vi.fn>
  reloadIgnoringCache: ReturnType<typeof vi.fn>
  goBack: ReturnType<typeof vi.fn>
  goForward: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  getURL: () => string
  canGoBack: () => boolean
  canGoForward: () => boolean
  getWebContentsId: () => number
}
const wvOf = (): MiniWebviewStub => document.querySelector('webview') as unknown as MiniWebviewStub

/** 唤起 dom-ready：真实 Electron 里 guest 挂载完成前 webview 方法面一律抛错，
 *  组件把元素调用门在 miniReady —— 桩不自动发，用例显式唤起 */
const fireDomReady = (): void => {
  act(() => { wvOf().dispatchEvent(new Event('dom-ready')) })
}

/** 当前 pane 的网页页签快照（overlays 数组序即页签条可见序）—— 断言「提交
 *  新地址 = 新开页签」而非就地替换，以及新页紧贴来源右侧 */
const webTabs = (): { ids: string[]; urls: string[]; activeId: string | null } => {
  const root = usePaneStore.getState().layout.root
  if (root.type !== 'leaf') throw new Error('Expected one pane')
  const payloads = usePaneStore.getState().overlayPayloads
  return {
    ids: root.overlays.map(o => o.id),
    urls: root.overlays.flatMap(o => {
      const payload = payloads[o.id]
      return payload?.kind === 'web' ? [payload.url] : []
    }),
    activeId: root.overlays.find(o => o.active)?.id ?? null
  }
}

/** 某个覆盖层的 payload URL（非 web 或已回收返回 undefined）—— 原页内容未变的判据 */
const webUrlOf = (id: string): string | undefined => {
  const payload = usePaneStore.getState().overlayPayloads[id]
  return payload?.kind === 'web' ? payload.url : undefined
}

beforeEach(() => {
  useBrowserDownloadsStore.setState({ downloads: [], downloadDirectory: '', loaded: false, error: false })
  useUiStore.setState({ webBarFocusRequest: 0 })
  useBrowserBookmarksStore.setState({ bookmarks: [] })
  localStorage.removeItem(BROWSER_BOOKMARKS_KEY)
  unregisterWebview('web-1')
  // 小窗恢复地址不跨用例带毒
  localStorage.removeItem('lyshell.webbarMini.url.v1')
  // 原型桩是全文件共享的 mock，逐例清计数（方法面全量清，防前例调用计数
  // 污染后续断言 —— getURL/canGoBack/canGoForward 同样是断言对象）
  for (const k of ['loadURL', 'reload', 'reloadIgnoringCache', 'goBack', 'goForward', 'stop', 'getURL', 'canGoBack', 'canGoForward', 'getWebContentsId'] as const) {
    (webviewProto[k] as ReturnType<typeof vi.fn>).mockClear()
  }
  // electronAPI 桩：带历史的用例会打 favicon 猜测（缺省会变未处理拒绝）；
  // 小窗高度对账/防抖打 getConfig/setConfig；dom-ready 后打 registerWebbarMini
  // （部分桩缺方法会让调用落地报错）
  window.electronAPI = {
    browserRequest: vi.fn(async () => ({ success: true, downloadSnapshot: { downloads: [], downloadDirectory: 'D:/BrowserDownloads' } })),
    fetchFavicon: vi.fn(async () => ({ success: false })),
    getConfig: vi.fn(async () => undefined),
    setConfig: vi.fn(async () => true),
    registerWebbarMini: vi.fn(async () => ({ success: true }))
  } as unknown as typeof window.electronAPI
})

afterEach(() => {
  cleanup()
  unregisterWebview('web-1')
})

describe('浏览器下载入口', () => {
  it('侧栏下载标签可用键盘进入，目录配置留在浏览器设置中', async () => {
    setupBrowserMode()
    render(<WebPanel />)
    const downloadTab = screen.getByRole('tab', { name: /Downloads/ })
    expect(screen.getByRole('tab', { selected: true }).id).toBe('web-list-tab-bookmarks')
    fireEvent.keyDown(screen.getByRole('tab', { selected: true }), { key: 'End' })
    expect(downloadTab.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(downloadTab)
    await waitFor(() => expect(window.electronAPI.browserRequest).toHaveBeenCalledWith({ kind: 'downloads' }))
    expect(screen.queryByText('D:/BrowserDownloads')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Change folder' })).toBeNull()
    fireEvent.keyDown(downloadTab, { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { selected: true }).id).toBe('web-list-tab-bookmarks')
  })
})

describe('网址收藏', () => {
  const renderWithWebTab = () => {
    const pane = usePaneStore.getState().layout.root
    if (pane.type !== 'leaf') throw new Error('Expected one pane')
    return render(<><PaneTabBar pane={pane} isTop /><WebPanel /></>)
  }

  it('主地址栏不再提供收藏入口', () => {
    setupBrowserMode()
    usePaneStore.setState({ layout: { root: { id: 'pane-1', type: 'leaf', sessions: [], activeSessionId: null, overlays: [] }, activePaneId: 'pane-1' }, overlayPayloads: {} })
    render(<WebPanel />)
    fireEvent.change(inputOf(), { target: { value: 'docs.example.com/guide' } })
    expect(screen.queryByRole('button', { name: 'Bookmark this URL' })).toBeNull()
    fireEvent.click(screen.getByTitle('Mini pane · More actions'))
    expect((screen.getByRole('menuitem', { name: 'Bookmark this URL' }) as HTMLButtonElement).disabled).toBe(true)
    expect(useBrowserBookmarksStore.getState().bookmarks).toEqual([])
    expect(Object.keys(usePaneStore.getState().overlayPayloads)).toHaveLength(0)
  })

  it('小窗星标收藏小窗实际地址，不误收活动页签地址', async () => {
    setupBrowserMode()
    localStorage.setItem('lyshell.webbarMini.url.v1', 'https://mini.example/preview')
    render(<WebPanel />)
    await waitFor(() => expect(document.querySelector('webview')).toBeTruthy())
    act(() => { wvOf().dispatchEvent(Object.assign(new Event('page-title-updated'), { title: '小窗预览文档' })) })
    fireEvent.click(screen.getByTitle('Mini pane · More actions'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Bookmark this URL' }))
    expect(useBrowserBookmarksStore.getState().bookmarks).toEqual([{ url: 'https://mini.example/preview', title: '小窗预览文档' }])
    fireEvent.click(screen.getByTitle('Mini pane · More actions'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove bookmark' }))
    expect(useBrowserBookmarksStore.getState().bookmarks).toEqual([])
  })

  it('收藏导航后的实际地址，保留标题；编辑地址栏不改变当前页收藏目标', () => {
    setupBrowserMode(navOf({ url: 'https://redirect.example/docs#intro' }))
    renderWithWebTab()
    fireEvent.change(inputOf(), { target: { value: 'https://draft.example/' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Bookmark this URL' })[0])
    expect(useBrowserBookmarksStore.getState().bookmarks).toEqual([{ url: 'https://redirect.example/docs#intro', title: 'example' }])
    expect(screen.getAllByRole('button', { name: 'Remove bookmark' })[0].getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('tab', { name: /Bookmarks/ }))
    const bookmark = within(screen.getByRole('tabpanel')).getByTitle('https://redirect.example/docs#intro')
    expect(bookmark.title).toBe('https://redirect.example/docs#intro')
    expect(bookmark.querySelector('.web-history-title')?.textContent).toBe('example')
    expect(bookmark.querySelector('.web-history-address')?.textContent).toBe('https://redirect.example/docs#intro')
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove bookmark' })[1])
    expect(useBrowserBookmarksStore.getState().bookmarks).toEqual([])
    expect(screen.getByText(/Click the star on a web tab/)).toBeTruthy()
  })

  it('从最近访问收藏，清空历史不删除收藏，并可打开页签或小窗', () => {
    setupBrowserMode()
    const url = 'https://saved.example/guide'
    usePaneStore.setState({ webTabHistory: [url] })
    render(<WebPanel />)
    fireEvent.click(screen.getByRole('tab', { name: /Recent/ }))
    const historyRow = screen.getByRole('button', { name: url }).parentElement!
    fireEvent.click(historyRow.querySelector<HTMLButtonElement>('[title="Bookmark this URL"]')!)
    fireEvent.click(screen.getByTitle('More actions'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear' }))
    expect(usePaneStore.getState().webTabHistory).toEqual([])
    fireEvent.click(screen.getByRole('tab', { name: /Bookmarks/ }))
    const saved = screen.getByTitle(url)
    expect(saved.title).toBe(url)
    fireEvent.click(saved, { ctrlKey: true })
    expect(miniInputOf().value).toBe(url)
    fireEvent.click(saved)
    expect(Object.values(usePaneStore.getState().overlayPayloads).some(item => item.kind === 'web' && item.url === url)).toBe(true)
    expect(useBrowserBookmarksStore.getState().bookmarks).toHaveLength(1)
    expect(JSON.parse(localStorage.getItem(BROWSER_BOOKMARKS_KEY)!)).toHaveLength(1)
  })

  it('收藏空态支持键盘切换，新标签页不能收藏', () => {
    setupBrowserMode()
    usePaneStore.setState({ overlayPayloads: { 'web-1': { kind: 'web', url: 'lyshell://new-tab', title: 'New tab' } } })
    renderWithWebTab()
    expect(screen.queryByRole('button', { name: 'Bookmark this URL' })).toBeNull()
    fireEvent.click(screen.getByTitle('Mini pane · More actions'))
    expect((screen.getByRole('menuitem', { name: 'Bookmark this URL' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    const recent = screen.getByRole('tab', { name: /Recent/ })
    fireEvent.keyDown(recent, { key: 'ArrowLeft' })
    const bookmarks = screen.getByRole('tab', { name: /Bookmarks/ })
    expect(document.activeElement).toBe(bookmarks)
    expect(bookmarks.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText(/Click the star on a web tab/)).toBeTruthy()
  })

  it('存储失败时显示提示，星标保持未收藏', () => {
    setupBrowserMode()
    renderWithWebTab()
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full') })
    try {
      fireEvent.click(screen.getAllByRole('button', { name: 'Bookmark this URL' })[0])
      expect(screen.getByRole('alert').textContent).toMatch(/Could not save bookmarks/)
      expect(screen.queryByRole('button', { name: 'Remove bookmark' })).toBeNull()
    } finally { write.mockRestore() }
  })
})

describe('小窗失败页', () => {
  it('证书确认入口使用小窗 guest ID 并在获准后重试失败地址', async () => {
    setupBrowserMode()
    const request = vi.fn().mockImplementation(async raw => raw.kind === 'certificateInfo' ? { success: true, certificate: { certificateId: 'actual-failure', subject: '', issuer: '', validFrom: '', validTo: '', fingerprint: '' } } : { success: true, certificateTrusted: true })
    localStorage.setItem('lyshell.webbarMini.url.v1', 'https://first.example/')
    render(<WebPanel visible />)
    await waitFor(() => expect(document.querySelector('webview')).toBeTruthy())
    window.electronAPI.browserRequest = request
    const el = wvOf()
    const url = 'https://10.5.20.36:8072/'
    act(() => { el.dispatchEvent(Object.assign(new Event('did-fail-load'), {
      isMainFrame: true, errorCode: -202, errorDescription: 'ERR_CERT_AUTHORITY_INVALID', validatedURL: url
    })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Advanced' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Proceed to/ })) })
    expect(request).toHaveBeenCalledWith({ kind: 'trustCertificate', guestId: 4242, url, certificateId: 'actual-failure' })
    expect(el.loadURL).toHaveBeenCalledWith(url)
  })

  it('主框架失败显示恢复入口，重试实际失败地址，加载成功收起提示', async () => {
    setupBrowserMode()
    localStorage.setItem('lyshell.webbarMini.url.v1', 'https://first.example/')
    render(<WebPanel />)
    await waitFor(() => expect(document.querySelector('webview')).toBeTruthy())
    const el = wvOf()
    act(() => {
      el.dispatchEvent(Object.assign(new Event('did-fail-load'), {
        isMainFrame: false, errorCode: -105
      }))
    })
    expect(screen.queryByRole('button', { name: 'Reload page' })).toBeNull()
    const failedUrl = 'http://localhost:8765/failed'
    act(() => {
      el.dispatchEvent(new CustomEvent('did-fail-load', { detail: {
        isMainFrame: true, errorCode: -102, errorDescription: 'ERR_CONNECTION_REFUSED', validatedURL: failedUrl
      } }))
      el.dispatchEvent(new Event('did-stop-loading'))
    })
    expect(screen.getByRole('status').textContent).toContain('service is running')
    fireEvent.click(screen.getByRole('button', { name: 'Reload page' }))
    expect(el.loadURL).toHaveBeenCalledWith(failedUrl)
    act(() => { el.dispatchEvent(new Event('did-start-loading')) })
    expect(screen.queryByRole('button', { name: 'Reload page' })).toBeNull()
    fireDomReady()
    expect(screen.queryByText('Loading…')).toBeNull()
  })
})

describe('插件聊天小窗回收', () => {
  it.each([
    ['http://127.0.0.1:31517/ui/chat/', true],
    ['https://example.com/', false]
  ] as const)('禁用时只销毁对应插件服务的小窗：%s', async (url, removed) => {
    setupBrowserMode()
    localStorage.setItem('lyshell.webbarMini.url.v1', url)
    const listeners = new Set<(id: string, origins?: string[]) => void>()
    window.electronAPI.onPluginResourcesReleased = listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }
    render(<WebPanel />)
    await waitFor(() => expect(document.querySelector('webview')).not.toBeNull())
    fireEvent.click(screen.getByTitle('Close mini browser'))
    expect(document.querySelector('webview')).not.toBeNull() // 合卷仍保活，禁用必须真正销毁。
    act(() => { for (const listener of listeners) listener('aipet', ['http://127.0.0.1:31517']) })
    expect(document.querySelector('webview') === null).toBe(removed)
    expect(localStorage.getItem('lyshell.webbarMini.url.v1')).toBe(removed ? null : url)
  })
})

describe('地址栏编辑守卫', () => {
  it('编辑中的导航回写不覆盖输入（redirect/SPA 跳转不打断打到一半的地址）', () => {
    setupBrowserMode()
    render(<WebPanel />)
    const input = inputOf()
    expect(input.value).toBe('https://example.com/')
    fireEvent.change(input, { target: { value: 'git' } })
    act(() => {
      usePaneStore.getState().setWebTabNav('web-1', { url: 'https://example.com/redirected' })
    })
    expect(input.value).toBe('git')
  })

  it('非编辑态跟随导航同步地址栏', () => {
    setupBrowserMode()
    render(<WebPanel />)
    const input = inputOf()
    act(() => {
      usePaneStore.getState().setWebTabNav('web-1', { url: 'https://example.com/page2' })
    })
    expect(input.value).toBe('https://example.com/page2')
  })

  it('浏览器模式 Esc 放弃编辑，复位为当前 URL 并失焦', () => {
    setupBrowserMode()
    render(<WebPanel />)
    const input = inputOf()
    fireEvent.change(input, { target: { value: 'git' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input.value).toBe('git')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input.value).toBe('https://example.com/')
    expect(document.activeElement).not.toBe(input)
  })
})

describe('主地址栏前往按钮', () => {
  it('空输入时禁用，点击按当前输入新开页签且不替换当前页', () => {
    setupBrowserMode()
    const page = makeWebview()
    registerWebview('web-1', page as unknown as WebviewTag)
    render(<WebPanel />)
    const input = inputOf()
    const go = screen.getByRole('button', { name: 'Go to address or search' }) as HTMLButtonElement
    expect(input.getAttribute('aria-autocomplete')).toBe('list')
    expect(input.hasAttribute('list')).toBe(false)
    fireEvent.change(input, { target: { value: '   ' } })
    expect(go.disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'https://edited.example/docs' } })
    expect(go.disabled).toBe(false)
    fireEvent.click(go)
    // 原页签不就地导航：guest 未被调用、payload URL 原样
    expect(page.loadURL).not.toHaveBeenCalled()
    expect(webUrlOf('web-1')).toBe('https://example.com/')
    // 新页签追加在原页签右侧，接管激活，地址栏跟随新页
    const tabs = webTabs()
    expect(tabs.urls).toEqual(['https://example.com/', 'https://edited.example/docs'])
    expect(tabs.ids[0]).toBe('web-1')
    expect(tabs.activeId).toBe(tabs.ids[1])
    expect(tabs.activeId).not.toBe('web-1')
    expect(input.value).toBe('https://edited.example/docs')
  })
})

describe('主地址栏提交一律新开网页页签', () => {
  it('没有活动网页时提交：在活动 pane 直接建页签，不报非法', () => {
    setupBrowserMode()
    usePaneStore.setState({
      layout: {
        root: { id: 'pane-1', type: 'leaf', sessions: [], activeSessionId: null, overlays: [] },
        activePaneId: 'pane-1'
      },
      overlayPayloads: {}
    })
    render(<WebPanel />)
    fireEvent.change(inputOf(), { target: { value: 'fresh.example/' } })
    fireEvent.keyDown(inputOf(), { key: 'Enter' })
    // 无 scheme 裸词走归一化补 https://（与浏览器地址栏同一入口）
    expect(webTabs().urls).toEqual(['https://fresh.example/'])
    expect(webTabs().activeId).toBe(webTabs().ids[0])
    expect(screen.queryByText('Invalid URL (http/https only)')).toBeNull()
  })

  it('活动页签不在末尾时，新页签紧贴活动页签右侧、其余页签顺序不变', () => {
    setupBrowserMode()
    const page = makeWebview()
    registerWebview('web-1', page as unknown as WebviewTag)
    const payloads = usePaneStore.getState().overlayPayloads
    usePaneStore.setState({
      layout: {
        root: {
          id: 'pane-1', type: 'leaf', sessions: [], activeSessionId: null,
          overlays: [
            { id: 'web-1', kind: 'web', active: true, slot: null },
            { id: 'web-2', kind: 'web', active: false, slot: null },
            { id: 'web-3', kind: 'web', active: false, slot: null }
          ]
        },
        activePaneId: 'pane-1'
      },
      overlayPayloads: {
        ...payloads,
        'web-2': { kind: 'web', url: 'https://two.example/', title: 'two.example' },
        'web-3': { kind: 'web', url: 'https://three.example/', title: 'three.example' }
      }
    })
    render(<WebPanel />)
    fireEvent.change(inputOf(), { target: { value: 'https://new.example/' } })
    fireEvent.keyDown(inputOf(), { key: 'Enter' })
    const tabs = webTabs()
    // 插在活动页签 web-1 之后，而不是追加到末尾
    expect(tabs.urls).toEqual([
      'https://example.com/', 'https://new.example/', 'https://two.example/', 'https://three.example/'
    ])
    expect(tabs.activeId).toBe(tabs.ids[1])
    expect(page.loadURL).not.toHaveBeenCalled()
  })

  it('非法地址只出 notice：既有页签不动、也不新开', () => {
    setupBrowserMode()
    const page = makeWebview()
    registerWebview('web-1', page as unknown as WebviewTag)
    render(<WebPanel />)
    // 'https://' 空 host 是真非法（裸词会被归一化成合法地址）
    fireEvent.change(inputOf(), { target: { value: 'https://' } })
    fireEvent.keyDown(inputOf(), { key: 'Enter' })
    expect(screen.getByText('Invalid URL (http/https only)')).toBeTruthy()
    expect(webTabs().ids).toEqual(['web-1'])
    expect(webUrlOf('web-1')).toBe('https://example.com/')
    expect(page.loadURL).not.toHaveBeenCalled()
  })

  it('组合输入（IME）期间回车不提交，不新开页签', () => {
    setupBrowserMode()
    const page = makeWebview()
    registerWebview('web-1', page as unknown as WebviewTag)
    render(<WebPanel />)
    fireEvent.change(inputOf(), { target: { value: 'https://ime.example/' } })
    fireEvent.keyDown(inputOf(), { key: 'Enter', isComposing: true })
    expect(webTabs().ids).toEqual(['web-1'])
    expect(page.loadURL).not.toHaveBeenCalled()
  })
})

describe('主题化网址候选列表', () => {
  const dropdown = (): HTMLElement => screen.getAllByRole('button', { name: 'Search suggestions, recent pages and bookmarks' })[0]
  it('合并最近访问和收藏并去重，键盘选择新开页签', () => {
    setupBrowserMode()
    const page = makeWebview()
    registerWebview('web-1', page as unknown as WebviewTag)
    const url = 'https://saved.example/guide'
    usePaneStore.setState({ webTabHistory: [url, 'https://recent.example/'] })
    useBrowserBookmarksStore.setState({ bookmarks: [{ url, title: 'Saved guide' }] })
    render(<WebPanel />)
    fireEvent.click(dropdown())
    expect(screen.getAllByRole('option')).toHaveLength(2)
    expect(screen.getByRole('listbox').parentElement?.parentElement).toBe(document.body)
    fireEvent.keyDown(inputOf(), { key: 'ArrowDown' })
    expect(inputOf().getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[0].id)
    fireEvent.keyDown(inputOf(), { key: 'Enter' })
    // 候选选择同样新开：原页签 guest 不动，新页签带候选 URL
    expect(page.loadURL).not.toHaveBeenCalled()
    expect(webUrlOf('web-1')).toBe('https://example.com/')
    const tabs = webTabs()
    expect(tabs.urls).toEqual(['https://example.com/', url])
    expect(tabs.activeId).toBe(tabs.ids[1])
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(inputOf().value).toBe(url)
  })

  it('按收藏名称过滤，Esc 只关闭候选，第二次 Esc 才放弃输入', () => {
    setupBrowserMode()
    useBrowserBookmarksStore.setState({ bookmarks: [{ url: 'https://saved.example/guide', title: 'Saved guide' }] })
    render(<WebPanel />)
    fireEvent.change(inputOf(), { target: { value: 'Saved' } })
    expect(screen.getAllByRole('option')).toHaveLength(2)
    fireEvent.keyDown(inputOf(), { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(inputOf().value).toBe('Saved')
    fireEvent.keyDown(inputOf(), { key: 'Escape' })
    expect(inputOf().value).toBe('https://example.com/')
  })

  it('外点和面板隐藏关闭浮层，恢复后不自行打开', () => {
    setupBrowserMode()
    usePaneStore.setState({ webTabHistory: ['https://recent.example/'] })
    const view = render(<WebPanel />)
    fireEvent.click(dropdown())
    expect(screen.getByRole('listbox')).toBeTruthy()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('listbox')).toBeNull()
    fireEvent.click(dropdown())
    view.rerender(<WebPanel visible={false} />)
    expect(screen.queryByRole('listbox')).toBeNull()
    view.rerender(<WebPanel visible />)
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('从小窗候选选择只在小窗打开，中文输入期间回车不导航', async () => {
    setupBrowserMode()
    const url = 'https://mini.example/docs'
    usePaneStore.setState({ webTabHistory: [url] })
    render(<WebPanel />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Search suggestions, recent pages and bookmarks' })[1])
    fireEvent.keyDown(miniInputOf(), { key: 'ArrowDown' })
    fireEvent.keyDown(miniInputOf(), { key: 'Enter', isComposing: true })
    expect(document.querySelector('webview')).toBeNull()
    fireEvent.click(screen.getByRole('option'))
    await waitFor(() => expect(document.querySelector('webview')?.getAttribute('src')).toBe(url))
    expect(Object.keys(usePaneStore.getState().overlayPayloads)).toEqual(['web-1'])
  })
})

describe('Ctrl+L 聚焦请求令牌（ui-store）', () => {
  it('请求先于挂载到达：挂载后消费，聚焦 + 全选 + 归零', () => {
    setupBrowserMode()
    useUiStore.getState().requestWebBarFocus()
    render(<WebPanel />)
    const input = inputOf()
    expect(document.activeElement).toBe(input)
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)
    expect(useUiStore.getState().webBarFocusRequest).toBe(0)
  })

  it('挂载后实时到达的请求同样消费', () => {
    setupBrowserMode()
    render(<WebPanel />)
    const input = inputOf()
    act(() => {
      useUiStore.getState().requestWebBarFocus()
    })
    expect(document.activeElement).toBe(input)
    expect(useUiStore.getState().webBarFocusRequest).toBe(0)
  })

  it('无请求挂载不偷焦点（普通进 Web 面板键盘留在原地）', () => {
    setupBrowserMode()
    render(<WebPanel />)
    const input = inputOf()
    expect(document.activeElement).not.toBe(input)
    expect(useUiStore.getState().webBarFocusRequest).toBe(0)
  })
})

describe('Enter 提交', () => {
  it('新页签使用输入框当前值，而非尚未同步的输入前缀', async () => {
    setupBrowserMode()
    const el = makeWebview()
    registerWebview('web-1', el as unknown as WebviewTag)
    render(<WebPanel />)
    // 先落定挂载期异步（小窗 config 对账会触发一次重渲染，插进 DOM 直写与
    // Enter 延迟读值之间会把受控值打回 state 前缀 —— 真机里对账远早于输入）
    await act(async () => {})
    const input = inputOf()
    // 输入前缀（React state 只知道这个）
    fireEvent.change(input, { target: { value: 'git' } })
    // 输入法或自动填充可能先更新 DOM，React state 尚未同步。
    input.value = 'https://github.com/'
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(webTabs().urls).toContain('https://github.com/'))
    expect(webTabs().urls).not.toContain('https://git/')
    // 原页签仍停在原地址，guest 未被导航
    expect(el.loadURL).not.toHaveBeenCalled()
    expect(webUrlOf('web-1')).toBe('https://example.com/')
  })
})

describe('激活补读', () => {
  it('重新激活页签时从元素补读前后可用性（停驻期间的旧值被校正）', () => {
    // 停驻残留：nav 里 canGoBack 还是 false；元素真值是 true（替身固定返回）
    setupBrowserMode(navOf({ canGoBack: false }))
    const el = makeWebview()
    registerWebview('web-1', el as unknown as WebviewTag)
    render(<WebPanel />)
    const payload = usePaneStore.getState().overlayPayloads['web-1']
    expect(payload?.kind === 'web' && payload.nav?.canGoBack).toBe(true)
  })
})

describe('写轮眼小窗（栏底迷你浏览器）', () => {
  it('恢复路径：存档即开眼挂载（src 已冻结），dom-ready 门生效期间不碰方法面（真机崩溃回归）', async () => {
    setupBrowserMode()
    localStorage.setItem('lyshell.webbarMini.url.v1', 'https://restored.example.com/')
    render(<WebPanel />)
    await waitFor(() => expect(document.querySelector('webview')).toBeTruthy())
    const wv = wvOf()
    expect(wv.getAttribute('src')).toBe('https://restored.example.com/')
    expect(miniInputOf().value).toBe('https://restored.example.com/')
    // 门的关键断言：挂载当拍(未 dom-ready)导航 effect 不得调 getURL/loadURL
    // —— 真机上这一拍调 getURL 就是用户报的那个 Uncaught Error
    expect(wv.loadURL).not.toHaveBeenCalled()
    fireDomReady()
    await waitFor(() => expect(wv.loadURL).toHaveBeenCalledWith('https://restored.example.com/'))
  })

  it('高度存档防毒：离谱超上限值经统一夹取收敛到绝对上限（4000）', async () => {
    setupBrowserMode()
    // config 被手改成 99999:clampMiniHeight 要把它夹到 MINI_ABS_MAX_HEIGHT,
    // 不夹会直接写成 99999px 的行内高度(恢复时面板未布局,rect 量不到上限)
    ;(window.electronAPI.getConfig as ReturnType<typeof vi.fn>).mockResolvedValue(99999)
    const { container } = render(<WebPanel />)
    await waitFor(() => {
      const mini = container.querySelector<HTMLElement>('div[style*="max-height"]')
      expect(mini).toBeTruthy()
      expect(mini?.style.height).toBe('4000px')
    })
  })

  it('存档防毒：https 前缀但畸形的值（空 host）拒收，落回未开眼空态', () => {
    setupBrowserMode()
    // 前缀对了但撑不起 new URL：恢复侧复用 normalizeWebBarUrl 校验，不得把它
    // 挂成注定失败的 src（修复前这里会照挂 webview，之后只能等失败反馈）
    localStorage.setItem('lyshell.webbarMini.url.v1', 'https://')
    const { container } = render(<WebPanel />)
    expect(container.querySelector('webview')).toBeNull()
    expect(screen.getByText('Mini browser')).toBeTruthy()
  })

  it('未开眼：空态指引不挂 webview，升格禁用', () => {
    setupBrowserMode()
    const { container } = render(<WebPanel />)
    expect(container.querySelector('webview')).toBeNull()
    expect(screen.getByText('Mini browser')).toBeTruthy()
    expect(screen.getByText("Type an address, or click a history row's mini button to open it here")).toBeTruthy()
    fireEvent.click(screen.getByTitle('Mini pane · More actions'))
    expect((screen.getByTitle('Promote to web tab') as HTMLButtonElement).disabled).toBe(true)
  })

  it('小窗地址：Esc 放弃编辑复位为当前页地址', () => {
    setupBrowserMode()
    localStorage.setItem('lyshell.webbarMini.url.v1', 'https://restored.example.com/')
    render(<WebPanel />)
    expect(miniInputOf().value).toBe('https://restored.example.com/')
    // 编辑中途失焦后，Esc 仍复位当前页面地址。
    fireEvent.focus(miniInputOf())
    fireEvent.change(miniInputOf(), { target: { value: 'https://editing.example.com/' } })
    fireEvent.blur(miniInputOf())
    fireEvent.keyDown(miniInputOf(), { key: 'Escape' })
    expect(miniInputOf().value).toBe('https://restored.example.com/')
  })

  it('小窗输入合法地址 → 开眼挂 webview（与完整页签共用 webbar partition 共享登录态，首航冻结为 src）', async () => {
    setupBrowserMode()
    render(<WebPanel />)
    fireEvent.change(miniInputOf(), { target: { value: 'https://example.com/' } })
    fireEvent.keyDown(miniInputOf(), { key: 'Enter' })
    await waitFor(() => expect(document.querySelector('webview')).toBeTruthy())
    const wv = wvOf()
    expect(wv.getAttribute('partition')).toBe(WEBBAR_PARTITION)
    // 首航地址定格为挂载 src（后续导航才走 loadURL）
    expect(wv.getAttribute('src')).toBe('https://example.com/')
    // dom-ready 前不碰方法面；唤起后导航 effect 落地（桩 getURL 恒空串 → 触发 loadURL）
    fireDomReady()
    await waitFor(() => expect(wv.loadURL).toHaveBeenCalledWith('https://example.com/'))
  })

  it('dom-ready 后把小窗 webContentsId 登记给主进程（快捷键转发的排除判据，门开前不登记）', async () => {
    setupBrowserMode()
    render(<WebPanel />)
    fireEvent.change(miniInputOf(), { target: { value: 'https://example.com/' } })
    fireEvent.keyDown(miniInputOf(), { key: 'Enter' })
    await waitFor(() => expect(document.querySelector('webview')).toBeTruthy())
    // 门的关键断言：dom-ready 前不碰方法面（getWebContentsId 同属方法面，真机
    // 上这一拍调用就是 Uncaught Error）
    expect((window.electronAPI.registerWebbarMini as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
    fireDomReady()
    await waitFor(() =>
      expect((window.electronAPI.registerWebbarMini as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(4242))
  })

  it('小窗移除刷新按钮，工具条 F5 只刷新小窗，加载时可停止', async () => {
    setupBrowserMode()
    const active = makeWebview()
    registerWebview('web-1', active as unknown as WebviewTag)
    render(<WebPanel />)
    fireEvent.change(miniInputOf(), { target: { value: 'https://mini.example/' } })
    fireEvent.keyDown(miniInputOf(), { key: 'Enter' })
    await waitFor(() => expect(document.querySelector('webview')).toBeTruthy())
    const mini = wvOf()
    expect(screen.queryByTitle('Reload')).toBeNull()
    fireEvent.keyDown(miniInputOf(), { key: 'F5' })
    expect(mini.reload).not.toHaveBeenCalled()
    fireDomReady()
    fireEvent.keyDown(miniInputOf(), { key: 'F5' })
    fireEvent.keyDown(miniInputOf(), { key: 'F5', shiftKey: true })
    expect(mini.reload).toHaveBeenCalledOnce()
    expect(mini.reloadIgnoringCache).toHaveBeenCalledOnce()
    expect(active.reload).not.toHaveBeenCalled()
    expect(active.reloadIgnoringCache).not.toHaveBeenCalled()
    expect(screen.getByTitle('Forward')).toBeTruthy()
    act(() => { mini.dispatchEvent(new Event('did-start-loading')) })
    expect(screen.queryByTitle('Forward')).toBeNull()
    fireEvent.click(screen.getByTitle('Stop loading'))
    expect(mini.stop).toHaveBeenCalledOnce()
    act(() => { mini.dispatchEvent(new Event('did-stop-loading')) })
    expect(screen.queryByTitle('Stop loading')).toBeNull()
    expect(screen.getByTitle('Forward')).toBeTruthy()
  })

  it('非法地址 → 面板公共 notice 通道，不开眼', async () => {
    setupBrowserMode()
    render(<WebPanel />)
    // 'https://' 空 host 才是真非法（裸词如 'git' 会被归一化成 https://git/）
    fireEvent.change(miniInputOf(), { target: { value: 'https://' } })
    fireEvent.keyDown(miniInputOf(), { key: 'Enter' })
    await waitFor(() => expect(screen.getByText('Invalid URL (http/https only)')).toBeTruthy())
    expect(document.querySelector('webview')).toBeNull()
  })

  it('did-navigate 落点回写工具条地址，Esc 复位为当前页', async () => {
    setupBrowserMode()
    render(<WebPanel />)
    fireEvent.change(miniInputOf(), { target: { value: 'https://example.com/' } })
    fireEvent.keyDown(miniInputOf(), { key: 'Enter' })
    await waitFor(() => expect(document.querySelector('webview')).toBeTruthy())
    fireDomReady()
    await waitFor(() => expect(wvOf().loadURL).toHaveBeenCalled())
    // redirect 落点：did-navigate 带最终地址（事件参数挂事件自身属性，Electron 28 同款）
    act(() => {
      wvOf().dispatchEvent(Object.assign(new Event('did-navigate'), { url: 'https://example.com/final', isMainFrame: true }))
    })
    await waitFor(() => expect(miniInputOf().value).toBe('https://example.com/final'))
    fireEvent.change(miniInputOf(), { target: { value: 'git' } })
    fireEvent.keyDown(miniInputOf(), { key: 'Escape' })
    expect(miniInputOf().value).toBe('git')
    fireEvent.keyDown(miniInputOf(), { key: 'Escape' })
    expect(miniInputOf().value).toBe('https://example.com/final')
  })

  it('小窗更多菜单支持键盘、Esc 返回焦点、外点及合卷关闭', async () => {
    setupBrowserMode()
    localStorage.setItem('lyshell.webbarMini.url.v1', 'https://mini.example/')
    render(<WebPanel />)
    await waitFor(() => expect(document.querySelector('webview')).toBeTruthy())
    const more = screen.getByTitle('Mini pane · More actions')
    expect(screen.queryByRole('menuitem', { name: 'Promote to web tab' })).toBeNull()
    fireEvent.click(more)
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Bookmark this URL' }))
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Promote to web tab' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(more.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(more)
    fireEvent.click(more)
    fireEvent.mouseDown(inputOf())
    expect(more.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(more)
    fireEvent.click(screen.getByTitle('Close mini browser'))
    expect(screen.queryByRole('menuitem', { name: 'Promote to web tab' })).toBeNull()
    expect(document.querySelector('webview')).toBeTruthy()
  })

  it('升格：以小窗当前页开完整网页页签（web 覆盖层 +1），小窗保留', async () => {
    setupBrowserMode()
    render(<WebPanel />)
    fireEvent.change(miniInputOf(), { target: { value: 'https://promote.example.com/' } })
    fireEvent.keyDown(miniInputOf(), { key: 'Enter' })
    await waitFor(() => expect(document.querySelector('webview')).toBeTruthy())
    fireEvent.click(screen.getByTitle('Mini pane · More actions'))
    fireEvent.click(screen.getByTitle('Promote to web tab'))
    const webs = Object.values(usePaneStore.getState().overlayPayloads).filter(p => p?.kind === 'web')
    expect(webs.length).toBe(2)  // 原有 web-1 + 升格新开
  })

  it('Ctrl+点击历史行 → 小窗预览，不开完整页签', async () => {
    setupBrowserMode()
    usePaneStore.setState({ webTabHistory: ['https://preview.example.org/'] })
    render(<WebPanel />)
    fireEvent.click(screen.getByRole('tab', { name: /Recent/ }))
    fireEvent.click(screen.getByText('https://preview.example.org/'), { ctrlKey: true })
    await waitFor(() => expect(document.querySelector('webview')).toBeTruthy())
    fireDomReady()
    await waitFor(() => expect(wvOf().loadURL).toHaveBeenCalledWith('https://preview.example.org/'))
    const webs = Object.values(usePaneStore.getState().overlayPayloads).filter(p => p?.kind === 'web')
    expect(webs.length).toBe(1)  // 没开新页签
  })

  it('历史行「在小窗打开」按钮 → 小窗预览不开完整页签（显式按钮，与 Ctrl+点击同走 loadMini）', async () => {
    setupBrowserMode()
    usePaneStore.setState({ webTabHistory: ['https://button.example.org/'] })
    render(<WebPanel />)
    fireEvent.click(screen.getByRole('tab', { name: /Recent/ }))
    // 显式入口:点行上的小窗按钮(此前只有 Ctrl+点击隐藏手势)
    fireEvent.click(screen.getByTitle('Open in mini browser'))
    await waitFor(() => expect(document.querySelector('webview')).toBeTruthy())
    fireDomReady()
    await waitFor(() => expect(wvOf().loadURL).toHaveBeenCalledWith('https://button.example.org/'))
    const webs = Object.values(usePaneStore.getState().overlayPayloads).filter(p => p?.kind === 'web')
    expect(webs.length).toBe(1)  // 没开新页签
  })

  it('最近访问保持全局最近顺序，同域网址不重排，重新访问后移到首行', () => {
    setupBrowserMode()
    const history = ['https://a.example.com/two', 'https://b.example.org/only', 'https://a.example.com/one', 'https://a.example.com:8443/port']
    usePaneStore.setState({ webTabHistory: history })
    render(<WebPanel />)
    fireEvent.click(screen.getByRole('tab', { name: /Recent/ }))
    const urls = (): string[] => Array.from(screen.getByRole('list', { name: 'Recent' }).querySelectorAll('li > button')).map(button => button.getAttribute('title')!)
    expect(urls()).toEqual(history)
    expect(screen.queryByRole('button', { name: 'Collapse all' })).toBeNull()
    act(() => usePaneStore.getState().recordWebTabVisit(history[2]))
    expect(urls()).toEqual([history[2], history[0], history[1], history[3]])
    const oldest = screen.getByTitle(history[3]).closest('li')!
    fireEvent.click(oldest.querySelector<HTMLButtonElement>('[title="Remove from recent"]')!)
    expect(urls()).toEqual([history[2], history[0], history[1]])
  })

  it('最近访问优先显示标题和辅助网址，旧记录显示可读字符，点击使用原始 URL', () => {
    setupBrowserMode()
    const titled = 'https://example.com/%E6%96%87%E6%A1%A3'
    const legacy = 'https://example.org/%E4%B8%AD%E6%96%87'
    usePaneStore.setState({ webTabHistory: [titled, legacy], webTabTitles: { [titled]: '项目使用指南' } })
    render(<WebPanel />)
    fireEvent.click(screen.getByRole('tab', { name: /Recent/ }))
    expect(screen.getByTitle(titled).querySelector('.web-history-title')?.textContent).toBe('项目使用指南')
    expect(screen.getByTitle(titled).querySelector('.web-history-address')?.textContent).toBe('https://example.com/文档')
    expect(screen.getByTitle(legacy).textContent).toBe('https://example.org/中文')
    fireEvent.click(screen.getByText('项目使用指南'))
    expect(Object.values(usePaneStore.getState().overlayPayloads).some(p => p.kind === 'web' && p.url === titled)).toBe(true)
  })

  it('小窗记录加载标题，并接收加载完成后的标题更新', async () => {
    setupBrowserMode()
    const url = 'https://mini.example/title'
    localStorage.setItem('lyshell.webbarMini.url.v1', url)
    render(<WebPanel />)
    await waitFor(() => expect(wvOf()).toBeTruthy())
    act(() => {
      wvOf().dispatchEvent(Object.assign(new Event('page-title-updated'), { title: '小窗标题' }))
      wvOf().dispatchEvent(new Event('did-finish-load'))
    })
    expect(usePaneStore.getState().webTabTitles[url]).toBe('小窗标题')
    act(() => { wvOf().dispatchEvent(Object.assign(new Event('page-title-updated'), { title: '动态新标题' })) })
    expect(usePaneStore.getState().webTabTitles[url]).toBe('动态新标题')
  })

  it('历史重排后 favicon 仍属于各自网址，缺图时显示通用图标', async () => {
    setupBrowserMode()
    const a = 'https://a.example.com/a', b = 'https://a.example.com/b'
    usePaneStore.setState({ webTabHistory: [a, b], webTabFavicons: { [a]: 'data:image/png;base64,AA==' } })
    render(<WebPanel />)
    fireEvent.click(screen.getByRole('tab', { name: /Recent/ }))
    await waitFor(() => expect(screen.getByTitle(a).querySelector('img')).toBeTruthy())
    expect(screen.getByTitle(b).querySelector('img')).toBeNull()
    expect(screen.getByTitle(b).querySelector('svg')).toBeTruthy()
    act(() => usePaneStore.setState({ webTabHistory: [b, a] }))
    expect(screen.getByRole('list', { name: 'Recent' }).firstElementChild).toBe(screen.getByTitle(b).closest('li'))
    expect(screen.getByTitle(b).querySelector('img')).toBeNull()
    expect(screen.getByTitle(a).querySelector('img')).toBeTruthy()
  })

  it('清空只在更多菜单提供：打开或取消菜单不清历史，选中清空才执行', () => {
    setupBrowserMode()
    render(<WebPanel />)
    fireEvent.click(screen.getByRole('tab', { name: /Recent/ }))
    expect(screen.queryByTitle('Clear')).toBeNull()
    const more = screen.getByTitle('More actions') as HTMLButtonElement
    expect(more.className).toContain('win-no-drag')
    expect(more.className).toContain('w-[28px]')
    fireEvent.click(more)
    expect((screen.getByRole('menuitem', { name: 'Clear' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    act(() => { usePaneStore.setState({ webTabHistory: ['https://a.example.com/one'] }) })
    fireEvent.click(more)
    expect(usePaneStore.getState().webTabHistory).toHaveLength(1)
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('menuitem', { name: 'Clear' })).toBeNull()
    expect(usePaneStore.getState().webTabHistory).toHaveLength(1)
    fireEvent.click(more)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(usePaneStore.getState().webTabHistory).toHaveLength(1)
    fireEvent.click(more)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear' }))
    expect(usePaneStore.getState().webTabHistory).toHaveLength(0)
    expect(screen.queryByRole('menuitem')).toBeNull()
  })

  it('导航簇保留后退/前进，移除刷新与检查按钮，加载时可停止', () => {
    setupBrowserMode()
    render(<WebPanel />)
    for (const title of ['Back (Alt+←)', 'Forward (Alt+→)']) {
      const btn = screen.getByTitle(title) as HTMLButtonElement
      expect(btn.className).toContain('win-no-drag')
      expect(btn.closest('.win-drag')).toBeTruthy()   // 所在行 = 铭牌拖拽区
      // 与清空钮保持相同操作面。
      expect(btn.className).toContain('w-[28px]')
    }
    // 前后可用性跟随导航快照，停止按钮只在加载时出现。
    expect((screen.getByTitle('Back (Alt+←)') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTitle('Forward (Alt+→)') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByTitle('Reload (F5)')).toBeNull()
    expect(screen.queryByTitle('Stop loading')).toBeNull()
    expect(screen.queryByTitle('Toggle DevTools (F12)')).toBeNull()
    const el = makeWebview()
    registerWebview('web-1', el as unknown as WebviewTag)
    act(() => { usePaneStore.getState().setWebTabNav('web-1', { loading: true }) })
    fireEvent.click(screen.getByTitle('Stop loading'))
    expect(el.stop).toHaveBeenCalledOnce()
    expect(el.reload).not.toHaveBeenCalled()
    act(() => { usePaneStore.getState().setWebTabNav('web-1', { loading: false }) })
    expect(screen.queryByTitle('Stop loading')).toBeNull()
  })

  it('更多菜单打开后聚焦操作，Esc 和执行清空后归还焦点', () => {
    setupBrowserMode()
    usePaneStore.setState({ webTabHistory: ['https://focus.example/'] })
    render(<WebPanel />)
    fireEvent.click(screen.getByRole('tab', { name: /Recent/ }))
    const more = screen.getByRole('button', { name: 'More actions' })
    more.focus()
    fireEvent.click(more)
    const clear = screen.getByRole('menuitem', { name: 'Clear' })
    expect(more.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('menu').id).toBe(more.getAttribute('aria-controls'))
    expect(document.activeElement).toBe(clear)
    fireEvent.keyDown(clear, { key: 'Escape' })
    expect(document.activeElement).toBe(more)
    expect(more.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(more)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear' }))
    expect(document.activeElement).toBe(more)
    expect(usePaneStore.getState().webTabHistory).toEqual([])
  })

  it('更多菜单随面板隐藏关闭，隐藏期间 Esc 不被消费，恢复后不自行重开', () => {
    setupBrowserMode()
    const view = render(<WebPanel visible />)
    fireEvent.click(screen.getByRole('tab', { name: /Recent/ }))
    fireEvent.click(screen.getByTitle('More actions'))
    expect(screen.getByRole('menuitem', { name: 'Clear' })).toBeTruthy()
    view.rerender(<WebPanel visible={false} />)
    const escaped = vi.fn()
    document.body.addEventListener('keydown', escaped)
    try {
      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(escaped).toHaveBeenCalledOnce()
    } finally {
      document.body.removeEventListener('keydown', escaped)
    }
    view.rerender(<WebPanel visible />)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByTitle('More actions').getAttribute('aria-expanded')).toBe('false')
  })

  it('切换到收藏列表后关闭最近访问菜单', () => {
    setupBrowserMode()
    render(<WebPanel />)
    fireEvent.click(screen.getByRole('tab', { name: /Recent/ }))
    fireEvent.click(screen.getByTitle('More actions'))
    fireEvent.click(screen.getByRole('tab', { name: /Bookmarks/ }))
    expect(screen.queryByRole('menuitem')).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: /Recent/ }))
    expect(screen.queryByRole('menuitem')).toBeNull()
  })

  it('窄栏菜单移除分组操作，清空和键盘导航仍可用', () => {
    // jsdom 无 ResizeObserver:桩一个捕获回调的类,手动喂根宽
    let fire: ResizeObserverCallback = () => {}
    class ROStub {
      constructor(cb: ResizeObserverCallback) { fire = cb }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', ROStub)
    try {
      const { container } = render(<WebPanel />)
      fireEvent.click(screen.getByRole('tab', { name: /Recent/ }))
      const root = container.firstElementChild as HTMLElement
      const rect = { width: 240, height: 800, top: 0, left: 0, bottom: 800, right: 240, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
      vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(rect)
      act(() => fire([], undefined as unknown as ResizeObserver))
      // 240 默认宽:次操作收进溢出菜单(「…」)，为题名留座。
      // 前后导航保留，刷新按钮不再出现。
      expect(screen.queryByTitle('Toggle DevTools (F12)')).toBeNull()
      expect(screen.queryByTitle('Clear')).toBeNull()
      expect(screen.getByTitle('More actions')).toBeTruthy()
      expect(screen.queryByTitle('Reload (F5)')).toBeNull()
      expect(screen.getByTitle('Back (Alt+←)')).toBeTruthy()
      expect(screen.getByTitle('Forward (Alt+→)')).toBeTruthy()
      // 无分组操作；单个清空项也支持循环键盘导航和焦点归还。
      act(() => { usePaneStore.setState({ webTabHistory: ['https://a.example.com/one'] }) })
      fireEvent.click(screen.getByTitle('More actions'))
      expect(screen.queryByRole('menuitem', { name: /Collapse|Expand/ })).toBeNull()
      const clearAction = screen.getByRole('menuitem', { name: 'Clear' })
      expect(document.activeElement).toBe(clearAction)
      for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
        fireEvent.keyDown(clearAction, { key })
        expect(document.activeElement).toBe(clearAction)
      }
      fireEvent.keyDown(clearAction, { key: 'Tab' })
      expect(screen.queryByRole('menu')).toBeNull()
      expect(document.activeElement).toBe(screen.getByTitle('More actions'))
      fireEvent.click(screen.getByTitle('More actions'))
      fireEvent.click(screen.getByText('Clear'))
      expect(usePaneStore.getState().webTabHistory.length).toBe(0)
      expect(screen.queryByText('Clear')).toBeNull()
      // 开着菜单拉宽:浮层卸载之外 open 复位 —— 不再占 useDismiss 的 ESC 回退栈
      fireEvent.click(screen.getByTitle('More actions'))
      expect(screen.getByText('Clear')).toBeTruthy()
      vi.mocked(root.getBoundingClientRect).mockReturnValue({ ...rect, width: 360, right: 360 } as DOMRect)
      act(() => fire([], undefined as unknown as ResizeObserver))
      // 全簇归位，清空仍留在更多菜单，菜单开态一并收口
      expect(screen.queryByTitle('Toggle DevTools (F12)')).toBeNull()
      expect(screen.queryByTitle('Clear')).toBeNull()
      expect(screen.getByTitle('More actions')).toBeTruthy()
      expect(screen.queryByText('Toggle DevTools (F12)')).toBeNull()
      // 再缩窄:菜单不自行重现(状态已复位),点触发钮才开
      vi.mocked(root.getBoundingClientRect).mockReturnValue(rect)
      act(() => fire([], undefined as unknown as ResizeObserver))
      expect(screen.queryByText('Clear')).toBeNull()
      fireEvent.click(screen.getByTitle('More actions'))
      expect(screen.getByText('Clear')).toBeTruthy()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('小窗关闭/恢复：webview 保活不摘树（同一元素），关闭态持久化', async () => {
    setupBrowserMode()
    localStorage.setItem('lyshell.webbarMini.url.v1', 'https://keep.example.com/')
    render(<WebPanel />)
    await waitFor(() => expect(document.querySelector('webview')).toBeTruthy())
    const mounted = document.querySelector('webview')
    fireEvent.click(screen.getByTitle('Close mini browser'))
    await waitFor(() => {
      // 保活:合卷不卸载,同一 webview 元素留树(guest 存活),纸收拢 + 恢复轨出现
      expect(document.querySelector('webview')).toBe(mounted)
      expect(screen.getByTitle('Restore mini browser')).toBeTruthy()
    })
    await waitFor(() => {
      expect(window.electronAPI.setConfig).toHaveBeenCalledWith('webMiniClosed', true)
    })
    fireEvent.click(screen.getByTitle('Restore mini browser'))
    // 恢复零重挂:还是同一元素,src 冻结纪律不变、首航地址原样
    expect(document.querySelector('webview')).toBe(mounted)
    expect(document.querySelector('webview')?.getAttribute('src')).toBe('https://keep.example.com/')
  })

  it('关闭页面：回空态摘 webview、清存档，再输入即全新首航', async () => {
    setupBrowserMode()
    localStorage.setItem('lyshell.webbarMini.url.v1', 'https://closeme.example.com/')
    render(<WebPanel />)
    await waitFor(() => expect(document.querySelector('webview')).toBeTruthy())
    fireEvent.click(screen.getByTitle('Mini pane · More actions'))
    fireEvent.click(screen.getByTitle('Close page (back to empty state, release mini page)'))
    // 未开眼空态:webview 摘树(guest 销毁)、空态指引出现
    await waitFor(() => expect(document.querySelector('webview')).toBeNull())
    expect(screen.getByTitle('Mini browser')).toBeTruthy()
    expect(miniInputOf().value).toBe('')
    // localStorage 存档一并清掉:冷启动不再恢复旧页
    expect(localStorage.getItem('lyshell.webbarMini.url.v1')).toBeNull()
    // 再输入 = 全新首航:未挂载期 src 跟随目标(与旧存档无关)
    fireEvent.change(miniInputOf(), { target: { value: 'https://fresh.example.com/' } })
    fireEvent.keyDown(miniInputOf(), { key: 'Enter' })
    await waitFor(() => expect(document.querySelector('webview')).toBeTruthy())
    expect(document.querySelector('webview')?.getAttribute('src')).toBe('https://fresh.example.com/')
  })

  it('存档关闭态起渲染即关（恢复轨、无关闭按钮），卸载补写真值不写默认 false', async () => {
    setupBrowserMode()
    // 存档 closed=true:挂载即关 —— 删掉 setMiniClosed(closed) 应用行会保持开态
    // (本用例即红),这是恢复路径此前的零覆盖断言
    ;(window.electronAPI.getConfig as ReturnType<typeof vi.fn>).mockImplementation(
      async (key: string) => key === 'webMiniClosed'
    )
    localStorage.setItem('lyshell.webbarMini.url.v1', 'https://saved.example.com/')
    const { container } = render(<WebPanel />)
    await waitFor(() => {
      expect(screen.getByTitle('Restore mini browser')).toBeTruthy()
      expect(screen.queryByTitle('Close mini browser')).toBeNull()
    })
    expect(container.querySelector('webview')).toBeNull()
    // 读档成功后写门已开:卸载补写真值 true(而非把默认 false 落盘冲掉存档)
    cleanup()
    const closedWrites = (window.electronAPI.setConfig as ReturnType<typeof vi.fn>).mock.calls
      .filter(c => c[0] === 'webMiniClosed')
    expect(closedWrites.length).toBeGreaterThan(0)
    expect(closedWrites[closedWrites.length - 1]).toEqual(['webMiniClosed', true])
  })

  it('写门：读档未落定即卸载（防抖 500ms 内切走页签），默认 false 不落盘冲掉存档', async () => {
    setupBrowserMode()
    // 模拟读档慢/失败:config 永不 resolve —— 修复前卸载补写会把默认 false
    // 写进档,存档的 true 被冲掉且无从恢复
    ;(window.electronAPI.getConfig as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise(() => {})
    )
    render(<WebPanel />)
    cleanup()
    const closedWrites = (window.electronAPI.setConfig as ReturnType<typeof vi.fn>).mock.calls
      .filter(c => c[0] === 'webMiniClosed')
    expect(closedWrites).toEqual([])
  })

  it('小窗关闭时 Ctrl+点击历史行 = 预览意图顺手重开，而非静默无反馈', async () => {
    setupBrowserMode()
    ;(window.electronAPI.getConfig as ReturnType<typeof vi.fn>).mockImplementation(
      async (key: string) => key === 'webMiniClosed'
    )
    usePaneStore.setState({ webTabHistory: ['https://preview.example.org/'] })
    render(<WebPanel />)
    fireEvent.click(screen.getByRole('tab', { name: /Recent/ }))
    await waitFor(() => expect(screen.getByTitle('Restore mini browser')).toBeTruthy())
    // 关闭态点历史行(修复前:URL 只落 state、webview 摘着树,点击像没点)
    fireEvent.click(screen.getByText('https://preview.example.org/'), { ctrlKey: true })
    await waitFor(() => expect(document.querySelector('webview')).toBeTruthy())
    expect(document.querySelector('webview')?.getAttribute('src')).toBe('https://preview.example.org/')
  })

  it('导航落点入档、src 恒冻结：关闭/恢复零重挂（保活，guest 原页保留）', async () => {
    setupBrowserMode()
    localStorage.setItem('lyshell.webbarMini.url.v1', 'https://first.example.com/')
    render(<WebPanel />)
    await waitFor(() => expect(document.querySelector('webview')).toBeTruthy())
    const mounted = document.querySelector('webview')
    // 真实导航：first → second（did-navigate 回写落点，同 redirect 后的真实地址）
    act(() => {
      wvOf().dispatchEvent(new CustomEvent('did-navigate', { detail: { url: 'https://second.example.com/', isMainFrame: true } }))
    })
    // 挂载元素 src 冻结纪律不变，落点入 localStorage 档
    expect(wvOf().getAttribute('src')).toBe('https://first.example.com/')
    await waitFor(() => expect(localStorage.getItem('lyshell.webbarMini.url.v1')).toBe('https://second.example.com/'))
    fireEvent.click(screen.getByTitle('Close mini browser'))
    // 合卷不卸载:元素与 src 原样留树(真机上 guest 页面状态由 guest 自己持有)
    expect(document.querySelector('webview')).toBe(mounted)
    expect(wvOf().getAttribute('src')).toBe('https://first.example.com/')
    fireEvent.click(screen.getByTitle('Restore mini browser'))
    // 恢复零重挂零重载:同一元素,地址栏跟随最后落点 second
    expect(document.querySelector('webview')).toBe(mounted)
    expect(miniInputOf().value).toBe('https://second.example.com/')
    expect(localStorage.getItem('lyshell.webbarMini.url.v1')).toBe('https://second.example.com/')
  })
})
