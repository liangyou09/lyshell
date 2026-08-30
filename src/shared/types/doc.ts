/**
 * 文档预览相关类型定义
 *
 * 「文档页签」：在分屏 pane 中与终端页签共存的只读文档视图，
 * 来源为文件树双击 / 窗口拖放 / Ctrl+O / 终端内 Ctrl+点击路径。
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
 * 文档页签条目 —— 同 webTabs 为瞬态：仅 pane 布局树持久化，
 * docTabs 不落盘，孤儿条目在加载布局时回收。
 */
export interface DocTabEntry {
  id: string            // `doc-${uuid}` 运行时唯一
  paneId: string        // 承载 pane
  active: boolean       // 每 pane 至多一个覆盖层激活
  source: DocSource
  kind: DocKind
  path: string          // 绝对路径（remote=posix，local=win32）
  title: string         // basename
  sessionId?: string    // remote 来源会话（刷新 / 编码上下文）
  size: number
  mtime: number         // epoch ms
  content: string       // 已解码文本（markdown 渲染源 / html srcdoc）
  loadError?: string    // 读取失败态（渲染错误占位而非空白）
  readVersion?: number  // 刷新竞态守卫：每次刷新自增，慢响应回写前校验（随页签生命周期，无泄漏）
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
