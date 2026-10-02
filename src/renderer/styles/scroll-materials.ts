/** 轴头材质与主题独立；早期恢复脚本只引入这份轻量白名单。 */
export const SCROLL_MATERIAL_IDS = ['walnut', 'jade', 'lacquer', 'porcelain'] as const
export type ScrollMaterialId = typeof SCROLL_MATERIAL_IDS[number]
export const DEFAULT_SCROLL_MATERIAL: ScrollMaterialId = 'walnut'
export const SCROLL_MATERIAL_STORAGE_KEY = 'lyshell.scrollMaterial.v1'

export function normalizeScrollMaterial(value: unknown): ScrollMaterialId {
  return typeof value === 'string' && SCROLL_MATERIAL_IDS.some(id => id === value)
    ? value as ScrollMaterialId
    : DEFAULT_SCROLL_MATERIAL
}
