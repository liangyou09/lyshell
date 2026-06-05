import React, { useState, useEffect } from 'react'
import cn from 'classnames'

interface QuickCommand {
  id: string
  name: string
  content: string
}

interface StatusBarProps {
  sessionId: string | null
  onExecuteCommand: (content: string) => void
}

/**
 * 状态栏组件 - 包含快速命令
 */
const StatusBar: React.FC<StatusBarProps> = ({ sessionId, onExecuteCommand }) => {
  const [commands, setCommands] = useState<QuickCommand[]>([])
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [editCommand, setEditCommand] = useState<QuickCommand | undefined>(undefined)
  const [newName, setNewName] = useState('')
  const [newContent, setNewContent] = useState('')

  // 加载保存的快速命令
  useEffect(() => {
    const saved = localStorage.getItem('quickCommands')
    if (saved) {
      try {
        const parsed = JSON.parse(saved)
        if (Array.isArray(parsed)) {
          setCommands(parsed)
        }
      } catch {
        setCommands([])
      }
    }
  }, [])

  // 保存命令到 localStorage
  const saveCommands = (cmds: QuickCommand[]) => {
    setCommands(cmds)
    localStorage.setItem('quickCommands', JSON.stringify(cmds))
  }

  // 双击添加命令
  const handleDoubleClick = () => {
    setEditCommand(undefined)
    setNewName('')
    setNewContent('')
    setShowAddDialog(true)
  }

  // 单击执行命令（支持多行）
  const handleExecute = (cmd: QuickCommand, e: React.MouseEvent) => {
    e.stopPropagation()
    const lines = cmd.content.split('\n')
    lines.forEach(line => {
      if (line.trim()) {
        onExecuteCommand(line.trim())
      }
    })
  }

  // 右键编辑/删除
  const handleContextMenu = (cmd: QuickCommand, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setEditCommand(cmd)
    setNewName(cmd.name)
    setNewContent(cmd.content)
    setShowAddDialog(true)
  }

  // 添加/编辑命令
  const handleSave = () => {
    if (!newName.trim() || !newContent.trim()) return

    if (editCommand) {
      const updated = commands.map(c =>
        c.id === editCommand.id
          ? { ...c, name: newName.trim(), content: newContent }
          : c
      )
      saveCommands(updated)
    } else {
      const newCmd: QuickCommand = {
        id: Date.now().toString(),
        name: newName.trim(),
        content: newContent
      }
      saveCommands([...commands, newCmd])
    }

    setShowAddDialog(false)
    setEditCommand(undefined)
    setNewName('')
    setNewContent('')
  }

  // 删除命令
  const handleDelete = () => {
    if (editCommand) {
      const updated = commands.filter(c => c.id !== editCommand.id)
      saveCommands(updated)
      setShowAddDialog(false)
      setEditCommand(undefined)
    }
  }

  return (
    <div
      className="flex items-center justify-between bg-[#252526] border-t border-[#3C3C3C] h-[28px] px-3 text-xs text-gray-400 overflow-hidden"
      onDoubleClick={handleDoubleClick}
    >
      {/* 左侧：快速命令 */}
      <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide flex-1 min-w-0">
        {/* 命令列表 */}
        {commands.map((cmd) => (
          <button
            key={cmd.id}
            onClick={(e) => handleExecute(cmd, e)}
            onContextMenu={(e) => handleContextMenu(cmd, e)}
            className={cn(
              'px-2 py-0.5 rounded text-xs whitespace-nowrap',
              'bg-[#3C3C3C] text-gray-300 hover:bg-[#555] hover:text-white',
              'cursor-pointer transition-colors'
            )}
          >
            {cmd.name}
          </button>
        ))}

        {/* 空状态提示 */}
        {commands.length === 0 && (
          <span className="text-gray-500">双击添加快速命令</span>
        )}
      </div>

      {/* 右侧：连接状态和版本 */}
      <div className="flex items-center gap-4 flex-shrink-0">
        {sessionId ? (
          <>
            <span className="text-green-400">OK</span>
            <span>SSH</span>
            <span>UTF-8</span>
          </>
        ) : (
          <span>未连接</span>
        )}
        <span className="text-gray-500">NovaShell v1.0.1</span>
      </div>

      {/* 添加/编辑对话框 */}
      {showAddDialog && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-[#2D2D30] rounded-lg shadow-xl w-[400px] p-4">
            <div className="text-sm text-white font-medium mb-3">
              {editCommand ? '编辑命令' : '添加快速命令'}
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">名称</label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="例如: ls"
                  className="w-full px-2 py-1 bg-[#3C3C3C] border border-[#555] rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:border-[#0078D4]"
                />
              </div>

              <div>
                <label className="block text-xs text-gray-400 mb-1">命令内容（支持多行）</label>
                <textarea
                  value={newContent}
                  onChange={(e) => setNewContent(e.target.value)}
                  placeholder="例如:\ncd /var/www\nls -la"
                  rows={4}
                  className="w-full px-2 py-1 bg-[#3C3C3C] border border-[#555] rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:border-[#0078D4] resize-none"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                {editCommand && (
                  <button
                    onClick={handleDelete}
                    className="px-3 py-1 text-sm text-red-400 hover:text-red-300 transition-colors"
                  >
                    删除
                  </button>
                )}
                <button
                  onClick={() => setShowAddDialog(false)}
                  className="px-3 py-1 text-sm text-gray-400 hover:text-white transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={handleSave}
                  className="px-3 py-1 text-sm bg-[#0078D4] text-white rounded hover:bg-[#006CBD] transition-colors"
                >
                  保存
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default StatusBar