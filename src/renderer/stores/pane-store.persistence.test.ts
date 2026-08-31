// @vitest-environment jsdom
/**
 * 布局持久化契约测试 —— 锁「覆盖层瞬态」在 localStorage 两侧的防线：
 * 1) 保存侧：subscribeToLayoutChanges 落盘前 stripOverlays，树只存终端布局
 * 2) 读取侧：loadSavedLayout → filterValidSessions 强制归零叶子 overlays，
 *    手改存储注入的垃圾引用进不了运行时树
 * 另锁当前生产入口的 write-only 现状（loadSavedLayout([]) 恒 null）——
 * 将来若要真正恢复布局，是有意的行为变更，须连着入口一起改。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { usePaneStore, loadSavedLayout } from './pane-store'
import type { OverlayRef, PaneLayout, PaneLeaf, PaneNode } from '@shared/types'

const LAYOUT_KEY = 'lyshell_pane_layout'

const leafOf = (id: string, sessions: string[], overlays: OverlayRef[] = []): PaneLeaf => ({
  id,
  type: 'leaf',
  sessions,
  activeSessionId: sessions[0] ?? null,
  overlays
})

// 双叶 split 布局：pane-1 [s-a]、pane-2 [s-b]
const splitLayout = (): PaneLayout => ({
  root: {
    id: 'split-1', type: 'split', direction: 'horizontal', splitRatio: 0.5,
    firstChild: leafOf('pane-1', ['s-a']),
    secondChild: leafOf('pane-2', ['s-b'])
  },
  activePaneId: 'pane-1'
})

const leavesOf = (node: PaneNode): PaneLeaf[] =>
  node.type === 'leaf' ? [node] : [...leavesOf(node.firstChild), ...leavesOf(node.secondChild)]

beforeEach(() => {
  localStorage.clear()
})

describe('保存侧：布局自动保存剥离 overlays', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('带覆盖层引用的布局落盘后叶子 overlays 全空，终端结构/会话原样保留（300ms 去抖后写入）', () => {
    vi.useFakeTimers()
    const withOverlays = splitLayout()
    const root = withOverlays.root
    if (root.type !== 'split') throw new Error('前置：应为 split 布局')
    root.firstChild = leafOf('pane-1', ['s-a'], [
      { id: 'doc-evil', kind: 'doc', active: true, slot: null }
    ])
    usePaneStore.setState({ layout: withOverlays })

    // 尾随去抖（拖分屏调宽不逐帧落盘）：窗口内不写，到期才落盘
    vi.advanceTimersByTime(299)
    expect(localStorage.getItem(LAYOUT_KEY)).toBeNull()
    vi.advanceTimersByTime(1)

    const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null') as PaneLayout | null
    if (!saved) throw new Error('去抖到期后应已落盘')
    expect(saved.root.type).toBe('split')
    const leaves = leavesOf(saved.root)
    expect(leaves.map(l => l.sessions)).toEqual([['s-a'], ['s-b']]) // 终端布局保留
    expect(leaves.every(l => l.overlays.length === 0)).toBe(true)   // 覆盖层引用剥离
  })
})

describe('读取侧：手改 localStorage 注入 overlays 后读取清空', () => {
  it('存储里带垃圾覆盖层引用的布局，读出的树 overlays 全空（瞬态引用不进运行时树）', () => {
    const layout = splitLayout()
    const root = layout.root
    if (root.type !== 'split') throw new Error('前置：应为 split 布局')
    root.firstChild = leafOf('pane-1', ['s-a', 's-b'], [
      { id: 'doc-injected', kind: 'doc', active: true, slot: null },
      { id: 'web-injected', kind: 'web', active: false, slot: 1 }
    ])
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout))

    const loaded = loadSavedLayout(['s-a', 's-b'])
    if (!loaded) throw new Error('有效会话集应能恢复结构')
    const leaves = leavesOf(loaded.root)
    expect(leaves.every(l => l.overlays.length === 0)).toBe(true)     // 注入引用被强制归零
    expect(leaves.map(l => l.sessions)).toEqual([['s-a', 's-b'], ['s-b']])
    expect(loaded.activePaneId).toBe('pane-1')
  })

  it('无效 sessionId 一并被过滤（只恢复已知会话的分屏结构，空叶回并）', () => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(splitLayout()))
    const loaded = loadSavedLayout(['s-a']) // s-b 未知：pane-2 过滤后空叶被回并
    if (!loaded) throw new Error('存在有效会话应能恢复')
    const leaves = leavesOf(loaded.root)
    expect(leaves).toHaveLength(1)
    expect(leaves[0].sessions).toEqual(['s-a'])
    expect(leaves[0].activeSessionId).toBe('s-a')
  })

  it('当前生产入口传空 session 集 → 恢复不出任何有效叶子返回 null（write-only 现状锁定）', () => {
    // 入口见 pane-store 初始化：loadSavedLayout([]) 本意只恢复分屏结构，但空集
    // 会过滤掉全部会话 → 恒 null、回落初始布局。这是已知现状而非缺陷；
    // 有意启用恢复时此测试须连着入口一起改
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(splitLayout()))
    expect(loadSavedLayout([])).toBeNull()
  })
})
