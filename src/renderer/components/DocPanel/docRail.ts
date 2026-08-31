/**
 * 文档目录轨开关 —— 全局单一偏好（与 docZoom / docPan 同款约定：
 * localStorage 持久化 + CustomEvent 广播，所有文档页签共享、实时生效）。
 * 消费方：MarkdownDoc（渲染目录轨或左缘展开条）与 DocHeader（常驻切换钮，
 * 收起时 amber 高亮提示展开入口）。无标题文档不渲染轨，此偏好不生效但保留。
 */
import { usePrefBroadcast } from './docPrefSync'

const RAIL_OPEN_KEY = 'docRailOpen'
const RAIL_OPEN_EVENT = 'docRailOpenChanged'

export function readDocRailOpen(): boolean {
  try { return localStorage.getItem(RAIL_OPEN_KEY) !== '0' } catch { return true }
}

export function setDocRailOpen(open: boolean): void {
  try { localStorage.setItem(RAIL_OPEN_KEY, open ? '1' : '0') } catch { /* 存不了就仅本次生效 */ }
  window.dispatchEvent(new CustomEvent(RAIL_OPEN_EVENT, { detail: open }))
}

export function toggleDocRail(): void {
  setDocRailOpen(!readDocRailOpen())
}

/** 订阅目录轨开关（MarkdownDoc / DocHeader 各自订阅，跨页签同步） */
export function useDocRailOpen(): boolean {
  return usePrefBroadcast(RAIL_OPEN_EVENT, readDocRailOpen)
}
