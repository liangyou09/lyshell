/**
 * 抓手平移模式 —— 全局瞬态开关（不持久化：会话级工具，像 PDF 阅读器的手型工具）。
 * 开启后文档内容区左键拖拽 = 上下左右平移（md 拖滚动容器；html 经护盾拖
 * iframe 的 contentWindow.scrollBy）；关闭恢复默认（选择文本/iframe 自身滚动）。
 * md 侧中键拖拽随时可平移，不依赖本开关。
 * 状态广播沿用 docZoom 的 CustomEvent 约定。
 */
import { useEffect, useState } from 'react'

const PAN_EVENT = 'docPanModeChanged'

let panMode = false

export function isPanMode(): boolean {
  return panMode
}

export function setPanMode(v: boolean): void {
  if (panMode === v) return
  panMode = v
  window.dispatchEvent(new CustomEvent(PAN_EVENT, { detail: v }))
}

export function togglePanMode(): void {
  setPanMode(!panMode)
}

/** 订阅平移模式（DocHeader 按钮 / MarkdownDoc / HtmlDoc 各自订阅，跨页签同步） */
export function usePanMode(): boolean {
  const [on, setOn] = useState(panMode)
  useEffect(() => {
    const h = (e: Event) => setOn((e as CustomEvent<boolean>).detail)
    window.addEventListener(PAN_EVENT, h as EventListener)
    return () => window.removeEventListener(PAN_EVENT, h as EventListener)
  }, [])
  return on
}
