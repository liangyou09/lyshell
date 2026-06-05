import React, { useState, useEffect } from 'react'

interface DownloadProgress {
  taskId: string
  fileName: string
  progress: number
  transferredSize: number
  fileSize: number
  speed: number
  status: 'downloading' | 'uploading' | 'completed' | 'failed'
  error?: string
  direction: 'download' | 'upload'  // 方向
  localPath?: string  // 本地路径（用于打开文件夹）
}

// 格式化文件大小
const formatSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`
}

// 格式化速度
const formatSpeed = (bytesPerSecond: number) => {
  if (bytesPerSecond < 1024) return `${bytesPerSecond}B/s`
  if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(1)}KB/s`
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)}MB/s`
}

// 全局文件名存储（用于进度条显示）
const fileNameStore: Map<string, string> = new Map()
// 本地路径存储（用于打开文件夹）
const localPathStore: Map<string, string> = new Map()

// 导出函数：注册文件名
export const registerDownloadFileName = (taskId: string, fileName: string, localPath?: string) => {
  fileNameStore.set(taskId, fileName)
  if (localPath) {
    localPathStore.set(taskId, localPath)
  }
}

// 导出函数：清理所有下载进度
export const clearAllDownloads = () => {
  fileNameStore.clear()
  localPathStore.clear()
}

// 导出函数：清理指定下载
export const clearDownload = (taskId: string) => {
  fileNameStore.delete(taskId)
  localPathStore.delete(taskId)
}

/**
 * 进度条组件 - 显示在文件管理器最底部
 * 支持下载和上传进度显示
 */
const DownloadProgressBar: React.FC = () => {
  const [downloads, setDownloads] = useState<DownloadProgress[]>([])

  // 清理指定任务
  const removeDownload = (taskId: string) => {
    setDownloads(prev => prev.filter(d => d.taskId !== taskId))
    fileNameStore.delete(taskId)
    localPathStore.delete(taskId)
  }

  // 打开文件夹
  const openFolder = (localPath?: string) => {
    if (localPath) {
      window.electronAPI.openFolder(localPath)
    }
  }

  // 清理所有任务
  const removeAllDownloads = () => {
    setDownloads([])
    fileNameStore.clear()
  }

  // 监听下载进度
  useEffect(() => {
    const cleanup = window.electronAPI.onFileProgress((event, data: any) => {
      if (data.md5Update) return  // 忽略 MD5 更新

      const taskId = data.taskId
      const fileName = fileNameStore.get(taskId) || '未知文件'
      const localPath = localPathStore.get(taskId)
      const direction = data.direction || 'download'

      if (data.failed) {
        // 失败
        setDownloads(prev => prev.map(d =>
          d.taskId === taskId ? { ...d, status: 'failed', error: data.error } : d
        ))
        fileNameStore.delete(taskId)
        localPathStore.delete(taskId)
      } else if (data.completed) {
        // 完成 - 不自动消失
        setDownloads(prev => prev.map(d =>
          d.taskId === taskId ? {
            ...d,
            status: 'completed',
            progress: 100,
            direction,
            localPath
          } : d
        ))
        fileNameStore.delete(taskId)
        localPathStore.delete(taskId)
      } else {
        // 进度更新
        setDownloads(prev => {
          const existing = prev.find(d => d.taskId === taskId)
          if (existing) {
            return prev.map(d =>
              d.taskId === taskId ? {
                ...d,
                fileName,
                progress: data.progress,
                transferredSize: data.transferredSize,
                fileSize: data.fileSize,
                speed: data.speed,
                direction,
                localPath
              } : d
            )
          } else {
            // 新任务 - 添加到数组开头
            return [{
              taskId,
              fileName,
              progress: data.progress || 0,
              transferredSize: data.transferredSize || 0,
              fileSize: data.fileSize || 0,
              speed: data.speed || 0,
              status: direction === 'upload' ? 'uploading' : 'downloading',
              direction,
              localPath
            }, ...prev]
          }
        })
      }
    })

    return cleanup
  }, [])

  if (downloads.length === 0) return null

  // 显示最新的下载任务（数组第一个）
  const current = downloads[0]

  // 如果有多个任务，显示数量
  const hasMultiple = downloads.length > 1

  return (
    <div
      className="border-t border-[#3C3C3C] bg-[#1E1E1E] px-2 py-2 transition-colors"
    >
      {/* 文件名、状态和操作按钮 */}
      <div className="flex items-center gap-2 mb-1">
        <span className={`text-xs truncate flex-1 ${
          current.status === 'failed' ? 'text-red-400' :
          current.status === 'completed' ? 'text-green-400' : 'text-white'
        }`} title={current.fileName}>
          {current.status === 'uploading' ? '⬆ ' :
           current.status === 'downloading' ? '⬇ ' :
           current.status === 'completed' ? '✓ ' : '✕ '}
          {current.fileName}
          <span className="text-gray-500 ml-1">
            ({current.direction === 'upload' ? '上传' : '下载'})
          </span>
        </span>
        <span className="text-xs text-gray-400">
          {current.status === 'downloading' || current.status === 'uploading' ? `${current.progress}%` :
           current.status === 'completed' ? '完成' : '失败'}
          {hasMultiple && ` (+${downloads.length - 1})`}
        </span>
        {/* 打开文件夹按钮（仅下载完成时显示） */}
        {current.status === 'completed' && current.direction === 'download' && current.localPath && (
          <button
            onClick={() => openFolder(current.localPath)}
            className="text-xs text-gray-400 hover:text-white px-1"
            title="打开文件夹"
          >
            📂
          </button>
        )}
        {/* 关闭按钮 */}
        <button
          onClick={(e) => {
            e.stopPropagation()
            removeDownload(current.taskId)
          }}
          className="text-xs text-gray-400 hover:text-white px-1"
          title="关闭"
        >
          ✕
        </button>
      </div>

      {/* 进度条 */}
      <div className="h-2 bg-[#3C3C3C] rounded overflow-hidden">
        <div
          className={`h-full transition-all duration-300 ${
            current.status === 'failed' ? 'bg-red-500' :
            current.status === 'completed' ? 'bg-green-500' : 'bg-[#0078D4]'
          }`}
          style={{ width: `${current.progress}%` }}
        />
      </div>

      {/* 速度和大小 */}
      {(current.status === 'downloading' || current.status === 'uploading') && current.fileSize > 0 && (
        <div className="flex justify-between text-xs text-gray-500 mt-1">
          <span>{formatSize(current.transferredSize)} / {formatSize(current.fileSize)}</span>
          <span>{current.speed > 0 ? formatSpeed(current.speed) : '计算中...'}</span>
        </div>
      )}

      {/* 错误信息 */}
      {current.status === 'failed' && current.error && (
        <div className="text-xs text-red-400 mt-1 truncate" title={current.error}>
          {current.error}
        </div>
      )}
    </div>
  )
}

export default DownloadProgressBar