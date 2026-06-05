import React, { useState, useRef } from 'react'
import { usePaneStore } from '../../stores/pane-store'
import TerminalView from '../Terminal/TerminalView'
import PaneTabBar from './PaneTabBar'
import SplitDivider from './SplitDivider'
import { getDraggingSessionId, setDraggingSessionId } from './SplitPaneContainer'
import type { PaneNode, SplitDirection } from '@shared/types'

type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'center' | null

interface PaneViewProps {
  node: PaneNode
}

/**
 * 分屏视图组件 - 递归渲染分屏树
 */
const PaneView: React.FC<PaneViewProps> = ({ node }) => {
  const { layout, setActivePane, addSessionToPane, splitPaneWithPosition, swapPanePosition } = usePaneStore()
  const { getPaneBySessionId, getParentPane, getPanePositionInParent } = usePaneStore.getState()
  const isActive = layout.activePaneId === node.id
  const [dropZone, setDropZone] = useState<DropZone>(null)
  const [dropAction, setDropAction] = useState<'swap' | 'changeDirection' | 'split' | null>(null)
  const dropRef = useRef<HTMLDivElement>(null)

  // 点击激活分屏
  const handleClick = () => {
    if (node.type === 'leaf') {
      setActivePane(node.id)
    }
  }

  // 叶子节点 - 渲染标签栏 + 终端
  if (node.type === 'leaf') {
    const handleDragOver = (e: React.DragEvent) => {
      const sessionId = getDraggingSessionId()
      if (!sessionId) {
        setDropZone(null)
        return
      }

      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'

      const rect = dropRef.current?.getBoundingClientRect()
      if (!rect) return

      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      const xPos = x / rect.width
      const yPos = y / rect.height

      // 标签栏高度约 28px，调整上边缘检测阈值
      const tabBarHeightRatio = 28 / rect.height
      const topThreshold = Math.max(0.3, tabBarHeightRatio + 0.1) // 至少 10% 余量

      const isHorizontalEdge = xPos < 0.3 || xPos > 0.7
      const isVerticalEdge = yPos < topThreshold || yPos > 0.7
      const isCenter = !isHorizontalEdge && !isVerticalEdge

      // 如果是自己的会话拖到中心区域，不显示drop提示
      const isOwnSession = node.sessions.includes(sessionId)
      if (isOwnSession && isCenter) {
        setDropZone(null)
        setDropAction(null)
        return
      }

      // 检查是否是兄弟分屏（可以交换位置或改变方向）
      const sourcePane = getPaneBySessionId(sessionId)
      const sourceParent = sourcePane ? getParentPane(sourcePane.id) : undefined
      const targetParent = getParentPane(node.id)

      // 判断操作类型
      let action: 'swap' | 'changeDirection' | 'split' | null = 'split'

      if (sourcePane && sourceParent && targetParent &&
          sourceParent.id === targetParent.id &&
          sourcePane.id !== node.id &&
          sourcePane.sessions.length > 0 &&
          node.sessions.length > 0 &&
          !isCenter) {

        const sourcePosition = getPanePositionInParent(sourcePane.id)
        const parentDirection = sourceParent.direction

        // 判断拖拽方向是否与父分屏方向相同
        const isSameDirection = (parentDirection === 'horizontal' && isHorizontalEdge) ||
                                (parentDirection === 'vertical' && isVerticalEdge)

        if (isSameDirection) {
          // 方向相同，判断是否需要交换位置
          // 逻辑：拖到左边缘期望源在左边，如果源在右边则需要交换
          // 拖到右边缘期望源在右边，如果源在左边则需要交换
          if (parentDirection === 'horizontal') {
            const targetLeft = xPos < 0.3
            const targetRight = xPos > 0.7
            // 拖到左边缘但源在右边 → 交换让源去左边
            if (targetLeft && sourcePosition === 'second') action = 'swap'
            // 拖到右边缘但源在左边 → 交换让源去右边
            if (targetRight && sourcePosition === 'first') action = 'swap'
          } else {
            const targetTop = yPos < 0.3
            const targetBottom = yPos > 0.7
            // 拖到上边缘但源在下边 → 交换让源去上边
            if (targetTop && sourcePosition === 'second') action = 'swap'
            // 拖到下边缘但源在上边 → 交换让源去下边
            if (targetBottom && sourcePosition === 'first') action = 'swap'
          }
        } else {
          // 方向不同，可以改变分屏方向
          action = 'changeDirection'
        }
      }

      setDropAction(action)

      // 显示对应的drop区域
      if (isCenter) {
        setDropZone('center')
      } else if (isHorizontalEdge) {
        setDropZone(xPos < 0.5 ? 'left' : 'right')
      } else {
        setDropZone(yPos < 0.5 ? 'top' : 'bottom')
      }
    }

    const handleDragLeave = (e: React.DragEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.relatedTarget as Node)) {
        setDropZone(null)
        setDropAction(null)
      }
    }

    const handleDrop = (e: React.DragEvent) => {
      e.preventDefault()
      setDropZone(null)
      setDropAction(null)

      const sessionId = getDraggingSessionId()
      if (!sessionId) return

      // 检查鼠标是否在自己的区域内
      const rect = dropRef.current?.getBoundingClientRect()
      if (!rect) return

      // 如果鼠标不在这个分屏内，不处理
      if (e.clientX < rect.left || e.clientX > rect.right ||
          e.clientY < rect.top || e.clientY > rect.bottom) {
        return
      }

      // 先清除拖拽状态，防止其他处理
      setDraggingSessionId(null)

      // 计算拖放位置
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      const xPos = x / rect.width
      const yPos = y / rect.height

      // 标签栏高度约 28px，调整上边缘检测阈值
      const tabBarHeightRatio = 28 / rect.height
      const topThreshold = Math.max(0.3, tabBarHeightRatio + 0.1)

      // 允许拖到自己的分屏边缘触发分屏
      const isOwnSession = node.sessions.includes(sessionId)
      const isHorizontalEdge = xPos < 0.3 || xPos > 0.7
      const isVerticalEdge = yPos < topThreshold || yPos > 0.7
      const isCenter = !isHorizontalEdge && !isVerticalEdge

      // 如果是自己的会话拖到中心区域，不处理
      if (isOwnSession && isCenter) return

      // 如果是自己的会话拖到边缘，或者是别人的会话，都处理
      if (isCenter) {
        addSessionToPane(node.id, sessionId)
      } else {
        // 检查是否是兄弟分屏
        const sourcePane = getPaneBySessionId(sessionId)
        const sourceParent = sourcePane ? getParentPane(sourcePane.id) : undefined
        const targetParent = getParentPane(node.id)

        // 判断是否是兄弟分屏
        if (sourcePane && sourceParent && targetParent &&
            sourceParent.id === targetParent.id &&
            sourcePane.id !== node.id &&
            sourcePane.sessions.length > 0 &&
            node.sessions.length > 0) {

          const sourcePosition = getPanePositionInParent(sourcePane.id)
          const parentDirection = sourceParent.direction

          // 判断拖拽方向是否与父分屏方向相同
          const isSameDirection = (parentDirection === 'horizontal' && isHorizontalEdge) ||
                                  (parentDirection === 'vertical' && isVerticalEdge)

          if (isSameDirection) {
            // 方向相同，判断是否需要交换位置
            let needSwap = false

            if (parentDirection === 'horizontal') {
              const targetLeft = xPos < 0.3
              const targetRight = xPos > 0.7
              if (targetLeft && sourcePosition === 'second') needSwap = true
              if (targetRight && sourcePosition === 'first') needSwap = true
            } else {
              const targetTop = yPos < 0.3
              const targetBottom = yPos > 0.7
              if (targetTop && sourcePosition === 'second') needSwap = true
              if (targetBottom && sourcePosition === 'first') needSwap = true
            }

            if (needSwap) {
              swapPanePosition(sourcePane.id)
            } else {
              // 方向相同但不需要交换，在目标分屏内创建新分屏
              const nestedDirection: SplitDirection = parentDirection === 'horizontal' ? 'vertical' : 'horizontal'
              const position: 'first' | 'second' = isHorizontalEdge
                ? (xPos < 0.3 ? 'first' : 'second')
                : (yPos < topThreshold ? 'first' : 'second')
              splitPaneWithPosition(node.id, nestedDirection, sessionId, position)
            }
          } else {
            // 方向不同，在目标分屏内创建新分屏
            const nestedDirection: SplitDirection = isHorizontalEdge ? 'horizontal' : 'vertical'
            const position: 'first' | 'second' = isHorizontalEdge
              ? (xPos < 0.3 ? 'first' : 'second')
              : (yPos < topThreshold ? 'first' : 'second')
            splitPaneWithPosition(node.id, nestedDirection, sessionId, position)
          }
        } else {
          // 否则创建新分屏
          const direction: SplitDirection = isHorizontalEdge ? 'horizontal' : 'vertical'
          const position: 'first' | 'second' = isHorizontalEdge
            ? (xPos < 0.3 ? 'first' : 'second')
            : (yPos < topThreshold ? 'first' : 'second')
          splitPaneWithPosition(node.id, direction, sessionId, position)
        }
      }
    }

    const getDropZoneStyle = (zone: DropZone, action: 'swap' | 'changeDirection' | 'split' | null) => {
      if (!zone) return null

      const colors = {
        swap: { bg: 'rgba(255, 140, 0, 0.3)', border: '#FF8C00' },      // 橙色 - 交换
        changeDirection: { bg: 'rgba(0, 200, 83, 0.3)', border: '#00C853' }, // 绿色 - 改变方向
        split: { bg: 'rgba(0, 120, 212, 0.3)', border: '#0078D4' }      // 蓝色 - 分屏
      }

      const color = colors[action || 'split']

      const baseStyle = {
        position: 'absolute',
        backgroundColor: color.bg,
        border: `2px dashed ${color.border}`,
        zIndex: 10,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'white',
        fontSize: '14px'
      }

      const labels = {
        swap: '交换',
        changeDirection: '改变方向',
        split: '分屏'
      }
      const label = labels[action || 'split']

      switch (zone) {
        case 'left':
          return { ...baseStyle, left: 0, top: 0, width: '30%', height: '100%', label: `${label}左侧` }
        case 'right':
          return { ...baseStyle, right: 0, top: 0, width: '30%', height: '100%', label: `${label}右侧` }
        case 'top':
          return { ...baseStyle, left: 0, top: 0, width: '100%', height: '30%', label: `${label}上方` }
        case 'bottom':
          return { ...baseStyle, left: 0, bottom: 0, width: '100%', height: '30%', label: `${label}下方` }
        case 'center':
          return { ...baseStyle, left: '30%', top: '30%', width: '40%', height: '40%', label: '合并' }
        default:
          return null
      }
    }

    return (
      <div
        ref={dropRef}
        data-pane-id={node.id}
        onClick={handleClick}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`
          relative w-full h-full flex flex-col
          ${isActive ? 'ring-1 ring-[#0078D4]' : ''}
        `}
      >
        <PaneTabBar pane={node} />

        <div className="flex-1 flex overflow-hidden">
          {/* 终端视图 */}
          {node.activeSessionId ? (
            <TerminalView sessionId={node.activeSessionId} paneId={node.id} />
          ) : (
            <div className="flex items-center justify-center flex-1 bg-[#0C0C0C] text-gray-500">
              <div className="text-center">
                <p className="text-sm">空分屏</p>
                <p className="text-xs mt-1">拖拽标签到此区域</p>
              </div>
            </div>
          )}
        </div>

        {dropZone && getDropZoneStyle(dropZone, dropAction) && (
          <div style={getDropZoneStyle(dropZone, dropAction) as React.CSSProperties}>
            {getDropZoneStyle(dropZone, dropAction)?.label}
          </div>
        )}
      </div>
    )
  }

  // 分屏节点 - 渲染两个子节点
  return (
    <div
      className={`
        w-full h-full flex
        ${node.direction === 'horizontal' ? 'flex-row' : 'flex-col'}
      `}
    >
      <div
        style={{
          [node.direction === 'horizontal' ? 'width' : 'height']: `${node.splitRatio * 100}%`
        }}
        className="flex-shrink-0 overflow-hidden"
      >
        <PaneView node={node.firstChild} />
      </div>

      <SplitDivider paneId={node.id} direction={node.direction} />

      <div className="flex-1 overflow-hidden">
        <PaneView node={node.secondChild} />
      </div>
    </div>
  )
}

export default PaneView