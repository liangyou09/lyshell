import React, { useEffect, useState, useRef } from 'react'
import cn from 'classnames'
import type { SessionConfig } from '@shared/types'
import { useSessionStore } from '../../stores/session-store'
import SessionDialog from '../SessionDialog/SessionDialog'

interface FloatWindowProps {
  onConnect?: (sessionId: string, config: SessionConfig) => void
  onCollapse?: () => void
}

/**
 * 简化版浮窗 - 用于快速开启终端
 * 显示最近访问的会话，支持置顶和拖拽排序
 */
const FloatWindow: React.FC<FloatWindowProps> = ({ onConnect, onCollapse }) => {
  const [searchQuery, setSearchQuery] = useState('')
  const [showDialog, setShowDialog] = useState(false)
  const { savedSessions, refreshSavedSessions } = useSessionStore()
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const isUpdating = useRef(false) // 防止重复更新

  // 加载最近会话列表
  useEffect(() => {
    refreshSavedSessions()
  }, [refreshSavedSessions])

  // 置顶会话按 pinOrder 排序（数字越小在前），没有 pinOrder 的按时间排序
  const sortByPinOrder = (a: SessionConfig, b: SessionConfig) => {
    if (a.pinOrder !== undefined && b.pinOrder !== undefined) {
      return a.pinOrder - b.pinOrder
    }
    if (a.pinOrder !== undefined) return -1
    if (b.pinOrder !== undefined) return 1
    // 都没有 pinOrder，按时间排序
    const getTime = (d: Date | string | undefined) => {
      if (!d) return 0
      return new Date(d).getTime()
    }
    return getTime(b.updatedAt) - getTime(a.updatedAt)
  }

  // 按 updatedAt 降序排序（最近的在前）
  const sortByTime = (a: SessionConfig, b: SessionConfig) => {
    const getTime = (d: Date | string | undefined) => {
      if (!d) return 0
      return new Date(d).getTime()
    }
    return getTime(b.updatedAt) - getTime(a.updatedAt)
  }

  // 分离置顶和非置顶会话，各自排序
  const pinnedSessions = savedSessions
    .filter(s => s.tags?.includes('pinned'))
    .sort(sortByPinOrder)

  const unpinnedSessions = savedSessions
    .filter(s => !s.tags?.includes('pinned'))
    .sort(sortByTime)
    .slice(0, 10)

  // 合并：置顶在前，非置顶在后
  const sortedSessions = [...pinnedSessions, ...unpinnedSessions]

  // 过滤会话
  const filteredSessions = sortedSessions.filter(s =>
    !searchQuery ||
    s.name.toLowerCase().includes(searchQuery.toLowerCase())
  )

  // 点击会话开启终端
  const handleConnect = (config: SessionConfig) => {
    // MainWindow 的 handleConnect 会更新访问时间并刷新列表
    onConnect?.(config.id, config)
  }

  // 打开新建对话框
  const handleNewSession = () => {
    setShowDialog(true)
  }

  // 置顶/取消置顶会话
  const handleTogglePin = async (config: SessionConfig, e: React.MouseEvent) => {
    e.stopPropagation()
    const isPinned = config.tags?.includes('pinned')
    const newTags = isPinned
      ? config.tags.filter(t => t !== 'pinned')
      : [...(config.tags || []), 'pinned']

    // 计算新的 pinOrder
    let newPinOrder: number | undefined
    if (!isPinned) {
      // 新置顶的会话，放到当前置顶会话的最后面
      const currentPinned = savedSessions.filter(s => s.tags?.includes('pinned'))
      const maxOrder = currentPinned.reduce((max, s) => {
        return s.pinOrder !== undefined ? Math.max(max, s.pinOrder) : max
      }, -1)
      newPinOrder = maxOrder + 1
    } else {
      // 取消置顶时清除 pinOrder
      newPinOrder = undefined
    }

    await window.electronAPI?.updateSession({
      ...config,
      tags: newTags,
      pinOrder: newPinOrder,
      updatedAt: new Date()
    })
    await refreshSavedSessions()
  }

  // 拖拽开始
  const handleDragStart = (e: React.DragEvent, index: number) => {
    setDraggedIndex(index)
    e.dataTransfer.effectAllowed = 'move'
  }

  // 拖拽进入
  const handleDragEnter = (e: React.DragEvent, index: number) => {
    e.preventDefault()
    setDragOverIndex(index)
  }

  // 拖拽放下 - 只允许置顶会话拖拽排序
  const handleDrop = async (e: React.DragEvent, targetIndex: number) => {
    e.preventDefault()

    // 防止重复触发
    if (isUpdating.current) return
    isUpdating.current = true

    try {
      if (draggedIndex === null || draggedIndex === targetIndex) {
        setDraggedIndex(null)
        setDragOverIndex(null)
        return
      }

      const draggedSession = filteredSessions[draggedIndex]
      const targetSession = filteredSessions[targetIndex]

      // 两个都必须是置顶会话才能拖拽排序
      if (!draggedSession?.tags?.includes('pinned') || !targetSession?.tags?.includes('pinned')) {
        setDraggedIndex(null)
        setDragOverIndex(null)
        return
      }

      // 在置顶组内找到位置
      const pinnedList = filteredSessions.filter(s => s.tags?.includes('pinned'))
      const draggedPos = pinnedList.findIndex(s => s.id === draggedSession.id)
      const targetPos = pinnedList.findIndex(s => s.id === targetSession.id)

      if (draggedPos === -1 || targetPos === -1) {
        setDraggedIndex(null)
        setDragOverIndex(null)
        return
      }

      // 重新排列置顶会话
      const reordered = [...pinnedList]
      reordered.splice(draggedPos, 1)
      reordered.splice(targetPos, 0, draggedSession)

      // 更新 pinOrder 实现排序（数字越小排在前面）
      for (let i = 0; i < reordered.length; i++) {
        const config = reordered[i]
        if (!config?.id) continue // 跳过无效数据
        await window.electronAPI?.updateSession({
          ...config,
          pinOrder: i
        })
      }

      await refreshSavedSessions()
      setDraggedIndex(null)
      setDragOverIndex(null)
    } finally {
      // 延迟解锁，防止快速重复操作
      setTimeout(() => {
        isUpdating.current = false
      }, 300)
    }
  }

  // 获取类型标签
  const getTypeLabel = (type: string) => {
    switch (type) {
      case 'ssh': return 'SSH'
      case 'telnet': return 'TEL'
      case 'serial': return 'SER'
      default: return ''
    }
  }

  return (
    <div className="flex flex-col h-screen bg-[#2D2D30] text-white select-none">
      {/* 搜索栏 */}
      <div className="pr-2 border-b border-[#3C3C3C] flex items-center h-[28px]">
        {/* 缩小按钮 */}
        <div
          onClick={onCollapse}
          className="w-[8px] h-full bg-gray-500/20 flex items-center justify-center hover:bg-gray-500/50 transition-colors cursor-pointer group flex-shrink-0"
          title="缩小浮窗"
        >
          <span className="text-gray-400/50 text-xs group-hover:text-white transition-colors">◀</span>
        </div>
        {/* 搜索输入 */}
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="搜索会话..."
          className="flex-1 h-full pl-2 bg-[#3C3C3C] border border-[#555] text-sm placeholder-gray-500 focus:outline-none focus:border-[#0078D4]"
        />
      </div>

      {/* 会话列表 */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {filteredSessions.length === 0 ? (
          <div className="text-center py-4 text-gray-500 text-sm">
            <p>暂无会话</p>
            <p className="mt-1">点击下方按钮创建</p>
          </div>
        ) : (
          filteredSessions.map((config, index) => {
            const isPinned = config.tags?.includes('pinned')
            const isDragging = draggedIndex === index
            const isDragOver = dragOverIndex === index

            return (
              <div
                key={config.id}
                draggable={isPinned}
                onDragStart={isPinned ? (e) => handleDragStart(e, index) : undefined}
                onDragEnter={isPinned ? (e) => handleDragEnter(e, index) : undefined}
                onDrop={isPinned ? (e) => handleDrop(e, index) : undefined}
                onDragOver={isPinned ? (e) => e.preventDefault() : undefined}
                onClick={() => handleConnect(config)}
                className={cn(
                  'px-3 py-2 rounded cursor-pointer transition-all',
                  'hover:bg-[#3C3C3C] group',
                  isDragging && 'opacity-50 bg-[#0078D4]',
                  isDragOver && !isDragging && 'border-t-2 border-[#0078D4]',
                  isPinned && 'bg-[#3C3C3C]/50'
                )}
              >
                <div className="flex items-center gap-2">
                  {isPinned && (
                    <span className="text-xs text-[#0078D4]" title="已置顶">📌</span>
                  )}
                  <span className="text-xs text-gray-400">{getTypeLabel(config.type)}</span>
                  <span className="flex-1 truncate">{config.name}</span>
                  <span className="text-xs text-gray-500">
                    {config.ssh?.host || config.telnet?.host || config.serial?.path}
                  </span>
                  <button
                    onClick={(e) => handleTogglePin(config, e)}
                    title={isPinned ? '取消置顶' : '置顶'}
                    className={cn(
                      'w-[18px] h-[18px] flex items-center justify-center rounded transition-colors',
                      'opacity-0 group-hover:opacity-100',
                      isPinned
                        ? 'text-[#0078D4] hover:bg-[#0078D4]/20'
                        : 'text-gray-400 hover:text-[#0078D4] hover:bg-[#555]'
                    )}
                  >
                    📌
                  </button>
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* 底部按钮 */}
      <div className="p-2 border-t border-[#3C3C3C] flex gap-2">
        <button
          onClick={handleNewSession}
          className="flex-1 flex items-center justify-center gap-2 py-1.5 text-sm bg-[#0078D4] text-white rounded hover:bg-[#006CBD] transition-colors"
        >
          <span>+</span>
          <span>新建会话</span>
        </button>
      </div>

      {/* 会话对话框 */}
      <SessionDialog
        open={showDialog}
        onClose={() => setShowDialog(false)}
        onSubmit={async (config) => {
          const saved = await window.electronAPI?.createSession(config)
          if (saved) {
            handleConnect(saved)
          }
          refreshSavedSessions()
        }}
      />
    </div>
  )
}

export default FloatWindow