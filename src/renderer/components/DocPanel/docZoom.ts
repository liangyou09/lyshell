/**
 * 文档缩放 —— 全局单一偏好（与终端 terminalFontSize 同款约定：
 * localStorage 持久化 + CustomEvent 广播，所有文档页签共享、实时生效）。
 * Markdown 侧用 CSS zoom 挂 .doc-content（字号散落 px，zoom 整体缩放且
 * 块级自适应宽度会回流，不横向溢出）；HTML 侧把 zoom 注入 iframe srcdoc。
 */
import { useEffect, useState } from 'react'

const ZOOM_KEY = 'docZoom'
const ZOOM_EVENT = 'docZoomChanged'

export const DOC_ZOOM_MIN = 0.5
export const DOC_ZOOM_MAX = 3
export const DOC_ZOOM_STEP = 0.1

/** 夹取到 [0.5, 3] 并圆到百分位（0.1 步进的浮点尾差防护） */
export function snapDocZoom(v: number): number {
  return Math.min(DOC_ZOOM_MAX, Math.max(DOC_ZOOM_MIN, Math.round(v * 100) / 100))
}

export function readDocZoom(): number {
  try {
    const v = Number.parseFloat(localStorage.getItem(ZOOM_KEY) || '')
    return Number.isFinite(v) && v > 0 ? snapDocZoom(v) : 1
  } catch { return 1 }
}

/** 调整（步进带符号）并广播；到边界时 no-op 不广播 */
export function adjustDocZoom(delta: number): void {
  const next = snapDocZoom(readDocZoom() + delta)
  if (next === readDocZoom()) return
  try { localStorage.setItem(ZOOM_KEY, String(next)) } catch { /* 存不了就仅本次生效 */ }
  window.dispatchEvent(new CustomEvent(ZOOM_EVENT, { detail: next }))
}

/** 复位到 100% */
export function resetDocZoom(): void {
  try { localStorage.setItem(ZOOM_KEY, '1') } catch { /* 同上 */ }
  window.dispatchEvent(new CustomEvent(ZOOM_EVENT, { detail: 1 }))
}

/** 订阅缩放（MarkdownDoc / HtmlDoc / DocHeader 各自订阅，跨页签同步） */
export function useDocZoom(): number {
  const [zoom, setZoom] = useState(readDocZoom)
  useEffect(() => {
    const h = (e: Event) => setZoom((e as CustomEvent<number>).detail)
    window.addEventListener(ZOOM_EVENT, h as EventListener)
    return () => window.removeEventListener(ZOOM_EVENT, h as EventListener)
  }, [])
  return zoom
}
