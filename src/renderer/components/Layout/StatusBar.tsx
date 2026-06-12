import React, { useState, useEffect, useRef } from 'react'
import cn from 'classnames'
import type { QuickCommand, QuickCommandGroup } from '@shared/types'
import { useTerminalStore } from '../../stores/terminal-store'

/**
 * 终端尺寸显示组件
 */
const TerminalSize: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const { getTerminal } = useTerminalStore()
  const [size, setSize] = useState<{ cols: number; rows: number; bufferLines: number } | null>(null)

  useEffect(() => {
    const updateSize = () => {
      const instance = getTerminal(sessionId)
      if (instance) {
        const cols = instance.terminal.cols
        const rows = instance.terminal.rows
        const bufferLines = instance.terminal.buffer.active.length
        if (cols && rows) {
          setSize({ cols, rows, bufferLines })
        }
      }
    }
    updateSize()
    const interval = setInterval(updateSize, 2000)
    return () => clearInterval(interval)
  }, [sessionId, getTerminal])

  if (!size) return null
  return <span>{size.cols}x{size.rows} [{size.bufferLines}]</span>
}

interface StatusBarProps {
  sessionId: string | null
  onExecuteCommand: (content: string) => void
  refreshKey?: number  // 用于触发刷新
}

/**
 * 状态栏组件 - 包含快速命令（支持分组）
 */
const StatusBar: React.FC<StatusBarProps> = ({ sessionId, onExecuteCommand, refreshKey }) => {
  const [commands, setCommands] = useState<QuickCommand[]>([])
  const [groups, setGroups] = useState<QuickCommandGroup[]>([])
  const [activeDropdown, setActiveDropdown] = useState<string | null>(null)
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [showGroupDialog, setShowGroupDialog] = useState(false)
  const [showBatchGroupDialog, setShowBatchGroupDialog] = useState(false)  // 批量编辑分组对话框
  const [batchGroups, setBatchGroups] = useState<{id: string, name: string, color: string}[]>([])  // 批量编辑的分组数据
  const [editCommand, setEditCommand] = useState<QuickCommand | undefined>(undefined)
  const [editGroup, setEditGroup] = useState<QuickCommandGroup | undefined>(undefined)
  const [newName, setNewName] = useState('')
  const [newContent, setNewContent] = useState('')
  const [newGroupId, setNewGroupId] = useState<string>('')
  const [newGroupName, setNewGroupName] = useState('')
  const [newGroupColor, setNewGroupColor] = useState('')

  const dropdownRef = useRef<HTMLDivElement>(null)
  const groupButtonRef = useRef<HTMLButtonElement>(null)
  // 初始化时选中默认分组
  const [selectedGroupId, setSelectedGroupId] = useState<string>('default')
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0 })

  // 加载命令和分组
  useEffect(() => {
    loadCommands()
    loadGroups()
  }, [refreshKey])

  // 加载命令
  const loadCommands = async () => {
    try {
      const result = await window.electronAPI?.getQuickCommands()
      if (result && Array.isArray(result)) {
        const validCommands = result
          .filter(cmd => cmd && cmd.name && cmd.content)
          .map((cmd, index) => ({
            ...cmd,
            id: cmd.id || Date.now().toString() + Math.random().toString(36).slice(2),
            groupId: cmd.groupId || undefined,
            order: cmd.order ?? index
          }))
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        setCommands(validCommands)
      }
    } catch (err) {
      console.error('Failed to load quick commands:', err)
    }
  }

  // 默认分组（始终存在，不可删除，名称固定）
  const DEFAULT_GROUP: QuickCommandGroup = {
    id: 'default',
    name: '默认分组',
    order: 0
  }

  // 合并默认分组和用户分组（过滤掉名称为空的分组）
  const allGroups = [DEFAULT_GROUP, ...groups.filter(g => g.name && g.name.trim().length > 0)]

  // 加载分组
  const loadGroups = async () => {
    try {
      const result = await window.electronAPI?.commandGroupList()
      if (result && Array.isArray(result)) {
        // 过滤掉没有有效 ID 的分组，排除默认分组（避免重复）
        const validGroups = result.filter(g => g && g.id && g.id !== 'default')
        setGroups(validGroups)
      }
    } catch (err) {
      console.error('Failed to load groups:', err)
    }
  }

  // 关闭下拉菜单（点击外部）
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setActiveDropdown(null)
      }
    }
    window.addEventListener('click', handleClickOutside)
    return () => window.removeEventListener('click', handleClickOutside)
  }, [])

  // ESC键关闭对话框
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowAddDialog(false)
        setShowGroupDialog(false)
        setShowBatchGroupDialog(false)
        setActiveDropdown(null)
        resetDialogState()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Ctrl + F1-F12 快捷键执行快速命令
  useEffect(() => {
    const handleShortcut = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return

      // F1-F12 对应快捷键索引 0-11
      const fKeyMatch = e.key.match(/^F([1-9]|1[0-2])$/)
      if (!fKeyMatch) return

      e.preventDefault()

      const index = parseInt(fKeyMatch[1]) - 1
      if (index >= 0 && index < 12) {
        // 直接根据当前 selectedGroupId 过滤命令
        const groupId = selectedGroupId || 'default'
        const currentCommands = groupId === 'default'
          ? commands.filter(c => !c.groupId || c.groupId === '')
          : commands.filter(c => c.groupId === groupId)

        const sortedCommands = [...currentCommands].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))

        if (index < sortedCommands.length) {
          const cmd = sortedCommands[index]
          const lines = cmd.content.split('\n')
          lines.forEach(line => {
            if (line.trim()) {
              onExecuteCommand(line.trim())
            }
          })
        }
      }
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [selectedGroupId, commands, onExecuteCommand])

  // 重置对话框状态
  const resetDialogState = () => {
    setEditCommand(undefined)
    setEditGroup(undefined)
    setNewName('')
    setNewContent('')
    setNewGroupId('')
    setNewGroupName('')
    setNewGroupColor('')
  }

  // 双击添加命令
  const handleDoubleClick = () => {
    setEditCommand(undefined)
    setNewName('')
    setNewContent('')
    // 自动填入当前选中的分组（默认分组则不填 groupId）
    setNewGroupId(selectedGroupId === 'default' ? '' : selectedGroupId)
    setShowAddDialog(true)
  }

  // 单击执行命令
  const handleExecute = (cmd: QuickCommand) => {
    const lines = cmd.content.split('\n')
    lines.forEach(line => {
      if (line.trim()) {
        onExecuteCommand(line.trim())
      }
    })
    setActiveDropdown(null)
  }

  // 右键编辑命令
  const handleCommandContextMenu = (cmd: QuickCommand, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setEditCommand(cmd)
    setNewName(cmd.name)
    setNewContent(cmd.content)
    setNewGroupId(cmd.groupId || '')
    setShowAddDialog(true)
    setActiveDropdown(null)
  }

  // 保存命令
  const handleSaveCommand = async () => {
    if (!newName.trim() || !newContent.trim()) return

    // 检查分组命令数量限制（最多12个）
    const targetGroupId = newGroupId || undefined
    const groupCommands = commands.filter(c => c.groupId === targetGroupId)

    // 编辑模式时不检查数量（因为只是修改，不增加）
    if (!editCommand && groupCommands.length >= 12) {
      const groupName = targetGroupId
        ? groups.find(g => g.id === targetGroupId)?.name || '该分组'
        : '默认分组'
      alert(`${groupName}已达到最大12个命令限制`)
      return
    }

    const command: QuickCommand = {
      id: editCommand?.id || Date.now().toString(),
      name: newName.trim(),
      content: newContent,
      groupId: targetGroupId,
      order: editCommand?.order ?? groupCommands.length  // 设置顺序
    }

    if (editCommand) {
      await window.electronAPI?.commandUpdate(command)
    } else {
      await window.electronAPI?.commandAdd(command)
    }

    await loadCommands()
    setShowAddDialog(false)
    resetDialogState()
  }

  // 删除命令
  const handleDeleteCommand = async () => {
    if (editCommand) {
      await window.electronAPI?.commandDelete(editCommand.id)
      await loadCommands()
      setShowAddDialog(false)
      resetDialogState()
    }
  }

  // 打开批量编辑分组对话框
  const handleOpenGroupDialog = () => {
    // 初始化批量编辑数据：默认分组（固定名称） + 用户分组 + 空槽位（补齐到4个）
    const editGroups: {id: string, name: string, color: string}[] = [
      { id: 'default', name: '默认分组', color: '' },  // 默认分组固定
      ...groups.map(g => ({ id: g.id, name: g.name, color: g.color || '' }))
    ]
    // 补齐空槽位到4个用户分组
    while (editGroups.length < 5) {
      editGroups.push({ id: '', name: '', color: '' })
    }
    // 确保最多5个分组（1默认+4用户）
    setBatchGroups(editGroups.slice(0, 5))
    setShowBatchGroupDialog(true)
  }

  // 保存分组
  const handleSaveGroup = async () => {
    if (!newGroupName.trim()) return

    // 限制最多5个分组（包含默认分组，用户最多创建4个）
    if (!editGroup && groups.length >= 4) {
      alert('最多只能创建4个分组（已包含默认分组）')
      return
    }

    const group: QuickCommandGroup = {
      id: editGroup?.id || Date.now().toString(),
      name: newGroupName.trim(),
      color: newGroupColor || undefined,
      order: editGroup?.order ?? groups.length + 1  // 默认分组order为0，用户分组从1开始
    }

    if (editGroup) {
      await window.electronAPI?.commandGroupUpdate(group)
    } else {
      await window.electronAPI?.commandGroupAdd(group)
    }

    await loadGroups()
    setShowGroupDialog(false)
    resetDialogState()
  }

  // 批量保存分组（只能编辑，不能新增或删除）
  const handleSaveBatchGroups = async () => {
    // 更新默认分组颜色（名称固定，不保存到数据库）
    DEFAULT_GROUP.color = batchGroups[0].color || undefined

    // 更新用户分组（索引1-4）
    for (let i = 1; i < batchGroups.length; i++) {
      const batchGroup = batchGroups[i]

      if (batchGroup.id) {
        // 更新已有分组
        await window.electronAPI?.commandGroupUpdate({
          id: batchGroup.id,
          name: batchGroup.name.trim(),
          color: batchGroup.color || undefined,
          order: i
        })
      } else if (batchGroup.name.trim()) {
        // 创建新分组
        const newId = `group-${Date.now()}-${i}`
        await window.electronAPI?.commandGroupAdd({
          id: newId,
          name: batchGroup.name.trim(),
          color: batchGroup.color || undefined,
          order: i
        })
      }
    }

    await loadGroups()
    setShowBatchGroupDialog(false)
  }

  // 获取分组下的命令（默认分组显示未分配groupId的命令，包括空字符串）
  const getCommandsByGroup = (groupId: string) => {
    if (groupId === 'default') {
      return commands.filter(c => !c.groupId || c.groupId === '')
    }
    return commands.filter(c => c.groupId === groupId)
  }

  // 获取当前显示的命令（按顺序排列）
  const currentGroup = allGroups.find(g => g.id === selectedGroupId) || DEFAULT_GROUP
  const displayCommands = getCommandsByGroup(selectedGroupId || 'default')
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))

  // 预定义颜色
  const predefinedColors = ['#0078D4', '#E81123', '#107C10', '#FFB900', '#881798', '#00CC99']

  // 限制字符串的视觉宽度不超过最大值（中文字符算1，英文字符算0.5）
  const limitVisualWidth = (str: string, maxWidth: number): string => {
    let result = ''
    let width = 0
    for (const char of str) {
      const charWidth = /[\u4e00-\u9fff]/.test(char) ? 1 : 0.5
      if (width + charWidth <= maxWidth) {
        result += char
        width += charWidth
      } else {
        break
      }
    }
    return result
  }

  return (
    <div
      className="flex items-center justify-between bg-[#252526] border-t border-[#3C3C3C] h-[28px] text-xs text-gray-400 relative"
      ref={dropdownRef}
    >
      {/* 分组选择按钮 - 最左侧 */}
      <button
        ref={groupButtonRef}
        onClick={(e) => {
          e.stopPropagation()
          const newDropdown = activeDropdown === 'groups' ? null : 'groups'
          // 计算下拉菜单位置（按钮上方）
          if (newDropdown === 'groups' && groupButtonRef.current) {
            const rect = groupButtonRef.current.getBoundingClientRect()
            setDropdownPosition({
              top: rect.top - 2,
              left: rect.left
            })
          }
          setActiveDropdown(newDropdown)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          // 右键打开批量编辑分组对话框
          handleOpenGroupDialog()
        }}
        className={cn(
          'h-full flex items-center justify-center flex-shrink-0',
          'bg-[#3C3C3C] text-gray-300 hover:bg-[#555] hover:text-white',
          'cursor-pointer transition-colors',
          activeDropdown === 'groups' && 'bg-[#555]',
          'border-r border-l border-gray-600'  // 左右两侧暗灰色边框
        )}
        style={{
          paddingLeft: '8px',
          paddingRight: '8px',
          width: '70px'
        }}
        title="单击切换分组 | 右键编辑所有分组"
      >
        <span className="text-xs">{currentGroup ? currentGroup.name : '默认分组'}</span>
      </button>

      {/* 中间：快速命令 */}
      <div
        className="flex items-center gap-1 overflow-x-auto scrollbar-thin flex-1 min-w-0 pl-1 pr-3"
        onDoubleClick={handleDoubleClick}
      >
        {/* 当前显示的命令按钮 */}
        {displayCommands.map((cmd, index) => (
          <button
            key={cmd.id}
            data-cmd
            onClick={() => handleExecute(cmd)}
            onContextMenu={(e) => handleCommandContextMenu(cmd, e)}
            className={cn(
              'px-2 py-0.5 text-xs whitespace-nowrap flex-shrink-0 relative',
              'bg-[#3C3C3C] text-gray-300 hover:bg-[#555] hover:text-white',
              'cursor-pointer transition-colors'
            )}
            title={index < 12 ? `Ctrl+F${index + 1}` : undefined}
          >
            {cmd.name}
            {index < 12 && (
              <span className="absolute top-0 right-0 text-gray-400 text-[8px] leading-none">{index + 1}</span>
            )}
          </button>
        ))}

        {/* 空状态提示 */}
        {displayCommands.length === 0 && (
          <span className="text-gray-500">双击添加快速命令</span>
        )}
      </div>

      {/* 分组选择下拉菜单（使用 fixed 定位） */}
      {activeDropdown === 'groups' && (
        <div
          className="fixed bg-[#2D2D30] border border-[#3C3C3C] rounded shadow-lg z-[100]"
          style={{
            top: `${dropdownPosition.top}px`,
            left: `${dropdownPosition.left}px`,
            width: '90px',
            transform: 'translateY(-100%)'
          }}
        >
          {/* 分组列表（包含默认分组和用户分组） */}
          {allGroups.map(group => {
            const groupCommands = getCommandsByGroup(group.id)
            return (
              <div
                key={group.id}
                className={cn(
                  'flex items-center gap-2 px-3 py-1.5 text-xs',
                  selectedGroupId === group.id ? 'bg-[#0078D4] text-white' : 'text-gray-300 hover:bg-[#3C3C3C]',
                  'cursor-pointer'
                )}
                style={{ borderLeft: group.color ? `3px solid ${group.color}` : undefined }}
                onClick={(e) => {
                  e.stopPropagation()
                  setSelectedGroupId(group.id)
                  setActiveDropdown(null)
                }}
                onContextMenu={(e) => {
                  // 禁用右键编辑，统一使用双击批量编辑
                  e.preventDefault()
                }}
              >
                <span className="flex-1">{group.name}</span>
                <span className="text-gray-400 text-[11px]">{groupCommands.length > 0 ? groupCommands.length : ''}</span>
              </div>
            )
          })}
        </div>
      )}

      {/* 右侧：连接状态和版本 */}
      <div className="flex items-center gap-4 flex-shrink-0">
        {sessionId ? (
          <>
            <span className="text-green-400">OK</span>
            <span>SSH</span>
            <TerminalSize sessionId={sessionId} />
            <span>UTF-8</span>
          </>
        ) : (
          <span>未连接</span>
        )}
        <span className="text-gray-500">v1.0.1</span>
      </div>

      {/* 添加/编辑命令对话框 */}
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
                  autoFocus
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

              <div>
                <label className="block text-xs text-gray-400 mb-1">所属分组</label>
                <select
                  value={newGroupId}
                  onChange={(e) => setNewGroupId(e.target.value)}
                  className="w-full px-2 py-1 bg-[#3C3C3C] border border-[#555] rounded text-sm text-white focus:outline-none focus:border-[#0078D4]"
                >
                  <option value="">默认</option>
                  {groups.map(g => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                </select>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                {editCommand && (
                  <button
                    onClick={handleDeleteCommand}
                    className="px-3 py-1 text-sm text-red-400 hover:text-red-300 transition-colors"
                  >
                    删除
                  </button>
                )}
                <button
                  onClick={() => {
                    setShowAddDialog(false)
                    resetDialogState()
                  }}
                  className="px-3 py-1 text-sm text-gray-400 hover:text-white transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={handleSaveCommand}
                  className="px-3 py-1 text-sm bg-[#0078D4] text-white rounded hover:bg-[#006CBD] transition-colors"
                >
                  保存
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 分组管理对话框 */}
      {showGroupDialog && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-[#2D2D30] rounded-lg shadow-xl w-[400px] p-4">
            <div className="text-sm text-white font-medium mb-3">
              编辑分组
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">分组名称</label>
                <input
                  type="text"
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  placeholder="例如: 系统"
                  autoFocus
                  className="w-full px-2 py-1 bg-[#3C3C3C] border border-[#555] rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:border-[#0078D4]"
                />
              </div>

              <div>
                <label className="block text-xs text-gray-400 mb-1">分组颜色</label>
                <div className="flex gap-2">
                  {predefinedColors.map(color => (
                    <button
                      key={color}
                      onClick={() => setNewGroupColor(color)}
                      className={cn(
                        'w-6 h-6 rounded transition-transform',
                        newGroupColor === color && 'ring-2 ring-white scale-110'
                      )}
                      style={{ backgroundColor: color }}
                    />
                  ))}
                  <button
                    onClick={() => setNewGroupColor('')}
                    className={cn(
                      'w-6 h-6 rounded border border-[#555] text-xs text-gray-400',
                      !newGroupColor && 'ring-2 ring-white'
                    )}
                  >
                    ✕
                  </button>
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  onClick={() => setShowGroupDialog(false)}
                  className="px-3 py-1 text-sm text-gray-400 hover:text-white transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={handleSaveGroup}
                  className="px-3 py-1 text-sm bg-[#0078D4] text-white rounded hover:bg-[#006CBD] transition-colors"
                >
                  保存
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 批量编辑分组对话框 */}
      {showBatchGroupDialog && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-[#2D2D30] rounded-lg shadow-xl w-[320px] p-4">
            {/* 标题栏：标题 + 感叹号提示 + 按钮 */}
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-1 text-sm text-white font-medium">
                <span>编辑分组（共5个）</span>
                <span
                  className="text-yellow-500 cursor-help"
                  title="第1个为默认分组（名称固定不可编辑）\n名称为空的用户分组不会显示在下拉列表中\n最多可输入4个中文字符或8个英文字符"
                >
                  !
                </span>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowBatchGroupDialog(false)}
                  className="px-3 py-1.5 text-xs bg-[#3C3C3C] text-gray-300 hover:bg-[#555] hover:text-white rounded transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={handleSaveBatchGroups}
                  className="px-3 py-1.5 text-xs bg-[#3C3C3C] text-gray-300 hover:bg-[#555] hover:text-white rounded transition-colors"
                >
                  保存
                </button>
              </div>
            </div>

            <div className="space-y-2">
              {batchGroups.map((bg, index) => {
                const isDefault = index === 0
                return (
                  <div key={index} className={cn(
                    'flex items-center gap-2 p-2 bg-[#3C3C3C] rounded',
                    isDefault && 'opacity-80'
                  )}>
                    {/* 分组序号 */}
                    <span className="text-xs text-gray-400 w-4">{index + 1}</span>

                    {/* 分组名称 */}
                    <input
                      type="text"
                      value={bg.name}
                      onChange={(e) => {
                        if (isDefault) return  // 默认分组不可编辑名称
                        const newGroups = [...batchGroups]
                        newGroups[index].name = limitVisualWidth(e.target.value, 4)  // 最多4个中文字符宽度
                        setBatchGroups(newGroups)
                      }}
                      placeholder={isDefault ? '默认分组' : '输入名称'}
                      disabled={isDefault}
                      className={cn(
                        'px-2 py-1 bg-[#252526] border border-[#555] rounded text-sm text-white placeholder-gray-500 w-[100px]',
                        isDefault ? 'cursor-not-allowed' : 'focus:outline-none focus:border-[#0078D4]'
                      )}
                    />

                    {/* 分组颜色选择 */}
                    <div className="flex gap-1">
                      {predefinedColors.slice(0, 4).map(color => (
                        <button
                          key={color}
                          onClick={() => {
                            const newGroups = [...batchGroups]
                            newGroups[index].color = color
                            setBatchGroups(newGroups)
                          }}
                          className={cn(
                            'w-5 h-5 rounded transition-transform',
                            bg.color === color && 'ring-2 ring-white scale-110'
                          )}
                          style={{ backgroundColor: color }}
                        />
                      ))}
                      <button
                        onClick={() => {
                          const newGroups = [...batchGroups]
                          newGroups[index].color = ''
                          setBatchGroups(newGroups)
                        }}
                        className={cn(
                          'w-5 h-5 rounded border border-[#555] text-xs text-gray-400',
                          !bg.color && 'ring-2 ring-white'
                        )}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default StatusBar