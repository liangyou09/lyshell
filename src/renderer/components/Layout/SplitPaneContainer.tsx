import React, { useEffect, useRef } from 'react'
import { usePaneStore } from '../../stores/pane-store'
import PaneView from './PaneView'
import { useShallow } from 'zustand/react/shallow'

// 全局拖拽状态
let globalDraggingSessionId: string | null = null
export const setDraggingSessionId = (id: string | null) => {
  globalDraggingSessionId = id
}
export const getDraggingSessionId = () => globalDraggingSessionId

/**
 * 分屏容器组件
 */
const SplitPaneContainer: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null)
  const { layout, splitPane, setActivePane, getAllLeafPanes } = usePaneStore(
    useShallow(state => ({
      layout: state.layout,
      splitPane: state.splitPane,
      setActivePane: state.setActivePane,
      getAllLeafPanes: state.getAllLeafPanes
    }))
  )

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

  return (
    <div
      ref={containerRef}
      className="w-full h-full bg-[var(--terminal-bg)] overflow-hidden relative"
    >
      {/* 分屏内容 */}
      <PaneView node={layout.root} />
    </div>
  )
}

export default SplitPaneContainer