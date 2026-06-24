import React, { useState, useEffect, useRef } from 'react'
import cn from 'classnames'
import type { SessionConfig } from '@shared/types'
import { useSessionStore } from '../../stores/session-store'
import SessionDialog from '../SessionDialog/SessionDialog'
import ExportImportDialog from '../ExportImportDialog/ExportImportDialog'
import FileManagerPanel from '../FileManager/FileManagerPanel'
import AgentBar from '../AgentBar/AgentBar'

interface QuickCommand {
  id: string
  name: string
  content: string
}

interface SidebarProps {
  collapsed: boolean
  onToggle: () => void
  onConnect?: (sessionId: string, config: SessionConfig) => void
  onQuickCommandsChange?: () => void  // 快速命令变化时通知父组件刷新 StatusBar
}

// 辅助函数
const getHostIP = (config: SessionConfig) => {
  if (!config) return 'unknown'
  if (config.ssh) return config.ssh.host
  if (config.telnet) return config.telnet.host
  if (config.serial) return config.serial.path
  if (config.local) return config.local.cwd || 'local'
  return 'unknown'
}

const getPort = (config: SessionConfig) => {
  if (!config) return ''
  if (config.ssh) return config.ssh.port
  if (config.telnet) return config.telnet.port
  return ''
}

const getTypeLabel = (type: string) => {
  switch (type) {
    case 'ssh': return 'SSH'
    case 'telnet': return 'TEL'
    case 'serial': return 'SER'
    case 'local': return 'LOC'
    default: return type?.toUpperCase() || ''
  }
}

const getTypeColor = (type: string) => {
  switch (type) {
    case 'ssh': return 'bg-blue-600 text-white'
    case 'telnet': return 'bg-green-600 text-white'
    case 'serial': return 'bg-yellow-600 text-white'
    case 'local': return 'bg-purple-600 text-white'
    default: return 'bg-gray-600 text-white'
  }
}

/**
 * 侧边栏组件 - 左侧会话列表 + 底部嵌入文件管理器
 * 支持宽度调整（右边缘拖动）和文件管理器高度调整（分割线拖动）
 */
const Sidebar: React.FC<SidebarProps> = ({ collapsed, onConnect, onQuickCommandsChange }) => {
  const [showDialog, setShowDialog] = useState(false)
  const [editConfig, setEditConfig] = useState<SessionConfig | undefined>(undefined)
  const [searchQuery, setSearchQuery] = useState('')
  const [showExportImport, setShowExportImport] = useState(false)
  const [quickCommands, setQuickCommands] = useState<QuickCommand[]>([])
  const { savedSessions, refreshSavedSessions } = useSessionStore()
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const isUpdating = useRef(false)

  // 宽度状态
  const [width, setWidth] = useState(240)
  const [fileManagerHeight, setFileManagerHeight] = useState(200)
  const [isResizingWidth, setIsResizingWidth] = useState(false)
  const [isResizingHeight, setIsResizingHeight] = useState(false)
  const sidebarRef = useRef<HTMLDivElement>(null)

  // 加载快速命令（从配置文件）
  useEffect(() => {
    window.electronAPI?.getQuickCommands().then((cmds: any[]) => {
      if (Array.isArray(cmds)) {
        setQuickCommands(cmds)
      }
    }).catch(err => {
      console.error('Failed to load quick commands:', err)
    })
  }, [])

  // 监听新建会话事件
  useEffect(() => {
    const handleNewSession = () => {
      setEditConfig(undefined)
      setShowDialog(true)
    }
    window.addEventListener('newSession', handleNewSession)
    return () => window.removeEventListener('newSession', handleNewSession)
  }, [])

  // 加载保存的会话列表
  useEffect(() => {
    refreshSavedSessions()
  }, [refreshSavedSessions])

  // 加载保存的 UI 配置
  useEffect(() => {
    const loadUIConfig = async () => {
      try {
        const savedWidth = await window.electronAPI?.getConfig('sidebarWidth')
        if (savedWidth && savedWidth > 0) {
          setWidth(savedWidth)
        }
        const savedHeight = await window.electronAPI?.getConfig('fileManagerHeight')
        if (savedHeight && savedHeight > 0) {
          setFileManagerHeight(savedHeight)
        }
      } catch (e) {
        console.warn('Failed to load UI config:', e)
      }
    }
    loadUIConfig()
  }, [])

  // 保存宽度到配置（带防抖）
  useEffect(() => {
    const timer = setTimeout(() => {
      window.electronAPI?.setConfig('sidebarWidth', width)
    }, 500)
    return () => clearTimeout(timer)
  }, [width])

  // 保存文件管理器高度到配置（带防抖）
  useEffect(() => {
    const timer = setTimeout(() => {
      window.electronAPI?.setConfig('fileManagerHeight', fileManagerHeight)
    }, 500)
    return () => clearTimeout(timer)
  }, [fileManagerHeight])

  // 宽度拖动处理
  useEffect(() => {
    if (!isResizingWidth) return

    const handleMouseMove = (e: MouseEvent) => {
      const newWidth = Math.max(180, Math.min(400, e.clientX))
      setWidth(newWidth)
    }

    const handleMouseUp = () => {
      setIsResizingWidth(false)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizingWidth])

  // 高度拖动处理
  useEffect(() => {
    if (!isResizingHeight) return

    const handleMouseMove = (e: MouseEvent) => {
      if (!sidebarRef.current) return
      const rect = sidebarRef.current.getBoundingClientRect()
      const newHeight = Math.max(100, Math.min(rect.height - 200, rect.bottom - e.clientY))
      setFileManagerHeight(newHeight)
    }

    const handleMouseUp = () => {
      setIsResizingHeight(false)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizingHeight])

  const handleOpenExportImport = () => {
    const saved = localStorage.getItem('quickCommands')
    if (saved) {
      try {
        const parsed = JSON.parse(saved)
        if (Array.isArray(parsed)) setQuickCommands(parsed)
      } catch {
        setQuickCommands([])
      }
    } else {
      setQuickCommands([])
    }
    setShowExportImport(true)
  }

  const handleImportComplete = async (_sessions: SessionConfig[], _commands: QuickCommand[]) => {
    // 导入已完成，刷新快速命令列表（从配置文件重新加载）
    try {
      const cmds = await window.electronAPI?.getQuickCommands()
      if (Array.isArray(cmds)) {
        setQuickCommands(cmds)
      }
      // 通知父组件刷新 StatusBar
      onQuickCommandsChange?.()
    } catch (err) {
      console.error('Failed to refresh quick commands:', err)
    }
    refreshSavedSessions()
  }

  const matchesSearch = (config: SessionConfig) => {
    if (!config) return false
    if (!searchQuery.trim()) return true
    const query = searchQuery.toLowerCase()
    const name = (config.name || '').toLowerCase()
    const ip = getHostIP(config).toLowerCase()
    const port = getPort(config).toString()
    return name.includes(query) || ip.includes(query) || port.includes(query)
  }

  const filteredSessions = savedSessions.filter(s => s && matchesSearch(s))

  const sortByUpdateTime = (a: SessionConfig, b: SessionConfig) => {
    const getTime = (d: Date | string | undefined) => d ? new Date(d).getTime() : 0
    return getTime(b.updatedAt) - getTime(a.updatedAt)
  }

  const sortByPinOrder = (a: SessionConfig, b: SessionConfig) => {
    if (a.pinOrder !== undefined && b.pinOrder !== undefined) return a.pinOrder - b.pinOrder
    if (a.pinOrder !== undefined) return -1
    if (b.pinOrder !== undefined) return 1
    return sortByUpdateTime(a, b)
  }

  const pinnedSessions = filteredSessions.filter(s => s.tags?.includes('pinned')).sort(sortByPinOrder)
  const unpinnedSessions = filteredSessions.filter(s => !s.tags?.includes('pinned'))

  // 按 IP 分组其他会话，并按最近更新时间排序分组
  const groupedByIP = unpinnedSessions.reduce((acc, session) => {
    if (!session) return acc
    const host = getHostIP(session)
    if (!acc[host]) acc[host] = []
    acc[host].push(session)
    return acc
  }, {} as Record<string, SessionConfig[]>)

  // IP分组按该分组内最新会话的更新时间排序
  const sortedIPGroups = Object.entries(groupedByIP).sort(([, aSessions], [, bSessions]) => {
    const getLatestTime = (sessions: SessionConfig[]) => {
      return sessions.reduce((max, s) => {
        const t = s.updatedAt ? new Date(s.updatedAt).getTime() : 0
        return Math.max(max, t)
      }, 0)
    }
    return getLatestTime(bSessions) - getLatestTime(aSessions)
  })

  // IP 分组展开状态
  const [expandedIPs, setExpandedIPs] = useState<Record<string, boolean>>({})

  const toggleIPGroup = (ip: string) => {
    setExpandedIPs(prev => ({ ...prev, [ip]: !prev[ip] }))
  }

  const handleTogglePin = async (config: SessionConfig, e: React.MouseEvent) => {
    e.stopPropagation()
    const isPinned = config.tags?.includes('pinned')
    const newTags = isPinned ? config.tags.filter(t => t !== 'pinned') : [...(config.tags || []), 'pinned']
    let newPinOrder: number | undefined
    if (!isPinned) {
      const currentPinned = savedSessions.filter(s => s.tags?.includes('pinned'))
      const maxOrder = currentPinned.reduce((max, s) => s.pinOrder !== undefined ? Math.max(max, s.pinOrder) : max, -1)
      newPinOrder = maxOrder + 1
    } else {
      newPinOrder = undefined
    }
    await window.electronAPI?.updateSession({ ...config, tags: newTags, pinOrder: newPinOrder, updatedAt: new Date() })
    await refreshSavedSessions()
  }

  const handleDragStart = (e: React.DragEvent, index: number) => {
    setDraggedIndex(index)
    e.dataTransfer.effectAllowed = 'move'
  }

  const handleDragEnter = (e: React.DragEvent, index: number) => {
    e.preventDefault()
    setDragOverIndex(index)
  }

  const handleDrop = async (e: React.DragEvent, targetIndex: number) => {
    e.preventDefault()
    if (isUpdating.current) return
    isUpdating.current = true
    try {
      if (draggedIndex === null || draggedIndex === targetIndex) {
        setDraggedIndex(null)
        setDragOverIndex(null)
        return
      }
      const draggedSession = pinnedSessions[draggedIndex]
      const targetSession = pinnedSessions[targetIndex]
      if (!draggedSession?.id || !targetSession?.id) {
        setDraggedIndex(null)
        setDragOverIndex(null)
        return
      }
      const reordered = [...pinnedSessions]
      reordered.splice(draggedIndex, 1)
      reordered.splice(targetIndex, 0, draggedSession)
      for (let i = 0; i < reordered.length; i++) {
        const config = reordered[i]
        if (!config?.id) continue
        await window.electronAPI?.updateSession({ ...config, pinOrder: i })
      }
      await refreshSavedSessions()
      setDraggedIndex(null)
      setDragOverIndex(null)
    } finally {
      setTimeout(() => { isUpdating.current = false }, 300)
    }
  }

  const handleDeleteSession = async (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (confirm('确定删除该会话？')) {
      await window.electronAPI?.deleteSession(sessionId)
      refreshSavedSessions()
    }
  }

  const handleSessionClick = (config: SessionConfig) => {
    onConnect?.(config.id, config)
  }

  const handleNewSession = () => {
    setEditConfig(undefined)
    setShowDialog(true)
  }

  const handleLaunchAgent = async (agentId: string) => {
    await window.electronAPI?.launchAgent(agentId)
    // 不调用 onConnect，agent:launch 已在后端创建并连接会话
    // 连接成功后 MainWindow 会通过 connection:status 事件自动添加到面板
  }

  const handleQuickLocal = async (shell: string, startupCommands?: string[]) => {
    const shellName = shell === 'powershell' ? 'PowerShell' : shell === 'pwsh' ? 'PowerShell 7' : 'CMD'
    const name = startupCommands ? `${shellName} (Admin)` : shellName
    const config: SessionConfig = {
      id: '',
      name,
      type: 'local' as any,
      local: { shell },
      terminal: {
        fontSize: 14,
        fontFamily: 'Consolas, Monaco, monospace',
        theme: {
          foreground: '#D4D4D4', background: '#1E1E1E', cursor: '#D4D4D4', selectionBackground: '#264F78',
          black: '#000000', red: '#CD3131', green: '#0DBC79', yellow: '#E5E510', blue: '#2472C8',
          magenta: '#BC3FBC', cyan: '#11A8CD', white: '#E5E5E5',
          brightBlack: '#666666', brightRed: '#F14C4C', brightGreen: '#23D18B', brightYellow: '#F5F543',
          brightBlue: '#3B8EEA', brightMagenta: '#D670D6', brightCyan: '#29B8DB', brightWhite: '#E5E5E5'
        },
        cursorStyle: 'bar', cursorBlink: true, scrollback: 10000, encoding: 'utf-8'
      },
      tags: [], startupCommands, createdAt: new Date(), updatedAt: new Date()
    }
    onConnect?.('', config)
  }

  const handleEditSession = (config: SessionConfig, e: React.MouseEvent) => {
    e.stopPropagation()
    setEditConfig(config)
    setShowDialog(true)
  }

  const handleCopySession = (config: SessionConfig, e: React.MouseEvent) => {
    e.stopPropagation()
    // 复制配置，清空id让它生成新id，名字加上"副本"后缀
    const copiedConfig: SessionConfig = {
      ...config,
      id: undefined as any,  // 清空id，提交时会生成新id
      name: config.name ? `${config.name} 副本` : '',
      createdAt: undefined as any,
      updatedAt: undefined as any
    }
    setEditConfig(copiedConfig)
    setShowDialog(true)
  }

  if (collapsed) return null

  return (
    <>
      <div
        ref={sidebarRef}
        className="bg-[#252526] border-r border-[#3C3C3C] flex flex-col h-full"
        style={{ width: `${width}px`, pointerEvents: 'auto' }}
      >
        {/* 搜索栏和操作按钮 */}
        <div className="flex items-center gap-2 px-2 py-2 border-b border-[#3C3C3C]">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索..."
            className="flex-1 px-2 py-1 bg-[#3C3C3C] border border-[#555] rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:border-[#0078D4]"
          />
          <button
            onClick={handleNewSession}
            title="新建会话"
            className="w-[28px] h-[28px] flex items-center justify-center bg-[#0078D4] text-white rounded hover:bg-[#006CBD] transition-colors"
          >
            +
          </button>
          <button
            onClick={handleOpenExportImport}
            title="导出/导入"
            className="w-[28px] h-[28px] flex items-center justify-center bg-[#3C3C3C] text-gray-300 rounded hover:bg-[#555] hover:text-white transition-colors"
          >
            ⬇
          </button>
        </div>

        {/* 本地终端快捷按钮 */}
        <div className="flex items-center gap-1 px-2 py-1.5 border-b border-[#3C3C3C]">
          <button
            onClick={() => handleQuickLocal('')}
            className="flex items-center gap-1 px-2 py-0.5 text-xs bg-[#3C3C3C] text-gray-300 hover:bg-[#555] hover:text-white cursor-pointer transition-colors rounded"
            title="CMD"
          >
            <span>⬛</span><span>CMD</span>
          </button>
          <button
            onClick={() => handleQuickLocal('powershell')}
            className="flex items-center gap-1 px-2 py-0.5 text-xs bg-[#3C3C3C] text-blue-400 hover:bg-[#555] hover:text-blue-300 cursor-pointer transition-colors rounded"
            title="PowerShell"
          >
            <span>🔷</span><span>PS</span>
          </button>
          <button
            onClick={() => handleQuickLocal('powershell', ['gsudo'])}
            className="flex items-center gap-1 px-2 py-0.5 text-xs bg-[#3C3C3C] text-red-400 hover:bg-[#555] hover:text-red-300 cursor-pointer transition-colors rounded"
            title="PowerShell (管理员) - 需要 gsudo"
          >
            <span>🛡️</span><span>PS+</span>
          </button>
          <button
            onClick={() => handleQuickLocal('pwsh')}
            className="flex items-center gap-1 px-2 py-0.5 text-xs bg-[#3C3C3C] text-purple-400 hover:bg-[#555] hover:text-purple-300 cursor-pointer transition-colors rounded"
            title="PowerShell 7"
          >
            <span>🔷</span><span>PS7</span>
          </button>
        </div>

        {/* AI Agent 快捷启动 */}
        <AgentBar onLaunchAgent={handleLaunchAgent} />

        {/* 会话列表 */}
        <div className="flex-1 overflow-y-auto min-h-[100px]">
          {/* 置顶会话区域 */}
          {pinnedSessions.length > 0 && (
            <div className="border-b border-[#3C3C3C] pb-2">
              <div className="flex items-center gap-2 px-3 py-1.5 bg-[#1E1E1E]">
                <span className="text-xs text-[#0078D4]">📌</span>
                <span className="text-sm font-medium text-gray-200">置顶会话</span>
                <span className="text-xs text-gray-500">({pinnedSessions.length})</span>
              </div>
              <div className="space-y-1 px-2 py-1">
                {pinnedSessions.map((config, index) => {
                  const isDragging = draggedIndex === index
                  const isDragOver = dragOverIndex === index && !isDragging
                  return (
                    <div
                      key={config.id}
                      draggable={true}
                      onDragStart={(e) => handleDragStart(e, index)}
                      onDragEnter={(e) => handleDragEnter(e, index)}
                      onDrop={(e) => handleDrop(e, index)}
                      onDragOver={(e) => e.preventDefault()}
                      onClick={() => handleSessionClick(config)}
                      className={cn(
                        'flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors group',
                        'hover:bg-[#3C3C3C]',
                        isDragging && 'opacity-50 bg-[#0078D4]',
                        isDragOver && 'border-t-2 border-[#0078D4]',
                        'bg-[#3C3C3C]/30'
                      )}
                    >
                      <span className="text-xs text-[#0078D4]" title="已置顶">📌</span>
                      <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${getTypeColor(config.type)}`}>
                        {getTypeLabel(config.type)}
                      </span>
                      <span className="text-sm text-gray-200 flex-1 truncate">{config.name}</span>
                      <span className="text-xs text-gray-500">{getPort(config)}</span>
                      <div className="hidden group-hover:flex gap-1">
                        <button onClick={(e) => handleEditSession(config, e)} title="编辑会话" className="w-[20px] h-[20px] flex items-center justify-center text-gray-400 hover:text-white hover:bg-[#555] rounded">✎</button>
                        <button onClick={(e) => handleCopySession(config, e)} title="复制会话" className="w-[20px] h-[20px] flex items-center justify-center text-gray-400 hover:text-white hover:bg-[#555] rounded">⎘</button>
                        <button onClick={(e) => handleTogglePin(config, e)} title="取消置顶" className="w-[20px] h-[20px] flex items-center justify-center text-[#0078D4] hover:bg-[#0078D4]/20 rounded">📌</button>
                        <button onClick={(e) => handleDeleteSession(config.id, e)} title="删除会话" className="w-[20px] h-[20px] flex items-center justify-center text-gray-400 hover:text-red-400 hover:bg-[#555] rounded">✕</button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* 其他会话 - 按 IP 分组显示 */}
          {sortedIPGroups.length > 0 && (
            <div className="space-y-[2px]">
              {sortedIPGroups.map(([ip, sessions]) => {
                // 单个会话不折叠，直接显示
                if (sessions.length === 1) {
                  const config = sessions[0]
                  return (
                    <div
                      key={config.id}
                      onClick={() => handleSessionClick(config)}
                      className="flex items-center gap-2 px-3 py-[5px] rounded hover:bg-[#3C3C3C] cursor-pointer transition-colors group bg-[#3C3C3C]/30"
                    >
                      <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${getTypeColor(config.type)}`}>
                        {getTypeLabel(config.type)}
                      </span>
                      <span className="text-xs text-gray-400 truncate max-w-[80px]">{ip}</span>
                      <span className="text-sm text-gray-200 flex-1 truncate">{config.name}</span>
                      <span className="text-xs text-gray-500">{getPort(config)}</span>
                      <div className="hidden group-hover:flex gap-1">
                        <button onClick={(e) => handleEditSession(config, e)} title="编辑会话" className="w-[20px] h-[20px] flex items-center justify-center text-gray-400 hover:text-white hover:bg-[#555] rounded">✎</button>
                        <button onClick={(e) => handleCopySession(config, e)} title="复制会话" className="w-[20px] h-[20px] flex items-center justify-center text-gray-400 hover:text-white hover:bg-[#555] rounded">⎘</button>
                        <button onClick={(e) => handleTogglePin(config, e)} title="置顶会话" className="w-[20px] h-[20px] flex items-center justify-center text-gray-400 hover:text-[#0078D4] hover:bg-[#555] rounded">📌</button>
                        <button onClick={(e) => handleDeleteSession(config.id, e)} title="删除会话" className="w-[20px] h-[20px] flex items-center justify-center text-gray-400 hover:text-red-400 hover:bg-[#555] rounded">✕</button>
                      </div>
                    </div>
                  )
                }
                // 多个会话才折叠显示
                return (
                  <div key={ip}>
                    <div
                      onClick={() => toggleIPGroup(ip)}
                      className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-[#2D2D30] transition-colors bg-[#1E1E1E]"
                    >
                      <span className="text-xs text-gray-400">{expandedIPs[ip] ? '▼' : '▶'}</span>
                      <span className="text-xs text-gray-300 flex-1 truncate">{ip}</span>
                      <span className="text-xs text-gray-500">({sessions.length})</span>
                    </div>
                    {expandedIPs[ip] && (
                      <div className="space-y-[2px] px-2 py-1 border-l-2 border-[#3C3C3C] ml-3">
                        {sessions.sort(sortByPinOrder).map((config) => (
                          <div
                            key={config.id}
                            onClick={() => handleSessionClick(config)}
                            className="flex items-center gap-2 px-2 py-[5px] rounded hover:bg-[#3C3C3C] cursor-pointer transition-colors group"
                          >
                            <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${getTypeColor(config.type)}`}>
                              {getTypeLabel(config.type)}
                            </span>
                            <span className="text-sm text-gray-200 flex-1 truncate">{config.name}</span>
                            <span className="text-xs text-gray-500">{getPort(config)}</span>
                            <div className="hidden group-hover:flex gap-1">
                              <button onClick={(e) => handleEditSession(config, e)} title="编辑会话" className="w-[20px] h-[20px] flex items-center justify-center text-gray-400 hover:text-white hover:bg-[#555] rounded">✎</button>
                              <button onClick={(e) => handleCopySession(config, e)} title="复制会话" className="w-[20px] h-[20px] flex items-center justify-center text-gray-400 hover:text-white hover:bg-[#555] rounded">⎘</button>
                              <button onClick={(e) => handleTogglePin(config, e)} title="置顶会话" className="w-[20px] h-[20px] flex items-center justify-center text-gray-400 hover:text-[#0078D4] hover:bg-[#555] rounded">📌</button>
                              <button onClick={(e) => handleDeleteSession(config.id, e)} title="删除会话" className="w-[20px] h-[20px] flex items-center justify-center text-gray-400 hover:text-red-400 hover:bg-[#555] rounded">✕</button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {filteredSessions.length === 0 && (
            <div className="text-center py-8 text-gray-500 text-xs px-4">
              <p>{searchQuery.trim() ? '无匹配结果' : '暂无会话'}</p>
              <p className="mt-1">{searchQuery.trim() ? '尝试其他关键词' : '点击顶部按钮创建'}</p>
            </div>
          )}
        </div>

        {/* 文件管理器分割线 - 可拖动调整高度 */}
        <div
          className="h-[4px] bg-[#3C3C3C] cursor-row-resize hover:bg-[#0078D4] transition-colors flex items-center justify-center relative"
          onMouseDown={() => setIsResizingHeight(true)}
        >
          {/* 上方透明区域，增加点击范围 */}
          <div className="absolute -top-[4px] left-0 right-0 h-[4px] cursor-row-resize" onMouseDown={() => setIsResizingHeight(true)} />
          <div className="w-[30px] h-[2px] bg-gray-500 rounded"></div>
        </div>

        {/* 嵌入式文件管理器 */}
        <div style={{ height: `${fileManagerHeight}px` }} className="flex-shrink-0 overflow-hidden">
          <FileManagerPanel />
        </div>
      </div>

      {/* 右边缘宽度调整条 */}
      <div
        className="w-[4px] bg-[#3C3C3C] cursor-col-resize hover:bg-[#0078D4] transition-colors flex-shrink-0 relative"
        onMouseDown={() => setIsResizingWidth(true)}
      >
        {/* 左侧透明区域，增加点击范围 */}
        <div className="absolute -left-[4px] top-0 bottom-0 w-[4px] cursor-col-resize" onMouseDown={() => setIsResizingWidth(true)} />
      </div>

      {/* 会话对话框 */}
      <SessionDialog
        open={showDialog}
        onClose={() => {
          setShowDialog(false)
          setEditConfig(undefined)
        }}
        initialConfig={editConfig}
        onSubmit={async (config) => {
          if (editConfig) {
            // 编辑模式：直接更新；dialog 内部会立即关闭
            await window.electronAPI?.updateSession(config)
            refreshSavedSessions()
            return config.id
          }
          // 新建模式：创建并触发连接；返回 sessionId 让 dialog 监听连接状态
          const newConfig = await window.electronAPI?.createSession(config)
          if (newConfig?.id) {
            onConnect?.(newConfig.id, newConfig)
          }
          refreshSavedSessions()
          return newConfig?.id
        }}
      />

      {/* 导出导入对话框 */}
      <ExportImportDialog
        open={showExportImport}
        onClose={() => setShowExportImport(false)}
        sessions={savedSessions}
        quickCommands={quickCommands}
        onImportComplete={handleImportComplete}
      />
    </>
  )
}

export default Sidebar