import React from 'react'
import cn from 'classnames'
import { ExecutionHistory, ExecutionStatus } from '@shared/types'

interface HistoryTabProps {
  searchQuery: string
}

/**
 * 历史页签组件
 */
const HistoryTab: React.FC<HistoryTabProps> = ({ searchQuery }) => {
  // 模拟数据
  const favoriteHistory: ExecutionHistory[] = [
    {
      id: '1',
      command: 'tar -czf backup.tar.gz /data',
      sessionId: '1',
      sessionName: 'prod-01',
      executedAt: new Date('2026-05-27 10:30'),
      status: ExecutionStatus.SUCCESS,
      duration: 45200,
      isFavorite: true
    },
    {
      id: '2',
      command: 'systemctl status nginx && systemctl status mysql',
      sessionId: '1',
      sessionName: 'prod-01',
      executedAt: new Date('2026-05-26 15:00'),
      status: ExecutionStatus.SUCCESS,
      duration: 1500,
      isFavorite: true
    }
  ]

  const recentHistory: ExecutionHistory[] = [
    {
      id: '3',
      command: 'ls -la',
      sessionId: '1',
      sessionName: 'prod-01',
      executedAt: new Date(Date.now() - 5 * 60 * 1000),
      status: ExecutionStatus.SUCCESS,
      duration: 200,
      isFavorite: false
    },
    {
      id: '4',
      command: 'cd /var/log && tail -100 syslog',
      sessionId: '1',
      sessionName: 'prod-01',
      executedAt: new Date(Date.now() - 10 * 60 * 1000),
      status: ExecutionStatus.SUCCESS,
      duration: 500,
      isFavorite: false
    },
    {
      id: '5',
      command: 'docker ps -a',
      sessionId: '2',
      sessionName: 'dev-02',
      executedAt: new Date(Date.now() - 30 * 60 * 1000),
      status: ExecutionStatus.FAILED,
      exitCode: 1,
      isFavorite: false
    },
    {
      id: '6',
      command: 'systemctl status nginx',
      sessionId: '1',
      sessionName: 'prod-01',
      executedAt: new Date(Date.now() - 60 * 60 * 1000),
      status: ExecutionStatus.SUCCESS,
      duration: 300,
      isFavorite: false
    }
  ]

  // 过滤
  const filterHistory = (history: ExecutionHistory[]) => {
    if (!searchQuery) return history
    return history.filter(h =>
      h.command.toLowerCase().includes(searchQuery.toLowerCase()) ||
      h.sessionName.toLowerCase().includes(searchQuery.toLowerCase())
    )
  }

  // 格式化时间
  const formatTime = (date: Date) => {
    const diff = Date.now() - date.getTime()
    if (diff < 60 * 1000) return '刚刚'
    if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60 / 1000)}分钟前`
    if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 60 / 60 / 1000)}小时前`
    return date.toLocaleDateString()
  }

  // 执行
  const handleExecute = (history: ExecutionHistory) => {
    console.log('Re-execute:', history.command)
  }

  // 切换收藏
  const handleToggleFavorite = (history: ExecutionHistory) => {
    console.log('Toggle favorite:', history.id)
  }

  return (
    <div className="space-y-4">
      {/* 收藏的命令 */}
      {favoriteHistory.length > 0 && (
        <div>
          <div className="flex items-center gap-2 px-2 py-1 text-xs text-gray-400">
            <span>⭐</span>
            <span>收藏的命令 ({favoriteHistory.length})</span>
          </div>
          <div className="space-y-1">
            {filterHistory(favoriteHistory).map((history) => (
              <HistoryItem
                key={history.id}
                history={history}
                onExecute={() => handleExecute(history)}
                onToggleFavorite={() => handleToggleFavorite(history)}
                formatTime={formatTime}
              />
            ))}
          </div>
        </div>
      )}

      {/* 最近执行 */}
      <div>
        <div className="flex items-center gap-2 px-2 py-1 text-xs text-gray-400">
          <span>📜</span>
          <span>最近执行 ({recentHistory.length})</span>
        </div>
        <div className="space-y-1">
          {filterHistory(recentHistory).map((history) => (
            <HistoryItem
              key={history.id}
              history={history}
              onExecute={() => handleExecute(history)}
              onToggleFavorite={() => handleToggleFavorite(history)}
              formatTime={formatTime}
            />
          ))}
        </div>
      </div>

      {/* 底部按钮 */}
      <div className="flex gap-2 px-2">
        <button className="px-3 py-1.5 text-sm text-gray-400 hover:text-white transition-colors">
          清空历史
        </button>
        <button className="px-3 py-1.5 text-sm text-gray-400 hover:text-white transition-colors">
          导出历史
        </button>
      </div>
    </div>
  )
}

/**
 * 历史项组件
 */
const HistoryItem: React.FC<{
  history: ExecutionHistory
  onExecute: () => void
  onToggleFavorite: () => void
  formatTime: (date: Date) => string
}> = ({ history, onExecute, onToggleFavorite, formatTime }) => {
  const statusIcon = {
    [ExecutionStatus.SUCCESS]: '✅',
    [ExecutionStatus.FAILED]: '❌',
    [ExecutionStatus.WARNING]: '⚠️',
    [ExecutionStatus.RUNNING]: '⏳'
  }[history.status]

  const statusClass = {
    [ExecutionStatus.SUCCESS]: 'text-green-500',
    [ExecutionStatus.FAILED]: 'text-red-500',
    [ExecutionStatus.WARNING]: 'text-yellow-500',
    [ExecutionStatus.RUNNING]: 'text-blue-500'
  }[history.status]

  return (
    <div
      className={cn(
        'px-3 py-2 rounded cursor-pointer transition-all',
        'hover:bg-[#3C3C3C] hover:translate-x-1'
      )}
      onDoubleClick={onExecute}
    >
      <div className="flex items-start gap-2">
        {/* 收藏图标 */}
        <button
          onClick={onToggleFavorite}
          className="text-sm"
        >
          {history.isFavorite ? '⭐' : '📋'}
        </button>

        {/* 内容 */}
        <div className="flex-1 min-w-0">
          <div className="text-sm text-white truncate font-mono">{history.command}</div>
          <div className="text-xs text-gray-500 truncate">
            {history.sessionName} · {formatTime(history.executedAt)}
          </div>
        </div>

        {/* 状态 */}
        <div className="text-right">
          <span className={cn('text-xs', statusClass)}>{statusIcon}</span>
        </div>
      </div>
    </div>
  )
}

export default HistoryTab