/**
 * lyshell-plugin:// 协议的纯逻辑核心（无 electron 依赖，vitest 直测）
 *
 * 从 view-protocol.ts 拆出：URL 解析/路径清洗/查询串校验/真实路径包围解析。
 * electron 接线（privileged scheme 注册、partition handler 安装、Response 组装）
 * 在 view-protocol.ts。安全规则见 view-protocol.ts 头注释与 docs/plugin-ui-views-plan.md §三。
 */
import { join, sep } from 'path'
import { realpathSync, statSync } from 'fs'
import { getPluginViewRegistry, isPathStrictlyInside } from './view-registry'
// 协议名/partition 前缀/入口 URL 拼法是 main ↔ renderer 跨端契约，单一事实来源
// 在 @shared/plugin-types（renderer 不能 import main 模块）；此处原样再导出，
// main 侧既有消费面（view-protocol/view-bridge/index.ts 与单测）不变。
import { PLUGIN_VIEW_SCHEME } from '@shared/plugin-types'

export {
  PLUGIN_VIEW_SCHEME,
  PLUGIN_VIEW_PARTITION_PREFIX,
  pluginViewPartitionName as pluginViewPartition,
  makeViewEntryUrl,
  makeViewDialogEntryUrl
} from '@shared/plugin-types'

/** 单文件大小上限（视图页面资源不应巨大；超限拒服，防内存滥用） */
export const MAX_RESOURCE_BYTES = 20 * 1024 * 1024

/** HTML 响应默认 CSP：禁远程/内联脚本（style 内联允许，插件 JS 必须放 views/ 下的外部文件） */
export const PLUGIN_VIEW_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "font-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"

export const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
}

/** 协议拒绝：带 HTTP 状态码的错误 */
export class ViewProtocolError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'ViewProtocolError'
  }
}

/**
 * 解码并校验 URL 路径为「views/ 下相对路径」。
 * 拒绝：空路径、空段、'.'/'..' 段、反斜杠、NUL、盘符、编码遍历。
 * 返回以 '/' 分隔的干净相对路径。
 */
export function cleanViewUrlPath(pathname: string): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    throw new ViewProtocolError(400, 'malformed URL path')
  }
  if (decoded.includes('\0') || decoded.includes('\\')) {
    throw new ViewProtocolError(403, 'illegal path characters')
  }
  if (decoded.includes('?') || decoded.includes('#')) {
    throw new ViewProtocolError(403, 'query/fragment not allowed in path')
  }
  const segments = decoded.split('/')
  // pathname 以 / 开头（standard scheme URL 形态），首段为空串属预期
  if (segments.length === 0 || segments[0] !== '') {
    throw new ViewProtocolError(400, 'unexpected URL shape')
  }
  const relSegments = segments.slice(1)
  if (relSegments.length === 0 || relSegments.some((s) => s.length === 0 || s === '.' || s === '..')) {
    throw new ViewProtocolError(403, 'empty/dot segments not allowed')
  }
  if (/^[a-zA-Z]:$/.test(relSegments[0])) {
    throw new ViewProtocolError(403, 'drive-letter paths not allowed')
  }
  return relSegments.join('/')
}

/**
 * 核对查询串：普通资源不允许带查询；弹窗入口仅允许 `?dialogId=<值>`（协议读文件
 * 时不把参数拼进文件路径）。返回是否为 dialogId 形态。
 */
export function checkUrlSearch(search: string): boolean {
  if (search === '') return false
  const params = new URLSearchParams(search)
  if (params.size !== 1 || !params.has('dialogId')) {
    throw new ViewProtocolError(403, 'only a single dialogId query parameter is allowed')
  }
  const id = params.get('dialogId') ?? ''
  if (id.length === 0 || id.length > 128 || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new ViewProtocolError(403, 'invalid dialogId')
  }
  return true
}

/**
 * 解析请求 URL 到磁盘绝对路径（不含读取）。所有拒绝在此抛 ViewProtocolError。
 * 包围链：真实插件根 → 真实 views/（须在根内）→ 目标真实路径（须严格在 views/ 内、
 * 是文件、非隐藏）。realpath 全程解析 symlink/junction，越界即拒。
 */
export function resolveViewFileUrl(pluginId: string, rawUrl: string): { absPath: string; mime: string } {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new ViewProtocolError(400, 'malformed URL')
  }
  if (url.protocol !== `${PLUGIN_VIEW_SCHEME}:`) {
    throw new ViewProtocolError(403, 'unexpected protocol')
  }
  // host 与 partition 绑定的 pluginId 完全一致（防 URL 指向他插件）
  if (url.hostname !== pluginId) {
    throw new ViewProtocolError(403, 'plugin id mismatch')
  }
  checkUrlSearch(url.search)
  const rel = cleanViewUrlPath(url.pathname)
  const lastSeg = rel.split('/').pop() ?? ''
  if (!/\.[a-z0-9]+$/i.test(lastSeg)) {
    throw new ViewProtocolError(403, 'directory requests not allowed')
  }

  const viewRegistry = getPluginViewRegistry()
  if (!viewRegistry.isPluginEnabled(pluginId)) {
    throw new ViewProtocolError(403, 'plugin is not enabled')
  }
  const pluginDir = viewRegistry.getPluginDir(pluginId)
  if (!pluginDir) {
    throw new ViewProtocolError(403, 'plugin directory unknown')
  }

  // 真实路径包围：realpath 全程解析 symlink/junction
  let realRoot: string
  let realViews: string
  try {
    realRoot = realpathSync(pluginDir)
    realViews = realpathSync(join(realRoot, 'views'))
  } catch {
    throw new ViewProtocolError(404, 'plugin views directory not found')
  }
  if (!isPathStrictlyInside(realViews, realRoot)) {
    throw new ViewProtocolError(403, 'views directory escapes plugin root')
  }
  let realTarget: string
  try {
    realTarget = realpathSync(realViews + sep + rel.split('/').join(sep))
  } catch {
    throw new ViewProtocolError(404, 'resource not found')
  }
  if (!isPathStrictlyInside(realTarget, realViews)) {
    throw new ViewProtocolError(403, 'resource escapes views directory')
  }
  let st
  try {
    st = statSync(realTarget)
  } catch {
    throw new ViewProtocolError(404, 'resource not found')
  }
  if (!st.isFile()) {
    throw new ViewProtocolError(403, 'directory requests not allowed')
  }
  const base = realTarget.split(sep).pop() ?? ''
  if (base.startsWith('.')) {
    throw new ViewProtocolError(403, 'hidden files are not served')
  }
  const ext = base.slice(base.lastIndexOf('.')).toLowerCase()
  return { absPath: realTarget, mime: MIME_BY_EXT[ext] ?? 'application/octet-stream' }
}
