// @vitest-environment jsdom
/**
 * dshWebTabIndex 维护逻辑的 store 级测试（纯逻辑，不渲染组件）。
 *
 * web 页签插槽存的是 pane.sessions 原始坐标的插入位，四条维护路径：
 * 1) 关闭会话 → removeSessionFromPane 按删除位置递减
 * 2) 会话重排 → reorderSessionsInPane 按"先删后插"坐标修正（含落点恰在 web 空隙的方向消歧）
 * 3) 会话拖到 web 页签 → insertSessionAtWebSlot 一次 set 完成重排+插槽
 * 4) web 挂载/激活/关闭 → 复位或保留
 * 这里的用例锁住各路径的坐标推导 —— 组件侧只做事件搬运，不掺坐标计算。
 */
import { describe, expect, it } from 'vitest'
import { usePaneStore, normalizeWebBarUrl, loadWebTabHistory, recordWebTabUrlToHistory } from './pane-store'
import type { PaneLeaf, PaneLayout, PaneNode } from '@shared/types'

const leaf = (id: string, sessions: string[]): PaneLeaf => ({
  id,
  type: 'leaf',
  sessions,
  activeSessionId: sessions[0] ?? null
})

const layoutOf = (root: PaneNode): PaneLayout => ({ root, activePaneId: root.type === 'leaf' ? root.id : '' })

const WEB_INFO = { url: 'http://127.0.0.1:3080', name: 'dsh web' }

// 基线：单 pane + web 挂同 pane。tabIndex 指定插槽（pane.sessions 原始坐标，null=钉尾）
const setup = (tabIndex: number | null, sessions = ['s-a', 's-b', 's-c'], extra: Record<string, unknown> = {}) => {
  usePaneStore.setState({
    layout: layoutOf(leaf('pane-1', sessions)),
    dshWeb: WEB_INFO,
    dshWebPaneId: 'pane-1',
    dshWebActive: true,
    dshWebTabIndex: tabIndex,
    mcpAuditPaneId: null,
    mcpAuditActive: false,
    draggingDshWeb: false,
    hiddenTabSessions: {},
    ...extra
  })
}

const paneSessions = (): string[] =>
  (usePaneStore.getState().getPaneById('pane-1') as PaneLeaf).sessions

const tabIndex = (): number | null => usePaneStore.getState().dshWebTabIndex

describe('removeSessionFromPane：关闭会话时 web 插槽递减', () => {
  it('关闭 web 左侧会话 → 插槽左移一位', () => {
    setup(1) // s-a, web, s-b, s-c
    usePaneStore.getState().removeSessionFromPane('pane-1', 's-a')
    expect(paneSessions()).toEqual(['s-b', 's-c'])
    expect(tabIndex()).toBe(0) // web, s-b, s-c
  })

  it('关闭 web 右侧会话 → 插槽不动', () => {
    setup(1)
    usePaneStore.getState().removeSessionFromPane('pane-1', 's-c')
    expect(paneSessions()).toEqual(['s-a', 's-b'])
    expect(tabIndex()).toBe(1) // s-a, web, s-b
  })

  it('关闭 web 左侧的隐藏页签 → 插槽同样左移（索引是原始坐标，与隐藏无关），残留 hidden 记录被清理', () => {
    setup(1, ['s-a', 's-b', 's-c'], { hiddenTabSessions: { 's-a': true } })
    usePaneStore.getState().removeSessionFromPane('pane-1', 's-a')
    expect(paneSessions()).toEqual(['s-b', 's-c'])
    expect(tabIndex()).toBe(0)
    expect(usePaneStore.getState().hiddenTabSessions).toEqual({})
  })

  it('关掉最后一个终端页签（web 未激活）→ 自动切到 web 页签，插槽保持 null 不被误写', () => {
    setup(null, ['s-a'], { dshWebActive: false })
    usePaneStore.getState().removeSessionFromPane('pane-1', 's-a')
    expect(usePaneStore.getState().dshWebActive).toBe(true)
    expect(tabIndex()).toBe(null)
    // pane 因承载 web 保留，不随会话清空被合并掉
    expect(usePaneStore.getState().getPaneById('pane-1')).toBeTruthy()
  })
})

describe('reorderSessionsInPane：会话重排时 web 插槽同步修正', () => {
  it('从右侧拖到 web 右邻页签（落点恰在 web 空隙，从右往左）→ 新页签落 web 后面，插槽不动', () => {
    setup(1) // s-a, web, s-b, s-c
    usePaneStore.getState().reorderSessionsInPane('pane-1', 2, 1)
    expect(paneSessions()).toEqual(['s-a', 's-c', 's-b'])
    expect(tabIndex()).toBe(1) // s-a, web, s-c, s-b —— web 不跳过落点页签 s-b
  })

  it('从左侧拖到 web 右邻页签（落点恰在 web 空隙，从左往右）→ 新页签落 web 前面，插槽右移', () => {
    setup(1) // s-a, web, s-b, s-c
    usePaneStore.getState().reorderSessionsInPane('pane-1', 0, 1)
    expect(paneSessions()).toEqual(['s-b', 's-a', 's-c'])
    expect(tabIndex()).toBe(0) // web, s-b, s-a, s-c
  })

  it('右侧会话拖到最左 → 插槽右移', () => {
    setup(1)
    usePaneStore.getState().reorderSessionsInPane('pane-1', 2, 0)
    expect(paneSessions()).toEqual(['s-c', 's-a', 's-b'])
    expect(tabIndex()).toBe(2) // s-c, s-a, web, s-b —— web 保持在 s-a/s-b 之间
  })

  it('左侧会话拖到最右（跨过 web）→ 插槽左移', () => {
    setup(1)
    usePaneStore.getState().reorderSessionsInPane('pane-1', 0, 2)
    expect(paneSessions()).toEqual(['s-b', 's-c', 's-a'])
    expect(tabIndex()).toBe(0) // web, s-b, s-c, s-a
  })

  it('web 居后（插槽 2）时左侧会话拖到 web 左邻 → 落 web 前面，插槽右移', () => {
    setup(2) // s-a, s-b, web, s-c
    usePaneStore.getState().reorderSessionsInPane('pane-1', 0, 1)
    expect(paneSessions()).toEqual(['s-b', 's-a', 's-c'])
    expect(tabIndex()).toBe(2) // s-b, s-a, web, s-c
  })

  it('四页签场景：右侧会话拖到 web 右邻（空隙右侧进入）→ 插槽不动', () => {
    setup(2, ['s-a', 's-b', 's-c', 's-d']) // s-a, s-b, web, s-c, s-d
    usePaneStore.getState().reorderSessionsInPane('pane-1', 3, 2)
    expect(paneSessions()).toEqual(['s-a', 's-b', 's-d', 's-c'])
    expect(tabIndex()).toBe(2) // s-a, s-b, web, s-d, s-c
  })

  // 隐藏页签 + web 中段插槽：插槽与重排坐标都在 pane.sessions 原始系（含隐藏页签），
  // 可见位置 = 过滤掉隐藏后再按插槽换算。这是最易回归的边界 —— 任何一侧误用可见坐标都会错位
  describe('隐藏页签在场时的重排（原始坐标系）', () => {
    // 基线：[s-a, s-b(隐藏), s-c]，插槽 1 → 可见 s-a, web, s-c
    const setupHidden = () => setup(1, ['s-a', 's-b', 's-c'], { hiddenTabSessions: { 's-b': true } })

    it('可见页签从右侧拖到最左 → 插槽右移，隐藏页签不参与可见换算', () => {
      setupHidden()
      usePaneStore.getState().reorderSessionsInPane('pane-1', 2, 0) // s-c(原2) → 0
      expect(paneSessions()).toEqual(['s-c', 's-a', 's-b'])
      expect(tabIndex()).toBe(2) // 可见 s-c, s-a, web（web 保持在 s-a 与隐藏的 s-b 之间）
    })

    it('可见页签从左侧拖到最右 → 插槽左移，web 顶到可见首位', () => {
      setupHidden()
      usePaneStore.getState().reorderSessionsInPane('pane-1', 0, 2) // s-a(原0) → 2
      expect(paneSessions()).toEqual(['s-b', 's-c', 's-a'])
      expect(tabIndex()).toBe(0) // 可见 web, s-c, s-a
    })

    it('隐藏页签自身被重排 → 可见顺序与 web 可见位置都不变', () => {
      setupHidden()
      usePaneStore.getState().reorderSessionsInPane('pane-1', 1, 0) // s-b(隐藏) → 0
      expect(paneSessions()).toEqual(['s-b', 's-a', 's-c'])
      expect(tabIndex()).toBe(2) // 可见仍是 s-a, web, s-c —— 只动隐藏坐标不动可见渲染
    })
  })
})

describe('insertSessionAtWebSlot：会话拖到 web 页签上的落点', () => {
  it('从左侧拖来（往右拖）→ 插 web 后面', () => {
    setup(1) // s-a, web, s-b, s-c
    usePaneStore.getState().insertSessionAtWebSlot('pane-1', 's-a')
    expect(paneSessions()).toEqual(['s-a', 's-b', 's-c'])
    expect(tabIndex()).toBe(0) // web, s-a, s-b, s-c
  })

  it('从右侧拖来（往左拖，紧邻 web 的页签）→ 插 web 前面', () => {
    setup(1)
    usePaneStore.getState().insertSessionAtWebSlot('pane-1', 's-b')
    expect(paneSessions()).toEqual(['s-a', 's-b', 's-c'])
    expect(tabIndex()).toBe(2) // s-a, s-b, web, s-c
  })

  it('从右侧远处拖来 → 插 web 前面，原相对顺序保持', () => {
    setup(1)
    usePaneStore.getState().insertSessionAtWebSlot('pane-1', 's-c')
    expect(paneSessions()).toEqual(['s-a', 's-c', 's-b'])
    expect(tabIndex()).toBe(2) // s-a, s-c, web, s-b
  })

  it('web 钉尾（插槽 null）时从左侧拖来 → 落 web 后面即队尾', () => {
    setup(null)
    usePaneStore.getState().insertSessionAtWebSlot('pane-1', 's-a')
    expect(paneSessions()).toEqual(['s-b', 's-c', 's-a'])
    expect(tabIndex()).toBe(2) // s-b, s-c, web, s-a
  })
})

describe('addSessionToPane：追加会话时的插槽同步', () => {
  it('web 在中段 → 插槽不动，新页签落在末位（渲染在 web 之后）', () => {
    setup(1) // s-a, web, s-b, s-c
    usePaneStore.getState().addSessionToPane('pane-1', 's-x')
    expect(paneSessions()).toEqual(['s-a', 's-b', 's-c', 's-x'])
    expect(tabIndex()).toBe(1) // s-a, web, s-b, s-c, s-x
  })

  it('web 在显式末位（拖到页签条空白处落的位）→ 插槽跟到新末尾，web 不被新页签顶到 MCP 前', () => {
    setup(3) // s-a, s-b, s-c, (MCP), web
    usePaneStore.getState().addSessionToPane('pane-1', 's-x')
    expect(paneSessions()).toEqual(['s-a', 's-b', 's-c', 's-x'])
    expect(tabIndex()).toBe(4) // s-a, s-b, s-c, s-x, (MCP), web —— web 保持钉尾
  })

  it('web 钉尾（null）→ 保持 null 不被误写成显式索引', () => {
    setup(null)
    usePaneStore.getState().addSessionToPane('pane-1', 's-x')
    expect(tabIndex()).toBe(null)
  })

  it('末位 web 的 pane 里移除又加回同一会话 → 移除时递减、加回时跟尾，web 全程保持末位', () => {
    setup(3) // s-a, s-b, s-c, (MCP), web
    usePaneStore.getState().removeSessionFromPane('pane-1', 's-c')
    expect(tabIndex()).toBe(2) // s-a, s-b, (MCP), web
    usePaneStore.getState().addSessionToPane('pane-1', 's-c')
    expect(paneSessions()).toEqual(['s-a', 's-b', 's-c'])
    expect(tabIndex()).toBe(3) // 回到 s-a, s-b, s-c, (MCP), web
  })
})

describe('moveDshWebToSessionTab：web 页签拖到普通页签上的落点', () => {
  it('往左拖（目标在 web 左侧）→ 插到目标前面', () => {
    setup(1) // s-a, web, s-b, s-c
    usePaneStore.getState().moveDshWebToSessionTab('pane-1', 's-a')
    expect(paneSessions()).toEqual(['s-a', 's-b', 's-c']) // 不动 sessions
    expect(tabIndex()).toBe(0) // web, s-a, s-b, s-c
  })

  it('往右拖（目标在 web 右侧）→ 插到目标后面', () => {
    setup(1)
    usePaneStore.getState().moveDshWebToSessionTab('pane-1', 's-b')
    expect(tabIndex()).toBe(2) // s-a, s-b, web, s-c —— 拖到右侧相邻页签不再是 no-op
  })

  it('往右拖到更远的目标 → 同样落在目标后面', () => {
    setup(1)
    usePaneStore.getState().moveDshWebToSessionTab('pane-1', 's-c')
    expect(tabIndex()).toBe(3) // s-a, s-b, s-c, web
  })

  it('web 钉尾（null）时往左拖 → 落到目标前面（null 视作末尾参与方向判定）', () => {
    setup(null)
    usePaneStore.getState().moveDshWebToSessionTab('pane-1', 's-b')
    expect(tabIndex()).toBe(1) // s-a, web, s-b, s-c
  })

  it('web 不在该 pane / 目标会话不在 pane → 不动', () => {
    setup(1)
    usePaneStore.getState().moveDshWebToSessionTab('pane-other', 's-a')
    usePaneStore.getState().moveDshWebToSessionTab('pane-1', 's-missing')
    expect(tabIndex()).toBe(1)
  })
})

describe('store API 防御性边界', () => {
  it('setDshWebTabIndex clamp 到 [0, 承载 pane 会话数]', () => {
    setup(1)
    usePaneStore.getState().setDshWebTabIndex(99)
    expect(tabIndex()).toBe(3)
    usePaneStore.getState().setDshWebTabIndex(-5)
    expect(tabIndex()).toBe(0)
    usePaneStore.getState().setDshWebTabIndex(null)
    expect(tabIndex()).toBe(null)
  })

  it('web 未挂载时 setDshWebTabIndex 忽略（复位路径不走此 action）', () => {
    setup(1)
    usePaneStore.getState().closeDshWeb()
    usePaneStore.getState().setDshWebTabIndex(2)
    expect(tabIndex()).toBe(null)
  })

  it('insertSessionAtWebSlot 对非 web 承载 pane 拒绝（不动 sessions 不动插槽）', () => {
    setup(1)
    // 双 pane 布局：web 挂 pane-1，往 pane-2 塞会话不应触碰 pane-1 的 web 插槽
    usePaneStore.setState({
      layout: {
        root: {
          id: 'split-1',
          type: 'split',
          direction: 'horizontal',
          splitRatio: 0.5,
          firstChild: leaf('pane-1', ['s-a', 's-b', 's-c']),
          secondChild: leaf('pane-2', ['s-z'])
        },
        activePaneId: 'pane-1'
      }
    })
    usePaneStore.getState().insertSessionAtWebSlot('pane-2', 's-z')
    expect(tabIndex()).toBe(1)
    expect((usePaneStore.getState().getPaneById('pane-2') as PaneLeaf).sessions).toEqual(['s-z'])
  })
})

describe('splitDshWebIntoPane：web 拆进独立 pane 时的插槽复位', () => {
  it('目标 pane 有会话（走 split 分支）→ 复位 null，旧 pane 坐标不残留', () => {
    setup(1) // s-a, web, s-b, s-c
    usePaneStore.getState().splitDshWebIntoPane('pane-1', 'horizontal', 'second')
    expect(tabIndex()).toBe(null)
    // web 已挂到新空 pane；原 pane 的会话留在另一侧
    const webPaneId = usePaneStore.getState().dshWebPaneId
    expect(webPaneId).not.toBe('pane-1')
    expect((usePaneStore.getState().getPaneById(webPaneId!) as PaneLeaf).sessions).toEqual([])
  })

  it('目标 pane 无会话（直接改挂载分支）→ 同样复位 null', () => {
    setup(1)
    usePaneStore.setState({
      layout: {
        root: {
          id: 'split-1',
          type: 'split',
          direction: 'horizontal',
          splitRatio: 0.5,
          firstChild: leaf('pane-1', ['s-a', 's-b', 's-c']),
          secondChild: leaf('pane-2', [])
        },
        activePaneId: 'pane-1'
      }
    })
    usePaneStore.getState().splitDshWebIntoPane('pane-2', 'horizontal', 'first')
    expect(tabIndex()).toBe(null)
    expect(usePaneStore.getState().dshWebPaneId).toBe('pane-2')
  })
})

describe('web 挂载/激活/关闭时的插槽复位', () => {
  it('activateDshWeb 保留插槽（仅切换显隐不动排序）', () => {
    setup(1, ['s-a', 's-b', 's-c'], { dshWebActive: false })
    usePaneStore.getState().activateDshWeb()
    expect(tabIndex()).toBe(1)
  })

  it('openDshWebInPane 重开 → 插槽复位 null（钉尾）', () => {
    setup(1)
    usePaneStore.getState().openDshWebInPane('pane-1', WEB_INFO)
    expect(tabIndex()).toBe(null)
  })

  it('closeDshWeb 关闭 → 插槽复位 null', () => {
    setup(1)
    usePaneStore.getState().closeDshWeb()
    expect(tabIndex()).toBe(null)
    expect(usePaneStore.getState().dshWeb).toBe(null)
  })
})

// ===== 网页访问栏页签（webTabs，多开）=====
// 基线：单 pane + 可选 dshWeb/MCP 共存，webTabs 由用例自行构造。
// setupWeb 复用 setup 的 dshWeb 基线并重置 webTabs 与历史（含 localStorage），避免用例间泄漏。
const setupWeb = (extra: Record<string, unknown> = {}, sessions = ['s-a', 's-b']) => {
  localStorage.removeItem('lyshell.webTabHistory.v1')
  usePaneStore.setState({
    layout: layoutOf(leaf('pane-1', sessions)),
    dshWeb: null,
    dshWebPaneId: null,
    dshWebActive: false,
    dshWebTabIndex: null,
    mcpAuditPaneId: null,
    mcpAuditActive: false,
    draggingDshWeb: false,
    hiddenTabSessions: {},
    webTabs: [],
    webTabHistory: [],
    ...extra
  })
}

const webTabIds = (): string[] => usePaneStore.getState().webTabs.map(t => t.id)
const activeWebTabInPane = (paneId: string): string | undefined =>
  usePaneStore.getState().webTabs.find(t => t.paneId === paneId && t.active)?.id

describe('normalizeWebBarUrl：网页访问栏 URL 归一化', () => {
  it('无 scheme 补 https', () => {
    expect(normalizeWebBarUrl('example.com/path')).toBe('https://example.com/path')
  })

  it('已有 scheme 原样保留（仅归一化）', () => {
    expect(normalizeWebBarUrl('http://127.0.0.1:8080/')).toBe('http://127.0.0.1:8080/')
  })

  it('非 http/https 协议拒绝', () => {
    expect(normalizeWebBarUrl('file:///C:/Windows')).toBeNull()
    expect(normalizeWebBarUrl('javascript:alert(1)')).toBeNull()
  })

  it('不可解析 / 空输入拒绝', () => {
    expect(normalizeWebBarUrl('')).toBeNull()
    expect(normalizeWebBarUrl('   ')).toBeNull()
    expect(normalizeWebBarUrl('https://')).toBeNull() // 无 hostname
  })
})

describe('openWebTab：打开网页页签', () => {
  it('挂到活动 pane 并激活，activePaneId 同步切换', () => {
    setupWeb()
    const res = usePaneStore.getState().openWebTab('example.com')
    expect(res.ok).toBe(true)
    const st = usePaneStore.getState()
    expect(st.webTabs).toHaveLength(1)
    expect(st.webTabs[0].paneId).toBe('pane-1')
    expect(st.webTabs[0].url).toBe('https://example.com/')
    expect(st.webTabs[0].title).toBe('example.com')
    expect(st.webTabs[0].active).toBe(true)
    expect(st.layout.activePaneId).toBe('pane-1')
  })

  it('activePaneId 未就绪时回落首个叶子 pane', () => {
    setupWeb()
    usePaneStore.setState({ layout: { ...layoutOf(leaf('pane-1', [])), activePaneId: '' } })
    const res = usePaneStore.getState().openWebTab('https://example.com')
    expect(res.ok).toBe(true)
    expect(usePaneStore.getState().webTabs[0].paneId).toBe('pane-1')
  })

  it('非法 URL 拒绝且不动 store', () => {
    setupWeb()
    const res = usePaneStore.getState().openWebTab('not a url')
    expect(res.ok).toBe(false)
    expect(usePaneStore.getState().webTabs).toHaveLength(0)
  })

  it('多开：每个 URL 一个独立页签，旧页签被去活（每 pane 至多一个激活）', () => {
    setupWeb()
    usePaneStore.getState().openWebTab('https://a.example.com')
    usePaneStore.getState().openWebTab('https://b.example.com')
    const st = usePaneStore.getState()
    expect(st.webTabs).toHaveLength(2)
    expect(activeWebTabInPane('pane-1')).toBe(st.webTabs[1].id)
  })

  it('同 pane 互斥：激活网页页签去活 dshWeb 与 MCP', () => {
    setupWeb({
      dshWeb: WEB_INFO, dshWebPaneId: 'pane-1', dshWebActive: true,
      mcpAuditPaneId: 'pane-1', mcpAuditActive: true
    })
    usePaneStore.getState().openWebTab('https://example.com')
    const st = usePaneStore.getState()
    expect(st.dshWebActive).toBe(false)
    expect(st.mcpAuditActive).toBe(false)
    expect(activeWebTabInPane('pane-1')).toBeTruthy()
  })

  it('反向互斥：激活 dshWeb / MCP 去活同 pane 网页页签（页签保留）', () => {
    setupWeb({ dshWeb: WEB_INFO, dshWebPaneId: 'pane-1' })
    usePaneStore.getState().openWebTab('https://example.com')
    usePaneStore.getState().activateDshWeb()
    expect(usePaneStore.getState().dshWebActive).toBe(true)
    expect(activeWebTabInPane('pane-1')).toBeUndefined()
    expect(webTabIds()).toHaveLength(1) // 仅隐藏未删除

    usePaneStore.getState().openMcpAuditInPane('pane-1')
    expect(usePaneStore.getState().mcpAuditActive).toBe(true)
    expect(usePaneStore.getState().dshWebActive).toBe(false)
  })
})

describe('activateWebTab / deactivateWebTabsInPane', () => {
  it('点页签激活目标、去活同 pane 其余 webTab，activePaneId 切到承载 pane', () => {
    setupWeb()
    usePaneStore.getState().openWebTab('https://a.example.com')
    usePaneStore.getState().openWebTab('https://b.example.com')
    const first = webTabIds()[0]
    usePaneStore.getState().activateWebTab(first)
    const st = usePaneStore.getState()
    expect(activeWebTabInPane('pane-1')).toBe(first)
    expect(st.layout.activePaneId).toBe('pane-1')
  })

  it('deactivateWebTabsInPane 隐藏本 pane 全部网页页签（页签保留）', () => {
    setupWeb()
    usePaneStore.getState().openWebTab('https://a.example.com')
    usePaneStore.getState().deactivateWebTabsInPane('pane-1')
    const st = usePaneStore.getState()
    expect(st.webTabs).toHaveLength(1)
    expect(st.webTabs[0].active).toBe(false)
  })
})

describe('closeWebTab：关闭网页页签', () => {
  it('关掉激活页签 → 切到同 pane 最后一个网页页签（浏览器惯例）', () => {
    setupWeb()
    usePaneStore.getState().openWebTab('https://a.example.com')
    usePaneStore.getState().openWebTab('https://b.example.com')
    const second = webTabIds()[1]
    usePaneStore.getState().closeWebTab(second)
    const st = usePaneStore.getState()
    expect(st.webTabs).toHaveLength(1)
    expect(st.webTabs[0].active).toBe(true)
  })

  it('关掉非激活页签 → 不动当前激活页签', () => {
    setupWeb()
    usePaneStore.getState().openWebTab('https://a.example.com')
    usePaneStore.getState().openWebTab('https://b.example.com')
    const first = webTabIds()[0]
    usePaneStore.getState().closeWebTab(first)
    const st = usePaneStore.getState()
    expect(st.webTabs).toHaveLength(1)
    expect(st.webTabs[0].active).toBe(true)
  })

  it('关掉唯一激活页签且无其余 webTab → 回到终端（页签清空，无激活残留）', () => {
    setupWeb()
    usePaneStore.getState().openWebTab('https://a.example.com')
    usePaneStore.getState().closeWebTab(webTabIds()[0])
    expect(usePaneStore.getState().webTabs).toHaveLength(0)
  })
})

describe('webTabs 与 pane 生命周期', () => {
  it('关掉最后一个终端页签 → pane 因承载网页页签保留，并自动切到该网页页签', () => {
    setupWeb({}, ['s-a'])
    usePaneStore.getState().openWebTab('https://example.com')
    usePaneStore.getState().deactivateWebTabsInPane('pane-1')
    usePaneStore.getState().removeSessionFromPane('pane-1', 's-a')
    const st = usePaneStore.getState()
    // pane 未被 removePaneAndMerge 删除（isOverlayPane 保护）
    expect(st.getPaneById('pane-1')).toBeTruthy()
    // 自动激活剩余的网页页签（否则窗格只剩空态占位）
    expect(activeWebTabInPane('pane-1')).toBeTruthy()
  })

  it('承载 pane 被 closePane 删除 → 网页页签一并回收（无孤儿 webview 状态）', () => {
    setupWeb()
    usePaneStore.getState().openWebTab('https://example.com')
    usePaneStore.getState().closePane('pane-1')
    expect(usePaneStore.getState().webTabs).toHaveLength(0)
  })

  it('仅剩网页页签的空 pane 不随会话清空被 removeEmptyPanes 合并掉', () => {
    setupWeb({}, ['s-a'])
    usePaneStore.getState().openWebTab('https://example.com')
    usePaneStore.getState().removeSessionFromPane('pane-1', 's-a')
    expect(usePaneStore.getState().getPaneById('pane-1')).toBeTruthy()
  })
})

// ===== 拖拽分屏 × 覆盖层迁移 =====
// splitPane / splitPaneWithPosition 会把目标叶子原地替换为 split（叶子 id 变成 split id，
// 会话落到新建 id 的子叶子）—— 承载在该叶子上的 webTabs / dshWeb 若不随迁会变成僵尸：
// findPane 按 id 仍能找到 split 节点，prune 不触发，但没有任何叶子渲染它。
describe('splitPane / splitPaneWithPosition：拖拽分屏时覆盖层迁移', () => {
  it('splitPane 拆分承载 webTab 的 pane → webTab 迁到继承原会话的第一子叶子', () => {
    setupWeb({}, ['s-a', 's-b'])
    usePaneStore.getState().openWebTab('https://example.com')
    usePaneStore.getState().splitPane('pane-1', 'vertical', 's-b')
    const st = usePaneStore.getState()
    expect(st.webTabs).toHaveLength(1)
    // 挂载点是叶子（而非变成 split 的 pane-1），且承载原会话
    const host = st.getPaneById(st.webTabs[0].paneId) as PaneLeaf
    expect(host.type).toBe('leaf')
    expect(host.sessions).toContain('s-a')
    expect(st.webTabs[0].active).toBe(true)
  })

  it("splitPaneWithPosition position='first' → webTab 迁到继承原会话的第二子叶子（position 反侧）", () => {
    setupWeb({}, ['s-a', 's-b'])
    usePaneStore.getState().openWebTab('https://example.com')
    usePaneStore.getState().splitPaneWithPosition('pane-1', 'vertical', 's-c', 'first')
    const st = usePaneStore.getState()
    const host = st.getPaneById(st.webTabs[0].paneId) as PaneLeaf
    expect(host.type).toBe('leaf')
    expect(host.sessions).toEqual(['s-a', 's-b']) // 原会话整组继承，不含新拖入的 s-c
  })

  it('splitPane 同步迁移 dshWeb 承载 pane（不触发孤儿回收，dshWebPaneId 指向新叶子）', () => {
    setupWeb({ dshWeb: WEB_INFO, dshWebPaneId: 'pane-1', dshWebActive: true }, ['s-a', 's-b'])
    usePaneStore.getState().splitPane('pane-1', 'vertical', 's-b')
    const st = usePaneStore.getState()
    expect(st.dshWeb).toBeTruthy() // 未被 pruneOrphanedDshWeb 误关
    expect(st.dshWebPaneId).not.toBe('pane-1')
    const host = st.getPaneById(st.dshWebPaneId!) as PaneLeaf
    expect(host.type).toBe('leaf')
    expect(host.sessions).toContain('s-a')
  })

  it('承载 pane 无覆盖层时 splitPane → 迁移为空操作（布局不受影响）', () => {
    setupWeb({}, ['s-a', 's-b'])
    usePaneStore.getState().splitPane('pane-1', 'vertical', 's-b')
    const st = usePaneStore.getState()
    expect(st.webTabs).toEqual([])
    expect(st.getAllLeafPanes()).toHaveLength(2)
  })
})

// ===== 网页访问栏历史（webTabHistory，localStorage 持久化）=====
describe('recordWebTabUrlToHistory：纯函数记录规则', () => {
  it('新 URL 前置插入', () => {
    expect(recordWebTabUrlToHistory(['https://a.example.com'], 'https://b.example.com'))
      .toEqual(['https://b.example.com', 'https://a.example.com'])
  })

  it('重复 URL 去重并前移到最近', () => {
    const history = ['https://a.example.com', 'https://b.example.com', 'https://c.example.com']
    expect(recordWebTabUrlToHistory(history, 'https://b.example.com'))
      .toEqual(['https://b.example.com', 'https://a.example.com', 'https://c.example.com'])
  })

  it('超出封顶截尾（最近优先保留）', () => {
    const history = Array.from({ length: 40 }, (_, i) => `https://old${i}.example.com`)
    const next = recordWebTabUrlToHistory(history, 'https://new.example.com')
    expect(next).toHaveLength(30)
    expect(next[0]).toBe('https://new.example.com')
    expect(next[next.length - 1]).toBe('https://old28.example.com')
  })
})

describe('openWebTab 与历史的边界：打开动作本身不记录', () => {
  it('openWebTab 成功 → 不写历史（记录时机在 webview did-finish-load）', () => {
    setupWeb()
    usePaneStore.getState().openWebTab('example.com')
    expect(usePaneStore.getState().webTabHistory).toEqual([])
    expect(localStorage.getItem('lyshell.webTabHistory.v1')).toBeNull()
  })

  it('openWebTab 非法 URL → 同样不记录', () => {
    setupWeb()
    usePaneStore.getState().openWebTab('not a url')
    expect(usePaneStore.getState().webTabHistory).toEqual([])
    expect(localStorage.getItem('lyshell.webTabHistory.v1')).toBeNull()
  })
})

describe('recordWebTabVisit：页面加载成功后记录历史', () => {
  it('记录 URL 并持久化到 localStorage', () => {
    setupWeb()
    usePaneStore.getState().recordWebTabVisit('https://a.example.com/')
    const st = usePaneStore.getState()
    expect(st.webTabHistory).toEqual(['https://a.example.com/'])
    expect(JSON.parse(localStorage.getItem('lyshell.webTabHistory.v1') ?? '[]'))
      .toEqual(['https://a.example.com/'])
  })

  it('重复记录同 URL → 去重前移，不产生重复条目', () => {
    setupWeb()
    usePaneStore.getState().recordWebTabVisit('https://a.example.com/')
    usePaneStore.getState().recordWebTabVisit('https://b.example.com/')
    usePaneStore.getState().recordWebTabVisit('https://a.example.com/')
    expect(usePaneStore.getState().webTabHistory)
      .toEqual(['https://a.example.com/', 'https://b.example.com/'])
  })

  it('已在顶部时重复记录 → 直接跳过（did-finish-load 幂等闸）', () => {
    setupWeb()
    usePaneStore.getState().recordWebTabVisit('https://a.example.com/')
    usePaneStore.getState().recordWebTabVisit('https://a.example.com/')
    expect(usePaneStore.getState().webTabHistory).toEqual(['https://a.example.com/'])
  })
})

describe('loadWebTabHistory：localStorage 读取容错', () => {
  it('正常数组原样读出', () => {
    localStorage.setItem('lyshell.webTabHistory.v1', JSON.stringify(['https://a.example.com']))
    expect(loadWebTabHistory()).toEqual(['https://a.example.com'])
  })

  it('坏数据容错：非数组/非法 JSON/缺失 → 空数组；混杂元素只保留字符串', () => {
    localStorage.setItem('lyshell.webTabHistory.v1', '{"a":1}')
    expect(loadWebTabHistory()).toEqual([])
    localStorage.setItem('lyshell.webTabHistory.v1', '["ok", 42, null]')
    expect(loadWebTabHistory()).toEqual(['ok'])
    localStorage.setItem('lyshell.webTabHistory.v1', 'not json')
    expect(loadWebTabHistory()).toEqual([])
    localStorage.removeItem('lyshell.webTabHistory.v1')
    expect(loadWebTabHistory()).toEqual([])
  })
})

describe('removeWebTabHistory / clearWebTabHistory：历史删改', () => {
  it('删除单条：store 与 localStorage 同步', () => {
    setupWeb()
    usePaneStore.getState().recordWebTabVisit('https://a.example.com/')
    usePaneStore.getState().recordWebTabVisit('https://b.example.com/')
    usePaneStore.getState().removeWebTabHistory('https://a.example.com/')
    const st = usePaneStore.getState()
    expect(st.webTabHistory).toEqual(['https://b.example.com/'])
    expect(JSON.parse(localStorage.getItem('lyshell.webTabHistory.v1') ?? '[]'))
      .toEqual(['https://b.example.com/'])
  })

  it('清空：store 置空且 localStorage 键移除', () => {
    setupWeb()
    usePaneStore.getState().recordWebTabVisit('https://a.example.com/')
    usePaneStore.getState().clearWebTabHistory()
    expect(usePaneStore.getState().webTabHistory).toEqual([])
    expect(localStorage.getItem('lyshell.webTabHistory.v1')).toBeNull()
  })
})
