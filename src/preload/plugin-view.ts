/**
 * 插件视图 guest preload（dist/preload/pluginView.js）
 *
 * 仅服务于 lyshell-plugin:// guest 页面（index.ts 的 will-attach-webview 插件分支
 * 强制指定本 preload，页面无法自带）。sandbox + contextIsolation 下经 contextBridge
 * 暴露最小面 `window.lyshellView`：
 *   - 页面没有任何 token/Node 能力；全部 IPC 进入 main 后以登记 guest 身份执行，
 *     权限按 pluginRepository 当前授权逐次核对（docs/plugin-ui-views-plan.md §四）。
 *   - bootstrap/callApi/动作/弹窗关闭走 invoke；事件（dialogResult/dialogCancelled）
 *     经 onEvent 订阅，返回退订函数。
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'

// 与 @shared/constants 的 IPC_CHANNELS 保持一致（preload 独立构建，走字面量副本）
const CHANNELS = {
  PLUGIN_VIEW_BOOTSTRAP: 'plugin:view-bootstrap',
  PLUGIN_VIEW_CALL_API: 'plugin:view-call-api',
  PLUGIN_VIEW_ACTION_INVOKE: 'plugin:view-action-invoke',
  PLUGIN_VIEW_DIALOG_CLOSE: 'plugin:view-dialog-close',
  PLUGIN_VIEW_EVENT: 'plugin:view-event'
}

/** 启动握手返回（main 侧 view-bridge BOOTSTRAP handler 的负载） */
export interface LyshellViewBootstrap {
  pluginId: string
  viewId: string
  kind: 'panel' | 'dialog'
  /** kind === 'dialog' 时的一次性弹窗 id（dialogResult/dialogCancelled 事件关联用） */
  dialogId: string | null
  title: string
  entry: string
  source: 'manifest' | 'runtime'
  /** 插件当前 grantedCapabilities（页面据此自行降级展示；不构成权限） */
  capabilities: string[]
  /** 界面明暗模式快照（renderer 推给 main 持有；变化时经 themeChanged 事件推送） */
  theme: 'dark' | 'light'
}

/** UI 动作结果（ok:true 不保证最终连通/加载成功，只表示请求被接受） */
export interface LyshellViewActionResult {
  ok: boolean
  error?: string
  /** openDialog 成功时返回的一次性弹窗 id */
  dialogId?: string
}

/** main → guest 事件（dialogResult / dialogCancelled / themeChanged） */
export interface LyshellViewEvent {
  type: string
  dialogId?: string
  result?: unknown
  reason?: string
  /** type === 'themeChanged' 时的最新明暗模式 */
  theme?: 'dark' | 'light'
}

const api = {
  /** 启动握手：确认登记身份并取视图元信息（未登记/视图已注销时 reject） */
  bootstrap(): Promise<LyshellViewBootstrap> {
    return ipcRenderer.invoke(CHANNELS.PLUGIN_VIEW_BOOTSTRAP)
  },

  /**
   * API 工具调用（仅 http transport 路由）。能力闸在 main 的 http-server 侧按
   * 路由生效；失败 reject Error（消息为服务端 error 字段）。
   */
  callApi(tool: string, args?: Record<string, unknown>): Promise<unknown> {
    return ipcRenderer.invoke(CHANNELS.PLUGIN_VIEW_CALL_API, { tool, args })
  },

  /** 打开已保存会话的终端页签（需 uiControl + sessionControl） */
  openTerminal(sessionId: string): Promise<LyshellViewActionResult> {
    return ipcRenderer.invoke(CHANNELS.PLUGIN_VIEW_ACTION_INVOKE, {
      action: 'openTerminal',
      params: { sessionId }
    })
  },

  /** 打开网页页签（需 uiControl；仅 http/https） */
  openWebTab(url: string): Promise<LyshellViewActionResult> {
    return ipcRenderer.invoke(CHANNELS.PLUGIN_VIEW_ACTION_INVOKE, {
      action: 'openWebTab',
      params: { url }
    })
  },

  /** 打开本地文档页签（需 uiControl + read） */
  openDoc(path: string): Promise<LyshellViewActionResult> {
    return ipcRenderer.invoke(CHANNELS.PLUGIN_VIEW_ACTION_INVOKE, {
      action: 'openDoc',
      params: { path }
    })
  },

  /** 打开本插件另一视图为弹窗（需 uiControl）；成功附 dialogId */
  openDialog(opts: { viewId: string; title?: string; width?: number; height?: number }): Promise<LyshellViewActionResult> {
    return ipcRenderer.invoke(CHANNELS.PLUGIN_VIEW_ACTION_INVOKE, {
      action: 'openDialog',
      params: opts
    })
  },

  /** 弹窗 guest 关闭自己并回传结果（结果只送发起 guest；仅 dialog guest 有效） */
  closeDialog(result?: unknown): Promise<LyshellViewActionResult> {
    return ipcRenderer.invoke(CHANNELS.PLUGIN_VIEW_DIALOG_CLOSE, { result })
  },

  /** 订阅 main → guest 事件；返回退订函数 */
  onEvent(listener: (evt: LyshellViewEvent) => void): () => void {
    const wrapped = (_event: IpcRendererEvent, evt: LyshellViewEvent) => {
      try {
        listener(evt)
      } catch (e) {
        // 页面监听器异常不应反复打到控制台：交还给页面自身的错误处理
        console.error('lyshellView.onEvent listener error:', e)
      }
    }
    ipcRenderer.on(CHANNELS.PLUGIN_VIEW_EVENT, wrapped)
    return () => {
      ipcRenderer.removeListener(CHANNELS.PLUGIN_VIEW_EVENT, wrapped)
    }
  }
}

export type LyshellViewApi = typeof api

contextBridge.exposeInMainWorld('lyshellView', api)
