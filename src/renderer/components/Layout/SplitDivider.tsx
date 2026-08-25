import React, { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
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
  const { t } = useTranslation()
  const startPosRef = useRef(0)
  const startRatioRef = useRef(0.5)
  const containerSizeRef = useRef(0) // 拖拽开始时实测的分屏容器尺寸
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
    // 实测父容器(即本 split 的 flex 容器)尺寸 -- 替代旧 window.innerWidth/Height 估算,
    // 后者在侧栏可收起/可调宽后早已不准(嵌套分屏时也错)
    const rect = e.currentTarget.parentElement?.getBoundingClientRect()
    containerSizeRef.current = direction === 'horizontal' ? (rect?.width ?? 0) : (rect?.height ?? 0)
  }

  // 拖拽中
  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      const parentPane = usePaneStore.getState().getParentPane(paneId)
      if (!parentPane) return

      const containerSize = containerSizeRef.current
      if (containerSize <= 0) return

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
      title={t('pane.dragToResize')}
    />
  )
}

export default SplitDivider