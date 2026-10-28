// @vitest-environment jsdom
/**
 * PaneView 内容区「网页面」回归：用户实测「浏览器页签出现了，内容区却显示别的
 * 终端」。成因是网页页签在 pane 内只有一层透明测位占位（<webview> 实体挂在跨树
 * 的 WebTabLayer 常驻层），实体未画出（加载中 / guest 崩溃）时，下面同 pane 的
 * TerminalView 即使网页覆盖层 active 仍 visibility:visible，直接露底。
 *
 * 本层锁三件事：
 * 1. 网页覆盖层 active 时，pane 内终端只 CSS 隐藏、不卸载（连接与输出保持），
 *    覆盖层去活后原样恢复显示；
 * 2. 测位占位自身必须不透明（bg-[var(--terminal-bg)]），真正网页层没就位时
 *    也能稳稳遮住下面；
 * 3. 纯终端流与「空态文档内联」的既有行为不被改变。
 *
 * TerminalView 用带锚点与生命周期计数的替身（jsdom 承载不了 xterm）；WebTabLayer
 * 不挂载 —— 本层只验证 PaneView 这一侧的 DOM 呈现与遮盖契约。
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, act } from '@testing-library/react'
import React from 'react'
import { usePaneStore } from '../../stores/pane-store'
import { useSessionStore } from '../../stores/session-store'
import { useTerminalStore } from '../../stores/terminal-store'
import { ConnectionType, ConnectionStatus } from '@shared/types'
import type { DocOverlayPayload, PaneLeaf, PaneNode, SessionConfig, SplitDirection } from '@shared/types'
import PaneView from './PaneView'
import SplitPaneContainer from './SplitPaneContainer'
import { WEB_TAB_PLACEHOLDER_ATTR } from './WebTabLayer'
import { registerShelfSurface } from './task-shelf-surfaces'
import { registerShelfWebPreview } from './task-shelf-preview-sources'
import '../../i18n'

// 终端替身的挂载/卸载计数：跨覆盖层开关保持 1/0 才证明「只隐藏、没卸载」
const terminalLifecycle = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }))

vi.mock('../Terminal/TerminalView', async () => {
  const ReactModule = await import('react')
  const MockTerminalView = ({ sessionId }: { sessionId: string }) => {
    ReactModule.useEffect(() => {
      terminalLifecycle.mounts += 1
      return () => { terminalLifecycle.unmounts += 1 }
    }, [])
    // 可识别内容：测试据此确认终端真在 DOM 里（而不是被条件渲染掉）
    return ReactModule.createElement('div', { 'data-testid': 'terminal-view' }, `terminal:${sessionId}`)
  }
  return { default: MockTerminalView }
})

// jsdom 未实现 scrollIntoView（命令屏候选列表的滚动跟随 effect 会踩到）
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

const SESSION_ID = 's-1'
const WEB_URL = 'https://example.com/'

// 测试用终端配置占位（本层不消费该字段，与 empty-state 套件同款）
const terminal = {} as SessionConfig['terminal']

const sessionConfig: SessionConfig = {
  id: SESSION_ID,
  name: 'session-one',
  type: ConnectionType.LOCAL,
  terminal,
  tags: [],
  createdAt: new Date(),
  updatedAt: new Date()
}

/** 清单类内置文档 payload（内容无所谓，只看内联/盖屏语义） */
const docPayload = (path: string): DocOverlayPayload => ({
  source: 'builtin',
  docKind: 'markdown',
  path,
  title: path,
  size: 16,
  mtime: 0,
  content: '# inventory\n\n- session-one\n'
})

/** 重置 pane-store：单叶子 pane-1，可带一个会话（activeSessionId 指向它） */
const resetLayout = (opts: { withSession?: boolean } = {}): void => {
  usePaneStore.setState({
    layout: {
      root: {
        id: 'pane-1',
        type: 'leaf',
        sessions: opts.withSession ? [SESSION_ID] : [],
        activeSessionId: opts.withSession ? SESSION_ID : null,
        overlays: []
      },
      activePaneId: 'pane-1'
    },
    overlayPayloads: {},
    hiddenTabSessions: {},
    draggingOverlayId: null,
    draggingSessionId: null
  })
}

/** 与 SplitPaneContainer 同款挂法：订阅 root 随 store 重渲染 */
const Harness: React.FC = () => {
  const root = usePaneStore(s => s.layout.root)
  return <PaneView node={root} isTop isTopLeft isTopRight />
}

const pane = (): ReturnType<typeof usePaneStore.getState> => usePaneStore.getState()

/** 终端替身外层（PaneView 在 pane 内的 absolute 包裹层，隐藏/显隐都落在它身上） */
const terminalWrapper = (): HTMLElement => {
  const view = screen.getByTestId('terminal-view')
  return view.parentElement as HTMLElement
}

/** 网页测位占位（WebTabLayer 按它的矩形摆放真正的 <webview>） */
const webPlaceholder = (): HTMLElement | null =>
  document.querySelector(`[${WEB_TAB_PLACEHOLDER_ATTR}]`)

/** 空 pane 时挂载的嵌入式命令屏 */
const commandScreen = (): HTMLElement | null => document.querySelector('.command-screen')

/** 在指定 pane 上挂一个网页覆盖层，返回实例 id */
const openWeb = (paneId = 'pane-1'): string => {
  const id = pane().mountOverlay(paneId, { kind: 'web', url: WEB_URL, title: 'example.com' })
  expect(id).toBeTruthy()
  return id as string
}

beforeEach(() => {
  resetLayout()
  terminalLifecycle.mounts = 0
  terminalLifecycle.unmounts = 0
  useSessionStore.setState({
    sessions: [{ id: SESSION_ID, config: sessionConfig, status: ConnectionStatus.CONNECTED }]
  })
})

afterEach(() => {
  cleanup()
  // 真实应用里 disconnectSession 会 unregister；替身没注册过，删键幂等
  useTerminalStore.getState().unregisterTerminal(SESSION_ID)
})

describe('常驻任务区上方的首行保持全宽', () => {
  it.each(['horizontal', 'vertical'] as const)('嵌套 %s 分屏仅放开首行最右路径，内容继续裁切且不重挂终端', direction => {
    const leaf = (id: string): PaneLeaf => ({ id, type: 'leaf', sessions: [id], activeSessionId: id, overlays: [] })
    const opposite: SplitDirection = direction === 'horizontal' ? 'vertical' : 'horizontal'
    const nested: PaneNode = { id: 'nested', type: 'split', direction: opposite, splitRatio: .5, firstChild: leaf('a'), secondChild: leaf('b') }
    const root: PaneNode = { id: 'root', type: 'split', direction, splitRatio: .5,
      firstChild: direction === 'vertical' ? nested : leaf('c'), secondChild: direction === 'horizontal' ? nested : leaf('c') }
    usePaneStore.setState({ layout: { root, activePaneId: 'a' } })
    useSessionStore.setState({ sessions: ['a', 'b', 'c'].map(id => ({ id, config: { ...sessionConfig, id }, status: ConnectionStatus.CONNECTED })) })
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    try {
      const view = render(<div style={{ paddingRight: 320, '--task-shelf-reserve': '320px' } as React.CSSProperties}><SplitPaneContainer /></div>)
      const rightmostId = direction === 'horizontal' ? 'a' : 'b'
      const rightmost = view.container.querySelector<HTMLElement>(`[data-pane-id="${rightmostId}"]`)!
      const bar = rightmost.firstElementChild as HTMLElement
      expect(bar.style.width).toBe('calc(100% + var(--task-shelf-reserve, 0px))')
      expect(bar.style.paddingRight).toBe('var(--top-right-reserve)')
      // 沿祖先直到窗口内容层均不裁掉延伸部分；终端自己的内容层仍裁切。
      for (let ancestor = rightmost.parentElement; ancestor && ancestor !== view.container; ancestor = ancestor.parentElement) {
        expect(ancestor.classList.contains('overflow-hidden')).toBe(false)
      }
      expect(rightmost.children[1].classList.contains('overflow-hidden')).toBe(true)
      const other = view.container.querySelector<HTMLElement>('[data-pane-id="c"]')!
      expect((other.firstElementChild as HTMLElement).style.width).toBe('')
      const terminals = [...view.container.querySelectorAll('[data-testid="terminal-view"]')]
      view.rerender(<div style={{ paddingRight: 0, '--task-shelf-reserve': '0px' } as React.CSSProperties}><SplitPaneContainer /></div>)
      expect([...view.container.querySelectorAll('[data-testid="terminal-view"]')]).toEqual(terminals)
      expect(terminalLifecycle.mounts).toBe(3)
      expect(terminalLifecycle.unmounts).toBe(0)
    } finally { vi.unstubAllGlobals() }
  })
})

describe('PaneView 网页面：覆盖层盖屏时终端只隐藏不卸载', () => {
  it('网页页签激活 → 终端 CSS 隐藏但仍挂载；去活 → 原样恢复', () => {
    resetLayout({ withSession: true })
    render(<Harness />)

    // 纯终端：可见，且没有多出来的占位
    expect(terminalWrapper().style.visibility).toBe('visible')
    expect(webPlaceholder()).toBeNull()
    expect(terminalLifecycle.mounts).toBe(1)

    let webId = ''
    act(() => { webId = openWeb() })

    // 网页覆盖层 active：测位占位在，终端仍挂载（连接与输出不断），只是不可见
    expect(webPlaceholder()).not.toBeNull()
    expect(screen.getByTestId('terminal-view')).toBeTruthy()
    expect(screen.getByText(`terminal:${SESSION_ID}`)).toBeTruthy()
    expect(terminalWrapper().style.visibility).toBe('hidden')
    expect(terminalLifecycle.mounts).toBe(1)
    expect(terminalLifecycle.unmounts).toBe(0)

    act(() => { pane().deactivateOverlay(webId) })

    // 网页去活：终端恢复显示，实例始终是同一个
    expect(terminalWrapper().style.visibility).toBe('visible')
    expect(terminalLifecycle.mounts).toBe(1)
    expect(terminalLifecycle.unmounts).toBe(0)

    // 关掉网页页签（真正卸载测位）后仍然是同一份终端
    act(() => { pane().closeOverlay(webId) })
    expect(webPlaceholder()).toBeNull()
    expect(terminalWrapper().style.visibility).toBe('visible')
    expect(terminalLifecycle.mounts).toBe(1)
    expect(terminalLifecycle.unmounts).toBe(0)
  })

  it('网页测位占位使用不透明主题底色（真正的网页层未就位也不露底）', () => {
    resetLayout({ withSession: true })
    render(<Harness />)
    act(() => { openWeb() })

    const placeholder = webPlaceholder() as HTMLElement
    expect(placeholder.className).toContain('bg-[var(--terminal-bg)]')
    expect(placeholder.className).not.toContain('bg-transparent')
  })
})

describe('PaneView 网页面：空 pane 激活网页时命令屏有稳定遮盖', () => {
  it('网页覆盖层盖住命令屏：命令屏保留挂载、让出焦点（inert），撤下后收回', () => {
    render(<Harness />)
    const screenEl = commandScreen() as HTMLElement
    expect(screenEl).toBeTruthy()
    expect(screenEl.hasAttribute('inert')).toBe(false)

    let webId = ''
    act(() => { webId = openWeb() })

    // 命令屏不卸载（焦点/状态留存），但被活覆盖层判定盖住 → inert 让出键盘；
    // 占位本身不透明，webview 实体没画出来也不会露出底下的命令屏
    expect(commandScreen()).toBe(screenEl)
    expect(screenEl.hasAttribute('inert')).toBe(true)
    expect((webPlaceholder() as HTMLElement).className).toContain('bg-[var(--terminal-bg)]')

    act(() => { pane().deactivateOverlay(webId) })

    expect(commandScreen()).toBe(screenEl)
    expect(screenEl.hasAttribute('inert')).toBe(false)
  })
})

describe('PaneView 网页面：既有呈现不被改变', () => {
  it('纯终端流：无覆盖层时终端可见、命令屏不挂载', () => {
    resetLayout({ withSession: true })
    render(<Harness />)

    expect(terminalWrapper().style.visibility).toBe('visible')
    expect(commandScreen()).toBeNull()
    expect(webPlaceholder()).toBeNull()
  })

  it('文档页签不算「活覆盖层」：有会话时终端保持可见（与 covered 同判据）', () => {
    resetLayout({ withSession: true })
    render(<Harness />)

    act(() => { pane().openDocTab('pane-1', docPayload('lyshell://inventory')) })

    // 文档不参与 liveOverlayActive（内联语义），终端不被藏
    expect(terminalWrapper().style.visibility).toBe('visible')
    expect(terminalLifecycle.unmounts).toBe(0)
  })

  it('空态文档内联：激活中的 doc 仍内联进命令屏、输入框保持聚焦', () => {
    render(<Harness />)

    act(() => { pane().openDocTab('pane-1', docPayload('lyshell://inventory')) })

    const screenEl = commandScreen() as HTMLElement
    expect(screenEl).toBeTruthy()
    expect(screenEl.hasAttribute('inert')).toBe(false)
    const input = (screen.queryByRole('searchbox') ?? screen.getByRole('textbox')) as HTMLInputElement
    expect(document.activeElement).toBe(input)
    // 内联文档不产生网页测位占位，也不挂终端
    expect(webPlaceholder()).toBeNull()
    expect(screen.queryByTestId('terminal-view')).toBeNull()
  })
})


describe('Harness 原生小窗口', () => {
  it('复用原 guest 并优先于透明缩略图，收起后隐藏，召回仍是原节点', () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {})
    const slot = document.createElement('div'); document.body.append(slot)
    slot.getBoundingClientRect = () => new DOMRect(500, 200, 400, 240)
    let release: (() => void) | undefined, releasePreview: (() => void) | undefined
    try {
      render(<Harness />)
      let id = ''
      act(() => { id = pane().mountOverlay('pane-1', { kind: 'dshWeb', url: 'https://harness.test/', name: 'Harness' })! })
      const guest = document.querySelector('webview')!
      act(() => { pane().deactivateOverlay(id); releasePreview = registerShelfWebPreview(id); release = registerShelfSurface('harness', id, slot, true) })
      const native = guest.closest<HTMLElement>('[data-shelf-native]')!
      expect(native.style.position).toBe('fixed')
      expect(native.style.left).toBe('500px')
      expect(native.style.visibility).toBe('visible')
      expect((guest as HTMLElement).style.opacity).toBe('')
      expect(document.querySelector('webview')).toBe(guest)
      act(() => release?.())
      expect(native.style.visibility).toBe('hidden')
      expect(native.style.width).toBe('400px')
      expect(native.hasAttribute('inert')).toBe(true)
      act(() => pane().activateOverlay(id))
      expect(native.style.visibility).toBe('visible')
      expect(native.hasAttribute('data-shelf-native')).toBe(false)
      expect(document.querySelector('webview')).toBe(guest)
    } finally { act(() => { release?.(); releasePreview?.() }); slot.remove(); vi.unstubAllGlobals() }
  })
})
