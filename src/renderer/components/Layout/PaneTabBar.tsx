import React, { useRef, useState } from 'react'
import cn from 'classnames'
import { useTranslation } from 'react-i18next'
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
  const { sessions, removeLiveSession } = useSessionStore()
  const { setActiveSessionInPane, removeSessionFromPane, addSessionToPane, reorderSessionsInPane, mcpAuditPaneId, dshWeb, dshWebPaneId, dshWebActive, setDraggingDshWeb } = usePaneStore()
  const toggleLiveSessionTabs = usePaneStore(s => s.toggleLiveSessionTabs)
  const { t } = useTranslation()
  // 被隐藏的页签(Sidebar LIVE 段会话标签点击 toggle)——不渲染对应页签,但终端实例保留
  const hiddenTabSessions = usePaneStore(s => s.hiddenTabSessions)

  // 防止重复双击
  const isCloning = useRef(false)

  // 获取该分屏内的会话（按照 pane.sessions 的顺序）；被隐藏的页签不显示
  const paneSessions = pane.sessions
    .map(sessionId => sessions.find(s => s.id === sessionId))
    .filter((s): s is typeof sessions[0] => s !== undefined)
    .filter(s => !hiddenTabSessions[s.id])

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
    // 切到 session 页签前关掉本 pane 的 MCP 覆盖层，否则它会挡住刚选中的终端
    const paneSt = usePaneStore.getState()
    if (paneSt.mcpAuditPaneId === pane.id) paneSt.closeMcpAudit()
    // 本 pane 正显示 dsh web 时，切到终端页签仅隐藏（webview 保持挂载、子进程不回收），点 web 页签可切回
    if (paneSt.dshWebPaneId === pane.id && paneSt.dshWebActive) paneSt.deactivateDshWeb()
    setActiveSessionInPane(pane.id, sessionId)
    // 清除活动状态
    useSessionStore.getState().setSessionActivity(sessionId, false)
    scrollToTab(sessionId)
    // 通知终端重新 fit + resize
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('terminal-tab-switched'))
    }, 50)
  }

  // 点击 MCP 页签（仅本 pane 已开 MCP 时渲染）：关闭 MCP，切回当前 session
  const handleMcpTabClick = () => {
    usePaneStore.getState().closeMcpAudit()
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

    // 找到拖拽会话的当前索引(在过滤后的 paneSessions 里)
    const dragIndex = paneSessions.findIndex(s => s.id === dragSessionId)
    if (dragIndex === -1 || dragIndex === targetIndex) {
      setDragOverIndex(null)
      return
    }

    // paneSessions 已过滤掉隐藏标签,但 reorderSessionsInPane 对原始 pane.sessions 做 splice,
    // 直接传过滤后索引会在中间夹有隐藏标签时错位 —— 映射回原始数组索引
    const fromOrigIndex = pane.sessions.indexOf(paneSessions[dragIndex].id)
    const toOrigIndex = pane.sessions.indexOf(paneSessions[targetIndex].id)
    if (fromOrigIndex === -1 || toOrigIndex === -1 || fromOrigIndex === toOrigIndex) {
      setDragOverIndex(null)
      return
    }

    // 重排序
    reorderSessionsInPane(pane.id, fromOrigIndex, toOrigIndex)
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
      case 'connected': return t('common.status.connected')
      case 'connecting': return ''
      case 'error': return t('common.status.error')
      default: return t('common.status.idle')
    }
  }

  // 获取友好的错误提示
  // errorMap 的 value 现在是 i18n key（而非字面文案）；map 的 key 是技术子串，
  // 用于匹配后端原始错误，永远不展示，不翻译。函数在渲染期调用，t 在闭包作用域。
  const getFriendlyError = (error?: string): string => {
    if (!error) return t('error.default')

    // 提取错误关键信息（去掉堆栈）
    let cleanError = error
    if (cleanError.includes('\n')) {
      cleanError = cleanError.split('\n')[0] // 只取第一行
    }
    if (cleanError.includes('Error:')) {
      cleanError = cleanError.replace(/Error:\s*/g, '')
    }

    // 常见错误转换 —— key=技术子串(匹配用), value=i18n key(展示用)
    const errorMap: Record<string, string> = {
      'Timed out while waiting for handshake': 'error.sshHandshakeTimeout',
      'handshake timeout': 'error.sshHandshakeTimeout',
      'Authentication failed': 'error.authFailed',
      'connection refused': 'error.connectionRefused',
      'Connection refused': 'error.connectionRefused',
      'Connection timeout': 'error.connectionTimeout',
      'connection timeout': 'error.connectionTimeout',
      'Host key verification failed': 'error.hostKeyVerification',
      'Network is unreachable': 'error.networkUnreachable',
      'ENOTFOUND': 'error.hostNotFound',
      'ECONNREFUSED': 'error.connectionRefused',
      'ETIMEDOUT': 'error.connectionTimeout',
      'EHOSTUNREACH': 'error.hostUnreachable',
      'getaddrinfo ENOTFOUND': 'error.dnsResolveFailed',
      'read ECONNRESET': 'error.connectionReset',
      'write ECONNRESET': 'error.connectionReset',
      'socket hang up': 'error.connectionClosed',
      'SSH connection error': 'error.sshConnectionError',
      'All configured authentication methods failed': 'error.allAuthMethodsFailed',
      'private key decrypt failed': 'error.privateKeyDecryptFailed',
      'no such file': 'error.fileNotFound',
      'Permission denied': 'error.permissionDenied',
      'Too many authentication failures': 'error.tooManyAuthFailures',
    }

    // 查找匹配的错误
    for (const [key, value] of Object.entries(errorMap)) {
      if (cleanError.includes(key)) {
        return t(value)
      }
    }

    // 如果还是太长，截断
    if (cleanError.length > 30) {
      return cleanError.substring(0, 30) + t('error.truncatedSuffix')
    }
    return cleanError
  }

  // 无会话且本 pane 未开 MCP / dsh Web 时不渲染标签栏，避免空 28px 条；打开时仍需标签栏承载页签
  if (paneSessions.length === 0 && mcpAuditPaneId !== pane.id && dshWebPaneId !== pane.id) return null

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

  // 本 pane 是否正显示 dsh web（web 页签激活态 / 终端标签激活态都据此判定）
  const webActiveHere = dshWebPaneId === pane.id && dshWebActive

  return (
    <div className="flex items-center bg-[var(--bg-rack)] border-b border-[var(--rule)] h-[28px]">
      {/* 左滚动按钮 */}
      <button
        onClick={scrollLeft}
        title={t('pane.scrollLeft')}
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
            title={t('pane.tabHint')}
            className={cn(
              'flex items-center gap-1 px-2 h-full border-r border-[var(--rule)] cursor-pointer transition-colors flex-shrink-0 min-w-[120px]',
              pane.activeSessionId === session.id && mcpAuditPaneId !== pane.id && !webActiveHere
                ? 'bg-[var(--terminal-bg)] text-[var(--text-rack)] border-b-2 border-b-[var(--amber)]'
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
            {session.lockedByMcp && (
              <span
                title={t('pane.lockedByMcp', { defaultValue: 'MCP is using this terminal' })}
                className="text-[10px] px-1 rounded bg-[var(--amber)]/20 text-[var(--amber)] flex-shrink-0"
              >
                🔒
              </span>
            )}
            {session.status === 'connecting' ? (
              // connecting 不显示文字,改用 amber 呼吸点指示"连接中",避免误读为空闲态
              <span
                title={t('pane.connecting')}
                aria-label={t('pane.connecting')}
                className="w-[6px] h-[6px] rounded-full bg-[var(--amber)] animate-pulse flex-shrink-0"
              />
            ) : (
              getStatusLabel(session.status) && (
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
              )
            )}
            <button
              onClick={async (e) => {
                e.stopPropagation()
                const sessionId = session.id
                // 1. 先从 pane 移除页签：同步、与连接状态无关，确保 UI 立刻响应
                removeSessionFromPane(pane.id, sessionId)
                // 2. 如果该 session 正被 LIVE 标签折叠隐藏，一并清掉 hidden 标记，避免残留
                if (hiddenTabSessions[sessionId]) {
                  toggleLiveSessionTabs([sessionId], false)
                }
                // 3. 通知后端断开并清理 store/terminal；已经 disconnected/error 的会话在前端短路，不再调后端
                try {
                  await useSessionStore.getState().disconnectSession(sessionId)
                } catch (error) {
                  // 最后一道防线：即使清理 store 也失败，页签已经关闭，避免未捕获 Promise rejection
                  console.error('Failed to disconnect session after closing tab:', error)
                }
                // 4. 从 sessions 数组彻底移除 —— 与 Sidebar LIVE 段的 handleCloseLive 保持一致
                removeLiveSession(sessionId)
              }}
              title={t('pane.closeConnection')}
              className="ml-auto w-[14px] h-[14px] flex items-center justify-center text-xs hover:bg-[var(--error-rack)] hover:text-white rounded-[2px] transition-colors"
            >
              ✕
            </button>
          </div>
        ))}
        {/* MCP 活动页签 -- 仅在本 pane 打开 MCP 时出现（非常驻）；入口为标题栏 MCP 状态片；✕ / 点标签 / ESC 关闭 */}
        {mcpAuditPaneId === pane.id && (
          <div
            data-tab-id="__mcp_audit__"
            onClick={handleMcpTabClick}
            title={t('pane.mcpTabHint')}
            className="flex items-center gap-1 px-2 h-full border-r border-[var(--rule)] cursor-pointer transition-colors flex-shrink-0 min-w-[120px] bg-[var(--terminal-bg)] text-[var(--text-rack)] border-b-2 border-b-[var(--amber)]"
          >
            <span className="text-xs truncate max-w-[150px]">{t('pane.mcpTab')}</span>
            <button
              onClick={(e) => { e.stopPropagation(); usePaneStore.getState().closeMcpAudit() }}
              title={t('mcpAudit.close')}
              className="ml-auto w-[14px] h-[14px] flex items-center justify-center text-xs hover:bg-[var(--error-rack)] hover:text-white rounded-[2px] transition-colors"
            >
              ✕
            </button>
          </div>
        )}
        {/* dsh Web UI 页签 -- 单例，仅本 pane 打开 web 时渲染；点页签切回 web，✕ 关闭并回收子进程。
            可拖拽：拖到本 pane 或其他 pane 的边缘拆成独立分屏，拖到中心则改挂载到该 pane。 */}
        {dshWebPaneId === pane.id && dshWeb && (
          <div
            data-tab-id="__dsh_web__"
            onClick={() => usePaneStore.getState().activateDshWeb()}
            title={dshWeb.cwd ?? t('dsh.webTitle')}
            draggable={webActiveHere}
            onDragStart={(e) => {
              e.dataTransfer.setData('text/plain', '__dsh_web__')
              e.dataTransfer.effectAllowed = 'move'
              setDraggingDshWeb(true)
            }}
            onDragEnd={() => setDraggingDshWeb(false)}
            className={cn(
              'flex items-center gap-1 px-2 h-full border-r border-[var(--rule)] cursor-pointer transition-colors flex-shrink-0 min-w-[120px]',
              webActiveHere
                ? 'bg-[var(--terminal-bg)] text-[var(--text-rack)] border-b-2 border-b-[var(--amber)]'
                : 'bg-[var(--bg-rack)] text-[var(--text-rack-mute)] hover:bg-[var(--bg-slot)] hover:text-[var(--text-rack)]'
            )}
          >
            <span className="text-xs truncate max-w-[150px]">{dshWeb.name}</span>
            <button
              onClick={(e) => { e.stopPropagation(); usePaneStore.getState().closeDshWeb() }}
              title={t('dsh.webClose')}
              className="ml-auto w-[14px] h-[14px] flex items-center justify-center text-xs hover:bg-[var(--error-rack)] hover:text-white rounded-[2px] transition-colors"
            >
              ✕
            </button>
          </div>
        )}
      </div>

      {/* 右滚动按钮 */}
      <button
        onClick={scrollRight}
        title={t('pane.scrollRight')}
        className="w-[20px] h-full flex items-center justify-center text-[var(--text-rack-mute)] hover:text-[var(--text-rack)] hover:bg-[var(--bg-elev)] transition-colors"
      >
        ›
      </button>
    </div>
  )
}

export default PaneTabBar
