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
 * 网页页签的导航态 —— 地址栏/导航按钮的显示数据，WebTabOverlay 经
 * did-navigate / did-navigate-in-page 回写。与打开时 URL（payload.url）分离：
 * src 永远只吃打开时 URL，就地导航经 webview.loadURL，杜绝「payload.url 回写 →
 * src 属性变化 → 重复导航」。缺省（undefined）= 首次导航尚未完成，面板按钮
 * 视为不可用、地址栏回落显示打开时 URL。
 */
export interface WebTabNav {
  url: string           // 当前 URL（含 SPA pushState 的页内跳转）
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
}

/** 弹窗转页签：POST 正文留主进程，postToken 仅供新 webview 首航认领一次（取走
 *  即毁 —— 重放已提交的请求有二次提交风险，付款/创建类动作会重复执行，已明确
 *  否决）。令牌随 payload 持久在页签上（下方 web 联合成员的 postToken）—— 首航
 *  落定（did-navigate）或认领被拒时 settleWebTabPost 把它从 payload 摘除，落点
 *  已知时一并把 url 改写为落点（仅为异常重挂兜底，如开发期 StrictMode；常态下
 *  页签挂 WebTabLayer 常驻层，拖分屏/拆分不销毁 webview，不存在重挂恢复问题）。 */
export interface WebTabPopupRequest {
  url: string
  background?: boolean
  postToken?: string
  /** main 提供发起 webContents 身份，后代页签继承插件归属。 */
  sourceWebContentsId?: number
  /** 小窗与旧页签没有归属字段时，按 main 提供的来源地址识别本机服务。 */
  sourceUrl?: string
}

/**
 * 覆盖层 payload（判别联合）—— 内容数据，按 id 存于 pane-store 的 overlayPayloads 字典。
 * 瞬态：与挂载点一样不持久化，重启即回收。
 */
export type OverlayPayload = { ownerPluginId?: string } & (
  | { kind: 'web'; url: string; title: string; favicon?: string; nav?: WebTabNav; postToken?: string }
  | { kind: 'doc' } & DocOverlayPayload
  | { kind: 'dshWeb'; url: string; name: string; cwd?: string }
  | { kind: 'mcpAudit' })
