import React, { useState } from 'react'
import cn from 'classnames'
import type { QuickCommand, CommandGroupDisplay } from '@shared/types'
import { DEFAULT_COMMAND_GROUPS } from '@shared/constants'

interface CommandsTabProps {
  searchQuery: string
}

/**
 * 命令页签组件
 */
const CommandsTab: React.FC<CommandsTabProps> = ({ searchQuery }) => {
  const [expandedGroups, setExpandedGroups] = useState<string[]>(['system', 'network'])

  // 模拟数据（使用预置命令）
  const groups: CommandGroupDisplay[] = DEFAULT_COMMAND_GROUPS.map((g, i) => ({
    id: g.id,
    name: g.name,
    icon: g.icon,
    commands: g.commands.map((c, j) => ({
      id: `${g.id}-${j}`,
      name: c.name,
      content: c.content,
      group: g.id,
      createdAt: new Date(),
      isFavorite: false
    })),
    isCollapsed: !expandedGroups.includes(g.id),
    order: i
  }))

  // 展开/折叠
  const toggleGroup = (groupId: string) => {
    setExpandedGroups(prev =>
      prev.includes(groupId)
        ? prev.filter(id => id !== groupId)
        : [...prev, groupId]
    )
  }

  // 过滤
  const filterCommands = (commands: QuickCommand[]) => {
    if (!searchQuery) return commands
    return commands.filter(c =>
      c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.content.toLowerCase().includes(searchQuery.toLowerCase())
    )
  }

  // 执行命令
  const handleExecute = (command: QuickCommand) => {
    console.log('Execute:', command.content)
    // TODO: 执行命令
  }

  // 复制命令
  const handleCopy = (command: QuickCommand) => {
    navigator.clipboard.writeText(command.content)
  }

  return (
    <div className="space-y-2">
      {groups.map((group) => (
        <div key={group.id}>
          {/* 分组标题 */}
          <button
            onClick={() => toggleGroup(group.id)}
            className="flex items-center gap-2 w-full px-2 py-1 text-xs text-gray-400 hover:text-white transition-colors"
          >
            <span className={cn(
              'transition-transform',
              group.isCollapsed ? '-rotate-90' : ''
            )}>
              ▼
            </span>
            <span>{group.icon}</span>
            <span>{group.name} ({group.commands.length})</span>
          </button>

          {/* 命令列表 */}
          {!group.isCollapsed && (
            <div className="space-y-1 mt-1">
              {filterCommands(group.commands).map((command) => (
                <CommandItem
                  key={command.id}
                  command={command}
                  onExecute={() => handleExecute(command)}
                  onCopy={() => handleCopy(command)}
                />
              ))}
            </div>
          )}
        </div>
      ))}

      {/* 底部按钮 */}
      <div className="flex gap-2 px-2 mt-4">
        <button className="px-3 py-1.5 text-sm text-[#0078D4] hover:bg-[#3C3C3C] rounded transition-colors">
          + 新建分组
        </button>
        <button className="px-3 py-1.5 text-sm text-[#0078D4] hover:bg-[#3C3C3C] rounded transition-colors">
          + 添加命令
        </button>
      </div>
    </div>
  )
}

/**
 * 命令项组件
 */
const CommandItem: React.FC<{
  command: QuickCommand
  onExecute: () => void
  onCopy: () => void
}> = ({ command, onExecute, onCopy }) => {
  return (
    <div
      className={cn(
        'px-3 py-2 rounded cursor-pointer transition-all',
        'hover:bg-[#3C3C3C] hover:translate-x-1'
      )}
      onDoubleClick={onExecute}
    >
      <div className="flex items-start gap-2">
        {/* 图标 */}
        <span className="text-sm">📋</span>

        {/* 内容 */}
        <div className="flex-1 min-w-0">
          <div className="text-sm text-white truncate">{command.name}</div>
          <div className="text-xs text-gray-500 truncate font-mono">{command.content}</div>
        </div>

        {/* 操作按钮 */}
        <div className="flex gap-1 opacity-0 hover:opacity-100 transition-opacity">
          <button
            onClick={onCopy}
            className="text-xs text-gray-400 hover:text-white"
            title="复制"
          >
            📋
          </button>
        </div>
      </div>
    </div>
  )
}

export default CommandsTab