import React, { useState } from 'react'

interface FileInfo {
  name: string
  path: string
  isDir: boolean
  size: number
  modifyTime: Date
}

interface FileBrowserProps {
  files: FileInfo[]
  currentPath: string
  loading: boolean
  hasSession: boolean
  sessionId: string | null
  filterPattern: string
  onFilterChange: (pattern: string) => void
  onEnterDir: (file: FileInfo) => void
  onGoUp: () => void
  onDownload: (file: FileInfo) => void
  onRefresh: () => void
}

// 格式化文件大小
const formatSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`
}

/**
 * 文件浏览子组件 - 显示文件列表
 */
const FileBrowser: React.FC<FileBrowserProps> = ({
  files,
  currentPath,
  loading,
  hasSession,
  sessionId,
  filterPattern,
  onFilterChange,
  onEnterDir,
  onGoUp,
  onDownload,
  onRefresh
}) => {
  const [md5Values, setMd5Values] = useState<Record<string, string>>({})
  const [md5Loading, setMd5Loading] = useState<Record<string, boolean>>({})
  const [showFilter, setShowFilter] = useState(false)

  // 获取文件 MD5
  const handleGetMd5 = async (file: FileInfo) => {
    if (!sessionId) return

    setMd5Loading(prev => ({ ...prev, [file.path]: true }))
    try {
      const result = await window.electronAPI.fileMd5(sessionId, file.path)
      if (result.success && result.data) {
        setMd5Values(prev => ({ ...prev, [file.path]: result.data }))
      } else {
        alert('获取MD5失败: ' + (result.error || '未知错误'))
      }
    } catch (err) {
      alert('获取MD5失败')
    }
    setMd5Loading(prev => ({ ...prev, [file.path]: false }))
  }

  return (
    <div className="flex flex-col h-full">
      {/* 路径导航 */}
      <div className="px-2 py-1.5 border-b border-[#3C3C3C]/50 flex items-center gap-1">
        <button
          onClick={onGoUp}
          disabled={currentPath === '/'}
          className={`px-2 py-1 text-sm rounded ${
            currentPath === '/' ? 'text-gray-500 cursor-not-allowed' : 'text-gray-400 hover:text-white bg-[#3C3C3C]'
          }`}
          title="上级目录"
        >
          ⬆
        </button>
        <span className="text-sm text-gray-300 flex-1 truncate font-mono">{currentPath}</span>
        {/* 筛选按钮 */}
        <button
          onClick={() => setShowFilter(!showFilter)}
          className={`px-2 py-1 text-sm rounded ${
            showFilter || filterPattern ? 'text-white bg-[#0078D4]' : 'text-gray-400 hover:text-white bg-[#3C3C3C]'
          }`}
          title="筛选文件"
        >
          🔍
        </button>
        <button
          onClick={onRefresh}
          className="px-2 py-1 text-sm text-gray-400 hover:text-white bg-[#3C3C3C] rounded"
          title="刷新"
        >
          ⟳
        </button>
      </div>

      {/* 筛选输入框 - 点击筛选按钮后显示 */}
      {showFilter && (
        <div className="px-2 py-1.5 border-b border-[#3C3C3C]/50 flex items-center gap-1">
          <input
            type="text"
            value={filterPattern}
            onChange={(e) => onFilterChange(e.target.value)}
            placeholder="*.txt, log*, *.log"
            className="flex-1 px-2 py-1 bg-[#3C3C3C] border border-[#555] rounded text-xs text-white placeholder-gray-500 focus:outline-none focus:border-[#0078D4]"
            autoFocus
          />
          {filterPattern && (
            <button
              onClick={() => onFilterChange('')}
              className="px-1.5 py-1 text-xs text-gray-400 hover:text-white"
              title="清除筛选"
            >
              ✕
            </button>
          )}
          <span className="text-xs text-gray-500">{files.length}项</span>
        </div>
      )}

      {/* 文件列表 */}
      <div
        className="flex-1 overflow-auto"
        onContextMenu={(e) => {
          e.preventDefault()
          onGoUp()
        }}
      >
        {!hasSession ? (
          <div className="flex items-center justify-center h-full text-sm text-gray-500 px-4 text-center">
            <div>
              <p>请在左侧选择会话</p>
              <p className="text-xs mt-1 text-gray-600">点击会话名称连接</p>
            </div>
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center h-full text-sm text-gray-500">
            加载中...
          </div>
        ) : files.length === 0 ? (
          <div className="flex items-center justify-center h-full text-sm text-gray-500">
            空目录
          </div>
        ) : (
          <div className="space-y-0.5 px-1.5 py-1">
            {files.map(file => (
              <div
                key={file.path}
                onClick={() => file.isDir && onEnterDir(file)}
                className={`flex items-center gap-2 px-2 py-1.5 rounded group ${
                  file.isDir ? 'cursor-pointer hover:bg-[#3C3C3C]' : 'hover:bg-[#3C3C3C]'
                }`}
              >
                {/* 图标 */}
                <span className="text-sm">{file.isDir ? '📁' : '📄'}</span>
                {/* 名称 */}
                <span className="text-sm text-gray-200 flex-1 truncate">{file.name}</span>

                {/* MD5 显示 */}
                {!file.isDir && md5Values[file.path] && (
                  <span className="text-xs text-gray-400 font-mono truncate max-w-[80px]" title={md5Values[file.path]}>
                    {md5Values[file.path].substring(0, 8)}...
                  </span>
                )}

                {/* 大小 */}
                {!file.isDir && (
                  <span className="text-xs text-gray-500">{formatSize(file.size)}</span>
                )}

                {/* 操作按钮 */}
                {!file.isDir && (
                  <div className="hidden group-hover:flex items-center gap-1">
                    {/* MD5 按钮 */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        handleGetMd5(file)
                      }}
                      disabled={md5Loading[file.path]}
                      className={`px-2 py-0.5 text-xs rounded ${
                        md5Loading[file.path]
                          ? 'text-gray-400 bg-[#555] cursor-wait'
                          : 'text-gray-400 bg-[#3C3C3C] hover:text-white hover:bg-[#555]'
                      }`}
                      title="获取MD5"
                    >
                      {md5Loading[file.path] ? '...' : '#'}
                    </button>
                    {/* 下载按钮 */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        onDownload(file)
                      }}
                      className="px-2 py-0.5 text-xs bg-[#0078D4] text-white rounded hover:bg-[#006CBD]"
                      title="下载"
                    >
                      ⬇
                    </button>
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

export default FileBrowser