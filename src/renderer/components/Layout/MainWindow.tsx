import React, { useState, useEffect, useRef } from 'react'
import cn from 'classnames'
import Sidebar from './Sidebar'
import StatusBar from './StatusBar'
import SplitPaneContainer from './SplitPaneContainer'
import FloatWindow from '../FloatWindow/FloatWindow'
import { useSessionStore } from '../../stores/session-store'
import { usePaneStore } from '../../stores/pane-store'
import { useThemeStore, AVAILABLE_THEMES } from '../../stores/theme-store'
import type { SessionConfig } from '@shared/types'
import { isCursorBlinkEnabled } from '@shared/constants'

/**
 * 主窗口布局组件
 */
const MainWindow: React.FC = () => {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [floatVisible, setFloatVisible] = useState(false) // 浮窗默认隐藏
  const [floatCollapsed, setFloatCollapsed] = useState(false) // 浮窗缩小状态
  const [isMaximized, setIsMaximized] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [quickCommandsRefreshKey, setQuickCommandsRefreshKey] = useState(0)  // 用于刷新 StatusBar
  const [scrollbackLines, setScrollbackLines] = useState(() => {
    const saved = localStorage.getItem('terminalScrollback')
    return saved ? parseInt(saved) : 10000
  })
  const [fontSize, setFontSize] = useState(() => {
    const saved = localStorage.getItem('terminalFontSize')
    return saved ? parseInt(saved) : 16
  })
  const [cursorBlink, setCursorBlink] = useState(() => isCursorBlinkEnabled())
  const [downloadDir, setDownloadDir] = useState('')
  const { loadSessions, refreshSavedSessions } = useSessionStore()
  const { getAllLeafPanes, layout } = usePaneStore()
  const { themeId, setTheme, initFromStorage } = useThemeStore()
  const terminalWrapperRef = useRef<HTMLDivElement>(null)

  // 加载主题（index.html 已早期应用，这里仅同步 store 状态）
  useEffect(() => {
    initFromStorage()
  }, [initFromStorage])

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

  // 加载下载配置
  useEffect(() => {
    const loadDownloadConfig = async () => {
      try {
        const result = await window.electronAPI?.getDownloadConfig()
        if (result?.success && result.data?.defaultDir) {
          setDownloadDir(result.data.defaultDir)
        }
      } catch (e) {
        console.warn('Failed to load download config:', e)
      }
    }
    loadDownloadConfig()
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

  // 订阅可达性探测结果
  useEffect(() => {
    if (!window.electronAPI?.onSessionReachable) return
    const cleanup = window.electronAPI.onSessionReachable((payload) => {
      useSessionStore.getState().updateReachability(payload.key, payload.reachable)
    })
    return cleanup
  }, [])

  // 检查窗口是否最大化
  useEffect(() => {
    window.electronAPI?.isMaximized().then((maximized: boolean) => {
      setIsMaximized(maximized)
    })
  }, [])

  // 监听浮窗显示/隐藏快捷键
  useEffect(() => {
    if (!window.electronAPI) return
    const cleanup = window.electronAPI.onFloatToggle(() => {
      console.log('Float toggle event received')
      setFloatVisible(prev => {
        console.log('Setting floatVisible to:', !prev)
        return !prev
      })
    })
    return cleanup
  }, [])

  // ESC 键关闭设置面板
  useEffect(() => {
    if (!showSettings) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowSettings(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [showSettings])

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

  // 选择下载目录（使用系统目录选择器）
  const handleSelectDownloadDir = async () => {
    const result = await window.electronAPI?.selectDirectory()
    if (result) {
      setDownloadDir(result)
      await window.electronAPI?.setDownloadConfig({ defaultDir: result })
    }
  }

  // 点击会话直接开启终端
  const handleConnect = async (_sessionId: string, config: SessionConfig) => {
    try {
      // 更新访问时间
      await window.electronAPI?.updateSession({
        ...config,
        updatedAt: new Date()
      })
      await refreshSavedSessions()

      // 调用后端连接（后端会立即返回 sessionId，前端显示终端）
      await window.electronAPI?.connect({
        ...config,
        id: '' // 后端会自动处理
      })
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
            title={sidebarCollapsed ? '展开会话栏' : '折叠会话栏'}
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

          {/* 设置面板 */}
          {showSettings && (
            <div className="absolute top-[28px] left-0 z-50 bg-[var(--bg-slot)] border border-[var(--rule)] rounded-[2px] shadow-lg p-3 min-w-[260px]">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] uppercase tracking-[.16em] font-semibold text-[var(--text-rack)]">terminal · settings</span>
                <button onClick={() => setShowSettings(false)} className="text-[var(--text-rack-mute)] hover:text-[var(--text-rack)] text-sm leading-none">✕</button>
              </div>
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] uppercase tracking-[.1em] text-[var(--text-rack-mute)] w-[60px]">缓冲区</span>
                  <input
                    type="number"
                    value={scrollbackLines}
                    onChange={(e) => {
                      const value = parseInt(e.target.value) || 1000
                      setScrollbackLines(value)
                      localStorage.setItem('terminalScrollback', value.toString())
                    }}
                    className="w-[80px] px-2 py-1 bg-[var(--bg-elev)] border border-[var(--rule)] rounded-[2px] text-[11px] font-mono text-[var(--text-rack)] focus:outline-none focus:border-[var(--amber)]"
                    min={1000}
                    max={100000}
                    step={1000}
                  />
                  <span className="text-[10px] text-[var(--text-rack-faint)] font-mono">lines</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] uppercase tracking-[.1em] text-[var(--text-rack-mute)] w-[60px]">字体</span>
                  <input
                    type="number"
                    value={fontSize}
                    onChange={(e) => {
                      const value = parseInt(e.target.value) || 12
                      const clampedValue = Math.max(8, Math.min(32, value))
                      setFontSize(clampedValue)
                      localStorage.setItem('terminalFontSize', clampedValue.toString())
                      window.dispatchEvent(new CustomEvent('terminalFontSizeChanged', { detail: clampedValue }))
                    }}
                    className="w-[80px] px-2 py-1 bg-[var(--bg-elev)] border border-[var(--rule)] rounded-[2px] text-[11px] font-mono text-[var(--text-rack)] focus:outline-none focus:border-[var(--amber)]"
                    min={8}
                    max={32}
                    step={1}
                  />
                  <span className="text-[10px] text-[var(--text-rack-faint)] font-mono">px</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] uppercase tracking-[.1em] text-[var(--text-rack-mute)] w-[60px]">光标</span>
                  <input
                    type="checkbox"
                    checked={cursorBlink}
                    onChange={(e) => {
                      setCursorBlink(e.target.checked)
                      localStorage.setItem('terminalCursorBlink', e.target.checked.toString())
                      window.dispatchEvent(new CustomEvent('terminalCursorBlinkChanged', { detail: e.target.checked }))
                    }}
                    className="w-3.5 h-3.5 accent-[var(--amber)]"
                  />
                  <span className="text-[10px] text-[var(--text-rack-faint)] font-mono uppercase tracking-[.08em]">{cursorBlink ? 'blink on' : 'blink off'}</span>
                </div>

                {/* 主题 ——— 三个 rack 槽位，每行用自己主题的真实色铺底 */}
                <div className="border-t border-[var(--rule)] pt-2 mt-2">
                  <div className="flex items-baseline justify-between mb-1.5">
                    <span className="text-[10px] uppercase tracking-[.1em] text-[var(--text-rack-mute)]">主题</span>
                    <span className="text-[9px] uppercase tracking-[.08em] font-mono text-[var(--text-rack-faint)] truncate ml-2">
                      {AVAILABLE_THEMES.find(t => t.id === themeId)?.name.toLowerCase()}
                    </span>
                  </div>
                  <div className="border border-[var(--rule)] rounded-[2px] overflow-hidden divide-y divide-[var(--rule-soft)]">
                    {AVAILABLE_THEMES.map(t => {
                      const active = themeId === t.id
                      return (
                        <button
                          key={t.id}
                          onClick={() => setTheme(t.id)}
                          title={t.description}
                          className={cn(
                            'group relative w-full grid items-center gap-2 h-[30px] pr-2 text-left transition-[filter] duration-150',
                            'grid-cols-[3px_1fr_auto_14px]',
                            !active && 'hover:brightness-110'
                          )}
                          style={{ backgroundColor: t.preview.bgRack, color: t.preview.text }}
                        >
                          {/* 3px 左条 — active=amber, idle=本主题 bg-slot（隐形但留位） */}
                          <span
                            aria-hidden
                            className="h-full"
                            style={{ backgroundColor: active ? 'var(--amber)' : t.preview.bgSlot }}
                          />

                          {/* 名 */}
                          <span
                            className={cn(
                              'text-[11px] font-semibold uppercase tracking-[.14em] truncate pl-1',
                              active && 'text-[var(--amber)]'
                            )}
                            style={!active ? { color: t.preview.text } : undefined}
                          >
                            {t.name}
                          </span>

                          {/* hex — 用本主题 bg-rack 的真值，遥测语言 */}
                          <span
                            className="text-[9.5px] font-mono tracking-[.04em] tabular-nums"
                            style={{ color: active ? 'var(--amber)' : `${t.preview.text}66` }}
                          >
                            {t.preview.bgRack.toLowerCase()}
                          </span>

                          {/* chrome 三阶塔（迷你机柜灯） */}
                          <span
                            aria-hidden
                            className="flex flex-col h-[18px] w-[5px] border border-[var(--bg-base)]"
                            style={{ borderColor: t.preview.bgBase }}
                          >
                            <span className="flex-1" style={{ backgroundColor: t.preview.bgBase }} />
                            <span className="flex-1" style={{ backgroundColor: t.preview.bgRack }} />
                            <span className="flex-1" style={{ backgroundColor: t.preview.bgSlot }} />
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>

                {/* 下载路径 */}
                <div className="border-t border-[var(--rule)] pt-2 mt-2">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px] uppercase tracking-[.1em] text-[var(--text-rack-mute)] w-[60px]">下载</span>
                    <div
                      onClick={handleSelectDownloadDir}
                      className="flex-1 px-2 py-1 bg-[var(--bg-elev)] border border-[var(--rule)] rounded-[2px] text-[11px] font-mono text-[var(--text-rack)] cursor-pointer hover:border-[var(--amber)] truncate transition-colors"
                      title={downloadDir || '点击选择'}
                    >
                      {downloadDir || '点击选择目录'}
                    </div>
                    <button
                      onClick={() => downloadDir && window.electronAPI?.openFolder(downloadDir)}
                      disabled={!downloadDir}
                      className={cn(
                        'w-[26px] h-[26px] rounded-[2px] text-xs border flex items-center justify-center transition-colors',
                        downloadDir
                          ? 'bg-[var(--bg-elev)] border-[var(--rule)] text-[var(--text-rack-data)] hover:border-[var(--amber)] hover:text-[var(--amber)]'
                          : 'bg-[var(--bg-elev)] border-[var(--rule)] text-[var(--text-rack-faint)] cursor-not-allowed'
                      )}
                      title="打开文件夹"
                    >
                      📂
                    </button>
                  </div>
                  <p className="text-[10px] text-[var(--text-rack-faint)] font-mono">default save path</p>
                </div>

                <p className="text-[10px] text-[var(--text-rack-faint)] border-t border-[var(--rule)] pt-2 mt-2 font-mono leading-relaxed">
                  font size applies live · buffer + cursor apply to new sessions
                </p>
              </div>
            </div>
          )}
        </div>

        {/* 右侧按钮组 — 应用控制 │ 系统窗口控制，两簇分隔 */}
        <div className="flex items-center pr-1" style={{ WebkitAppRegion: 'no-drag' } as any}>
          {/* 应用控制簇 */}
          <div className="flex items-center gap-[2px]">
            {/* 浮窗按钮 — 两矩形错位，PIP/分窗形态 */}
            <div
              onClick={() => setFloatVisible(!floatVisible)}
              className={cn(
                'w-[24px] h-[24px] flex items-center justify-center rounded-[2px] cursor-pointer group transition-colors',
                floatVisible
                  ? 'bg-[var(--bg-elev)]'
                  : 'bg-[var(--bg-slot)] hover:bg-[var(--bg-elev)]'
              )}
              title="会话浮窗"
            >
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                <rect x="1" y="2.5" width="9" height="7" stroke="currentColor" strokeWidth="1.3"
                  className={cn(floatVisible ? 'text-[var(--amber)]' : 'text-[var(--text-rack-mute)] group-hover:text-[var(--text-rack)]', 'transition-colors')} />
                <rect x="5.5" y="6" width="7.5" height="6" fill="currentColor"
                  className={cn(floatVisible ? 'text-[var(--amber)]' : 'text-[var(--text-rack-mute)] group-hover:text-[var(--text-rack)]', 'transition-colors')} />
              </svg>
            </div>
            {/* 设置按钮 */}
            <div
              onClick={() => setShowSettings(!showSettings)}
              className={cn(
                'w-[24px] h-[24px] flex items-center justify-center rounded-[2px] cursor-pointer group transition-colors',
                showSettings
                  ? 'bg-[var(--bg-elev)]'
                  : 'bg-[var(--bg-slot)] hover:bg-[var(--bg-elev)]'
              )}
              title="终端设置"
            >
              <span className={cn(
                'text-xs transition-colors',
                showSettings ? 'text-[var(--amber)]' : 'text-[var(--text-rack-mute)] group-hover:text-[var(--text-rack)]'
              )}>⚙</span>
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
              title="最小化"
            >
              <span className="text-[var(--text-rack-mute)] text-base leading-none group-hover:text-[var(--text-rack)] transition-colors">─</span>
            </div>
            {/* 放大 */}
            <div
              onClick={handleMaximize}
              className="w-[24px] h-[24px] bg-[var(--bg-slot)] flex items-center justify-center rounded-[2px] hover:bg-[var(--bg-elev)] transition-colors cursor-pointer group"
              title={isMaximized ? '还原' : '最大化'}
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
              title="关闭"
            >
              <span className="text-[var(--text-rack-mute)] text-base leading-none group-hover:text-white transition-colors">✕</span>
            </div>
          </div>
        </div>
      </div>

      {/* 主内容区 */}
      <div className="flex flex-1 min-w-0 min-h-0 main-content">
        {/* 侧边栏 */}
        <Sidebar
          collapsed={sidebarCollapsed}
          onToggle={() => setSidebarCollapsed(!sidebarCollapsed)}
          onConnect={handleConnect}
          onQuickCommandsChange={() => setQuickCommandsRefreshKey(k => k + 1)}
        />

        {/* 终端内容区 */}
        <div className="flex flex-col flex-1 min-w-0 min-h-0">
          {/* 终端内容区 - 分屏布局 */}
          <div ref={terminalWrapperRef} className="terminal-wrapper flex-1 min-h-0 bg-[#0C0C0C] overflow-hidden relative pl-1 pb-0">
            <SplitPaneContainer />

            {/* 右上角会话浮窗 */}
            {floatVisible && !floatCollapsed && (
              <div className="absolute top-[28px] right-[12px] z-50 w-[300px] h-[400px] bg-[var(--bg-slot)] border border-[var(--rule)] overflow-hidden shadow-lg">
                <FloatWindow onConnect={handleConnect} onCollapse={() => setFloatCollapsed(true)} />
              </div>
            )}

            {/* 浮窗缩小状态 - 右上角小图标 */}
            {floatVisible && floatCollapsed && (
              <div
                onClick={() => setFloatCollapsed(false)}
                className="absolute top-[32px] right-[12px] z-50 cursor-pointer group"
                title="展开浮窗"
              >
                <div className="w-[12px] h-[48px] bg-[var(--bg-slot)] flex items-center justify-center shadow-sm group-hover:bg-[var(--bg-elev)] transition-colors">
                  <span className="text-[var(--text-rack-mute)] text-xs group-hover:text-[var(--text-rack)] transition-colors">▶</span>
                </div>
              </div>
            )}
          </div>

          {/* 状态栏 */}
          <StatusBar sessionId={activeSessionIdForStatusBar} onExecuteCommand={handleExecuteCommand} refreshKey={quickCommandsRefreshKey} />
        </div>
      </div>
    </div>
  )
}

export default MainWindow