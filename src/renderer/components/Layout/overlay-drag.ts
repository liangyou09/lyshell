/**
 * 覆盖层页签拖拽标记 —— HTML5 DnD 期间在 dataTransfer 里传递「拖的是哪个覆盖层」。
 * 独立模块：写侧（PaneTabBar dragstart）与读侧（PaneView / PaneTabBar 的落点分流）
 * 都要解析同一协议，收在一处防两份实现漂移。
 */

/** dataTransfer text/plain 里的标记前缀（值 = 覆盖层实例 id） */
export const OVERLAY_DRAG_MARKER = '__overlay__:'

/** 解析 dataTransfer 数据里的覆盖层标记；非标记数据返回 null */
export const parseOverlayDragMarker = (data: string): string | null =>
  data.startsWith(OVERLAY_DRAG_MARKER) ? data.slice(OVERLAY_DRAG_MARKER.length) : null

/**
 * 落点分流用：从 dataTransfer 原始数据 + store 内拖拽标记共同解析覆盖层 id。
 * getData 在 dragover/drop 之外返回 ''（浏览器协议限制），外部拖入（文件等）
 * 也是 ''——空串时回落 store 标记（只有自家 dragstart 会写入），非空且非
 * 标记格式则返回 null（外来文本，不当覆盖层处理）
 */
export const resolveOverlayDragId = (dragData: string, storeDraggingId: string | null): string | null =>
  parseOverlayDragMarker(dragData) ?? (dragData === '' ? storeDraggingId : null)
