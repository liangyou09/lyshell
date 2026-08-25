// @vitest-environment jsdom
/**
 * 页签条提顶(浏览器式第一行)测试。
 *
 * PaneTabBar 部分用 RTL 渲染断言:空态 28px 条、拖拽区落点(win-drag/win-no-drag)、
 * 留白常量生效 -- 对渲染产物断言,重构改写 className 不误伤。
 * MainWindow / globals.css 无法整树渲染(依赖 electronAPI / xterm),只保留少量
 * 结构断言:持久化键名、内框类名落点、CSS 关键规则,不做逐字 className 匹配。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import * as fs from 'fs'
import * as path from 'path'
import PaneTabBar from './PaneTabBar'
import { useSessionStore } from '../../stores/session-store'
import { usePaneStore } from '../../stores/pane-store'
import { ConnectionStatus } from '@shared/types'
import type { PaneLeaf, SessionConfig } from '@shared/types'
import { TOPBAR_HEIGHT, TOP_LEFT_RESERVE } from './topbar-metrics'

// PaneTabBar 仅从 SplitPaneContainer 导入 setDraggingSessionId;真实模块会拖入
// PaneView → TerminalView → xterm 整条渲染链,与页签条渲染无关,桩掉
vi.mock('./SplitPaneContainer', () => ({
  setDraggingSessionId: () => {},
  getDraggingSessionId: () => null
}))

const makePane = (sessions: string[]): PaneLeaf => ({
  id: 'pane-1',
  type: 'leaf',
  sessions,
  activeSessionId: sessions[0] ?? null
})

const makeSession = (id: string, name: string) => ({
  id,
  // 渲染只读 name;完整 SessionConfig 字段(terminal/tags/时间戳等)与本测试无关
  config: { id, name, type: 'ssh' } as unknown as SessionConfig,
  status: ConnectionStatus.CONNECTED
})

beforeEach(() => {
  useSessionStore.setState({ sessions: [] })
  usePaneStore.setState({
    mcpAuditPaneId: null,
    dshWeb: null,
    dshWebPaneId: null,
    dshWebActive: false,
    hiddenTabSessions: {}
  })
})

afterEach(() => cleanup())

describe('PaneTabBar 顶排页签条(渲染断言)', () => {
  it('空 pane 顶排渲染 28px 空条:可拖窗 + 左右留白,第一行永远存在', () => {
    const { container } = render(<PaneTabBar pane={makePane([])} isTop isTopLeft isTopRight />)
    const bar = container.firstElementChild as HTMLElement
    expect(bar).toBeTruthy()
    expect(bar.className).toContain('win-drag')
    expect(bar.style.height).toBe(`${TOPBAR_HEIGHT}px`)
    expect(bar.style.paddingLeft).toBe(`${TOP_LEFT_RESERVE}px`)
    // 右留白读 CSS 变量 -- 由 TopRightControls 实测发布(globals.css :root 兜底 252px)
    expect(bar.style.paddingRight).toBe('var(--top-right-reserve)')
  })

  it('空 pane 非顶排不渲染(窗口中部不出现空条)', () => {
    const { container } = render(<PaneTabBar pane={makePane([])} />)
    expect(container.innerHTML).toBe('')
  })

  it('有会话时:根容器可拖窗,页签脱离拖拽区', () => {
    useSessionStore.setState({ sessions: [makeSession('s1', 'alpha')] })
    const { container } = render(<PaneTabBar pane={makePane(['s1'])} isTop />)
    expect((container.firstElementChild as HTMLElement).className).toContain('win-drag')
    const tab = container.querySelector('[data-tab-id="s1"]') as HTMLElement
    expect(tab.className).toContain('win-no-drag')
  })

  it('非顶排根容器无拖拽区(窗口中部的页签条不可拖窗)', () => {
    useSessionStore.setState({ sessions: [makeSession('s1', 'alpha')] })
    const { container } = render(<PaneTabBar pane={makePane(['s1'])} />)
    expect((container.firstElementChild as HTMLElement).className).not.toContain('win-drag')
  })

  it('MCP 页签与 dsh web 页签同样脱离拖拽区', () => {
    usePaneStore.setState({
      mcpAuditPaneId: 'pane-1',
      dshWeb: { url: 'http://127.0.0.1:3080', name: 'dsh web' },
      dshWebPaneId: 'pane-1'
    })
    const { container } = render(<PaneTabBar pane={makePane([])} isTop />)
    const mcpTab = container.querySelector('[data-tab-id="__mcp_audit__"]') as HTMLElement
    const webTab = container.querySelector('[data-tab-id="__dsh_web__"]') as HTMLElement
    expect(mcpTab.className).toContain('win-no-drag')
    expect(webTab.className).toContain('win-no-drag')
  })
})

/* ────────── 以下为无法渲染覆盖的结构断言(收窄到不变量,不逐字匹配) ────────── */

const read = (rel: string) =>
  fs.readFileSync(path.join(process.cwd(), rel), 'utf-8')

const MAIN_WINDOW = read('src/renderer/components/Layout/MainWindow.tsx')
const TOP_RIGHT = read('src/renderer/components/Layout/TopRightControls.tsx')
const METRICS = read('src/renderer/components/Layout/topbar-metrics.ts')
const CSS = read('src/renderer/styles/globals.css')

describe('topbar-metrics 单一真相源', () => {
  it('度量常量集中定义且被三处消费方引用(防两份字面量漂移)', () => {
    const TAB_BAR = read('src/renderer/components/Layout/PaneTabBar.tsx')
    expect(METRICS).toContain('TOPBAR_HEIGHT')
    expect(METRICS).toContain('TOP_LEFT_RESERVE')
    expect(METRICS).toContain('SIDEBAR_DIVIDER_WIDTH')
    expect(TAB_BAR).toContain("from './topbar-metrics'")
    expect(MAIN_WINDOW).toContain("from './topbar-metrics'")
    expect(TOP_RIGHT).toContain("from './topbar-metrics'")
  })

  it('右留白走实测链路:CSS 变量兜底定义 + TopRightControls ResizeObserver 发布', () => {
    // globals.css :root 提供首帧兜底值,首个测量帧被 TopRightControls 覆盖
    expect(CSS).toContain('--top-right-reserve: 252px')
    expect(TOP_RIGHT).toContain("setProperty('--top-right-reserve'")
    expect(TOP_RIGHT).toContain('ResizeObserver')
  })
})

describe('globals.css 拖拽区与内框', () => {
  it('拖拽区工具类集中定义,组件不再内联 WebkitAppRegion', () => {
    expect(CSS).toMatch(/\.win-drag\s*\{\s*-webkit-app-region:\s*drag;\s*\}/)
    expect(CSS).toMatch(/\.win-no-drag\s*\{\s*-webkit-app-region:\s*no-drag;\s*\}/)
    expect(MAIN_WINDOW).not.toContain('WebkitAppRegion')
  })

  it('L 形内框:左+下两条等宽线(与页签条同色),左下角 8px 圆角连续,悬停整框通电', () => {
    expect(CSS).toContain('--edge-frame-width: 4px')
    expect(CSS).toContain('border-left: var(--edge-frame-width) solid var(--bg-rack)')
    expect(CSS).toContain('border-bottom: var(--edge-frame-width) solid var(--bg-rack)')
    expect(CSS).toContain('border-bottom-left-radius: 8px')
    expect(CSS).toContain('.edge-hit:hover ~ .edge-frame')
  })
})

describe('MainWindow 布局不变量', () => {
  it('侧栏收起态持久化(加载 + 防抖保存)', () => {
    expect(MAIN_WINDOW).toContain("getConfig('sidebarCollapsed')")
    expect(MAIN_WINDOW).toContain("setConfig('sidebarCollapsed'")
  })

  it('收起时内框画在终端让出的槽位里,页签拖拽分屏期间让位', () => {
    expect(MAIN_WINDOW).toContain('edge-hit')   // 两条槽位命中条(左+下)
    expect(MAIN_WINDOW).toContain('edge-frame') // 单元素画整框(左+下边框,左下 8px 圆角连续)
    expect(MAIN_WINDOW).toContain('isTabDragging && ') // 拖页签分屏时内框隐身,不挡最左 pane 落点
    // 画布让位 inset 与框线边框/命中条同读 --edge-frame-width,槽宽与线宽不会脱钩
    expect(MAIN_WINDOW).toContain(
      "sidebarCollapsed && 'pl-[var(--edge-frame-width)] pb-[var(--edge-frame-width)]'"
    )
  })
})
