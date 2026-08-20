import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n'

interface DownloadRecord {
  id: string
  sessionId: string
  sessionName: string
  host: string
  port: number
  remotePath: string
  localPath: string
  fileName: string
  fileSize: number
  startTime: Date
  endTime?: Date
  status: 'success' | 'failed' | 'cancelled'
  error?: string
  md5?: string
  downloadDir: string
}

// 格式化文件大小（用 i18n 单例取单位）
const formatSize = (bytes: number) => {
  if (bytes < 1024) return i18n.t('file.fileSizeB', { n: bytes })
  if (bytes < 1024 * 1024) return i18n.t('common.sizeKB', { n: (bytes / 1024).toFixed(1) })
  return i18n.t('common.sizeMB', { n: (bytes / (1024 * 1024)).toFixed(1) })
}

// 格式化日期——按当前语言取 locale（zh → zh-CN，en → en-US）
const formatDate = (date: Date) => {
  const d = new Date(date)
  const locale = i18n.language === 'zh' ? 'zh-CN' : 'en-US'
  return d.toLocaleString(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

interface DownloadHistoryPanelProps {
  sessionId?: string | null
}

/**
 * 下载记录面板
 */
const DownloadHistoryPanel: React.FC<DownloadHistoryPanelProps> = ({ sessionId }) => {
  const [records, setRecords] = useState<DownloadRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [groupByServer, setGroupByServer] = useState(true)
  const { t } = useTranslation()

  // 加载下载记录
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
    } catch (error) {
      console.error('Failed to load download history:', error)
    }
    setLoading(false)
  }

  // 删除记录
  const handleDelete = async (recordId: string) => {
    if (!confirm(t('fileManager.deleteRecordConfirm'))) return
    try {
      await window.electronAPI.deleteDownloadRecord(recordId)
      setRecords(records.filter(r => r.id !== recordId))
    } catch (error) {
      console.error('Failed to delete record:', error)
    }
  }

  // 清空所有记录
  const handleClearAll = async () => {
    if (!confirm(t('fileManager.clearAllConfirm'))) return
    try {
      await window.electronAPI.clearDownloadHistory()
      setRecords([])
    } catch (error) {
      console.error('Failed to clear history:', error)
    }
  }

  // 打开文件夹
  const handleOpenFolder = (localPath: string) => {
    window.electronAPI.openFolder(localPath)
  }

  // 按服务器分组
  const groupedRecords = records.reduce((acc, record) => {
    const key = `${record.sessionName} (${record.host}:${record.port})`
    if (!acc[key]) acc[key] = []
    acc[key].push(record)
    return acc
  }, {} as Record<string, DownloadRecord[]>)

  return (
    <div className="flex flex-col h-full">
      {/* 工具栏 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#3C3C3C] bg-[#252526]">
        <span className="text-sm text-gray-300">{t('fileManager.historyTitle', { count: records.length })}</span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setGroupByServer(!groupByServer)}
            className={`px-2 py-1 text-xs rounded ${
              groupByServer ? 'bg-[#0078D4] text-white' : 'bg-[#3C3C3C] text-gray-400'
            }`}
          >
            {groupByServer ? t('fileManager.groupedByServer') : t('fileManager.listView')}
          </button>
          <button
            onClick={handleClearAll}
            className="px-2 py-1 text-xs bg-[#3C3C3C] text-gray-400 hover:text-red-400 rounded"
          >
            {t('fileManager.clear')}
          </button>
          <button
            onClick={loadRecords}
            className="px-2 py-1 text-xs bg-[#3C3C3C] text-gray-400 hover:text-white rounded"
          >
            {t('common.refresh')}
          </button>
        </div>
      </div>

      {/* 记录列表 */}
      <div className="flex-1 overflow-auto rack-scroll">
        {loading ? (
          <div className="flex items-center justify-center h-full text-gray-500">
            {t('fileManager.loading')}
          </div>
        ) : records.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-500">
            {t('fileManager.noDownloadRecords')}
          </div>
        ) : groupByServer ? (
          // 按服务器分组显示
          Object.entries(groupedRecords).map(([server, serverRecords]) => (
            <div key={server} className="border-b border-[#3C3C3C]">
              <div className="px-3 py-2 bg-[#2D2D30] text-sm text-gray-200 flex items-center gap-2">
                <span className="text-xs">📁</span>
                <span>{server}</span>
                <span className="text-xs text-gray-500">({serverRecords.length})</span>
              </div>
              <div className="space-y-1 px-2 py-1">
                {serverRecords.map(record => (
                  <div
                    key={record.id}
                    className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-[#3C3C3C] group"
                  >
                    {/* 状态图标 */}
                    <span className={`text-xs ${
                      record.status === 'success' ? 'text-green-400' :
                      record.status === 'failed' ? 'text-red-400' :
                      'text-gray-400'
                    }`}>
                      {record.status === 'success' ? '✓' : record.status === 'failed' ? '✕' : '○'}
                    </span>
                    {/* 文件名 */}
                    <span className="text-sm text-gray-200 flex-1 truncate">{record.fileName}</span>
                    {/* 大小 */}
                    <span className="text-xs text-gray-400">{formatSize(record.fileSize)}</span>
                    {/* 时间 */}
                    <span className="text-xs text-gray-500">{formatDate(record.startTime)}</span>
                    {/* 操作 */}
                    <div className="hidden group-hover:flex gap-1">
                      {record.status === 'success' && (
                        <button
                          onClick={() => handleOpenFolder(record.localPath)}
                          className="text-xs text-gray-400 hover:text-blue-400"
                          title={t('common.openFolder')}
                        >
                          📂
                        </button>
                      )}
                      <button
                        onClick={() => handleDelete(record.id)}
                        className="text-xs text-gray-400 hover:text-red-400"
                        title={t('fileManager.deleteRecord')}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))
        ) : (
          // 列表视图
          records.map(record => (
            <div
              key={record.id}
              className="flex items-center gap-2 px-3 py-1.5 border-b border-[#3C3C3C]/50 hover:bg-[#3C3C3C] group"
            >
              {/* 状态 */}
              <span className={`text-xs ${
                record.status === 'success' ? 'text-green-400' :
                record.status === 'failed' ? 'text-red-400' :
                'text-gray-400'
              }`}>
                {record.status === 'success' ? '✓' : record.status === 'failed' ? '✕' : '○'}
              </span>
              {/* 文件名 */}
              <span className="text-sm text-gray-200 flex-1 truncate">{record.fileName}</span>
              {/* 服务器 */}
              <span className="text-xs text-gray-400 truncate max-w-[120px]">{record.sessionName}</span>
              {/* 大小 */}
              <span className="text-xs text-gray-400">{formatSize(record.fileSize)}</span>
              {/* 时间 */}
              <span className="text-xs text-gray-500">{formatDate(record.startTime)}</span>
              {/* 操作 */}
              <div className="hidden group-hover:flex gap-1">
                {record.status === 'success' && (
                  <button
                    onClick={() => handleOpenFolder(record.localPath)}
                    className="text-xs text-gray-400 hover:text-blue-400"
                  >
                    📂
                  </button>
                )}
                <button
                  onClick={() => handleDelete(record.id)}
                  className="text-xs text-gray-400 hover:text-red-400"
                >
                  ✕
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

export default DownloadHistoryPanel