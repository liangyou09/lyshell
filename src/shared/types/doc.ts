/**
 * 文档预览相关类型定义
 *
 * 「文档页签」：在分屏 pane 中与终端页签共存的只读文档视图，
 * 来源为文件树双击 / 窗口拖放 / Ctrl+Shift+O / 终端内 Ctrl+点击路径。
 */

/**
 * 文档来源
 */
export type DocSource = 'remote' | 'local'

/**
 * 文档类型（按扩展名判定）
 */
export type DocKind = 'markdown' | 'html'

/**
 * 文档覆盖层 payload —— 挂载态（id/paneId/active/slot）在 pane 树的 OverlayRef 上，
 * 这里只留内容数据。瞬态：仅 pane 布局树持久化，覆盖层不落盘，重启即回收。
 */
export interface DocOverlayPayload {
  source: DocSource
  docKind: DocKind
  path: string          // 绝对路径（remote=posix，local=win32）
  title: string         // basename
  sessionId?: string    // remote 来源会话（刷新 / 编码上下文）
  size: number
  mtime: number         // epoch ms
  content: string       // 已解码文本（markdown 渲染源 / html srcdoc）
  loadError?: string    // 读取失败态（渲染错误占位而非空白）
  // 开-开竞态守卫：读取「发起时」分配的版本（readDoc 的 openVersions，按文档身份自增）。
  // 同 pane 并发打开同一路径时，后触发先到的旧响应（含旧失败）版本更小，
  // openDocTab 复用分支据此拒绝覆写内容。刷新排序走 readDoc 的 readVersions，
  // 不经过此字段。不带版本（直接调用 openDocTab）= 无条件覆写的刷新语义
  readVersion?: number
}

/**
 * 文档读取结果（IPC file:read-doc / file:read-local-doc 响应体）
 */
export interface DocReadResult {
  content: string
  size: number
  mtime: number
  encoding: string
}

/**
 * 文档预览扩展名白名单（大小写不敏感）
 */
export const DOC_EXTENSIONS = ['.md', '.markdown', '.html', '.htm', '.txt'] as const

/**
 * 远端文档大小上限（2MB，超出提示下载后查看）
 */
export const DOC_MAX_REMOTE_BYTES = 2 * 1024 * 1024

/**
 * 本地文档大小上限（10MB）
 */
export const DOC_MAX_LOCAL_BYTES = 10 * 1024 * 1024

/**
 * 路径是否命中文档扩展名白名单
 */
export function isDocPath(path: string): boolean {
  const lower = path.toLowerCase()
  return DOC_EXTENSIONS.some(ext => lower.endsWith(ext))
}

/**
 * 按扩展名判定文档类型；非白名单返回 null
 */
export function docKindFromPath(path: string): DocKind | null {
  const lower = path.toLowerCase()
  if (lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.txt')) {
    return 'markdown'
  }
  if (lower.endsWith('.html') || lower.endsWith('.htm')) {
    return 'html'
  }
  return null
}
