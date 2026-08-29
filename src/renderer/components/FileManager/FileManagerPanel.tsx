import React, { useState, useEffect, useRef } from 'react'
import cn from 'classnames'
import { useTranslation } from 'react-i18next'
import DownloadHistoryList from './DownloadHistoryList'
import FileBrowser from './FileBrowser'
import DownloadProgressBar, { registerDownloadFileName } from './DownloadProgressBar'
import { usePaneStore } from '../../stores/pane-store'
import { useSessionStore } from '../../stores/session-store'
import PanelTabs from '../Layout/PanelTabs'
import { PANEL_STRIP_HEIGHT } from '../Layout/topbar-metrics'

interface FileInfo {
  name: string
  path: string
  isDir: boolean
  size: number
  modifyTime: Date | string
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
  const [dragFileCount, setDragFileCount] = useState(0)
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
  const { t } = useTranslation()

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
          setError(result.error || t('fileManager.loadFailed'))
          setDisplayFiles([])
          setDisplayLoading(false)
        }
      }
    } catch (err) {
      console.error('Failed to load files:', err)
      loadingCacheRef.current[key] = false
      if (currentServerKey === key) {
        setError(t('fileManager.loadFailed'))
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

  // 跳转到指定路径（面包屑点击）
  const handleNavigateTo = (absPath: string) => {
    if (!currentServerKey || !currentSessionId) return
    if (!absPath) return
    pathsCacheRef.current[currentServerKey] = absPath
    saveServerPaths(pathsCacheRef.current)
    setDisplayPath(absPath)
    loadFiles(currentServerKey, currentSessionId, absPath)
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
    if (currentSessionId) {
      setIsDragging(true)
      setDragFileCount(e.dataTransfer.items?.length ?? 0)
    }
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
    if (!currentTarget.contains(relatedTarget)) {
      setIsDragging(false)
      setDragFileCount(0)
    }
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
    setDragFileCount(0)

    if (!currentSessionId || !currentServerKey) {
      alert(t('fileManager.connectTerminalFirst'))
      return
    }

    const droppedFiles = e.dataTransfer.files
    if (droppedFiles.length === 0) return

    for (const file of droppedFiles) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const localPath = (file as any).path
      if (localPath) handleUpload(localPath, file.name)
    }
  }

  // 下载文件
  const handleDownload = async (file: FileInfo) => {
    if (!currentSessionId) return

    const dirResult = await window.electronAPI.getDownloadDir(currentSessionId)
    if (!dirResult.success) {
      alert(dirResult.error || t('fileManager.transferFailed'))
      return
    }

    const localPath = `${dirResult.data}/${file.name}`
    const taskId = crypto.randomUUID()
    registerDownloadFileName(taskId, file.name, localPath)
    window.electronAPI.fileDownload(currentSessionId, file.path, localPath, taskId, file.name, file.size)
  }

  // 上传文件（拖放）
  const handleUpload = async (localPath: string, fileName: string) => {
    if (!currentSessionId || !currentServerKey) return

    const remotePath = `${displayPath}/${fileName}`
    const taskId = crypto.randomUUID()
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
  const sessionName = activeSession?.config?.name || ''
  const sessionUser = activeSession?.config?.ssh?.username ?? ''
  const sessionType = activeSession?.config?.type || 'ssh'
  const protoStripColor = (() => {
    switch (sessionType) {
      case 'ssh':    return 'var(--proto-ssh)'
      case 'telnet': return 'var(--proto-tel)'
      case 'serial': return 'var(--proto-ser)'
      case 'local':  return 'var(--proto-loc)'
      default:        return 'var(--text-rack-dim)'
    }
  })()

  // 是否有可用的文件会话
  const hasFileSession = currentServerKey && currentSessionId

  return (
    <div
      className={cn(
        'flex flex-col h-full overflow-hidden relative bg-[var(--bg-base)] transition-shadow',
        isDragging && 'shadow-[inset_0_0_0_1px_var(--amber)]'
      )}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* 拖放提示条（替代原全屏遮罩）— 仅在面板顶部显示一条 24px */}
      {isDragging && (
        <div className="flex items-center justify-between gap-2 px-2.5 py-1 bg-[var(--amber-soft)] border-b border-[var(--amber)] font-mono text-[12px] text-[var(--amber)] tracking-[.02em] pointer-events-none">
          <span>{t('fileManager.releaseToUpload', { fileLabel: dragFileCount > 0 ? t('fileManager.fileCount', { count: dragFileCount }) : t('fileManager.filesLabel') })}</span>
          <span className="text-[var(--text-rack-data)] truncate" title={displayPath}>→ {displayPath}</span>
        </div>
      )}

      {/* 标题栏 — 协议色条 + 会话名居左,页签 inline 挂右端,单条 PANEL_STRIP_HEIGHT 横带 */}
      <div
        className="bg-[var(--bg-strip)] border-b border-[var(--rule)] flex items-center justify-between px-2.5 gap-2 flex-shrink-0"
        style={{ height: PANEL_STRIP_HEIGHT }}
      >
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <span
            className="w-[3px] h-[14px] rounded-r-[1px] flex-shrink-0"
            style={{ background: hasFileSession ? protoStripColor : 'var(--text-rack-faint)' }}
          />
          {hasFileSession ? (
            <>
              <span className="text-[13px] text-[var(--text-rack)] font-medium truncate" title={sessionName}>
                {sessionName}
              </span>
              {sessionUser && (
                <span className="font-mono text-[11.5px] text-[var(--text-rack-mute)] flex-shrink-0">{sessionUser}</span>
              )}
            </>
          ) : (
            <span className="text-[13px] text-[var(--text-rack-mute)] truncate">{t('fileManager.noActiveSession')}</span>
          )}
        </div>
        <PanelTabs
          tabs={[
            { key: 'files' as const, label: t('fileManager.tabFiles') },
            { key: 'history' as const, label: t('fileManager.tabHistory') }
          ]}
          active={activeTab}
          onChange={setActiveTab}
        />
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-auto min-h-0 rack-scroll">
        {activeTab === 'files' ? (
          hasFileSession ? (
            <>
              {/* 错误提示 — fm-err */}
              {error && (
                <div className="px-2.5 py-1 bg-[#3a1a1a] border-b border-[var(--error-rack)] flex items-center justify-between font-mono text-[12px] text-[#ffb3b3] gap-2">
                  <span className="truncate">{error}</span>
                  <button
                    onClick={() => setError(null)}
                    className="text-[#ff8a8a] hover:opacity-100 opacity-70 flex-shrink-0 cursor-pointer bg-transparent border-none"
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
                onNavigateTo={handleNavigateTo}
              />
            </>
          ) : (
            <div className="flex flex-col items-center justify-center h-full px-4 text-center gap-2">
              <span className="font-mono text-[18px] text-[var(--text-rack-dim)] tracking-[.1em]">─ · ─</span>
              <span className="text-[13px] text-[var(--text-rack-mute)]">{t('fileManager.attachHint')}</span>
              <span className="font-mono text-[12px] text-[var(--text-rack-faint)]">{t('fileManager.clickSessionHint')}</span>
            </div>
          )
        ) : (
          <DownloadHistoryList sessionId={currentSessionId} />
        )}
      </div>

      {/* 进度条 — 已重设计为 fm-foot 风格的 24px 行 */}
      <DownloadProgressBar />
    </div>
  )
}

export default FileManagerPanel
