/** 玉雕画轴是唯一材质；保留旧存储键用于启动时迁移历史选择。 */
export type ScrollMaterialId = 'jade'
export const DEFAULT_SCROLL_MATERIAL: ScrollMaterialId = 'jade'
export const SCROLL_MATERIAL_STORAGE_KEY = 'lyshell.scrollMaterial.v1'

export function normalizeScrollMaterial(_value: unknown): ScrollMaterialId {
  return DEFAULT_SCROLL_MATERIAL
}
