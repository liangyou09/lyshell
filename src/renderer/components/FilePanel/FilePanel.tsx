import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import FileTree from './FileTree'
import FileToolbar from './FileToolbar'
import { useFileStore, useSessionStore } from '../../stores'
import type { FileInfo } from '@shared/types'

interface FilePanelProps {
  sessionId: string
}

/**
 * 文件面板主组件 - 不包含传输进度显示
 */
const FilePanel: React.FC<FilePanelProps> = ({ sessionId }) => {
  const {
    fileTrees,
    currentPaths,
    initFileTree,
    loadDir,
    refreshDir,
    setCurrentPath,
    fetchConnectorType
  } = useFileStore()

  const { sessions } = useSessionStore()

  const [mkdirDialogOpen, setMkdirDialogOpen] = useState(false)
  const [mkdirParentPath, setMkdirParentPath] = useState('')
  const [newDirName, setNewDirName] = useState('')
  const [renameDialogOpen, setRenameDialogOpen] = useState(false)
  const [renameFile, setRenameFile] = useState<FileInfo | null>(null)
  const [newFileName, setNewFileName] = useState('')
  const { t } = useTranslation()

  // ESC键关闭弹窗
  useEffect(() => {
    if (!mkdirDialogOpen && !renameDialogOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (mkdirDialogOpen) {
          setMkdirDialogOpen(false)
          setNewDirName('')
        }
        if (renameDialogOpen) {
          setRenameDialogOpen(false)
          setRenameFile(null)
          setNewFileName('')
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [mkdirDialogOpen, renameDialogOpen])

  const root = fileTrees[sessionId]
  const currentPath = currentPaths[sessionId] || '/'

  // 检查会话是否连接
  const session = sessions.find(s => s.id === sessionId)
  const isConnected = session?.status === 'connected'

  // 初始化
  useEffect(() => {
    if (isConnected) {
      fetchConnectorType(sessionId)
      if (!root) {
        initFileTree(sessionId, '/')
      }
    }
  }, [sessionId, isConnected, root, fetchConnectorType, initFileTree])

  // 刷新当前目录
  const handleRefresh = () => {
    if (root) {
      refreshDir(sessionId, currentPath)
    } else {
      initFileTree(sessionId, currentPath)
    }
  }

  // 上传文件（直接调用，不显示进度）
  const handleUpload = async (targetDir?: string) => {
    const uploadDir = targetDir || currentPath

    const result = await window.electronAPI.showOpenDialog({
      title: t('file.uploadDialogTitle'),
      properties: ['openFile', 'multiSelections']
    })

    if (result.canceled || !result.filePaths.length) {
      return
    }

    for (const localPath of result.filePaths) {
      const fileName = localPath.split('/').pop() || localPath.split('\\').pop() || 'unknown'
      const remotePath = `${uploadDir}/${fileName}`
      const taskId = Date.now().toString()

      // 直接调用上传，不追踪进度
      window.electronAPI.fileUpload(sessionId, localPath, remotePath, taskId)
    }

    // 提示用户
    alert(t('file.uploadStarted', { count: result.filePaths.length }))
  }

  // 下载文件（直接调用，不显示进度）
  const handleDownload = async (file: FileInfo) => {
    // 获取下载目录
    const dirResult = await window.electronAPI.getDownloadDir(sessionId)
    if (!dirResult.success) {
      // 使用默认保存对话框
      const result = await window.electronAPI.showSaveDialog({
        title: t('file.saveDialogTitle'),
        defaultPath: file.name
      })
      if (result.canceled || !result.filePath) return

      const taskId = Date.now().toString()
      window.electronAPI.fileDownload(sessionId, file.path, result.filePath, taskId, file.name, file.size)
      alert(t('file.downloadStarted', { name: file.name }))
    } else {
      // 使用配置的下载目录
      const localPath = `${dirResult.data}/${file.name}`
      const taskId = Date.now().toString()
      window.electronAPI.fileDownload(sessionId, file.path, localPath, taskId, file.name, file.size)
      alert(t('file.downloadStartedWithPath', { name: file.name, path: localPath }))
    }
  }

  // 删除文件
  const handleDelete = async (file: FileInfo) => {
    const confirmed = await window.electronAPI.showMessageBox({
      type: 'warning',
      buttons: [t('file.deleteConfirmButton'), t('file.cancelButton')],
      title: t('file.deleteConfirmTitle'),
      message: t('file.deleteConfirmMessage', {
        type: file.isDir ? t('file.typeDir') : t('file.typeFile'),
        name: file.name,
        dirExtra: file.isDir ? t('file.deleteConfirmDirExtra') : ''
      })
    })

    if (confirmed.response !== 0) {
      return
    }

    const result = await window.electronAPI.fileDelete(sessionId, file.path)
    if (result.success) {
      handleRefresh()
    } else {
      await window.electronAPI.showMessageBox({
        type: 'error',
        title: t('file.deleteFailedTitle'),
        message: result.error
      })
    }
  }

  // 重命名
  const handleRename = (file: FileInfo) => {
    setRenameFile(file)
    setNewFileName(file.name)
    setRenameDialogOpen(true)
  }

  const executeRename = async () => {
    if (!renameFile || !newFileName || newFileName === renameFile.name) {
      setRenameDialogOpen(false)
      return
    }

    const parentPath = renameFile.path.substring(0, renameFile.path.lastIndexOf('/'))
    const newPath = `${parentPath}/${newFileName}`

    const result = await window.electronAPI.fileRename(sessionId, renameFile.path, newPath)
    if (result.success) {
      handleRefresh()
    } else {
      await window.electronAPI.showMessageBox({
        type: 'error',
        title: t('file.renameFailedTitle'),
        message: result.error
      })
    }

    setRenameDialogOpen(false)
    setRenameFile(null)
  }

  // 新建目录
  const handleMkdir = (parentDir?: string) => {
    setMkdirParentPath(parentDir || currentPath)
    setNewDirName('')
    setMkdirDialogOpen(true)
  }

  const executeMkdir = async () => {
    if (!newDirName) {
      setMkdirDialogOpen(false)
      return
    }

    const dirPath = `${mkdirParentPath}/${newDirName}`

    const result = await window.electronAPI.fileMkdir(sessionId, dirPath)
    if (result.success) {
      handleRefresh()
    } else {
      await window.electronAPI.showMessageBox({
        type: 'error',
        title: t('file.mkdirFailedTitle'),
        message: result.error
      })
    }

    setMkdirDialogOpen(false)
  }

  // 导航到上级目录
  const handleNavigateUp = () => {
    if (currentPath === '/') return

    const parentPath = currentPath.substring(0, currentPath.lastIndexOf('/')) || '/'
    setCurrentPath(sessionId, parentPath)
    loadDir(sessionId, parentPath)
  }

  // 导航到指定目录
  const handleNavigateTo = (path: string) => {
    setCurrentPath(sessionId, path)
    loadDir(sessionId, path)
  }

  // 未连接时显示提示
  if (!isConnected) {
    return (
      <div className="flex flex-col h-full bg-[#1E1E1E]">
        <div className="flex items-center justify-center h-full text-gray-400">
          {t('file.notConnected')}
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-[#1E1E1E]">
      {/* 工具栏 */}
      <FileToolbar
        sessionId={sessionId}
        currentPath={currentPath}
        onRefresh={handleRefresh}
        onUpload={() => handleUpload()}
        onMkdir={() => handleMkdir()}
        onNavigateUp={handleNavigateUp}
        onNavigateTo={handleNavigateTo}
      />

      {/* 文件树 */}
      <div className="flex-1 overflow-hidden">
        <FileTree
          sessionId={sessionId}
          onFileDownload={handleDownload}
          onFileUpload={handleUpload}
          onFileDelete={handleDelete}
          onFileRename={handleRename}
          onMkdir={handleMkdir}
        />
      </div>

      {/* 新建目录对话框 */}
      {mkdirDialogOpen && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/50 z-50">
          <div className="bg-[#252526] border border-[#3C3C3C] rounded shadow-lg p-4 w-[300px]">
            <div className="text-sm text-gray-200 mb-3">{t('file.newDirDialogTitle')}</div>
            <div className="text-xs text-gray-400 mb-2">{mkdirParentPath}</div>
            <input
              type="text"
              value={newDirName}
              onChange={(e) => setNewDirName(e.target.value)}
              placeholder={t('file.dirNamePlaceholder')}
              className="w-full bg-[#1E1E1E] border border-[#3C3C3C] rounded px-2 py-1 text-sm text-gray-200 outline-none focus:border-[#0078D4]"
              autoFocus
            />
            <div className="flex justify-end gap-2 mt-3">
              <button
                onClick={() => setMkdirDialogOpen(false)}
                className="px-3 py-1 text-sm text-gray-400 hover:text-white transition-colors"
              >
                {t('file.cancelButton')}
              </button>
              <button
                onClick={executeMkdir}
                className="px-3 py-1 text-sm text-white bg-[#0078D4] rounded hover:bg-[#0066B4] transition-colors"
              >
                {t('file.createButton')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 重命名对话框 */}
      {renameDialogOpen && renameFile && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/50 z-50">
          <div className="bg-[#252526] border border-[#3C3C3C] rounded shadow-lg p-4 w-[300px]">
            <div className="text-sm text-gray-200 mb-3">
              {t('file.renameDialogTitle', { type: renameFile.isDir ? t('file.typeDir') : t('file.typeFile') })}
            </div>
            <input
              type="text"
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              placeholder={t('file.newNamePlaceholder')}
              className="w-full bg-[#1E1E1E] border border-[#3C3C3C] rounded px-2 py-1 text-sm text-gray-200 outline-none focus:border-[#0078D4]"
              autoFocus
            />
            <div className="flex justify-end gap-2 mt-3">
              <button
                onClick={() => setRenameDialogOpen(false)}
                className="px-3 py-1 text-sm text-gray-400 hover:text-white transition-colors"
              >
                {t('file.cancelButton')}
              </button>
              <button
                onClick={executeRename}
                className="px-3 py-1 text-sm text-white bg-[#0078D4] rounded hover:bg-[#0066B4] transition-colors"
              >
                {t('file.okButton')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default FilePanel