import { create } from 'zustand'

/**
 * 跨组件 UI 请求 store —— 解决「事件监听器在条件挂载的组件里会丢事件」的问题。
 *
 * 背景:新建连接对话框由 SessionsPanel 渲染,而 SessionsPanel 仅在
 * activeNav === 'sessions' 时挂载(MainWindow 条件渲染)。原先靠 window 上的
 * 'newSession' 事件通知,侧栏停在别的页签 / 收起时监听器不存在,请求静默丢失
 * (MCP open_connection_dialog 工具即踩此坑)。
 *
 * 请求落成 store 状态后跨组件挂载存活:请求方先置自增 id(可同时把左栏切到
 * 目标页签),面板无论「已挂载收到变更」还是「随后才挂载读到存量」都能开
 * 对话框,消费后归零 —— 二次进页签不会误弹。
 *
 * 「打开某面板的新建对话框」不止会话一处(命令 /new、MCP C4、/ls 清点文档的
 * 新建链接都要用),故按面板泛化成一张请求表;消费方(SessionsPanel 等)只
 * 订阅自己那一格。openItemRequests 同构:「打开该面板的某个既有条目」
 * (/ls 清点文档点行内名称 → 变量组开编辑对话框、harness 工作区走启动链),
 * 带 itemId + 自增 nonce(nonce 变化 = 又点了一次同名条目也要重新触发)。
 */
export type CreateDialogPanel = 'sessions' | 'agents' | 'env' | 'plugins' | 'dsh' | 'codex' | 'claude'

/** 「打开指定条目」请求:目标条目 id + 自增序号(区分「再点一次同一条目」) */
export interface OpenItemRequest {
  itemId: string
  nonce: number
}

interface UiStore {
  /** 待处理的「打开新建对话框」请求 id 表,按面板分格;0/缺省 = 无请求 */
  createDialogRequests: Partial<Record<CreateDialogPanel, number>>
  /** 发起一次「打开某面板新建对话框」请求(对应格自增) */
  requestCreateDialog: (panel: CreateDialogPanel) => void
  /** 消费掉当前请求(打开对话框的组件调用,归零防重放) */
  consumeCreateDialogRequest: (panel: CreateDialogPanel) => void
  /** 待处理的「打开指定条目」请求表,按面板分格;缺省 = 无请求 */
  openItemRequests: Partial<Record<CreateDialogPanel, OpenItemRequest>>
  /** 发起一次「打开某面板既有条目」请求(替换该格并自增 nonce) */
  requestOpenItem: (panel: CreateDialogPanel, itemId: string) => void
  /** 消费掉当前请求(完成打开动作的组件调用,置空防重放) */
  consumeOpenItemRequest: (panel: CreateDialogPanel) => void
}

export const useUiStore = create<UiStore>((set, get) => ({
  createDialogRequests: {},

  requestCreateDialog: (panel) => {
    set({ createDialogRequests: { ...get().createDialogRequests, [panel]: (get().createDialogRequests[panel] ?? 0) + 1 } })
  },

  consumeCreateDialogRequest: (panel) => {
    // 只在仍有未消费请求时清零 —— 消费方 effect 与请求方的重入都调它,幂等
    if (get().createDialogRequests[panel]) {
      set({ createDialogRequests: { ...get().createDialogRequests, [panel]: 0 } })
    }
  },

  openItemRequests: {},

  requestOpenItem: (panel, itemId) => {
    const cur = get().openItemRequests[panel]
    set({ openItemRequests: { ...get().openItemRequests, [panel]: { itemId, nonce: (cur?.nonce ?? 0) + 1 } } })
  },

  consumeOpenItemRequest: (panel) => {
    // 只在仍有未消费请求时置空 —— 消费方 effect 与请求方的重入都调它,幂等
    if (get().openItemRequests[panel]) {
      set({ openItemRequests: { ...get().openItemRequests, [panel]: undefined } })
    }
  }
}))
