import React, { useState, useEffect, useRef } from 'react'
import DownloadHistoryList from './DownloadHistoryList'
import FileBrowser from './FileBrowser'
import DownloadProgressBar, { registerDownloadFileName } from './DownloadProgressBar'
import { usePaneStore } from '../../stores/pane-store'
import { useSessionStore } from '../../stores/session-store'

interface FileInfo {
  name: string
  path: string
  isDir: boolean
  size: number
  modifyTime: Date
}

// 服务器标识（用于区分不同服务器）
interface ServerIdentity {
  host: string
  port: number
  username: string
}

// 获取服务器标识
function getServerIdentity(session: any): ServerIdentity | null {
  const ssh = session?.config?.ssh
  if (!ssh) return null
  return {
    host: ssh.host || '',
    port: ssh.port || 22,
    username: ssh.username || ''
  }
}

// 服务器标识转字符串（用于存储）
function serverKey(identity: ServerIdentity): string {
  return `${identity.host}:${identity.port}:${identity.username}`
}

/**
 * 嵌入式文件管理器 - 用于侧边栏底部
 * 基于服务器（host:port:user），一个服务器只有一个文件会话
 * 只有该服务器所有终端都关闭才清空
 */
const FileManagerPanel: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'files' | 'history'>('files')
  const [files, setFiles] = useState<FileInfo[]>([])
  const [currentPath, setCurrentPath] = useState('/')
  const [loading, setLoading] = useState(false)
  const [filterPattern, setFilterPattern] = useState('')
  const [isDragging, setIsDragging] = useState(false)

  // 每个服务器保存的路径
  const serverPathsRef = useRef<Record<string, string>>({})

  // 获取所有会话和终端
  const { layout, getAllLeafPanes } = usePaneStore()
  const { sessions } = useSessionStore()

  // 获取所有已连接的会话
  const connectedSessions = sessions.filter(s => s.status === 'connected')

  // 获取活动终端的会话
  const activePane = getAllLeafPanes().find(p => p.id === layout.activePaneId)
  const paneSessionId = activePane?.activeSessionId || null
  const paneSession = sessions.find(s => s.id === paneSessionId)

  // 计算当前服务器的标识
  const paneServerIdentity = paneSession?.status === 'connected' ? getServerIdentity(paneSession) : null
  const currentServerKey = paneServerIdentity ? serverKey(paneServerIdentity) : null
  const currentSessionId = paneSessionId

  // 检查当前服务器是否还有连接
  const serverHasConnections = currentServerKey ?
    connectedSessions.some(s => {
      const identity = getServerIdentity(s)
      return identity && serverKey(identity) === currentServerKey
    }) : false

  // 当服务器真正切换时，恢复路径
  const prevServerKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (currentServerKey && currentServerKey !== prevServerKeyRef.current) {
      prevServerKeyRef.current = currentServerKey
      const savedPath = serverPathsRef.current[currentServerKey]
      setCurrentPath(savedPath || '/')
    }
  }, [currentServerKey])

  // 当服务器断开时，清空状态
  useEffect(() => {
    if (prevServerKeyRef.current && !serverHasConnections && currentServerKey === null) {
      prevServerKeyRef.current = null
      setFiles([])
      setCurrentPath('/')
    }
  }, [serverHasConnections, currentServerKey])

  // 拖放处理
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (currentSessionId) setIsDragging(true)
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    if (currentSessionId) setIsDragging(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const currentTarget = e.currentTarget as HTMLElement
    const relatedTarget = e.relatedTarget as HTMLElement
    if (!currentTarget.contains(relatedTarget)) setIsDragging(false)
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)

    if (!currentSessionId) {
      alert('请先连接终端')
      return
    }

    const droppedFiles = e.dataTransfer.files
    if (droppedFiles.length === 0) return

    for (const file of droppedFiles) {
      const localPath = (file as any).path
      if (localPath) handleUpload(localPath, file.name)
    }
  }

  // 加载文件列表 - 只在服务器或路径变化时加载
  useEffect(() => {
    if (currentServerKey && activeTab === 'files' && currentSessionId) {
      loadFiles(currentSessionId, currentPath)
    }
  }, [currentServerKey, currentPath, activeTab])

  // 通配符匹配函数
  const matchPattern = (filename: string, pattern: string): boolean => {
    if (!pattern.trim()) return true

    // 转换通配符为正则表达式
    // * 匹配任意字符，? 匹配单个字符
    const regexPattern = pattern
      .replace(/\./g, '\\.')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')

    const regex = new RegExp(`^${regexPattern}$`, 'i')  // 不区分大小写
    return regex.test(filename)
  }

  // 筛选后的文件列表
  const filteredFiles = filterPattern.trim()
    ? files.filter(f => matchPattern(f.name, filterPattern))
    : files

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
    if (!currentSessionId) return

    const dirResult = await window.electronAPI.getDownloadDir(currentSessionId)
    if (!dirResult.success) return

    const localPath = `${dirResult.data}/${file.name}`
    const taskId = Date.now().toString()
    registerDownloadFileName(taskId, file.name, localPath)
    window.electronAPI.fileDownload(currentSessionId, file.path, localPath, taskId, file.name, file.size)
  }

  // 上传文件（拖放）
  const handleUpload = async (localPath: string, fileName: string) => {
    if (!currentSessionId) return

    const remotePath = `${currentPath}/${fileName}`
    const taskId = Date.now().toString()
    registerDownloadFileName(taskId, fileName, localPath)

    const result = await window.electronAPI.fileUpload(currentSessionId, localPath, remotePath, taskId)
    if (result.success) {
      setTimeout(() => currentSessionId && loadFiles(currentSessionId, currentPath), 2000)
    }
  }

  // 获取当前会话名称
  const activeSession = sessions.find(s => s.id === currentSessionId)
  const sessionName = activeSession?.config?.name || '未连接'

  // 是否有可用的文件会话
  const hasFileSession = currentServerKey && currentSessionId

  return (
    <div
      className="flex flex-col h-full bg-[#252526] overflow-hidden relative"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* 拖动遮罩 */}
      {isDragging && (
        <div className="absolute inset-0 bg-[#0078D4]/30 border-2 border-dashed border-[#0078D4] flex items-center justify-center z-30 pointer-events-none">
          <div className="text-center bg-[#1E1E1E]/90 px-6 py-4 rounded-lg">
            <div className="text-4xl mb-2">📤</div>
            <div className="text-sm text-[#0078D4] font-medium">拖放文件上传</div>
            <div className="text-xs text-gray-400 mt-1">上传到: {currentPath}</div>
          </div>
        </div>
      )}

      {/* 标题栏 */}
      <div className="h-[28px] bg-[#1E1E1E] border-b border-[#3C3C3C] flex items-center justify-between px-2">
        <span className="text-xs text-gray-300 truncate">{sessionName}</span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setActiveTab('files')}
            className={`px-2 py-0.5 text-xs rounded ${
              activeTab === 'files' ? 'bg-[#0078D4] text-white' : 'text-gray-400 hover:text-white'
            }`}
          >
            文件
          </button>
          <button
            onClick={() => setActiveTab('history')}
            className={`px-2 py-0.5 text-xs rounded ${
              activeTab === 'history' ? 'bg-[#0078D4] text-white' : 'text-gray-400 hover:text-white'
            }`}
          >
            记录
          </button>
        </div>
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-auto min-h-0">
        {activeTab === 'files' ? (
          hasFileSession ? (
            <FileBrowser
              files={filteredFiles}
              currentPath={currentPath}
              loading={loading}
              hasSession={true}
              sessionId={currentSessionId}
              filterPattern={filterPattern}
              onFilterChange={setFilterPattern}
              onEnterDir={handleEnterDir}
              onGoUp={handleGoUp}
              onDownload={handleDownload}
              onRefresh={() => currentSessionId && loadFiles(currentSessionId, currentPath)}
            />
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-gray-500">
              <div className="text-xl mb-1">🔗</div>
              <div className="text-xs">请连接服务器</div>
            </div>
          )
        ) : (
          <DownloadHistoryList sessionId={currentSessionId} />
        )}
      </div>

      {/* 进度条 */}
      <DownloadProgressBar />
    </div>
  )
}

export default FileManagerPanel