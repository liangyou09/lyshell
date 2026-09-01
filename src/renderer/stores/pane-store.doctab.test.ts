// @vitest-environment jsdom
/**
 * doc 覆盖层的 store 级测试（纯逻辑，不渲染组件）—— 克隆 webtab 测试脚手架。
 *
 * 锁住的维护路径：
 * 1) 打开/复用：同 pane 同来源同路径复用页签；打开去活同 pane 其余覆盖层
 * 2) 激活互斥：doc ↔ web ↔ dshWeb ↔ MCP 四向
 * 3) 关闭：关激活页签回落同 pane 最后一个 doc；关光剩空；
 *    纯文档 pane 空出即回并还原分屏（焦点落吸收侧）
 * 4) pane 生命周期：仅剩 doc 的空 pane 不被合并；承载 pane 关闭回收页签；
 *    拖拽分屏时 doc 随迁到继承会话的子叶子
 * 5) 页签拖拽（对齐 dsh web 交互）：中心落点改挂载（源纯文档 pane 空出即清理）、
 *    四边落点拆独立 pane（会话留 keep 侧，其它覆盖层随迁）
 */
import { describe, expect, it } from 'vitest'
import { usePaneStore } from './pane-store'
import { DSH_WEB_OVERLAY_ID, MCP_AUDIT_OVERLAY_ID } from './overlay-kinds'
import type { DocOverlayPayload, OverlayPayload, OverlayRef, PaneLeaf, PaneLayout, PaneNode, PaneSplit } from '@shared/types'

const leaf = (id: string, sessions: string[], overlays: OverlayRef[] = []): PaneLeaf => ({
  id,
  type: 'leaf',
  sessions,
  activeSessionId: sessions[0] ?? null,
  overlays
})

const layoutOf = (root: PaneNode): PaneLayout => ({ root, activePaneId: root.type === 'leaf' ? root.id : '' })

const WEB_INFO = { url: 'http://127.0.0.1:3080', name: 'dsh web' }

const dshRef = (active = false): OverlayRef =>
  ({ id: DSH_WEB_OVERLAY_ID, kind: 'dshWeb', active, slot: null })

const mcpRef = (active = true): OverlayRef =>
  ({ id: MCP_AUDIT_OVERLAY_ID, kind: 'mcpAudit', active, slot: null })

// 基线：单 pane（可选 dshWeb/MCP 以 refs 构造到叶子上），doc 页签由用例自行创建
const setup = (extra: Record<string, unknown> = {}, sessions = ['s-a', 's-b'], refs: OverlayRef[] = []) => {
  const payloads: Record<string, OverlayPayload> = {}
  for (const r of refs) {
    if (r.id === DSH_WEB_OVERLAY_ID) payloads[r.id] = { kind: 'dshWeb', ...WEB_INFO }
    else if (r.id === MCP_AUDIT_OVERLAY_ID) payloads[r.id] = { kind: 'mcpAudit' }
  }
  usePaneStore.setState({
    layout: layoutOf(leaf('pane-1', sessions, refs)),
    overlayPayloads: payloads,
    draggingOverlayId: null,
    hiddenTabSessions: {},
    webTabHistory: [],
    webTabFavicons: {},
    ...extra
  })
}

const docInfo = (path: string, sessionId?: string): DocOverlayPayload => ({
  source: sessionId ? 'remote' : 'local',
  docKind: path.endsWith('.html') ? 'html' : 'markdown',
  path,
  title: path.split('/').pop() || path,
  ...(sessionId ? { sessionId } : {}),
  size: 1024,
  mtime: 1700000000000,
  content: '# hi'
})

interface DocTabView {
  id: string
  paneId: string
  active: boolean
  payload: DocOverlayPayload
}

interface WebTabView {
  id: string
  paneId: string
  active: boolean
}

// 从树 + payload 字典投影旧 docTabs/webTabs 视图（叶序 × 引用序 = 打开序）
const docTabs = (): DocTabView[] => {
  const st = usePaneStore.getState()
  const tabs: DocTabView[] = []
  for (const pane of st.getAllLeafPanes()) {
    for (const r of pane.overlays) {
      const p = st.overlayPayloads[r.id]
      if (r.kind === 'doc' && p?.kind === 'doc') {
        tabs.push({ id: r.id, paneId: pane.id, active: r.active, payload: p })
      }
    }
  }
  return tabs
}

const webTabs = (): WebTabView[] => {
  const st = usePaneStore.getState()
  const tabs: WebTabView[] = []
  for (const pane of st.getAllLeafPanes()) {
    for (const r of pane.overlays) {
      if (r.kind === 'web') tabs.push({ id: r.id, paneId: pane.id, active: r.active })
    }
  }
  return tabs
}

const docTabIds = (): string[] => docTabs().map(t => t.id)
const activeDocInPane = (paneId: string): string | undefined =>
  docTabs().find(t => t.paneId === paneId && t.active)?.id

// 取叶子当前的全部覆盖层引用（构造中途替换 layout 的用例须带着引用走，否则引用悬空）
const overlaysOf = (paneId: string): OverlayRef[] =>
  (usePaneStore.getState().getPaneById(paneId) as PaneLeaf | undefined)?.overlays ?? []

describe('openDocTab：打开与复用', () => {
  it('挂到指定 pane 并激活，activePaneId 同步切换', () => {
    setup()
    const id = usePaneStore.getState().openDocTab('pane-1', docInfo('/srv/README.md', 'sess-1'))
    const st = usePaneStore.getState()
    const tabs = docTabs()
    expect(tabs).toHaveLength(1)
    expect(tabs[0].paneId).toBe('pane-1')
    expect(tabs[0].active).toBe(true)
    expect(st.layout.activePaneId).toBe('pane-1')
    expect(typeof id).toBe('string')
  })

  it('paneId 缺省 → 落活动 pane', () => {
    setup()
    usePaneStore.getState().openDocTab(undefined, docInfo('/srv/a.md', 'sess-1'))
    expect(docTabs()[0].paneId).toBe('pane-1')
  })

  it('同 pane 同来源同路径复用页签（刷新语义），不同 pane 各开各的', () => {
    setup()
    const first = usePaneStore.getState().openDocTab('pane-1', docInfo('/srv/README.md', 'sess-1'))
    usePaneStore.getState().openDocTab('pane-1', { ...docInfo('/srv/README.md', 'sess-1'), content: '# v2' })
    let tabs = docTabs()
    expect(tabs).toHaveLength(1)
    expect(tabs[0].payload.content).toBe('# v2')
    expect(tabs[0].id).toBe(first)

    // 双 pane 布局：同路径在另一 pane 是独立页签（引用须随 pane-1 叶子带走）
    usePaneStore.setState({
      layout: {
        root: {
          id: 'split-1', type: 'split', direction: 'horizontal', splitRatio: 0.5,
          firstChild: leaf('pane-1', ['s-a'], overlaysOf('pane-1')),
          secondChild: leaf('pane-2', ['s-b'])
        },
        activePaneId: 'pane-1'
      }
    })
    usePaneStore.getState().openDocTab('pane-2', docInfo('/srv/README.md', 'sess-1'))
    tabs = docTabs()
    expect(tabs).toHaveLength(2)
  })

  it('同路径不同远端会话是两份文档（sessionId 是身份证）：各开各的，不互相改嫁', () => {
    setup()
    usePaneStore.getState().openDocTab('pane-1', docInfo('/etc/os-release', 'host-a'))
    usePaneStore.getState().openDocTab('pane-1', { ...docInfo('/etc/os-release', 'host-b'), content: '# from B' })
    const tabs = docTabs()
    // 不同 sessionId → 独立页签；若误复用，host-a 的内容会被 B 的读取静默替换
    expect(tabs).toHaveLength(2)
    expect(tabs.map(t => t.payload.sessionId).sort()).toEqual(['host-a', 'host-b'])
    expect(tabs.find(t => t.payload.sessionId === 'host-a')?.payload.content).toBe('# hi')
    // 同一 sessionId 的同路径仍是复用语义（刷新）
    usePaneStore.getState().openDocTab('pane-1', { ...docInfo('/etc/os-release', 'host-b'), content: '# from B v2' })
    expect(docTabs()).toHaveLength(2)
    expect(docTabs().find(t => t.payload.sessionId === 'host-b')?.payload.content).toBe('# from B v2')
  })

  it('多开去活旧页签（每 pane 至多一个激活）', () => {
    setup()
    usePaneStore.getState().openDocTab('pane-1', docInfo('/a.md', 'sess-1'))
    usePaneStore.getState().openDocTab('pane-1', docInfo('/b.md', 'sess-1'))
    const tabs = docTabs()
    expect(tabs).toHaveLength(2)
    expect(activeDocInPane('pane-1')).toBe(tabs[1].id)
  })

  it('并发落盘（读取 await 完成后才调 openDocTab）也只建一个页签', async () => {
    // 复现双击/拖放连点的时序：两次读取各自 await 完成后落 openDocTab。
    // openDocTab 内 get()→set() 无 await，两次调用严格串行，后到者必然
    // 在 get() 里看到先到者刚建的页签并复用 —— 不产生重复页签
    setup()
    const open = async (): Promise<void> => {
      await Promise.resolve() // 模拟 IPC 读取 await 完成的时机
      usePaneStore.getState().openDocTab('pane-1', docInfo('/srv/README.md', 'sess-1'))
    }
    await Promise.all([open(), open()])
    expect(docTabs()).toHaveLength(1)
  })

  it('带版本的旧响应只激活不覆写（开-开竞态守卫；真实读取管线契约见 readDoc.test）', () => {
    setup()
    // 后触发（版本 2）先落盘建页签
    const id = usePaneStore.getState().openDocTab(
      'pane-1', { ...docInfo('/srv/a.md', 'sess-1'), content: '# v2', readVersion: 2 }
    )
    // 页签被顶掉（去活）后，先触发（版本 1）的旧响应迟到
    usePaneStore.getState().openDocTab('pane-1', docInfo('/other.md', 'sess-1'))
    usePaneStore.getState().deactivateOverlay(id)
    const again = usePaneStore.getState().openDocTab(
      'pane-1', { ...docInfo('/srv/a.md', 'sess-1'), content: '# v1', loadError: 'boom', readVersion: 1 }
    )
    const tabs = docTabs()
    expect(again).toBe(id)          // 复用同一页签（含旧失败也不另开）
    expect(tabs).toHaveLength(2)
    const target = tabs.find(t => t.id === id)
    expect(target?.active).toBe(true)          // 迟到响应仍会激活页签
    expect(target?.payload.content).toBe('# v2') // 但内容/错误态不被旧响应覆写
    expect(target?.payload.loadError).toBeUndefined()
  })

  it('打开 doc 去活同 pane 的 webTab / dshWeb / MCP', () => {
    setup({}, ['s-a', 's-b'], [dshRef(true), mcpRef(true)])
    usePaneStore.getState().openWebTab('https://example.com')
    usePaneStore.getState().openDocTab('pane-1', docInfo('/a.md', 'sess-1'))
    const st = usePaneStore.getState()
    expect(st.isOverlayActive(DSH_WEB_OVERLAY_ID)).toBe(false)
    expect(st.isOverlayActive(MCP_AUDIT_OVERLAY_ID)).toBe(false)
    expect(webTabs().every(t => !t.active)).toBe(true)
    expect(activeDocInPane('pane-1')).toBeTruthy()
  })
})

describe('激活互斥（四向）', () => {
  it('activateOverlay(doc) 去活同 pane webTab / dshWeb / MCP，activePaneId 切到承载 pane', () => {
    setup({}, ['s-a', 's-b'], [dshRef(false)])
    usePaneStore.getState().openWebTab('https://example.com')
    usePaneStore.getState().openDocTab('pane-1', docInfo('/a.md', 'sess-1'))
    // 先让 webTab 顶上来（doc 被去活）
    usePaneStore.getState().activateOverlay(webTabs()[0].id)
    expect(activeDocInPane('pane-1')).toBeUndefined()

    usePaneStore.getState().activateOverlay(docTabIds()[0])
    const st = usePaneStore.getState()
    expect(activeDocInPane('pane-1')).toBeTruthy()
    expect(webTabs()[0].active).toBe(false)
    expect(st.layout.activePaneId).toBe('pane-1')
  })

  it('激活保持未变引用的身份（渲染层 React.memo 的跳过依据，全量重建会让整 pane 重跑 react-markdown）', () => {
    setup()
    usePaneStore.getState().openDocTab('pane-1', docInfo('/a.md', 'sess-1'))
    usePaneStore.getState().openDocTab('pane-1', docInfo('/b.md', 'sess-1'))
    const refOf = (id: string): OverlayRef | undefined =>
      usePaneStore.getState().getAllLeafPanes()[0].overlays.find(r => r.id === id)
    const a = docTabIds()[0]
    const b = docTabIds()[1]
    const refA = refOf(a)
    // 激活 b：a 本就 active:false，引用必须原样；b 换新对象（active 翻转）
    usePaneStore.getState().activateOverlay(b)
    expect(refOf(a)).toBe(refA)
    expect(refOf(b)?.active).toBe(true)
    // 再点 a：此刻 b 是激活态须换对象去活，a 翻转；来回切换只动这两个引用
    const refB = refOf(b)
    usePaneStore.getState().activateOverlay(a)
    expect(refOf(b)).not.toBe(refB)
    expect(refOf(a)).not.toBe(refA)
  })

  it('会话加入/分屏保持未变引用的身份（addSessionToPane / splitPane / splitPaneWithPosition 三条路径）', () => {
    const refOf = (iid: string): OverlayRef | undefined => {
      const pane = usePaneStore.getState().getAllLeafPanes().find(p => p.overlays.some(r => r.id === iid))
      return pane?.overlays.find(r => r.id === iid)
    }
    // 路径一：addSessionToPane —— 中段/无插槽的 inactive 引用原样；钉尾插槽随追加
    // 前移（slot 真的变了，换对象是必要的）
    setup({}, ['s-a'])
    usePaneStore.getState().openDocTab('pane-1', docInfo('/a.md', 's-a'))
    const id = docTabIds()[0]
    usePaneStore.getState().deactivateOverlay(id)
    const ref = refOf(id)
    usePaneStore.getState().addSessionToPane('pane-1', 's-b')
    expect(refOf(id)).toBe(ref)
    usePaneStore.getState().setOverlaySlot(id, 2) // 钉尾（sessions 此刻 ['s-a','s-b']）
    const pinned = refOf(id)
    usePaneStore.getState().addSessionToPane('pane-1', 's-c')
    const bumped = refOf(id)
    expect(bumped).not.toBe(pinned)
    expect(bumped?.slot).toBe(3)

    // 路径二：splitPane —— 目标叶继承引用数组，元素身份不动
    setup({}, ['s-a'])
    usePaneStore.getState().openDocTab('pane-1', docInfo('/a.md', 's-a'))
    const id2 = docTabIds()[0]
    usePaneStore.getState().deactivateOverlay(id2)
    const ref2 = refOf(id2)
    usePaneStore.getState().splitPane('pane-1', 'horizontal', 's-a')
    expect(refOf(id2)).toBe(ref2)

    // 路径三：splitPaneWithPosition 空叶分支 —— inactive 引用原样
    setup({}, ['s-a'])
    usePaneStore.getState().openDocTab('pane-1', docInfo('/a.md', 's-a'))
    const id3 = docTabIds()[0]
    usePaneStore.getState().deactivateOverlay(id3)
    const ref3 = refOf(id3)
    usePaneStore.getState().splitPaneWithPosition('pane-1', 'horizontal', 's-a', 'first')
    expect(refOf(id3)).toBe(ref3)
  })

  it('反向：激活 dshWeb / MCP / webTab 去活同 pane doc（页签保留）', () => {
    setup({}, ['s-a', 's-b'], [dshRef(false)])
    usePaneStore.getState().openDocTab('pane-1', docInfo('/a.md', 'sess-1'))
    usePaneStore.getState().activateOverlay(DSH_WEB_OVERLAY_ID)
    expect(activeDocInPane('pane-1')).toBeUndefined()
    expect(docTabIds()).toHaveLength(1) // 仅隐藏未删除

    usePaneStore.getState().activateOverlay(docTabIds()[0])
    usePaneStore.getState().openMcpAuditInPane('pane-1')
    expect(usePaneStore.getState().isOverlayActive(MCP_AUDIT_OVERLAY_ID)).toBe(true)
    expect(activeDocInPane('pane-1')).toBeUndefined()

    usePaneStore.getState().activateOverlay(docTabIds()[0])
    usePaneStore.getState().openWebTab('https://example.com')
    usePaneStore.getState().activateOverlay(webTabs()[0].id)
    expect(activeDocInPane('pane-1')).toBeUndefined()
  })
})

describe('closeDocTab / closeOverlaysInPane(doc) / deactivateOverlaysInPane(doc)', () => {
  it('关掉激活页签 → 回落同 pane 最后一个 doc（浏览器惯例）', () => {
    setup()
    usePaneStore.getState().openDocTab('pane-1', docInfo('/a.md', 'sess-1'))
    usePaneStore.getState().openDocTab('pane-1', docInfo('/b.md', 'sess-1'))
    usePaneStore.getState().closeDocTab(docTabIds()[1])
    const tabs = docTabs()
    expect(tabs).toHaveLength(1)
    expect(tabs[0].active).toBe(true)
  })

  it('关掉非激活页签 → 不动当前激活', () => {
    setup()
    usePaneStore.getState().openDocTab('pane-1', docInfo('/a.md', 'sess-1'))
    usePaneStore.getState().openDocTab('pane-1', docInfo('/b.md', 'sess-1'))
    usePaneStore.getState().closeDocTab(docTabIds()[0])
    const tabs = docTabs()
    expect(tabs).toHaveLength(1)
    expect(tabs[0].active).toBe(true)
  })

  it('关掉唯一页签 → 清空无残留激活', () => {
    setup()
    usePaneStore.getState().openDocTab('pane-1', docInfo('/a.md', 'sess-1'))
    usePaneStore.getState().closeDocTab(docTabIds()[0])
    expect(docTabs()).toHaveLength(0)
  })

  // 拖拽拆屏产生的纯文档 pane：最后一个页签关掉后 pane 空出，
  // split 应回并还原分屏（而不是留下一个空白 pane），焦点落回吸收侧
  it('关掉纯文档 pane 的最后一个页签 → 空 pane 回并，分屏还原，焦点回存活侧', () => {
    setup({}, ['s-a'])
    usePaneStore.getState().openDocTab('pane-1', docInfo('/a.md', 'sess-1'))
    usePaneStore.getState().splitOverlayIntoPane(docTabIds()[0], 'pane-1', 'horizontal', 'second')
    const split = usePaneStore.getState().layout.root
    expect(split.type).toBe('split') // 前置：确实拆出了分屏
    const docPaneId = docTabs()[0].paneId
    // 模拟用户正在文档 pane 里看文档时点 ✕（activePaneId 落在文档 pane）
    usePaneStore.setState({ layout: { ...usePaneStore.getState().layout, activePaneId: docPaneId } })

    usePaneStore.getState().closeDocTab(docTabIds()[0])
    const st = usePaneStore.getState()
    expect(docTabs()).toHaveLength(0)
    expect(st.layout.root.type).toBe('leaf') // split 回并成单 pane
    expect((st.layout.root as PaneLeaf).sessions).toEqual(['s-a'])
    expect(st.layout.activePaneId).toBe(st.layout.root.id) // 焦点切到吸收侧，不悬空
  })

  it('纯文档 pane 还有其它页签时关一个 → 只切页签不回并；关到最后一个才回并', () => {
    setup({}, ['s-a'])
    usePaneStore.getState().openDocTab('pane-1', docInfo('/a.md', 'sess-1'))
    usePaneStore.getState().splitOverlayIntoPane(docTabIds()[0], 'pane-1', 'horizontal', 'second')
    const docPaneId = docTabs()[0].paneId
    usePaneStore.getState().openDocTab(docPaneId, docInfo('/b.md', 'sess-1'))

    // 关掉激活的第一个：切到同 pane 剩余页签，布局不动
    usePaneStore.getState().closeDocTab(docTabIds()[0])
    let st = usePaneStore.getState()
    expect(docTabs()).toHaveLength(1)
    expect(st.layout.root.type).toBe('split')

    // 关到最后一个：回并
    usePaneStore.getState().closeDocTab(docTabIds()[0])
    st = usePaneStore.getState()
    expect(docTabs()).toHaveLength(0)
    expect(st.layout.root.type).toBe('leaf')
    expect((st.layout.root as PaneLeaf).sessions).toEqual(['s-a'])
  })

  it('有终端会话的 pane 关文档 → 布局不动（单 pane 也不炸）', () => {
    setup()
    usePaneStore.getState().openDocTab('pane-1', docInfo('/a.md', 'sess-1'))
    usePaneStore.getState().closeDocTab(docTabIds()[0])
    const st = usePaneStore.getState()
    expect(docTabs()).toHaveLength(0)
    expect(st.layout.root.type).toBe('leaf')
    expect(st.layout.root.id).toBe('pane-1')
    expect((st.layout.root as PaneLeaf).sessions).toEqual(['s-a', 's-b'])
  })

  // 嵌套布局：文档 pane 在内层 split 里，回并后外层结构保持、由兄弟侧吸收
  it('嵌套布局：关掉纯文档 pane → 内层 split 回并，外层结构保持，焦点落兄弟叶子', () => {
    setup()
    usePaneStore.setState({
      layout: {
        root: {
          id: 'split-outer', type: 'split', direction: 'horizontal', splitRatio: 0.5,
          firstChild: leaf('pane-1', ['s-a']),
          secondChild: {
            id: 'split-inner', type: 'split', direction: 'vertical', splitRatio: 0.5,
            firstChild: leaf('pane-2', ['s-b']),
            secondChild: leaf('pane-doc', [])
          }
        },
        activePaneId: 'pane-doc'
      }
    })
    usePaneStore.getState().openDocTab('pane-doc', docInfo('/a.md', 'sess-1'))
    usePaneStore.getState().closeDocTab(docTabIds()[0])

    const st = usePaneStore.getState()
    expect(docTabs()).toHaveLength(0)
    expect(st.layout.root.type).toBe('split')
    if (st.layout.root.type !== 'split') return
    expect(st.layout.root.id).toBe('split-outer') // 外层保持
    expect(st.layout.root.secondChild.type).toBe('leaf') // 内层 split 回并
    expect(st.layout.root.secondChild.id).toBe('pane-2') // 兄弟侧吸收
    expect(st.layout.activePaneId).toBe('pane-2') // 焦点落兄弟叶子
  })

  it('closeOverlaysInPane(doc) 只清本 pane；deactivate 只隐藏不删', () => {
    setup()
    usePaneStore.setState({
      layout: {
        root: {
          id: 'split-1', type: 'split', direction: 'horizontal', splitRatio: 0.5,
          firstChild: leaf('pane-1', ['s-a']),
          secondChild: leaf('pane-2', ['s-b'])
        },
        activePaneId: 'pane-1'
      }
    })
    usePaneStore.getState().openDocTab('pane-1', docInfo('/a.md', 'sess-1'))
    usePaneStore.getState().openDocTab('pane-2', docInfo('/b.md', 'sess-1'))
    usePaneStore.getState().closeOverlaysInPane('pane-1', 'doc')
    expect(docTabs().map(t => t.paneId)).toEqual(['pane-2'])

    usePaneStore.getState().deactivateOverlaysInPane('pane-2', 'doc')
    const tabs = docTabs()
    expect(tabs).toHaveLength(1)
    expect(tabs[0].active).toBe(false)
  })
})

describe('doc 与 pane 生命周期', () => {
  it('关掉最后一个终端页签 → pane 因承载 doc 保留，并自动切到该 doc', () => {
    setup({}, ['s-a'])
    usePaneStore.getState().openDocTab('pane-1', docInfo('/a.md', 'sess-1'))
    usePaneStore.getState().deactivateOverlaysInPane('pane-1', 'doc')
    usePaneStore.getState().removeSessionFromPane('pane-1', 's-a')
    const st = usePaneStore.getState()
    expect(st.getPaneById('pane-1')).toBeTruthy()
    expect(activeDocInPane('pane-1')).toBeTruthy()
  })

  it('承载 pane 被 closePane 删除 → doc 一并回收', () => {
    setup()
    usePaneStore.getState().openDocTab('pane-1', docInfo('/a.md', 'sess-1'))
    const id = docTabIds()[0]
    usePaneStore.getState().closePane('pane-1')
    expect(docTabs()).toHaveLength(0)
    expect(usePaneStore.getState().getOverlayPayload(id)).toBeUndefined()
  })

  it('拖拽分屏：doc 随迁到继承原会话的第一子叶子', () => {
    setup({}, ['s-a', 's-b'])
    usePaneStore.getState().openDocTab('pane-1', docInfo('/a.md', 'sess-1'))
    usePaneStore.getState().splitPane('pane-1', 'vertical', 's-b')
    const st = usePaneStore.getState()
    const tabs = docTabs()
    expect(tabs).toHaveLength(1)
    const host = st.getPaneById(tabs[0].paneId) as PaneLeaf
    expect(host.type).toBe('leaf')
    expect(host.sessions).toContain('s-a')
    expect(tabs[0].active).toBe(true)
  })
})

describe('文档页签拖拽：setDraggingOverlay / moveOverlayToPane / splitOverlayIntoPane', () => {
  it('setDraggingOverlay 记录/清除拖拽中的覆盖层 id', () => {
    setup()
    usePaneStore.getState().setDraggingOverlay('doc-x')
    expect(usePaneStore.getState().draggingOverlayId).toBe('doc-x')
    usePaneStore.getState().setDraggingOverlay(null)
    expect(usePaneStore.getState().draggingOverlayId).toBeNull()
  })

  it('中心落点：改挂载目标 pane，去活其覆盖层，activePaneId 切换', () => {
    setup()
    usePaneStore.setState({
      layout: {
        root: {
          id: 'split-1', type: 'split', direction: 'horizontal', splitRatio: 0.5,
          firstChild: leaf('pane-1', ['s-a']),
          secondChild: leaf('pane-2', ['s-b'])
        },
        activePaneId: 'pane-1'
      }
    })
    usePaneStore.getState().openDocTab('pane-1', docInfo('/a.md', 'sess-1'))
    // pane-2 已有激活的网页覆盖层（等价旧测试手工挪 webTabs 字段，走正式挂载路径）
    usePaneStore.getState().mountOverlay('pane-2', { kind: 'web', url: 'https://example.com/', title: 'example.com' })

    usePaneStore.getState().moveOverlayToPane(docTabIds()[0], 'pane-2')
    const st = usePaneStore.getState()
    const tabs = docTabs()
    expect(tabs[0].paneId).toBe('pane-2')
    expect(tabs[0].active).toBe(true)
    expect(webTabs().every(t => !t.active)).toBe(true)
    expect(st.layout.activePaneId).toBe('pane-2')
  })

  it('中心落点：源 pane 是纯文档 pane 时空出即清理', () => {
    setup()
    usePaneStore.setState({
      layout: {
        root: {
          id: 'split-1', type: 'split', direction: 'horizontal', splitRatio: 0.5,
          firstChild: leaf('pane-1', ['s-a']),
          secondChild: leaf('pane-2', [])
        },
        activePaneId: 'pane-1'
      }
    })
    usePaneStore.getState().openDocTab('pane-2', docInfo('/a.md', 'sess-1'))
    expect(usePaneStore.getState().getPaneById('pane-2')).toBeTruthy() // 承载 doc 不被清

    usePaneStore.getState().moveOverlayToPane(docTabIds()[0], 'pane-1')
    const st = usePaneStore.getState()
    expect(docTabs()[0].paneId).toBe('pane-1')
    expect(st.getPaneById('pane-2')).toBeUndefined() // tab 移走后空出被清理
  })

  it('边缘落点：拆独立 pane，会话留在另一侧，activePaneId 指向文档 pane', () => {
    setup({}, ['s-a', 's-b'])
    usePaneStore.getState().openDocTab('pane-1', docInfo('/a.md', 'sess-1'))
    usePaneStore.getState().splitOverlayIntoPane(docTabIds()[0], 'pane-1', 'horizontal', 'second')
    const st = usePaneStore.getState()
    expect(st.layout.root.type).toBe('split')
    if (st.layout.root.type !== 'split') return
    // second 位置：文档在右，会话在左
    const docPane = st.layout.root.secondChild
    const keepPane = st.layout.root.firstChild
    expect(docPane.type).toBe('leaf')
    expect(keepPane.type).toBe('leaf')
    expect(docTabs()[0].paneId).toBe(docPane.id)
    expect((keepPane as PaneLeaf).sessions).toEqual(['s-a', 's-b'])
    expect(st.layout.activePaneId).toBe(docPane.id)
  })

  it('边缘落点：同 pane 其它覆盖层随会话迁到 keep 侧', () => {
    setup({}, ['s-a'])
    usePaneStore.getState().openDocTab('pane-1', docInfo('/a.md', 'sess-1'))
    const stayId = docTabIds()[0]
    usePaneStore.getState().openDocTab('pane-1', docInfo('/b.md', 'sess-1'))
    const splitId = docTabIds()[1]
    usePaneStore.getState().openWebTab('https://example.com') // 挂活动 pane-1（顺带去活 doc，互斥）

    usePaneStore.getState().splitOverlayIntoPane(splitId, 'pane-1', 'vertical', 'second')
    const st = usePaneStore.getState()
    expect(st.layout.root.type).toBe('split')
    if (st.layout.root.type !== 'split') return
    const keepPane = st.layout.root.firstChild as PaneLeaf
    const docPane = st.layout.root.secondChild as PaneLeaf
    // 拖走的挂文档 pane；留下的 doc / web 随会话在 keep 侧
    expect(docTabs().find(t => t.id === splitId)?.paneId).toBe(docPane.id)
    expect(docTabs().find(t => t.id === stayId)?.paneId).toBe(keepPane.id)
    expect(webTabs()[0].paneId).toBe(keepPane.id)
    expect(keepPane.sessions).toEqual(['s-a'])
  })

  it('目标 pane 无会话但有驻留覆盖层：照常拆屏（keep 侧留驻留文档）；拖回自己 pane 是 no-op', () => {
    setup({}, ['s-a'])
    usePaneStore.getState().openDocTab('pane-1', docInfo('/a.md', 'sess-1'))
    const id = docTabIds()[0]
    usePaneStore.setState({
      layout: {
        root: {
          id: 'split-1', type: 'split', direction: 'horizontal', splitRatio: 0.5,
          firstChild: leaf('pane-1', ['s-a'], overlaysOf('pane-1')), // 引用随叶子带走
          secondChild: leaf('pane-2', [])
        },
        activePaneId: 'pane-1'
      }
    })
    usePaneStore.getState().openDocTab('pane-2', docInfo('/b.md', 'sess-1'))
    const residentId = docTabs().find(t => t.paneId === 'pane-2')!.id

    // 边缘落点到无会话但驻留着 b.md 的 pane-2 → 拆屏（doc/doc 对拆是合法诉求，
    // 仅当目标拆空后无内容可留才退化改挂载）：pane-2 变嵌套 split，
    // position 'first' → 拖拽项在前，驻留项 keep 到后侧
    usePaneStore.getState().splitOverlayIntoPane(id, 'pane-2', 'horizontal', 'first')
    const st = usePaneStore.getState()
    expect(st.layout.root.type).toBe('split')
    const inner = (st.layout.root as PaneSplit).secondChild
    expect(inner.type).toBe('split') // pane-2 被替换为嵌套 split
    if (inner.type !== 'split') return
    const draggedPane = inner.firstChild as PaneLeaf
    const keepPane = inner.secondChild as PaneLeaf
    expect(docTabs().find(t => t.id === id)?.paneId).toBe(draggedPane.id)
    expect(docTabs().find(t => t.id === residentId)?.paneId).toBe(keepPane.id)

    // 拖回自己 pane 中心 → no-op
    usePaneStore.getState().moveOverlayToPane(id, draggedPane.id)
    expect(docTabs().find(t => t.id === id)?.paneId).toBe(draggedPane.id)
  })
})

describe('updateDocTab：内容/错误态回写', () => {
  it('按 id 打补丁，未知 id 不炸不动', () => {
    setup()
    usePaneStore.getState().openDocTab('pane-1', docInfo('/a.md', 'sess-1'))
    const id = docTabIds()[0]
    usePaneStore.getState().updateDocTab(id, { content: '# v2', size: 2048, loadError: undefined })
    const tab = docTabs()[0].payload
    expect(tab.content).toBe('# v2')
    expect(tab.size).toBe(2048)

    usePaneStore.getState().updateDocTab('doc-nope', { content: 'x' })
    expect(docTabs()[0].payload.content).toBe('# v2')
  })
})
