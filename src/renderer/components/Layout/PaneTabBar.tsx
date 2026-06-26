import React, { useRef, useState } from 'react'
import cn from 'classnames'
import { useSessionStore } from '../../stores/session-store'
import { usePaneStore } from '../../stores/pane-store'
import { setDraggingSessionId as setGlobalDraggingId } from './SplitPaneContainer'
import type { PaneLeaf } from '@shared/types'

interface PaneTabBarProps {
  pane: PaneLeaf
}

/**
 * 分屏内的标签栏组件 - 显示该分屏内的会话标签
 */
const PaneTabBar: React.FC<PaneTabBarProps> = ({ pane }) => {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [draggingSessionId, setDraggingSessionIdLocal] = useState<string | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)  // 悬停位置索引
  const { sessions } = useSessionStore()
  const { setActiveSessionInPane, removeSessionFromPane, addSessionToPane, reorderSessionsInPane } = usePaneStore()

  // 防止重复双击
  const isCloning = useRef(false)

  // 获取该分屏内的会话（按照 pane.sessions 的顺序）
  const paneSessions = pane.sessions
    .map(sessionId => sessions.find(s => s.id === sessionId))
    .filter((s): s is typeof sessions[0] => s !== undefined)

  // 获取所有分屏内的活跃会话（用于全局编号计算，只统计活跃的）
  const allPaneSessions = sessions.filter(s =>
    (s.status === 'connected' || s.status === 'connecting')
  )

  // 滚动到选中的标签
  const scrollToTab = (tabId: string) => {
    const container = scrollRef.current
    if (!container) return

    const tabElement = container.querySelector(`[data-tab-id="${tabId}"]`)
    if (tabElement) {
      const containerWidth = container.clientWidth
      const tabLeft = tabElement.getBoundingClientRect().left - container.getBoundingClientRect().left
      const tabWidth = tabElement.clientWidth

      if (tabLeft < 0) {
        container.scrollLeft += tabLeft
      } else if (tabLeft + tabWidth > containerWidth) {
        container.scrollLeft += tabLeft + tabWidth - containerWidth
      }
    }
  }

  // 点击标签时切换会话
  const handleTabClick = (sessionId: string) => {
    setActiveSessionInPane(pane.id, sessionId)
    // 清除活动状态
    useSessionStore.getState().setSessionActivity(sessionId, false)
    scrollToTab(sessionId)
    // 通知终端重新 fit + resize
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('terminal-tab-switched'))
    }, 50)
  }

  // 双击左键：断开状态重连，已连接状态克隆会话
  const handleTabDoubleClick = async (sessionId: string) => {
    // 防止重复触发
    if (isCloning.current) return
    isCloning.current = true

    try {
      // 检查会话状态
      const session = sessions.find(s => s.id === sessionId)

      if (session?.status === 'disconnected' || session?.status === 'error') {
        // 断开状态：重连
        await useSessionStore.getState().reconnectSession(sessionId)
      } else {
        // 已连接状态：克隆会话（创建新连接）
        const newSessionId = await useSessionStore.getState().cloneSession(sessionId, false)

        // 检查会话是否已经在某个分屏中
        const paneStore = usePaneStore.getState()
        const allPanes = paneStore.getAllLeafPanes()
        const isInPane = allPanes.some(p => p.sessions.includes(newSessionId))

        // 如果不在任何分屏中，才添加到当前分屏
        if (!isInPane) {
          addSessionToPane(pane.id, newSessionId)
        }
      }
    } catch (error) {
      console.error('Handle tab double click failed:', error)
    } finally {
      // 延迟解锁，防止快速重复双击
      setTimeout(() => {
        isCloning.current = false
      }, 500)
    }
  }

  // 双击右键克隆渠道（共享 SSH 连接）
  const handleTabRightDoubleClick = async (sessionId: string, sessionType: string) => {
    if (sessionType !== 'ssh') {
      // 非 SSH 会话不支持克隆渠道 —— 静默 return(TODO: 全局 toast 后接入提示)
      return
    }

    // 防止重复触发
    if (isCloning.current) return
    isCloning.current = true

    try {
      // 克隆渠道（共享 SSH 连接）
      const newSessionId = await useSessionStore.getState().cloneSession(sessionId, true)

      // 检查会话是否已经在某个分屏中
      const paneStore = usePaneStore.getState()
      const allPanes = paneStore.getAllLeafPanes()
      const isInPane = allPanes.some(p => p.sessions.includes(newSessionId))

      // 如果不在任何分屏中，才添加到当前分屏
      if (!isInPane) {
        addSessionToPane(pane.id, newSessionId)
      }
    } catch (error) {
      console.error('Clone channel failed:', error)
    } finally {
      // 延迟解锁
      setTimeout(() => {
        isCloning.current = false
      }, 500)
    }
  }

  // 处理右键双击（需要检测连续两次右键点击）
  const lastRightClickTime = useRef<number>(0)
  const lastRightClickSession = useRef<string>('')

  const handleTabRightClick = (sessionId: string, sessionType: string) => {
    const now = Date.now()
    const lastTime = lastRightClickTime.current
    const lastSession = lastRightClickSession.current

    // 如果在 300ms 内连续右键点击同一个标签，视为双击右键
    if (now - lastTime < 300 && sessionId === lastSession) {
      handleTabRightDoubleClick(sessionId, sessionType)
      lastRightClickTime.current = 0
      lastRightClickSession.current = ''
    } else {
      lastRightClickTime.current = now
      lastRightClickSession.current = sessionId
    }
  }

  // 开始拖拽
  const handleDragStart = (e: React.DragEvent, sessionId: string) => {
    setGlobalDraggingId(sessionId)
    setDraggingSessionIdLocal(sessionId)
    e.dataTransfer.setData('text/plain', sessionId)
    e.dataTransfer.effectAllowed = 'move'
  }

  // 结束拖拽
  const handleDragEnd = () => {
    setGlobalDraggingId(null)
    setDraggingSessionIdLocal(null)
    setDragOverIndex(null)
  }

  // 拖拽悬停在标签上
  const handleDragOverTab = (e: React.DragEvent, index: number) => {
    e.preventDefault()
    // 不阻止传播，让事件正常流动
    setDragOverIndex(index)
  }

  // 拖拽离开标签
  const handleDragLeaveTab = () => {
    setDragOverIndex(null)
  }

  // 拖拽放下到标签上
  const handleDropOnTab = (e: React.DragEvent, targetIndex: number) => {
    e.preventDefault()
    e.stopPropagation()

    const dragSessionId = e.dataTransfer.getData('text/plain')
    if (!dragSessionId) return

    // 找到拖拽会话的当前索引
    const dragIndex = paneSessions.findIndex(s => s.id === dragSessionId)
    if (dragIndex === -1 || dragIndex === targetIndex) {
      setDragOverIndex(null)
      return
    }

    // 重排序
    reorderSessionsInPane(pane.id, dragIndex, targetIndex)
    setDragOverIndex(null)
  }

  // 向左滚动
  const scrollLeft = () => {
    scrollRef.current?.scrollBy({ left: -150, behavior: 'smooth' })
  }

  // 向右滚动
  const scrollRight = () => {
    scrollRef.current?.scrollBy({ left: 150, behavior: 'smooth' })
  }

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'connected': return 'OK'
      case 'connecting': return '...'
      case 'error': return 'ERR'
      default: return '--'
    }
  }

  // 获取友好的错误提示
  const getFriendlyError = (error?: string): string => {
    if (!error) return '连接失败'

    // 提取错误关键信息（去掉堆栈）
    let cleanError = error
    if (cleanError.includes('\n')) {
      cleanError = cleanError.split('\n')[0] // 只取第一行
    }
    if (cleanError.includes('Error:')) {
      cleanError = cleanError.replace(/Error:\s*/g, '')
    }

    // 常见错误转换
    const errorMap: Record<string, string> = {
      'Timed out while waiting for handshake': 'SSH握手超时，请检查主机端口和网络',
      'handshake timeout': 'SSH握手超时，请检查主机端口和网络',
      'Authentication failed': '认证失败，请检查用户名和密码',
      'connection refused': '连接被拒绝，请检查端口是否正确',
      'Connection refused': '连接被拒绝，请检查端口是否正确',
      'Connection timeout': '连接超时，请检查主机地址和网络',
      'connection timeout': '连接超时，请检查主机地址和网络',
      'Host key verification failed': '主机密钥验证失败',
      'Network is unreachable': '网络不可达，请检查网络连接',
      'ENOTFOUND': '无法找到主机，请检查地址是否正确',
      'ECONNREFUSED': '连接被拒绝，请检查端口是否正确',
      'ETIMEDOUT': '连接超时，请检查主机地址和网络',
      'EHOSTUNREACH': '主机不可达，请检查网络连接',
      'getaddrinfo ENOTFOUND': '无法解析主机名，请检查地址是否正确',
      'read ECONNRESET': '连接被重置',
      'write ECONNRESET': '连接被重置',
      'socket hang up': '连接意外关闭',
      'SSH connection error': 'SSH连接错误',
      'All configured authentication methods failed': '所有认证方式都失败了，请检查密码或密钥',
      'private key decrypt failed': '私钥解密失败，请检查密钥密码',
      'no such file': '找不到指定的文件',
      'Permission denied': '权限被拒绝',
      'Too many authentication failures': '认证失败次数过多',
    }

    // 查找匹配的错误
    for (const [key, value] of Object.entries(errorMap)) {
      if (cleanError.includes(key)) {
        return value
      }
    }

    // 如果还是太长，截断
    if (cleanError.length > 30) {
      return cleanError.substring(0, 30) + '...'
    }
    return cleanError
  }

  // 如果分屏没有会话，不显示标签栏
  if (paneSessions.length === 0) {
    return null
  }

  // 计算会话名称编号 - 基于全局所有分屏的同名会话
  const getNameWithIndex = (session: typeof paneSessions[0]) => {
    // 使用所有分屏内的会话来计算编号，保持名称稳定
    const sameNameSessions = allPaneSessions.filter(s => s.config.name === session.config.name)
    if (sameNameSessions.length <= 1) {
      return session.config.name
    }
    const getTime = (d: Date | string | undefined) => {
      if (!d) return 0
      return new Date(d).getTime()
    }
    const sorted = [...sameNameSessions].sort((a, b) =>
      getTime(a.config.createdAt) - getTime(b.config.createdAt)
    )
    const index = sorted.findIndex(s => s.id === session.id)
    if (index === 0) {
      return session.config.name
    }
    return `${session.config.name} (${index})`
  }

  return (
    <div className="flex items-center bg-[var(--bg-rack)] border-b border-[var(--rule)] h-[28px]">
      {/* 左滚动按钮 */}
      <button
        onClick={scrollLeft}
        title="向左滚动"
        className="w-[20px] h-full flex items-center justify-center text-[var(--text-rack-mute)] hover:text-[var(--text-rack)] hover:bg-[var(--bg-elev)] transition-colors"
      >
        ‹
      </button>

      {/* 标签容器 */}
      <div
        ref={scrollRef}
        onDragOver={(e) => {
          e.preventDefault()
          // 不阻止传播，让终端区域也能接收 dragover
        }}
        className="flex flex-nowrap items-center h-full overflow-x-auto scrollbar-hide overflow-y-hidden flex-1"
      >
        {paneSessions.map((session, index) => (
          <div
            key={session.id}
            data-tab-id={session.id}
            onClick={() => handleTabClick(session.id)}
            onDoubleClick={() => handleTabDoubleClick(session.id)}
            onContextMenu={() => handleTabRightClick(session.id, session.config.type)}
            draggable
            onDragStart={(e) => handleDragStart(e, session.id)}
            onDragEnd={handleDragEnd}
            onDragOver={(e) => handleDragOverTab(e, index)}
            onDragLeave={handleDragLeaveTab}
            onDrop={(e) => handleDropOnTab(e, index)}
            title="单击切换 | 双击左键克隆会话 | 双击右键克隆渠道(SSH)"
            className={cn(
              'flex items-center gap-1 px-2 h-full border-r border-[var(--rule)] cursor-pointer transition-colors flex-shrink-0 min-w-[120px]',
              pane.activeSessionId === session.id
                ? 'bg-[#0C0C0C] text-[var(--text-rack)] border-b-2 border-b-[var(--amber)]'
                : session.hasActivity
                  ? 'bg-[var(--reachable)]/25 text-[var(--text-rack)] hover:bg-[var(--reachable)]/35 shadow-[inset_2px_0_0_var(--reachable)]' // 有未读输出:reachable 青调底 + 左侧 stripe
                  : 'bg-[var(--bg-rack)] text-[var(--text-rack-mute)] hover:bg-[var(--bg-slot)] hover:text-[var(--text-rack)]',
              draggingSessionId === session.id && 'opacity-50',
              // 拖拽位置指示器 —— amber border-l 与 activity 的 reachable inset stripe 共存,视觉上 amber 覆盖青色(border 渲染层 > inset shadow);
              // 调整时不要改成 border-l-[var(--reachable)] 否则两态视觉无差
              dragOverIndex === index && draggingSessionId !== session.id && 'border-l-2 border-l-[var(--amber)]'
            )}
          >
            <span className="text-xs truncate max-w-[150px]">{getNameWithIndex(session)}</span>
            <span
              title={session.status === 'error' ? getFriendlyError(session.lastError) : undefined}
              className={cn(
                'text-xs cursor-default',
                session.status === 'connected' ? 'text-[var(--live)]' :
                session.status === 'error' ? 'text-[var(--error-rack)] hover:opacity-80' : 'text-[var(--text-rack-mute)]'
              )}
            >
              {getStatusLabel(session.status)}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation()
                removeSessionFromPane(pane.id, session.id)
                // 如果会话已经断开，从 store 中移除
                useSessionStore.getState().disconnectSession(session.id)
              }}
              title="关闭连接"
              className="ml-1 w-[14px] h-[14px] flex items-center justify-center text-xs hover:bg-[var(--error-rack)] hover:text-white rounded-[2px] transition-colors"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {/* 右滚动按钮 */}
      <button
        onClick={scrollRight}
        title="向右滚动"
        className="w-[20px] h-full flex items-center justify-center text-[var(--text-rack-mute)] hover:text-[var(--text-rack)] hover:bg-[var(--bg-elev)] transition-colors"
      >
        ›
      </button>
    </div>
  )
}

export default PaneTabBar