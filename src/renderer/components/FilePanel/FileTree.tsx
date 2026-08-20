import React, { useEffect, useState } from 'react'
import cn from 'classnames'
import { useTranslation } from 'react-i18next'
import { useFileStore } from '../../stores'
import i18n from '../../i18n'
import type { FileNode } from '../../stores/file-store'
import type { FileInfo } from '@shared/types'

interface FileTreeProps {
  sessionId: string
  onFileSelect?: (file: FileInfo) => void
  onFileDownload?: (file: FileInfo) => void
  onFileUpload?: (targetDir: string) => void
  onFileDelete?: (file: FileInfo) => void
  onFileRename?: (file: FileInfo) => void
  onMkdir?: (parentDir: string) => void
}

/**
 * 文件树组件
 */
const FileTree: React.FC<FileTreeProps> = ({
  sessionId,
  onFileSelect,
  onFileDownload,
  onFileUpload,
  onFileDelete,
  onFileRename,
  onMkdir
}) => {
  const {
    fileTrees,
    loading,
    errors,
    selectedPaths,
    loadDir,
    toggleExpand,
    setSelected,
    initFileTree,
    refreshDir
  } = useFileStore()
  const { t } = useTranslation()

  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    file: FileNode
  } | null>(null)

  const [md5Dialog, setMd5Dialog] = useState<{
    file: FileNode
    md5: string
    loading: boolean
  } | null>(null)

  // ESC键关闭MD5对话框
  useEffect(() => {
    if (!md5Dialog) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMd5Dialog(null)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [md5Dialog])

  const root = fileTrees[sessionId]
  const isLoading = loading[sessionId]
  const error = errors[sessionId]
  const selectedPath = selectedPaths[sessionId]

  // 初始化时加载根目录
  useEffect(() => {
    if (!root) {
      initFileTree(sessionId, '/')
    }
  }, [sessionId, root, initFileTree])

  // 查看 MD5
  const handleViewMd5 = async (file: FileNode) => {
    setMd5Dialog({ file, md5: '', loading: true })
    setContextMenu(null)

    try {
      const result = await window.electronAPI.fileMd5(sessionId, file.path)
      if (result.success) {
        setMd5Dialog({ file, md5: result.data, loading: false })
      } else {
        setMd5Dialog({ file, md5: t('file.errorPrefix', { message: result.error }), loading: false })
      }
    } catch (err) {
      setMd5Dialog({ file, md5: t('file.errorPrefix', { message: (err as Error).message }), loading: false })
    }
  }

  // 处理节点点击
  const handleNodeClick = (node: FileNode) => {
    setSelected(sessionId, node.path)

    if (node.isDir) {
      // 当前是否展开
      const isCurrentlyExpanded = node.expanded

      // 目录：展开/折叠
      toggleExpand(sessionId, node.path)

      // 如果正在展开且未加载子节点，加载它们
      if (!isCurrentlyExpanded && !node.loaded) {
        loadDir(sessionId, node.path)
      }
    } else {
      // 文件：触发选择回调
      if (onFileSelect) {
        onFileSelect({
          name: node.name,
          path: node.path,
          isDir: false,
          size: node.size,
          modifyTime: node.modifyTime,
          permissions: node.permissions
        })
      }
    }
  }

  // 处理右键菜单
  const handleContextMenu = (e: React.MouseEvent, node: FileNode) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, file: node })
  }

  // 关闭右键菜单
  const closeContextMenu = () => {
    setContextMenu(null)
  }

  // 渲染文件节点
  const renderNode = (node: FileNode, depth: number = 0) => {
    const isSelected = selectedPath === node.path
    const isExpanded = node.isDir && node.expanded
    const showChildren = isExpanded && node.loaded && node.children

    return (
      <div key={node.path}>
        {/* 节点行 */}
        <div
          className={cn(
            'flex items-center gap-1 px-2 py-1 cursor-pointer hover:bg-[#3C3C3C] transition-colors',
            isSelected && 'bg-[#0078D4] hover:bg-[#0078D4]',
            'group'
          )}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onClick={() => handleNodeClick(node)}
          onContextMenu={(e) => handleContextMenu(e, node)}
        >
          {/* 展开/折叠图标 */}
          {node.isDir && (
            <span className="text-xs text-gray-400 w-4">
              {isExpanded ? '▼' : '▶'}
            </span>
          )}

          {/* 文件图标 */}
          <span className="text-sm">
            {node.isDir ? '📁' : getFileIcon(node.name)}
          </span>

          {/* 文件名 */}
          <span className="text-sm text-gray-200 truncate flex-1">
            {node.name}
          </span>

          {/* 文件大小（仅文件显示） */}
          {!node.isDir && (
            <span className="text-xs text-gray-400 hidden group-hover:inline">
              {formatSize(node.size)}
            </span>
          )}
        </div>

        {/* 子节点 */}
        {showChildren && (
          <div>
            {node.children!.map(child => renderNode(child, depth + 1))}
          </div>
        )}

        {/* 加载中提示 */}
        {node.isDir && isExpanded && !node.loaded && (
          <div
            className="text-xs text-gray-400 px-2 py-1"
            style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}
          >
            {t('file.loadingTree')}
          </div>
        )}
      </div>
    )
  }

  // 加载状态
  if (isLoading && !root) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400">
        {t('file.loadingTree')}
      </div>
    )
  }

  // 错误状态
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-400 gap-2">
        <span className="text-red-400">{error}</span>
        <button
          onClick={() => initFileTree(sessionId, '/')}
          className="text-xs text-blue-400 hover:text-blue-300"
        >
          {t('file.retry')}
        </button>
      </div>
    )
  }

  // 无内容
  if (!root) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400">
        {t('file.noFiles')}
      </div>
    )
  }

  return (
    <div
      className="h-full overflow-auto text-sm select-none"
      onClick={closeContextMenu}
    >
      {/* 渲染根节点的子节点 */}
      {root.children && root.children.map(child => renderNode(child, 0))}

      {/* 右键菜单 */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          file={contextMenu.file}
          onDownload={() => {
            if (!contextMenu.file.isDir && onFileDownload) {
              onFileDownload({
                name: contextMenu.file.name,
                path: contextMenu.file.path,
                isDir: false,
                size: contextMenu.file.size,
                modifyTime: contextMenu.file.modifyTime
              })
            }
            closeContextMenu()
          }}
          onUpload={() => {
            if (contextMenu.file.isDir && onFileUpload) {
              onFileUpload(contextMenu.file.path)
            } else if (onFileUpload) {
              onFileUpload(contextMenu.file.path.substring(0, contextMenu.file.path.lastIndexOf('/')))
            }
            closeContextMenu()
          }}
          onDelete={() => {
            if (onFileDelete) {
              onFileDelete({
                name: contextMenu.file.name,
                path: contextMenu.file.path,
                isDir: contextMenu.file.isDir,
                size: contextMenu.file.size,
                modifyTime: contextMenu.file.modifyTime
              })
            }
            closeContextMenu()
          }}
          onRename={() => {
            if (onFileRename) {
              onFileRename({
                name: contextMenu.file.name,
                path: contextMenu.file.path,
                isDir: contextMenu.file.isDir,
                size: contextMenu.file.size,
                modifyTime: contextMenu.file.modifyTime
              })
            }
            closeContextMenu()
          }}
          onMkdir={() => {
            if (contextMenu.file.isDir && onMkdir) {
              onMkdir(contextMenu.file.path)
            } else if (onMkdir) {
              onMkdir(contextMenu.file.path.substring(0, contextMenu.file.path.lastIndexOf('/')))
            }
            closeContextMenu()
          }}
          onRefresh={() => {
            refreshDir(sessionId, contextMenu.file.isDir ? contextMenu.file.path : contextMenu.file.path.substring(0, contextMenu.file.path.lastIndexOf('/')))
            closeContextMenu()
          }}
          onViewMd5={() => {
            if (!contextMenu.file.isDir) {
              handleViewMd5(contextMenu.file)
            }
          }}
        />
      )}

      {/* MD5 对话框 */}
      {md5Dialog && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={() => setMd5Dialog(null)}
        >
          <div
            className="bg-[#252526] border border-[#3C3C3C] rounded-lg p-4 min-w-[300px]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm text-gray-200 mb-2">
              {md5Dialog.file.name}
            </div>
            {md5Dialog.loading ? (
              <div className="text-sm text-gray-400">{t('file.md5Calculating')}</div>
            ) : (
              <div className="text-xs text-green-400 break-all select-all">
                {t('file.md5Label', { value: md5Dialog.md5 })}
              </div>
            )}
            <button
              onClick={() => setMd5Dialog(null)}
              className="mt-3 text-xs text-gray-400 hover:text-white"
            >
              {t('file.md5DialogClose')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * 右键菜单组件
 */
const ContextMenu: React.FC<{
  x: number
  y: number
  file: FileNode
  onDownload?: () => void
  onUpload?: () => void
  onDelete?: () => void
  onRename?: () => void
  onMkdir?: () => void
  onRefresh?: () => void
  onViewMd5?: () => void
}> = ({ x, y, file, onDownload, onUpload, onDelete, onRename, onMkdir, onRefresh, onViewMd5 }) => {
  const { t } = useTranslation()
  return (
    <div
      className="fixed bg-[#252526] border border-[#3C3C3C] rounded shadow-lg py-1 z-50"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* 目录操作 */}
      {file.isDir && (
        <>
          {onUpload && (
            <MenuItem onClick={onUpload} icon="⬆" label={t('file.contextUploadFile')} />
          )}
          {onMkdir && (
            <MenuItem onClick={onMkdir} icon="📁" label={t('file.contextNewDir')} />
          )}
        </>
      )}

      {/* 文件操作 */}
      {!file.isDir && onDownload && (
        <MenuItem onClick={onDownload} icon="⬇" label={t('file.contextDownload')} />
      )}
      {!file.isDir && onViewMd5 && (
        <MenuItem onClick={onViewMd5} icon="🔍" label={t('file.contextMd5')} />
      )}

      {/* 通用操作 */}
      {onRename && (
        <MenuItem onClick={onRename} icon="✏" label={t('file.contextRename')} />
      )}
      {onDelete && (
        <MenuItem onClick={onDelete} icon="🗑" label={t('file.contextDelete')} />
      )}
      {onRefresh && (
        <MenuItem onClick={onRefresh} icon="🔄" label={t('file.contextRefresh')} />
      )}
    </div>
  )
}

/**
 * 菜单项组件
 */
const MenuItem: React.FC<{
  onClick: () => void
  icon: string
  label: string
}> = ({ onClick, icon, label }) => (
  <div
    onClick={onClick}
    className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-200 hover:bg-[#3C3C3C] cursor-pointer"
  >
    <span>{icon}</span>
    <span>{label}</span>
  </div>
)

/**
 * 获取文件图标
 */
function getFileIcon(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  const iconMap: Record<string, string> = {
    txt: '📄',
    md: '📝',
    json: '📋',
    js: '📜',
    ts: '📜',
    py: '🐍',
    sh: '💻',
    yml: '⚙',
    yaml: '⚙',
    xml: '⚙',
    html: '🌐',
    css: '🎨',
    jpg: '🖼',
    jpeg: '🖼',
    png: '🖼',
    gif: '🖼',
    zip: '📦',
    tar: '📦',
    gz: '📦',
    pdf: '📑',
    doc: '📑',
    docx: '📑',
    xls: '📊',
    xlsx: '📊',
  }
  return iconMap[ext] || '📄'
}

/**
 * 格式化文件大小（模块级，用 i18n 单例取单位——非组件作用域无法用 hook）
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return i18n.t('file.fileSizeB', { n: bytes })
  if (bytes < 1024 * 1024) return i18n.t('file.fileSizeKB', { n: (bytes / 1024).toFixed(1) })
  if (bytes < 1024 * 1024 * 1024) return i18n.t('file.fileSizeMB', { n: (bytes / (1024 * 1024)).toFixed(1) })
  return i18n.t('file.fileSizeGB', { n: (bytes / (1024 * 1024 * 1024)).toFixed(1) })
}

export default FileTree