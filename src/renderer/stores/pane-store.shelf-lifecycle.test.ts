// @vitest-environment jsdom
/**
 * 页签生命周期 × 任务保存区收纳 契约套件 —— 纯 store 逻辑，不渲染组件、不连 PTY/不碰 IPC 服务。
 *
 * 锁死一条统一收敛：关闭页签 / 收入任务栏（收纳）后，若某分屏失去了它最后一个
 * 「可见页签」，这个分屏要让出空间（回并），而后台收纳资源必须迁入存活叶子 ——
 * 原 sessionId / overlayId / payload / 连接身份一并保持，且全树只出现一次。
 *
 * 可见页签的判据（渲染层同口径）：
 *  - 终端：在 pane.sessions 里且未被 hiddenTabSessions 隐藏；
 *  - 覆盖层：在 leaf.overlays 里且未被 shelved —— active=false 只是没激活，
 *    仍然是页签条上的可见页签，不能当空 pane 合并掉。
 * 收纳资源 = hidden + retained 的终端、shelved + retained 的覆盖层引用。
 *
 * 禁止事项：单根叶子永远不删除（全部收纳后回到首页态 activeSessionId=null）；
 * 显式 disconnect（未收纳）语义不变。驱动一律走当前公开 store action
 * （retainShelfResource / toggleLiveSessionTabs / removeSessionFromPane /
 * shelveOverlay / closeOverlay / closeOverlaysInPane），不直接测私有树函数。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findOverlayRef, usePaneStore } from './pane-store'
import { useSessionStore } from './session-store'
import { ConnectionStatus, ConnectionType } from '@shared/types'
import type { OverlayPayload, OverlayRef, PaneLeaf, PaneNode, SessionConfig } from '@shared/types'
import type { SessionState } from './session-store'

// ───────────── 夹具 ─────────────

const leaf = (id: string, sessions: string[], overlays: OverlayRef[] = []): PaneLeaf => ({
  id, type: 'leaf', sessions, activeSessionId: sessions[0] ?? null, overlays
})

const webRef = (id: string, patch: Partial<OverlayRef> = {}): OverlayRef =>
  ({ id, kind: 'web', active: false, slot: null, ...patch })

const docRef = (id: string, patch: Partial<OverlayRef> = {}): OverlayRef =>
  ({ id, kind: 'doc', active: false, slot: null, ...patch })

const webPayload = (url: string): OverlayPayload => ({
  kind: 'web', url, title: new URL(url).hostname
})

const DOC_PAYLOAD: OverlayPayload = {
  kind: 'doc', source: 'local', docKind: 'markdown', path: '/tmp/a.md',
  title: 'a.md', size: 1, mtime: 1, content: '# hi'
}

// pane-a | pane-b
const twoPaneRoot = (first: PaneLeaf, second: PaneLeaf): PaneNode => ({
  id: 'split-1', type: 'split', direction: 'horizontal', splitRatio: 0.5,
  firstChild: first, secondChild: second
})

// pane-a | (pane-b / pane-c) —— 「只合并失去可见页签的那一格」需要嵌套树
const nestedThreePaneRoot = (a: PaneLeaf, b: PaneLeaf, c: PaneLeaf): PaneNode => ({
  id: 'split-1', type: 'split', direction: 'horizontal', splitRatio: 0.5,
  firstChild: a,
  secondChild: {
    id: 'split-2', type: 'split', direction: 'vertical', splitRatio: 0.5,
    firstChild: b, secondChild: c
  }
})

interface Seed {
  root: PaneNode
  activePaneId: string
  overlayPayloads?: Record<string, OverlayPayload>
  hidden?: Record<string, boolean>
  retained?: Record<string, boolean>
}

// 独立重置：布局 / payload / 隐藏 / 保留 / 拖拽标记全部落回夹具值，
// 不依赖上一用例的残留（拖拽标记残留会让渲染层卡在拖拽期隐藏态）
const seed = ({ root, activePaneId, overlayPayloads = {}, hidden = {}, retained = {} }: Seed): void => {
  usePaneStore.setState({
    layout: { root, activePaneId },
    overlayPayloads,
    hiddenTabSessions: hidden,
    retainedSessionIds: retained,
    draggingOverlayId: null,
    draggingSessionId: null
  })
}

const store = () => usePaneStore.getState()
const leaves = (): PaneLeaf[] => store().getAllLeafPanes()
const leafIds = (): string[] => leaves().map(l => l.id)
const paneOf = (sessionId: string): PaneLeaf | undefined => leaves().find(l => l.sessions.includes(sessionId))
const occurrences = (sessionId: string): number => leaves().filter(l => l.sessions.includes(sessionId)).length
const refOf = (id: string): OverlayRef | undefined => findOverlayRef(store().layout.root, id)?.ref
const refsOf = (id: string): OverlayRef[] => leaves().flatMap(l => l.overlays.filter(r => r.id === id))
const paneOfOverlay = (id: string): string | undefined => findOverlayRef(store().layout.root, id)?.leaf.id
const overlayIds = (): string[] => leaves().flatMap(l => l.overlays.map(r => r.id))
const activeSessionOf = (paneId: string): string | null | undefined => {
  const node = store().getPaneById(paneId)
  return node?.type === 'leaf' ? node.activeSessionId : undefined
}

// ───────────── session-store 独立重置（连接身份断言的数据源） ─────────────

const sessionState = (id: string): SessionState => ({
  id,
  config: {
    id,
    name: `shelf-lifecycle-${id}`,
    type: ConnectionType.LOCAL,
    terminal: {
      fontFamily: 'Consolas', fontSize: 12, theme: {} as SessionConfig['terminal']['theme'],
      cursorStyle: 'bar', cursorBlink: false, scrollback: 10, encoding: 'utf-8'
    },
    tags: [], createdAt: new Date(), updatedAt: new Date()
  },
  status: ConnectionStatus.CONNECTED
})

const ALL_SESSIONS = ['s-a', 's-b', 's-c', 's-1', 's-2', 's-a-held', 's-b-held', 's-c-held']

beforeEach(() => {
  localStorage.clear()
  useSessionStore.setState({
    savedSessions: [],
    sessions: ALL_SESSIONS.map(sessionState),
    reachability: {},
    pendingRuntimeEncoding: {},
    pendingSessionCwd: {},
    pendingSessionStatus: {},
    activeSessionId: null
  })
})

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

// ───────────── 收纳 terminal：引用不会因页签关闭而消失 ─────────────

describe('收纳 terminal：隐藏 + 保留标记与引用', () => {
  it('两叶收纳 terminal（retainShelfResource 再 toggleLiveSessionTabs true）：收走最后一个可见页签后分屏回并，资源迁入存活叶子', () => {
    seed({
      root: twoPaneRoot(leaf('pane-a', ['s-a']), leaf('pane-b', ['s-b'])),
      activePaneId: 'pane-b'
    })

    // 生产路径同序：先落保留标记（capture 成功），再隐藏页签
    store().retainShelfResource('s-a', true, true)
    store().toggleLiveSessionTabs(['s-a'], true)

    expect(store().retainedSessionIds['s-a']).toBe(true)
    expect(store().hiddenTabSessions['s-a']).toBe(true)
    // 收纳不是关闭：引用仍在树里，且全树只有一份
    expect(occurrences('s-a')).toBe(1)
    // 收入任务栏等于移除最后一个可见页签：让出的分屏回并，资源随迁到存活叶子
    expect(leafIds()).toEqual(['pane-b'])
    expect(paneOf('s-a')?.id).toBe('pane-b')
    expect(activeSessionOf('pane-b')).toBe('s-b')
    expect(store().layout.activePaneId).toBe('pane-b')
    // 连接身份不动（收纳只隐藏入口，不碰会话）
    expect(useSessionStore.getState().sessions.find(s => s.id === 's-a')?.status)
      .toBe(ConnectionStatus.CONNECTED)
  })

  it('已收纳 terminal 再走 removeSessionFromPane：必须保留引用与 hidden/retained 标记', () => {
    seed({
      root: twoPaneRoot(leaf('pane-a', ['s-a']), leaf('pane-b', ['s-b'])),
      activePaneId: 'pane-b',
      hidden: { 's-a': true },
      retained: { 's-a': true }
    })

    // 页签关闭路径撞上「任务保存区仍持有」的实例：不得销毁后台现场
    store().removeSessionFromPane('pane-a', 's-a')

    // 引用与标记都不得消失（位置允许随回并迁移，身份不允许变）
    const holder = paneOf('s-a')
    expect(holder).toBeDefined()
    expect(occurrences('s-a')).toBe(1)
    expect(leafIds()).toEqual(['pane-b'])
    expect(holder?.id).toBe('pane-b')
    expect(store().hiddenTabSessions['s-a']).toBe(true)
    expect(store().retainedSessionIds['s-a']).toBe(true)
  })
})

// ───────────── 收纳覆盖层：shelve 与 retained close 同一挂载态 ─────────────

describe('收纳覆盖层：shelveOverlay 与 retained 引用上的 closeOverlay 一致', () => {
  it('网页 shelveOverlay 与 retained 引用 closeOverlay 收敛到同一态，payload 原样保留', () => {
    const payload = webPayload('https://example.org/')
    const mount = (ref: OverlayRef): void => seed({
      root: twoPaneRoot(leaf('pane-a', ['s-a'], [ref]), leaf('pane-b', ['s-b'])),
      activePaneId: 'pane-a',
      overlayPayloads: { 'web-1': payload }
    })

    mount(webRef('web-1', { active: true }))
    store().shelveOverlay('web-1')
    const shelved = {
      ref: { ...refOf('web-1') },
      payload: store().overlayPayloads['web-1'],
      pane: paneOfOverlay('web-1'),
      leaves: leafIds()
    }

    // 任务保存区持有（retained）的引用上走 close：必须收敛为「再次收纳」而非销毁
    mount(webRef('web-1', { active: true, retained: true }))
    store().closeOverlay('web-1')
    const closed = {
      ref: { ...refOf('web-1') },
      payload: store().overlayPayloads['web-1'],
      pane: paneOfOverlay('web-1'),
      leaves: leafIds()
    }

    expect(closed).toEqual(shelved)
    expect(shelved.ref).toMatchObject({
      id: 'web-1', kind: 'web', active: false, shelved: true, retained: true
    })
    expect(shelved.payload).toBe(payload)
    expect(shelved.pane).toBe('pane-a')
  })

  it('普通不可见但未 shelved 的覆盖层依然是可见页签：终端清空后该 pane 不得当空 pane 回并', () => {
    seed({
      root: twoPaneRoot(
        leaf('pane-a', ['s-a'], [docRef('doc-1')]),
        leaf('pane-b', ['s-b'])
      ),
      activePaneId: 'pane-b',
      overlayPayloads: { 'doc-1': DOC_PAYLOAD }
    })

    store().removeSessionFromPane('pane-a', 's-a')

    // 未 shelved 的 doc 只是没被激活，页签仍在：pane 必须保留（doc 也不参与自动激活）
    expect(leafIds()).toEqual(['pane-a', 'pane-b'])
    expect(paneOfOverlay('doc-1')).toBe('pane-a')
    expect(refOf('doc-1')?.active).toBe(false)
    expect(refOf('doc-1')?.shelved).toBeUndefined()
    expect(refOf('doc-1')?.retained).toBeUndefined()
    expect(store().overlayPayloads['doc-1']).toBe(DOC_PAYLOAD)
    expect(activeSessionOf('pane-a')).toBeNull()
  })
})

// ───────────── 回并与后台资源迁移 ─────────────

describe('最后一个可见页签移除后的回并与资源迁移', () => {
  it('混合 terminal/web 仍有可见页签：关掉其中一个页签不合并分屏', () => {
    const payload = webPayload('https://example.org/')
    seed({
      root: twoPaneRoot(
        leaf('pane-a', ['s-a', 's-a-held'], [webRef('web-1')]),
        leaf('pane-b', ['s-b'])
      ),
      activePaneId: 'pane-a',
      hidden: { 's-a-held': true },
      retained: { 's-a-held': true },
      overlayPayloads: { 'web-1': payload }
    })

    store().removeSessionFromPane('pane-a', 's-a')

    // web-1 未被 shelved，仍是可见页签：pane-a 有活可留，不能回并
    expect(leafIds()).toEqual(['pane-a', 'pane-b'])
    expect(paneOfOverlay('web-1')).toBe('pane-a')
    expect(store().overlayPayloads['web-1']).toBe(payload)
    expect(occurrences('s-a-held')).toBe(1)
  })

  it('普通 terminal 关掉最后一个可见页签、pane 尚有隐藏收纳资源：分屏回并且资源迁入存活叶子', () => {
    seed({
      root: twoPaneRoot(leaf('pane-a', ['s-a', 's-a-held']), leaf('pane-b', ['s-b'])),
      activePaneId: 'pane-b',
      hidden: { 's-a-held': true },
      retained: { 's-a-held': true }
    })

    store().removeSessionFromPane('pane-a', 's-a')

    // 失去全部可见页签 → 让出的分屏回并
    expect(leafIds()).toEqual(['pane-b'])
    expect(paneOf('s-a')).toBeUndefined()
    // 后台收纳资源迁入存活叶子，且只出现一次
    expect(occurrences('s-a-held')).toBe(1)
    expect(paneOf('s-a-held')?.id).toBe('pane-b')
    expect(store().hiddenTabSessions['s-a-held']).toBe(true)
    expect(store().retainedSessionIds['s-a-held']).toBe(true)
    // 存活叶子的可见页签与焦点不被后台资源顶掉
    expect(paneOf('s-a-held')?.sessions).toContain('s-b')
    expect(activeSessionOf('pane-b')).toBe('s-b')
    expect(store().layout.activePaneId).toBe('pane-b')
    // 连接不被断开
    expect(useSessionStore.getState().sessions.find(s => s.id === 's-a-held')?.status)
      .toBe(ConnectionStatus.CONNECTED)
  })

  it('普通 web 关掉最后一个可见页签、pane 尚有隐藏收纳覆盖层：分屏回并且引用/payload 不丢', () => {
    const heldPayload = webPayload('https://held.example.org/')
    const livePayload = webPayload('https://live.example.org/')
    seed({
      root: twoPaneRoot(
        leaf('pane-a', [], [
          webRef('web-live', { active: true }),
          webRef('web-held', { shelved: true, retained: true })
        ]),
        leaf('pane-b', ['s-b'])
      ),
      activePaneId: 'pane-b',
      overlayPayloads: { 'web-live': livePayload, 'web-held': heldPayload }
    })

    store().closeOverlay('web-live')

    expect(leafIds()).toEqual(['pane-b'])
    expect(paneOfOverlay('web-held')).toBe('pane-b')
    expect(refsOf('web-held')).toHaveLength(1)
    expect(refOf('web-held')).toMatchObject({ active: false, shelved: true, retained: true })
    expect(store().overlayPayloads['web-held']).toBe(heldPayload)
    expect(store().overlayPayloads['web-live']).toBeUndefined()
    expect(store().layout.activePaneId).toBe('pane-b')
  })

  it('嵌套三叶：只合并失去可见页签的分屏，后台活动 pane 焦点保持', () => {
    seed({
      root: nestedThreePaneRoot(
        leaf('pane-a', ['s-a']),
        leaf('pane-b', ['s-b', 's-b-held']),
        leaf('pane-c', ['s-c'])
      ),
      activePaneId: 'pane-c',
      hidden: { 's-b-held': true },
      retained: { 's-b-held': true }
    })

    store().removeSessionFromPane('pane-b', 's-b')

    // 只有 pane-b 失去全部可见页签；pane-a / pane-c 原样保留
    expect(leafIds()).toEqual(['pane-a', 'pane-c'])
    expect(paneOf('s-a')?.id).toBe('pane-a')
    expect(paneOf('s-c')?.id).toBe('pane-c')
    expect(occurrences('s-b-held')).toBe(1)
    expect(paneOf('s-b-held')?.id).toBe('pane-c')
    expect(store().hiddenTabSessions['s-b-held']).toBe(true)
    expect(store().retainedSessionIds['s-b-held']).toBe(true)
    // 后台活动 pane 不因合并被抢焦点
    expect(store().layout.activePaneId).toBe('pane-c')
  })
})

// ───────────── 单根叶子 / 显式 disconnect ─────────────

describe('单根叶子与首页态', () => {
  it('单根全部收纳：根叶不删除，隐藏/保留资源与 payload 全留，activeSessionId 回到 null', () => {
    const heldPayload = webPayload('https://held.example.org/')
    seed({
      root: leaf('pane-root', ['s-1', 's-2'], [webRef('web-held', { shelved: true, retained: true })]),
      activePaneId: 'pane-root',
      hidden: { 's-2': true },
      retained: { 's-2': true },
      overlayPayloads: { 'web-held': heldPayload }
    })

    store().removeSessionFromPane('pane-root', 's-1')

    // 根叶不可删（删了就把后台现场一起丢了）
    expect(leafIds()).toEqual(['pane-root'])
    expect(paneOf('s-2')?.id).toBe('pane-root')
    expect(store().hiddenTabSessions['s-2']).toBe(true)
    expect(store().retainedSessionIds['s-2']).toBe(true)
    expect(refOf('web-held')).toMatchObject({ shelved: true, retained: true })
    expect(store().overlayPayloads['web-held']).toBe(heldPayload)
    // 没有可见页签 → 首页态；activeSessionId 不能指向被隐藏的收纳会话
    expect(activeSessionOf('pane-root')).toBeNull()
    expect(store().layout.activePaneId).toBe('pane-root')
  })

  it('显式 disconnect（未收纳）语义不变：关掉单根最后一个页签 → 空单叶 + activeSessionId=null', () => {
    seed({ root: leaf('pane-root', ['s-1']), activePaneId: 'pane-root' })

    store().removeSessionFromPane('pane-root', 's-1')

    const remaining = leaves()
    expect(remaining).toHaveLength(1)
    expect(remaining[0].sessions).toEqual([])
    expect(remaining[0].activeSessionId).toBeNull()
    expect(store().layout.activePaneId).toBe(remaining[0].id)
    expect(store().hiddenTabSessions['s-1']).toBeUndefined()
    expect(store().retainedSessionIds['s-1']).toBeUndefined()
  })

  it('两叶且无收纳资源：关掉一侧最后一个页签 → 回并成单叶（既有回并语义不变）', () => {
    seed({
      root: twoPaneRoot(leaf('pane-a', ['s-a']), leaf('pane-b', ['s-b'])),
      activePaneId: 'pane-a'
    })

    store().removeSessionFromPane('pane-b', 's-b')

    expect(leafIds()).toEqual(['pane-a'])
    expect(store().layout.activePaneId).toBe('pane-a')
  })
})

// ───────────── 顺序无关 / 幂等 ─────────────

describe('顺序无关与幂等', () => {
  it('重复关闭已移除的普通终端不再衰减覆盖层插槽', () => {
    seed({ root: leaf('root', ['s-a', 's-b'], [webRef('web', { slot: 2 })]), activePaneId: 'root',
      overlayPayloads: { web: webPayload('https://example.org/') } })
    store().removeSessionFromPane('root', 's-a')
    expect(refOf('web')?.slot).toBe(1)
    store().removeSessionFromPane('root', 's-a')
    expect(refOf('web')?.slot).toBe(1)
    expect(paneOf('s-b')?.activeSessionId).toBe('s-b')
  })

  it('收纳资源迁移时插槽按新宿主会话坐标平移', () => {
    seed({ root: twoPaneRoot(leaf('pane-a', ['s-a'], [webRef('web', { slot: 0 })]), leaf('pane-b', ['s-b'])),
      activePaneId: 'pane-b', overlayPayloads: { web: webPayload('https://example.org/') } })
    store().retainShelfResource('s-a', true, true)
    store().toggleLiveSessionTabs(['s-a'], true)
    store().shelveOverlay('web')
    expect(leafIds()).toEqual(['pane-b'])
    expect(refOf('web')?.slot).toBe(1)
    expect(paneOf('s-a')?.sessions).toEqual(['s-b', 's-a'])
  })

  const mixed = (): void => seed({
    root: twoPaneRoot(leaf('pane-a', ['s-a'], [webRef('web-1')]), leaf('pane-b', ['s-b'])),
    activePaneId: 'pane-b',
    overlayPayloads: { 'web-1': webPayload('https://example.org/') }
  })

  const snapshot = () => {
    const s = usePaneStore.getState()
    return JSON.parse(JSON.stringify({
      root: s.layout.root,
      activePaneId: s.layout.activePaneId,
      hidden: s.hiddenTabSessions,
      retained: s.retainedSessionIds,
      payloads: s.overlayPayloads
    }))
  }

  it('先隐藏 terminal 再收 web，与反序执行，最终树/标记/payload 完全一致', () => {
    mixed()
    store().retainShelfResource('s-a', true, true)
    store().toggleLiveSessionTabs(['s-a'], true)
    store().shelveOverlay('web-1')
    const hideThenShelve = snapshot()

    mixed()
    store().shelveOverlay('web-1')
    store().retainShelfResource('s-a', true, true)
    store().toggleLiveSessionTabs(['s-a'], true)
    const shelveThenHide = snapshot()

    expect(shelveThenHide).toEqual(hideThenShelve)
    expect(hideThenShelve.hidden).toEqual({ 's-a': true })
    expect(hideThenShelve.retained).toEqual({ 's-a': true })
    expect(refOf('web-1')).toMatchObject({ active: false, shelved: true, retained: true })
    expect(store().retainedSessionIds['s-a']).toBe(true)
  })

  it('重复 hide / 重复 close 幂等：状态不再变化', () => {
    mixed()
    store().retainShelfResource('s-a', true, true)
    store().toggleLiveSessionTabs(['s-a'], true)
    store().shelveOverlay('web-1')
    const once = snapshot()

    store().retainShelfResource('s-a', true, true)
    store().toggleLiveSessionTabs(['s-a'], true)
    store().shelveOverlay('web-1')
    expect(snapshot()).toEqual(once)

    // retained 引用上的 close 收敛为「再次收纳」，重复调用同样无变化
    store().closeOverlay('web-1')
    store().closeOverlay('web-1')
    expect(snapshot()).toEqual(once)
  })
})

// ───────────── 批量 ─────────────

describe('批量操作', () => {
  it('批量隐藏跨多 pane：每个收纳资源全树只出现一次，至少保留一个根叶', () => {
    seed({
      root: twoPaneRoot(leaf('pane-a', ['s-a', 's-a-held']), leaf('pane-b', ['s-b'])),
      activePaneId: 'pane-a',
      hidden: { 's-a-held': true },
      retained: { 's-a-held': true }
    })

    store().retainShelfResource('s-a', true, true)
    store().toggleLiveSessionTabs(['s-a', 's-a-held', 's-b'], true)

    for (const sid of ['s-a', 's-a-held', 's-b']) expect(occurrences(sid)).toBe(1)
    expect(leaves()).toHaveLength(1)
    expect(store().hiddenTabSessions).toEqual({ 's-a': true, 's-a-held': true, 's-b': true })
    expect(store().retainedSessionIds['s-a']).toBe(true)
    expect(store().retainedSessionIds['s-a-held']).toBe(true)

    // 再逐个走关闭路径：非收纳项正常消失并触发回并，收纳资源仍各一份、根叶还在
    for (const pane of leaves()) {
      for (const sid of [...pane.sessions]) store().removeSessionFromPane(pane.id, sid)
    }
    expect(occurrences('s-b')).toBe(0)
    expect(occurrences('s-a')).toBe(1)
    expect(occurrences('s-a-held')).toBe(1)
    expect(leaves().length).toBeGreaterThanOrEqual(1)
    expect(store().hiddenTabSessions['s-a']).toBe(true)
    expect(store().hiddenTabSessions['s-a-held']).toBe(true)
  })

  it('closeOverlaysInPane 混合 held / 非 held：中途不丢资源，held 逐份保留，非 held 连 payload 回收', () => {
    const heldWeb = webPayload('https://held.example.org/')
    const doomedWeb = webPayload('https://doomed.example.org/')
    seed({
      root: twoPaneRoot(
        leaf('pane-a', [], [
          webRef('web-held', { shelved: true, retained: true }),
          webRef('web-doomed', { active: true }),
          docRef('doc-held', { shelved: true, retained: true })
        ]),
        leaf('pane-b', ['s-b'])
      ),
      activePaneId: 'pane-b',
      overlayPayloads: { 'web-held': heldWeb, 'web-doomed': doomedWeb, 'doc-held': DOC_PAYLOAD }
    })

    store().closeOverlaysInPane('pane-a')

    expect(overlayIds()).toEqual(['web-held', 'doc-held'])
    expect(refsOf('web-held')).toHaveLength(1)
    expect(refOf('web-held')).toMatchObject({ active: false, shelved: true, retained: true })
    expect(refOf('doc-held')).toMatchObject({ active: false, shelved: true, retained: true })
    expect(store().overlayPayloads['web-held']).toBe(heldWeb)
    expect(store().overlayPayloads['doc-held']).toBe(DOC_PAYLOAD)
    expect(store().overlayPayloads['web-doomed']).toBeUndefined()
    // 该 pane 只剩「已被收纳」的引用：允许回并，但资源必须随迁存活、且各只一份
    const survivors = leafIds()
    expect(survivors).toEqual(['pane-b'])
    for (const id of ['web-held', 'doc-held']) {
      expect(survivors).toContain(paneOfOverlay(id) ?? '')
    }
  })

  it('closeOverlaysInPane 带 kind 过滤：非该种类的 held / 非 held 都不动，且不丢 payload', () => {
    const heldWeb = webPayload('https://held.example.org/')
    const doomedWeb = webPayload('https://doomed.example.org/')
    seed({
      root: twoPaneRoot(
        leaf('pane-a', [], [
          webRef('web-held', { shelved: true, retained: true }),
          webRef('web-doomed', { active: true }),
          docRef('doc-other')
        ]),
        leaf('pane-b', ['s-b'])
      ),
      activePaneId: 'pane-b',
      overlayPayloads: { 'web-held': heldWeb, 'web-doomed': doomedWeb, 'doc-other': DOC_PAYLOAD }
    })

    store().closeOverlaysInPane('pane-a', 'web')

    // kind 过滤只作用于 web：held web 保留、doomed web 回收、doc 原样（含 payload）
    expect(overlayIds()).toEqual(['web-held', 'doc-other'])
    expect(refOf('web-held')).toMatchObject({ shelved: true, retained: true })
    expect(refOf('doc-other')).toMatchObject({ active: false })
    expect(store().overlayPayloads['web-held']).toBe(heldWeb)
    expect(store().overlayPayloads['doc-other']).toBe(DOC_PAYLOAD)
    expect(store().overlayPayloads['web-doomed']).toBeUndefined()
    expect(paneOfOverlay('doc-other')).toBe('pane-a')
  })
})
