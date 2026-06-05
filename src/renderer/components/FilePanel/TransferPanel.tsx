import React, { useMemo } from 'react'
import cn from 'classnames'
import { useTransferStore } from '../../stores'
import { TransferStatus, TransferDirection } from '@shared/types'

interface TransferPanelProps {
  sessionId: string
}

// 格式化速度（组件外定义，避免每次渲染重新创建）
const formatSpeed = (speed?: number) => {
  if (!speed) return ''
  if (speed < 1024) return `${speed}B/s`
  if (speed < 1024 * 1024) return `${(speed / 1024).toFixed(1)}KB/s`
  return `${(speed / (1024 * 1024)).toFixed(1)}MB/s`
}

// 格式化大小（组件外定义）
const formatSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

// 格式化时长（组件外定义）
const formatDuration = (startTime?: Date, endTime?: Date) => {
  if (!startTime || !endTime) return ''
  const ms = endTime.getTime() - startTime.getTime()
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}min`
}

// 获取状态颜色（组件外定义）
const getStatusColor = (status: TransferStatus) => {
  switch (status) {
    case TransferStatus.COMPLETED: return 'text-green-400'
    case TransferStatus.FAILED: return 'text-red-400'
    case TransferStatus.CANCELLED: return 'text-gray-400'
    case TransferStatus.TRANSFERRING: return 'text-blue-400'
    default: return 'text-gray-300'
  }
}

// 获取状态标签（组件外定义）
const getStatusLabel = (status: TransferStatus) => {
  switch (status) {
    case TransferStatus.PENDING: return '等待中'
    case TransferStatus.TRANSFERRING: return '传输中'
    case TransferStatus.COMPLETED: return '已完成'
    case TransferStatus.FAILED: return '失败'
    case TransferStatus.CANCELLED: return '已取消'
    default: return status
  }
}

// 单个任务项组件（使用 memo 优化）
const TransferTaskItem = React.memo(({ task, onCancel, onRemove, onOpenFolder }: {
  task: any
  onCancel: (id: string) => void
  onRemove: (id: string) => void
  onOpenFolder: (path: string) => void
}) => {
  return (
    <div className="px-3 py-1.5 border-b border-[#3C3C3C]/50 hover:bg-[#252526]">
      {/* 第一行：进度、方向、文件名、大小、时间/速度、操作 */}
      <div className="flex items-center gap-1">
        {/* 进度百分比 */}
        <span className={`text-xs font-medium w-[32px] ${getStatusColor(task.status)}`}>
          {task.progress}%
        </span>

        {/* 方向图标 */}
        <span className="text-xs">
          {task.direction === TransferDirection.UPLOAD ? '⬆' : '⬇'}
        </span>

        {/* 文件名 */}
        <span className="text-sm text-gray-200 truncate flex-1">
          {task.fileName}
        </span>

        {/* 文件大小 */}
        <span className="text-xs text-gray-400">
          {formatSize(task.fileSize)}
        </span>

        {/* 传输速度（传输中）或时长（完成后） */}
        {task.status === TransferStatus.TRANSFERRING && (
          <span className="text-xs text-gray-400">
            {formatSpeed(task.speed)}
          </span>
        )}
        {task.status === TransferStatus.COMPLETED && (
          <span className="text-xs text-gray-400">
            {formatDuration(task.startTime, task.endTime)}
          </span>
        )}

        {/* 操作按钮 */}
        <div className="flex gap-1">
          {task.status === TransferStatus.COMPLETED && task.direction === TransferDirection.DOWNLOAD && (
            <button
              onClick={() => onOpenFolder(task.localPath)}
              className="text-xs text-gray-400 hover:text-blue-400 transition-colors"
              title="打开文件夹"
            >
              📂
            </button>
          )}
          {task.status === TransferStatus.TRANSFERRING && (
            <button
              onClick={() => onCancel(task.id)}
              className="text-xs text-gray-400 hover:text-red-400 transition-colors"
              title="取消"
            >
              ✕
            </button>
          )}
          {(task.status === TransferStatus.COMPLETED ||
            task.status === TransferStatus.FAILED ||
            task.status === TransferStatus.CANCELLED) && (
            <button
              onClick={() => onRemove(task.id)}
              className="text-xs text-gray-400 hover:text-white transition-colors"
              title="删除"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* 第二行：进度条（传输中）或 MD5（完成后） */}
      {task.status === TransferStatus.COMPLETED && task.md5 ? (
        <div className="text-xs text-green-500 truncate mt-0.5" title={task.md5}>
          MD5: {task.md5}
        </div>
      ) : task.status === TransferStatus.TRANSFERRING ? (
        <div className="h-[3px] bg-[#3C3C3C] rounded overflow-hidden mt-0.5">
          <div
            className="h-full bg-[#0078D4] transition-all"
            style={{ width: `${task.progress}%` }}
          />
        </div>
      ) : null}
    </div>
  )
})

TransferTaskItem.displayName = 'TransferTaskItem'

/**
 * 传输任务面板（优化版）
 */
const TransferPanel: React.FC<TransferPanelProps> = React.memo(({ sessionId }) => {
  const { cancelTask, removeTask, clearCompleted } = useTransferStore()
  // 直接订阅 tasks 数组，确保进度更新时组件重新渲染
  const tasks = useTransferStore(state => state.tasks)
  const sessionTasks = useMemo(() => tasks.filter(t => t.sessionId === sessionId), [tasks, sessionId])

  if (sessionTasks.length === 0) {
    return null
  }

  return (
    <div className="bg-[#1E1E1E] border-t border-[#3C3C3C]">
      {/* 标题栏 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#3C3C3C]">
        <span className="text-sm text-gray-200">
          传输任务 ({sessionTasks.length})
        </span>
        <div className="flex gap-2">
          <button
            onClick={clearCompleted}
            className="text-xs text-gray-400 hover:text-white transition-colors"
          >
            清除已完成
          </button>
        </div>
      </div>

      {/* 任务列表 */}
      <div className="max-h-[150px] overflow-auto">
        {sessionTasks.map(task => (
          <TransferTaskItem
            key={task.id}
            task={task}
            onCancel={cancelTask}
            onRemove={removeTask}
            onOpenFolder={window.electronAPI.openFolder}
          />
        ))}
      </div>
    </div>
  )
})

TransferPanel.displayName = 'TransferPanel'

export default TransferPanel