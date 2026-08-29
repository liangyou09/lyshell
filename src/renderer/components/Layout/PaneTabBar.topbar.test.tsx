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
import { TOPBAR_HEIGHT } from './topbar-metrics'

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

const makeSession = (id: string, name: string, tags?: string[]) => ({
  id,
  // 渲染只读 name 与 tags(页签品牌来源标);其余 SessionConfig 字段与本测试无关
  config: { id, name, type: 'ssh', tags } as unknown as SessionConfig,
  status: ConnectionStatus.CONNECTED
})

beforeEach(() => {
  useSessionStore.setState({ sessions: [] })
  usePaneStore.setState({
    mcpAuditPaneId: null,
    mcpAuditActive: false,
    dshWeb: null,
    dshWebPaneId: null,
    dshWebActive: false,
    dshWebTabIndex: null,
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
    // 左留白读 CSS 变量 -- MainWindow 按侧栏收起态发布(收起 32px / 展开 0,globals.css :root 兜底 32px)
    expect(bar.style.paddingLeft).toBe('var(--top-left-reserve)')
    // 右留白读 CSS 变量 -- 由 TopRightControls 实测发布(globals.css :root 兜底 130px)
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
      mcpAuditActive: true,
      dshWeb: { url: 'http://127.0.0.1:3080', name: 'dsh web' },
      dshWebPaneId: 'pane-1'
    })
    const { container } = render(<PaneTabBar pane={makePane([])} isTop />)
    const mcpTab = container.querySelector('[data-tab-id="__mcp_audit__"]') as HTMLElement
    const webTab = container.querySelector('[data-tab-id="__dsh_web__"]') as HTMLElement
    expect(mcpTab.className).toContain('win-no-drag')
    expect(webTab.className).toContain('win-no-drag')
  })

  // harness 工作区启动的瞬态会话 tags 带 <kind>:<id>(handlers.ts 的 spawnLocalCommandSession),
  // 页签名左侧据此亮品牌来源标;普通会话、通用 Agent(agent:<id>)与用户自建的裸 kind 名标签不亮
  it('harness 会话页签亮品牌来源标(codex/claude/dsh),普通、agent: 与裸 kind 名标签不亮', () => {
    useSessionStore.setState({
      sessions: [
        makeSession('s1', 'ws', ['codex:ws-1']),
        makeSession('s2', 'ws', ['claude:ws-2']),
        makeSession('s3', 'ws', ['dsh:ws-3']),
        makeSession('s4', 'plain'),
        makeSession('s5', 'agent', ['agent:a-1']),
        makeSession('s6', 'bare', ['codex'])
      ]
    })
    const { container } = render(<PaneTabBar pane={makePane(['s1', 's2', 's3', 's4', 's5', 's6'])} isTop />)
    const markOf = (id: string) =>
      container.querySelector(`[data-tab-id="${id}"] [data-harness-mark]`)
    expect(markOf('s1')?.getAttribute('data-harness-mark')).toBe('codex')
    expect(markOf('s2')?.getAttribute('data-harness-mark')).toBe('claude')
    expect(markOf('s3')?.getAttribute('data-harness-mark')).toBe('dsh')
    expect(markOf('s4')).toBeNull()
    expect(markOf('s5')).toBeNull()
    // 只认 <kind>: 前缀(主进程打标约定)—— 用户自建的裸 "codex" 纯标签不命中品牌标
    expect(markOf('s6')).toBeNull()
  })

  // web 插槽存 pane.sessions 原始坐标，渲染时换算成"过滤隐藏页签后的可见索引"。
  // 这里对 DOM 页签顺序断言 —— 防止后续把可见坐标当原始坐标用（或反之）的回归；
  // store 侧的坐标推导已由 pane-store.webtab.test.ts 覆盖，两层各锁一半
  it('web 中段插槽 + 隐藏页签：DOM 页签顺序 = 隐藏过滤后按插槽插入', () => {
    useSessionStore.setState({
      sessions: [makeSession('s1', 'alpha'), makeSession('s2', 'beta'), makeSession('s3', 'gamma')]
    })
    usePaneStore.setState({
      dshWeb: { url: 'http://127.0.0.1:3080', name: 'dsh web' },
      dshWebPaneId: 'pane-1',
      dshWebActive: false,
      // 原始坐标 [s1, s2(隐藏), s3]，插槽 1（s2 之前）→ 可见顺序 s1, web, s3
      dshWebTabIndex: 1,
      hiddenTabSessions: { s2: true }
    })
    const { container } = render(<PaneTabBar pane={makePane(['s1', 's2', 's3'])} isTop />)
    const tabIds = Array.from(container.querySelectorAll('[data-tab-id]'))
      .map(el => el.getAttribute('data-tab-id'))
    expect(tabIds).toEqual(['s1', '__dsh_web__', 's3'])
  })

  it('web 插槽 0 / 钉尾 null：分别渲染在最前 / 最后', () => {
    useSessionStore.setState({
      sessions: [makeSession('s1', 'alpha'), makeSession('s2', 'beta')]
    })
    usePaneStore.setState({
      dshWeb: { url: 'http://127.0.0.1:3080', name: 'dsh web' },
      dshWebPaneId: 'pane-1',
      dshWebActive: false,
      dshWebTabIndex: 0
    })
    const first = render(<PaneTabBar pane={makePane(['s1', 's2'])} isTop />)
    expect(
      Array.from(first.container.querySelectorAll('[data-tab-id]')).map(el => el.getAttribute('data-tab-id'))
    ).toEqual(['__dsh_web__', 's1', 's2'])

    usePaneStore.setState({ dshWebTabIndex: null })
    const last = render(<PaneTabBar pane={makePane(['s1', 's2'])} isTop />)
    expect(
      Array.from(last.container.querySelectorAll('[data-tab-id]')).map(el => el.getAttribute('data-tab-id'))
    ).toEqual(['s1', 's2', '__dsh_web__'])
  })
})

/* ────────── 以下为无法渲染覆盖的结构断言(收窄到不变量,不逐字匹配) ────────── */

const read = (rel: string) =>
  fs.readFileSync(path.join(process.cwd(), rel), 'utf-8')

const MAIN_WINDOW = read('src/renderer/components/Layout/MainWindow.tsx')
const ACTIVITY_RAIL = read('src/renderer/components/Layout/ActivityRail.tsx')
const TOP_RIGHT = read('src/renderer/components/Layout/TopRightControls.tsx')
const METRICS = read('src/renderer/components/Layout/topbar-metrics.ts')
const CSS = read('src/renderer/styles/globals.css')

describe('topbar-metrics 单一真相源', () => {
  it('度量常量集中定义且被三处消费方引用(防两份字面量漂移)', () => {
    const TAB_BAR = read('src/renderer/components/Layout/PaneTabBar.tsx')
    expect(METRICS).toContain('TOPBAR_HEIGHT')
    expect(METRICS).toContain('TOP_LEFT_RESERVE')
    expect(METRICS).toContain('SIDEBAR_DIVIDER_WIDTH')
    expect(METRICS).toContain('SIDEBAR_PILL_HEIGHT')
    expect(TAB_BAR).toContain("from './topbar-metrics'")
    expect(MAIN_WINDOW).toContain("from './topbar-metrics'")
    expect(TOP_RIGHT).toContain("from './topbar-metrics'")
    // 轨顶收起槽与终端第一行齐平 -- ActivityRail 也读 TOPBAR_HEIGHT
    expect(ACTIVITY_RAIL).toContain("from './topbar-metrics'")
    expect(ACTIVITY_RAIL).toContain('style={{ height: TOPBAR_HEIGHT }}')
    // 收起槽画底线(与面板头条/页签条同色同 y)—— 第一行底线横贯整个窗口,整行读作一条横带
    expect(ACTIVITY_RAIL).toContain('border-b border-[var(--rule)]')
    // 左列四个内容面板头条同族(SessionsPanel/AgentsPanel/HarnessPanel/PluginPanel):
    // 都是 TOPBAR_HEIGHT 高 + border-b 发丝线的满幅头条,窗口第一行横带在哪个页签都连续
    const SESSIONS_PANEL = read('src/renderer/components/Layout/SessionsPanel.tsx')
    const AGENTS_PANEL = read('src/renderer/components/Layout/AgentsPanel.tsx')
    const HARNESS_PANEL = read('src/renderer/components/Layout/HarnessPanel.tsx')
    const PLUGIN_PANEL = read('src/renderer/components/Layout/PluginPanel.tsx')
    for (const panel of [SESSIONS_PANEL, AGENTS_PANEL, HARNESS_PANEL, PLUGIN_PANEL]) {
      expect(panel).toContain("from './topbar-metrics'")
      expect(panel).toContain('style={{ height: TOPBAR_HEIGHT }}')
      expect(panel).toContain('border-b border-[var(--rule)]')
      // 铭牌字体同源:设备徽章系统,厂牌走系统 UI 字体(与终端画布的等宽栈刻意拉开字面)
      expect(panel).toContain('Segoe UI Variable Display')
    }
  })

  it('右留白走实测链路:CSS 变量兜底定义 + TopRightControls ResizeObserver 发布', () => {
    // globals.css :root 提供首帧兜底值(MCP 状态片移轨后控制簇为固定宽 ~120px),
    // 首个测量帧被 TopRightControls 覆盖
    expect(CSS).toContain('--top-right-reserve: 130px')
    expect(TOP_RIGHT).toContain("setProperty('--top-right-reserve'")
    expect(TOP_RIGHT).toContain('ResizeObserver')
  })

  it('左留白随侧栏收起态:MainWindow 发布 --top-left-reserve(收起 32 / 展开 0) + globals.css 兜底', () => {
    // 展开时 pill 隐形,留白归零让第一行页签紧贴左列;收起时给展开 pill 让位
    expect(CSS).toContain('--top-left-reserve: 32px')
    expect(MAIN_WINDOW).toContain("'--top-left-reserve'")
    expect(MAIN_WINDOW).toContain('sidebarCollapsed ? `')
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

  it('侧栏开关双控位:展开=轨顶收起槽,收起=左上 pill(交叉淡变)', () => {
    // 展开态的收起开关在机柜轨顶槽(非页签),MainWindow 注入 onCollapse
    expect(ACTIVITY_RAIL).toContain('onCollapse')
    expect(MAIN_WINDOW).toContain('onCollapse')
    // pill 悬停不联动点亮内框(反馈只留在 pill 自身),globals 只保留 edge-hit 通电链路
    expect(CSS).not.toContain('.edge-pill')
    // 展开态 pill 淡出并退出交互/Tab 序(同一开关在窗口左上角变形,不重复出现)
    expect(MAIN_WINDOW).toContain('!sidebarCollapsed && \'opacity-0 pointer-events-none\'')
    expect(MAIN_WINDOW).toContain('tabIndex={sidebarCollapsed ? 0 : -1}')
  })
})
