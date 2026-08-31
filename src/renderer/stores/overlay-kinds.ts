import type { OverlayKind, OverlayPayload } from '@shared/types'

/**
 * 覆盖层种类注册表（store 侧行为表）—— 归一化模型的核心。
 * 新增一种覆盖层 = shared/types 里加一个 payload 变体 + 这里一条注册 +
 * PaneTabBar / PaneView 各一个渲染器；互斥、回并、拖拽、回收等机制层自动覆盖，
 * 不再逐触点手工枚举（那正是「新增一种就踩一遍旧坑」的根因）。
 */

/** dsh Web UI 单例哨兵 id（兼作页签 data-tab-id 与 DOM 查询锚点） */
export const DSH_WEB_OVERLAY_ID = '__dsh_web__'

/** MCP 审计面板单例哨兵 id（同上） */
export const MCP_AUDIT_OVERLAY_ID = '__mcp_audit__'

export interface OverlayKindDef {
  /** 全局至多一个实例：重开 = 换挂载点并覆写 payload（同 id 原位或跨 pane 迁移） */
  singleton: boolean
  /**
   * 单例哨兵 id：单例重开（含已关闭后重开）恒用此 id，页签 data-tab-id / DOM 查询
   * 锚点 / 跨模块引用才稳定。挂载点查不到既有实例时 mountOverlay 以它兜底，
   * 不再落入随机 id —— 那会让「关掉再开」丢失哨兵身份
   */
  singletonId?: string
  /** 多开种类生成实例 id 的前缀（`web-<rand>` 风格）；缺省回退 `<kind>-` */
  idPrefix?: string
  /** 关掉激活页签时回落到同 pane 同种类最后一个（浏览器惯例；单例无此语义） */
  fallbackToLastInPane: boolean
  /** 关最后一个终端页签时的自动激活优先级，小者优先（现行 dsh > web > doc > MCP） */
  activatePriority: number
  /** 去活即卸载（webview 系「保活挂载只藏显」的反面：MCP 纯 DOM 面板重进回第 1 页） */
  unmountWhenInactive: boolean
  /** 拖到 pane 落区的强调色（主题令牌；doc=amber、web 系=reachable，与各自页签点色同源） */
  dropAccent: { bg: string; border: string }
  /** 拖到 pane 落区文案的 i18n key */
  dropLabelKey: string
  /** 关闭回收时补发的副作用（dsh web：杀子进程；单例 pane 误删时也走这里兜底） */
  closeSideEffect?: (payload: OverlayPayload) => void
}

export const OVERLAY_KINDS: Record<OverlayKind, OverlayKindDef> = {
  dshWeb: {
    singleton: true,
    singletonId: DSH_WEB_OVERLAY_ID,
    fallbackToLastInPane: false,
    activatePriority: 0,
    unmountWhenInactive: false,
    dropAccent: { bg: 'var(--reachable-glow)', border: 'var(--reachable)' },
    dropLabelKey: 'pane.moveWebHere',
    closeSideEffect: () => { void window.electronAPI?.closeDshWeb?.() }
  },
  web: {
    singleton: false,
    idPrefix: 'web-',
    fallbackToLastInPane: true,
    activatePriority: 1,
    unmountWhenInactive: false,
    dropAccent: { bg: 'var(--reachable-glow)', border: 'var(--reachable)' },
    dropLabelKey: 'pane.moveWebHere'
  },
  doc: {
    singleton: false,
    idPrefix: 'doc-',
    fallbackToLastInPane: true,
    activatePriority: 2,
    unmountWhenInactive: false,
    // amber 与页签点色同源（remote doc 点色）；lark 主题下 amber=品牌蓝，落区跟着翻
    dropAccent: { bg: 'var(--amber-glow)', border: 'var(--amber)' },
    dropLabelKey: 'pane.moveDocHere'
  },
  mcpAudit: {
    singleton: true,
    singletonId: MCP_AUDIT_OVERLAY_ID,
    fallbackToLastInPane: false,
    activatePriority: 3,
    unmountWhenInactive: true,
    dropAccent: { bg: 'var(--reachable-glow)', border: 'var(--reachable)' },
    dropLabelKey: 'pane.moveMcpHere'
  }
}
