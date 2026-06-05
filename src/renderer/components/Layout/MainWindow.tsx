import React, { useState, useEffect, useRef } from 'react'
import Sidebar from './Sidebar'
import StatusBar from './StatusBar'
import SplitPaneContainer from './SplitPaneContainer'
import FloatWindow from '../FloatWindow/FloatWindow'
import { useSessionStore } from '../../stores/session-store'
import { usePaneStore } from '../../stores/pane-store'
import type { SessionConfig } from '@shared/types'

/**
 * 主窗口布局组件
 */
const MainWindow: React.FC = () => {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [floatVisible, setFloatVisible] = useState(false) // 浮窗默认隐藏
  const [floatCollapsed, setFloatCollapsed] = useState(false) // 浮窗缩小状态
  const [isMaximized, setIsMaximized] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [scrollbackLines, setScrollbackLines] = useState(() => {
    const saved = localStorage.getItem('terminalScrollback')
    return saved ? parseInt(saved) : 10000
  })
  const [fontSize, setFontSize] = useState(() => {
    const saved = localStorage.getItem('terminalFontSize')
    return saved ? parseInt(saved) : 16
  })
  const [cursorBlink, setCursorBlink] = useState(() => {
    const saved = localStorage.getItem('terminalCursorBlink')
    return saved !== 'false'  // 默认开启
  })
  const [downloadDir, setDownloadDir] = useState('')
  const { loadSessions, refreshSavedSessions } = useSessionStore()
  const { getAllLeafPanes, layout } = usePaneStore()
  const terminalWrapperRef = useRef<HTMLDivElement>(null)

  // 加载会话列表
  useEffect(() => {
    loadSessions()
  }, [loadSessions])

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

    const cleanup = window.electronAPI.onConnectionStatus((_event, data) => {
      const store = useSessionStore.getState()

      // 如果会话不在 store 中，添加它
      const existingSession = store.sessions.find(s => s.id === data.id)
      if (!existingSession) {
        // 从后端获取会话配置并添加
        window.electronAPI?.getSession(data.id).then(config => {
          if (config) {
            // 不跳过自动添加，让所有会话都能显示在分屏中
            // PaneTabBar 的克隆逻辑会自行检查并处理分屏添加
            store.addTemporarySession({
              id: data.id,
              config,
              status: data.status,
              skipAutoAddToPane: false
            })
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
    <div className="flex flex-col h-screen bg-[#1E1E1E] text-white overflow-hidden">
      {/* 自定义标题栏 */}
      <div className="h-[28px] bg-[#252526] border-b border-[#3C3C3C] flex items-center justify-between select-none relative" style={{ WebkitAppRegion: 'drag' } as any}>
        {/* 左侧按钮组 */}
        <div className="flex items-center gap-1 pl-1 relative" style={{ WebkitAppRegion: 'no-drag' } as any}>
          {/* 展开/折叠侧边栏按钮 */}
          <div
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            className="w-[12px] h-[28px] bg-gray-500/20 flex items-center justify-center hover:bg-gray-500/50 transition-colors cursor-pointer group"
            title={sidebarCollapsed ? '展开会话栏' : '折叠会话栏'}
          >
            <span className="text-gray-400/50 text-xs group-hover:text-white transition-colors">{sidebarCollapsed ? '▶' : '◀'}</span>
          </div>
          {/* 新建会话按钮 */}
          <div
            onClick={() => {
              const event = new CustomEvent('newSession')
              window.dispatchEvent(event)
            }}
            className="w-[12px] h-[28px] bg-gray-500/20 flex items-center justify-center hover:bg-[#0078D4] transition-colors cursor-pointer group"
            title="新建会话"
          >
            <span className="text-gray-400/50 text-xs group-hover:text-white transition-colors">+</span>
          </div>
          {/* 标题 */}
          <span className="text-xs text-gray-400 pl-2">NovaShell</span>

          {/* 设置面板 */}
          {showSettings && (
            <div className="absolute top-[28px] left-0 z-50 bg-[#2D2D30] border border-[#3C3C3C] rounded shadow-lg p-3 min-w-[200px]">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-white font-medium">终端设置</span>
                <button onClick={() => setShowSettings(false)} className="text-gray-400 hover:text-white">✕</button>
              </div>
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-400 w-[60px]">缓冲区:</span>
                  <input
                    type="number"
                    value={scrollbackLines}
                    onChange={(e) => {
                      const value = parseInt(e.target.value) || 1000
                      setScrollbackLines(value)
                      localStorage.setItem('terminalScrollback', value.toString())
                    }}
                    className="w-[80px] px-2 py-1 bg-[#3C3C3C] border border-[#555] rounded text-sm text-white focus:outline-none focus:border-[#0078D4]"
                    min={1000}
                    max={100000}
                    step={1000}
                  />
                  <span className="text-xs text-gray-500">行</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-400 w-[60px]">字体大小:</span>
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
                    className="w-[80px] px-2 py-1 bg-[#3C3C3C] border border-[#555] rounded text-sm text-white focus:outline-none focus:border-[#0078D4]"
                    min={8}
                    max={32}
                    step={1}
                  />
                  <span className="text-xs text-gray-500">px</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-400 w-[60px]">光标闪烁:</span>
                  <input
                    type="checkbox"
                    checked={cursorBlink}
                    onChange={(e) => {
                      setCursorBlink(e.target.checked)
                      localStorage.setItem('terminalCursorBlink', e.target.checked.toString())
                      window.dispatchEvent(new CustomEvent('terminalCursorBlinkChanged', { detail: e.target.checked }))
                    }}
                    className="w-4 h-4"
                  />
                  <span className="text-xs text-gray-500">{cursorBlink ? '开启' : '关闭'}</span>
                </div>

                {/* 下载路径 */}
                <div className="border-t border-[#3C3C3C] pt-2 mt-2">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs text-gray-400 w-[60px]">下载路径:</span>
                    <div
                      onClick={handleSelectDownloadDir}
                      className="flex-1 px-2 py-1 bg-[#3C3C3C] border border-[#555] rounded text-sm text-white cursor-pointer hover:bg-[#555] truncate"
                      title={downloadDir || '点击选择'}
                    >
                      {downloadDir || '点击选择目录'}
                    </div>
                    <button
                      onClick={() => downloadDir && window.electronAPI?.openFolder(downloadDir)}
                      disabled={!downloadDir}
                      className={`px-2 py-1 rounded text-xs border ${
                        downloadDir
                          ? 'bg-[#3C3C3C] border-[#555] text-gray-300 hover:bg-[#555] hover:text-white'
                          : 'bg-[#3C3C3C] border-[#555] text-gray-500 cursor-not-allowed'
                      }`}
                      title="打开文件夹"
                    >
                      📂
                    </button>
                  </div>
                  <p className="text-xs text-gray-500">文件下载的默认保存目录</p>
                </div>

                <p className="text-xs text-gray-500 border-t border-[#3C3C3C] pt-2 mt-2">字体大小立即生效，缓冲区和光标设置新终端生效</p>
              </div>
            </div>
          )}
        </div>

        {/* 右侧按钮组 */}
        <div className="flex items-center gap-1 pr-1" style={{ WebkitAppRegion: 'no-drag' } as any}>
          {/* 浮窗按钮 */}
          <div
            onClick={() => setFloatVisible(!floatVisible)}
            className="w-[24px] h-[24px] bg-gray-500/20 flex items-center justify-center rounded hover:bg-gray-500/50 transition-colors cursor-pointer group"
            title="会话浮窗"
          >
            <span className="text-gray-400/50 text-xs group-hover:text-white transition-colors">📋</span>
          </div>
          {/* 设置按钮 */}
          <div
            onClick={() => setShowSettings(!showSettings)}
            className="w-[24px] h-[24px] bg-gray-500/20 flex items-center justify-center rounded hover:bg-gray-500/50 transition-colors cursor-pointer group"
            title="终端设置"
          >
            <span className="text-gray-400/50 text-xs group-hover:text-white transition-colors">⚙</span>
          </div>
          {/* 缩小 */}
          <div
            onClick={handleMinimize}
            className="w-[24px] h-[24px] bg-gray-500/20 flex items-center justify-center rounded hover:bg-gray-500/50 transition-colors cursor-pointer group"
            title="最小化"
          >
            <span className="text-gray-400/50 text-base group-hover:text-white transition-colors">─</span>
          </div>
          {/* 放大 */}
          <div
            onClick={handleMaximize}
            className="w-[24px] h-[24px] bg-gray-500/20 flex items-center justify-center rounded hover:bg-gray-500/50 transition-colors cursor-pointer group"
            title={isMaximized ? '还原' : '最大化'}
          >
            {isMaximized ? (
              <svg width="14" height="14" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="3" y="7" width="8" height="8" stroke="currentColor" strokeWidth="1.5" fill="none" className="text-gray-400/50 group-hover:text-white transition-colors"/>
                <path d="M7 3H15V11" stroke="currentColor" strokeWidth="1.5" fill="none" className="text-gray-400/50 group-hover:text-white transition-colors"/>
                <path d="M5 11V5H11" stroke="currentColor" strokeWidth="1.5" fill="none" className="text-gray-400/50 group-hover:text-white transition-colors"/>
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="3" y="3" width="12" height="12" stroke="currentColor" strokeWidth="2" fill="none" className="text-gray-400/50 group-hover:text-white transition-colors"/>
              </svg>
            )}
          </div>
          {/* 关闭 */}
          <div
            onClick={handleClose}
            className="w-[24px] h-[24px] bg-gray-500/20 flex items-center justify-center rounded hover:bg-red-500 transition-colors cursor-pointer group"
            title="关闭"
          >
            <span className="text-gray-400/50 text-base group-hover:text-white transition-colors">✕</span>
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
        />

        {/* 终端内容区 */}
        <div className="flex flex-col flex-1 min-w-0 min-h-0">
          {/* 终端内容区 - 分屏布局 */}
          <div ref={terminalWrapperRef} className="terminal-wrapper flex-1 min-h-0 bg-[#0C0C0C] overflow-hidden relative pl-1 pb-0">
            <SplitPaneContainer />

            {/* 右上角会话浮窗 */}
            {floatVisible && !floatCollapsed && (
              <div className="absolute top-[28px] right-[12px] z-50 w-[300px] h-[400px] bg-[#2D2D30] border border-[#3C3C3C] overflow-hidden shadow-lg">
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
                <div className="w-[12px] h-[48px] bg-gray-500/20 flex items-center justify-center shadow-sm group-hover:bg-gray-500/50 transition-colors">
                  <span className="text-gray-400/50 text-xs group-hover:text-white transition-colors">▶</span>
                </div>
              </div>
            )}
          </div>

          {/* 状态栏 */}
          <StatusBar sessionId={activeSessionIdForStatusBar} onExecuteCommand={handleExecuteCommand} />
        </div>
      </div>
    </div>
  )
}

export default MainWindow