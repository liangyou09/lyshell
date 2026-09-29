/**
 * 插件视图 UI 动作编排（main 侧，docs/plugin-ui-views-plan.md §四）
 *
 * guest（插件页面）经 view-bridge 调 openTerminal/openWebTab/openDoc/openDialog →
 * 本模块做权限与参数校验 → 经 PLUGIN_VIEW_ACTION_REQUEST 请求所属窗口的 renderer
 * 执行（connectSession / usePaneStore.openWebTab / openLocalDoc / 挂载弹窗 webview）
 * → renderer 经 PLUGIN_VIEW_ACTION_RESULT 回执（requestId 对账，首次回执唯一有效）
 * → 结果回 guest。
 *
 * 权限模型（产品契约 4）：纯展示不需要任何授权；UI 动作需要 uiControl，其中
 * openTerminal 另需 sessionControl、openDoc 另需 read。每次调用以
 * pluginRepository 的当前授权为准（enabled + grantedCapabilities），不缓存。
 * openTerminal 复用 HTTP server 的会话黑白名单判定（isSessionAllowedForMcp），
 * 不另写一套名单判断。
 */
import { BrowserWindow } from 'electron'
import type { McpCapability } from '@shared/api-routes'
import { PLUGIN_DIALOG_MIN_SIZE, PLUGIN_DIALOG_MAX_SIZE, clampPluginDialogSize } from '@shared/plugin-types'
import { isDocPath, docKindFromPath } from '@shared/types'
import { assertSafeLocalPath } from '@main/file/path-safety'
import { sessionRepository } from '@main/storage/repository'
import { pluginRepository } from '@main/storage/plugin-repository'
import { isSessionAllowedForMcp } from '@main/mcp/http-server'
import type { PluginGuestRecord } from './view-guests'

/** 动作名（preload 暴露面与 renderer 消费端一致） */
export type PluginUiAction = 'openTerminal' | 'openWebTab' | 'openDoc' | 'openDialog'

/** 公开结果类型：ok:true 表示请求被接受/页签已挂载，不保证最终连通或外站加载成功。
 *  openDialog 成功时附 dialogId（发起 guest 凭此关联 dialogResult/dialogCancelled 事件） */
export type ActionResult = { ok: true; dialogId?: string } | { ok: false; error: string }

/** 发给 renderer 的动作请求（main → owner 窗口） */
export interface PluginActionRequest {
  requestId: string
  action: PluginUiAction
  pluginId: string
  viewId: string
  params: Record<string, unknown>
}

/** renderer 回执 */
export interface PluginActionResultReceipt {
  requestId: string
  ok: boolean
  error?: string
}

/** renderer 动作超时（目标窗口关闭/挂起时给出确定错误，不能把 dispatched 当成功） */
const ACTION_RESULT_TIMEOUT_MS = 10_000

/** 各动作的 capability 要求（uiControl 之外追加） */
const EXTRA_CAPABILITY: Record<PluginUiAction, McpCapability | null> = {
  openTerminal: 'sessionControl',
  openWebTab: null,
  openDoc: 'read',
  openDialog: null
}

/** 动作权限判定（纯函数，可测）：UI 动作一律要求 uiControl + 各自追加项 */
export function checkActionPermission(
  granted: readonly McpCapability[] | undefined,
  action: PluginUiAction
): { ok: true } | { ok: false; error: string } {
  const set = new Set(granted ?? [])
  if (!set.has('uiControl')) {
    return { ok: false, error: `action "${action}" requires the uiControl capability` }
  }
  const extra = EXTRA_CAPABILITY[action]
  if (extra && !set.has(extra)) {
    return { ok: false, error: `action "${action}" additionally requires the ${extra} capability` }
  }
  return { ok: true }
}

// 弹窗尺寸钳制范围（像素）—— 单一事实来源在 @shared/plugin-types（renderer 挂载
// 弹窗时用同一钳制，防两端各说各话）
const DIALOG_MIN_SIZE = PLUGIN_DIALOG_MIN_SIZE
const DIALOG_MAX_SIZE = PLUGIN_DIALOG_MAX_SIZE

/**
 * 动作参数清洗（纯函数，可测）。类型/长度/URL/路径硬校验在此；涉及文件系统/
 * 会话真实性的核对在 handleInvoke（需要仓库与名单）。
 */
export function sanitizeActionParams(
  action: PluginUiAction,
  raw: unknown
): { ok: true; params: Record<string, unknown> } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'params must be an object' }
  }
  const p = raw as Record<string, unknown>
  switch (action) {
    case 'openTerminal': {
      const sessionId = p.sessionId
      if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 128) {
        return { ok: false, error: 'openTerminal requires sessionId (1-128 chars)' }
      }
      return { ok: true, params: { sessionId } }
    }
    case 'openWebTab': {
      const url = p.url
      if (typeof url !== 'string' || url.length === 0 || url.length > 4096) {
        return { ok: false, error: 'openWebTab requires url (1-4096 chars)' }
      }
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        return { ok: false, error: 'openWebTab url must be a valid URL' }
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, error: 'openWebTab only accepts http/https URLs' }
      }
      return { ok: true, params: { url: parsed.toString() } }
    }
    case 'openDoc': {
      const docPath = p.path
      if (typeof docPath !== 'string' || docPath.length === 0 || docPath.length > 4096) {
        return { ok: false, error: 'openDoc requires path (1-4096 chars)' }
      }
      if (docPath.includes('\0') || docPath.includes('?') || docPath.includes('#')) {
        return { ok: false, error: 'openDoc path must not contain NUL, query or fragment' }
      }
      return { ok: true, params: { path: docPath } }
    }
    case 'openDialog': {
      const viewId = p.viewId
      if (typeof viewId !== 'string' || !/^[a-z][a-z0-9-]*$/.test(viewId) || viewId.length > 64) {
        return { ok: false, error: 'openDialog requires viewId matching ^[a-z][a-z0-9-]*$' }
      }
      const out: Record<string, unknown> = { viewId }
      if (p.title !== undefined) {
        if (typeof p.title !== 'string' || p.title.length === 0 || p.title.length > 64) {
          return { ok: false, error: 'openDialog title must be 1-64 chars' }
        }
        out.title = p.title
      }
      for (const key of ['width', 'height'] as const) {
        const v = p[key]
        if (v === undefined) continue
        if (typeof v !== 'number' || !Number.isFinite(v) || v < DIALOG_MIN_SIZE || v > DIALOG_MAX_SIZE) {
          return { ok: false, error: `openDialog ${key} must be a number in [${DIALOG_MIN_SIZE}, ${DIALOG_MAX_SIZE}]` }
        }
        out[key] = Math.round(v)
      }
      return { ok: true, params: out }
    }
  }
}

/** 每插件并发在途动作上限（防 guest 刷爆 pending 表） */
const MAX_PENDING_PER_PLUGIN = 8

/** 动作请求 hooks（electron 接线注入；测试可替换） */
export interface ActionDispatchHooks {
  sendToWindow(ownerWindowId: number, payload: PluginActionRequest): void
  logWarn(msg: string, ...rest: unknown[]): void
  /**
   * openDialog 专用：核对目标视图属于本插件并登记一次性弹窗记录，返回注入
   * params 的 dialogId + entryUrl（view-bridge 实现；测试可替换）。
   * 在 sanitize 之后调用 —— 注入字段不经 sanitize，直达 renderer 挂载弹窗。
   */
  createDialogForInvoke?(
    guest: PluginGuestRecord,
    params: Record<string, unknown>
  ): { ok: true; dialogId: string; entryUrl: string } | { ok: false; error: string }
  /**
   * openDialog 专用：分发失败（窗口丢失/回执错误等）后放弃尚未挂载的弹窗记录
   * （view-bridge 实现；测试可替换）。已挂弹窗不动 —— 回执超时时 webview 可能已
   * 挂上，是仍在交互的真弹窗；未挂载记录由弹窗管理器的放弃路径即时移除。
   */
  abandonDialogForInvoke?(dialogId: string): void
}

export class PluginActionDispatcher {
  /** requestId → 等待回执的 resolver（含到期与所属窗口） */
  private pending = new Map<
    string,
    {
      pluginId: string
      ownerWindowId: number
      timer: ReturnType<typeof setTimeout>
      resolve: (result: ActionResult) => void
    }
  >()

  constructor(private hooks: ActionDispatchHooks) {}

  private newRequestId(): string {
    return `act-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }

  /**
   * guest → main 动作入口（view-bridge 已核对 guest 登记身份）。
   * 每次以 pluginRepository 当前授权 + enabled 为准。
   */
  async handleInvoke(
    guest: PluginGuestRecord,
    rawAction: unknown,
    rawParams: unknown
  ): Promise<ActionResult> {
    if (typeof rawAction !== 'string') return { ok: false, error: 'action must be a string' }
    const action = rawAction as PluginUiAction
    if (!(action in EXTRA_CAPABILITY)) {
      return { ok: false, error: `unknown action: ${rawAction}` }
    }
    const entry = pluginRepository.get(guest.pluginId)
    if (!entry || !entry.enabled) {
      return { ok: false, error: 'plugin is not enabled' }
    }
    const perm = checkActionPermission(entry.grantedCapabilities, action)
    if (!perm.ok) return { ok: false, error: perm.error }

    const sanitize = sanitizeActionParams(action, rawParams)
    if (!sanitize.ok) return { ok: false, error: sanitize.error }
    const params = sanitize.params

    // ---- 分发前闸：每插件并发在途上限。须在 openDialog 登记弹窗记录之前 ——
    // 否则超限请求也会留下一条无人消费的 pending 弹窗记录，只能等 TTL 兜底 ----
    const pendingCount = [...this.pending.values()].filter((p) => p.pluginId === guest.pluginId).length
    if (pendingCount >= MAX_PENDING_PER_PLUGIN) {
      return { ok: false, error: 'too many pending actions for this plugin' }
    }

    // ---- 动作特定的 main 侧事实核对 ----
    if (action === 'openTerminal') {
      const sessionId = params.sessionId as string
      const saved = sessionRepository.get(sessionId)
      if (!saved) {
        return { ok: false, error: 'unknown session' }
      }
      // 复用 HTTP server 的会话黑白名单判定（产品契约：不另写不一致的名单判断）
      if (!isSessionAllowedForMcp(sessionId)) {
        return { ok: false, error: 'session is not allowed (MCP security list)' }
      }
      // renderer 端 connectSession 需要完整 config（含解密后的凭据；不回 guest）
      params.config = saved as unknown as Record<string, unknown>
    } else if (action === 'openDoc') {
      const docPath = params.path as string
      // openDoc 要求 read capability 已在上面的权限判定覆盖；这里是路径事实预检
      if (!isDocPath(docPath) || docKindFromPath(docPath) === null) {
        return { ok: false, error: 'path is not a supported document type' }
      }
      try {
        assertSafeLocalPath(docPath, { write: false })
      } catch (e) {
        return { ok: false, error: `path rejected: ${(e as Error).message}` }
      }
    } else if (action === 'openDialog') {
      // 目标视图必须属于本插件（openDialog 只能打开本插件已注册的视图）——
      // 经 bridge 注入的 createDialogForInvoke 完成：registry 核对 + 弹窗记录登记，
      // dialogId/entryUrl 在此注入（sanitize 已完成，注入字段直达 renderer）。
      if (!this.hooks.createDialogForInvoke) {
        return { ok: false, error: 'dialog support is not wired' }
      }
      const dlg = this.hooks.createDialogForInvoke(guest, params)
      if (!dlg.ok) return { ok: false, error: dlg.error }
      params.dialogId = dlg.dialogId
      params.entryUrl = dlg.entryUrl
    }

    // ---- 分发到所属窗口 renderer 并等待首次回执 ----
    const dispatched = await this.dispatch(guest, action, params)
    if (action === 'openDialog') {
      if (dispatched.ok) {
        // 把一次性 dialogId 带回发起 guest（dialogResult/dialogCancelled 事件按它关联）
        return { ok: true, dialogId: typeof params.dialogId === 'string' ? params.dialogId : undefined }
      }
      // 分发失败（窗口丢失/回执错误/超时）：发起 guest 已拿到确定的 ok:false 且从未
      // 拿到 dialogId，放弃未挂载的弹窗记录不留悬账；已挂弹窗不动（见 hook 注释）
      const dialogId = params.dialogId
      if (typeof dialogId === 'string') this.hooks.abandonDialogForInvoke?.(dialogId)
    }
    return dispatched
  }

  /** 分发 + 等待回执（openDialog 的 dialogId 由 bridge 在调用本方法前注入 params） */
  private dispatch(guest: PluginGuestRecord, action: PluginUiAction, params: Record<string, unknown>): Promise<ActionResult> {
    const win = BrowserWindow.fromId(guest.ownerWindowId)
    if (!win || win.isDestroyed()) {
      return Promise.resolve({ ok: false, error: 'owner window is gone' })
    }
    const requestId = this.newRequestId()
    return new Promise<ActionResult>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(requestId)) {
          resolve({ ok: false, error: 'renderer action timed out' })
        }
      }, ACTION_RESULT_TIMEOUT_MS)
      this.pending.set(requestId, {
        pluginId: guest.pluginId,
        ownerWindowId: guest.ownerWindowId,
        timer,
        resolve
      })
      const request: PluginActionRequest = {
        requestId,
        action,
        pluginId: guest.pluginId,
        viewId: guest.viewId,
        params
      }
      try {
        this.hooks.sendToWindow(guest.ownerWindowId, request)
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(requestId)
        resolve({ ok: false, error: `dispatch failed: ${(e as Error).message}` })
      }
    })
  }

  /**
   * renderer 回执：只接受「仍待处理 requestId」的首次回执；其他窗口/重复/过期回执忽略。
   * @returns 是否被采纳（测试与审计用）
   */
  handleResult(receipt: Partial<PluginActionResultReceipt> | undefined, senderWindowId: number | null): boolean {
    if (!receipt || typeof receipt.requestId !== 'string') return false
    const entry = this.pending.get(receipt.requestId)
    if (!entry) return false
    if (senderWindowId !== null && senderWindowId !== entry.ownerWindowId) {
      this.hooks.logWarn(`[plugin-view] action result from wrong window (request ${receipt.requestId})`)
      return false
    }
    this.pending.delete(receipt.requestId)
    clearTimeout(entry.timer)
    const ok = receipt.ok === true
    entry.resolve(ok ? { ok: true } : { ok: false, error: typeof receipt.error === 'string' && receipt.error ? receipt.error : 'renderer action failed' })
    return true
  }

  /** 窗口关闭：该窗口在途回执全部按确定错误收尾 */
  failPendingForWindow(ownerWindowId: number, error: string): void {
    for (const [requestId, entry] of [...this.pending.entries()]) {
      if (entry.ownerWindowId === ownerWindowId) {
        clearTimeout(entry.timer)
        this.pending.delete(requestId)
        entry.resolve({ ok: false, error })
      }
    }
  }

  /** 插件清理（禁用/卸载）：在途回执按确定错误收尾 */
  failPendingForPlugin(pluginId: string, error: string): void {
    for (const [requestId, entry] of [...this.pending.entries()]) {
      if (entry.pluginId === pluginId) {
        clearTimeout(entry.timer)
        this.pending.delete(requestId)
        entry.resolve({ ok: false, error })
      }
    }
  }

  pendingCount(): number {
    return this.pending.size
  }
}

/** 弹窗尺寸钳制（renderer 挂载时夹紧；实现移至 @shared 供两端共用） */
export const clampDialogSize = clampPluginDialogSize

/** 审计摘要（避免敏感全文）：动作 + 目标 + 插件 */
export function summarizeAction(action: PluginUiAction, pluginId: string, viewId: string, params: Record<string, unknown>): string {
  switch (action) {
    case 'openTerminal':
      return `${pluginId}/${viewId} openTerminal session=${typeof params.sessionId === 'string' ? params.sessionId : '?'}`
    case 'openWebTab':
      return `${pluginId}/${viewId} openWebTab ${typeof params.url === 'string' ? params.url.slice(0, 120) : '?'}`
    case 'openDoc':
      return `${pluginId}/${viewId} openDoc ${typeof params.path === 'string' ? params.path.slice(0, 120) : '?'}`
    case 'openDialog':
      return `${pluginId}/${viewId} openDialog target=${typeof params.viewId === 'string' ? params.viewId : '?'}`
  }
}
