import { create } from 'zustand'
import type { SessionConfig } from '@shared/types'
import { ConnectionStatus } from '@shared/types'
import { useTerminalStore } from './terminal-store'

/**
 * 会话状态
 */
interface SessionState {
  id: string
  config: SessionConfig
  status: ConnectionStatus
  lastError?: string
  isTemporary?: boolean // 临时会话标记
  skipAutoAddToPane?: boolean // 跳过自动添加到分屏（用于克隆）
  hasActivity?: boolean // 有新输出活动（用于标签高亮提示）
}

/**
 * 会话 Store
 */
interface SessionStore {
  // 保存的会话列表
  savedSessions: SessionConfig[]

  // 所有会话（包括临时会话）
  sessions: SessionState[]

  // 可达性映射：key = saved session.id（与 main/ipc/handlers.ts 中 syncReachabilityTargets 对齐）
  reachability: Record<string, { reachable: boolean; at: number }>

  // 活动会话ID
  activeSessionId: string | null

  // 加载状态
  loading: boolean

  // 刷新保存的会话列表
  refreshSavedSessions: () => Promise<void>

  // 操作方法
  loadSessions: () => Promise<void>
  createSession: (config: SessionConfig) => Promise<SessionState>
  updateSession: (config: SessionConfig) => Promise<void>
  deleteSession: (id: string) => Promise<void>

  // 克隆会话
  cloneSession: (sourceSessionId: string, cloneChannel?: boolean) => Promise<string>

  // 添加临时会话
  addTemporarySession: (state: SessionState) => void

  // 连接方法
  connectSession: (id: string) => Promise<void>
  disconnectSession: (id: string, clearTerminal?: boolean) => Promise<void>
  reconnectSession: (id: string) => Promise<void>

  // 状态更新
  updateSessionStatus: (id: string, status: ConnectionStatus, error?: string) => void
  updateReachability: (key: string, reachable: boolean) => void
  setActiveSession: (id: string | null) => void

  // 获取方法
  getSession: (id: string) => SessionState | undefined
  getActiveSession: () => SessionState | undefined

  // 清除跳过自动添加标记
  clearSkipAutoAddToPane: (id: string) => void

  // 设置/清除会话活动状态
  setSessionActivity: (id: string, hasActivity: boolean) => void
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  savedSessions: [],
  sessions: [],
  reachability: {},
  activeSessionId: null,
  loading: false,

  // 刷新保存的会话列表
  refreshSavedSessions: async () => {
    try {
      const sessions = await window.electronAPI.listSessions()
      set({ savedSessions: sessions })
    } catch (error) {
      console.error('Failed to refresh saved sessions:', error)
    }
  },

  // 加载会话列表
  loadSessions: async () => {
    set({ loading: true })
    try {
      const sessions = await window.electronAPI.listSessions()
      set({
        savedSessions: sessions,
        sessions: sessions.map(s => ({
          id: s.id,
          config: s,
          status: 'disconnected' as ConnectionStatus
        })),
        loading: false
      })
    } catch (error) {
      console.error('Failed to load sessions:', error)
      set({ loading: false })
    }
  },

  // 创建会话（保存的会话）
  createSession: async (config) => {
    const saved = await window.electronAPI.createSession(config)
    const newSession: SessionState = {
      id: saved.id,
      config: saved,
      status: ConnectionStatus.DISCONNECTED
    }
    set(store => ({
      savedSessions: [...store.savedSessions, saved],
      sessions: [...store.sessions, newSession]
    }))
    return newSession
  },

  // 更新会话
  updateSession: async (config) => {
    await window.electronAPI.updateSession(config)
    set(state => ({
      savedSessions: state.savedSessions.map(s =>
        s.id === config.id ? config : s
      ),
      sessions: state.sessions.map(s =>
        s.id === config.id ? { ...s, config } : s
      )
    }))
  },

  // 删除会话
  deleteSession: async (id) => {
    await window.electronAPI.deleteSession(id)
    set(state => ({
      savedSessions: state.savedSessions.filter(s => s.id !== id),
      sessions: state.sessions.filter(s => s.id !== id),
      activeSessionId: state.activeSessionId === id ? null : state.activeSessionId
    }))
  },

  // 添加临时会话
  addTemporarySession: (state) => {
    set(s => ({
      sessions: [...s.sessions, { ...state, isTemporary: true }]
    }))
  },

  // 连接会话
  connectSession: async (id) => {
    const session = get().sessions.find(s => s.id === id)
    if (!session) return

    set(state => ({
      sessions: state.sessions.map(s =>
        s.id === id ? { ...s, status: 'connecting' as ConnectionStatus } : s
      )
    }))

    try {
      await window.electronAPI.connect(session.config)
    } catch (error) {
      set(state => ({
        sessions: state.sessions.map(s =>
          s.id === id ? {
            ...s,
            status: 'error' as ConnectionStatus,
            lastError: (error as Error).message
          } : s
        )
      }))
    }
  },

  // 断开连接（用户主动断开才清理终端）
  disconnectSession: async (id, clearTerminal = true) => {
    await window.electronAPI.disconnect(id)
    set(state => ({
      sessions: state.sessions.map(s =>
        s.id === id ? { ...s, status: 'disconnected' as ConnectionStatus } : s
      )
    }))
    // 只有用户主动断开才清理终端实例
    if (clearTerminal) {
      useTerminalStore.getState().unregisterTerminal(id)
    }
    // 移除临时会话
    const session = get().sessions.find(s => s.id === id)
    if (session?.isTemporary) {
      set(s => ({
        sessions: s.sessions.filter(sess => sess.id !== id)
      }))
    }
  },

  // 重连
  reconnectSession: async (id) => {
    await window.electronAPI.reconnect(id)
  },

  // 克隆会话
  cloneSession: async (sourceSessionId, cloneChannel = false) => {
    const sourceSession = get().sessions.find(s => s.id === sourceSessionId)
    if (!sourceSession) {
      throw new Error('Source session not found')
    }

    // 克隆会话保持源会话的名称（不修改），PaneTabBar 会根据 createdAt 显示序号
    const newName = sourceSession.config.name

    // 创建新的会话配置（复制配置，清除 id）
    const newConfig: SessionConfig = {
      ...sourceSession.config,
      id: '',  // 空 id 表示临时会话
      name: newName,
      createdAt: new Date(),
      updatedAt: new Date()
    }

    // 如果是 SSH 且要求克隆渠道
    if (cloneChannel && sourceSession.config.type === 'ssh') {
      try {
        // 通过后端克隆渠道
        const result = await window.electronAPI?.cloneChannel(sourceSessionId)
        if (result && result.id) {
          // 更新配置中的名称
          result.config.name = newName
          return result.id
        }
        throw new Error('Clone channel failed')
      } catch (error) {
        console.error('Clone channel failed:', error)
        throw error
      }
    }

    // 普通克隆：创建新连接
    try {
      const result = await window.electronAPI?.connect(newConfig)
      if (result && result.id) {
        return result.id
      }
      throw new Error('Failed to create cloned session')
    } catch (error) {
      console.error('Clone session failed:', error)
      throw error
    }
  },

  // 更新状态
  updateSessionStatus: (id, status, error) => {
    set(state => ({
      sessions: state.sessions.map(s =>
        s.id === id ? { ...s, status, lastError: error } : s
      )
    }))
  },

  // 更新可达性
  updateReachability: (key, reachable) => {
    set(state => ({
      reachability: { ...state.reachability, [key]: { reachable, at: Date.now() } }
    }))
  },

  // 设置活动会话
  setActiveSession: (id) => {
    set({ activeSessionId: id })
  },

  // 获取会话
  getSession: (id) => {
    return get().sessions.find(s => s.id === id)
  },

  // 获取活动会话
  getActiveSession: () => {
    const id = get().activeSessionId
    if (!id) return undefined
    return get().sessions.find(s => s.id === id)
  },

  // 清除跳过自动添加标记
  clearSkipAutoAddToPane: (id) => {
    set(state => ({
      sessions: state.sessions.map(s =>
        s.id === id ? { ...s, skipAutoAddToPane: false } : s
      )
    }))
  },

  // 设置/清除会话活动状态
  setSessionActivity: (id, hasActivity) => {
    set(state => ({
      sessions: state.sessions.map(s =>
        s.id === id ? { ...s, hasActivity } : s
      )
    }))
  }
}))