/**
 * 文档页签读取入口 —— 统一的「读 → 开页签」管线。
 *
 * 读取全部在主进程完成：远端走 connector 原始字节 + 会话编码 iconv 解码
 * （execRaw 的 utf-8 解码对 GBK 文件有损），本地走扩展名白名单 +
 * assertSafeLocalPath 只读闸门。渲染层只消费 DocReadResult。
 * 读取失败也开页签（置 loadError）：错误占位比静默无反馈好排查。
 */
import { usePaneStore } from '../../stores/pane-store'
import i18n from '../../i18n'
import { docKindFromPath } from '@shared/types'
import type { DocReadResult, DocKind, DocSource, DocOverlayPayload } from '@shared/types'
// 内置手册随包打包（?raw 原文引入，不落磁盘）；两种语言都进主包，运行时按 locale 选
import zhManual from '../../docs/manual.zh-CN.md?raw'
import enManual from '../../docs/manual.en-US.md?raw'
import { isInventoryDocPath, refreshInventoryDoc } from '../../commands/inventory'

/** 标题取路径最后一段（posix / win32 通用：按 / 与 \ 切分） */
export function docTitleFromPath(filePath: string): string {
  const parts = filePath.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] ?? filePath
}

/** 解 IPC 信封：失败抛 Error（调用方落 loadError） */
function unwrapDoc(
  res: { success?: boolean; data?: unknown; error?: string } | undefined,
  fallback: string
): DocReadResult {
  if (!res || !res.success) throw new Error(res?.error || fallback)
  return res.data as DocReadResult
}

function extractErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 开-开竞态的版本表（文档身份 → 自增版本）：同路径并发打开时，后触发的读取
 *  须胜出，即使其响应先到（旧响应迟到时只激活页签、不覆写内容，见 openDocTab）。
 *  与下方 readVersions 同族但键不同 —— 页签在首次读取完成前尚不存在，只能按
 *  (source, sessionId, path) 键控。key 是文档身份而非页签 id，条目少量常驻不清理 */
const openVersions = new Map<string, number>()

const docKey = (source: DocSource, path: string, sessionId?: string): string =>
  source === 'remote' ? `remote:${sessionId ?? ''}:${path}` : `local:${path}`

/** 读取发起时同步分配版本（不等响应）：并发调用按调用序拿到递增值 */
const nextReadVersion = (source: DocSource, path: string, sessionId?: string): number => {
  const key = docKey(source, path, sessionId)
  const version = (openVersions.get(key) ?? 0) + 1
  openVersions.set(key, version)
  return version
}

/** 打开远端文档（文件树双击 / 终端 Ctrl+点击入口） */
export async function openRemoteDoc(sessionId: string, remotePath: string, paneId?: string): Promise<void> {
  const docKind: DocKind | null = docKindFromPath(remotePath)
  if (!docKind) return
  // OverlayPayload 判别联合的 doc 变体：kind 判别字段 + DocOverlayPayload 内容字段
  const base = {
    kind: 'doc' as const,
    source: 'remote' as DocSource,
    docKind,
    path: remotePath,
    title: docTitleFromPath(remotePath),
    sessionId,
    readVersion: nextReadVersion('remote', remotePath, sessionId)
  }
  try {
    const data = unwrapDoc(await window.electronAPI.fileReadDoc(sessionId, remotePath), 'read failed')
    // loadError 显式置 undefined：复用旧页签时抹掉上次失败的错误态（spread 合并不会自动清）
    bumpReadVersion(usePaneStore.getState().openDocTab(paneId, { ...base, size: data.size, mtime: data.mtime, content: data.content, loadError: undefined }))
  } catch (err) {
    bumpReadVersion(usePaneStore.getState().openDocTab(paneId, { ...base, size: 0, mtime: 0, content: '', loadError: extractErr(err) }))
  }
}

/** 打开本地文档（拖放 / Ctrl+Shift+O 入口） */
export async function openLocalDoc(localPath: string, paneId?: string): Promise<void> {
  const docKind: DocKind | null = docKindFromPath(localPath)
  if (!docKind) return
  const base = {
    kind: 'doc' as const,
    source: 'local' as DocSource,
    docKind,
    path: localPath,
    title: docTitleFromPath(localPath),
    readVersion: nextReadVersion('local', localPath)
  }
  try {
    const data = unwrapDoc(await window.electronAPI.fileReadLocalDoc(localPath), 'read failed')
    // loadError 显式置 undefined：同上，复用旧页签时抹掉旧错误态
    bumpReadVersion(usePaneStore.getState().openDocTab(paneId, { ...base, size: data.size, mtime: data.mtime, content: data.content, loadError: undefined }))
  } catch (err) {
    bumpReadVersion(usePaneStore.getState().openDocTab(paneId, { ...base, size: 0, mtime: 0, content: '', loadError: extractErr(err) }))
  }
}

/** 刷新竞态守卫的版本表（页签 id → 自增版本）。独立于 payload 存放：
 *  版本自增若走 payload，每次连点刷新都会写 overlayPayloads 字典，触发全量订阅
 *  该字典的 PaneView 重渲染（内容却没变）。页签关闭时随下方订阅剪除，无泄漏。 */
const readVersions = new Map<string, number>()

/** 重开使在途刷新过期：openDocTab 同路径复用页签 id，重开不 bump 的话，
 *  复用前发起的 refresh 在响应回来时仍通过 isStale 校验，拿旧内容覆盖新内容 */
const bumpReadVersion = (id: string | null): void => {
  if (id) readVersions.set(id, (readVersions.get(id) ?? 0) + 1)
}

// 订阅 payload 字典：id 消失（页签关闭 / 回收）即同步删除版本项
usePaneStore.subscribe((state, prev) => {
  if (state.overlayPayloads === prev.overlayPayloads) return
  for (const id of readVersions.keys()) {
    if (!state.overlayPayloads[id]) readVersions.delete(id)
  }
})

/** 内置使用手册的文档身份 —— openDocTab 的同 pane 复用键与页签 tooltip；
 *  lyshell:// 前缀一眼可辨「不是文件系统里的路径」，docKind 直接置 markdown 不走扩展名判定 */
export const BUILTIN_HELP_PATH = 'lyshell://help.md'

/** 打开内置使用手册（/help 命令入口）。内容随包打包、不走 IPC 读取，按当前 locale
 *  选语言；lang 参数可显式压过 locale（/help chinese 的直达入口）。同 pane 重复打开
 *  复用页签并覆写内容（openDocTab 无 readVersion = 刷新语义，切语言后再开一次即换语言）。
 *  size 用字符数近似，仅供头条元信息展示。 */
export function openBuiltinHelpDoc(paneId?: string, lang?: 'zh' | 'en'): string {
  const content = lang === 'zh' || (lang === undefined && i18n.language?.toLowerCase().startsWith('zh'))
    ? zhManual
    : enManual
  return usePaneStore.getState().openDocTab(paneId, {
    source: 'builtin',
    docKind: 'markdown',
    path: BUILTIN_HELP_PATH,
    title: i18n.t('commandBar.manualTitle'),
    size: content.length,
    mtime: 0, // 非文件，无修改时间；DocHeader 对 0 隐藏该项
    content
  })
}

/** 文档页签是否可刷新：远端/本地走重读；内置只有清点页（/ls，时点快照）可刷新，
 *  手册这类随包内容重读无意义（只随版本更新）。DocHeader 据此禁用刷新钮 ——
 *  与下方 refreshDocTab 的分支同源，行为与按钮态不会各说各话 */
export const isDocTabRefreshable = (payload: DocOverlayPayload): boolean =>
  payload.source !== 'builtin' || isInventoryDocPath(payload.path)

/** 刷新已有文档页签（DocHeader 刷新按钮）：按来源重读，成功回写内容、失败置 loadError（原内容保留在 state）。
 *  版本表见上：快速连点时慢响应不得覆盖快响应。 */
export async function refreshDocTab(id: string): Promise<void> {
  const { updateDocTab, getOverlayPayload } = usePaneStore.getState()
  const payload = getOverlayPayload(id)
  if (!payload || payload.kind !== 'doc') return
  // 内置文档随包打包、无外部来源可重读；清点页（/ls，含 /ls <对象> 子清单）例外 ——
  // 动态时点快照，刷新 = 按页签自己的身份重新聚合（inventory.ts 自带版本守卫与节参数），
  // 其余静默（内容只随版本更新）
  if (payload.source === 'builtin') {
    if (isInventoryDocPath(payload.path)) void refreshInventoryDoc(id)
    return
  }
  // 版本号在发起时即同步自增（不等响应）：连点两次各自拿到递增版本
  const version = (readVersions.get(id) ?? 0) + 1
  readVersions.set(id, version)
  const isStale = (): boolean => {
    const cur = usePaneStore.getState().getOverlayPayload(id)
    // 页签已关闭（undefined）同样视为过期
    return !(cur && cur.kind === 'doc' && readVersions.get(id) === version)
  }
  try {
    let data: DocReadResult
    if (payload.source === 'remote' && payload.sessionId) {
      data = unwrapDoc(await window.electronAPI.fileReadDoc(payload.sessionId, payload.path), 'read failed')
    } else if (payload.source === 'local') {
      data = unwrapDoc(await window.electronAPI.fileReadLocalDoc(payload.path), 'read failed')
    } else {
      return
    }
    if (isStale()) return // 已被更新的刷新取代：丢弃旧响应
    updateDocTab(id, { content: data.content, size: data.size, mtime: data.mtime, loadError: undefined })
  } catch (err) {
    if (isStale()) return
    updateDocTab(id, { loadError: extractErr(err) })
  }
}
