import { useSyncExternalStore } from 'react'

interface TerminalToolsState {
  count: number
  bound: boolean
  offline: boolean
  open: boolean
  toggle: () => void
}

// 页签入口只订阅轻量状态；草稿、webview 与发送状态仍属于常驻工具实例。
const states = new Map<string, TerminalToolsState>()
const listeners = new Set<() => void>()
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function publishWebTerminalState(id: string, state?: TerminalToolsState): void {
  if (state) states.set(id, state)
  else states.delete(id)
  listeners.forEach(listener => listener())
}

export function useWebTerminalState(id: string): TerminalToolsState | undefined {
  return useSyncExternalStore(subscribe, () => states.get(id))
}
