export type ShelfMode = 'auto' | 'hover' | 'fixed'
export const SHELF_PREVIEW_WIDTH = 360
export const SHELF_INPUT_WIDTH = 520
/** 顶部按行填充任务格；末行补空位，无任务时仍保留一行空格。 */
export function shelfGridLayout(width: number, count: number): { columns: number; slots: number } {
  const columns = Math.max(1, Math.floor((width - 16 + 8) / (104 + 8)))
  return { columns, slots: Math.max(columns, Math.ceil(count / columns) * columns) }
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
