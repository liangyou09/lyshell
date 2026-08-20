import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import DownloadHistoryList from './DownloadHistoryList'
import FileBrowser from './FileBrowser'

interface SessionInfo {
  id: string
  name: string
  status: string
  host?: string
  port?: number
}

interface FileInfo {
  name: string
  path: string
  isDir: boolean
  size: number
  modifyTime: Date | string
}

interface FileManagerFloatProps {
  visible: boolean
  onClose: () => void
  sessions: SessionInfo[]
}

/**
 * 文件管理浮窗 - 侧边栏按钮下方显示
 */
const FileManagerFloat: React.FC<FileManagerFloatProps> = ({ visible, onClose, sessions }) => {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<'files' | 'history'>('files')
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [files, setFiles] = useState<FileInfo[]>([])
  const [currentPath, setCurrentPath] = useState('/')
  const [loading, setLoading] = useState(false)
  const [filterPattern, setFilterPattern] = useState('')

  // 选择第一个已连接的会话
  useEffect(() => {
    if (sessions.length > 0 && !selectedSessionId) {
      const connected = sessions.find(s => s.status === 'connected')
      if (connected) {
        setSelectedSessionId(connected.id)
      }
    }
  }, [sessions])

  // 加载文件列表
  useEffect(() => {
    if (selectedSessionId && activeTab === 'files') {
      loadFiles(selectedSessionId, currentPath)
    }
  }, [selectedSessionId, currentPath, activeTab])

  const loadFiles = async (sessionId: string, path: string) => {
    setLoading(true)
    try {
      const result = await window.electronAPI.fileList(sessionId, path)
      if (result.success) {
        setFiles(result.data || [])
      }
    } catch (err) {
      console.error('Failed to load files:', err)
    }
    setLoading(false)
  }

  // 进入目录
  const handleEnterDir = (file: FileInfo) => {
    if (file.isDir) {
      setCurrentPath(file.path)
    }
  }

  // 返回上级
  const handleGoUp = () => {
    if (currentPath === '/') return
    const parent = currentPath.substring(0, currentPath.lastIndexOf('/')) || '/'
    setCurrentPath(parent)
  }

  // 下载文件
  const handleDownload = async (file: FileInfo) => {
    if (!selectedSessionId) return

    // 获取下载目录
    const dirResult = await window.electronAPI.getDownloadDir(selectedSessionId)
    if (!dirResult.success) {
      alert(t('fileManager.noDownloadDir'))
      return
    }

    const localPath = `${dirResult.data}/${file.name}`
    const taskId = crypto.randomUUID()

    // 调用下载
    window.electronAPI.fileDownload(selectedSessionId, file.path, localPath, taskId, file.name, file.size)
  }

  // 通配符匹配函数
  const matchPattern = (filename: string, pattern: string): boolean => {
    if (!pattern.trim()) return true
    const regexPattern = pattern
      .replace(/\./g, '\\.')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')
    const regex = new RegExp(`^${regexPattern}$`, 'i')
    return regex.test(filename)
  }

  // 筛选后的文件列表
  const filteredFiles = filterPattern.trim()
    ? files.filter(f => matchPattern(f.name, filterPattern))
    : files

  if (!visible) return null

  return (
    <div className="fixed bottom-[24px] left-[0px] z-40 w-[240px] max-h-[calc(50vh-60px)] bg-[#2D2D30] border border-[#3C3C3C] rounded shadow-lg flex flex-col overflow-hidden">
      {/* 标题栏 */}
      <div className="h-[28px] bg-[#252526] border-b border-[#3C3C3C] flex items-center justify-between px-2">
        <span className="text-xs text-gray-300">{t('fileManager.floatTitle')}</span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setActiveTab('files')}
            className={`px-2 py-0.5 text-xs rounded ${
              activeTab === 'files' ? 'bg-[#0078D4] text-white' : 'text-gray-400 hover:text-white'
            }`}
          >
            {t('fileManager.floatTabFiles')}
          </button>
          <button
            onClick={() => setActiveTab('history')}
            className={`px-2 py-0.5 text-xs rounded ${
              activeTab === 'history' ? 'bg-[#0078D4] text-white' : 'text-gray-400 hover:text-white'
            }`}
          >
            {t('fileManager.floatTabHistory')}
          </button>
          <button
            onClick={onClose}
            className="text-xs text-gray-400 hover:text-white px-1"
          >
            ✕
          </button>
        </div>
      </div>

      {/* 内容区 - 可滚动 */}
      <div className="flex-1 overflow-auto min-h-0">
        {activeTab === 'files' ? (
          <FileBrowser
            files={filteredFiles}
            currentPath={currentPath}
            loading={loading}
            hasSession={!!selectedSessionId}
            sessionId={selectedSessionId}
            filterPattern={filterPattern}
            onFilterChange={setFilterPattern}
            onEnterDir={handleEnterDir}
            onGoUp={handleGoUp}
            onDownload={handleDownload}
            onRefresh={() => selectedSessionId && loadFiles(selectedSessionId, currentPath)}
            onNavigateTo={(absPath) => setCurrentPath(absPath)}
          />
        ) : (
          <DownloadHistoryList sessionId={selectedSessionId} />
        )}
      </div>
    </div>
  )
}

export default FileManagerFloat