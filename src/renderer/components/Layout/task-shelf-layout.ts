export type ShelfMode = 'auto' | 'hover' | 'fixed'
export type ShelfEdge = 'left' | 'right' | 'top' | 'bottom'
export function shelfEdge(raw: unknown): ShelfEdge {
  return raw === 'left' || raw === 'top' || raw === 'bottom' ? raw : 'right'
}
export function shelfPanelHeight(value: number, available: number): number {
  return Math.min(Math.max(0, available - 32), Math.max(0, available * 0.65), Math.max(260, value))
}
/** 只在靠近内容区边缘时吸附，中央松手保持原位置。 */
export function shelfDropEdge(x: number, y: number, rect: { left: number; top: number; width: number; height: number }): ShelfEdge | null {
  if (rect.width <= 0 || rect.height <= 0 || x < rect.left || y < rect.top || x > rect.left + rect.width || y > rect.top + rect.height) return null
  const distances: [ShelfEdge, number][] = [['left', x - rect.left], ['right', rect.left + rect.width - x], ['top', y - rect.top], ['bottom', rect.top + rect.height - y]]
  distances.sort((a, b) => a[1] - b[1])
  return distances[0][1] <= Math.min(96, rect.width / 4, rect.height / 4) ? distances[0][0] : null
}
export const SHELF_PREVIEW_WIDTH = 360
export const SHELF_INPUT_WIDTH = 520
/** 横向任务栏：标题位于上方，网页工具栏计入统一的 16:9 窗口高度。 */
export function shelfHorizontalLayout(width: number, height: number, count: number, previewRequested = false) {
  const rows = Math.max(1, Math.floor((height - 24) / 136))
  const columns = Math.max(1, Math.ceil(count / rows))
  // 显式选择任务时让方块区横向滚动，为右侧小窗口保留至少 280px。
  const gridMaximum = previewRequested && width >= 456 ? Math.min(Math.max(148, width * 0.4), width - 308) : width
  const gridWidth = Math.min(width, columns * 136 + 12, gridMaximum)
  const previewWidth = Math.max(0, Math.min(width - gridWidth - 28, (height - 70) * 16 / 9))
  const previewCardWidth = previewWidth + 2
  return { rows, columns, gridWidth, previewWidth, previewCardWidth, showPreviews: previewWidth >= 280 }
}
/** 任务卡保留可读宽度，宽栏最多五列；不为未保存的任务生成占位。 */
export function shelfGridLayout(width: number): { columns: number } {
  const columns = Math.max(width >= 224 ? 2 : 1, Math.min(5, Math.floor((width - 32 + 12) / (132 + 12))))
  return { columns }
}
/** 输入为窗口和左侧占用后的实际 CSS 宽度，含回差避免调宽时反复切换。 */
export function shelfDocked(mode: ShelfMode, windowWidth: number, availableWidth: number, panelWidth: number, previous: boolean): boolean {
  if (mode === 'hover') return false
  const enough = availableWidth - panelWidth >= (previous ? 1020 : 1100)
  if (mode === 'fixed') return enough
  return enough && windowWidth >= (previous ? 1720 : 1800)
}

export function shelfPanelWidth(value: number, available: number, windowWidth = available): number {
  const maximum = Math.max(0, Math.min(windowWidth * 0.4, available - 32))
  return Math.min(maximum, Math.max(240, value))
}
