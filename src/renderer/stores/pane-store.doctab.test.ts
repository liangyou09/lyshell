// @vitest-environment jsdom
/**
 * docTabs 的 store 级测试（纯逻辑，不渲染组件）—— 克隆 webtab 测试脚手架。
 *
 * 锁住的维护路径：
 * 1) 打开/复用：同 pane 同来源同路径复用页签；打开去活同 pane 其余覆盖层
 * 2) 激活互斥：docTab ↔ webTab ↔ dshWeb ↔ MCP 四向
 * 3) 关闭：关激活页签回落同 pane 最后一个 docTab；关光剩空
 * 4) pane 生命周期：仅剩 docTab 的空 pane 不被合并；承载 pane 关闭回收页签；
 *    拖拽分屏时 docTab 随迁到继承会话的子叶子
 */
import { describe, expect, it } from 'vitest'
import { usePaneStore } from './pane-store'
import type { PaneLeaf, PaneLayout, PaneNode, DocTabEntry } from '@shared/types'

const leaf = (id: string, sessions: string[]): PaneLeaf => ({
  id,
  type: 'leaf',
  sessions,
  activeSessionId: sessions[0] ?? null
})

const layoutOf = (root: PaneNode): PaneLayout => ({ root, activePaneId: root.type === 'leaf' ? root.id : '' })

const WEB_INFO = { url: 'http://127.0.0.1:3080', name: 'dsh web' }

const setup = (extra: Record<string, unknown> = {}, sessions = ['s-a', 's-b']) => {
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
    webTabFavicons: {},
    docTabs: [],
    ...extra
  })
}

const docInfo = (path: string, sessionId?: string) => ({
  source: (sessionId ? 'remote' : 'local') as 'remote' | 'local',
  kind: path.endsWith('.html') ? ('html' as const) : ('markdown' as const),
  path,
  title: path.split('/').pop() || path,
  ...(sessionId ? { sessionId } : {}),
  size: 1024,
  mtime: 1700000000000,
  content: '# hi'
})

const docTabIds = (): string[] => usePaneStore.getState().docTabs.map(t => t.id)
const activeDocInPane = (paneId: string): string | undefined =>
  usePaneStore.getState().docTabs.find(t => t.paneId === paneId && t.active)?.id

describe('openDocTab：打开与复用', () => {
  it('挂到指定 pane 并激活，activePaneId 同步切换', () => {
    setup()
    const id = usePaneStore.getState().openDocTab('pane-1', docInfo('/srv/README.md', 'sess-1'))
    const st = usePaneStore.getState()
    expect(st.docTabs).toHaveLength(1)
    expect(st.docTabs[0].paneId).toBe('pane-1')
    expect(st.docTabs[0].active).toBe(true)
    expect(st.layout.activePaneId).toBe('pane-1')
    expect(typeof id).toBe('string')
  })

  it('paneId 缺省 → 落活动 pane', () => {
    setup()
    usePaneStore.getState().openDocTab(undefined, docInfo('/srv/a.md', 'sess-1'))
    expect(usePaneStore.getState().docTabs[0].paneId).toBe('pane-1')
  })

  it('同 pane 同来源同路径复用页签（刷新语义），不同 pane 各开各的', () => {
    setup()
    const first = usePaneStore.getState().openDocTab('pane-1', docInfo('/srv/README.md', 'sess-1'))
    usePaneStore.getState().openDocTab('pane-1', { ...docInfo('/srv/README.md', 'sess-1'), content: '# v2' })
    expect(usePaneStore.getState().docTabs).toHaveLength(1)
    expect(usePaneStore.getState().docTabs[0].content).toBe('# v2')
    expect(usePaneStore.getState().docTabs[0].id).toBe(first)

    // 双 pane 布局：同路径在另一 pane 是独立页签
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
    usePaneStore.getState().openDocTab('pane-2', docInfo('/srv/README.md', 'sess-1'))
    expect(usePaneStore.getState().docTabs).toHaveLength(2)
  })

  it('多开去活旧页签（每 pane 至多一个激活）', () => {
    setup()
    usePaneStore.getState().openDocTab('pane-1', docInfo('/a.md', 'sess-1'))
    usePaneStore.getState().openDocTab('pane-1', docInfo('/b.md', 'sess-1'))
    const st = usePaneStore.getState()
    expect(st.docTabs).toHaveLength(2)
    expect(activeDocInPane('pane-1')).toBe(st.docTabs[1].id)
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
    expect(usePaneStore.getState().docTabs).toHaveLength(1)
  })

  it('打开 docTab 去活同 pane 的 webTab / dshWeb / MCP', () => {
    setup({
      dshWeb: WEB_INFO, dshWebPaneId: 'pane-1', dshWebActive: true,
      mcpAuditPaneId: 'pane-1', mcpAuditActive: true
    })
    usePaneStore.getState().openWebTab('https://example.com')
    usePaneStore.getState().openDocTab('pane-1', docInfo('/a.md', 'sess-1'))
    const st = usePaneStore.getState()
    expect(st.dshWebActive).toBe(false)
    expect(st.mcpAuditActive).toBe(false)
    expect(st.webTabs.every(t => !t.active)).toBe(true)
    expect(activeDocInPane('pane-1')).toBeTruthy()
  })
})

describe('激活互斥（四向）', () => {
  it('activateDocTab 去活同 pane webTab / dshWeb / MCP，activePaneId 切到承载 pane', () => {
    setup({ dshWeb: WEB_INFO, dshWebPaneId: 'pane-1' })
    usePaneStore.getState().openWebTab('https://example.com')
    usePaneStore.getState().openDocTab('pane-1', docInfo('/a.md', 'sess-1'))
    // 先让 webTab 顶上来（docTab 被去活）
    usePaneStore.getState().activateWebTab(usePaneStore.getState().webTabs[0].id)
    expect(activeDocInPane('pane-1')).toBeUndefined()

    usePaneStore.getState().activateDocTab(docTabIds()[0])
    const st = usePaneStore.getState()
    expect(activeDocInPane('pane-1')).toBeTruthy()
    expect(st.webTabs[0].active).toBe(false)
    expect(st.layout.activePaneId).toBe('pane-1')
  })

  it('反向：激活 dshWeb / MCP / webTab 去活同 pane docTab（页签保留）', () => {
    setup({ dshWeb: WEB_INFO, dshWebPaneId: 'pane-1' })
    usePaneStore.getState().openDocTab('pane-1', docInfo('/a.md', 'sess-1'))
    usePaneStore.getState().activateDshWeb()
    expect(activeDocInPane('pane-1')).toBeUndefined()
    expect(docTabIds()).toHaveLength(1) // 仅隐藏未删除

    usePaneStore.getState().activateDocTab(docTabIds()[0])
    usePaneStore.getState().openMcpAuditInPane('pane-1')
    expect(usePaneStore.getState().mcpAuditActive).toBe(true)
    expect(activeDocInPane('pane-1')).toBeUndefined()

    usePaneStore.getState().activateDocTab(docTabIds()[0])
    usePaneStore.getState().openWebTab('https://example.com')
    usePaneStore.getState().activateWebTab(usePaneStore.getState().webTabs[0].id)
    expect(activeDocInPane('pane-1')).toBeUndefined()
  })
})

describe('closeDocTab / closeDocTabsInPane / deactivateDocTabsInPane', () => {
  it('关掉激活页签 → 回落同 pane 最后一个 docTab（浏览器惯例）', () => {
    setup()
    usePaneStore.getState().openDocTab('pane-1', docInfo('/a.md', 'sess-1'))
    usePaneStore.getState().openDocTab('pane-1', docInfo('/b.md', 'sess-1'))
    usePaneStore.getState().closeDocTab(docTabIds()[1])
    const st = usePaneStore.getState()
    expect(st.docTabs).toHaveLength(1)
    expect(st.docTabs[0].active).toBe(true)
  })

  it('关掉非激活页签 → 不动当前激活', () => {
    setup()
    usePaneStore.getState().openDocTab('pane-1', docInfo('/a.md', 'sess-1'))
    usePaneStore.getState().openDocTab('pane-1', docInfo('/b.md', 'sess-1'))
    usePaneStore.getState().closeDocTab(docTabIds()[0])
    const st = usePaneStore.getState()
    expect(st.docTabs).toHaveLength(1)
    expect(st.docTabs[0].active).toBe(true)
  })

  it('关掉唯一页签 → 清空无残留激活', () => {
    setup()
    usePaneStore.getState().openDocTab('pane-1', docInfo('/a.md', 'sess-1'))
    usePaneStore.getState().closeDocTab(docTabIds()[0])
    expect(usePaneStore.getState().docTabs).toHaveLength(0)
  })

  it('closeDocTabsInPane 只清本 pane；deactivate 只隐藏不删', () => {
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
    usePaneStore.getState().closeDocTabsInPane('pane-1')
    expect(usePaneStore.getState().docTabs.map(t => t.paneId)).toEqual(['pane-2'])

    usePaneStore.getState().deactivateDocTabsInPane('pane-2')
    expect(usePaneStore.getState().docTabs).toHaveLength(1)
    expect(usePaneStore.getState().docTabs[0].active).toBe(false)
  })
})

describe('docTabs 与 pane 生命周期', () => {
  it('关掉最后一个终端页签 → pane 因承载 docTab 保留，并自动切到该 docTab', () => {
    setup({}, ['s-a'])
    usePaneStore.getState().openDocTab('pane-1', docInfo('/a.md', 'sess-1'))
    usePaneStore.getState().deactivateDocTabsInPane('pane-1')
    usePaneStore.getState().removeSessionFromPane('pane-1', 's-a')
    const st = usePaneStore.getState()
    expect(st.getPaneById('pane-1')).toBeTruthy()
    expect(activeDocInPane('pane-1')).toBeTruthy()
  })

  it('承载 pane 被 closePane 删除 → docTabs 一并回收', () => {
    setup()
    usePaneStore.getState().openDocTab('pane-1', docInfo('/a.md', 'sess-1'))
    usePaneStore.getState().closePane('pane-1')
    expect(usePaneStore.getState().docTabs).toHaveLength(0)
  })

  it('拖拽分屏：docTab 随迁到继承原会话的第一子叶子', () => {
    setup({}, ['s-a', 's-b'])
    usePaneStore.getState().openDocTab('pane-1', docInfo('/a.md', 'sess-1'))
    usePaneStore.getState().splitPane('pane-1', 'vertical', 's-b')
    const st = usePaneStore.getState()
    expect(st.docTabs).toHaveLength(1)
    const host = st.getPaneById(st.docTabs[0].paneId) as PaneLeaf
    expect(host.type).toBe('leaf')
    expect(host.sessions).toContain('s-a')
    expect(st.docTabs[0].active).toBe(true)
  })
})

describe('updateDocTab：内容/错误态回写', () => {
  it('按 id 打补丁，未知 id 不炸不动', () => {
    setup()
    usePaneStore.getState().openDocTab('pane-1', docInfo('/a.md', 'sess-1'))
    const id = docTabIds()[0]
    usePaneStore.getState().updateDocTab(id, { content: '# v2', size: 2048, loadError: undefined })
    const tab = usePaneStore.getState().docTabs[0] as DocTabEntry
    expect(tab.content).toBe('# v2')
    expect(tab.size).toBe(2048)

    usePaneStore.getState().updateDocTab('doc-nope', { content: 'x' })
    expect(usePaneStore.getState().docTabs[0].content).toBe('# v2')
  })
})
