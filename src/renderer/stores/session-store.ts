import { create } from 'zustand'
import type { SessionConfig, TerminalEncoding } from '@shared/types'
import { ConnectionStatus } from '@shared/types'
import { useTerminalStore } from './terminal-store'
import i18n from '../i18n'

/**
 * 会话状态
 */
export interface SessionState {
  id: string
  config: SessionConfig
  /**
   * 运行时编码（状态栏切档 / MCP 落位的推送字段）—— 放 config 外：
   * config 始终是保存值的镜像（sync/update 会整体替换），运行时值独立存放
   * 才不会被同步冲掉、读数也才与 connector 实际解码一致
   */
  runtimeEncoding?: TerminalEncoding
  status: ConnectionStatus
  lastError?: string
  isTemporary?: boolean // 临时会话标记
  skipAutoAddToPane?: boolean // 跳过自动添加到分屏（用于克隆）
  hasActivity?: boolean // 有新输出活动（用于标签高亮提示）
  lockedByMcp?: boolean // MCP 是否正在占用该会话 PTY（共享 PTY 模式时阻塞用户输入）
}

/**
 * 会话 Store
 */
interface SessionStore {
  // 保存的会话列表
  savedSessions: SessionConfig[]

  // 所有会话（包括临时会话）
  sessions: SessionState[]

  // 编码推送早于 entry 建立时的暂存（id -> 编码）：MCP create_session 就地连接时，
  // main 先后推 session:status（CONNECTING）与 session:encoding-changed，渲染层
  // onConnectionStatus 收到前者才发起异步 getSession 建 entry —— 后者必然先到、
  // 直接落位会被丢弃（读数停在保存值而 connector 已按新值解码）。暂存后由
  // addTemporarySession 建立时带上，deleteSession 时清掉
  pendingRuntimeEncoding: Record<string, TerminalEncoding>

  // 可达性映射：key = saved session.id（与 main/ipc/handlers.ts 中 syncReachabilityTargets 对齐）
  reachability: Record<string, { reachable: boolean; at: number }>

  // 活动会话ID
  activeSessionId: string | null

  // 加载状态
  loading: boolean

  // 刷新保存的会话列表
  refreshSavedSessions: () => Promise<void>

  // 外部路径（MCP 写入/创建）改动会话列表后的增量同步：
  // 拉取最新列表，合并进既有 entry 的 config，但不重置 status/isTemporary/hasActivity。
  // 与 loadSessions 的区别——loadSessions 会把所有会话 status 重置为 disconnected，不能用于运行中同步。
  syncSessionsFromBackend: () => Promise<void>

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
  // 从 sessions 数组移除一个 entry —— "真关闭"(不动 savedSessions / 不动后端 config)
  // 用于 Sidebar LIVE 段:disconnect 只改 status,真要从 UI 摘掉得显式从 sessions 里清掉
  removeLiveSession: (id: string) => void

  // 状态更新
  updateSessionStatus: (id: string, status: ConnectionStatus, error?: string) => void
  updateReachability: (key: string, reachable: boolean) => void
  setActiveSession: (id: string | null) => void

  // 运行时切换会话编码（状态栏点击）—— 只发 IPC，不在这里改 state：main 成功后推
  // session:encoding-changed，MainWindow 监听落位 setRuntimeEncoding（单一驱动源，
  // 避免「乐观更新 + 推送回填」双写竞态；不写回 savedSessions，关闭后重新打开才回到保存值）
  setSessionEncoding: (id: string, encoding: TerminalEncoding) => Promise<void>

  // session:encoding-changed 推送的落点：只写对应 entry 的 runtimeEncoding
  setRuntimeEncoding: (id: string, encoding: TerminalEncoding) => void

  // 获取方法
  getSession: (id: string) => SessionState | undefined
  getActiveSession: () => SessionState | undefined

  // 清除跳过自动添加标记
  clearSkipAutoAddToPane: (id: string) => void

  // 设置/清除会话活动状态
  setSessionActivity: (id: string, hasActivity: boolean) => void

  // 设置/清除 MCP PTY 锁定状态
  setSessionMcpLock: (id: string, lockedByMcp: boolean) => void
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  savedSessions: [],
  sessions: [],
  reachability: {},
  pendingRuntimeEncoding: {},
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

  // 外部路径（MCP）改动后的增量同步：savedSessions 全量替换；
  // sessions 数组保留每个既有 entry 的运行态（status/isTemporary/hasActivity），仅用最新 config 覆盖。
  // 运行时编码不怕被覆盖 —— 它在 entry 的 runtimeEncoding 字段（config 外），
  // config 换成保存值镜像不影响读数（见 SessionState.runtimeEncoding）。
  // 新会话只进 savedSessions（sidebar SAVED 段以它为源），不强行塞进 sessions——用户没打开就不该出现在 LIVE 段。
  syncSessionsFromBackend: async () => {
    try {
      const fresh: SessionConfig[] = await window.electronAPI.listSessions()
      const freshById = new Map<string, SessionConfig>()
      for (const s of fresh) freshById.set(s.id, s)
      set(state => ({
        savedSessions: fresh,
        sessions: state.sessions.map(entry => {
          const updated = freshById.get(entry.id)
          return updated ? { ...entry, config: updated } : entry
        })
      }))
    } catch (error) {
      console.error('Failed to sync sessions from backend:', error)
    }
  },

  // 加载会话列表
  loadSessions: async () => {
    set({ loading: true })
    try {
      const sessions = await window.electronAPI.listSessions()
      set(state => ({
        savedSessions: sessions,
        // 启动窗口内可能有编码推送先到（listSessions 往返期间）：已有 entry 的
        // runtimeEncoding 保留；暂存里的早到推送在此消费 —— addTemporarySession
        // 的合并路径会再兜一次，同值重复消费无害
        sessions: sessions.map(s => ({
          id: s.id,
          config: s,
          status: 'disconnected' as ConnectionStatus,
          runtimeEncoding: state.sessions.find(e => e.id === s.id)?.runtimeEncoding ?? state.pendingRuntimeEncoding[s.id]
        })),
        loading: false
      }))
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

  // 运行时切换编码（状态栏点击）：只发 IPC。成功后 main 推 session:encoding-changed，
  // 由 MainWindow 监听调 setRuntimeEncoding 落位 —— 单一驱动源，这里不做乐观更新。
  // handler 对未知会话/local 兜底拒绝时是「解析 {success:false}」而非抛错，不查就是
  // 静默 no-op —— 留 warn 供排查（读数保持原值，main 没推事件）
  setSessionEncoding: async (id, encoding) => {
    try {
      const res: { success?: boolean } | undefined = await window.electronAPI.setSessionEncoding(id, encoding)
      if (!res?.success) {
        console.warn('Switch session encoding rejected (session gone or local):', id, encoding)
      }
    } catch (error) {
      console.error('Failed to switch session encoding:', error)
    }
  },

  // 编码切换推送的落点：只写 runtimeEncoding（config 保持保存值镜像）。
  // entry 还没建立（见 pendingRuntimeEncoding 的说明）时先暂存，addTemporarySession 建立时带上。
  // 未命中只动暂存，不做 sessions 数组的无谓拷贝（不触发订阅者重渲染）
  setRuntimeEncoding: (id, encoding) => {
    set(state => {
      if (!state.sessions.some(s => s.id === id)) {
        return { pendingRuntimeEncoding: { ...state.pendingRuntimeEncoding, [id]: encoding } }
      }
      const sessions = state.sessions.map(s => (s.id === id ? { ...s, runtimeEncoding: encoding } : s))
      if (!(id in state.pendingRuntimeEncoding)) return { sessions }
      const pendingRuntimeEncoding = { ...state.pendingRuntimeEncoding }
      delete pendingRuntimeEncoding[id]
      return { sessions, pendingRuntimeEncoding }
    })
  },

  // 删除会话
  deleteSession: async (id) => {
    await window.electronAPI.deleteSession(id)
    set(state => {
      const pendingRuntimeEncoding = { ...state.pendingRuntimeEncoding }
      delete pendingRuntimeEncoding[id]
      return {
        savedSessions: state.savedSessions.filter(s => s.id !== id),
        sessions: state.sessions.filter(s => s.id !== id),
        activeSessionId: state.activeSessionId === id ? null : state.activeSessionId,
        pendingRuntimeEncoding
      }
    })
  },

  // 添加临时会话
  // 去重: onConnectionStatus 的 connecting/connected 事件可能在 getSession().then()
  // 返回前先后到达,导致对同一 id 调用两次 addTemporarySession,数组里出现重复 entry。
  // 这里改为: 已存在同 id 则合并更新(保留 isTemporary),否则才 push。
  // 建立时取回 pendingRuntimeEncoding 暂存的早到编码推送并清掉(见该字段说明)
  addTemporarySession: (state) => {
    set(s => {
      const runtimeEncoding = s.pendingRuntimeEncoding[state.id]
      let pendingRuntimeEncoding = s.pendingRuntimeEncoding
      if (runtimeEncoding !== undefined) {
        pendingRuntimeEncoding = { ...s.pendingRuntimeEncoding }
        delete pendingRuntimeEncoding[state.id]
      }
      const withRuntime = runtimeEncoding !== undefined ? { ...state, runtimeEncoding } : state
      const idx = s.sessions.findIndex(x => x.id === state.id)
      if (idx >= 0) {
        const next = [...s.sessions]
        next[idx] = { ...next[idx], ...withRuntime, isTemporary: next[idx].isTemporary || withRuntime.isTemporary }
        return { sessions: next, pendingRuntimeEncoding }
      }
      return { sessions: [...s.sessions, { ...withRuntime, isTemporary: true }], pendingRuntimeEncoding }
    })
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
  // 对已经 disconnected/error 的会话不再调后端 disconnect，避免 half-open 连接器挂起/抛错阻塞前端清理。
  // 后端找不到 session 或 disconnect 失败也继续清理 store/terminal，保证“关闭”一定有可见效果。
  disconnectSession: async (id, clearTerminal = true) => {
    const sessionBefore = get().sessions.find(s => s.id === id)
    const alreadyDead = sessionBefore?.status === 'disconnected' || sessionBefore?.status === 'error'

    if (!alreadyDead) {
      try {
        await window.electronAPI.disconnect(id)
      } catch (error) {
        // 已经断开或后端找不到都无所谓，继续前端清理
        console.warn('Backend disconnect failed, continuing frontend cleanup:', error)
      }
    }

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

  // 从 sessions 数组移除 entry —— Sidebar LIVE 段的"真关闭"用,即使已 disconnected 也能彻底摘掉
  removeLiveSession: (id) => {
    set(state => ({
      sessions: state.sessions.filter(s => s.id !== id),
      activeSessionId: state.activeSessionId === id ? null : state.activeSessionId
    }))
  },

  // 克隆会话
  cloneSession: async (sourceSessionId, cloneChannel = false) => {
    const sourceSession = get().sessions.find(s => s.id === sourceSessionId)
    if (!sourceSession) {
      throw new Error(i18n.t('error.session.sourceNotFound'))
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
    // 运行时编码继承：源 entry 的 config 是保存值镜像（sync/update 会整体替换，
    // 运行时切换只落在 runtimeEncoding 字段）。不带上的话普通克隆按保存值建流解码
    // —— GBK 主机上乱码；而克隆渠道（main 侧 withRuntimeEncoding 读源会话的运行时
    // config）按切换值解码，同一个页签两种克隆手势得到两种字符集、读数也和源分叉
    if (sourceSession.runtimeEncoding && sourceSession.runtimeEncoding !== newConfig.terminal?.encoding) {
      newConfig.terminal = { ...newConfig.terminal, encoding: sourceSession.runtimeEncoding }
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
        throw new Error(i18n.t('error.session.cloneChannelFailed'))
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
      throw new Error(i18n.t('error.session.createCloneFailed'))
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
  },

  // 设置/清除 MCP PTY 锁定状态
  setSessionMcpLock: (id, lockedByMcp) => {
    set(state => ({
      sessions: state.sessions.map(s =>
        s.id === id ? { ...s, lockedByMcp } : s
      )
    }))
  }
}))