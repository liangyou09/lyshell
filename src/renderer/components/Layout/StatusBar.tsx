import React, { useState, useEffect, useRef } from 'react'
import cn from 'classnames'
import type { QuickCommand, QuickCommandGroup } from '@shared/types'
import { useTerminalStore } from '../../stores/terminal-store'
import { useSessionStore } from '../../stores/session-store'

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
  const lines = size.bufferLines
  const formattedLines = lines >= 10000 ? `${Math.floor(lines / 1000)}k`
    : lines >= 1000 ? `${(lines / 1000).toFixed(1)}k`
    : `${lines}`
  return (
    <>
      <span>{size.cols}×{size.rows}</span>
      <span aria-hidden className="w-px h-[10px] bg-[var(--rule)] flex-shrink-0" />
      <span className="tabular-nums">{formattedLines}</span>
    </>
  )
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
  const { sessions } = useSessionStore()
  const [groups, setGroups] = useState<QuickCommandGroup[]>([])
  const [activeDropdown, setActiveDropdown] = useState<string | null>(null)
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [showBatchGroupDialog, setShowBatchGroupDialog] = useState(false)  // 批量编辑分组对话框
  const [batchGroups, setBatchGroups] = useState<{id: string, name: string, color: string}[]>([])  // 批量编辑的分组数据
  const [editCommand, setEditCommand] = useState<QuickCommand | undefined>(undefined)
  const [newName, setNewName] = useState('')
  const [newContent, setNewContent] = useState('')
  const [newGroupId, setNewGroupId] = useState<string>('')

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
    name: 'Default',
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
    setNewName('')
    setNewContent('')
    setNewGroupId('')
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
        ? groups.find(g => g.id === targetGroupId)?.name || 'this group'
        : 'Default'
      alert(`${groupName} has reached the 12-command limit`)
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
      { id: 'default', name: 'Default', color: '' },  // 默认分组固定
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

  // 当前分组颜色（用于键帽底部 2px 色条 + 分组键色点）
  const currentGroupColor = currentGroup?.color || ''

  return (
    <div
      className="flex items-stretch justify-between bg-[var(--bg-base)] border-t border-[var(--rule)] h-[30px] text-xs text-[var(--text-rack-mute)] relative"
      ref={dropdownRef}
    >
      {/* 分组选择键 - 最左侧 */}
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
          'h-full flex items-center gap-1.5 flex-shrink-0',
          'bg-[var(--bg-rack)] hover:bg-[var(--bg-slot)]',
          'border-r border-[var(--rule)]',
          'cursor-pointer transition-colors px-2.5',
          activeDropdown === 'groups' && 'bg-[var(--bg-slot)]'
        )}
        title="单击切换分组 · 右键编辑所有分组"
      >
        <span
          className="w-1.5 h-1.5 rounded-full flex-shrink-0"
          style={{
            backgroundColor: currentGroupColor || 'var(--text-rack-dim)',
            boxShadow: 'inset 0 0 0 1px rgba(0,0,0,.4)'
          }}
        />
        <span className="text-[11px] text-[var(--text-rack)] font-medium">{currentGroup ? currentGroup.name : '默认'}</span>
        <span className="text-[9px] text-[var(--text-rack-dim)] -translate-y-px">▾</span>
      </button>

      {/* 中间：键帽轨道 */}
      <div
        className="flex items-center gap-1.5 overflow-x-auto scrollbar-thin flex-1 min-w-0 px-2"
        onDoubleClick={handleDoubleClick}
      >
        {/* 当前显示的命令键帽 */}
        {displayCommands.map((cmd, index) => (
          <button
            key={cmd.id}
            data-cmd
            onClick={() => handleExecute(cmd)}
            onContextMenu={(e) => handleCommandContextMenu(cmd, e)}
            className={cn(
              'group/key relative flex-shrink-0 h-[22px] rounded-[3px]',
              'pl-2 pr-2.5 flex items-center',
              'bg-[var(--bg-slot)] hover:bg-[var(--bg-elev)] active:bg-[var(--rule)]',
              'text-[var(--text-rack)] cursor-pointer transition-colors'
            )}
            style={{
              boxShadow:
                'inset 0 1px 0 rgba(255,255,255,.045), inset 0 -1px 0 rgba(0,0,0,.35), 0 1px 0 rgba(0,0,0,.25)'
            }}
            title={index < 12 ? `Ctrl+F${index + 1}` : undefined}
          >
            {/* F 键丝印 — 左上 8.5px tabular-nums */}
            {index < 12 && (
              <span
                className="absolute top-[1px] left-[4px] text-[8.5px] leading-none text-[var(--text-rack-dim)] pointer-events-none"
                style={{
                  fontFamily: 'ui-monospace, "JetBrains Mono", "Cascadia Code", Consolas, monospace',
                  fontFeatureSettings: '"tnum" 1',
                  letterSpacing: '0.02em'
                }}
              >
                F{index + 1}
              </span>
            )}
            {/* 命令名 — 主字，向下让出丝印位置 */}
            <span className="text-[11px] font-medium leading-none mt-1">{cmd.name}</span>

            {/* 分组色底条 — 2px signature */}
            {currentGroupColor && (
              <span
                className="absolute left-[2px] right-[2px] bottom-[1px] h-[2px] rounded-[1px] pointer-events-none"
                style={{ backgroundColor: currentGroupColor, opacity: 0.92 }}
              />
            )}
          </button>
        ))}

        {/* 空状态：虚线键帽，明示这是个槽位 */}
        {displayCommands.length === 0 && (
          <button
            onClick={handleDoubleClick}
            className={cn(
              'flex-shrink-0 h-[22px] rounded-[3px] px-2.5 flex items-center gap-1.5',
              'border border-dashed border-[var(--bg-elev)] hover:border-[var(--text-rack-dim)]',
              'text-[var(--text-rack-dim)] hover:text-[var(--text-rack-data)]',
              'cursor-pointer transition-colors'
            )}
          >
            <span className="text-[11px] leading-none">+</span>
            <span className="text-[10.5px] leading-none">添加命令</span>
            <span
              className="text-[9.5px] leading-none text-[var(--text-rack-faint)] ml-1"
              style={{ fontFamily: 'ui-monospace, "JetBrains Mono", monospace' }}
            >
              双击此处
            </span>
          </button>
        )}
      </div>

      {/* 分组选择下拉菜单（使用 fixed 定位） */}
      {activeDropdown === 'groups' && (
        <div
          className="fixed bg-[var(--bg-rack)] border border-[var(--rule)] rounded-[2px] shadow-xl z-[100] p-1"
          style={{
            top: `${dropdownPosition.top}px`,
            left: `${dropdownPosition.left}px`,
            width: '168px',
            transform: 'translateY(-100%)',
            boxShadow: '0 12px 28px rgba(0,0,0,.4), 0 2px 4px rgba(0,0,0,.3)'
          }}
        >
          {/* 分组列表（包含默认分组和用户分组） */}
          {allGroups.map(group => {
            const groupCommands = getCommandsByGroup(group.id)
            const isActive = selectedGroupId === group.id
            return (
              <div
                key={group.id}
                className={cn(
                  'flex items-center gap-2 px-2 py-1.5 text-[11.5px] rounded-[2px] cursor-pointer',
                  isActive ? 'bg-[var(--bg-slot)] text-[var(--text-rack)]' : 'text-[var(--text-rack-data)] hover:bg-[var(--bg-slot)]'
                )}
                onClick={(e) => {
                  e.stopPropagation()
                  setSelectedGroupId(group.id)
                  setActiveDropdown(null)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                }}
              >
                <span
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{
                    backgroundColor: group.color || 'var(--text-rack-dim)',
                    boxShadow: 'inset 0 0 0 1px rgba(0,0,0,.3)'
                  }}
                />
                <span className="flex-1">{group.name}</span>
                <span
                  className="text-[var(--text-rack-dim)] text-[10px]"
                  style={{
                    fontFamily: 'ui-monospace, "JetBrains Mono", monospace',
                    fontFeatureSettings: '"tnum" 1'
                  }}
                >
                  {groupCommands.length > 0 ? groupCommands.length : ''}
                </span>
              </div>
            )
          })}
          {/* 分隔 + 编辑入口（升格为明示项） */}
          <div className="h-px bg-[var(--rule)] my-1 mx-1.5" />
          <div
            className="flex items-center gap-2 px-2 py-1.5 text-[11px] rounded-[2px] cursor-pointer text-[var(--text-rack-dim)] hover:text-[var(--text-rack)] hover:bg-[var(--bg-slot)]"
            onClick={(e) => {
              e.stopPropagation()
              setActiveDropdown(null)
              handleOpenGroupDialog()
            }}
          >
            <span
              className="w-2 h-2 rounded-full flex-shrink-0 border border-dashed border-[var(--text-rack-dim)]"
            />
            <span className="flex-1">编辑分组…</span>
          </div>
        </div>
      )}

      {/* 右侧：连接状态簇 — 字段分色 + 1px 分隔条 */}
      <div
        className="flex items-center gap-2.5 flex-shrink-0 px-3 bg-[var(--bg-rack)] border-l border-[var(--rule)] text-[var(--text-rack-data)]"
        style={{
          fontFamily: 'ui-monospace, "JetBrains Mono", "Cascadia Code", Consolas, monospace',
          fontSize: '11px',
          fontFeatureSettings: '"tnum" 1'
        }}
      >
        {sessionId ? (
          <>
            {/* 状态点 — 不再配冗余的 OK 字 */}
            <span
              className="w-[6px] h-[6px] rounded-full flex-shrink-0"
              style={{ backgroundColor: 'var(--live)', boxShadow: '0 0 6px rgba(124,197,118,.5)' }}
              title="connected"
            />
            <span aria-hidden className="w-px h-[10px] bg-[var(--rule)] flex-shrink-0" />
            {/* 协议 — 用协议色，和会话行同语言 */}
            {(() => {
              const s = sessions.find(s => s.id === sessionId)
              const t = s?.config?.type
              const code = t === 'ssh' ? 'SSH' : t === 'telnet' ? 'TEL' : t === 'serial' ? 'SER' : t === 'local' ? 'LOC' : ''
              const color = t === 'ssh' ? 'var(--proto-ssh)'
                : t === 'telnet' ? 'var(--proto-tel)'
                : t === 'serial' ? 'var(--proto-ser)'
                : t === 'local' ? 'var(--proto-loc)'
                : 'var(--text-rack-data)'
              return code ? <span style={{ color }} className="font-semibold tracking-[.08em]">{code}</span> : null
            })()}
            <span aria-hidden className="w-px h-[10px] bg-[var(--rule)] flex-shrink-0" />
            <TerminalSize sessionId={sessionId} />
            <span aria-hidden className="w-px h-[10px] bg-[var(--rule)] flex-shrink-0" />
            <span className="lowercase">utf-8</span>
          </>
        ) : (
          <>
            {/* 空心点 + 小写 mono "no session"，调子和上下文一致 */}
            <span
              className="w-[6px] h-[6px] rounded-full flex-shrink-0"
              style={{ border: '1px solid var(--text-rack-dim)' }}
              title="no session"
            />
            <span className="lowercase">no session</span>
          </>
        )}
        <span aria-hidden className="w-px h-[10px] bg-[var(--rule)] flex-shrink-0" />
        <span className="lowercase">v1.0.2</span>
      </div>

      {/* 添加/编辑命令对话框 */}
      {showAddDialog && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-[var(--bg-slot)] border border-[var(--rule)] rounded-[2px] shadow-xl w-[400px] p-4">
            <div className="text-[11px] uppercase tracking-[.16em] font-semibold text-[var(--text-rack)] mb-3">
              {editCommand ? '编辑命令' : '添加快速命令'}
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-[10px] uppercase tracking-[.1em] text-[var(--text-rack-mute)] mb-1">名称</label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="例如: ls"
                  autoFocus
                  className="w-full px-2 py-1 bg-[var(--bg-elev)] border border-[var(--rule)] rounded-[2px] text-sm text-[var(--text-rack)] placeholder-[var(--text-rack-faint)] focus:outline-none focus:border-[var(--amber)]"
                />
              </div>

              <div>
                <label className="block text-[10px] uppercase tracking-[.1em] text-[var(--text-rack-mute)] mb-1">命令内容（支持多行）</label>
                <textarea
                  value={newContent}
                  onChange={(e) => setNewContent(e.target.value)}
                  placeholder="例如:\ncd /var/www\nls -la"
                  rows={4}
                  className="w-full px-2 py-1 bg-[var(--bg-elev)] border border-[var(--rule)] rounded-[2px] text-sm font-mono text-[var(--text-rack)] placeholder-[var(--text-rack-faint)] focus:outline-none focus:border-[var(--amber)] resize-none"
                />
              </div>

              <div>
                <label className="block text-[10px] uppercase tracking-[.1em] text-[var(--text-rack-mute)] mb-1">所属分组</label>
                <select
                  value={newGroupId}
                  onChange={(e) => setNewGroupId(e.target.value)}
                  className="w-full px-2 py-1 bg-[var(--bg-elev)] border border-[var(--rule)] rounded-[2px] text-sm text-[var(--text-rack)] focus:outline-none focus:border-[var(--amber)]"
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
                    className="px-3 py-1 text-sm text-[var(--error-rack)] hover:opacity-80 transition-opacity"
                  >
                    删除
                  </button>
                )}
                <button
                  onClick={() => {
                    setShowAddDialog(false)
                    resetDialogState()
                  }}
                  className="px-3 py-1 text-sm text-[var(--text-rack-mute)] hover:text-[var(--text-rack)] transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={handleSaveCommand}
                  className="px-3 py-1 text-sm bg-[var(--amber)] text-[var(--bg-base)] font-semibold rounded-[2px] hover:brightness-110 transition-[filter]"
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
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-[var(--bg-slot)] border border-[var(--rule)] rounded-[2px] shadow-xl w-[320px] p-4">
            {/* 标题栏：标题 + 说明提示 + 按钮 */}
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-[.16em] font-semibold text-[var(--text-rack)]">
                <span>编辑分组</span>
                <span
                  className="inline-flex items-center justify-center w-[14px] h-[14px] rounded-full border border-[var(--text-rack-dim)] text-[var(--text-rack-dim)] text-[9px] italic cursor-help"
                  style={{ fontFamily: '"Times New Roman", serif' }}
                  title={"第 1 个是默认分组，名称固定。\n其它分组留空则不显示。\n名称最多 4 字宽（自动按显示宽度截断）。"}
                >
                  i
                </span>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowBatchGroupDialog(false)}
                  className="px-3 py-1.5 text-xs bg-[var(--bg-elev)] text-[var(--text-rack-data)] hover:bg-[var(--rule)] hover:text-[var(--text-rack)] rounded-[2px] transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={handleSaveBatchGroups}
                  className="px-3 py-1.5 text-xs bg-[var(--amber)] text-[var(--bg-base)] font-semibold hover:brightness-110 rounded-[2px] transition-[filter]"
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
                    'flex items-center gap-2 p-2 bg-[var(--bg-elev)] rounded-[2px]',
                    isDefault && 'opacity-80'
                  )}>
                    {/* 分组序号 */}
                    <span className="text-[10px] font-mono text-[var(--text-rack-mute)] w-4">{index + 1}</span>

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
                      placeholder={isDefault ? 'Default' : 'Group name'}
                      disabled={isDefault}
                      className={cn(
                        'px-2 py-1 bg-[var(--bg-base)] border border-[var(--rule)] rounded-[2px] text-sm text-[var(--text-rack)] placeholder-[var(--text-rack-faint)] w-[100px]',
                        isDefault ? 'cursor-not-allowed' : 'focus:outline-none focus:border-[var(--amber)]'
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
                            'w-5 h-5 rounded-[2px] transition-transform',
                            bg.color === color && 'ring-2 ring-[var(--amber)] scale-110'
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
                          'w-5 h-5 rounded-[2px] border border-[var(--rule)] text-xs text-[var(--text-rack-mute)]',
                          !bg.color && 'ring-2 ring-[var(--amber)]'
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