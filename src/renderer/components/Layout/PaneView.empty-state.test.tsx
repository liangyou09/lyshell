// @vitest-environment jsdom
/**
 * PaneView 空态命令屏焦点回归(用户实测:/ls 清单里点开 session、关掉终端后,
 * 命令屏不再收键盘)。焦点链跨三层:pane-store 关闭后 activePaneId 的收敛、
 * PaneView 的条件挂载(sessions 空了才挂命令屏)+ covered/inlineDoc 透传、
 * CommandScreen 的聚焦 effect —— store 级单测只锁第一层,这里渲染真实
 * PaneView 走完整链路,断言内容页签关掉后 document.activeElement 落回命令屏
 * 输入框。TerminalView 用替身(jsdom 承载不了 xterm),终端内部的焦点行为
 * 不属本层;DocTabOverlay 用真实组件(空态激活 doc 内联进输出区、停驻/回并
 * 的切换正是 covered/inlineDoc 翻转的边界)。
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, act, fireEvent } from '@testing-library/react'
import React from 'react'
import { usePaneStore } from '../../stores/pane-store'
import { useSessionStore } from '../../stores/session-store'
import { useTerminalStore } from '../../stores/terminal-store'
import { PALETTE_CLOSED_EVENT } from '../../commands/palette'
import { ConnectionType, ConnectionStatus } from '@shared/types'
import type { DocOverlayPayload, SessionConfig } from '@shared/types'
import type { PaneLeaf } from '@shared/types'
import PaneView from './PaneView'
import '../../i18n'

// xterm/WebGL 在 jsdom 里跑不起来;本层只验证命令屏侧的焦点,终端视图替身为空
vi.mock('../Terminal/TerminalView', () => ({ default: () => null }))

// jsdom 未实现 scrollIntoView(候选列表的滚动跟随 effect 会踩到)
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

const SESSION_ID = 's-1'

// 测试用终端配置占位(本层不消费该字段,与 inventory.test.ts 同款)
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

/** 清单/手册类内置文档页签的 payload(内容无所谓,焦点只看覆盖层有无) */
const docPayload = (path: string): DocOverlayPayload => ({
  source: 'builtin',
  docKind: 'markdown',
  path,
  title: path,
  size: 16,
  mtime: 0,
  content: '# inventory\n\n- session-one\n'
})

/** 重置 pane-store:单空叶子 pane-1 —— 应用冷启动 / 关掉所有页签后的标准形态 */
const resetLayout = (): void => {
  usePaneStore.setState({
    layout: {
      root: { id: 'pane-1', type: 'leaf', sessions: [], activeSessionId: null, overlays: [] },
      activePaneId: 'pane-1'
    },
    overlayPayloads: {},
    hiddenTabSessions: {},
    draggingOverlayId: null,
    draggingSessionId: null
  })
}

/** 与 SplitPaneContainer 同款挂法:订阅 root 随 store 重渲染 */
const Harness: React.FC = () => {
  const root = usePaneStore(s => s.layout.root)
  return <PaneView node={root} isTop isTopLeft isTopRight />
}

const inputOf = (): HTMLInputElement => screen.getByRole('textbox') as HTMLInputElement
const pane = (): ReturnType<typeof usePaneStore.getState> => usePaneStore.getState()

beforeEach(() => {
  resetLayout()
  useSessionStore.setState({
    sessions: [{ id: SESSION_ID, config: sessionConfig, status: ConnectionStatus.CONNECTED }]
  })
})

afterEach(() => {
  cleanup()
  // 真实应用里 disconnectSession 会 unregister;测试替身没有注册过,删键幂等
  useTerminalStore.getState().unregisterTerminal(SESSION_ID)
})

describe('PaneView 空态焦点:内容页签全关后命令屏收回键盘', () => {
  it('纯终端流:会话长出又关掉(根被换新 id),命令屏重新聚焦', () => {
    render(<Harness />)
    expect(document.activeElement).toBe(inputOf())

    act(() => { pane().addSessionToPane('pane-1', SESSION_ID) })
    // 有会话即无命令屏(条件渲染让位给终端)
    expect(screen.queryByRole('textbox')).toBeNull()

    act(() => { pane().removeSessionFromPane('pane-1', SESSION_ID) })
    // 关掉最后一个会话:根叶子被换成新 id(removePaneAndMerge 的换根路径),
    // activePaneId 必须收敛到新根 —— paneActive 为真,焦点才收得回来
    const root = pane().layout.root as PaneLeaf
    expect(root.type).toBe('leaf')
    expect(root.id).not.toBe('pane-1')
    expect(pane().layout.activePaneId).toBe(root.id)
    expect(document.activeElement).toBe(inputOf())
  })

  it('清单流(先关终端):关终端 → 清单停驻不盖屏,命令屏立即收回键盘', async () => {
    render(<Harness />)
    let docId = ''
    act(() => { docId = pane().openDocTab('pane-1', docPayload('lyshell://inventory')) })
    // 激活中的清单内联为命令屏输出区(md 在上、prompt 在下):输入框保持聚焦
    expect(document.activeElement).toBe(inputOf())
    // 文档内容真渲染进了输出区(lazy MarkdownDoc 需等一拍;全量并发跑时模块
    // 加载可能超默认 1s,放宽到 3s 防抖)
    expect(await screen.findByText('session-one', {}, { timeout: 3000 })).toBeTruthy()

    act(() => { pane().addSessionToPane('pane-1', SESSION_ID) })
    expect(screen.queryByRole('textbox')).toBeNull()

    act(() => { pane().removeSessionFromPane('pane-1', SESSION_ID) })
    // ★ 用户实测断点:pane 因承载清单保留,但 doc 不参与关终端后的自动激活
    // (activateOnLastTerminalClose=false)—— 停驻成页签,命令屏立即接管键盘
    const root = pane().layout.root as PaneLeaf
    expect(root.type).toBe('leaf')
    expect(root.overlays).toHaveLength(1)
    expect(root.overlays[0].active).toBe(false)  // 停驻,不自动弹回
    expect(pane().layout.activePaneId).toBe(root.id)
    expect(document.activeElement).toBe(inputOf())

    // 停驻的清单手动关掉:空 pane,焦点保持
    act(() => { pane().closeDocTab(docId) })
    expect((pane().layout.root as PaneLeaf).overlays).toHaveLength(0)
    expect(document.activeElement).toBe(inputOf())
  })

  it('清单流(先关清单):两步都关完,焦点收回', () => {
    render(<Harness />)
    let docId = ''
    act(() => { docId = pane().openDocTab('pane-1', docPayload('lyshell://inventory')) })

    act(() => { pane().addSessionToPane('pane-1', SESSION_ID) })
    act(() => { pane().closeDocTab(docId) })
    // 只剩终端,命令屏不挂载;此时终端可输入(替身不聚焦,跳过终端断言)

    act(() => { pane().removeSessionFromPane('pane-1', SESSION_ID) })
    expect(pane().layout.activePaneId).toBe((pane().layout.root as PaneLeaf).id)
    expect(document.activeElement).toBe(inputOf())
  })

  it('停驻页签的 ✕:mousedown 焦点不搬家,关掉后键盘仍在命令屏', () => {
    render(<Harness />)
    act(() => { pane().openDocTab('pane-1', docPayload('lyshell://inventory')) })
    act(() => { pane().addSessionToPane('pane-1', SESSION_ID) })
    act(() => { pane().removeSessionFromPane('pane-1', SESSION_ID) })
    // 停驻态:页签行可见清单页签,✕ 是可聚焦 button —— 点击即关闭、随之卸载,
    // 拦下 mousedown 的默认焦点搬迁,不给"关完页签焦点落到 body"留缝。
    // 同标题的 ✕ 还有一枚:停驻 doc 由 OverlayHost 以 visibility:hidden 常驻
    // (DocHeader 的关闭钮),按 .pane-tab 选中页签行上那枚
    const closeBtn = screen.getAllByTitle('Close document tab')
      .find(el => el.closest('.pane-tab')) as HTMLButtonElement
    const evt = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })
    closeBtn.dispatchEvent(evt)
    expect(evt.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(inputOf())

    // 真点掉:doc 关闭、pane 归空,焦点仍在 prompt
    act(() => { fireEvent.click(closeBtn) })
    expect((pane().layout.root as PaneLeaf).overlays).toHaveLength(0)
    expect(document.activeElement).toBe(inputOf())
  })

  it('分屏流:另一格的终端关掉回并后,焦点落回空格的命令屏', () => {
    render(<Harness />)
    // 先有终端再拆屏:firstChild 继承会话、secondChild 是空格(命令屏),且 second 激活
    act(() => { pane().addSessionToPane('pane-1', SESSION_ID) })
    act(() => { pane().splitPane('pane-1', 'horizontal') })
    const leaves = pane().getAllLeafPanes()
    expect(leaves).toHaveLength(2)
    const paneA = leaves.find(l => l.sessions.includes(SESSION_ID))
    const paneB = leaves.find(l => l.sessions.length === 0)
    expect(paneA && paneB).toBeTruthy()
    // 拆屏即激活空格:命令屏在 B 格且聚焦
    expect(pane().layout.activePaneId).toBe(paneB!.id)
    expect(document.activeElement).toBe(inputOf())

    // 用户点回 A 格的终端(setActivePane + 焦点归终端;替身不聚焦,手动 blur 模拟)
    act(() => { pane().setActivePane(paneA!.id) })
    ;(inputOf() as HTMLInputElement).blur()

    // A 格最后一个页签关掉 → split 回并成单叶(兄弟也是空叶,removePaneAndMerge
    // 向上合并时换成新根),焦点从已消失的 A 落回命令屏
    act(() => { pane().removeSessionFromPane(paneA!.id, SESSION_ID) })
    const root = pane().layout.root as PaneLeaf
    expect(root.type).toBe('leaf')
    expect(root.sessions).toHaveLength(0)
    expect(root.overlays).toHaveLength(0)
    // 命令屏所在叶子必须恰好是活动 pane —— paneActive 为真,焦点才收得回来
    expect(pane().layout.activePaneId).toBe(root.id)
    expect(document.activeElement).toBe(inputOf())
  })
})

describe('PaneView 空态焦点:全局命令面板关闭后接回', () => {
  // 面板盖在终端区之上(Ctrl+Shift+P / 「+」),关闭卸载时焦点摔到 body;空态
  // 命令屏的 paneActive/covered 都没变、聚焦 effect 不重跑 —— 靠 PALETTE_CLOSED_EVENT
  // 接回。这里走真实 PaneView 挂载链(paneActive 由 store 收敛),blur 模拟面板
  // 卸载后的"焦点悬空"终态
  it('面板关闭(事件)后,焦点悬空(body)时命令屏接回键盘', () => {
    render(<Harness />)
    expect(document.activeElement).toBe(inputOf())

    inputOf().blur()
    expect(document.activeElement).toBe(document.body)
    window.dispatchEvent(new CustomEvent(PALETTE_CLOSED_EVENT))
    expect(document.activeElement).toBe(inputOf())
  })
})
