import React, { useEffect, useRef, useState } from 'react'
import { usePaneStore } from '../../stores/pane-store'
import PaneView from './PaneView'
import cn from 'classnames'

type DropZone = 'left' | 'right' | 'top' | 'bottom' | null

// 全局拖拽状态
let globalDraggingSessionId: string | null = null
export const setDraggingSessionId = (id: string | null) => {
  globalDraggingSessionId = id
}
export const getDraggingSessionId = () => globalDraggingSessionId

/**
 * 分屏容器组件 - 支持拖拽标签分屏
 */
const SplitPaneContainer: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null)
  const [activeDropZone, setActiveDropZone] = useState<DropZone>(null)
  const [isDragging, setIsDragging] = useState(false)
  const { layout, splitPane, setActivePane, getAllLeafPanes, addSessionToPane } = usePaneStore()

  // 使用 ref 存储最新的状态和函数，避免 useEffect 重新运行
  const stateRef = useRef({
    activeDropZone,
    layout,
    splitPane,
    addSessionToPane,
    getAllLeafPanes
  })

  // 每次渲染时更新 ref
  useEffect(() => {
    stateRef.current = {
      activeDropZone,
      layout,
      splitPane,
      addSessionToPane,
      getAllLeafPanes
    }
  })

  // 分屏快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey) {
        if (e.key === 'H' || e.key === 'h') {
          e.preventDefault()
          if (layout.activePaneId) {
            splitPane(layout.activePaneId, 'horizontal')
          }
        } else if (e.key === 'V' || e.key === 'v') {
          e.preventDefault()
          if (layout.activePaneId) {
            splitPane(layout.activePaneId, 'vertical')
          }
        }
      }

      // Ctrl+方向键切换分屏
      if (e.ctrlKey && !e.shiftKey) {
        const leaves = getAllLeafPanes()
        const currentIndex = leaves.findIndex(p => p.id === layout.activePaneId)

        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault()
          const nextIndex = (currentIndex + 1) % leaves.length
          setActivePane(leaves[nextIndex].id)
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault()
          const prevIndex = (currentIndex - 1 + leaves.length) % leaves.length
          setActivePane(leaves[prevIndex].id)
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [layout.activePaneId, splitPane, setActivePane, getAllLeafPanes])

  // 初始化：如果没有活动分屏，设置第一个叶子为活动
  useEffect(() => {
    const leaves = getAllLeafPanes()
    if (leaves.length > 0 && !layout.activePaneId) {
      setActivePane(leaves[0].id)
    }
  }, [layout.root, getAllLeafPanes, setActivePane])

  // resize 时通知所有终端
  useEffect(() => {
    if (!containerRef.current) return

    const resizeObserver = new ResizeObserver(() => {
      window.dispatchEvent(new CustomEvent('pane-resize'))
    })

    resizeObserver.observe(containerRef.current)
    return () => resizeObserver.disconnect()
  }, [])

  // 拖拽处理 - 只用于显示拖放提示
  useEffect(() => {
    const handleDragOver = (e: DragEvent) => {
      if (!getDraggingSessionId()) return

      e.preventDefault()
      setIsDragging(true)

      const leaves = stateRef.current.getAllLeafPanes()
      if (leaves.length > 1) {
        setActiveDropZone(null)
        return
      }

      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return

      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      const xPos = x / rect.width
      const yPos = y / rect.height

      if (xPos < 0.3) {
        setActiveDropZone('left')
      } else if (xPos > 0.7) {
        setActiveDropZone('right')
      } else if (yPos < 0.3) {
        setActiveDropZone('top')
      } else if (yPos > 0.7) {
        setActiveDropZone('bottom')
      } else {
        setActiveDropZone(null)
      }
    }

    const handleDragLeave = (e: DragEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.relatedTarget as Node)) {
        setIsDragging(false)
        setActiveDropZone(null)
      }
    }

    const handleDrop = () => {
      setIsDragging(false)
      setActiveDropZone(null)
    }

    const container = containerRef.current
    if (container) {
      container.addEventListener('dragover', handleDragOver)
      container.addEventListener('dragleave', handleDragLeave)
      container.addEventListener('drop', handleDrop)
    }

    return () => {
      if (container) {
        container.removeEventListener('dragover', handleDragOver)
        container.removeEventListener('dragleave', handleDragLeave)
        container.removeEventListener('drop', handleDrop)
      }
    }
  }, [])

  // 获取拖放区域的样式
  const getDropZoneStyle = (zone: DropZone) => {
    if (!zone) return {}
    const baseStyle = {
      position: 'absolute',
      backgroundColor: 'rgba(0, 120, 212, 0.3)',
      border: '2px dashed #0078D4',
      zIndex: 20,
      transition: 'all 0.15s ease'
    }

    switch (zone) {
      case 'left':
        return { ...baseStyle, left: 0, top: 0, width: '50%', height: '100%' }
      case 'right':
        return { ...baseStyle, right: 0, top: 0, width: '50%', height: '100%' }
      case 'top':
        return { ...baseStyle, left: 0, top: 0, width: '100%', height: '50%' }
      case 'bottom':
        return { ...baseStyle, left: 0, bottom: 0, width: '100%', height: '50%' }
      default:
        return {}
    }
  }

  return (
    <div
      ref={containerRef}
      className="w-full h-full bg-[#0C0C0C] overflow-hidden relative"
    >
      {/* 分屏内容 */}
      <PaneView node={layout.root} />

      {/* 拖放区域提示 */}
      {isDragging && (
        <>
          {/* 左 */}
          <div
            style={getDropZoneStyle('left')}
            className={cn('pointer-events-none', activeDropZone !== 'left' && 'opacity-30')}
          >
            <div className="absolute inset-0 flex items-center justify-center text-white text-sm font-medium">
              左侧分屏
            </div>
          </div>
          {/* 右 */}
          <div
            style={getDropZoneStyle('right')}
            className={cn('pointer-events-none', activeDropZone !== 'right' && 'opacity-30')}
          >
            <div className="absolute inset-0 flex items-center justify-center text-white text-sm font-medium">
              右侧分屏
            </div>
          </div>
          {/* 上 */}
          <div
            style={getDropZoneStyle('top')}
            className={cn('pointer-events-none', activeDropZone !== 'top' && 'opacity-30')}
          >
            <div className="absolute inset-0 flex items-center justify-center text-white text-sm font-medium">
              上方分屏
            </div>
          </div>
          {/* 下 */}
          <div
            style={getDropZoneStyle('bottom')}
            className={cn('pointer-events-none', activeDropZone !== 'bottom' && 'opacity-30')}
          >
            <div className="absolute inset-0 flex items-center justify-center text-white text-sm font-medium">
              下方分屏
            </div>
          </div>
        </>
      )}
    </div>
  )
}

export default SplitPaneContainer