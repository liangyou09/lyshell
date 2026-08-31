import type { DocOverlayPayload } from './doc'

/**
 * 分屏方向
 */
export type SplitDirection = 'horizontal' | 'vertical'

/**
 * 覆盖层种类 —— 与终端页签共存的非终端「占据 pane 的东西」。
 * 挂载点（OverlayRef）进 pane 树叶子，payload 进 pane-store 的字典；
 * 新增种类 = payload 变体 + overlay-kinds 注册表条目 + 渲染器，机制层自动覆盖。
 */
export type OverlayKind = 'web' | 'doc' | 'dshWeb' | 'mcpAudit'

/**
 * 覆盖层引用（挂在叶子上）—— id/active/slot 是挂载态，与 payload 解耦。
 * 同叶子内至多一个 active；全 false 时显示终端。
 */
export interface OverlayRef {
  id: string          // 实例 id；单例用固定哨兵 '__dsh_web__' / '__mcp_audit__'（同时是页签 data-tab-id）
  kind: OverlayKind
  active: boolean
  slot: number | null // 在终端页签序列中的插入坐标（pane.sessions RAW 坐标）；null = 钉尾追加
}

/**
 * 叶子分屏 - 包含多个会话和自己的标签栏
 */
export interface PaneLeaf {
  id: string
  type: 'leaf'
  sessions: string[]  // 该分屏中的会话ID列表
  activeSessionId: string | null  // 当前显示的会话
  overlays: OverlayRef[]  // 挂载在本叶子上的覆盖层（瞬态，持久化时剥离）
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

/**
 * 覆盖层 payload（判别联合）—— 内容数据，按 id 存于 pane-store 的 overlayPayloads 字典。
 * 瞬态：与挂载点一样不持久化，重启即回收。
 */
export type OverlayPayload =
  | { kind: 'web'; url: string; title: string; favicon?: string }
  | { kind: 'doc' } & DocOverlayPayload
  | { kind: 'dshWeb'; url: string; name: string; cwd?: string }
  | { kind: 'mcpAudit' }
