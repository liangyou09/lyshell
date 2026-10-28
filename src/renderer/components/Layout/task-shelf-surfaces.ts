import { useSyncExternalStore, type CSSProperties } from 'react'

export type ShelfSurfaceKind = 'terminal' | 'web' | 'harness'
export interface ShelfSurfaceRect { left: number; top: number; width: number; height: number }
export interface ShelfSurfaceSnapshot {
  rect: ShelfSurfaceRect | null
  clipPath: string
  visible: boolean
  interactive: boolean
  active: boolean
}
interface SurfaceRecord {
  target: HTMLElement
  interactive: boolean
  snapshot: ShelfSurfaceSnapshot
  observer: ResizeObserver | null
}

const records = new Map<string, SurfaceRecord>()
const listeners = new Set<() => void>()
const keyFor = (kind: ShelfSurfaceKind, id: string) => `${kind}:${id}`
export const SHELF_SURFACE_ENTER = 'task-shelf:surface-enter'
export const SHELF_SURFACE_LEAVE = 'task-shelf:surface-leave'
let activeKey: string | null = null
let frame = 0
/** 只有侧栏根元素上的 transform/width 会改变原生小窗几何，其余过渡不参与跟随。 */
const FOLLOWED_TRANSITIONS = ['transform', 'width']
/** 进行中的过渡按元素和属性名分别记录：重叠过渡各自结束，最后一个结束时才停止刷新循环。 */
const transitions = new Map<Element, Set<string>>()

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
let revision = 0
export const subscribeShelfSurfaces = subscribe
export const shelfSurfacesRevision = () => revision
const publish = () => { revision++; listeners.forEach(listener => listener()) }
export function useShelfKeyboardFocus(): string | null {
  return useSyncExternalStore(subscribe, () => activeKey)
}
export function refreshShelfSurfaces(): void { if (frame) cancelAnimationFrame(frame); refresh() }
export function getShelfSurface(kind: ShelfSurfaceKind, id: string): ShelfSurfaceSnapshot | null {
  return records.get(keyFor(kind, id))?.snapshot ?? null
}
export function useShelfSurface(kind: ShelfSurfaceKind, id: string): ShelfSurfaceSnapshot | null {
  return useSyncExternalStore(subscribe, () => getShelfSurface(kind, id))
}
export function useShelfSurfacePresence(kind: ShelfSurfaceKind, id: string): boolean {
  return useSyncExternalStore(subscribe, () => records.has(keyFor(kind, id)))
}
/** 宿主只在显隐/输入归属改变时渲染，矩形通过同帧订阅直接写样式。 */
export function useShelfSurfaceMode(kind: ShelfSurfaceKind, id: string): number {
  return useSyncExternalStore(subscribe, () => {
    const surface = getShelfSurface(kind, id)
    return surface ? 1 | (surface.visible ? 2 : 0) | (surface.interactive ? 4 : 0) | (surface.active ? 8 : 0) : 0
  })
}

/** 固定定位可跨越分屏的裁剪边界，但必须显式裁到右侧内容滚动区。 */
export function measureShelfSurface(target: ShelfSurfaceRect, clip: ShelfSurfaceRect): { visible: boolean; clipPath: string } {
  if (![target.left, target.top, target.width, target.height, clip.left, clip.top, clip.width, clip.height].every(Number.isFinite) || target.width <= 0 || target.height <= 0 || clip.width <= 0 || clip.height <= 0) return { visible: false, clipPath: 'inset(100%)' }
  const left = Math.max(target.left, clip.left), top = Math.max(target.top, clip.top)
  const right = Math.min(target.left + target.width, clip.left + clip.width), bottom = Math.min(target.top + target.height, clip.top + clip.height)
  if (right <= left || bottom <= top) return { visible: false, clipPath: 'inset(100%)' }
  return { visible: true, clipPath: `inset(${top - target.top}px ${target.left + target.width - right}px ${target.top + target.height - bottom}px ${left - target.left}px)` }
}

function measure(record: SurfaceRecord, key: string, bounds = new Map<Element, DOMRect>()): ShelfSurfaceSnapshot {
  const read = (element: Element) => {
    let rect = bounds.get(element)
    if (!rect) { rect = element.getBoundingClientRect(); bounds.set(element, rect) }
    return rect
  }
  const rect = read(record.target)
  if (![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return { rect: record.snapshot.rect, clipPath: 'inset(100%)', visible: false, interactive: false, active: false }
  let clip: ShelfSurfaceRect = { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
  for (const ancestor of [record.target.closest('.task-shelf-list'), record.target.closest('.task-shelf')]) {
    if (!ancestor) continue
    const ancestorRect = read(ancestor)
    const left = Math.max(clip.left, ancestorRect.left), top = Math.max(clip.top, ancestorRect.top)
    const right = Math.min(clip.left + clip.width, ancestorRect.right), bottom = Math.min(clip.top + clip.height, ancestorRect.bottom)
    clip = { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
  }
  const clipped = measureShelfSurface(rect, clip)
  const visible = clipped.visible && !record.target.closest('[aria-hidden="true"]')
  return { rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }, clipPath: clipped.clipPath, visible, interactive: visible && record.interactive, active: visible && record.interactive && key === activeKey }
}

function refresh() {
  frame = 0
  let changed = false
  // 一帧内共享滚动区和侧栏边界；先完成全部读取，再通知宿主写样式。
  const bounds = new Map<Element, DOMRect>()
  for (const [key, record] of records) {
    const next = measure(record, key, bounds)
    const old = record.snapshot
    if (next.visible !== old.visible || next.interactive !== old.interactive || next.active !== old.active || next.clipPath !== old.clipPath ||
      next.rect?.left !== old.rect?.left || next.rect?.top !== old.rect?.top || next.rect?.width !== old.rect?.width || next.rect?.height !== old.rect?.height) {
      record.snapshot = next; changed = true
    }
  }
  if (activeKey && !records.get(activeKey)?.snapshot.interactive) { activeKey = null; changed = true }
  if (changed) publish()
  // 过渡集合为空说明侧栏已停在终点，不再空转；脱离文档的元素收不到结束事件，先剔除。
  pruneTransitions()
  if (records.size && transitions.size) frame = requestAnimationFrame(refresh)
}
function schedule() { if (!frame && records.size) frame = requestAnimationFrame(refresh) }
function followedTarget(event: TransitionEvent): Element | null {
  const target = event.target
  if (!(target instanceof Element) || !target.matches('.task-shelf')) return null
  return FOLLOWED_TRANSITIONS.includes(event.propertyName) ? target : null
}
function startTransition(event: TransitionEvent) {
  const target = followedTarget(event)
  if (!target) return
  let properties = transitions.get(target)
  if (!properties) { properties = new Set(); transitions.set(target, properties) }
  properties.add(event.propertyName)
  schedule()
}
function finishTransition(event: TransitionEvent) {
  const target = followedTarget(event)
  if (!target) return
  const properties = transitions.get(target)
  if (properties && properties.delete(event.propertyName) && !properties.size) transitions.delete(target)
  schedule()
}
function pruneTransitions() {
  for (const element of transitions.keys()) if (!element.isConnected) transitions.delete(element)
}
function releaseFocus(event: FocusEvent) {
  if (activeKey && event.target instanceof Element && !event.target.closest('[data-shelf-native]')) {
    activeKey = null
    for (const record of records.values()) record.snapshot = { ...record.snapshot, active: false }
    publish()
  }
}
function watch() {
  document.addEventListener('focusin', releaseFocus)
  window.addEventListener('scroll', schedule, true)
  window.addEventListener('resize', schedule)
  window.addEventListener('transitionrun', startTransition, true)
  window.addEventListener('transitionend', finishTransition, true)
  window.addEventListener('transitioncancel', finishTransition, true)
}
function unwatch() {
  document.removeEventListener('focusin', releaseFocus)
  window.removeEventListener('scroll', schedule, true)
  window.removeEventListener('resize', schedule)
  window.removeEventListener('transitionrun', startTransition, true)
  window.removeEventListener('transitionend', finishTransition, true)
  window.removeEventListener('transitioncancel', finishTransition, true)
  if (frame) cancelAnimationFrame(frame)
  frame = 0; transitions.clear()
}

export function registerShelfSurface(kind: ShelfSurfaceKind, id: string, target: HTMLElement, interactive: boolean): () => void {
  const key = keyFor(kind, id)
  const previous = records.get(key)
  previous?.observer?.disconnect()
  const first = !records.size
  const record: SurfaceRecord = { target, interactive, observer: null, snapshot: { rect: null, clipPath: 'inset(100%)', visible: false, interactive: false, active: false } }
  records.set(key, record)
  if (typeof ResizeObserver !== 'undefined') {
    record.observer = new ResizeObserver(schedule)
    for (const element of [target, target.closest('.task-shelf-list'), target.closest('.task-shelf')]) if (element) record.observer.observe(element)
  }
  if (first) watch()
  record.snapshot = measure(record, key)
  if (activeKey === key && !record.snapshot.interactive) activeKey = null
  publish(); schedule()
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true; record.observer?.disconnect()
    if (records.get(key) !== record) return
    records.delete(key)
    if (activeKey === key) activeKey = null
    if (!records.size) unwatch()
    publish(); schedule()
  }
}

export function updateShelfSurfaceInteraction(kind: ShelfSurfaceKind, id: string, interactive: boolean): void {
  const key = keyFor(kind, id)
  const record = records.get(key)
  if (!record || record.interactive === interactive) return
  record.interactive = interactive
  if (activeKey === key && !interactive) activeKey = null
  record.snapshot = { ...record.snapshot, interactive: record.snapshot.visible && interactive, active: record.snapshot.visible && interactive && activeKey === key }
  publish()
}

export function focusShelfSurface(kind: ShelfSurfaceKind, id: string): void {
  const key = keyFor(kind, id)
  const record = records.get(key)
  if (!record?.snapshot.visible || !record.snapshot.interactive) return
  if (activeKey !== key) {
    activeKey = key
    for (const [otherKey, record] of records) record.snapshot = { ...record.snapshot, active: record.snapshot.visible && otherKey === key }
    publish()
  }
  window.dispatchEvent(new Event(SHELF_SURFACE_ENTER))
}
export function leaveShelfSurface(): void { window.dispatchEvent(new Event(SHELF_SURFACE_LEAVE)) }
export function isShelfSurfaceEngaged(): boolean {
  return !!document.querySelector('[data-shelf-native]:hover') || !!document.activeElement?.closest('[data-shelf-native]')
}

export function shelfSurfaceStyle(snapshot: ShelfSurfaceSnapshot): CSSProperties {
  return { position: 'fixed', inset: 'auto', left: snapshot.rect?.left ?? 0, top: snapshot.rect?.top ?? 0, width: snapshot.rect?.width ?? 1, height: snapshot.rect?.height ?? 1, zIndex: 46, visibility: snapshot.visible ? 'visible' : 'hidden', pointerEvents: snapshot.visible && snapshot.interactive ? 'auto' : 'none', clipPath: snapshot.clipPath }
}
