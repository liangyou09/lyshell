import React, { useState, useEffect } from 'react'

interface DownloadRecord {
  id: string
  sessionId: string
  sessionName: string
  host: string
  port: number
  fileName: string
  fileSize: number
  startTime: Date
  status: 'success' | 'failed' | 'cancelled'
  localPath: string
  md5?: string
}

// 格式化大小
const formatSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

// 格式化时间
const formatTime = (date: Date) => {
  const d = new Date(date)
  return `${d.getMonth()+1}/${d.getDate()} ${d.getHours()}:${d.getMinutes().toString().padStart(2,'0')}`
}

interface DownloadHistoryListProps {
  sessionId?: string | null
}

/**
 * 下载记录列表子组件
 */
const DownloadHistoryList: React.FC<DownloadHistoryListProps> = ({ sessionId }) => {
  const [records, setRecords] = useState<DownloadRecord[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadRecords()
  }, [sessionId])

  const loadRecords = async () => {
    setLoading(true)
    try {
      const result = await window.electronAPI.getDownloadHistory(sessionId || undefined)
      if (result.success) {
        setRecords(result.data || [])
      }
    } catch (err) {
      console.error('Failed to load history:', err)
    }
    setLoading(false)
  }

  const handleOpenFolder = (localPath: string) => {
    window.electronAPI.openFolder(localPath)
  }

  return (
    <div className="flex flex-col h-full">
      {/* 头部 */}
      <div className="px-2 py-1 border-b border-[#3C3C3C]/50 flex items-center justify-between">
        <span className="text-xs text-gray-400">共 {records.length} 条</span>
        <button
          onClick={loadRecords}
          className="px-1.5 py-0.5 text-xs text-gray-400 hover:text-white bg-[#3C3C3C] rounded"
        >
          ⟳
        </button>
      </div>

      {/* 列表 */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-full text-xs text-gray-500">
            加载中...
          </div>
        ) : records.length === 0 ? (
          <div className="flex items-center justify-center h-full text-xs text-gray-500">
            暂无记录
          </div>
        ) : (
          <div className="space-y-0.5 px-1 py-1">
            {records.map(record => (
              <div
                key={record.id}
                className="px-1.5 py-1 rounded hover:bg-[#3C3C3C] group"
              >
                <div className="flex items-center gap-1.5">
                  {/* 状态 */}
                  <span className={`text-xs ${
                    record.status === 'success' ? 'text-green-400' :
                    record.status === 'failed' ? 'text-red-400' : 'text-gray-400'
                  }`}>
                    {record.status === 'success' ? '✓' : '✕'}
                  </span>
                  {/* 文件名 */}
                  <span className="text-xs text-gray-200 flex-1 truncate">{record.fileName}</span>
                  {/* 来源 */}
                  <span className="text-xs text-gray-500 truncate max-w-[60px]">{record.sessionName}</span>
                  {/* 大小 */}
                  <span className="text-xs text-gray-500">{formatSize(record.fileSize)}</span>
                  {/* 操作 */}
                  {record.status === 'success' && (
                    <button
                      onClick={() => handleOpenFolder(record.localPath)}
                      className="hidden group-hover:block text-xs text-gray-400 hover:text-blue-400"
                    >
                      📂
                    </button>
                  )}
                </div>
                {/* MD5 显示 */}
                {record.status === 'success' && record.md5 && (
                  <div className="text-xs text-green-500 truncate ml-4 mt-0.5" title={`MD5: ${record.md5}`}>
                    MD5: {record.md5.substring(0, 8)}...
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default DownloadHistoryList