/**
 * 分屏方向
 */
export type SplitDirection = 'horizontal' | 'vertical'

/**
 * 叶子分屏 - 包含多个会话和自己的标签栏
 */
export interface PaneLeaf {
  id: string
  type: 'leaf'
  sessions: string[]  // 该分屏中的会话ID列表
  activeSessionId: string | null  // 当前显示的会话
}

/**
 * 分屏节点 - 包含两个子分屏
 */
export interface PaneSplit {
  id: string
  type: 'split'
  direction: SplitDirection
  splitRatio: number  // 0.0 到 1.0，表示第一个子分屏占比
  firstChild: PaneNode
  secondChild: PaneNode
}

/**
 * 分屏节点类型（叶子或分屏）
 */
export type PaneNode = PaneLeaf | PaneSplit

/**
 * 分屏布局
 */
export interface PaneLayout {
  root: PaneNode
  activePaneId: string
}