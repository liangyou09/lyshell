import React, { useState, useRef, useEffect } from 'react'
import { usePaneStore } from '../../stores/pane-store'
import type { SplitDirection } from '@shared/types'

interface SplitDividerProps {
  paneId: string
  direction: SplitDirection
}

/**
 * 分屏分隔条组件 - 可拖拽调整比例
 */
const SplitDivider: React.FC<SplitDividerProps> = ({ paneId, direction }) => {
  const [isDragging, setIsDragging] = useState(false)
  const startPosRef = useRef(0)
  const startRatioRef = useRef(0.5)
  const { setSplitRatio } = usePaneStore()

  // 获取当前比例
  const pane = usePaneStore.getState().getPaneById(paneId)
  const currentRatio = pane?.type === 'split' ? pane.splitRatio : 0.5

  // 开始拖拽
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    setIsDragging(true)
    startPosRef.current = direction === 'horizontal' ? e.clientX : e.clientY
    startRatioRef.current = currentRatio
  }

  // 拖拽中
  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      const parentPane = usePaneStore.getState().getParentPane(paneId)
      if (!parentPane) return

      // 计算容器尺寸
      // 这里简化处理，假设容器是整个窗口
      const containerSize = direction === 'horizontal'
        ? window.innerWidth - 240 // 减去侧边栏宽度
        : window.innerHeight - 100 // 减去顶部和底部高度

      const delta = direction === 'horizontal'
        ? e.clientX - startPosRef.current
        : e.clientY - startPosRef.current

      const newRatio = startRatioRef.current + delta / containerSize
      setSplitRatio(paneId, newRatio)
    }

    const handleMouseUp = () => {
      setIsDragging(false)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging, paneId, direction, setSplitRatio])

  return (
    <div
      onMouseDown={handleMouseDown}
      className={`
        ${direction === 'horizontal' ? 'w-[4px] cursor-col-resize' : 'h-[4px] cursor-row-resize'}
        ${isDragging ? 'bg-[#0078D4]' : 'bg-[#3C3C3C] hover:bg-[#0078D4]'}
        flex-shrink-0 transition-colors
      `}
      title="拖拽调整分屏比例"
    />
  )
}

export default SplitDivider