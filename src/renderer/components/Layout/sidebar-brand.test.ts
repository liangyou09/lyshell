import { describe, expect, it } from 'vitest'
import type { PaneLeaf, PaneNode } from '@shared/types'
import { hasVisiblePaneTabs } from './sidebar-brand'

const empty = (): PaneLeaf => ({ id: 'empty', type: 'leaf', sessions: [], activeSessionId: null, overlays: [] })
const sessions = [{ id: 'terminal' }]

describe('侧栏品牌随可见页签切换', () => {
  it('空布局和仅存在于后台的会话保留完整品牌', () => {
    expect(hasVisiblePaneTabs(empty(), sessions, {}, {})).toBe(false)
  })

  it('终端页签出现后收紧入口，隐藏或移除后恢复品牌', () => {
    const pane = { ...empty(), sessions: ['terminal'] }
    expect(hasVisiblePaneTabs(pane, sessions, {}, {})).toBe(true)
    expect(hasVisiblePaneTabs(pane, sessions, { terminal: true }, {})).toBe(false)
    expect(hasVisiblePaneTabs(pane, [], {}, {})).toBe(false)
  })

  it('网页等覆盖层也算页签，缺失内容的引用不算', () => {
    const pane: PaneLeaf = { ...empty(), overlays: [{ id: 'web', kind: 'web', active: true, slot: null }] }
    expect(hasVisiblePaneTabs(pane, [], {}, { web: { kind: 'web' } })).toBe(true)
    expect(hasVisiblePaneTabs(pane, [], {}, {})).toBe(false)
  })

  it('任意分屏存在可见页签都使用紧凑入口，不受分屏比例影响', () => {
    const root: PaneNode = {
      id: 'split', type: 'split', direction: 'horizontal', splitRatio: 0.5,
      firstChild: empty(), secondChild: { ...empty(), id: 'right', sessions: ['terminal'] }
    }
    expect(hasVisiblePaneTabs(root, sessions, {}, {})).toBe(true)
    expect(hasVisiblePaneTabs({ ...root, splitRatio: 0.7 }, sessions, {}, {})).toBe(true)
    expect(hasVisiblePaneTabs(root, sessions, { terminal: true }, {})).toBe(false)
  })
})
