// @vitest-environment jsdom
/**
 * 空 pane 目标契约 + 关闭 pane 焦点兜底 —— 两类历史缺陷的回归锁：
 *
 * 1) 空 pane 目标保护（removeEmptyPanes 的 keepId 豁免）：把会话拖进空 pane 时，
 *    目标 pane 在 removeSessionFromAllPanes + removeEmptyPanes 清理中途被回收，
 *    会话落进 leaves[0] 兜底 —— 三 pane 树上等于跨 pane 传送、两 pane 树上等于
 *    drop 被静默吞掉（会话弹回源 pane）。keepId 豁免后空目标是合法承口。
 * 2) 关闭 pane 的焦点兜底（settleActivePaneAfterClose）：closePane /
 *    removeSessionFromPane 曾无条件重置 activePaneId 到 leaves[0] —— 关后台
 *    pane 会抢走焦点、关中间 pane 焦点不去吸收侧兄弟。现在 active 有效即保持，
 *    失效才落到吸收侧兄弟首个存活叶子。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { usePaneStore } from './pane-store'
import type { OverlayRef, PaneLeaf, PaneNode } from '@shared/types'

const leaf = (id: string, sessions: string[], overlays: OverlayRef[] = []): PaneLeaf => ({
  id, type: 'leaf', sessions, activeSessionId: sessions[0] ?? null, overlays
})

// 三叶树：pane-a | (pane-b / pane-c)，覆盖「关闭中置 pane」「拖进右侧空 pane」等场景
const threePaneRoot = (): PaneNode => ({
  id: 'split-1', type: 'split', direction: 'horizontal', splitRatio: 0.5,
  firstChild: leaf('pane-a', ['s-a']),
  secondChild: {
    id: 'split-2', type: 'split', direction: 'vertical', splitRatio: 0.5,
    firstChild: leaf('pane-b', ['s-b']),
    secondChild: leaf('pane-c', ['s-c'])
  }
})

const leavesOf = (node: PaneNode): PaneLeaf[] =>
  node.type === 'leaf' ? [node] : [...leavesOf(node.firstChild), ...leavesOf(node.secondChild)]

const paneOf = (sessionId: string): PaneLeaf | undefined =>
  leavesOf(usePaneStore.getState().layout.root).find(l => l.sessions.includes(sessionId))

const setLayout = (root: PaneNode, activePaneId: string): void => {
  usePaneStore.setState({
    layout: { root, activePaneId },
    overlayPayloads: {}, draggingOverlayId: null, draggingSessionId: null, hiddenTabSessions: {}
  })
}

beforeEach(() => {
  localStorage.clear()
})

describe('空 pane 目标保护（keepId 豁免）', () => {
  it('三 pane 树：把 s-a 拖进右侧空 pane 中心 → s-a 落进目标 pane，不跨 pane 传送', () => {
    // split-1 { split-2 { pane-a, pane-b }, pane-e(空) } —— pane-e 是 Ctrl+Shift+H 拆出的空位
    const root: PaneNode = {
      id: 'split-1', type: 'split', direction: 'horizontal', splitRatio: 0.5,
      firstChild: {
        id: 'split-2', type: 'split', direction: 'vertical', splitRatio: 0.5,
        firstChild: leaf('pane-a', ['s-a']),
        secondChild: leaf('pane-b', ['s-b'])
      },
      secondChild: leaf('pane-e', [])
    }
    setLayout(root, 'pane-a')

    usePaneStore.getState().addSessionToPane('pane-e', 's-a')

    // 历史缺陷：pane-e 被中途回收，s-a 落进 pane-b、整棵树塌缩成单叶
    expect(paneOf('s-a')?.id).toBe('pane-e')
    expect(paneOf('s-b')?.id).toBe('pane-b')
    expect(leavesOf(usePaneStore.getState().layout.root)).toHaveLength(2)
  })

  it('两 pane 树：把 pane 内一个会话拖进空 pane 中心 → 会话移入空 pane（drop 不再被吞）', () => {
    setLayout({
      id: 'split-1', type: 'split', direction: 'horizontal', splitRatio: 0.5,
      firstChild: leaf('pane-x', ['s1', 's2']),
      secondChild: leaf('pane-e', [])
    }, 'pane-x')

    usePaneStore.getState().addSessionToPane('pane-e', 's1')

    // 历史缺陷：pane-e 被回收后 s1 弹回 pane-x（变成 [s2, s1] 的静默换位）
    expect(paneOf('s1')?.id).toBe('pane-e')
    expect(paneOf('s2')?.id).toBe('pane-x')
  })

  it('两 pane 树：拖到空 pane 边缘 → 空目标分支直接承接会话，不误拆 leaves[0]', () => {
    setLayout({
      id: 'split-1', type: 'split', direction: 'horizontal', splitRatio: 0.5,
      firstChild: leaf('pane-x', ['s1', 's2']),
      secondChild: leaf('pane-e', [])
    }, 'pane-x')

    usePaneStore.getState().splitPaneWithPosition('pane-e', 'vertical', 's1', 'first')

    // 历史缺陷：pane-e 被回收，目标解析成 leaves[0]=pane-x → 把 pane-x 拆成了 [s1]/[s2]
    expect(paneOf('s1')?.id).toBe('pane-e')
    expect(paneOf('s2')?.id).toBe('pane-x')
    expect(leavesOf(usePaneStore.getState().layout.root)).toHaveLength(2)
  })

  it('源 pane 只剩被拖会话、目标是空兄弟：目标承接会话，源侧自然回并', () => {
    setLayout({
      id: 'split-1', type: 'split', direction: 'horizontal', splitRatio: 0.5,
      firstChild: leaf('pane-x', ['s1']),
      secondChild: leaf('pane-e', [])
    }, 'pane-x')

    usePaneStore.getState().addSessionToPane('pane-e', 's1')

    const leaves = leavesOf(usePaneStore.getState().layout.root)
    expect(leaves).toHaveLength(1)
    expect(leaves[0].sessions).toEqual(['s1'])
  })
})

describe('关闭 pane 的焦点兜底（settleActivePaneAfterClose）', () => {
  it('closePane 关后台 pane：焦点保持在原活动 pane，不被抢到 leaves[0]', () => {
    setLayout(threePaneRoot(), 'pane-c')

    usePaneStore.getState().closePane('pane-b')

    // 历史缺陷：无条件 leaves[0] → 焦点跳去 pane-a
    expect(usePaneStore.getState().layout.activePaneId).toBe('pane-c')
    expect(leavesOf(usePaneStore.getState().layout.root).map(l => l.id)).toEqual(['pane-a', 'pane-c'])
  })

  it('closePane 关活动 pane：焦点落到吸收侧兄弟，而非 leaves[0]', () => {
    setLayout(threePaneRoot(), 'pane-b')

    usePaneStore.getState().closePane('pane-b')

    // pane-b 让出的空间由兄弟 pane-c 接管，焦点跟过去；历史缺陷是跳去 pane-a
    expect(usePaneStore.getState().layout.activePaneId).toBe('pane-c')
  })

  it('removeSessionFromPane 关后台 pane 最后一个页签（pane 随之回并）：焦点保持', () => {
    setLayout(threePaneRoot(), 'pane-c')

    usePaneStore.getState().removeSessionFromPane('pane-b', 's-b')

    expect(usePaneStore.getState().layout.activePaneId).toBe('pane-c')
    expect(leavesOf(usePaneStore.getState().layout.root).map(l => l.id)).toEqual(['pane-a', 'pane-c'])
  })

  it('removeSessionFromPane 关后台纯覆盖层 pane 的最后一个终端页签：pane 保留、焦点保持', () => {
    const root = threePaneRoot()
    if (root.type !== 'split') throw new Error('前置：应为 split 根')
    const inner = root.secondChild
    if (inner.type !== 'split') throw new Error('前置：second 应为 split')
    inner.firstChild = leaf('pane-b', ['s-b'], [{ id: 'doc-1', kind: 'doc', active: false, slot: null }])
    usePaneStore.setState({
      layout: { root, activePaneId: 'pane-a' },
      overlayPayloads: {
        'doc-1': {
          kind: 'doc', source: 'local', docKind: 'markdown', path: '/tmp/a.md',
          title: 'a.md', size: 1, mtime: 1, content: '# hi'
        }
      },
      draggingOverlayId: null, draggingSessionId: null, hiddenTabSessions: {}
    })

    usePaneStore.getState().removeSessionFromPane('pane-b', 's-b')

    // pane-b 因承载文档页签保留；历史缺陷：activePaneId 被强制改到 pane-b（抢焦点）
    expect(usePaneStore.getState().layout.activePaneId).toBe('pane-a')
    expect(paneOf('s-b')).toBeUndefined()
    expect(leavesOf(usePaneStore.getState().layout.root).map(l => l.id)).toContain('pane-b')
  })
})

describe('会话拖拽标记（draggingSessionId，拖拽盾挂起条件之一）', () => {
  it('setDraggingSession 置位/复位往返', () => {
    usePaneStore.getState().setDraggingSession('s-a')
    expect(usePaneStore.getState().draggingSessionId).toBe('s-a')
    usePaneStore.getState().setDraggingSession(null)
    expect(usePaneStore.getState().draggingSessionId).toBeNull()
  })
})
