import React, { useEffect, useState, useRef } from 'react'
import cn from 'classnames'
import type { SessionConfig } from '@shared/types'
import { useSessionStore } from '../../stores/session-store'
import SessionDialog from '../SessionDialog/SessionDialog'

interface FloatWindowProps {
  onConnect?: (sessionId: string, config: SessionConfig) => void
}

/**
 * 简化版浮窗 - 用于快速开启终端
 * 显示最近访问的会话，支持置顶和拖拽排序
 */
const FloatWindow: React.FC<FloatWindowProps> = ({ onConnect }) => {
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
  // 总上限 16 条:pinned 全保留(用户主动置顶),剩余配额给最近的 unpinned
  // pinned 超过 16 时仍全显 —— 用户置顶的不该被静默截断,宁可让 unpinned 段为空
  // 16 这个数:浮窗 h-[400px] - 头/底 padding ≈ 13 行可见,16 留 3 行滚动余量,既不空也不需翻页(用户选定)
  const TOTAL_LIMIT = 16
  const pinnedSessions = savedSessions
    .filter(s => s.tags?.includes('pinned'))
    .sort(sortByPinOrder)

  const unpinnedQuota = Math.max(0, TOTAL_LIMIT - pinnedSessions.length)
  const unpinnedSessions = savedSessions
    .filter(s => !s.tags?.includes('pinned'))
    .sort(sortByTime)
    .slice(0, unpinnedQuota)

  // 合并：置顶在前，非置顶在后
  const sortedSessions = [...pinnedSessions, ...unpinnedSessions]

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

      const draggedSession = sortedSessions[draggedIndex]
      const targetSession = sortedSessions[targetIndex]

      // 两个都必须是置顶会话才能拖拽排序
      if (!draggedSession?.tags?.includes('pinned') || !targetSession?.tags?.includes('pinned')) {
        setDraggedIndex(null)
        setDragOverIndex(null)
        return
      }

      // 在置顶组内找到位置
      const pinnedList = sortedSessions.filter(s => s.tags?.includes('pinned'))
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
      case 'local': return 'LOC'
      default: return ''
    }
  }

  // 协议色 stripe + 文字色(与 sidebar 一致)
  const PROTO_STRIPE: Record<string, string> = {
    ssh: 'bg-[var(--proto-ssh)]',
    telnet: 'bg-[var(--proto-tel)]',
    serial: 'bg-[var(--proto-ser)]',
    local: 'bg-[var(--proto-loc)]',
  }
  const PROTO_TEXT: Record<string, string> = {
    ssh: 'text-[var(--proto-ssh)]',
    telnet: 'text-[var(--proto-tel)]',
    serial: 'text-[var(--proto-ser)]',
    local: 'text-[var(--proto-loc)]',
  }

  return (
    <div className="relative flex flex-col h-screen bg-[var(--bg-rack)] text-[var(--text-rack)] select-none">
      {/* 顶边 amber 高亮 — 标识"被召唤压在终端上的焦点面板",跟下层终端拉开层级 */}
      <div aria-hidden className="absolute top-0 left-0 right-0 h-[1px] bg-[var(--amber)] opacity-80 z-10" />

      {/* 会话列表 */}
      <div className="flex-1 overflow-y-auto rack-scroll py-1">
        {sortedSessions.length === 0 ? (
          <div className="text-center py-6 text-[var(--text-rack-mute)] text-xs">
            <p className="font-mono uppercase tracking-[.1em]">No sessions</p>
            <p className="mt-1 text-[var(--text-rack-faint)]">点击下方按钮创建</p>
          </div>
        ) : (
          sortedSessions.map((config, index) => {
            const isPinned = config.tags?.includes('pinned')
            const isDragging = draggedIndex === index
            const isDragOver = dragOverIndex === index
            const protoStripe = PROTO_STRIPE[config.type] || 'bg-[var(--text-rack-faint)]'
            const protoText = PROTO_TEXT[config.type] || 'text-[var(--text-rack-faint)]'

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
                  'relative grid grid-cols-[3px_28px_auto_minmax(0,1fr)_auto] items-center gap-2 pr-2 h-[26px] cursor-pointer transition-colors group',
                  'hover:bg-[var(--bg-slot)]',
                  isDragging && 'opacity-40 bg-[var(--amber-soft)]',
                  isDragOver && !isDragging && 'border-t border-[var(--amber)]',
                  isPinned && 'bg-[var(--bg-slot)]/60'
                )}
              >
                {/* 协议色条 */}
                <span aria-hidden className={cn('h-full', protoStripe, isPinned ? 'opacity-100' : 'opacity-60 group-hover:opacity-100')} />
                {/* 协议文字 */}
                <span className={cn('font-mono text-[10px] font-bold uppercase tracking-[.12em] tabular-nums text-center', protoText)}>
                  {getTypeLabel(config.type)}
                </span>
                {/* 置顶图标 */}
                <span className={cn('w-[10px] flex justify-center text-[10px]', isPinned ? 'text-[var(--amber)]' : 'text-transparent')} title={isPinned ? '已置顶' : undefined}>
                  ◆
                </span>
                {/* 名称 + host */}
                <span className="flex items-baseline gap-2 min-w-0">
                  <span className="truncate text-sm text-[var(--text-rack)]">{config.name}</span>
                  <span className="truncate text-[10px] font-mono text-[var(--text-rack-data)]">
                    {config.ssh?.host || config.telnet?.host || config.serial?.path || ''}
                  </span>
                </span>
                {/* pin 按钮 */}
                <button
                  onClick={(e) => handleTogglePin(config, e)}
                  title={isPinned ? '取消置顶' : '置顶'}
                  className={cn(
                    'w-[16px] h-[16px] flex items-center justify-center text-[10px] transition-all rounded-[2px]',
                    isPinned
                      ? 'text-[var(--amber)] opacity-100 hover:bg-[var(--amber-soft)]'
                      : 'text-[var(--text-rack-faint)] opacity-0 group-hover:opacity-100 hover:text-[var(--amber)] hover:bg-[var(--bg-elev)]'
                  )}
                >
                  ◆
                </button>
              </div>
            )
          })
        )}
      </div>

      {/* 底部按钮 — rack 风:elev 底 + amber 文字 + 边框 hover 亮 */}
      <div className="p-2 border-t border-[var(--rule)] bg-[var(--bg-strip)]">
        <button
          onClick={handleNewSession}
          className="w-full flex items-center justify-center gap-2 h-[28px] text-xs font-mono uppercase tracking-[.12em] bg-[var(--bg-elev)] border border-[var(--rule)] text-[var(--amber)] hover:border-[var(--amber)] hover:bg-[var(--amber-soft)] transition-colors rounded-[2px]"
        >
          <span className="text-base leading-none">+</span>
          <span>New Session</span>
        </button>
      </div>

      {/* 会话对话框 */}
      <SessionDialog
        open={showDialog}
        onClose={() => setShowDialog(false)}
        onSubmit={async (config) => {
          const saved = await window.electronAPI?.createSession(config)
          if (saved) {
            // 触发连接；dialog 内部监听 onConnectionStatus 自动决定关闭/留在 FAULT
            handleConnect(saved)
          }
          refreshSavedSessions()
          return saved?.id
        }}
      />
    </div>
  )
}

export default FloatWindow