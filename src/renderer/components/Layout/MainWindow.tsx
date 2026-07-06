import React, { useState, useEffect, useRef, useCallback } from 'react'
import cn from 'classnames'
import { useTranslation } from 'react-i18next'
import Sidebar from './Sidebar'
import StatusBar from './StatusBar'
import SplitPaneContainer from './SplitPaneContainer'
import FloatWindow from '../FloatWindow/FloatWindow'
import { McpAuditPanel } from './McpAuditPanel'
import { useSessionStore } from '../../stores/session-store'
import { usePaneStore } from '../../stores/pane-store'
import { useThemeStore, AVAILABLE_THEMES, CUSTOM_THEME_ID } from '../../stores/theme-store'
import { useLocaleStore, AVAILABLE_LOCALES } from '../../stores/locale-store'
import type { SessionConfig } from '@shared/types'
import { isCursorBlinkEnabled } from '@shared/constants'

/**
 * 主窗口布局组件
 */
const MainWindow: React.FC = () => {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [floatVisible, setFloatVisible] = useState(false) // 浮窗默认隐藏
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
  const [mcpSessionMetadataWrite, setMcpSessionMetadataWrite] = useState(false)
  // 破坏性命令确认默认开启（与后端 DEFAULT_MCP_SECURITY 一致）
  const [mcpConfirmDestructive, setMcpConfirmDestructive] = useState(true)
  // 复制 MCP 注册命令的瞬时反馈
  const [mcpCmdCopied, setMcpCmdCopied] = useState(false)
  // MCP 活动面板
  const [mcpAuditOpen, setMcpAuditOpen] = useState(false)
  // 设置面板页签 —— 'terminal' 默认;组件内 state,关闭再开回到上次页签(不持久化到磁盘)
  const [settingsTab, setSettingsTab] = useState<'terminal' | 'mcp'>('terminal')
  // 设置面板拖拽偏移 —— 持久化到 localStorage,关闭/重启都保留位置
  const [settingsOffset, setSettingsOffset] = useState(() => {
    try {
      const saved = localStorage.getItem('settingsPanelOffset')
      if (saved) {
        const parsed = JSON.parse(saved)
        if (typeof parsed.x === 'number' && typeof parsed.y === 'number') return parsed
      }
    } catch { /* 坏数据忽略,落到默认 */ }
    return { x: 0, y: 0 }
  })
  const settingsDragRef = useRef<{ startX: number; startY: number; offsetX: number; offsetY: number } | null>(null)
  const settingsPanelRef = useRef<HTMLDivElement>(null)
  const { loadSessions, refreshSavedSessions, syncSessionsFromBackend } = useSessionStore()
  const { getAllLeafPanes, layout } = usePaneStore()
  const { themeId, setTheme, customColors, setCustomColors, initFromStorage } = useThemeStore()
  const { localeId, setLocale, initFromStorage: initLocaleFromStorage } = useLocaleStore()
  const { t } = useTranslation()
  const terminalWrapperRef = useRef<HTMLDivElement>(null)

  // 加载主题（index.html 已早期应用，这里仅同步 store 状态）
  useEffect(() => {
    initFromStorage()
  }, [initFromStorage])

  // 加载语言（lang-init.ts 已早期设 <html lang>，i18n.ts 已用 saved 初始化 lng；这里同步 store 状态供选择器显示）
  useEffect(() => {
    initLocaleFromStorage()
  }, [initLocaleFromStorage])

  // 一次性清理:RECENT 段已从 Sidebar 删除并搬到浮窗,旧 localStorage key 是死数据
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

  // 设置面板打开时加载 MCP 安全开关
  useEffect(() => {
    if (!showSettings || !window.electronAPI) return
    const loadMcpSecurity = async () => {
      try {
        const rawSecurity = await window.electronAPI?.getConfig('security')
        if (rawSecurity && typeof rawSecurity === 'object') {
          const security = rawSecurity as Record<string, unknown>
          const mcp = security.mcp && typeof security.mcp === 'object'
            ? (security.mcp as Record<string, unknown>)
            : null
          if (mcp) {
            setMcpSessionMetadataWrite(mcp.allowSessionMetadataWrite === true)
            // confirmDestructiveCommands 默认 true：仅在显式 false 时关闭
            setMcpConfirmDestructive(mcp.confirmDestructiveCommands !== false)
          }
        }
      } catch (e) {
        console.warn('Failed to load MCP security settings:', e)
      }
    }
    loadMcpSecurity()
  }, [showSettings])

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

  // 监听浮窗显示/隐藏快捷键
  useEffect(() => {
    if (!window.electronAPI) return
    const cleanup = window.electronAPI.onFloatToggle(() => {
      setFloatVisible(prev => !prev)
    })
    return cleanup
  }, [])

  // MCP open_connection_dialog 工具（C4）：主进程推送 → 派发 newSession 事件，
  // 由 Sidebar 监听并打开"新建连接"对话框。agent 把凭据填写交还给用户（MCP 通道不接受凭据）。
  useEffect(() => {
    if (!window.electronAPI?.onMcpOpenConnectionDialog) return
    const cleanup = window.electronAPI.onMcpOpenConnectionDialog(() => {
      window.dispatchEvent(new Event('newSession'))
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

  // 把 offset 夹紧到视口内 —— 面板锚点 (left:0, top:28px),translate(x,y) 后整体必须仍可见。
  // 只读 refs / DOM 当下尺寸,无组件状态依赖,空 deps 让引用稳定供 effect 复用。
  const clampSettingsOffset = useCallback((x: number, y: number) => {
    const panel = settingsPanelRef.current
    // 守卫只为类型收窄,语义上调用者(拖拽 / rAF 后的 effect)都在面板挂载后才触发
    if (!panel) return { x, y }
    const { width, height } = panel.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    // panel 比视口大时,vw - width 会变负;Math.max 防止把"最大上界"拉到比"最小下界"(0 / -28)还小,
    // 退化时区间塌缩为单点,面板贴左/贴顶,不会继续被推走。
    const maxX = Math.max(0, vw - width)
    const maxY = Math.max(-28, vh - 28 - height)
    return {
      x: Math.max(0, Math.min(maxX, x)),
      y: Math.max(-28, Math.min(maxY, y)),
    }
  }, [])

  // 面板打开 / 窗口 resize 后兜底夹紧 —— 救援 localStorage 里历史脏数据,以及窗口缩到比面板小的场景
  useEffect(() => {
    if (!showSettings) return
    // 等浏览器把面板挂到 DOM,getBoundingClientRect 才有真值
    const raf = requestAnimationFrame(() => {
      setSettingsOffset(curr => {
        const clamped = clampSettingsOffset(curr.x, curr.y)
        if (clamped.x !== curr.x || clamped.y !== curr.y) {
          try { localStorage.setItem('settingsPanelOffset', JSON.stringify(clamped)) } catch { /* 忽略 */ }
        }
        return clamped
      })
    })
    const onResize = () => {
      setSettingsOffset(curr => clampSettingsOffset(curr.x, curr.y))
    }
    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
    }
  }, [showSettings, clampSettingsOffset])

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

  // 设置面板拖拽 —— pointer capture 让拖出头条区域也能继续追踪;关闭按钮通过 closest('button') 跳过避免误触
  const handleSettingsDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return
    e.currentTarget.setPointerCapture(e.pointerId)
    settingsDragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      offsetX: settingsOffset.x,
      offsetY: settingsOffset.y,
    }
  }

  const handleSettingsDragMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = settingsDragRef.current
    if (!drag) return
    const rawX = drag.offsetX + (e.clientX - drag.startX)
    const rawY = drag.offsetY + (e.clientY - drag.startY)
    setSettingsOffset(clampSettingsOffset(rawX, rawY))
  }

  const handleSettingsDragEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (settingsDragRef.current) {
      e.currentTarget.releasePointerCapture(e.pointerId)
      settingsDragRef.current = null
      // 落盘:函数式读 state 保最新值(setSettingsOffset 是异步的,直接读 settingsOffset 可能是旧值)
      setSettingsOffset(curr => {
        try { localStorage.setItem('settingsPanelOffset', JSON.stringify(curr)) } catch { /* 满盘忽略 */ }
        return curr
      })
    }
  }

  const handleCloseSettings = () => {
    setShowSettings(false)
  }

  // 重置面板位置 —— 拖到屏外救援用,双击头条触发
  const handleResetSettingsPosition = () => {
    setSettingsOffset({ x: 0, y: 0 })
    try { localStorage.removeItem('settingsPanelOffset') } catch { /* 忽略 */ }
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

          {/* 设置面板 —— 与 FloatWindow 同套"被召唤覆盖物"语言:amber 顶边线 + 双段式(strip 头 + elev 体) */}
          {/* 之前用 bg-slot 单段,与 bg-rack 标题栏只差 ~6 亮度,在影子被深色界面吃掉时几乎贴在标题栏上看不出 */}
          {/* shadow 用 color-mix(var(--bg-base)) 派生,carbon/slate/graphite 切换时影子调性也跟着变,不再是固定纯黑 */}
          {showSettings && (
            <div
              ref={settingsPanelRef}
              className="absolute top-[28px] left-0 z-50 bg-[var(--bg-elev)] border border-[var(--rule)] rounded-[2px] min-w-[280px] overflow-hidden"
              style={{
                transform: `translate(${settingsOffset.x}px, ${settingsOffset.y}px)`,
                boxShadow: '0 10px 28px color-mix(in srgb, var(--bg-base) 70%, transparent), 0 2px 6px color-mix(in srgb, var(--bg-base) 55%, transparent)'
              }}
            >
              {/* 顶边 amber 高亮 — 同 FloatWindow,标识"召出的焦点面板"(amber 跨主题不变,与 chrome 形成主题独立的 identity 信号) */}
              <div aria-hidden className="h-[2px] bg-[var(--amber)]" />
              {/* 头条:bg-strip 暗带 + amber 标题,与下方主体形成机柜两段式;同时作为拖拽把手(双击重置位置) */}
              <div
                onPointerDown={handleSettingsDragStart}
                onPointerMove={handleSettingsDragMove}
                onPointerUp={handleSettingsDragEnd}
                onPointerCancel={handleSettingsDragEnd}
                onDoubleClick={handleResetSettingsPosition}
                title={t('settings.dragToMove')}
                className="flex items-center justify-between px-3 h-[26px] bg-[var(--bg-strip)] border-b border-[var(--rule)] cursor-move select-none"
              >
                <span className="text-[12px] font-semibold text-[var(--amber)] font-mono">{t('settings.title')}</span>
                <button
                  onClick={handleCloseSettings}
                  className="w-[18px] h-[18px] flex items-center justify-center rounded-[2px] text-[var(--text-rack-mute)] hover:text-[var(--text-rack)] hover:bg-[var(--bg-slot)] text-xs leading-none transition-colors cursor-pointer"
                  title={t('settings.close')}
                >✕</button>
              </div>
              {/* 页签栏 —— bg-strip 续条;active 用 amber 底边线标识,与面板顶边 amber 信号呼应
                  (顶边=被召出的焦点面板,tab 底边=被选中的页签)。amber 跨主题不变,作主题独立的 identity 信号 */}
              <div className="flex bg-[var(--bg-strip)] border-b border-[var(--rule)]">
                {(['terminal', 'mcp'] as const).map(tab => {
                  const active = settingsTab === tab
                  return (
                    <button
                      key={tab}
                      onClick={() => setSettingsTab(tab)}
                      className={cn(
                        'relative flex-1 h-[26px] text-[12px] font-mono font-semibold transition-colors',
                        active ? 'text-[var(--amber)]' : 'text-[var(--text-rack-mute)] hover:text-[var(--text-rack)]'
                      )}
                    >
                      {tab === 'terminal' ? t('settings.tabTerminal') : t('settings.tabMcp')}
                      {/* amber 底边线 —— bottom-[-1px] 压住 strip 的 border-b,让选中页签"咬合"进下方主体,呼应机柜插卡意象 */}
                      {active && <span aria-hidden className="absolute inset-x-0 bottom-[-1px] h-[2px] bg-[var(--amber)]" />}
                    </button>
                  )
                })}
              </div>
              <div className="space-y-3 p-3">
                {settingsTab === 'terminal' && (<>
                <div className="flex items-center gap-2">
                  <span className="text-[12px] font-mono text-[var(--text-rack)] w-[64px]">{t('settings.buffer')}</span>
                  <input
                    type="number"
                    value={scrollbackLines}
                    onChange={(e) => {
                      const value = parseInt(e.target.value) || 1000
                      setScrollbackLines(value)
                      localStorage.setItem('terminalScrollback', value.toString())
                    }}
                    className="w-[80px] px-2 py-1 bg-[var(--bg-slot)] border border-[var(--rule)] rounded-[2px] text-[12px] font-mono text-[var(--text-rack)] focus:outline-none focus:border-[var(--amber)]"
                    min={1000}
                    max={100000}
                    step={1000}
                  />
                  <span className="text-[11px] text-[var(--text-rack-data)] font-mono">{t('settings.lines')}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[12px] font-mono text-[var(--text-rack)] w-[64px]">{t('settings.font')}</span>
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
                    className="w-[80px] px-2 py-1 bg-[var(--bg-slot)] border border-[var(--rule)] rounded-[2px] text-[12px] font-mono text-[var(--text-rack)] focus:outline-none focus:border-[var(--amber)]"
                    min={8}
                    max={32}
                    step={1}
                  />
                  <span className="text-[11px] text-[var(--text-rack-data)] font-mono">{t('settings.px')}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[12px] font-mono text-[var(--text-rack)] w-[64px]">{t('settings.cursor')}</span>
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
                  {/* blink on/off 是该行的值(等价 input 的数值),不是单位 —— 提到 text-rack-data + 11px,跟 lines/px 那种纯单位拉开层级 */}
                  <span className={cn(
                    'text-[12px] font-mono',
                    cursorBlink ? 'text-[var(--amber)]' : 'text-[var(--text-rack-data)]'
                  )}>{cursorBlink ? t('settings.blinkOn') : t('settings.blinkOff')}</span>
                </div>

                {/* 主题 ——— 三个 rack 槽位，每行用自己主题的真实色铺底 */}
                <div className="border-t border-[var(--rule)] pt-2 mt-2">
                  <div className="flex items-baseline justify-between mb-1.5">
                    <span className="text-[12px] font-mono text-[var(--text-rack)]">{t('settings.theme')}</span>
                    <span className="text-[11px] font-mono text-[var(--text-rack-data)] truncate ml-2">
                      {AVAILABLE_THEMES.find(t => t.id === themeId)?.name}
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
                              'text-[13px] font-semibold font-mono truncate pl-1',
                              active && 'text-[var(--amber)]'
                            )}
                            style={!active ? { color: t.preview.text } : undefined}
                          >
                            {t.name}
                          </span>

                          {/* hex — 用本主题 bg-rack 的真值，遥测语言 */}
                          <span
                            className="text-[10.5px] font-mono tracking-[.04em] tabular-nums"
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

                  {/* Custom 主题色 picker —— 只有 themeId === rack-custom 时展开,
                      两个 native color input 直接驱动 store.setCustomColors,store 内部已处理实时注入 */}
                  {themeId === CUSTOM_THEME_ID && (
                    <div className="mt-1.5 border border-[var(--rule)] rounded-[2px] bg-[var(--bg-rack)] divide-y divide-[var(--rule-soft)]">
                      {/* Base */}
                      <div className="flex items-center gap-2 px-2 h-[26px]">
                        <span className="text-[11px] font-mono text-[var(--text-rack-data)] w-[44px]">Base</span>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="color"
                            value={customColors.base}
                            onChange={(e) => setCustomColors({ base: e.target.value.toUpperCase() })}
                            className="w-[18px] h-[18px] cursor-pointer border-0 bg-transparent p-0"
                            title={t('settings.pickBaseColor')}
                          />
                        </label>
                        <span className="text-[11px] font-mono text-[var(--text-rack-mute)] tabular-nums">
                          {customColors.base.toLowerCase()}
                        </span>
                      </div>
                      {/* Accent */}
                      <div className="flex items-center gap-2 px-2 h-[26px]">
                        <span className="text-[11px] font-mono text-[var(--text-rack-data)] w-[44px]">Accent</span>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="color"
                            value={customColors.accent}
                            onChange={(e) => setCustomColors({ accent: e.target.value.toUpperCase() })}
                            className="w-[18px] h-[18px] cursor-pointer border-0 bg-transparent p-0"
                            title={t('settings.pickAccentColor')}
                          />
                        </label>
                        <span className="text-[11px] font-mono text-[var(--text-rack-mute)] tabular-nums">
                          {customColors.accent.toLowerCase()}
                        </span>
                      </div>
                    </div>
                  )}
                </div>

                {/* 语言 —— 镜像 Theme 段布局：border-t 分隔 + 标题行 + locale 按钮列表 */}
                <div className="border-t border-[var(--rule)] pt-2 mt-2">
                  <div className="flex items-baseline justify-between mb-1.5">
                    <span className="text-[12px] font-mono text-[var(--text-rack)]">{t('settings.language')}</span>
                    <span className="text-[11px] font-mono text-[var(--text-rack-data)] truncate ml-2">
                      {AVAILABLE_LOCALES.find(l => l.id === localeId)?.name}
                    </span>
                  </div>
                  <div className="border border-[var(--rule)] rounded-[2px] overflow-hidden divide-y divide-[var(--rule-soft)]">
                    {AVAILABLE_LOCALES.map(l => {
                      const active = localeId === l.id
                      return (
                        <button
                          key={l.id}
                          onClick={() => setLocale(l.id)}
                          className={cn(
                            'group relative w-full grid items-center gap-2 h-[30px] pr-2 text-left transition-[filter] duration-150',
                            'grid-cols-[3px_1fr]',
                            !active && 'hover:brightness-110'
                          )}
                        >
                          {/* 3px 左条 — active=amber, idle=透明留位 */}
                          <span
                            aria-hidden
                            className="h-full"
                            style={{ backgroundColor: active ? 'var(--amber)' : 'transparent' }}
                          />
                          {/* name 用目标语言自身书写，不翻译 */}
                          <span
                            className={cn(
                              'text-[13px] font-semibold font-mono truncate pl-1',
                              active ? 'text-[var(--amber)]' : 'text-[var(--text-rack)]'
                            )}
                          >
                            {l.name}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>

                {/* 下载路径 */}
                <div className="border-t border-[var(--rule)] pt-2 mt-2">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[12px] font-mono text-[var(--text-rack)] w-[64px]">{t('settings.download')}</span>
                    <div
                      onClick={handleSelectDownloadDir}
                      className="flex-1 px-2 py-1 bg-[var(--bg-slot)] border border-[var(--rule)] rounded-[2px] text-[12px] font-mono text-[var(--text-rack)] cursor-pointer hover:border-[var(--amber)] truncate transition-colors"
                      title={downloadDir || t('settings.clickToSelect')}
                    >
                      {downloadDir || t('settings.clickToChoose')}
                    </div>
                    <button
                      onClick={() => downloadDir && window.electronAPI?.openFolder(downloadDir)}
                      disabled={!downloadDir}
                      className={cn(
                        'w-[26px] h-[26px] rounded-[2px] text-xs border flex items-center justify-center transition-colors',
                        downloadDir
                          ? 'bg-[var(--bg-slot)] border-[var(--rule)] text-[var(--text-rack-data)] hover:border-[var(--amber)] hover:text-[var(--amber)]'
                          : 'bg-[var(--bg-slot)] border-[var(--rule)] text-[var(--text-rack-faint)] cursor-not-allowed'
                      )}
                      title={t('settings.openFolder')}
                    >
                      📂
                    </button>
                  </div>
                  <p className="text-[11px] text-[var(--text-rack-mute)] font-mono">{t('settings.defaultSavePath')}</p>
                </div>

                {/* 字号/缓冲/光标生效说明 —— 终端页脚(原面板底部 hint,随终端页签归属) */}
                <p className="text-[11px] text-[var(--text-rack-mute)] border-t border-[var(--rule)] pt-2 mt-2 font-mono leading-relaxed">
                  {t('settings.applyHint')}
                </p>
                </>)}
                {settingsTab === 'mcp' && (<>
                {/* MCP 会话元数据写入开关 —— 页签内首块,去掉 border-t/mt-2(无需与上方分隔) */}
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <input
                      id="mcp-session-metadata-write"
                      type="checkbox"
                      checked={mcpSessionMetadataWrite}
                      onChange={async (e) => {
                        const checked = e.target.checked
                        setMcpSessionMetadataWrite(checked)
                        try {
                          const rawSecurity = await window.electronAPI?.getConfig('security')
                          const security = rawSecurity && typeof rawSecurity === 'object'
                            ? (rawSecurity as Record<string, unknown>)
                            : {}
                          const existingMcp =
                            security.mcp && typeof security.mcp === 'object'
                              ? (security.mcp as Record<string, unknown>)
                              : {}
                          await window.electronAPI?.setConfig('security', {
                            ...security,
                            mcp: {
                              ...existingMcp,
                              allowSessionMetadataWrite: checked
                            }
                          })
                        } catch (err) {
                          console.warn('Failed to save MCP security setting:', err)
                        }
                      }}
                      className="w-3.5 h-3.5 accent-[var(--amber)]"
                    />
                    <label
                      htmlFor="mcp-session-metadata-write"
                      className="text-[12px] font-mono text-[var(--text-rack)] cursor-pointer"
                    >
                      {t('settings.mcpSessionMetadataWrite')}
                    </label>
                  </div>
                  <p className="text-[11px] text-[var(--text-rack-mute)] font-mono">
                    {t('settings.mcpSessionMetadataWriteHint')}
                  </p>
                </div>

                {/* MCP 破坏性命令确认开关 */}
                <div className="border-t border-[var(--rule)] pt-2 mt-2">
                  <div className="flex items-center gap-2 mb-1">
                    <input
                      id="mcp-confirm-destructive"
                      type="checkbox"
                      checked={mcpConfirmDestructive}
                      onChange={async (e) => {
                        const checked = e.target.checked
                        setMcpConfirmDestructive(checked)
                        try {
                          const rawSecurity = await window.electronAPI?.getConfig('security')
                          const security = rawSecurity && typeof rawSecurity === 'object'
                            ? (rawSecurity as Record<string, unknown>)
                            : {}
                          const existingMcp =
                            security.mcp && typeof security.mcp === 'object'
                              ? (security.mcp as Record<string, unknown>)
                              : {}
                          await window.electronAPI?.setConfig('security', {
                            ...security,
                            mcp: {
                              ...existingMcp,
                              confirmDestructiveCommands: checked
                            }
                          })
                        } catch (err) {
                          console.warn('Failed to save MCP security setting:', err)
                        }
                      }}
                      className="w-3.5 h-3.5 accent-[var(--amber)]"
                    />
                    <label
                      htmlFor="mcp-confirm-destructive"
                      className="text-[12px] font-mono text-[var(--text-rack)] cursor-pointer"
                    >
                      {t('settings.mcpConfirmDestructive')}
                    </label>
                  </div>
                  <p className="text-[11px] text-[var(--text-rack-mute)] font-mono">
                    {t('settings.mcpConfirmDestructiveHint')}
                  </p>
                </div>

                {/* MCP 注册命令复制 */}
                <div className="border-t border-[var(--rule)] pt-2 mt-2">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[12px] font-mono text-[var(--text-rack)] w-[64px]">
                      {t('settings.mcpRegister')}
                    </span>
                    <button
                      onClick={async () => {
                        try {
                          const info = await window.electronAPI?.getMcpAddCommand()
                          if (info?.command) {
                            await navigator.clipboard.writeText(info.command)
                            setMcpCmdCopied(true)
                            setTimeout(() => setMcpCmdCopied(false), 2000)
                          }
                        } catch (err) {
                          console.warn('Failed to copy MCP add command:', err)
                        }
                      }}
                      className={cn(
                        'px-2 py-1 rounded-[2px] text-[12px] font-mono border transition-colors',
                        mcpCmdCopied
                          ? 'bg-[var(--amber)] border-[var(--amber)] text-[var(--bg-rack)]'
                          : 'bg-[var(--bg-slot)] border-[var(--rule)] text-[var(--text-rack)] hover:border-[var(--amber)] hover:text-[var(--amber)]'
                      )}
                    >
                      {mcpCmdCopied ? t('settings.mcpRegisterCopied') : t('settings.mcpRegisterCopy')}
                    </button>
                    <button
                      onClick={() => setMcpAuditOpen(true)}
                      className="px-2 py-1 rounded-[2px] text-[12px] font-mono border bg-[var(--bg-slot)] border-[var(--rule)] text-[var(--text-rack)] hover:border-[var(--amber)] hover:text-[var(--amber)]"
                    >
                      {t('settings.mcpAudit')}
                    </button>
                  </div>
                  <p className="text-[11px] text-[var(--text-rack-mute)] font-mono">
                    {t('settings.mcpRegisterHint')}
                  </p>
                </div>
                </>)}
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
              title={t('settings.floatWindow')}
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
              title={t('settings.title')}
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
            {floatVisible && (
              <div className="absolute top-[28px] right-[12px] z-50 w-[300px] h-[400px] bg-[var(--bg-slot)] border border-[var(--rule)] overflow-hidden shadow-lg">
                <FloatWindow onConnect={handleConnect} />
              </div>
            )}
          </div>

          {/* 状态栏 */}
          <StatusBar sessionId={activeSessionIdForStatusBar} onExecuteCommand={handleExecuteCommand} refreshKey={quickCommandsRefreshKey} />
        </div>
      </div>

      {/* MCP 活动面板（模态） */}
      <McpAuditPanel open={mcpAuditOpen} onClose={() => setMcpAuditOpen(false)} />
    </div>
  )
}

export default MainWindow