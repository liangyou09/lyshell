import React, { useState, useEffect } from 'react'
import type { SessionConfig } from '@shared/types'

interface QuickCommand {
  id: string
  name: string
  content: string
}

interface ExportImportDialogProps {
  open: boolean
  onClose: () => void
  sessions: SessionConfig[]
  quickCommands: QuickCommand[]
  onImportComplete: (sessions: SessionConfig[], quickCommands: QuickCommand[]) => void
}

/**
 * 导出导入配置对话框
 * 支持密码加密导出，导入时解密
 */
const ExportImportDialog: React.FC<ExportImportDialogProps> = ({
  open,
  onClose,
  sessions,
  quickCommands,
  onImportComplete
}) => {
  const [mode, setMode] = useState<'export' | 'import'>('export')
  const [selectedSessions, setSelectedSessions] = useState<Set<string>>(new Set())
  const [selectedCommands, setSelectedCommands] = useState<Set<string>>(new Set())
  const [encryptPassword, setEncryptPassword] = useState('')
  const [importSessions, setImportSessions] = useState<SessionConfig[]>([])
  const [importCommands, setImportCommands] = useState<QuickCommand[]>([])
  const [importSessionSelect, setImportSessionSelect] = useState<Set<string>>(new Set())
  const [importCommandSelect, setImportCommandSelect] = useState<Set<string>>(new Set())
  const [decryptPassword, setDecryptPassword] = useState('')
  const [needPassword, setNeedPassword] = useState(false)
  const [_importFilePath, setImportFilePath] = useState('')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'warning', text: string } | null>(null)

  // ESC键关闭弹窗
  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  if (!open) return null

  // 导出时全选/取消会话
  const toggleAllSessions = () => {
    if (selectedSessions.size === sessions.length) {
      setSelectedSessions(new Set())
    } else {
      setSelectedSessions(new Set(sessions.map(s => s.id)))
    }
  }

  // 导出时选择/取消单个会话
  const toggleSession = (id: string) => {
    const newSet = new Set(selectedSessions)
    if (newSet.has(id)) {
      newSet.delete(id)
    } else {
      newSet.add(id)
    }
    setSelectedSessions(newSet)
  }

  // 导出时全选/取消快速命令
  const toggleAllCommands = () => {
    if (selectedCommands.size === quickCommands.length) {
      setSelectedCommands(new Set())
    } else {
      setSelectedCommands(new Set(quickCommands.map(c => c.id)))
    }
  }

  // 导出时选择/取消单个快速命令
  const toggleCommand = (id: string) => {
    const newSet = new Set(selectedCommands)
    if (newSet.has(id)) {
      newSet.delete(id)
    } else {
      newSet.add(id)
    }
    setSelectedCommands(newSet)
  }

  // 导入时全选/取消会话
  const toggleAllImportSessions = () => {
    if (importSessionSelect.size === importSessions.length) {
      setImportSessionSelect(new Set())
    } else {
      setImportSessionSelect(new Set(importSessions.map(s => s.id)))
    }
  }

  // 导入时选择/取消单个会话
  const toggleImportSession = (id: string) => {
    const newSet = new Set(importSessionSelect)
    if (newSet.has(id)) {
      newSet.delete(id)
    } else {
      newSet.add(id)
    }
    setImportSessionSelect(newSet)
  }

  // 导入时全选/取消快速命令
  const toggleAllImportCommands = () => {
    if (importCommandSelect.size === importCommands.length) {
      setImportCommandSelect(new Set())
    } else {
      setImportCommandSelect(new Set(importCommands.map(c => c.id)))
    }
  }

  // 导入时选择/取消单个快速命令
  const toggleImportCommand = (id: string) => {
    const newSet = new Set(importCommandSelect)
    if (newSet.has(id)) {
      newSet.delete(id)
    } else {
      newSet.add(id)
    }
    setImportCommandSelect(newSet)
  }

  // 执行导出
  const handleExport = async () => {
    if (selectedSessions.size === 0 && selectedCommands.size === 0) {
      setMessage({ type: 'error', text: '请选择要导出的内容' })
      return
    }

    setLoading(true)
    setMessage(null)

    try {
      const exportSessions = sessions.filter(s => selectedSessions.has(s.id))
      const exportCommands = quickCommands.filter(c => selectedCommands.has(c.id))

      const result = await window.electronAPI?.exportData(
        {
          sessions: exportSessions,
          quickCommands: exportCommands
        },
        encryptPassword || undefined
      )

      if (result?.success) {
        setMessage({
          type: 'success',
          text: `导出成功: ${result.path}${result.encrypted ? ' (已加密)' : ''}`
        })
      } else {
        setMessage({ type: 'error', text: result?.message || '导出失败' })
      }
    } catch (error) {
      setMessage({ type: 'error', text: (error as Error).message })
    } finally {
      setLoading(false)
    }
  }

  // 选择导入文件
  const handleSelectImportFile = async () => {
    setLoading(true)
    setMessage(null)
    setNeedPassword(false)
    setImportSessions([])
    setImportCommands([])

    try {
      const result = await window.electronAPI?.importData()

      if (result?.needPassword) {
        // 文件需要解密密码
        setNeedPassword(true)
        setImportFilePath(result.path)
        setMessage({ type: 'warning', text: '该文件已加密，请输入解密密码' })
      } else if (result?.success && result.data) {
        setImportSessions(result.data.sessions || [])
        setImportCommands(result.data.quickCommands || [])
        setImportSessionSelect(new Set(result.data.sessions?.map((s: SessionConfig) => s.id) || []))
        setImportCommandSelect(new Set(result.data.quickCommands?.map((c: QuickCommand) => c.id) || []))
        setMessage({ type: 'success', text: `已加载: ${result.path}${result.encrypted ? ' (已解密)' : ''}` })
      } else {
        setMessage({ type: 'error', text: result?.message || '导入失败' })
      }
    } catch (error) {
      setMessage({ type: 'error', text: (error as Error).message })
    } finally {
      setLoading(false)
    }
  }

  // 输入密码后解密
  const handleDecrypt = async () => {
    if (!decryptPassword) {
      setMessage({ type: 'error', text: '请输入解密密码' })
      return
    }

    setLoading(true)
    setMessage(null)

    try {
      const result = await window.electronAPI?.importData(decryptPassword)

      if (result?.success && result.data) {
        setImportSessions(result.data.sessions || [])
        setImportCommands(result.data.quickCommands || [])
        setImportSessionSelect(new Set(result.data.sessions?.map((s: SessionConfig) => s.id) || []))
        setImportCommandSelect(new Set(result.data.quickCommands?.map((c: QuickCommand) => c.id) || []))
        setNeedPassword(false)
        setMessage({ type: 'success', text: '解密成功，数据已加载' })
      } else {
        setMessage({ type: 'error', text: result?.message || '解密失败，密码可能错误' })
      }
    } catch (error) {
      setMessage({ type: 'error', text: '解密失败，密码可能错误' })
    } finally {
      setLoading(false)
    }
  }

  // 执行导入
  const handleImport = async () => {
    if (importSessionSelect.size === 0 && importCommandSelect.size === 0) {
      setMessage({ type: 'error', text: '请选择要导入的内容' })
      return
    }

    setLoading(true)
    setMessage(null)

    try {
      const selectedImportSessions = importSessions.filter(s => importSessionSelect.has(s.id))
      const selectedImportCommands = importCommands.filter(c => importCommandSelect.has(c.id))

      // 导入会话（创建新会话，重新生成ID避免冲突）
      for (const session of selectedImportSessions) {
        const newSession = {
          ...session,
          id: '', // 清空ID，让系统生成新ID
          createdAt: new Date(),
          updatedAt: new Date()
        }
        await window.electronAPI?.createSession(newSession)
      }

      // 导入快速命令（直接保存到配置文件）
      if (selectedImportCommands.length > 0) {
        // 获取现有命令
        const existingCommands = await window.electronAPI?.getQuickCommands() || []
        // 合并导入的命令（重新生成ID避免冲突）
        const newCommands = selectedImportCommands.map(cmd => ({
          ...cmd,
          id: '' // 清空ID，让系统生成新ID
        }))
        // 保存合并后的命令
        await window.electronAPI?.saveQuickCommands([...existingCommands, ...newCommands])
      }

      // 返回导入的数据给父组件处理（刷新UI）
      onImportComplete(selectedImportSessions, selectedImportCommands)

      setMessage({ type: 'success', text: `导入成功: ${selectedImportSessions.length} 个会话, ${selectedImportCommands.length} 个快速命令` })
    } catch (error) {
      setMessage({ type: 'error', text: (error as Error).message })
    } finally {
      setLoading(false)
    }
  }

  // 切换模式时重置状态
  const handleModeChange = (newMode: 'export' | 'import') => {
    setMode(newMode)
    setMessage(null)
    setEncryptPassword('')
    setDecryptPassword('')
    setNeedPassword(false)
    setImportFilePath('')
    if (newMode === 'export') {
      setSelectedSessions(new Set())
      setSelectedCommands(new Set())
    } else {
      setImportSessions([])
      setImportCommands([])
      setImportSessionSelect(new Set())
      setImportCommandSelect(new Set())
    }
  }

  // 获取主机IP
  const getHostIP = (config: SessionConfig) => {
    if (config.ssh) return config.ssh.host
    if (config.telnet) return config.telnet.host
    if (config.serial) return config.serial.path
    return 'unknown'
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-[#2D2D30] rounded-lg shadow-xl w-[500px] max-h-[80vh] overflow-hidden">
        {/* 标题 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#3C3C3C]">
          <span className="text-white font-medium">配置导出/导入</span>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white"
          >
            ✕
          </button>
        </div>

        {/* 模式切换 */}
        <div className="flex px-4 py-2 gap-2 border-b border-[#3C3C3C]">
          <button
            onClick={() => handleModeChange('export')}
            className={`px-4 py-1.5 rounded text-sm ${
              mode === 'export'
                ? 'bg-[#0078D4] text-white'
                : 'bg-[#3C3C3C] text-gray-300 hover:bg-[#555]'
            }`}
          >
            导出
          </button>
          <button
            onClick={() => handleModeChange('import')}
            className={`px-4 py-1.5 rounded text-sm ${
              mode === 'import'
                ? 'bg-[#0078D4] text-white'
                : 'bg-[#3C3C3C] text-gray-300 hover:bg-[#555]'
            }`}
          >
            导入
          </button>
        </div>

        {/* 内容区域 */}
        <div className="px-4 py-3 overflow-y-auto max-h-[50vh]">
          {mode === 'export' ? (
            <>
              {/* 加密密码 */}
              <div className="mb-4">
                <label className="block text-sm text-gray-300 mb-1">
                  加密密码 (可选，加密密码等敏感数据)
                </label>
                <input
                  type="password"
                  value={encryptPassword}
                  onChange={(e) => setEncryptPassword(e.target.value)}
                  placeholder="留空则不加密"
                  className="w-full px-3 py-1.5 bg-[#3C3C3C] border border-[#555] rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:border-[#0078D4]"
                />
                {encryptPassword && (
                  <p className="text-xs text-green-400 mt-1">密码、私钥等敏感数据将被加密</p>
                )}
              </div>

              {/* 会话列表 */}
              <div className="mb-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-sm text-gray-300">会话 ({sessions.length})</span>
                  <button
                    onClick={toggleAllSessions}
                    className="text-xs text-[#0078D4] hover:text-[#0098FF]"
                  >
                    {selectedSessions.size === sessions.length ? '取消全选' : '全选'}
                  </button>
                </div>
                {sessions.length === 0 ? (
                  <div className="text-xs text-gray-500 py-2">暂无会话</div>
                ) : (
                  <div className="space-y-1">
                    {sessions.map(session => (
                      <div
                        key={session.id}
                        onClick={() => toggleSession(session.id)}
                        className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors ${
                          selectedSessions.has(session.id)
                            ? 'bg-[#0078D4]/20 border border-[#0078D4]'
                            : 'bg-[#3C3C3C] hover:bg-[#555]'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={selectedSessions.has(session.id)}
                          onChange={() => toggleSession(session.id)}
                          className="w-4 h-4"
                        />
                        <span className="text-sm text-gray-200 flex-1 truncate">{session.name}</span>
                        <span className="text-xs text-gray-400">{getHostIP(session)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* 快速命令列表 */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-sm text-gray-300">快速命令 ({quickCommands.length})</span>
                  <button
                    onClick={toggleAllCommands}
                    className="text-xs text-[#0078D4] hover:text-[#0098FF]"
                  >
                    {selectedCommands.size === quickCommands.length ? '取消全选' : '全选'}
                  </button>
                </div>
                {quickCommands.length === 0 ? (
                  <div className="text-xs text-gray-500 py-2">暂无快速命令</div>
                ) : (
                  <div className="space-y-1">
                    {quickCommands.map(cmd => (
                      <div
                        key={cmd.id}
                        onClick={() => toggleCommand(cmd.id)}
                        className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors ${
                          selectedCommands.has(cmd.id)
                            ? 'bg-[#0078D4]/20 border border-[#0078D4]'
                            : 'bg-[#3C3C3C] hover:bg-[#555]'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={selectedCommands.has(cmd.id)}
                          onChange={() => toggleCommand(cmd.id)}
                          className="w-4 h-4"
                        />
                        <span className="text-sm text-gray-200 flex-1 truncate">{cmd.name}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              {/* 导入文件选择 */}
              <button
                onClick={handleSelectImportFile}
                disabled={loading}
                className="w-full px-3 py-2 bg-[#3C3C3C] text-gray-200 rounded hover:bg-[#555] transition-colors mb-4 text-sm"
              >
                {loading ? '加载中...' : '选择导入文件 (.json)'}
              </button>

              {/* 需要解密密码 */}
              {needPassword && (
                <div className="mb-4 p-3 bg-[#1E1E1E] rounded border border-[#555]">
                  <p className="text-sm text-yellow-400 mb-2">该文件已加密，请输入解密密码:</p>
                  <input
                    type="password"
                    value={decryptPassword}
                    onChange={(e) => setDecryptPassword(e.target.value)}
                    placeholder="输入解密密码"
                    className="w-full px-3 py-1.5 bg-[#3C3C3C] border border-[#555] rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:border-[#0078D4] mb-2"
                  />
                  <button
                    onClick={handleDecrypt}
                    disabled={loading || !decryptPassword}
                    className="w-full px-3 py-1.5 bg-[#0078D4] text-white rounded text-sm hover:bg-[#006CBD] transition-colors disabled:opacity-50"
                  >
                    {loading ? '解密中...' : '解密'}
                  </button>
                </div>
              )}

              {/* 导入数据预览 */}
              {(importSessions.length > 0 || importCommands.length > 0) && !needPassword && (
                <>
                  {/* 导入会话列表 */}
                  <div className="mb-4">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-sm text-gray-300">会话 ({importSessions.length})</span>
                      <button
                        onClick={toggleAllImportSessions}
                        className="text-xs text-[#0078D4] hover:text-[#0098FF]"
                      >
                        {importSessionSelect.size === importSessions.length ? '取消全选' : '全选'}
                      </button>
                    </div>
                    <div className="space-y-1">
                      {importSessions.map(session => (
                        <div
                          key={session.id}
                          onClick={() => toggleImportSession(session.id)}
                          className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors ${
                            importSessionSelect.has(session.id)
                              ? 'bg-[#0078D4]/20 border border-[#0078D4]'
                              : 'bg-[#3C3C3C] hover:bg-[#555]'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={importSessionSelect.has(session.id)}
                            onChange={() => toggleImportSession(session.id)}
                            className="w-4 h-4"
                          />
                          <span className="text-sm text-gray-200 flex-1 truncate">{session.name}</span>
                          <span className="text-xs text-gray-400">{getHostIP(session)}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* 导入快速命令列表 */}
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-sm text-gray-300">快速命令 ({importCommands.length})</span>
                      <button
                        onClick={toggleAllImportCommands}
                        className="text-xs text-[#0078D4] hover:text-[#0098FF]"
                      >
                        {importCommandSelect.size === importCommands.length ? '取消全选' : '全选'}
                      </button>
                    </div>
                    <div className="space-y-1">
                      {importCommands.map(cmd => (
                        <div
                          key={cmd.id}
                          onClick={() => toggleImportCommand(cmd.id)}
                          className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors ${
                            importCommandSelect.has(cmd.id)
                              ? 'bg-[#0078D4]/20 border border-[#0078D4]'
                              : 'bg-[#3C3C3C] hover:bg-[#555]'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={importCommandSelect.has(cmd.id)}
                            onChange={() => toggleImportCommand(cmd.id)}
                            className="w-4 h-4"
                          />
                          <span className="text-sm text-gray-200 flex-1 truncate">{cmd.name}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {/* 未加载文件提示 */}
              {!needPassword && importSessions.length === 0 && importCommands.length === 0 && (
                <div className="text-center text-gray-500 text-sm py-8">
                  请选择要导入的配置文件
                </div>
              )}
            </>
          )}
        </div>

        {/* 消息提示 */}
        {message && (
          <div className={`px-4 py-2 text-sm ${
            message.type === 'success' ? 'text-green-400' :
            message.type === 'warning' ? 'text-yellow-400' : 'text-red-400'
          }`}>
            {message.text}
          </div>
        )}

        {/* 操作按钮 */}
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-[#3C3C3C]">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-sm text-gray-400 hover:text-white transition-colors"
          >
            关闭
          </button>
          {mode === 'export' ? (
            <button
              onClick={handleExport}
              disabled={loading}
              className="px-4 py-1.5 text-sm bg-[#0078D4] text-white rounded hover:bg-[#006CBD] transition-colors disabled:opacity-50"
            >
              {loading ? '导出中...' : '导出'}
            </button>
          ) : (
            <button
              onClick={handleImport}
              disabled={loading || needPassword || (importSessionSelect.size === 0 && importCommandSelect.size === 0)}
              className="px-4 py-1.5 text-sm bg-[#0078D4] text-white rounded hover:bg-[#006CBD] transition-colors disabled:opacity-50"
            >
              {loading ? '导入中...' : '导入'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export default ExportImportDialog