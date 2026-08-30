/**
 * 文档页签读取入口 —— 统一的「读 → 开页签」管线。
 *
 * 读取全部在主进程完成：远端走 connector 原始字节 + 会话编码 iconv 解码
 * （execRaw 的 utf-8 解码对 GBK 文件有损），本地走扩展名白名单 +
 * assertSafeLocalPath 只读闸门。渲染层只消费 DocReadResult。
 * 读取失败也开页签（置 loadError）：错误占位比静默无反馈好排查。
 */
import { usePaneStore } from '../../stores/pane-store'
import { docKindFromPath } from '@shared/types'
import type { DocReadResult, DocTabEntry, DocKind, DocSource } from '@shared/types'

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

/** 打开远端文档（文件树双击 / 终端 Ctrl+点击入口） */
export async function openRemoteDoc(sessionId: string, remotePath: string, paneId?: string): Promise<void> {
  const kind: DocKind | null = docKindFromPath(remotePath)
  if (!kind) return
  const base = {
    source: 'remote' as DocSource,
    kind,
    path: remotePath,
    title: docTitleFromPath(remotePath),
    sessionId
  }
  try {
    const data = unwrapDoc(await window.electronAPI.fileReadDoc(sessionId, remotePath), 'read failed')
    // loadError 显式置 undefined：复用旧页签时抹掉上次失败的错误态（spread 合并不会自动清）
    usePaneStore.getState().openDocTab(paneId, { ...base, size: data.size, mtime: data.mtime, content: data.content, loadError: undefined })
  } catch (err) {
    usePaneStore.getState().openDocTab(paneId, { ...base, size: 0, mtime: 0, content: '', loadError: extractErr(err) })
  }
}

/** 打开本地文档（拖放 / Ctrl+O 入口） */
export async function openLocalDoc(localPath: string, paneId?: string): Promise<void> {
  const kind: DocKind | null = docKindFromPath(localPath)
  if (!kind) return
  const base = {
    source: 'local' as DocSource,
    kind,
    path: localPath,
    title: docTitleFromPath(localPath)
  }
  try {
    const data = unwrapDoc(await window.electronAPI.fileReadLocalDoc(localPath), 'read failed')
    // loadError 显式置 undefined：同上，复用旧页签时抹掉旧错误态
    usePaneStore.getState().openDocTab(paneId, { ...base, size: data.size, mtime: data.mtime, content: data.content, loadError: undefined })
  } catch (err) {
    usePaneStore.getState().openDocTab(paneId, { ...base, size: 0, mtime: 0, content: '', loadError: extractErr(err) })
  }
}

/** 刷新已有文档页签（DocHeader 刷新按钮）：按来源重读，成功回写内容、失败置 loadError（原内容保留在 state）。
 *  版本号存页签条目自身（readVersion）：快速连点时慢响应不得覆盖快响应；
 *  页签关闭后条目即消失，守卫随生命周期回收，无独立累积。 */
export async function refreshDocTab(tab: DocTabEntry): Promise<void> {
  const { updateDocTab } = usePaneStore.getState()
  // 版本号基于 store 当前值自增（而非入参快照）：同一渲染周期内连点两次也会得到不同版本
  const current = usePaneStore.getState().docTabs.find(t => t.id === tab.id)
  const version = (current?.readVersion ?? 0) + 1
  updateDocTab(tab.id, { readVersion: version })
  const isStale = (): boolean => {
    const cur = usePaneStore.getState().docTabs.find(t => t.id === tab.id)
    return cur?.readVersion !== version // 页签已关闭（undefined）同样视为过期
  }
  try {
    let data: DocReadResult
    if (tab.source === 'remote' && tab.sessionId) {
      data = unwrapDoc(await window.electronAPI.fileReadDoc(tab.sessionId, tab.path), 'read failed')
    } else if (tab.source === 'local') {
      data = unwrapDoc(await window.electronAPI.fileReadLocalDoc(tab.path), 'read failed')
    } else {
      return
    }
    if (isStale()) return // 已被更新的刷新取代：丢弃旧响应
    updateDocTab(tab.id, { content: data.content, size: data.size, mtime: data.mtime, loadError: undefined })
  } catch (err) {
    if (isStale()) return
    updateDocTab(tab.id, { loadError: extractErr(err) })
  }
}
