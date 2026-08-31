/**
 * 文档偏好广播订阅 hook —— docZoom / docPan / docRail 三个模块共用
 * 「模块级状态（可选 localStorage 持久化）+ CustomEvent 广播」约定的订阅侧收敛。
 * 写入侧各异（持久化与否、夹取/守卫逻辑不同），此处只收敛这段订阅样板：
 * useState 读初值 + useEffect 监听广播事件回写 detail。
 */
import { useEffect, useState } from 'react'

/** 订阅某偏好广播（docZoomChanged / docPanModeChanged / docRailOpenChanged） */
export function usePrefBroadcast<T>(eventName: string, read: () => T): T {
  const [value, setValue] = useState(read)
  useEffect(() => {
    const h = (e: Event) => setValue((e as CustomEvent<T>).detail)
    window.addEventListener(eventName, h as EventListener)
    return () => window.removeEventListener(eventName, h as EventListener)
  }, [eventName])
  return value
}
