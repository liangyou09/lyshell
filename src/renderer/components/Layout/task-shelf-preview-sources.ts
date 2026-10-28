/** 仅可见缩略图申请后台网页绘制；不改变页签激活态、输入目标或 guest 实例。 */
const sources = new Map<string, number>()
const listeners = new Set<() => void>()
let revision = 0
const changed = () => { revision += 1; listeners.forEach(listener => listener()) }
export const shelfWebPreviewRevision = () => revision
export const isShelfWebPreviewing = (id: string) => sources.has(id)
export function subscribeShelfWebPreviews(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function registerShelfWebPreview(id: string): () => void {
  const previous = sources.get(id) || 0
  sources.set(id, previous + 1)
  if (!previous) changed()
  let released = false
  return () => {
    if (released) return
    released = true
    const remaining = (sources.get(id) || 1) - 1
    if (remaining) sources.set(id, remaining)
    else { sources.delete(id); changed() }
  }
}
