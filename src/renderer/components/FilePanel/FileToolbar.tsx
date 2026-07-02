import React from 'react'
import cn from 'classnames'
import { useTranslation } from 'react-i18next'
import { useFileStore } from '../../stores'
import { FileConnectorType } from '@shared/types'

interface FileToolbarProps {
  sessionId: string
  currentPath: string
  onRefresh: () => void
  onUpload: () => void
  onMkdir: () => void
  onNavigateUp: () => void
  onNavigateTo: (path: string) => void
}

/**
 * 文件面板工具栏
 */
const FileToolbar: React.FC<FileToolbarProps> = ({
  sessionId,
  currentPath,
  onRefresh,
  onUpload,
  onMkdir,
  onNavigateUp,
  onNavigateTo
}) => {
  const { connectorTypes, loading } = useFileStore()
  const connectorType = connectorTypes[sessionId]
  const isLoading = loading[sessionId]
  const { t } = useTranslation()

  return (
    <div className="flex items-center gap-2 px-2 py-1.5 border-b border-[#3C3C3C] bg-[#252526]">
      {/* 连接器类型指示 */}
      <div
        className={cn(
          'px-2 py-0.5 rounded text-xs',
          connectorType === FileConnectorType.SFTP
            ? 'bg-green-900/50 text-green-400'
            : connectorType === FileConnectorType.EXEC
              ? 'bg-blue-900/50 text-blue-400'
              : 'bg-gray-700/50 text-gray-400'
        )}
      >
        {connectorType === FileConnectorType.SFTP ? 'SFTP' :
         connectorType === FileConnectorType.EXEC ? 'EXEC' : 'N/A'}
      </div>

      {/* 分隔线 */}
      <div className="w-px h-4 bg-[#3C3C3C]" />

      {/* 刷新按钮 */}
      <button
        onClick={onRefresh}
        disabled={isLoading}
        className={cn(
          'w-6 h-6 flex items-center justify-center rounded hover:bg-[#3C3C3C] transition-colors',
          isLoading && 'opacity-50 cursor-not-allowed'
        )}
        title={t('file.refresh')}
      >
        🔄
      </button>

      {/* 上传按钮 */}
      <button
        onClick={onUpload}
        className="w-6 h-6 flex items-center justify-center rounded hover:bg-[#3C3C3C] transition-colors"
        title={t('file.uploadFile')}
      >
        ⬆
      </button>

      {/* 新建目录按钮 */}
      <button
        onClick={onMkdir}
        className="w-6 h-6 flex items-center justify-center rounded hover:bg-[#3C3C3C] transition-colors"
        title={t('file.newDir')}
      >
        📁+
      </button>

      {/* 向上导航按钮 */}
      <button
        onClick={onNavigateUp}
        disabled={currentPath === '/'}
        className={cn(
          'w-6 h-6 flex items-center justify-center rounded hover:bg-[#3C3C3C] transition-colors',
          currentPath === '/' && 'opacity-50 cursor-not-allowed'
        )}
        title={t('file.parentDir')}
      >
        ⬆
      </button>

      {/* 当前路径 */}
      <div className="flex-1 flex items-center bg-[#1E1E1E] rounded px-2 py-1 text-sm text-gray-200 overflow-hidden">
        {/* 路径分段，可点击导航 */}
        {renderPathSegments(currentPath, onNavigateTo)}
      </div>
    </div>
  )
}

/**
 * 渲染路径分段
 */
function renderPathSegments(path: string, onNavigateTo: (path: string) => void) {
  if (path === '/') {
    return <span className="text-gray-400">/</span>
  }

  const segments = path.split('/').filter(Boolean)
  const elements: React.ReactNode[] = []

  // 根目录
  elements.push(
    <span
      key="root"
      onClick={() => onNavigateTo('/')}
      className="text-gray-400 hover:text-blue-400 cursor-pointer"
    >
      /
    </span>
  )

  // 各分段
  segments.forEach((segment, index) => {
    const segmentPath = '/' + segments.slice(0, index + 1).join('/')

    elements.push(
      <span key={`sep-${index}`} className="text-gray-400">
        /
      </span>
    )

    elements.push(
      <span
        key={`segment-${index}`}
        onClick={() => onNavigateTo(segmentPath)}
        className={cn(
          'hover:text-blue-400 cursor-pointer',
          index === segments.length - 1 ? 'text-gray-200' : 'text-gray-400'
        )}
      >
        {segment}
      </span>
    )
  })

  return elements
}

export default FileToolbar