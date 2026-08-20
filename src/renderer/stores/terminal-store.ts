import { create } from 'zustand'
import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type { SearchAddon } from '@xterm/addon-search'

/**
 * 终端实例信息
 */
interface TerminalInstance {
  sessionId: string
  terminal: Terminal
  fitAddon: FitAddon
  // SearchAddon 也属于终端的"长生命周期"附件——必须随终端一起在 store 中保留,
  // 否则切换 tab/分屏复用终端时,新挂载的 TerminalView 拿不到搜索能力。
  searchAddon: SearchAddon
  cols: number
  rows: number
}

/**
 * 终端 Store
 */
interface TerminalStore {
  // 终端实例映射（sessionId -> TerminalInstance）
  terminals: Map<string, TerminalInstance>

  // 注册终端
  registerTerminal: (sessionId: string, terminal: Terminal, fitAddon: FitAddon, searchAddon: SearchAddon) => void

  // 注销终端
  unregisterTerminal: (sessionId: string) => void

  // 更新尺寸
  updateSize: (sessionId: string, cols: number, rows: number) => void

  // 获取终端
  getTerminal: (sessionId: string) => TerminalInstance | undefined

  // 获取所有终端
  getAllTerminals: () => TerminalInstance[]
}

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  terminals: new Map(),

  // 注册终端
  registerTerminal: (sessionId, terminal, fitAddon, searchAddon) => {
    const terminals = new Map(get().terminals)
    terminals.set(sessionId, {
      sessionId,
      terminal,
      fitAddon,
      searchAddon,
      cols: terminal.cols,
      rows: terminal.rows
    })
    set({ terminals })
  },

  // 注销终端
  unregisterTerminal: (sessionId) => {
    const terminals = new Map(get().terminals)
    const instance = terminals.get(sessionId)
    if (instance) {
      instance.terminal.dispose()
    }
    terminals.delete(sessionId)
    set({ terminals })
  },

  // 更新尺寸
  updateSize: (sessionId, cols, rows) => {
    const terminals = new Map(get().terminals)
    const terminal = terminals.get(sessionId)
    if (terminal) {
      terminals.set(sessionId, { ...terminal, cols, rows })
      set({ terminals })

      // 发送尺寸更新到主进程
      window.electronAPI?.terminalResize(sessionId, cols, rows)
    }
  },

  // 获取终端
  getTerminal: (sessionId) => {
    return get().terminals.get(sessionId)
  },

  // 获取所有终端
  getAllTerminals: () => {
    return Array.from(get().terminals.values())
  }
}))