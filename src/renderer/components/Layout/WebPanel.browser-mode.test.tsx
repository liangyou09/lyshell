// @vitest-environment jsdom
/**
 * WebPanel 浏览器模式交互回归 —— store 单测锁不住的「面板渲染层」行为：
 * 1) 地址栏编辑守卫：editing 期间的导航回写（redirect/SPA 跳转）不得冲掉输入；
 *    非编辑态则跟随导航同步（Chrome omnibox 语义）；
 * 2) Ctrl+L 聚焦请求令牌：请求先于挂载到达（侧栏收起/别的页签时切过来的
 *    竞态）与挂载后实时到达两条路径都消费，消费后归零防二次进页签误聚焦；
 * 3) Enter 的 datalist 提交竞态：高亮项的补全是 Enter 的默认动作（晚于
 *    keydown），导航必须吃 DOM 已提交值而非 React state 里的输入前缀；
 * 4) 重新激活页签时补读 canGoBack/canGoForward（onNav 只在活动态同步读
 *    IPC，后台停驻的导航靠这一步校正）；
 * 5) 写轮眼小窗（栏底迷你浏览器）：合法地址开眼挂载/非法走 notice/did-navigate
 *    落点回写/Esc 复位/升格开完整页签/Ctrl+点击历史行预览/dom-ready 门（webview
 *    方法面在 guest 挂载前调用会抛错 —— 真机曾炸于此，门开前不得调 loadURL/getURL）/
 *    存档与高度防毒（畸形存档落空态、离谱高度夹到绝对上限）。
 *    jsdom 里 <webview> 是未知元素（名字无连字符，customElements 注册不了）——
 *    在其原型上补方法面（loadURL 等 mock），渲染后的元素即可被组件调用、被断言。
 * 完整页签的 webview 用注册表替身（jsdom 承载不了真实 guest），历史置空避开
 * favicon 代取（用例自带历史时走 electronAPI 桩）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, act, fireEvent, waitFor } from '@testing-library/react'
import type { WebviewTag } from 'electron'
import { usePaneStore } from '../../stores/pane-store'
import { useUiStore } from '../../stores/ui-store'
import { registerWebview, unregisterWebview } from './web-tab-controls'
import type { OverlayPayload, WebTabNav } from '@shared/types'
import WebPanel from './WebPanel'
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

/** 地址栏元素：带 list 属性的 input 在可访问树中是 combobox 角色（非 textbox）。
 *  小窗工具条还有第二个 combobox —— DOM 序在前的是主地址栏，在后的是小窗地址 */
const inputOf = (): HTMLInputElement => screen.getAllByRole('combobox')[0] as HTMLInputElement
const miniInputOf = (): HTMLInputElement => screen.getAllByRole('combobox')[1] as HTMLInputElement

/** jsdom 的 <webview> 原型桩 —— 未知元素拿不到真实 guest 方法面，这里补上
 *  mock（模块级一次性挂原型，逐例 mockClear 重置计数） */
const webviewProto = document.createElement('webview').constructor.prototype as Record<string, unknown>
if (!webviewProto['loadURL']) {
  webviewProto['loadURL'] = vi.fn()
  webviewProto['reload'] = vi.fn()
  webviewProto['goBack'] = vi.fn()
  webviewProto['goForward'] = vi.fn()
  webviewProto['stop'] = vi.fn()
  webviewProto['getURL'] = vi.fn(() => '')
  webviewProto['canGoBack'] = vi.fn(() => false)
  webviewProto['canGoForward'] = vi.fn(() => false)
}
type MiniWebviewStub = HTMLUnknownElement & {
  loadURL: ReturnType<typeof vi.fn>
  reload: ReturnType<typeof vi.fn>
  goBack: ReturnType<typeof vi.fn>
  goForward: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  getURL: () => string
  canGoBack: () => boolean
  canGoForward: () => boolean
}
const wvOf = (): MiniWebviewStub => document.querySelector('webview') as unknown as MiniWebviewStub

/** 唤起 dom-ready：真实 Electron 里 guest 挂载完成前 webview 方法面一律抛错，
 *  组件把元素调用门在 miniReady —— 桩不自动发，用例显式唤起 */
const fireDomReady = (): void => {
  act(() => { wvOf().dispatchEvent(new Event('dom-ready')) })
}

beforeEach(() => {
  useUiStore.setState({ webBarFocusRequest: 0 })
  unregisterWebview('web-1')
  // 小窗恢复地址不跨用例带毒
  localStorage.removeItem('lyshell.webbarMini.url.v1')
  // 原型桩是全文件共享的 mock，逐例清计数（方法面全量清，防前例调用计数
  // 污染后续断言 —— getURL/canGoBack/canGoForward 同样是断言对象）
  for (const k of ['loadURL', 'reload', 'goBack', 'goForward', 'stop', 'getURL', 'canGoBack', 'canGoForward'] as const) {
    (webviewProto[k] as ReturnType<typeof vi.fn>).mockClear()
  }
  // electronAPI 桩：带历史的用例会打 favicon 猜测（缺省会变未处理拒绝）；
  // 小窗高度对账/防抖打 getConfig/setConfig（部分桩缺方法会让调用落地报错）
  window.electronAPI = {
    fetchFavicon: vi.fn(async () => ({ success: false })),
    getConfig: vi.fn(async () => undefined),
    setConfig: vi.fn(async () => true)
  } as unknown as typeof window.electronAPI
})

afterEach(() => {
  cleanup()
  unregisterWebview('web-1')
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
    expect(input.value).toBe('https://example.com/')
    expect(document.activeElement).not.toBe(input)
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

describe('Enter 提交（datalist 竞态）', () => {
  it('导航吃 datalist 提交后的 DOM 值，而非 state 里的输入前缀', async () => {
    setupBrowserMode()
    const el = makeWebview()
    registerWebview('web-1', el as unknown as WebviewTag)
    render(<WebPanel />)
    const input = inputOf()
    // 输入前缀（React state 只知道这个）
    fireEvent.change(input, { target: { value: 'git' } })
    // 模拟 datalist 高亮项作为 Enter 默认动作、在 keydown 之后提交到 DOM
    // （不经 React onChange，state 仍是 'git'）
    input.value = 'https://github.com/'
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(el.loadURL).toHaveBeenCalledWith('https://github.com/'))
    expect(el.loadURL).not.toHaveBeenCalledWith('https://git/')
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
    expect(screen.getByText('Type an address, or Ctrl+click a history row to preview here')).toBeTruthy()
    expect((screen.getByTitle('Promote to web tab') as HTMLButtonElement).disabled).toBe(true)
  })

  it('小窗输入合法地址 → 开眼挂 webview（独立 partition，首航冻结为 src）', async () => {
    setupBrowserMode()
    render(<WebPanel />)
    fireEvent.change(miniInputOf(), { target: { value: 'https://example.com/' } })
    fireEvent.keyDown(miniInputOf(), { key: 'Enter' })
    await waitFor(() => expect(document.querySelector('webview')).toBeTruthy())
    const wv = wvOf()
    expect(wv.getAttribute('partition')).toBe('persist:webbar-mini')
    // 首航地址定格为挂载 src（后续导航才走 loadURL）
    expect(wv.getAttribute('src')).toBe('https://example.com/')
    // dom-ready 前不碰方法面；唤起后导航 effect 落地（桩 getURL 恒空串 → 触发 loadURL）
    fireDomReady()
    await waitFor(() => expect(wv.loadURL).toHaveBeenCalledWith('https://example.com/'))
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
    expect(miniInputOf().value).toBe('https://example.com/final')
  })

  it('升格：以小窗当前页开完整网页页签（web 覆盖层 +1），小窗保留', async () => {
    setupBrowserMode()
    render(<WebPanel />)
    fireEvent.change(miniInputOf(), { target: { value: 'https://promote.example.com/' } })
    fireEvent.keyDown(miniInputOf(), { key: 'Enter' })
    await waitFor(() => expect(document.querySelector('webview')).toBeTruthy())
    fireEvent.click(screen.getByTitle('Promote to web tab'))
    const webs = Object.values(usePaneStore.getState().overlayPayloads).filter(p => p?.kind === 'web')
    expect(webs.length).toBe(2)  // 原有 web-1 + 升格新开
  })

  it('Ctrl+点击历史行 → 小窗预览，不开完整页签', async () => {
    setupBrowserMode()
    usePaneStore.setState({ webTabHistory: ['https://preview.example.org/'] })
    render(<WebPanel />)
    fireEvent.click(screen.getByText('https://preview.example.org/'), { ctrlKey: true })
    await waitFor(() => expect(document.querySelector('webview')).toBeTruthy())
    fireDomReady()
    await waitFor(() => expect(wvOf().loadURL).toHaveBeenCalledWith('https://preview.example.org/'))
    const webs = Object.values(usePaneStore.getState().overlayPayloads).filter(p => p?.kind === 'web')
    expect(webs.length).toBe(1)  // 没开新页签
  })
})
