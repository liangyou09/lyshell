import React, { useMemo } from 'react'
import { useTransferStore } from '../../stores'
import type { TransferTask } from '@shared/types'
import { TransferDirection } from '@shared/types'

interface TransferPanelProps {
  sessionId: string
}

// 格式化大小（组件外定义）
const formatSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

// 单个失败任务项组件（使用 memo 优化）
const TransferTaskItem = React.memo(({ task }: { task: TransferTask }) => {
  return (
    <div className="px-3 py-1.5 border-b border-[#3C3C3C]/50 hover:bg-[#252526]">
      <div className="flex items-center gap-1">
        <span className="text-xs font-medium w-[32px] text-red-400">失败</span>
        <span className="text-xs">
          {task.direction === TransferDirection.UPLOAD ? '⬆' : '⬇'}
        </span>
        <span className="text-sm text-gray-200 truncate flex-1">
          {task.fileName}
        </span>
        <span className="text-xs text-gray-400">
          {formatSize(task.fileSize)}
        </span>
      </div>
      {task.error && (
        <div className="text-xs text-red-400 truncate mt-0.5" title={task.error}>
          {task.error}
        </div>
      )}
    </div>
  )
})

TransferTaskItem.displayName = 'TransferTaskItem'

/**
 * 传输任务面板（优化版）
 */
const TransferPanel: React.FC<TransferPanelProps> = React.memo(({ sessionId }) => {
  const clearFailed = useTransferStore(state => state.clearFailed)
  const failedTasks = useTransferStore(state => state.failedTasks)
  const sessionTasks = useMemo(() => failedTasks.filter(t => t.sessionId === sessionId), [failedTasks, sessionId])

  if (sessionTasks.length === 0) {
    return null
  }

  return (
    <div className="bg-[#1E1E1E] border-t border-[#3C3C3C]">
      {/* 标题栏 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#3C3C3C]">
        <span className="text-sm text-gray-200">
          传输失败 ({sessionTasks.length})
        </span>
        <button
          onClick={clearFailed}
          className="text-xs text-gray-400 hover:text-white transition-colors"
        >
          清除失败
        </button>
      </div>

      {/* 失败列表 */}
      <div className="max-h-[150px] overflow-auto">
        {sessionTasks.map(task => (
          <TransferTaskItem key={task.id} task={task} />
        ))}
      </div>
    </div>
  )
})

TransferPanel.displayName = 'TransferPanel'

export default TransferPanel