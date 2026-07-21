import React, { useState, useEffect, useRef } from 'react'
import cn from 'classnames'
import { useTranslation } from 'react-i18next'
import type { QuickCommand, QuickCommandGroup } from '@shared/types'
import { processInputEscapeSequences } from '@shared/escape-sequences'
import { useTerminalStore } from '../../stores/terminal-store'
import { useSessionStore } from '../../stores/session-store'

/**
 * 终端尺寸显示组件
 */
const TerminalSize: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const { getTerminal } = useTerminalStore()
  const { t } = useTranslation()
  const [size, setSize] = useState<{ cols: number; rows: number; bufferLines: number } | null>(null)
  // 行数单击/双击区分:单击滚回底部、双击清空 scrollback,用定时器避免单击动作在双击时先行触发
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  // 卸载时清掉待触发的单击定时器,避免组件销毁后仍 scrollToBottom
  useEffect(() => {
    return () => {
      if (clickTimer.current) clearTimeout(clickTimer.current)
    }
  }, [])

  if (!size) return null
  const lines = size.bufferLines
  const formattedLines = lines >= 10000 ? `${Math.floor(lines / 1000)}k`
    : lines >= 1000 ? `${(lines / 1000).toFixed(1)}k`
    : `${lines}`

  // size 单击:往 PTY 发 Ctrl+L(\x0c),清当前屏并重绘提示符,保留 scrollback
  const handleSizeClick = () => {
    window.electronAPI?.terminalWrite(sessionId, '\x0c')
  }

  // 行数:首次点击起一个 250ms 定时器做"滚回底部";定时器未到期又来一次点击则取消并"清空 scrollback"
  const handleLinesClick = () => {
    const instance = getTerminal(sessionId)
    if (!instance) return
    if (clickTimer.current) {
      clearTimeout(clickTimer.current)
      clickTimer.current = null
      instance.terminal.clear()
    } else {
      clickTimer.current = setTimeout(() => {
        clickTimer.current = null
        instance.terminal.scrollToBottom()
      }, 250)
    }
  }

  return (
    <>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={handleSizeClick}
        title={t('statusbar.clearScreenHint')}
        className="bg-transparent border-0 p-0 cursor-pointer [font-family:inherit] [font-size:inherit] [line-height:inherit] hover:text-[var(--text-rack)] transition-colors"
      >
        {size.cols}×{size.rows}
      </button>
      <span aria-hidden className="w-px h-[10px] bg-[var(--rule)] flex-shrink-0" />
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={handleLinesClick}
        title={t('statusbar.scrollBottomHint')}
        className="tabular-nums bg-transparent border-0 p-0 cursor-pointer [font-family:inherit] [font-size:inherit] [line-height:inherit] hover:text-[var(--text-rack)] transition-colors"
      >
        {formattedLines}
      </button>
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
  const { t } = useTranslation()
  const [groups, setGroups] = useState<QuickCommandGroup[]>([])
  const [defaultGroupColor, setDefaultGroupColor] = useState<string>('')
  const [activeDropdown, setActiveDropdown] = useState<string | null>(null)
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [showBatchGroupDialog, setShowBatchGroupDialog] = useState(false)  // 批量编辑分组对话框
  const [batchGroups, setBatchGroups] = useState<{id: string, name: string, color: string}[]>([])  // 批量编辑的分组数据
  const [editCommand, setEditCommand] = useState<QuickCommand | undefined>(undefined)
  const [newName, setNewName] = useState('')
  const [newContent, setNewContent] = useState('')
  const [newGroupId, setNewGroupId] = useState<string>('')
  const [newEscape, setNewEscape] = useState(false)
  const [editingCommandId, setEditingCommandId] = useState<string | null>(null)
  const [groupDialogOffset, setGroupDialogOffset] = useState({ x: 0, y: 0 })
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)

  const dropdownRef = useRef<HTMLDivElement>(null)
  const groupButtonRef = useRef<HTMLButtonElement>(null)
  // 初始化时选中默认分组
  const [selectedGroupId, setSelectedGroupId] = useState<string>('default')
  const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0 })

  // 加载命令和分组
  useEffect(() => {
    loadCommands()
    loadGroups()
    loadDefaultGroupColor()
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

  // 默认分组（始终存在，不可删除，名称固定，颜色持久化到偏好设置）
  const DEFAULT_GROUP: QuickCommandGroup = {
    id: 'default',
    name: 'Default',
    order: 0,
    color: defaultGroupColor || undefined
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

  // 加载默认分组颜色（从偏好设置持久化，未设置时默认粉色）
  const loadDefaultGroupColor = async () => {
    try {
      const color = await window.electronAPI?.getConfig?.('quickCommand.defaultGroupColor')
      if (typeof color === 'string') {
        setDefaultGroupColor(color)
      } else {
        setDefaultGroupColor('#0078D4')
      }
    } catch (err) {
      console.error('Failed to load default group color:', err)
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
        setEditingCommandId(null)
        resetDialogState()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // 把单行 content 展开成待发送文本：勾选转义时解析 \n \r \t \xHH，否则 trim。
  const expandLine = (escapeSequences: boolean | undefined, line: string): string | null => {
    const processed = escapeSequences ? processInputEscapeSequences(line) : line.trim()
    return processed || null
  }

  // Ctrl + F1-F12 快捷键执行快速命令
  useEffect(() => {
    const handleShortcut = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return

      // F1-F12 对应快捷键索引 0-11
      const fKeyMatch = e.key.match(/^F([1-9]|1[0-2])$/)
      if (!fKeyMatch) return

      // 必须 stopPropagation:capture 阶段截断后阻止事件继续传到 xterm,
      // 否则 xterm 仍会把 F1-F12 解析成转义序列发进 PTY(快捷命令与转义序列双发)。
      e.preventDefault()
      e.stopPropagation()

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
            const processed = expandLine(cmd.escapeSequences, line)
            if (processed) {
              onExecuteCommand(processed)
            }
          })
        }
      }
    }
    // 用 capture 阶段:焦点在终端时 xterm 会先在 textarea 上处理 F1-F12 并
    // stopPropagation,冒泡阶段的 window 监听收不到事件;capture 抢在 xterm 之前截走。
    window.addEventListener('keydown', handleShortcut, true)
    return () => window.removeEventListener('keydown', handleShortcut, true)
  }, [selectedGroupId, commands, onExecuteCommand])

  // 重置对话框状态
  const resetDialogState = () => {
    setEditCommand(undefined)
    setNewName('')
    setNewContent('')
    setNewGroupId('')
    setNewEscape(false)
  }

  // 双击添加命令
  const handleDoubleClick = () => {
    setEditCommand(undefined)
    setEditingCommandId(null)
    setNewName('')
    setNewContent('')
    setNewEscape(false)
    // 自动填入当前选中的分组（默认分组则不填 groupId）
    setNewGroupId(selectedGroupId === 'default' ? '' : selectedGroupId)
    setShowAddDialog(true)
  }

  // 单击执行命令
  const handleExecute = (cmd: QuickCommand) => {
    const lines = cmd.content.split('\n')
    lines.forEach(line => {
      const processed = expandLine(cmd.escapeSequences, line)
      if (processed) {
        onExecuteCommand(processed)
      }
    })
    setActiveDropdown(null)
  }

  // 右键编辑命令
  const handleCommandContextMenu = (cmd: QuickCommand, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setEditCommand(cmd)
    setEditingCommandId(cmd.id)
    setNewName(cmd.name)
    setNewContent(cmd.content)
    setNewGroupId(cmd.groupId || '')
    setNewEscape(cmd.escapeSequences ?? false)
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
      alert(t('statusbar.commandLimit', { name: groupName }))
      return
    }

    const command: QuickCommand = {
      id: editCommand?.id || Date.now().toString(),
      name: newName.trim(),
      content: newContent,
      groupId: targetGroupId,
      escapeSequences: newEscape,
      order: editCommand?.order ?? groupCommands.length  // 设置顺序
    }

    if (editCommand) {
      await window.electronAPI?.commandUpdate(command)
    } else {
      await window.electronAPI?.commandAdd(command)
    }

    await loadCommands()
    setShowAddDialog(false)
    setEditingCommandId(null)
    resetDialogState()
  }

  // 删除命令
  const handleDeleteCommand = async () => {
    if (editCommand) {
      await window.electronAPI?.commandDelete(editCommand.id)
      await loadCommands()
      setShowAddDialog(false)
      setEditingCommandId(null)
      resetDialogState()
    }
  }

  // 拖动分组编辑窗口
  const handleGroupDialogMouseDown = (e: React.MouseEvent) => {
    const startX = e.clientX
    const startY = e.clientY
    const startOffsetX = groupDialogOffset.x
    const startOffsetY = groupDialogOffset.y

    const handleMouseMove = (e: MouseEvent) => {
      setGroupDialogOffset({
        x: startOffsetX + e.clientX - startX,
        y: startOffsetY + e.clientY - startY
      })
    }

    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
  }

  // 打开批量编辑分组对话框
  const handleOpenGroupDialog = () => {
    // 固定 1 个默认分组 + 4 个用户分组槽位
    const editGroups: {id: string, name: string, color: string}[] = [
      { id: 'default', name: 'Default', color: defaultGroupColor },
      ...groups.map(g => ({ id: g.id, name: g.name, color: g.color || '' }))
    ]
    // 补齐到 5 个槽位（1 默认 + 4 用户）
    while (editGroups.length < 5) {
      editGroups.push({ id: '', name: '', color: '' })
    }
    setBatchGroups(editGroups.slice(0, 5))
    setDraggedIndex(null)
    setDragOverIndex(null)
    setGroupDialogOffset({ x: 0, y: 0 })
    setShowBatchGroupDialog(true)
  }

  // 批量保存分组：固定 1+4 槽位，空名称视为无效分组
  const handleSaveBatchGroups = async () => {
    // 持久化默认分组颜色（名称固定，存到偏好设置）
    const newDefaultColor = batchGroups[0].color || ''
    setDefaultGroupColor(newDefaultColor)
    await window.electronAPI?.setConfig?.('quickCommand.defaultGroupColor', newDefaultColor)

    const userGroups = batchGroups.slice(1)

    // 更新/创建/删除用户分组
    for (let i = 0; i < userGroups.length; i++) {
      const group = userGroups[i]
      const name = group.name.trim()

      if (group.id) {
        if (name) {
          // 更新有效分组
          await window.electronAPI?.commandGroupUpdate({
            id: group.id,
            name,
            color: group.color || undefined,
            order: i + 1
          })
        } else {
          // 名称清空 -> 视为无效，删除该分组；若分组下还有命令，先确认
          const groupCommandCount = commands.filter(c => c.groupId === group.id).length
          if (groupCommandCount > 0) {
            const confirmed = confirm(
              t('statusbar.deleteGroupConfirm', { count: groupCommandCount })
            )
            if (!confirmed) continue
          }
          await window.electronAPI?.commandGroupDelete(group.id)
        }
      } else if (name) {
        // 创建新分组
        const newId = `group-${Date.now()}-${i}`
        await window.electronAPI?.commandGroupAdd({
          id: newId,
          name,
          color: group.color || undefined,
          order: i + 1
        })
      }
      // 空槽位（无 id 且无名称）直接跳过
    }

    await loadGroups()
    setShowBatchGroupDialog(false)
  }

  // 分组拖拽排序
  const handleGroupDragStart = (index: number) => {
    if (index === 0) return
    setDraggedIndex(index)
  }

  const handleGroupDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault()
    if (draggedIndex === null || draggedIndex === index || index === 0) return
    setDragOverIndex(index)
  }

  const handleGroupDrop = (targetIndex: number) => {
    if (draggedIndex === null || draggedIndex === targetIndex || targetIndex === 0) return
    const newGroups = [...batchGroups]
    const [removed] = newGroups.splice(draggedIndex, 1)
    newGroups.splice(targetIndex, 0, removed)
    setBatchGroups(newGroups)
    setDraggedIndex(null)
    setDragOverIndex(null)
  }

  const handleGroupDragEnd = () => {
    setDraggedIndex(null)
    setDragOverIndex(null)
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
  const predefinedColors = ['#0078D4', '#E81123', '#107C10', '#FFB900', '#FF69B4']

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
          activeDropdown === 'groups' && 'bg-[var(--bg-slot)]',
          showBatchGroupDialog && 'ring-1 ring-inset ring-[var(--amber)]'
        )}
        title={t('statusbar.groupSwitchHint')}
      >
        <span
          className="w-1.5 h-1.5 rounded-full flex-shrink-0 shadow-[inset_0_0_0_1px_rgba(0,0,0,.5)]"
          style={{
            backgroundColor: currentGroupColor || 'var(--text-rack-dim)'
          }}
        />
        <span className="text-[11px] text-[var(--text-rack)] font-medium">{currentGroup ? currentGroup.name : 'Default'}</span>
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
            // 阻止鼠标点击时抢走焦点,点完后光标仍留在终端,避免按回车再次触发该命令
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => handleExecute(cmd)}
            onContextMenu={(e) => handleCommandContextMenu(cmd, e)}
            className={cn(
              'group/key relative flex-shrink-0 h-[22px] rounded-[3px]',
              'pl-2 pr-2.5 flex items-center',
              'bg-[var(--bg-slot)] hover:bg-[var(--bg-elev)] active:bg-[var(--rule)]',
              'text-[var(--text-rack)] cursor-pointer transition-colors',
              editingCommandId === cmd.id && 'ring-1 ring-inset ring-[var(--amber)]'
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
            <span className="text-[10.5px] leading-none">{t('statusbar.addCommand')}</span>
            <span
              className="text-[9.5px] leading-none text-[var(--text-rack-faint)] ml-1"
              style={{ fontFamily: 'ui-monospace, "JetBrains Mono", monospace' }}
            >
              {t('statusbar.doubleClick')}
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
                  className="w-2 h-2 rounded-full flex-shrink-0 shadow-[inset_0_0_0_1px_rgba(0,0,0,.5)]"
                  style={{
                    backgroundColor: group.color || 'var(--text-rack-dim)'
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
            <span className="flex-1">Edit groups…</span>
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
              title={t('statusbar.connected')}
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
              title={t('statusbar.noSession')}
            />
            <span className="lowercase">{t('statusbar.noSession')}</span>
          </>
        )}
        <span aria-hidden className="w-px h-[10px] bg-[var(--rule)] flex-shrink-0" />
        <span className="lowercase">v1.0.2</span>
      </div>

      {/* Quick-command editor */}
      {showAddDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-[var(--bg-rack)] border border-[var(--rule)] rounded-[4px] shadow-2xl w-[400px] overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 bg-[var(--bg-slot)] border-b border-[var(--rule)]">
              <div className="flex items-center gap-2">
                <span
                  className="w-2 h-2 rounded-full ring-2 ring-[var(--bg-slot)]"
                  style={{ backgroundColor: currentGroupColor || 'var(--text-rack-dim)' }}
                />
                <span className="text-[12px] font-semibold text-[var(--text-rack)]">
                  {editCommand ? t('statusbar.editCommandTitle') : t('statusbar.newCommandTitle')}
                </span>
              </div>
              <button
                onClick={() => {
                  setShowAddDialog(false)
                  setEditingCommandId(null)
                  resetDialogState()
                }}
                className="text-[var(--text-rack-dim)] hover:text-[var(--text-rack)] text-lg leading-none px-1"
                aria-label={t('common.close')}
              >
                ×
              </button>
            </div>

            <div className="px-4 py-4 space-y-4">
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="block text-[12px] tracking-[.04em] text-[var(--text-rack-data)] mb-1.5">{t('statusbar.fieldName')}</label>
                  <input
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder={t('statusbar.namePlaceholder')}
                    autoFocus
                    className="w-full px-2.5 py-1.5 bg-[var(--bg-base)] border border-[var(--rule)] rounded-[3px] text-sm text-[var(--text-rack)] placeholder-[var(--text-rack-faint)] focus:outline-none focus:border-[var(--amber)]"
                  />
                </div>
                <div className="w-[130px]">
                  <label className="block text-[12px] tracking-[.04em] text-[var(--text-rack-data)] mb-1.5">{t('statusbar.fieldGroup')}</label>
                  <select
                    value={newGroupId}
                    onChange={(e) => setNewGroupId(e.target.value)}
                    className="w-full px-2 py-1.5 bg-[var(--bg-base)] border border-[var(--rule)] rounded-[3px] text-sm text-[var(--text-rack)] focus:outline-none focus:border-[var(--amber)]"
                  >
                    <option value="">{t('statusbar.defaultGroup')}</option>
                    {groups.map(g => (
                      <option key={g.id} value={g.id}>{g.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-[12px] tracking-[.04em] text-[var(--text-rack-data)] mb-1.5">{t('statusbar.fieldCommand')}</label>
                <textarea
                  value={newContent}
                  onChange={(e) => setNewContent(e.target.value)}
                  placeholder={t('statusbar.commandPlaceholder')}
                  rows={4}
                  className="w-full px-2.5 py-2 bg-[var(--bg-base)] border border-[var(--rule)] rounded-[3px] text-sm font-mono text-[var(--text-rack)] placeholder-[var(--text-rack-faint)] focus:outline-none focus:border-[var(--amber)] resize-none"
                />
              </div>

              <label
                className="flex items-center gap-2.5 cursor-pointer select-none group/esc"
                title={t('statusbar.parseEscapeTitle')}
              >
                <span className="relative flex-shrink-0">
                  <input
                    type="checkbox"
                    checked={newEscape}
                    onChange={(e) => setNewEscape(e.target.checked)}
                    className="sr-only peer"
                  />
                  <span
                    className={cn(
                      'block w-4 h-4 rounded-[4px] border transition-colors',
                      newEscape
                        ? 'bg-[var(--amber)] border-[var(--amber)]'
                        : 'bg-[var(--bg-base)] border-[var(--rule)] group-hover/esc:border-[var(--text-rack-dim)]'
                    )}
                  />
                  <svg
                    viewBox="0 0 14 14"
                    className={cn(
                      'absolute inset-0 w-4 h-4 m-auto pointer-events-none transition-opacity',
                      newEscape ? 'opacity-100' : 'opacity-0'
                    )}
                    style={{ color: 'var(--bg-base)' }}
                  >
                    <path d="M3 7.5 L5.5 10 L11 4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <span className="text-xs text-[var(--text-rack)]">{t('statusbar.parseEscape')}</span>
              </label>
            </div>

            <div className="flex items-center justify-between gap-2 px-4 py-3 bg-[var(--bg-slot)] border-t border-[var(--rule)]">
              {editCommand ? (
                <button
                  onClick={handleDeleteCommand}
                  className="px-3 py-1.5 text-xs font-medium text-[var(--error-rack)] hover:bg-[var(--error-rack)]/10 rounded-[3px] transition-colors"
                >
                  {t('statusbar.delete')}
                </button>
              ) : (
                <span />
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setShowAddDialog(false)
                    setEditingCommandId(null)
                    resetDialogState()
                  }}
                  className="px-3 py-1.5 text-xs font-medium text-[var(--text-rack-mute)] hover:text-[var(--text-rack)] hover:bg-[var(--bg-elev)] rounded-[3px] transition-colors"
                >
                  {t('statusbar.cancel')}
                </button>
                <button
                  onClick={handleSaveCommand}
                  className="px-4 py-1.5 text-xs font-semibold bg-[var(--amber)] text-[var(--bg-base)] rounded-[3px] hover:brightness-110 transition-[filter]"
                >
                  {t('statusbar.save')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Group editor */}
      {showBatchGroupDialog && (
        <div className="fixed inset-0 z-50 pointer-events-none">
          <div
            className="pointer-events-auto absolute top-1/2 left-1/2 bg-[var(--bg-slot)] border border-[var(--rule)] rounded-[4px] w-[320px] overflow-hidden"
            style={{
              transform: `translate(-50%, -50%) translate(${groupDialogOffset.x}px, ${groupDialogOffset.y}px)`,
              boxShadow: '0 24px 60px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.03)'
            }}
          >
            <div
              className="flex items-center justify-between px-4 py-3 bg-[var(--bg-base)] border-b border-[var(--rule)] cursor-move select-none"
              onMouseDown={handleGroupDialogMouseDown}
            >
              <div className="flex items-center gap-2">
                <span className="text-base font-semibold text-[var(--text-rack)] tracking-wide">{t('statusbar.editGroups')}</span>
                <span
                  className="text-xs font-mono text-[var(--text-rack-data)] px-1.5 py-0.5 bg-[var(--bg-elev)] rounded-[2px]"
                  style={{ fontFeatureSettings: '"tnum" 1' }}
                >
                  {batchGroups.length - 1}/4
                </span>
              </div>
              <button
                onClick={() => {
                  setShowBatchGroupDialog(false)
                  setGroupDialogOffset({ x: 0, y: 0 })
                }}
                onMouseDown={(e) => e.stopPropagation()}
                className="w-7 h-7 flex items-center justify-center text-[var(--text-rack-dim)] hover:text-[var(--text-rack)] text-lg leading-none pointer-events-auto rounded-[3px] hover:bg-[var(--bg-elev)] transition-colors"
                aria-label={t('common.close')}
              >
                ×
              </button>
            </div>

            <div className="px-4 py-4 space-y-2">
              {batchGroups.map((bg, index) => {
                const isDefault = index === 0
                const isDragged = draggedIndex === index
                const isDragOver = dragOverIndex === index && draggedIndex !== index
                return (
                  <div
                    key={index}
                    draggable={!isDefault}
                    onDragStart={() => handleGroupDragStart(index)}
                    onDragOver={(e) => handleGroupDragOver(e, index)}
                    onDrop={() => handleGroupDrop(index)}
                    onDragEnd={handleGroupDragEnd}
                    className={cn(
                      'group flex items-center gap-2 p-2 rounded-[4px] bg-[var(--bg-base)] border transition-all',
                      isDragOver ? 'border-[var(--amber)] ring-1 ring-[var(--amber)]/30' : 'border-[var(--rule)]',
                      isDragged && 'opacity-40',
                      !isDefault && 'hover:border-[var(--text-rack-dim)]'
                    )}
                  >
                    {/* Drag handle / default lock */}
                    {!isDefault ? (
                      <div
                        className="w-5 h-5 flex-shrink-0 flex items-center justify-center rounded-[3px] bg-[var(--bg-elev)] border border-[var(--rule)] text-[10px] font-mono text-[var(--text-rack)] cursor-move"
                        title={t('statusbar.dragToReorder')}
                      >
                        {index}
                      </div>
                    ) : (
                      <div
                        className="w-5 h-5 flex-shrink-0 flex items-center justify-center text-[var(--text-rack-data)]"
                        title={t('statusbar.defaultGroupLabel')}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="5" y="11" width="14" height="10" rx="2" ry="2" />
                          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                        </svg>
                      </div>
                    )}

                    {/* Nameplate input */}
                    <input
                      type="text"
                      value={bg.name}
                      onChange={(e) => {
                        if (isDefault) return
                        const newGroups = [...batchGroups]
                        newGroups[index].name = limitVisualWidth(e.target.value, 6)
                        setBatchGroups(newGroups)
                      }}
                      placeholder={isDefault ? t('statusbar.defaultGroup') : t('statusbar.groupNamePlaceholder')}
                      disabled={isDefault}
                      className={cn(
                        'flex-1 min-w-0 h-7 px-2.5 bg-[var(--bg-rack)] border border-[var(--rule)] rounded-[3px] text-sm text-[var(--text-rack)] placeholder-[var(--text-rack-faint)]',
                        isDefault ? 'cursor-not-allowed opacity-80' : 'focus:outline-none focus:border-[var(--amber)]'
                      )}
                    />

                    {/* Color swatches */}
                    <div className="flex items-center gap-[2px] h-7">
                      {predefinedColors.map(color => {
                        const selected = bg.color === color
                        return (
                          <button
                            key={color}
                            type="button"
                            onClick={() => {
                              const newGroups = [...batchGroups]
                              newGroups[index].color = color
                              setBatchGroups(newGroups)
                            }}
                            className={cn(
                              'w-[18px] h-[18px] rounded-[3px] flex-shrink-0 box-border block overflow-hidden',
                              'border appearance-none p-[1px] m-0',
                              selected
                                ? 'border-white/90'
                                : 'border-black/60 hover:border-black/80'
                            )}
                            aria-label={t('statusbar.setGroupColor', { color })}
                          >
                            <span
                              className="block w-full h-full rounded-[2px]"
                              style={{ backgroundColor: color }}
                            />
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="px-4 pb-2 text-[10px] text-[var(--text-rack-dim)] leading-relaxed">
              {t('statusbar.clearGroupHint')}
            </div>

            <div className="flex items-center justify-end gap-2 px-4 py-3 bg-[var(--bg-base)] border-t border-[var(--rule)]">
              <button
                onClick={() => {
                  setShowBatchGroupDialog(false)
                  setGroupDialogOffset({ x: 0, y: 0 })
                }}
                className="px-3 py-1.5 text-xs font-medium text-[var(--text-rack-data)] hover:text-[var(--text-rack)] hover:bg-[var(--bg-elev)] rounded-[3px] transition-colors"
              >
                {t('statusbar.cancel')}
              </button>
              <button
                onClick={handleSaveBatchGroups}
                className="px-4 py-1.5 text-xs font-semibold bg-[var(--amber)] text-[var(--bg-base)] rounded-[3px] hover:brightness-110 transition-[filter]"
              >
                {t('statusbar.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default StatusBar