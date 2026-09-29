/**
 * 插件视图 guest IPC 桥（main 侧，docs/plugin-ui-views-plan.md §四/§五）
 *
 * guest（panel/dialog webview 里的页面）没有任何 token —— 全部调用进入 main 后
 * 以「已登记 guest 身份」执行，权限按 pluginRepository 当前授权逐次核对：
 *   - PLUGIN_VIEW_BOOTSTRAP   页面启动握手：确认登记身份 + 返回视图元信息
 *   - PLUGIN_VIEW_CALL_API    API 工具调用：路由解析复用 plugin-host/api.ts，
 *                             经 loopback HTTP 以本插件 UI token 调用（能力闸在
 *                             http-server 侧按路由生效，bridge 不重复实现）
 *   - PLUGIN_VIEW_ACTION_INVOKE  UI 动作（openTerminal/openWebTab/openDoc/openDialog）
 *   - PLUGIN_VIEW_DIALOG_CLOSE   弹窗 guest 关闭自己并回传结果（结果只回发起 guest）
 *   - PLUGIN_VIEW_ACTION_RESULT  主窗口 renderer 对动作请求的回执（guest 冒充无效）
 *
 * 身份核对（verifyGuest）：不信任 renderer 自报 —— 每次调用核对
 *   ① event.sender 在 pluginGuestRegistry 的登记（did-attach 闸写入）
 *   ② event.senderFrame 是 guest 主 frame（无 parent）且 URL 协议/host 与登记
 *      pluginId 一致（防 guest 内部导航后持旧身份继续调用）
 *   ③ 插件当前 enabled
 *   ④ 视图仍在册（运行时注销后、renderer 摘除前的窗口期，动作/callApi 一律拒绝）
 */
import { ipcMain, webContents, BrowserWindow } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import log from 'electron-log'
import { IPC_CHANNELS } from '@shared/constants'
import { getPluginViewRegistry } from './view-registry'
import { pluginGuestRegistry, type PluginGuestRecord } from './view-guests'
import { PluginDialogManager } from './view-dialogs'
import { PluginActionDispatcher, type PluginActionRequest, type PluginActionResultReceipt } from './view-actions'
import { makeViewDialogEntryUrl, PLUGIN_VIEW_SCHEME } from './view-protocol-core'
import { getRendererThemeMode, setRendererThemeMode, setUiThemeModeListener } from '../ui-theme'
import { resolveApiRouteCall } from '../plugin-host/api'
import { LyShellHttpClient } from '../mcp-server/http-client'
import { getMcpHttpPort } from '../mcp/http-server'
import { getPluginUiToken } from '../mcp/auth'
import { pluginRepository } from '../storage/plugin-repository'

// ====================== 弹窗管理器（main 单例） ======================

/** 向 guest webContents 推送事件（dialogResult / dialogCancelled） */
function sendToGuestWebContents(webContentsId: number, payload: unknown): void {
  try {
    const wc = webContents.fromId(webContentsId)
    if (wc && !wc.isDestroyed()) {
      wc.send(IPC_CHANNELS.PLUGIN_VIEW_EVENT, payload)
    }
  } catch (e) {
    log.warn('[plugin-view] failed to send to guest', webContentsId, e)
  }
}

/** main 强制关闭 guest webContents（弹窗完成/取消、插件清理） */
function closeGuestWebContents(webContentsId: number): void {
  try {
    const wc = webContents.fromId(webContentsId)
    if (wc && !wc.isDestroyed()) {
      wc.close()
    }
  } catch (e) {
    log.warn('[plugin-view] failed to close guest', webContentsId, e)
  }
}

/** 向全部在册 guest 广播视图事件（目前只有 themeChanged：明暗模式切换即时生效） */
export function broadcastPluginViewEvent(payload: unknown): void {
  for (const g of pluginGuestRegistry.listAll()) {
    sendToGuestWebContents(g.webContentsId, payload)
  }
}

/** 弹窗生命周期（挂载闸在 index.ts 的 will-attach/did-attach webview） */
export const pluginDialogManager = new PluginDialogManager({
  sendToGuest: sendToGuestWebContents,
  closeGuest: closeGuestWebContents
})

// ====================== 动作分发器（main 单例） ======================

/** 弹窗结果 JSON 体积上限（结果只是数据回执，不应携带大负载） */
const MAX_DIALOG_RESULT_JSON_BYTES = 64 * 1024

export const pluginActionDispatcher = new PluginActionDispatcher({
  sendToWindow(ownerWindowId, payload: PluginActionRequest) {
    const win = BrowserWindow.fromId(ownerWindowId)
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.PLUGIN_VIEW_ACTION_REQUEST, payload)
    } else {
      log.warn(`[plugin-view] action request dropped: owner window ${ownerWindowId} gone`)
    }
  },
  logWarn(msg, ...rest) {
    log.warn(msg, ...rest)
  },
  createDialogForInvoke(guest, params) {
    // openDialog 只能打开本插件已注册的视图（getView 只查 enabled 插件）
    const viewId = params.viewId
    if (typeof viewId !== 'string') return { ok: false, error: 'openDialog requires viewId' }
    let view
    try {
      view = getPluginViewRegistry().getView(guest.pluginId, viewId)
    } catch {
      return { ok: false, error: 'view registry is not ready' }
    }
    if (!view) return { ok: false, error: `openDialog target view is not registered: ${viewId}` }
    let record
    try {
      record = pluginDialogManager.create({
        invokerContentsId: guest.webContentsId,
        pluginId: guest.pluginId,
        viewId,
        // attach 闸比对形态：URL 路径（剥 views/ 前缀），与 makeViewEntryUrl 一致
        entryPath: view.entry.replace(/^views\//, ''),
        ownerWindowId: guest.ownerWindowId
      })
    } catch (e) {
      // 每插件在册弹窗超上限（MAX_DIALOGS_PER_PLUGIN）等容量错误：转为确定回执，
      // 不让异常沿 handleInvoke 一路 reject 成 IPC 异常
      return { ok: false, error: (e as Error).message }
    }
    return {
      ok: true,
      dialogId: record.dialogId,
      // 入口必须带 ?dialogId=：attach 闸按它识别弹窗并单次消费（不带查询串的
      // 入口会被当成常驻面板挂载，guest kind=panel，closeDialog 一律被拒）
      entryUrl: makeViewDialogEntryUrl(guest.pluginId, view.entry, record.dialogId)
    }
  },
  abandonDialogForInvoke(dialogId) {
    // 分发失败兜底：未挂载的弹窗记录即时放弃（不推送 —— openDialog 调用方已拿到
    // 确定的 ok:false 且从未拿到 dialogId；已挂弹窗不受影响）
    pluginDialogManager.dropUnattached(dialogId)
  }
})

// ====================== guest 身份核对 ======================

/**
 * guest IPC 每次调用前的身份核对（见模块头注释三条）。
 * @returns 登记记录；任何一步不符返回 null（调用方统一按「未验证」拒绝）
 */
export function verifyGuest(event: IpcMainEvent | IpcMainInvokeEvent): PluginGuestRecord | null {
  const record = pluginGuestRegistry.get(event.sender.id)
  if (!record) return null
  let frame
  try {
    frame = event.senderFrame
  } catch {
    return null
  }
  if (!frame || frame.parent !== null) return null // 子 frame 不持 guest 身份
  let url: URL
  try {
    url = new URL(frame.url)
  } catch {
    return null
  }
  if (url.protocol !== `${PLUGIN_VIEW_SCHEME}:`) return null
  if (url.hostname !== record.pluginId) return null
  try {
    if (!getPluginViewRegistry().isPluginEnabled(record.pluginId)) return null
  } catch {
    return null
  }
  // 视图仍须在册：运行时注销后，已挂的 panel/dialog guest 在 renderer 摘除前还
  // 活着，其后续 IPC（动作/callApi/closeDialog）一律拒绝 —— 与 bootstrap 的
  // 「view is no longer registered」同款判定。getView 只查 enabled 插件。
  try {
    if (!getPluginViewRegistry().getView(record.pluginId, record.viewId)) return null
  } catch {
    return null
  }
  return record
}

/** 弹窗结果收敛为可安全 JSON 化且限长的数据（超限降级为截断标记） */
function sanitizeDialogResult(raw: unknown): unknown {
  try {
    const json = JSON.stringify(raw ?? null)
    if (json.length > MAX_DIALOG_RESULT_JSON_BYTES) {
      return { truncated: true }
    }
    return JSON.parse(json)
  } catch {
    return null
  }
}

// ====================== callApi（loopback + UI token） ======================

/** guest callApi 单参数上限（工具名），args 交给路由解析与 http-server 校验 */
const MAX_TOOL_NAME_LEN = 128

async function handleGuestCallApi(record: PluginGuestRecord, payload: unknown): Promise<unknown> {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('callApi payload must be an object')
  }
  const { tool, args } = payload as { tool?: unknown; args?: unknown }
  if (typeof tool !== 'string' || tool.length === 0 || tool.length > MAX_TOOL_NAME_LEN) {
    throw new Error('callApi requires tool (1-128 chars)')
  }
  if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
    throw new Error('callApi args must be an object')
  }
  // 路由解析复用 plugin-host/api.ts（:id 替换、GET query/POST body 同一套规则）；
  // 视图页面只允许 http transport 工具。
  let resolved
  try {
    resolved = resolveApiRouteCall(tool, args as Record<string, unknown> | undefined, {
      requireHttpTransport: true,
      pluginId: record.pluginId
    })
  } catch (e) {
    throw new Error(`callApi ${tool}: ${(e as Error).message}`)
  }
  if (!resolved) {
    throw new Error(`callApi: unknown tool: ${tool}`)
  }
  // 页面无 token：bridge 以本插件 UI token 发起 loopback 调用；能力闸在 http-server
  // 侧按路由逐一生效（UI token capabilities = grantedCapabilities 快照）。
  const token = getPluginUiToken(record.pluginId)
  if (!token) {
    throw new Error('view API is unavailable (plugin disabled or has no views)')
  }
  const port = getMcpHttpPort()
  if (!port) {
    throw new Error('LyShell API is not running')
  }
  const client = new LyShellHttpClient(port, token)
  // LyShellHttpClient 解析 HTTP {success, data} 信封并 resolve 整体；这里解出 data
  // 与 plugin host SDK call() 的返回口径一致（失败已由客户端 reject error 字段）。
  if (resolved.route.method === 'GET') {
    const r = await client.get(resolved.query ? `${resolved.path}?${resolved.query}` : resolved.path)
    return (r as { data?: unknown })?.data ?? null
  }
  const r = await client.post(resolved.path, resolved.body)
  return (r as { data?: unknown })?.data ?? null
}

// ====================== IPC 注册 ======================

let registered = false

/** 注册 guest 桥 IPC（main 启动时调用一次；幂等） */
export function registerPluginViewIpc(): void {
  if (registered) return
  registered = true

  // 页面启动握手：确认登记身份 + 视图元信息（页面凭此渲染标题/按 capabilities 降级）
  ipcMain.handle(IPC_CHANNELS.PLUGIN_VIEW_BOOTSTRAP, (event) => {
    const record = verifyGuest(event)
    if (!record) throw new Error('guest identity not verified')
    const view = getPluginViewRegistry().getView(record.pluginId, record.viewId)
    if (!view) throw new Error('view is no longer registered')
    const entry = pluginRepository.get(record.pluginId)
    return {
      pluginId: record.pluginId,
      viewId: record.viewId,
      kind: record.kind,
      dialogId: record.dialogId ?? null,
      title: view.title,
      entry: view.entry,
      source: view.source,
      capabilities: entry?.grantedCapabilities ?? [],
      // 界面明暗模式快照（renderer 经 UI_THEME_MODE 推给 main 持有；变化时
      // 广播 themeChanged 事件）。页面据此自选配色，与主窗口观感一致。
      theme: getRendererThemeMode()
    }
  })

  // API 工具调用（能力闸在 http-server 侧）
  ipcMain.handle(IPC_CHANNELS.PLUGIN_VIEW_CALL_API, async (event, payload) => {
    const record = verifyGuest(event)
    if (!record) throw new Error('guest identity not verified')
    return await handleGuestCallApi(record, payload)
  })

  // UI 动作
  ipcMain.handle(IPC_CHANNELS.PLUGIN_VIEW_ACTION_INVOKE, async (event, payload) => {
    const record = verifyGuest(event)
    if (!record) return { ok: false, error: 'guest identity not verified' }
    if (typeof payload !== 'object' || payload === null) {
      return { ok: false, error: 'payload must be an object' }
    }
    const { action, params } = payload as { action?: unknown; params?: unknown }
    return await pluginActionDispatcher.handleInvoke(record, action, params)
  })

  // 弹窗关闭 + 结果回传（只有目标 dialog guest 可调；结果只发发起 guest）
  ipcMain.handle(IPC_CHANNELS.PLUGIN_VIEW_DIALOG_CLOSE, (event, payload) => {
    const record = verifyGuest(event)
    if (!record) return { ok: false, error: 'guest identity not verified' }
    if (record.kind !== 'dialog' || !record.dialogId) {
      return { ok: false, error: 'only dialog guests can closeDialog' }
    }
    const result = payload !== null && typeof payload === 'object'
      ? sanitizeDialogResult((payload as { result?: unknown }).result)
      : sanitizeDialogResult(undefined)
    const closed = pluginDialogManager.closeWithResult(record.dialogId, result)
    if (!closed) return { ok: false, error: 'dialog is no longer active' }
    return { ok: true }
  })

  // 主窗口 renderer 的动作回执（guest 冒充无效：sender 必须是窗口主 frame 而非 guest）
  ipcMain.on(IPC_CHANNELS.PLUGIN_VIEW_ACTION_RESULT, (event, receipt: PluginActionResultReceipt | undefined) => {
    if (pluginGuestRegistry.get(event.sender.id)) {
      log.warn('[plugin-view] action result from guest webContents rejected')
      return
    }
    const win = BrowserWindow.fromWebContents(event.sender)
    const senderWindowId = win && !win.isDestroyed() ? win.id : null
    pluginActionDispatcher.handleResult(receipt, senderWindowId)
  })

  // renderer 的明暗模式推送（fire-and-forget）：更新 main 快照并广播 themeChanged
  // 给所有在册 guest。注册即注入回调，值变化才有广播。
  setUiThemeModeListener((mode) => {
    broadcastPluginViewEvent({ type: 'themeChanged', theme: mode })
  })
  ipcMain.on(IPC_CHANNELS.UI_THEME_MODE, (_event, mode: unknown) => {
    setRendererThemeMode(mode)
  })
}

// ====================== 生命周期联动（index.ts / handlers.ts 调用） ======================

/**
 * guest webContents 销毁（webview unmount/崩溃/窗口关闭）：清理登记并联动弹窗取消。
 * 弹窗 guest 也可发起嵌套弹窗（openDialog 不限 guest 形态），目标/发起两角色统一
 * 交 cancelByGuestDestroyed 清理 —— 只按 kind 分支会漏掉 dialog guest 发起的嵌套弹窗。
 */
export function handlePluginGuestDestroyed(webContentsId: number): void {
  const removed = pluginGuestRegistry.detach(webContentsId)
  if (!removed) return
  pluginDialogManager.cancelByGuestDestroyed(webContentsId)
}

/** 主窗口关闭：该窗口全部 guest 登记与在途动作/弹窗清理 */
export function handlePluginViewWindowClosed(ownerWindowId: number): void {
  for (const g of pluginGuestRegistry.listByWindow(ownerWindowId)) {
    pluginGuestRegistry.detach(g.webContentsId)
  }
  pluginActionDispatcher.failPendingForWindow(ownerWindowId, 'owner window closed')
  pluginDialogManager.cancelByWindow(ownerWindowId)
}

/**
 * 插件禁用/卸载：强制关闭其全部面板与弹窗 guest、在途动作按确定错误收尾。
 * 面板随 PLUGIN_VIEWS_CHANGED 由 renderer 卸载；此处是 main 侧兜底强制清理。
 */
export function teardownPluginViews(pluginId: string): void {
  for (const g of pluginGuestRegistry.listByPlugin(pluginId)) {
    closeGuestWebContents(g.webContentsId)
    pluginGuestRegistry.detach(g.webContentsId)
  }
  pluginActionDispatcher.failPendingForPlugin(pluginId, 'plugin disabled or uninstalled')
  pluginDialogManager.cancelByPlugin(pluginId)
}

/**
 * 运行时视图注销：关闭仍挂着的该视图 guest（panel/dialog），该视图的在挂/过闸中/
 * 已挂弹窗统一取消（结果/取消事件只回发起 guest）。在途动作不中断 —— 已过授权的
 * 请求按原结果收口；后续调用被 verifyGuest 的「视图在册」检查拒绝。
 */
export function teardownPluginViewGuests(pluginId: string, viewId: string): void {
  const removed: PluginGuestRecord[] = []
  for (const g of pluginGuestRegistry.listByPlugin(pluginId)) {
    if (g.viewId !== viewId) continue
    removed.push(g)
    closeGuestWebContents(g.webContentsId)
    pluginGuestRegistry.detach(g.webContentsId)
  }
  // 先清「目标视图 = 本视图」的弹窗；再按发起者清其余 —— 被移除 guest 可以发起
  // 目标仍在册的其他视图弹窗，而登记已移除，随后的 destroyed 回调不再按发起者
  // 联动，必须在此显式清理，否则弹窗残留（发起者已死，结果/取消事件无处可投）。
  pluginDialogManager.cancelByView(pluginId, viewId)
  for (const g of removed) {
    pluginDialogManager.cancelByInvokerDestroyed(g.webContentsId)
  }
}
