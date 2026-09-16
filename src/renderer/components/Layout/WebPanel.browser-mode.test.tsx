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
 *    IPC，后台停驻的导航靠这一步校正）。
 * webview 用注册表替身（jsdom 承载不了真实 guest），历史置空避开 favicon 代取。
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

/** 地址栏元素：带 list 属性的 input 在可访问树中是 combobox 角色（非 textbox） */
const inputOf = (): HTMLInputElement => screen.getByRole('combobox') as HTMLInputElement

beforeEach(() => {
  useUiStore.setState({ webBarFocusRequest: 0 })
  unregisterWebview('web-1')
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
