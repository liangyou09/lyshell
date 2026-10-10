/**
 * lyshell-plugin:// 自定义协议 —— 插件界面视图页面资源服务（electron 接线层）
 *
 * 设计（docs/plugin-ui-views-plan.md §三）：
 *   - app.ready 前 registerSchemesAsPrivileged（standard/secure/supportFetchAPI/stream）。
 *   - 每插件独立内存 partition `pluginviews:${pluginId}`；guest 创建前在对应
 *     session 上注册只服务该 pluginId 的 handler。不共享 session/协议 handler。
 *   - URL 形如 `lyshell-plugin://{pluginId}/{相对 views/ 的路径}`。handler 要求
 *     URL host 与 partition 绑定的 pluginId 完全一致，插件 enabled，解码路径干净；
 *     拒绝编码遍历/分隔符、反斜杠、NUL、空段、目录请求、隐藏/凭据文件。
 *   - 真实路径包围防 symlink/junction 逃逸：先确认真实 views/ 目录位于真实插件根内，
 *     再确认目标文件真实路径位于该 views/ 内。
 *   - 普通资源 URL 不带查询串；弹窗入口仅允许一次性 dialogId 参数（协议读文件时
 *     不把参数拼进文件路径，dialogId 的有效性由 webview attach 闸核对）。
 *   - MIME + `X-Content-Type-Options: nosniff`；HTML 加 CSP（禁远程/内联脚本）。
 *
 * 协议只服务 views/ 目录中的页面资源；manifest、主进程入口、插件根部文件不在
 * 服务范围。图标不走本协议 —— 主 renderer 用受限 IPC 入口（见 handlers PLUGIN_VIEW_ICON）。
 * 纯逻辑（URL 清洗/路径包围/MIME）拆在 view-protocol-core.ts 供 vitest 直测。
 */
import { app, protocol, session } from 'electron'
import log from 'electron-log'
import {
  PLUGIN_VIEW_SCHEME,
  buildViewCsp,
  pluginViewPartition,
  resolveViewFileUrl,
  ViewProtocolError
} from './view-protocol-core'
import { getPluginViewRegistry } from './view-registry'
import { readPluginViewResource } from './view-resource'

export {
  PLUGIN_VIEW_CSP,
  PLUGIN_VIEW_SCHEME,
  pluginViewPartition,
  makeViewEntryUrl
} from './view-protocol-core'

/** app.ready 前调用：注册 privileged scheme（必须先于任何 fromPartition/挂载） */
export function registerPluginViewSchemePrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PLUGIN_VIEW_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    }
  ])
}

/** 已注册协议 handler 的插件集合（幂等安装/卸载） */
const installedHandlers = new Set<string>()

/**
 * 为指定插件在其专属 partition 上安装协议 handler（幂等）。
 * handler 闭包绑定 pluginId：URL host 与其完全一致才服务（跨插件拒 403）。
 * 返回是否实际安装（已装过返回 false）。
 */
export function installPluginViewProtocolHandler(pluginId: string): boolean {
  if (installedHandlers.has(pluginId)) return false
  const ses = session.fromPartition(pluginViewPartition(pluginId))
  ses.protocol.handle(PLUGIN_VIEW_SCHEME, (request) => handlePluginViewRequest(pluginId, request.url))
  // guest 页面一律不授 web 权限（通知/剪枝板写/地理/全屏/媒体等 —— 主进程侧全部拒绝，
  // 无需用户面对逐站点弹窗；页面 capabilities 之外的任何提权路径都不存在）
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  installedHandlers.add(pluginId)
  log.info(`[plugin-view] protocol handler installed for ${pluginId}`)
  return true
}

/** 移除插件协议 handler（卸载/禁用清理；handler 本身也会因 enabled 检查拒服，双保险） */
export function uninstallPluginViewProtocolHandler(pluginId: string): void {
  if (!installedHandlers.has(pluginId)) return
  try {
    session.fromPartition(pluginViewPartition(pluginId)).protocol.unhandle(PLUGIN_VIEW_SCHEME)
  } catch (e) {
    log.warn(`[plugin-view] failed to unhandle protocol for ${pluginId}:`, e)
  }
  installedHandlers.delete(pluginId)
}

/** 协议 handler 主体：解析 → 读取（限长）→ 响应。所有失败走 403/404。 */
async function handlePluginViewRequest(pluginId: string, rawUrl: string): Promise<Response> {
  let absPath: string
  let mime: string
  let rel: string
  try {
    const resolved = resolveViewFileUrl(pluginId, rawUrl)
    absPath = resolved.absPath
    mime = resolved.mime
    rel = resolved.rel
  } catch (e) {
    const status = e instanceof ViewProtocolError ? e.status : 403
    log.warn(`[plugin-view] denied ${pluginId} ${rawUrl}: ${(e as Error).message}`)
    return new Response(`denied (${status})`, {
      status,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }
    })
  }
  try {
    const buf = await readPluginViewResource(absPath)
    const headers: Record<string, string> = {
      'Content-Type': mime,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store'
    }
    if (mime.startsWith('text/html')) {
      // 入口 HTML 按视图声明的 connectOrigins 放宽 CSP（connect-src/img-src 合并；
      // 声明值仅限 localhost，校验在 @shared/plugin-types validateViewDefinition）
      const view = getPluginViewRegistry().getViewByEntry(pluginId, rel)
      headers['Content-Security-Policy'] = buildViewCsp(view?.connectOrigins)
    }
    return new Response(buf, { status: 200, headers })
  } catch (e) {
    return new Response(e instanceof ViewProtocolError ? e.message : 'resource not found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }
    })
  }
}

/** 为当前全部 enabled 且有视图的插件安装协议 handler（启动初始化用） */
export function installProtocolHandlersForEnabledPlugins(): void {
  try {
    const viewRegistry = getPluginViewRegistry()
    const seen = new Set<string>()
    for (const view of viewRegistry.listViews()) {
      if (seen.has(view.pluginId)) continue
      seen.add(view.pluginId)
      installPluginViewProtocolHandler(view.pluginId)
    }
  } catch (e) {
    log.warn('[plugin-view] failed to install protocol handlers:', e)
  }
}

/** app ready 后才可调（依赖 protocol/session）—— 供启动序列自检 */
export function ensureAppReadyForViewProtocol(): void {
  if (!app.isReady()) {
    throw new Error('view protocol setup requires app ready')
  }
}
