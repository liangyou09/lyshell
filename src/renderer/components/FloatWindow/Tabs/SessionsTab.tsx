import React, { useEffect, useState } from 'react'
import cn from 'classnames'
import type { SessionConfig, ConnectionStatus } from '@shared/types'
import { useSessionStore } from '../../../stores/session-store'
import { useQuickConnect } from '../../../hooks/useConnection'
import SessionDialog from '../../SessionDialog/SessionDialog'

interface SessionsTabProps {
  searchQuery: string
}

/**
 * 会话页签组件
 */
const SessionsTab: React.FC<SessionsTabProps> = ({ searchQuery }) => {
  const { sessions, loadSessions, createSession } = useSessionStore()
  const { quickConnect } = useQuickConnect()
  const [showDialog, setShowDialog] = useState(false)

  // 加载会话
  useEffect(() => {
    loadSessions()
  }, [loadSessions])

  // 过滤会话
  const filteredSessions = sessions.filter(s =>
    !searchQuery ||
    s.config.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    s.config.tags.some(t => t.includes(searchQuery))
  )

  // 常用会话
  const favorites = filteredSessions.filter(s => s.config.tags.includes('favorite'))

  // 其他会话
  const others = filteredSessions.filter(s => !s.config.tags.includes('favorite'))

  // 点击已存在会话 = 触发连接
  const handleConnect = async (session: SessionConfig) => {
    try {
      await quickConnect(session)
      // 连接成功后不关闭浮窗，让用户看到状态变化
      // 主窗口会自动打开终端标签
    } catch (error) {
      console.error('Connect failed:', error)
    }
  }

  // 新建会话：浮窗里只入库、不自动连接。
  // 返回 null 告诉 dialog 跳过 linking 等待，直接关闭。
  // 用户之后从侧边栏或这里再点一次会话项触发连接。
  const handleCreateSession = async (config: SessionConfig): Promise<null> => {
    try {
      await createSession(config)
    } catch (error) {
      console.error('Create session failed:', error)
    }
    return null
  }

  return (
    <div className="space-y-4">
      {/* 常用会话 */}
      {favorites.length > 0 && (
        <div>
          <div className="flex items-center gap-2 px-2 py-1 text-xs text-gray-400">
            <span>⭐</span>
            <span>常用会话 ({favorites.length})</span>
          </div>
          <div className="space-y-1">
            {favorites.map((session) => (
              <SessionItem
                key={session.id}
                config={session.config}
                status={session.status}
                onClick={() => handleConnect(session.config)}
              />
            ))}
          </div>
        </div>
      )}

      {/* 其他会话 */}
      {others.length > 0 && (
        <div>
          <div className="flex items-center gap-2 px-2 py-1 text-xs text-gray-400">
            <span>📜</span>
            <span>会话列表 ({others.length})</span>
          </div>
          <div className="space-y-1">
            {others.map((session) => (
              <SessionItem
                key={session.id}
                config={session.config}
                status={session.status}
                onClick={() => handleConnect(session.config)}
              />
            ))}
          </div>
        </div>
      )}

      {/* 无会话 */}
      {filteredSessions.length === 0 && (
        <div className="text-center py-8 text-gray-500">
          <p>暂无会话配置</p>
          <p className="text-sm mt-1">点击下方按钮创建新会话</p>
        </div>
      )}

      {/* 新建会话按钮 */}
      <div className="px-2">
        <button
          onClick={() => setShowDialog(true)}
          className="w-full py-1.5 text-sm text-[#0078D4] hover:bg-[#3C3C3C] rounded transition-colors"
        >
          + 新建会话
        </button>
      </div>

      {/* 会话创建对话框 */}
      <SessionDialog
        open={showDialog}
        onClose={() => setShowDialog(false)}
        onSubmit={handleCreateSession}
      />
    </div>
  )
}

/**
 * 会话项组件
 */
const SessionItem: React.FC<{
  config: SessionConfig
  status: ConnectionStatus
  onClick: () => void
}> = ({ config, status, onClick }) => {
  const typeIcon = config.type === 'ssh' ? '🖥' : config.type === 'telnet' ? '📜' : '📟'

  // 获取连接地址
  const getAddress = () => {
    if (config.ssh) return `ssh://${config.ssh.host}:${config.ssh.port}`
    if (config.telnet) return `telnet://${config.telnet.host}:${config.telnet.port}`
    if (config.serial) return `${config.serial.path} @ ${config.serial.baudRate}`
    return ''
  }

  // 状态显示
  const statusIcon = {
    connected: '🟢',
    connecting: '🟡',
    disconnected: '⚪',
    error: '🔴',
    reconnecting: '🟡'
  }[status]

  const statusText = {
    connected: '已连接',
    connecting: '连接中',
    disconnected: '未连接',
    error: '错误',
    reconnecting: '重连中'
  }[status]

  return (
    <div
      onClick={onClick}
      className={cn(
        'px-3 py-2 rounded cursor-pointer transition-all',
        'hover:bg-[#3C3C3C] hover:translate-x-1',
        status === 'connecting' && 'animate-pulse'
      )}
    >
      <div className="flex items-start gap-2">
        <span className="text-sm">{typeIcon}</span>
        <div className="flex-1 min-w-0">
          <div className="text-sm text-white truncate">{config.name}</div>
          <div className="text-xs text-gray-500 truncate">{getAddress()}</div>
        </div>
        <div className="text-right">
          <span className="text-xs">{statusIcon}</span>
          <div className="text-xs text-gray-500">{statusText}</div>
        </div>
      </div>
    </div>
  )
}

export default SessionsTab