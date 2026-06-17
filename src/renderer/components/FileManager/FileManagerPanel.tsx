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

// 服务器路径持久化 key
const SERVER_PATHS_STORAGE_KEY = 'lyshell_server_paths'

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

// 从 localStorage 加载服务器路径
function loadServerPaths(): Record<string, string> {
  try {
    const saved = localStorage.getItem(SERVER_PATHS_STORAGE_KEY)
    if (!saved) return {}
    return JSON.parse(saved)
  } catch (e) {
    console.warn('Failed to load server paths:', e)
    return {}
  }
}

// 保存服务器路径到 localStorage
function saveServerPaths(paths: Record<string, string>): void {
  try {
    localStorage.setItem(SERVER_PATHS_STORAGE_KEY, JSON.stringify(paths))
  } catch (e) {
    console.warn('Failed to save server paths:', e)
  }
}

/**
 * 嵌入式文件管理器 - 用于侧边栏底部
 * 每个服务器的文件列表独立缓存在内存中
 * 切换会话时直接从缓存读取，不重新请求
 */
const FileManagerPanel: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'files' | 'history'>('files')
  const [filterPattern, setFilterPattern] = useState('')
  const [isDragging, setIsDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 每个服务器的缓存数据
  const filesCacheRef = useRef<{ [key: string]: FileInfo[] }>({})  // 文件列表缓存
  const pathsCacheRef = useRef<{ [key: string]: string }>(loadServerPaths())  // 路径缓存（从 localStorage 加载）
  const loadingCacheRef = useRef<{ [key: string]: boolean }>({})  // 加载状态
  const initializedRef = useRef<Set<string>>(new Set())  // 已初始化的服务器
  const homeDirsRef = useRef<{ [key: string]: string }>({})  // home 目录

  // 当前显示的数据（从缓存中读取）
  const [displayFiles, setDisplayFiles] = useState<FileInfo[]>([])
  const [displayPath, setDisplayPath] = useState('/')
  const [displayLoading, setDisplayLoading] = useState(false)

  // 获取所有会话和终端
  const { layout, getAllLeafPanes } = usePaneStore()
  const { sessions } = useSessionStore()

  // 获取活动终端的会话
  const activePane = getAllLeafPanes().find(p => p.id === layout.activePaneId)
  const paneSessionId = activePane?.activeSessionId || null
  const paneSession = sessions.find(s => s.id === paneSessionId)

  // 计算当前服务器的标识
  const paneServerIdentity = paneSession?.status === 'connected' ? getServerIdentity(paneSession) : null
  const currentServerKey = paneServerIdentity ? serverKey(paneServerIdentity) : null
  const currentSessionId = paneSessionId

  // 切换服务器时，从缓存读取数据
  useEffect(() => {
    if (currentServerKey && currentSessionId) {
      // 从缓存读取当前服务器的数据
      const cachedFiles = filesCacheRef.current[currentServerKey] || []
      const cachedPath = pathsCacheRef.current[currentServerKey] || '/'
      const cachedLoading = loadingCacheRef.current[currentServerKey] || false

      setDisplayFiles(cachedFiles)
      setDisplayPath(cachedPath)
      setDisplayLoading(cachedLoading)

      // 如果没有初始化且没有正在加载，才加载文件列表
      if (!initializedRef.current.has(currentServerKey) && !loadingCacheRef.current[currentServerKey]) {
        // 如果有保存的路径且不是根目录，直接加载
        if (cachedPath && cachedPath !== '/' && cachedPath !== '') {
          initializedRef.current.add(currentServerKey)
          loadFiles(currentServerKey, currentSessionId, cachedPath)
        } else {
          // 没有保存的路径，获取 home 目录
          fetchHomeDirectory(currentServerKey, currentSessionId)
        }
      }
    } else {
      setDisplayFiles([])
      setDisplayPath('/')
      setDisplayLoading(false)
    }
  }, [currentServerKey, currentSessionId])

  // 获取用户的 home 目录
  const fetchHomeDirectory = async (key: string, sessionId: string) => {
    loadingCacheRef.current[key] = true
    initializedRef.current.add(key)  // 标记为已初始化，防止重复调用
    setDisplayLoading(true)

    try {
      const pwdResult = await window.electronAPI.filePwd(sessionId)
      if (pwdResult.success && pwdResult.data) {
        const homeDir = pwdResult.data
        homeDirsRef.current[key] = homeDir
        pathsCacheRef.current[key] = homeDir
        saveServerPaths(pathsCacheRef.current)
        setDisplayPath(homeDir)

        // 加载 home 目录的文件列表
        loadFiles(key, sessionId, homeDir)
      } else {
        pathsCacheRef.current[key] = '/'
        setDisplayPath('/')
        loadingCacheRef.current[key] = false
        setDisplayLoading(false)
      }
    } catch (err) {
      console.error('Failed to fetch home directory:', err)
      pathsCacheRef.current[key] = '/'
      setDisplayPath('/')
      loadingCacheRef.current[key] = false
      setDisplayLoading(false)
    }
  }

  // 加载文件列表 - 存入对应服务器的缓存，不管是否切换
  const loadFiles = async (key: string, sessionId: string, path: string) => {
    loadingCacheRef.current[key] = true
    // 只有当前显示的是这个服务器时才更新 loading 状态
    if (currentServerKey === key) {
      setDisplayLoading(true)
    }
    setError(null)

    try {
      const result = await window.electronAPI.fileList(sessionId, path)
      if (result.success) {
        const files = result.data || []
        // 存入缓存，不管是否切换
        filesCacheRef.current[key] = files
        loadingCacheRef.current[key] = false

        // 只有当前显示的还是这个服务器时才更新显示
        if (currentServerKey === key) {
          setDisplayFiles(files)
          setDisplayLoading(false)
        }
      } else {
        loadingCacheRef.current[key] = false
        if (currentServerKey === key) {
          setError(result.error || '加载失败')
          setDisplayFiles([])
          setDisplayLoading(false)
        }
      }
    } catch (err) {
      console.error('Failed to load files:', err)
      loadingCacheRef.current[key] = false
      if (currentServerKey === key) {
        setError('加载失败')
        setDisplayFiles([])
        setDisplayLoading(false)
      }
    }
  }

  // 刷新当前目录
  const handleRefresh = () => {
    if (currentServerKey && currentSessionId) {
      loadFiles(currentServerKey, currentSessionId, displayPath)
    }
  }

  // 进入目录 - 更新路径缓存
  const handleEnterDir = (file: FileInfo) => {
    if (file.isDir && currentServerKey) {
      pathsCacheRef.current[currentServerKey] = file.path
      saveServerPaths(pathsCacheRef.current)
      setDisplayPath(file.path)

      // 加载新目录的文件列表
      if (currentSessionId) {
        loadFiles(currentServerKey, currentSessionId, file.path)
      }
    }
  }

  // 返回上级 - 更新路径缓存
  const handleGoUp = () => {
    if (displayPath === '/' || !currentServerKey) return
    const parent = displayPath.substring(0, displayPath.lastIndexOf('/')) || '/'
    pathsCacheRef.current[currentServerKey] = parent
    saveServerPaths(pathsCacheRef.current)
    setDisplayPath(parent)

    // 加载上级目录的文件列表
    if (currentSessionId) {
      loadFiles(currentServerKey, currentSessionId, parent)
    }
  }

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

    if (!currentSessionId || !currentServerKey) {
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
    if (!currentSessionId || !currentServerKey) return

    const remotePath = `${displayPath}/${fileName}`
    const taskId = Date.now().toString()
    registerDownloadFileName(taskId, fileName, localPath)

    const result = await window.electronAPI.fileUpload(currentSessionId, localPath, remotePath, taskId)
    if (result.success) {
      // 上传完成后刷新文件列表
      setTimeout(() => {
        if (currentSessionId && currentServerKey) {
          loadFiles(currentServerKey, currentSessionId, displayPath)
        }
      }, 2000)
    }
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
    ? displayFiles.filter(f => matchPattern(f.name, filterPattern))
    : displayFiles

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
            <div className="text-xs text-gray-400 mt-1">上传到: {displayPath}</div>
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
            <>
              {/* 错误提示 */}
              {error && (
                <div className="px-2 py-1 bg-red-900/30 border-b border-red-800/50 text-red-400 text-xs flex items-center justify-between">
                  <span className="truncate">{error}</span>
                  <button
                    onClick={() => setError(null)}
                    className="text-red-400 hover:text-white ml-2"
                  >
                    ✕
                  </button>
                </div>
              )}
              <FileBrowser
                files={filteredFiles}
                currentPath={displayPath}
                loading={displayLoading}
                hasSession={true}
                sessionId={currentSessionId}
                filterPattern={filterPattern}
                onFilterChange={setFilterPattern}
                onEnterDir={handleEnterDir}
                onGoUp={handleGoUp}
                onDownload={handleDownload}
                onRefresh={handleRefresh}
              />
            </>
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