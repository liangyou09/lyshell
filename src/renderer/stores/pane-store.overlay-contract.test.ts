// @vitest-environment jsdom
/**
 * 覆盖层归一化契约套件 —— 对全部四种 OverlayKind 跑同一套契约。
 *
 * 这是「新增一种覆盖层」的必过门槛：历史上一系列坑（空条早退漏算某种类、
 * close 漏空 pane 回并、splitPane 覆盖层不随迁变僵尸、插槽随会话关闭漂移、
 * 拖拽态残留…）都是逐触点手工枚举漏改造成的。归一化后这些行为收敛在
 * mountOverlay / activateOverlay / closeOverlay / moveOverlayToPane /
 * splitOverlayIntoPane / slot 族里，本套件参数化锁死 —— 新种类只要通过
 * 这套契约，机制层就自动具备全部历史行为，不再换位置踩旧坑。
 *
 * 挂载入口走各种类的公开门面（openDocTab / openDshWebInPane /
 * openMcpAuditInPane / mountOverlay 核心），门面自身的差异行为由
 * webtab / doctab 套件覆盖，这里只锁跨种类一致的部分。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePaneStore, findOverlayRef } from './pane-store'
import { DSH_WEB_OVERLAY_ID, MCP_AUDIT_OVERLAY_ID } from './overlay-kinds'
import type { DocOverlayPayload, OverlayKind, OverlayPayload, PaneLeaf, PaneNode } from '@shared/types'

const leaf = (id: string, sessions: string[]): PaneLeaf => ({
  id,
  type: 'leaf',
  sessions,
  activeSessionId: sessions[0] ?? null,
  overlays: []
})

// 直接返回 split 根节点（reset 接的是 PaneNode；传整个 PaneLayout 会让
// layout.root 变成无 type 的对象，stripOverlays/树遍历全部误判崩溃）
const splitLayout = (first: PaneLeaf, second: PaneLeaf): PaneNode => ({
  id: 'split-1',
  type: 'split',
  direction: 'horizontal',
  splitRatio: 0.5,
  firstChild: first,
  secondChild: second
})

const DOC_INFO: DocOverlayPayload = {
  source: 'local',
  docKind: 'markdown',
  path: '/tmp/a.md',
  title: 'a.md',
  size: 1,
  mtime: 1,
  content: '# hi'
}

interface ContractCase {
  kind: OverlayKind
  singleton: boolean      // 全局唯一：重开 = 换挂载点而非新增实例
  fallback: boolean       // 关激活页签回落同 pane 同种类最后一个（浏览器惯例）
  payload: OverlayPayload
}

const CASES: ContractCase[] = [
  { kind: 'web', singleton: false, fallback: true, payload: { kind: 'web', url: 'https://example.com/', title: 'example.com' } },
  { kind: 'doc', singleton: false, fallback: true, payload: { kind: 'doc', ...DOC_INFO } },
  { kind: 'dshWeb', singleton: true, fallback: false, payload: { kind: 'dshWeb', url: 'http://127.0.0.1:3080', name: 'dsh web' } },
  { kind: 'mcpAudit', singleton: true, fallback: false, payload: { kind: 'mcpAudit' } }
]

// 挂载门面：单例返回固定哨兵 id，多开返回生成的实例 id。
// variant 用于 doc 的第二次打开 —— openDocTab 对同 source+path 去重复用页签，
// 「互斥/回落/跨 pane」契约需要的是两个独立实例，用不同路径绕开去重
const open = (c: ContractCase, paneId: string, variant = 0): string => {
  const st = usePaneStore.getState()
  switch (c.kind) {
    case 'web':
      return st.mountOverlay(paneId, c.payload)!
    case 'doc':
      return st.openDocTab(paneId, variant === 0
        ? DOC_INFO
        : { ...DOC_INFO, path: `/tmp/a${variant}.md`, title: `a${variant}.md` })
    case 'dshWeb':
      st.openDshWebInPane(paneId, { url: 'http://127.0.0.1:3080', name: 'dsh web' })
      return DSH_WEB_OVERLAY_ID
    case 'mcpAudit':
      st.openMcpAuditInPane(paneId)
      return MCP_AUDIT_OVERLAY_ID
  }
}

const reset = (root?: PaneNode): void => {
  usePaneStore.setState({
    layout: { root: root ?? leaf('pane-1', ['s-a', 's-b']), activePaneId: 'pane-1' },
    overlayPayloads: {},
    draggingOverlayId: null,
    hiddenTabSessions: {}
  })
}

const slotOf = (id: string): number | null =>
  findOverlayRef(usePaneStore.getState().layout.root, id)?.ref.slot ?? null

describe.each(CASES)('$kind：归一化覆盖层契约', (c) => {
  beforeEach(() => reset())

  it('挂载：引用进目标叶子并激活，payload 入字典，activePaneId 切换', () => {
    const id = open(c, 'pane-1')
    const st = usePaneStore.getState()
    expect(st.getOverlayPaneId(id)).toBe('pane-1')
    expect(st.isOverlayActive(id)).toBe(true)
    expect(st.getOverlayPayload(id)).toEqual(c.payload)
    expect(st.layout.activePaneId).toBe('pane-1')
    const host = st.getPaneById('pane-1') as PaneLeaf
    expect(host.overlays).toHaveLength(1)
    expect(host.overlays[0]).toMatchObject({ id, kind: c.kind, active: true })
  })

  it('同 pane 互斥：后挂载去活先挂载（页签保留），激活切换是 radio', () => {
    const first = open(c, 'pane-1')
    const second = open(c, 'pane-1', 2)
    const st = usePaneStore.getState()
    const host = () => usePaneStore.getState().getPaneById('pane-1') as PaneLeaf

    if (c.singleton) {
      // 单例：同 pane 重开 = 原位重开（仍一个引用且激活）
      expect(second).toBe(first)
      expect(host().overlays).toHaveLength(1)
      expect(st.isOverlayActive(first)).toBe(true)
      return
    }

    expect(st.isOverlayActive(first)).toBe(false)
    expect(st.isOverlayActive(second)).toBe(true)
    usePaneStore.getState().activateOverlay(first)
    const after = usePaneStore.getState()
    expect(after.isOverlayActive(first)).toBe(true)
    expect(after.isOverlayActive(second)).toBe(false)
    expect(host().overlays).toHaveLength(2) // 去活不删页签
  })

  it('跨 pane：多开种类各自激活互不影响；单例种类换 pane 重挂（全局唯一）', () => {
    reset(splitLayout(leaf('pane-1', ['s-a']), leaf('pane-2', ['s-b'])))
    const a = open(c, 'pane-1')
    const b = open(c, 'pane-2', 2)
    const st = usePaneStore.getState()
    if (c.singleton) {
      expect(b).toBe(a) // 同一实例，不产生第二份
      expect(st.getOverlayPaneId(a)).toBe('pane-2')
      expect((st.getPaneById('pane-1') as PaneLeaf).overlays).toHaveLength(0)
    } else {
      expect(st.isOverlayActive(a)).toBe(true)
      expect(st.isOverlayActive(b)).toBe(true)
    }
  })

  it('关闭回落：fallback 种类关激活页签切同 pane 同种类最后一个；非 fallback 直接回终端', () => {
    if (!c.fallback) {
      const id = open(c, 'pane-1')
      usePaneStore.getState().closeOverlay(id)
      const st = usePaneStore.getState()
      expect(st.getOverlayPayload(id)).toBeUndefined()
      expect((st.getPaneById('pane-1') as PaneLeaf).overlays).toHaveLength(0)
      return
    }
    const first = open(c, 'pane-1')
    const second = open(c, 'pane-1', 2)
    usePaneStore.getState().closeOverlay(second)
    const st = usePaneStore.getState()
    expect(st.isOverlayActive(first)).toBe(true)
    expect(st.getOverlayPayload(second)).toBeUndefined()
  })

  it('关闭副作用：dshWeb 关闭回收时补发 closeDshWeb IPC，其余种类无副作用', () => {
    const spy = vi.fn()
    ;(window as unknown as { electronAPI: unknown }).electronAPI = { closeDshWeb: spy }
    try {
      const id = open(c, 'pane-1')
      usePaneStore.getState().closeOverlay(id)
      expect(spy).toHaveBeenCalledTimes(c.kind === 'dshWeb' ? 1 : 0)
    } finally {
      delete (window as unknown as { electronAPI?: unknown }).electronAPI
    }
  })

  it('移动（中心落点）：改挂载目标 pane、去活其覆盖层、slot 复位钉尾、源 pane 会话不动', () => {
    reset(splitLayout(leaf('pane-1', ['s-a', 's-b']), leaf('pane-2', ['s-z'])))
    const id = open(c, 'pane-1')
    usePaneStore.getState().setOverlaySlot(id, 1)
    // 目标 pane 预置一个激活的 web 覆盖层（跨种类去活对象）
    const other = usePaneStore.getState().mountOverlay('pane-2', { kind: 'web', url: 'https://other.example.com/', title: 'other' })!

    usePaneStore.getState().moveOverlayToPane(id, 'pane-2')
    const st = usePaneStore.getState()
    expect(st.getOverlayPaneId(id)).toBe('pane-2')
    expect(st.isOverlayActive(id)).toBe(true)
    expect(st.isOverlayActive(other)).toBe(false)
    expect(slotOf(id)).toBeNull() // 旧 slot 是源 pane 坐标，换 pane 后复位
    expect(st.layout.activePaneId).toBe('pane-2')
    expect((st.getPaneById('pane-1') as PaneLeaf).sessions).toEqual(['s-a', 's-b'])
  })

  it('移动：源是纯覆盖层 pane 时移走后空出回并', () => {
    reset(splitLayout(leaf('pane-1', ['s-a']), leaf('pane-2', [])))
    const id = open(c, 'pane-2')
    expect(usePaneStore.getState().getPaneById('pane-2')).toBeTruthy() // 承载覆盖层不被清

    usePaneStore.getState().moveOverlayToPane(id, 'pane-1')
    const st = usePaneStore.getState()
    expect(st.getOverlayPaneId(id)).toBe('pane-1')
    expect(st.getPaneById('pane-2')).toBeUndefined() // 空出被清理
    expect(st.layout.root.type).toBe('leaf') // split 回并
  })

  it('拆屏（边缘落点）：拆独立 pane，会话留 keep 侧，activePaneId 指向覆盖层 pane', () => {
    const id = open(c, 'pane-1')
    usePaneStore.getState().splitOverlayIntoPane(id, 'pane-1', 'horizontal', 'second')
    const st = usePaneStore.getState()
    expect(st.layout.root.type).toBe('split')
    if (st.layout.root.type !== 'split') return
    const keep = st.layout.root.firstChild as PaneLeaf
    const overlayPane = st.layout.root.secondChild as PaneLeaf
    expect(keep.sessions).toEqual(['s-a', 's-b'])
    expect(overlayPane.sessions).toEqual([])
    expect(st.getOverlayPaneId(id)).toBe(overlayPane.id)
    expect(st.isOverlayActive(id)).toBe(true)
    expect(st.layout.activePaneId).toBe(overlayPane.id)
  })

  it('拆屏（纯覆盖层目标）：目标 pane 无会话但有驻留覆盖层 → 照常拆屏（keep 侧留驻留项）', () => {
    reset(splitLayout(leaf('pane-1', ['s-a']), leaf('pane-2', [])))
    // 无会话的纯覆盖层 pane（真正空白 pane 在任意树操作后即被回并，无法稳定存在）
    const resident = usePaneStore.getState().mountOverlay('pane-2', { kind: 'web', url: 'https://stay.example.com/', title: 'stay' })!
    const id = open(c, 'pane-1')
    usePaneStore.getState().splitOverlayIntoPane(id, 'pane-2', 'vertical', 'first')
    const st = usePaneStore.getState()
    expect(st.layout.root.type).toBe('split') // 外层 split 不变
    if (st.layout.root.type !== 'split') return
    expect(st.layout.root.firstChild.type).toBe('leaf') // pane-1（源）仍是叶子
    // pane-2 被替换为新 split：position 'first' → 拖拽项 first，驻留项 keep 到 second
    const inner = st.layout.root.secondChild
    expect(inner.type).toBe('split')
    if (inner.type !== 'split') return
    expect(inner.direction).toBe('vertical')
    const draggedPane = inner.firstChild as PaneLeaf
    const keepPane = inner.secondChild as PaneLeaf
    expect(st.getOverlayPaneId(id)).toBe(draggedPane.id)
    expect(st.isOverlayActive(id)).toBe(true)
    expect(st.getOverlayPaneId(resident)).toBe(keepPane.id) // 驻留覆盖层留 keep 侧
    expect(st.layout.activePaneId).toBe(draggedPane.id)
  })

  it('拆屏退化：目标 pane 无会话且无可留覆盖层（拖回自己的纯覆盖层 pane）→ 改挂载 no-op，无新 split 层级', () => {
    // 拖拽项是目标 pane 的唯一内容：拆出后 keep 侧为空叶必被回并，拆了等于没拆
    reset(splitLayout(leaf('pane-1', []), leaf('pane-2', ['s-a'])))
    const id = open(c, 'pane-1') // pane-1 成为纯覆盖层 pane
    usePaneStore.getState().splitOverlayIntoPane(id, 'pane-1', 'vertical', 'second')
    const st = usePaneStore.getState()
    expect(st.layout.root.type).toBe('split') // 仍是原 split，没有再包一层
    if (st.layout.root.type !== 'split') return
    expect(st.layout.root.firstChild.type).toBe('leaf') // 无嵌套新层级
    expect(st.layout.root.secondChild.type).toBe('leaf')
    expect(st.getOverlayPaneId(id)).toBe('pane-1') // 原位未动
    expect(st.isOverlayActive(id)).toBe(true)
  })

  it('回并：纯覆盖层 pane 关最后一个页签 → split 回并，焦点落吸收侧，payload 回收', () => {
    const id = open(c, 'pane-1')
    usePaneStore.getState().splitOverlayIntoPane(id, 'pane-1', 'horizontal', 'second')
    const overlayPaneId = usePaneStore.getState().getOverlayPaneId(id)!
    // 模拟用户正在覆盖层 pane 里看点 ✕（activePaneId 落在覆盖层 pane）
    usePaneStore.setState({
      layout: { ...usePaneStore.getState().layout, activePaneId: overlayPaneId }
    })

    usePaneStore.getState().closeOverlay(id)
    const after = usePaneStore.getState()
    expect(after.layout.root.type).toBe('leaf')
    expect((after.layout.root as PaneLeaf).sessions).toEqual(['s-a', 's-b'])
    expect(after.layout.activePaneId).toBe(after.layout.root.id) // 焦点切到吸收侧
    expect(after.getOverlayPayload(id)).toBeUndefined()
  })

  // 回归锁：双空子叶塌缩 —— 空 pane 开覆盖层再拆屏（无 sessionId，两侧都无会话），
  // 关掉覆盖层后整个 split 塌缩成带 split id 的新叶；回退逻辑若从塌缩前原树取兄弟叶
  // id，会得到树中不存在的悬空 activePaneId（mountOverlay/快捷命令随之静默失效）
  it('双空塌缩：纯覆盖层 pane + 空兄弟侧同时清空 → activePaneId 落到树中真实叶子', () => {
    reset(leaf('pane-1', []))
    const id = open(c, 'pane-1')
    usePaneStore.getState().splitPane('pane-1', 'horizontal')
    expect(usePaneStore.getState().layout.root.type).toBe('split') // 前置：确实拆出了分屏

    usePaneStore.getState().closeOverlay(id)
    const st = usePaneStore.getState()
    expect(st.layout.root.type).toBe('leaf') // 双空 split 塌缩回单叶
    expect(st.getAllLeafPanes().map(l => l.id)).toContain(st.layout.activePaneId) // 不悬空
    expect(st.getOverlayPayload(id)).toBeUndefined()
  })

  it('空条保护：仅剩覆盖层的 pane 不随会话清空被合并；关最后终端页签自动激活', () => {
    const id = open(c, 'pane-1')
    usePaneStore.getState().deactivateOverlay(id)
    usePaneStore.getState().removeSessionFromPane('pane-1', 's-a')
    usePaneStore.getState().removeSessionFromPane('pane-1', 's-b')
    const st = usePaneStore.getState()
    expect(st.getPaneById('pane-1')).toBeTruthy() // 不被 removePaneAndMerge 删
    // 终端页签清空后按优先级自动切到剩余覆盖层（否则窗格只剩空态占位）
    expect(st.isOverlayActive(id)).toBe(true)
  })

  it('slot 契约：RAW 坐标随左侧会话关闭递减，右侧关闭不动（中段插槽不漂移）', () => {
    reset(splitLayout(leaf('pane-1', ['s-a', 's-b', 's-c']), leaf('pane-2', ['s-z'])))
    const id = open(c, 'pane-1')
    usePaneStore.getState().setOverlaySlot(id, 1) // s-a, <overlay>, s-b, s-c
    usePaneStore.getState().removeSessionFromPane('pane-1', 's-a')
    expect(slotOf(id)).toBe(0)
    usePaneStore.getState().removeSessionFromPane('pane-1', 's-c') // 右侧关闭
    expect(slotOf(id)).toBe(0)
  })

  // 回归锁：跨 pane 移动走 removeSessionFromAllPanes 纯函数（splitPane / addSessionToPane
  // 共用），它曾漏掉删位衰减 —— 「移走页签」与「关闭页签」对插槽语义不一致，
  // slotted 覆盖层每次跨 pane 移动都向右漂移一位
  it('slot 契约：跨 pane 移走左侧会话（addSessionToPane 纯函数路径）→ 插槽同样衰减', () => {
    reset(splitLayout(leaf('pane-1', ['s-a', 's-b', 's-c']), leaf('pane-2', ['s-z'])))
    const id = open(c, 'pane-1')
    usePaneStore.getState().setOverlaySlot(id, 2) // s-a, s-b, <overlay>, s-c

    usePaneStore.getState().addSessionToPane('pane-2', 's-a') // 移走 s-a（左侧）
    const st = usePaneStore.getState()
    expect((st.getPaneById('pane-1') as PaneLeaf).sessions).toEqual(['s-b', 's-c'])
    expect(slotOf(id)).toBe(1) // s-b, <overlay>, s-c —— 锚定关系保持，不漂到 s-c 之后

    usePaneStore.getState().addSessionToPane('pane-2', 's-c') // 再移走右侧
    expect((usePaneStore.getState().getPaneById('pane-1') as PaneLeaf).sessions).toEqual(['s-b'])
    expect(slotOf(id)).toBe(1) // 右侧移走不衰减（钉尾语义等价）
  })

  // 回归锁：同 pane 原位重开曾无条件把 slot 抹回 null —— 多开种类（doc/web）
  // 用户拖出来的位置不该被一次「重新打开同一文件/链接」无声抹掉；
  // 单例（dshWeb/mcpAudit）保持复位钉尾（webtab 契约已另行锁定）
  it('同 pane 原位重开：多开种类保留插槽，单例复位钉尾', () => {
    const id = open(c, 'pane-1')
    usePaneStore.getState().setOverlaySlot(id, 1)
    expect(slotOf(id)).toBe(1)

    const st = usePaneStore.getState()
    // doc 走 openDocTab 同路径复用；web 需显式传 id 复用（门面无复用入口）；单例走门面重开
    const reopened = c.kind === 'web'
      ? st.mountOverlay('pane-1', c.payload, { id })
      : open(c, 'pane-1')
    expect(reopened).toBe(id) // 原位：同 id、不新增页签
    const after = usePaneStore.getState()
    expect(after.isOverlayActive(id)).toBe(true)
    expect((after.getPaneById('pane-1') as PaneLeaf).overlays).toHaveLength(1)
    expect(slotOf(id)).toBe(c.singleton ? null : 1)
  })

  it('拖拽态：setDraggingOverlay 记录；关闭被拖覆盖层时自动清空（落点判定不悬空）', () => {
    const id = open(c, 'pane-1')
    usePaneStore.getState().setDraggingOverlay(id)
    expect(usePaneStore.getState().draggingOverlayId).toBe(id)
    usePaneStore.getState().closeOverlay(id)
    expect(usePaneStore.getState().draggingOverlayId).toBeNull()
  })

  // 回归锁：closePane 走 pruneOverlayPayloads 回收（与 closeOverlay 不同路径），
  // 被回收实例正处于拖拽中时标记也须清空，否则 webview 系覆盖层卡在拖拽期隐藏态
  it('拖拽态：closePane 回收被拖覆盖层时标记一并清空', () => {
    reset(splitLayout(leaf('pane-1', ['s-a']), leaf('pane-2', [])))
    const id = open(c, 'pane-2')
    usePaneStore.getState().setDraggingOverlay(id)
    usePaneStore.getState().closePane('pane-2')
    expect(usePaneStore.getState().draggingOverlayId).toBeNull()
    expect(usePaneStore.getState().getOverlayPayload(id)).toBeUndefined()
  })

  // 回归锁：向覆盖层激活中的 pane 添加会话，新会话自动接管视图 —— 覆盖层不去活的
  // 话会以更高 zIndex 盖住刚连上的终端，页签条连会话高亮都被 overlayActiveHere 抑制
  it('addSessionToPane：新会话激活即接管视图，本 pane 覆盖层让位', () => {
    const id = open(c, 'pane-1')
    usePaneStore.getState().addSessionToPane('pane-1', 's-new')
    const st = usePaneStore.getState()
    const host = st.getPaneById('pane-1') as PaneLeaf
    expect(host.sessions).toContain('s-new')
    expect(host.activeSessionId).toBe('s-new')
    expect(st.isOverlayActive(id)).toBe(false)
  })
})

describe('跨种类契约（四种覆盖层同 pane 共存）', () => {
  beforeEach(() => reset())

  it('依次挂载同 pane：仅最后激活，页签序 = 打开序', () => {
    const ids = CASES.map(c => open(c, 'pane-1'))
    const st = usePaneStore.getState()
    const host = st.getPaneById('pane-1') as PaneLeaf
    expect(host.overlays).toHaveLength(4)
    expect(host.overlays.map(r => r.id)).toEqual(ids)
    ids.forEach((id, i) => expect(st.isOverlayActive(id)).toBe(i === ids.length - 1))
  })

  it('激活任一种类去活同 pane 全部其余（叶子内跨种类 radio）', () => {
    const ids = CASES.map(c => open(c, 'pane-1'))
    usePaneStore.getState().activateOverlay(ids[0])
    const st = usePaneStore.getState()
    ids.forEach((id, i) => expect(st.isOverlayActive(id)).toBe(i === 0))
    expect(st.layout.activePaneId).toBe('pane-1')
  })

  it('关掉最后一个终端页签时按 activatePriority 激活（dsh > web > doc > MCP）', () => {
    reset(leaf('pane-1', ['s-a']))
    const ids = CASES.map(c => open(c, 'pane-1'))
    // 先全部去活（模拟都在终端视图）
    ids.forEach(id => usePaneStore.getState().deactivateOverlay(id))
    usePaneStore.getState().removeSessionFromPane('pane-1', 's-a')
    const st = usePaneStore.getState()
    const dshId = ids[CASES.findIndex(c => c.kind === 'dshWeb')]
    expect(st.isOverlayActive(dshId)).toBe(true) // 优先级最高者胜出
    ids.filter(id => id !== dshId).forEach(id => expect(st.isOverlayActive(id)).toBe(false))
  })

  // 回归锁：曾把 doomed 谓词原样抄进树编辑的保留过滤 —— 混合 pane 里关一种类会
  // 留下该种类僵尸 ref（payload 已删）并把其余种类的 ref 误删出树（payload 孤儿泄漏）
  it('混合种类 pane 按种类关闭：只摘匹配种类的 ref + payload，其余种类原样', () => {
    const ids = CASES.map(c => open(c, 'pane-1'))
    const webId = ids[CASES.findIndex(c => c.kind === 'web')]

    usePaneStore.getState().closeOverlaysInPane('pane-1', 'web')

    const after = usePaneStore.getState()
    const host = after.getPaneById('pane-1') as PaneLeaf
    expect(host.overlays.some(r => r.id === webId)).toBe(false)      // 匹配种类：ref 摘除
    expect(after.getOverlayPayload(webId)).toBeUndefined()           // payload 回收
    ids.filter(id => id !== webId).forEach(id => {
      expect(host.overlays.some(r => r.id === id)).toBe(true)        // 其余种类：ref 保留
      expect(after.getOverlayPayload(id)).toBeDefined()              // payload 保留
    })
  })

  it('不带 kind 调 closeOverlaysInPane：本 pane 全部覆盖层关闭（ref 与 payload 一并清空）', () => {
    CASES.map(c => open(c, 'pane-1'))
    usePaneStore.getState().closeOverlaysInPane('pane-1')
    const after = usePaneStore.getState()
    expect((after.getPaneById('pane-1') as PaneLeaf).overlays).toHaveLength(0)
    expect(Object.keys(after.overlayPayloads)).toHaveLength(0)
  })
})

// 回归锁：insertSessionAtOverlaySlot 曾只调目标覆盖层自身插槽，同 pane 其它
// slotted 覆盖层不跟随锚点动 —— 会话跨过谁，谁的插槽就该按同一「先删后插」
// 坐标重定基，否则每操作一次兄弟漂移一位（web 多开实例最容易踩）
describe('insertSessionAtOverlaySlot：同 pane 多 slotted 覆盖层联动重定基', () => {
  beforeEach(() => reset())

  const WEB_A = { kind: 'web' as const, url: 'https://a.example.com/', title: 'a' }
  const WEB_B = { kind: 'web' as const, url: 'https://b.example.com/', title: 'b' }

  const openWeb = (paneId: string, payload: OverlayPayload): string =>
    usePaneStore.getState().mountOverlay(paneId, payload)!

  it('会话向右拖过兄弟覆盖层 → 兄弟插槽左移让位（会话插在其原槽位上）', () => {
    reset(leaf('pane-1', ['s-a', 's-b', 's-c']))
    const x = openWeb('pane-1', WEB_A)
    const y = openWeb('pane-1', WEB_B)
    usePaneStore.getState().setOverlaySlot(x, 2) // s-a, Y, s-b, X, s-c
    usePaneStore.getState().setOverlaySlot(y, 1)

    // s-a 拖到 X 页签上（向右）：落 X 后面 —— s-a 跨过了 Y，Y 让到最前
    usePaneStore.getState().insertSessionAtOverlaySlot(x, 'pane-1', 's-a')
    const st = usePaneStore.getState()
    expect((st.getPaneById('pane-1') as PaneLeaf).sessions).toEqual(['s-b', 's-a', 's-c'])
    expect(slotOf(x)).toBe(1) // Y, s-b, X, s-a, s-c
    expect(slotOf(y)).toBe(0) // 兄弟跟随：不重定基则 Y 卡在 s-b 之后（Y, s-b, X, s-a, s-c 错序）
  })

  it('会话向左拖过兄弟覆盖层 → 兄弟插槽右移补位', () => {
    reset(leaf('pane-1', ['s-a', 's-b', 's-c']))
    const x = openWeb('pane-1', WEB_A)
    const y = openWeb('pane-1', WEB_B)
    usePaneStore.getState().setOverlaySlot(x, 1) // s-a, X, s-b, Y, s-c
    usePaneStore.getState().setOverlaySlot(y, 2)

    // s-c 拖到 X 页签上（向左）：落 X 前面 —— s-c 跨过了 Y，Y 右移到 s-b 之后
    usePaneStore.getState().insertSessionAtOverlaySlot(x, 'pane-1', 's-c')
    const st = usePaneStore.getState()
    expect((st.getPaneById('pane-1') as PaneLeaf).sessions).toEqual(['s-a', 's-c', 's-b'])
    expect(slotOf(x)).toBe(2) // s-a, s-c, X, s-b, Y
    expect(slotOf(y)).toBe(3) // 兄弟跟随：不重定基则 Y 与 X 同槽挤进 s-b 之前
  })

  // 回归锁：平局分支（插入点恰落兄弟槽位）的坐标系 —— 曾误用删后坐标判方向，
  // 左向拖拽（fromOrig === slotOrig）时恒判「不弹回」，右邻兄弟每操作向左漂移一位
  it('左向平局：会话原位恰在目标槽位上 → 右邻兄弟 +1 弹回原位（数组不变）', () => {
    reset(leaf('pane-1', ['s-a', 's-b', 's-c']))
    const x = openWeb('pane-1', WEB_A)
    const y = openWeb('pane-1', WEB_B)
    usePaneStore.getState().setOverlaySlot(x, 2)
    usePaneStore.getState().setOverlaySlot(y, 3) // s-a, s-b, X, s-c, Y

    // s-c 拖到 X 上（往左，s-c 恰在 X 槽位）：落 X 前面，sessions 原样
    usePaneStore.getState().insertSessionAtOverlaySlot(x, 'pane-1', 's-c')
    const st = usePaneStore.getState()
    expect((st.getPaneById('pane-1') as PaneLeaf).sessions).toEqual(['s-a', 's-b', 's-c'])
    expect(slotOf(x)).toBe(3) // s-a, s-b, s-c, X, Y
    expect(slotOf(y)).toBe(3) // 兄弟弹回：误用删后坐标则 Y=2，渲染成 s-a, s-b, Y, s-c, X
  })

  it('右向平局：兄弟与目标同槽（删位在其左）→ 会话插目标后，兄弟 +1 让位', () => {
    reset(leaf('pane-1', ['s-a', 's-b', 's-c']))
    const x = openWeb('pane-1', WEB_A)
    const y = openWeb('pane-1', WEB_B)
    usePaneStore.getState().setOverlaySlot(x, 1)
    usePaneStore.getState().setOverlaySlot(y, 1) // 同槽按数组序：s-a, X, Y, s-b, s-c

    // s-a 拖到 X 上（往右）：落 X 后面
    usePaneStore.getState().insertSessionAtOverlaySlot(x, 'pane-1', 's-a')
    const st = usePaneStore.getState()
    expect((st.getPaneById('pane-1') as PaneLeaf).sessions).toEqual(['s-a', 's-b', 's-c'])
    expect(slotOf(x)).toBe(0) // X, s-a, Y, s-b, s-c
    expect(slotOf(y)).toBe(1) // 兄弟让位：不弹回则 Y 与 X 同槽，s-a 被隔到 Y 之后
  })
})
