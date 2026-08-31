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
  }, [layout.root, layout.activePaneId, getAllLeafPanes, setActivePane])

  // resize 时通知所有终端
  useEffect(() => {
    if (!containerRef.current) return

    const resizeObserver = new ResizeObserver(() => {
      window.dispatchEvent(new CustomEvent('pane-resize'))
    })

    resizeObserver.observe(containerRef.current)
    return () => resizeObserver.disconnect()
  }, [])

  // 丢失 dragend 兜底：dragend 只挂在源页签（OverlayTab / 会话页签）上，源元素
  // 中途卸载（如拖拽中布局变化）或 Electron 异常序列下 dragend 可能不再触发，
  // 残留的拖拽标记会让拖拽盾常驻挡住内容区、并误路由下一次 drop。window 级
  // capture 监听兜两道险：dragend 无论源元素是否存活都会冒泡到 window（capture
  // 确保先于各页签自己的 reset，幂等无妨）；pointerdown 兜 dragend 彻底丢失的
  // 场景 —— 拖拽期间不会有 pointer 事件，下一次按下必然意味着拖拽已结束，自愈
  useEffect(() => {
    const clearDraggingMarkers = () => {
      globalDraggingSessionId = null
      // setDraggingOverlay 自带同值短路，这里可以无条件清
      usePaneStore.getState().setDraggingOverlay(null)
    }
    window.addEventListener('dragend', clearDraggingMarkers, true)
    window.addEventListener('pointerdown', clearDraggingMarkers, true)
    return () => {
      window.removeEventListener('dragend', clearDraggingMarkers, true)
      window.removeEventListener('pointerdown', clearDraggingMarkers, true)
    }
  }, [])

  return (
    <div
      ref={containerRef}
      className="w-full h-full bg-[var(--terminal-bg)] overflow-hidden relative"
    >
      {/* 分屏内容 -- 根节点即窗口第一行,三个顶排 flag 全部置真(由 PaneView 沿分屏树传播) */}
      <PaneView node={layout.root} isTop isTopLeft isTopRight />
    </div>
  )
}

export default SplitPaneContainer