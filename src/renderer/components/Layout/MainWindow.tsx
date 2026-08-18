import React, { useState, useEffect, useRef, useCallback } from 'react'
import cn from 'classnames'
import { useTranslation } from 'react-i18next'
import SessionsPanel from './SessionsPanel'
import ActivityRail, { type NavTab, RAIL_WIDTH } from './ActivityRail'
import AgentsPanel from './AgentsPanel'
import StatusBar from './StatusBar'
import SplitPaneContainer from './SplitPaneContainer'
import FloatWindow from '../FloatWindow/FloatWindow'
import { McpActivityChip } from './McpActivityChip'
import PluginPanel from './PluginPanel'
import DeepSeekHarnessPanel from './DeepSeekHarnessPanel'
import SettingsPanel from './SettingsPanel'
import { useSessionStore } from '../../stores/session-store'
import { usePaneStore } from '../../stores/pane-store'
import { useThemeStore } from '../../stores/theme-store'
import { useLocaleStore } from '../../stores/locale-store'
import type { SessionConfig } from '@shared/types'

/**
 * 主窗口布局组件
 */
const MainWindow: React.FC = () => {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  // 左列机柜页签轨当前页签 -- 持久化到 localStorage
  const [activeNav, setActiveNav] = useState<NavTab>(() => {
    try {
      const saved = localStorage.getItem('lyshell.navTab.v1')
      if (saved === 'sessions' || saved === 'agents' || saved === 'dsh' || saved === 'plugins' || saved === 'settings') {
        return saved
      }
    } catch { /* localStorage 不可用,回退默认 */ }
    return 'sessions'
  })
  // 左列宽度(三栏共享) -- 从会话面板(SessionsPanel)上移到此;ActivityRail 固定 RAIL_WIDTH 在其左,面板填剩余宽
  const [sidebarWidth, setSidebarWidth] = useState(240)
  const [isResizingSidebar, setIsResizingSidebar] = useState(false)
  const [floatVisible, setFloatVisible] = useState(false) // 浮窗默认隐藏
  const [isMaximized, setIsMaximized] = useState(false)
  const [quickCommandsRefreshKey, setQuickCommandsRefreshKey] = useState(0)  // 用于刷新 StatusBar
  const { sessions, loadSessions, refreshSavedSessions, syncSessionsFromBackend } = useSessionStore()
  const { getAllLeafPanes, layout, dshWebActive, dshWebPaneId } = usePaneStore()
  const { initFromStorage } = useThemeStore()
  const { initFromStorage: initLocaleFromStorage } = useLocaleStore()
  const { t } = useTranslation()
  const terminalWrapperRef = useRef<HTMLDivElement>(null)

  // 切换左列页签 -- 持久化到 localStorage(Alt+1/2/3 与页签轨点击共用)
  const handleNavChange = useCallback((tab: NavTab) => {
    setActiveNav(tab)
    try { localStorage.setItem('lyshell.navTab.v1', tab) } catch { /* quota */ }
  }, [])

  // 加载主题（index.html 已早期应用，这里仅同步 store 状态）
  useEffect(() => {
    initFromStorage()
  }, [initFromStorage])

  // 加载语言（lang-init.ts 已早期设 <html lang>，i18n.ts 已用 saved 初始化 lng；这里同步 store 状态供选择器显示）
  useEffect(() => {
    initLocaleFromStorage()
  }, [initLocaleFromStorage])

  // 一次性清理:RECENT 段已从会话面板删除并搬到浮窗,旧 localStorage key 是死数据
  // 几次启动后绝大多数客户端就清干净了;新装用户根本不会有这个 key,这段也会是 no-op
  // 注:recentCollapsed 存在 main 的 preferences.json(非 localStorage),清理它需要新增 IPC delete 通道,
  // 只为删一个 boolean 不值得 —— 残留几 bytes,忽略
  useEffect(() => {
    if (typeof localStorage === 'undefined') return
    localStorage.removeItem('lyshell.recents.v1')
  }, [])

  // 加载会话列表
  useEffect(() => {
    loadSessions()
  }, [loadSessions])

  // 全局监听终端数据，设置活动状态（用于标签高亮提示）
  useEffect(() => {
    if (!window.electronAPI) return

    const cleanup = window.electronAPI.onTerminalData((sessionId, _data) => {
      const { sessions, setSessionActivity } = useSessionStore.getState()
      const { getPaneBySessionId } = usePaneStore.getState()

      // 找到该会话所在的pane
      const pane = getPaneBySessionId(sessionId)
      if (pane && pane.type === 'leaf') {
        // 如果该会话不是该pane的活跃会话，设置活动状态
        if (pane.activeSessionId !== sessionId) {
          const session = sessions.find(s => s.id === sessionId)
          // 只有当前没有活动状态时才设置（避免频繁更新）
          if (session && !session.hasActivity) {
            setSessionActivity(sessionId, true)
          }
        }
      }
    })

    return cleanup
  }, [])

  // 监听会话状态变化并更新 store
  useEffect(() => {
    if (!window.electronAPI) return

    const cleanup = window.electronAPI.onConnectionStatus((data) => {
      const store = useSessionStore.getState()

      // 如果会话不在 store 中，检查状态
      const existingSession = store.sessions.find(s => s.id === data.id)
      if (!existingSession) {
        // 对于断开或错误状态的会话，不要重新添加（可能是用户关闭后被移除的临时会话）
        if (data.status === 'disconnected' || data.status === 'error') {
          return
        }

        // 从后端获取会话配置并添加（仅对于 connecting/connected 状态）
        window.electronAPI?.getSession(data.id).then(config => {
          if (config) {
            store.addTemporarySession({
              id: data.id,
              config,
              status: data.status,
              skipAutoAddToPane: false
            })

            // 立即添加到当前分屏（即使是 connecting 状态）
            const paneStore = usePaneStore.getState()
            const activePaneId = paneStore.layout.activePaneId
            if (activePaneId) {
              paneStore.addSessionToPane(activePaneId, data.id)
            }
          }
        })
        return
      }

      // 更新状态
      store.updateSessionStatus(data.id, data.status, data.error)

      // 当会话连接成功时，检查是否需要自动添加到分屏
      if (data.status === 'connected') {
        // 检查是否跳过自动添加
        if (existingSession.skipAutoAddToPane) {
          store.clearSkipAutoAddToPane(data.id)
          return  // 跳过自动添加，让克隆逻辑手动处理
        }

        // 检查会话是否已经在某个分屏中
        const paneStore = usePaneStore.getState()
        const allPanes = paneStore.getAllLeafPanes()
        const isInPane = allPanes.some(p => p.sessions.includes(data.id))

        if (!isInPane) {
          const activePaneId = paneStore.layout.activePaneId
          if (activePaneId) {
            paneStore.addSessionToPane(activePaneId, data.id)
          }
        }
      }
    })

    return cleanup
  }, [])

  // 启动时把当前已在终端页签中的会话同步给主进程（覆盖从 localStorage 恢复布局的场景）
  useEffect(() => {
    if (!window.electronAPI?.syncTerminalOpenSessions) return
    const ids = usePaneStore.getState().getAllOpenSessionIds()
    if (ids.length > 0) {
      window.electronAPI.syncTerminalOpenSessions(ids).catch((err: unknown) => {
        console.warn('Failed to sync initial terminal open sessions:', err)
      })
    }
  }, [])

  // MCP 占用/释放共享 PTY 时更新 store 锁定状态，TerminalView 据此阻塞用户输入
  useEffect(() => {
    if (!window.electronAPI?.onMcpSessionLocked) return
    const cleanupLock = window.electronAPI.onMcpSessionLocked(({ sessionId }) => {
      useSessionStore.getState().setSessionMcpLock(sessionId, true)
    })
    return cleanupLock
  }, [])

  useEffect(() => {
    if (!window.electronAPI?.onMcpSessionUnlocked) return
    const cleanupUnlock = window.electronAPI.onMcpSessionUnlocked(({ sessionId }) => {
      useSessionStore.getState().setSessionMcpLock(sessionId, false)
    })
    return cleanupUnlock
  }, [])

  // 订阅可达性探测结果
  useEffect(() => {
    if (!window.electronAPI?.onSessionReachable) return
    const cleanup = window.electronAPI.onSessionReachable((payload) => {
      useSessionStore.getState().updateReachability(payload.key, payload.reachable)
    })
    return cleanup
  }, [])

  // 外部路径（MCP 写入/创建）改动会话列表后，主进程推送 sessions:changed —— 增量同步，不重置连接状态
  useEffect(() => {
    if (!window.electronAPI?.onSessionsChanged) return
    const cleanup = window.electronAPI.onSessionsChanged(() => {
      syncSessionsFromBackend()
    })
    return cleanup
  }, [syncSessionsFromBackend])

  // 检查窗口是否最大化
  useEffect(() => {
    window.electronAPI?.isMaximized().then((maximized: boolean) => {
      setIsMaximized(maximized)
    })
  }, [])

  // 左列宽度:加载 / 防抖保存 / 拖动(rail RAIL_WIDTH 在左,面板宽 = clientX - RAIL_WIDTH)
  useEffect(() => {
    window.electronAPI?.getConfig('sidebarWidth').then((w: unknown) => {
      if (typeof w === 'number' && w > 0) setSidebarWidth(w)
    }).catch(() => {})
  }, [])
  useEffect(() => {
    const t = setTimeout(() => {
      window.electronAPI?.setConfig('sidebarWidth', sidebarWidth)
    }, 500)
    return () => clearTimeout(t)
  }, [sidebarWidth])
  useEffect(() => {
    if (!isResizingSidebar) return
    const handleMouseMove = (e: MouseEvent) => setSidebarWidth(Math.max(180, Math.min(400, e.clientX - RAIL_WIDTH)))
    const handleMouseUp = () => setIsResizingSidebar(false)
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizingSidebar])

  // Alt+1/2/3/4/5 切换左列页签(实现 footer 既有 "alt + 1…5" 提示;capture 抢在 xterm 前)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.altKey) return
      // 文本输入中不拦截(避免劫持 PluginPanel URL 输入等)
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      let tab: NavTab | null = null
      if (e.key === '1') tab = 'sessions'
      else if (e.key === '2') tab = 'agents'
      else if (e.key === '3') tab = 'dsh'
      else if (e.key === '4') tab = 'plugins'
      else if (e.key === '5') tab = 'settings'
      if (!tab) return
      e.preventDefault()
      e.stopPropagation()
      handleNavChange(tab)
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [handleNavChange])

  // 监听浮窗显示/隐藏快捷键
  useEffect(() => {
    if (!window.electronAPI) return
    const cleanup = window.electronAPI.onFloatToggle(() => {
      setFloatVisible(prev => !prev)
    })
    return cleanup
  }, [])

  // MCP open_connection_dialog 工具（C4）：主进程推送 → 派发 newSession 事件，
  // 由 SessionsPanel 监听并打开"新建连接"对话框。agent 把凭据填写交还给用户（MCP 通道不接受凭据）。
  useEffect(() => {
    if (!window.electronAPI?.onMcpOpenConnectionDialog) return
    const cleanup = window.electronAPI.onMcpOpenConnectionDialog(() => {
      window.dispatchEvent(new Event('newSession'))
    })
    return cleanup
  }, [])

  // 窗口控制
  const handleMinimize = () => {
    window.electronAPI?.minimizeWindow()
  }

  const handleMaximize = () => {
    window.electronAPI?.maximizeWindow().then((maximized: boolean) => {
      setIsMaximized(maximized)
    })
  }

  const handleClose = () => {
    window.electronAPI?.closeWindow()
  }

  // 打开 dsh Web UI：主进程 spawn `dsh web --port 0` 解析端口 → 拿到 URL 后写入 pane-store，
  // 由 PaneTabBar / PaneView 渲染成终端页签 + <webview> 覆盖层（对齐 MCP 活动页签模式，可像标签一样 ✕ 关闭）。
  // 失败把 error 回传给面板横幅展示（面板负责本地化兜底文案）。
  const handleOpenWeb = useCallback(async (ws: { id: string; name: string }) => {
    try {
      const res = await window.electronAPI?.openDshWeb(ws.id)
      if (!res || res.success === false) {
        return { success: false as const, error: res && typeof res.error === 'string' ? res.error : undefined }
      }
      const { openDshWebInPane, layout: paneLayout } = usePaneStore.getState()
      const info = { url: res.url as string, name: ws.name }
      openDshWebInPane(paneLayout.activePaneId, info)
      return { success: true as const }
    } catch (err) {
      console.error('dsh web open failed:', err)
      return { success: false as const, error: err instanceof Error ? err.message : undefined }
    }
  }, [])

  // 点击会话直接开启终端
  const handleConnect = async (_sessionId: string, config: SessionConfig) => {
    try {
      // 更新访问时间（仍用原 saved id）
      await window.electronAPI?.updateSession({
        ...config,
        updatedAt: new Date()
      })
      await refreshSavedSessions()

      // 每次点击 saved session 都创建新的 runtime 会话：
      // 把 id 置空让后端生成新 UUID，避免同一 saved id 只能对应一个终端页签。
      // 通过 originSavedSessionId 保留与原保存项的关联，供 MCP list_sessions 同步状态。
      const runtimeConfig: SessionConfig = { ...config, id: '', originSavedSessionId: config.id }

      // 调用后端连接（后端会立即返回 sessionId，前端显示终端）
      await window.electronAPI?.connect(runtimeConfig)
    } catch (error) {
      console.error('Connect failed:', error)
    }
  }

  // 执行快速命令 - 发送到活动分屏的活动会话
  const handleExecuteCommand = (content: string) => {
    const activePane = getAllLeafPanes().find(p => p.id === layout.activePaneId)
    if (activePane?.activeSessionId) {
      window.electronAPI?.terminalWrite(activePane.activeSessionId, content + '\r')
    }
  }

  // 获取活动分屏的活动会话ID用于状态栏
  const activePane = getAllLeafPanes().find(p => p.id === layout.activePaneId)
  const activeSessionIdForStatusBar = activePane?.activeSessionId || null
  // dsh web 仅在其承载分屏为当前活动分屏且正显示时，才接管底部状态栏（隐藏快捷命令）。
  // 否则即便 web 仍挂在别的分屏上，活动分屏是终端时快捷命令仍应指向该终端。
  const dshWebActiveHere = dshWebActive && dshWebPaneId === layout.activePaneId
  // 在线会话数 -- ActivityRail 的 sessions 槽位 LED 读数
  const liveCount = sessions.filter(s => s.status === 'connected').length

  return (
    <div className="flex flex-col h-screen bg-[var(--bg-base)] text-[var(--text-rack)] overflow-hidden">
      {/* 自定义标题栏 */}
      <div className="h-[28px] bg-[var(--bg-rack)] border-b border-[var(--rule)] flex items-center justify-between select-none relative" style={{ WebkitAppRegion: 'drag' } as any}>
        {/* 左侧按钮组 */}
        <div className="flex items-center gap-[2px] pl-1 relative" style={{ WebkitAppRegion: 'no-drag' } as any}>
          {/* 侧栏开关 — 自绘 SVG，左条 fill 状态映射侧栏开/关 */}
          <div
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            className="w-[24px] h-[24px] bg-[var(--bg-slot)] flex items-center justify-center rounded-[2px] hover:bg-[var(--bg-elev)] transition-colors cursor-pointer group"
            title={sidebarCollapsed ? t('settings.expandSidebar') : t('settings.collapseSidebar')}
          >
            <svg width="14" height="11" viewBox="0 0 14 11" fill="none"
              className="text-[var(--text-rack-mute)] group-hover:text-[var(--text-rack)] transition-colors">
              {/* 窗框 */}
              <rect x="0.5" y="0.5" width="13" height="10" stroke="currentColor" strokeWidth="1" />
              {/* 左侧条：开时实填，关时虚线 */}
              {sidebarCollapsed ? (
                <line x1="4.5" y1="0.5" x2="4.5" y2="10.5" stroke="currentColor" strokeWidth="1" strokeDasharray="1.5 1.5" />
              ) : (
                <rect x="0.5" y="0.5" width="4" height="10" fill="currentColor" />
              )}
            </svg>
          </div>

          {/* 标题 */}
          <span className="text-[10px] uppercase tracking-[.18em] text-[var(--text-rack)] px-2 font-mono font-semibold">lyshell</span>

        </div>

        {/* 右侧按钮组 — 应用控制 │ 系统窗口控制，两簇分隔 */}
        <div className="flex items-center pr-1" style={{ WebkitAppRegion: 'no-drag' } as any}>
          {/* 应用控制簇 */}
          <div className="flex items-center gap-[2px]">
            {/* MCP 活动状态片 -- 浮窗键左边；从设置页 MCP tab 提升出来，随时可达。
                圆点(amber=最近有活动/灰=空闲)+标签+记录条数，点击打开 MCP 活动面板(ESC 可关) */}
            <McpActivityChip />
            {/* 浮窗按钮 — 两矩形错位，PIP/分窗形态 */}
            <div
              onClick={() => setFloatVisible(!floatVisible)}
              className={cn(
                'w-[24px] h-[24px] flex items-center justify-center rounded-[2px] cursor-pointer group transition-colors',
                floatVisible
                  ? 'bg-[var(--bg-elev)]'
                  : 'bg-[var(--bg-slot)] hover:bg-[var(--bg-elev)]'
              )}
              title={t('settings.floatWindow')}
            >
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                <rect x="1" y="2.5" width="9" height="7" stroke="currentColor" strokeWidth="1.3"
                  className={cn(floatVisible ? 'text-[var(--amber)]' : 'text-[var(--text-rack-mute)] group-hover:text-[var(--text-rack)]', 'transition-colors')} />
                <rect x="5.5" y="6" width="7.5" height="6" fill="currentColor"
                  className={cn(floatVisible ? 'text-[var(--amber)]' : 'text-[var(--text-rack-mute)] group-hover:text-[var(--text-rack)]', 'transition-colors')} />
              </svg>
            </div>
          </div>

          {/* 簇分隔 hairline */}
          <span aria-hidden className="w-px h-[14px] bg-[var(--rule)] mx-1.5" />

          {/* 系统窗口控制簇 */}
          <div className="flex items-center gap-[2px]">
            {/* 缩小 */}
            <div
              onClick={handleMinimize}
              className="w-[24px] h-[24px] bg-[var(--bg-slot)] flex items-center justify-center rounded-[2px] hover:bg-[var(--bg-elev)] transition-colors cursor-pointer group"
              title={t('settings.minimize')}
            >
              <span className="text-[var(--text-rack-mute)] text-base leading-none group-hover:text-[var(--text-rack)] transition-colors">─</span>
            </div>
            {/* 放大 */}
            <div
              onClick={handleMaximize}
              className="w-[24px] h-[24px] bg-[var(--bg-slot)] flex items-center justify-center rounded-[2px] hover:bg-[var(--bg-elev)] transition-colors cursor-pointer group"
              title={isMaximized ? t('settings.restore') : t('settings.maximize')}
            >
              {isMaximized ? (
                <svg width="14" height="14" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <rect x="3" y="7" width="8" height="8" stroke="currentColor" strokeWidth="1.5" fill="none" className="text-[var(--text-rack-mute)] group-hover:text-[var(--text-rack)] transition-colors"/>
                  <path d="M7 3H15V11" stroke="currentColor" strokeWidth="1.5" fill="none" className="text-[var(--text-rack-mute)] group-hover:text-[var(--text-rack)] transition-colors"/>
                  <path d="M5 11V5H11" stroke="currentColor" strokeWidth="1.5" fill="none" className="text-[var(--text-rack-mute)] group-hover:text-[var(--text-rack)] transition-colors"/>
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <rect x="3" y="3" width="12" height="12" stroke="currentColor" strokeWidth="2" fill="none" className="text-[var(--text-rack-mute)] group-hover:text-[var(--text-rack)] transition-colors"/>
                </svg>
              )}
            </div>
            {/* 关闭 */}
            <div
              onClick={handleClose}
              className="w-[24px] h-[24px] bg-[var(--bg-slot)] flex items-center justify-center rounded-[2px] hover:bg-[var(--error-rack)] transition-colors cursor-pointer group"
              title={t('settings.close')}
            >
              <span className="text-[var(--text-rack-mute)] text-base leading-none group-hover:text-white transition-colors">✕</span>
            </div>
          </div>
        </div>
      </div>

      {/* 主内容区 */}
      <div className="flex flex-1 min-w-0 min-h-0 main-content">
        {/* 左列:机柜页签轨 + 面板 + 宽度调整条。sidebarCollapsed 时整列隐藏 */}
        {!sidebarCollapsed && (
          <>
            <ActivityRail active={activeNav} onChange={handleNavChange} liveCount={liveCount} />
            <div style={{ width: `${sidebarWidth}px` }} className="flex-shrink-0 min-w-0 h-full">
              {activeNav === 'sessions' && (
                <SessionsPanel
                  onConnect={handleConnect}
                  onQuickCommandsChange={() => setQuickCommandsRefreshKey(k => k + 1)}
                />
              )}
              {activeNav === 'agents' && <AgentsPanel />}
              {activeNav === 'dsh' && <DeepSeekHarnessPanel onOpenWeb={handleOpenWeb} />}
              {activeNav === 'plugins' && <PluginPanel />}
              {activeNav === 'settings' && <SettingsPanel />}
            </div>
            {/* 宽度调整条 */}
            <div
              className="w-[4px] bg-[var(--rule)] cursor-col-resize hover:bg-[var(--amber)] transition-colors flex-shrink-0 relative"
              onMouseDown={() => setIsResizingSidebar(true)}
            >
              <div
                className="absolute -left-[4px] top-0 bottom-0 w-[4px] cursor-col-resize"
                onMouseDown={() => setIsResizingSidebar(true)}
              />
            </div>
          </>
        )}

        {/* 终端内容区 */}
        <div className="flex flex-col flex-1 min-w-0 min-h-0">
          {/* 终端内容区 - 分屏布局 */}
          <div ref={terminalWrapperRef} className="terminal-wrapper flex-1 min-h-0 bg-[var(--terminal-bg)] overflow-hidden relative pb-0">
            <SplitPaneContainer />

            {/* 右上角会话浮窗 */}
            {floatVisible && (
              <div className="absolute top-[28px] right-[12px] z-50 w-[300px] h-[400px] bg-[var(--bg-slot)] border border-[var(--rule)] overflow-hidden shadow-lg">
                <FloatWindow onConnect={handleConnect} />
              </div>
            )}
          </div>

          {/* 状态栏：dsh web 激活时直接隐藏整条状态栏（含快捷命令），webview 占满剩余高度；否则维持终端快速命令栏 */}
          {!dshWebActiveHere && (
            <StatusBar sessionId={activeSessionIdForStatusBar} onExecuteCommand={handleExecuteCommand} refreshKey={quickCommandsRefreshKey} />
          )}
        </div>
      </div>

      {/* MCP 活动面板以页签形式挂在各分屏 PaneView 内，由 pane-store.mcpAuditPaneId 驱动 */}
    </div>
  )
}

export default MainWindow