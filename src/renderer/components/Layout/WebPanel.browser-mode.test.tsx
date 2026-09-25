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
 *    落点回写/Esc 复位/升格开完整页签/关页回空态（webview 摘树销毁 guest、
 *    localStorage 存档清掉，再输入即全新首航）/Ctrl+点击历史行预览与行上
 *    「在小窗打开」按钮/dom-ready 门（webview
 *    方法面在 guest 挂载前调用会抛错 —— 真机曾炸于此，门开前不得调 loadURL/getURL）/
 *    dom-ready 后把 webContentsId 登记给主进程（小窗与完整页签共用 webbar
 *    partition 共享登录态，主进程快捷键转发凭登记排除小窗）/存档与高度防毒
 *    （畸形存档落空态、离谱高度夹到绝对上限）/地址栏挂双开画轴（.scroll-search
 *    系列 CSS）：开合裁决 = 聚焦或有址 —— 闭眼空态收卷拴绳、有墨失焦仍展，
 *    与勾玉「闭眼/开眼」同一状态语言。
 * 7) 最近历史按域名分组立画轴：组头 scroll-head 卷轴（题签域名 + 计数）点击
 *    开合（ScrollFold inert 挡 Tab 序）、组序/组内序吃历史最近优先序、非默认
 *    端口独立成组（hostKey = hostname + port）。
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
import { render, cleanup, screen, act, fireEvent, waitFor } from '@testing-library/react'
import type { WebviewTag } from 'electron'
import { usePaneStore } from '../../stores/pane-store'
import { useUiStore } from '../../stores/ui-store'
import { registerWebview, unregisterWebview } from './web-tab-controls'
import type { OverlayPayload, WebTabNav } from '@shared/types'
import { WEBBAR_PARTITION } from '@shared/constants'
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
  // 小窗 dom-ready 后报给主进程的 webContentsId（真机取自 guest,桩给固定值,
  // 与 registerWebbarMini 桩断言配对 —— 快捷键转发排除判据的契约测试）
  webviewProto['getWebContentsId'] = vi.fn(() => 4242)
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
  getWebContentsId: () => number
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
  for (const k of ['loadURL', 'reload', 'goBack', 'goForward', 'stop', 'getURL', 'canGoBack', 'canGoForward', 'getWebContentsId'] as const) {
    (webviewProto[k] as ReturnType<typeof vi.fn>).mockClear()
  }
  // electronAPI 桩：带历史的用例会打 favicon 猜测（缺省会变未处理拒绝）；
  // 小窗高度对账/防抖打 getConfig/setConfig；dom-ready 后打 registerWebbarMini
  // （部分桩缺方法会让调用落地报错）
  window.electronAPI = {
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
    // 先落定挂载期异步（小窗 config 对账会触发一次重渲染，插进 DOM 直写与
    // Enter 延迟读值之间会把受控值打回 state 前缀 —— 真机里对账远早于输入）
    await act(async () => {})
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
    expect(screen.getByText("Type an address, or click a history row's mini button to open it here")).toBeTruthy()
    expect((screen.getByTitle('Promote to web tab') as HTMLButtonElement).disabled).toBe(true)
  })

  it('小窗地址 = 双开画轴：闭眼空态收卷拴绳，聚焦即展、失焦且空即收（与勾玉同一状态语言）', () => {
    setupBrowserMode()
    render(<WebPanel />)
    const label = miniInputOf().closest('label')
    expect(label).toBeTruthy()
    // 结构：纸幅×2 + 双辊×2 + 蝴蝶结×2（机械全在 .scroll-search 系列 CSS，组件只挂态）
    expect(label?.className).toContain('scroll-search')
    expect(label?.className).toContain('h-[32px]')
    expect(label?.querySelectorAll('.scroll-search-paper')).toHaveLength(2)
    expect(label?.querySelectorAll('.scroll-search-rod')).toHaveLength(2)
    expect(label?.querySelectorAll('.scroll-search-tie')).toHaveLength(2)
    // 闭眼空态：双卷各拴一只蝴蝶结
    expect(label?.className).toContain('rolled')
    // 聚焦即展开（label 承接点击落到 input，focus 态参与开合裁决）
    fireEvent.focus(miniInputOf())
    expect(label?.className).toContain('open')
    // 失焦且未开眼：纸裹回双辊、重新拴绳
    fireEvent.blur(miniInputOf())
    expect(label?.className).toContain('rolled')
  })

  it('小窗地址 = 双开画轴：有址即开眼（有墨失焦仍展），Esc 复位后仍展', () => {
    setupBrowserMode()
    localStorage.setItem('lyshell.webbarMini.url.v1', 'https://restored.example.com/')
    render(<WebPanel />)
    const label = miniInputOf().closest('label')
    // 存档恢复即开眼：miniInput 随当前页地址，纸上有墨 —— 挂载即展开
    expect(miniInputOf().value).toBe('https://restored.example.com/')
    expect(label?.className).toContain('open')
    // 编辑中途失焦：纸上有字不收
    fireEvent.focus(miniInputOf())
    fireEvent.change(miniInputOf(), { target: { value: 'https://editing.example.com/' } })
    fireEvent.blur(miniInputOf())
    expect(label?.className).toContain('open')
    // Esc 放弃编辑复位为当前页地址 —— 仍有址，仍展开
    fireEvent.keyDown(miniInputOf(), { key: 'Escape' })
    expect(miniInputOf().value).toBe('https://restored.example.com/')
    expect(label?.className).toContain('open')
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

  it('历史行「在小窗打开」按钮 → 小窗预览不开完整页签（显式按钮，与 Ctrl+点击同走 loadMini）', async () => {
    setupBrowserMode()
    usePaneStore.setState({ webTabHistory: ['https://button.example.org/'] })
    render(<WebPanel />)
    // 显式入口:点行上的小窗按钮(此前只有 Ctrl+点击隐藏手势)
    fireEvent.click(screen.getByTitle('Open in mini browser'))
    await waitFor(() => expect(document.querySelector('webview')).toBeTruthy())
    fireDomReady()
    await waitFor(() => expect(wvOf().loadURL).toHaveBeenCalledWith('https://button.example.org/'))
    const webs = Object.values(usePaneStore.getState().overlayPayloads).filter(p => p?.kind === 'web')
    expect(webs.length).toBe(1)  // 没开新页签
  })

  it('最近历史按域名分组：同域并组（组头 = 域名题签 + 计数），组序/组内序吃最近序，非默认端口独立成组', () => {
    setupBrowserMode()
    usePaneStore.setState({
      webTabHistory: [
        'https://a.example.com/two',       // a 组最近一条 = 全表最新 → a 组排最前
        'https://b.example.org/only',
        'https://a.example.com/one',
        'https://a.example.com:8443/port'  // 非默认端口:独立组,不与 a 并
      ]
    })
    const { container } = render(<WebPanel />)
    const headOf = (prefix: string): HTMLElement =>
      Array.from(container.querySelectorAll('div.scroll-head'))
        .find(el => el.textContent?.startsWith(prefix)) as HTMLElement
    const headA = headOf('a.example.com2')   // 题签 + 计数同落卷面(textContent 顺读)
    const headB = headOf('b.example.org1')
    const headPort = headOf('a.example.com:84431')
    expect(headA).toBeTruthy()
    expect(headB).toBeTruthy()
    expect(headPort).toBeTruthy()
    // 段身份青蓝:轴头 inline 注入 --web-group(锁色契约,防回落中性)
    expect(headA.querySelector('.rod-caps')?.getAttribute('style')).toContain('--web-group')
    // 长域名不挤走计数:题签可缩可截断(ellipsis),全名走 title
    const slip = headA.querySelector('.scroll-slip') as HTMLElement
    expect(slip.className).toContain('truncate')
    expect(slip.className).not.toContain('flex-shrink-0')
    expect(slip.getAttribute('title')).toBe('a.example.com')
    // 组序 = 各组最近一条的落位:a(最新)→ b → a:8443
    expect(headA.compareDocumentPosition(headB) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(headB.compareDocumentPosition(headPort) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // 组内最近序:…/two 在 …/one 之前
    const text = document.body.textContent ?? ''
    expect(text.indexOf('https://a.example.com/two')).toBeGreaterThan(-1)
    expect(text.indexOf('https://a.example.com/two')).toBeLessThan(text.indexOf('https://a.example.com/one'))
  })

  it('组头 favicon 跟随组内最新一条：url 变化先清旧图，回落猜测失败不残留上一条的图标', async () => {
    setupBrowserMode()
    // A 条有持久化图标(页签打开时捕获),组头先落 A 的图
    usePaneStore.setState({
      webTabHistory: ['https://a.example.com/a', 'https://a.example.com/b'],
      webTabFavicons: { 'https://a.example.com/a': 'data:image/png;base64,AA==' }
    })
    const { container } = render(<WebPanel />)
    await waitFor(() => expect(container.querySelector('.scroll-head img')).toBeTruthy())
    // 同域 B 条成为组内最新(无持久化图标,origin 猜测在桩下失败)→ 组头清图。
    // 修复前:src 不随 url 重置,A 的图长期张冠李戴地挂在组头上
    act(() => {
      usePaneStore.setState({ webTabHistory: ['https://a.example.com/b', 'https://a.example.com/a'] })
    })
    await waitFor(() => expect(container.querySelector('.scroll-head img')).toBeNull())
  })

  it('组头点击开合（画轴）：收起后 aria-expanded 翻转、组内容卷进 ScrollFold（inert 挡 Tab 序），再点恢复', () => {
    setupBrowserMode()
    usePaneStore.setState({ webTabHistory: ['https://a.example.com/one', 'https://a.example.com/two'] })
    const { container } = render(<WebPanel />)
    const head = container.querySelector('div.scroll-head') as HTMLElement
    expect(head.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('.scroll-fold')?.className).toContain('open')
    fireEvent.click(head)
    expect(head.getAttribute('aria-expanded')).toBe('false')
    const fold = container.querySelector('.scroll-fold')
    expect(fold?.className).not.toContain('open')
    expect(fold?.hasAttribute('inert')).toBe(true)
    fireEvent.click(head)
    expect(head.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('.scroll-fold')?.className).toContain('open')
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
