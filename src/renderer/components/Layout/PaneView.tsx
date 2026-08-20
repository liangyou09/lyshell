import React, { useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { usePaneStore } from '../../stores/pane-store'
import TerminalView from '../Terminal/TerminalView'
import PaneTabBar from './PaneTabBar'
import { McpAuditPanel } from './McpAuditPanel'
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
  const { layout, setActivePane, addSessionToPane, splitPaneWithPosition, swapPanePosition, mcpAuditPaneId, closeMcpAudit, dshWeb, dshWebPaneId, dshWebActive, draggingDshWeb, setDraggingDshWeb, moveDshWebToPane, splitDshWebIntoPane } = usePaneStore()
  const { getPaneBySessionId, getParentPane, getPanePositionInParent } = usePaneStore.getState()
  // 被隐藏的终端页签记录(Sidebar LIVE 段会话标签点击 toggle);订阅整个记录,任何 toggle 都会触发本组件重渲染。
  // 实际负载很小(仅 visibility 切换),未做按 pane 过滤的选择器。
  const hiddenTabSessions = usePaneStore(s => s.hiddenTabSessions)
  const { t } = useTranslation()
  const isActive = layout.activePaneId === node.id
  const [dropZone, setDropZone] = useState<DropZone>(null)
  const [dropAction, setDropAction] = useState<'swap' | 'changeDirection' | 'split' | 'moveWeb' | null>(null)
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
      const draggingWeb = draggingDshWeb
      if (!sessionId && !draggingWeb) {
        setDropZone(null)
        setDropAction(null)
        return
      }

      const rect = dropRef.current?.getBoundingClientRect()
      if (!rect) return

      const x = e.clientX - rect.left
      const y = e.clientY - rect.top

      // 如果光标不在终端区域内，不处理（比如在标签栏上）
      if (x < 0 || x > rect.width || y < 0 || y > rect.height) {
        setDropZone(null)
        setDropAction(null)
        return
      }

      // 只有光标在终端区域内才调用 preventDefault
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'

      const xPos = x / rect.width
      const yPos = y / rect.height

      // dsh Web 拖拽分屏：四边 = 独立分屏，中心 = 改挂载到本 pane（live 预览沿用 dropZone 指示器）
      if (draggingWeb) {
        const isHorizontalEdge = xPos < 0.3 || xPos > 0.7
        const isVerticalEdge = yPos < 0.25 || yPos > 0.7
        const isCenter = !isHorizontalEdge && !isVerticalEdge
        setDropAction(isCenter ? 'moveWeb' : 'split')
        if (isCenter) {
          setDropZone('center')
        } else if (isHorizontalEdge) {
          setDropZone(xPos < 0.5 ? 'left' : 'right')
        } else {
          setDropZone(yPos < 0.5 ? 'top' : 'bottom')
        }
        return
      }

      // 非 web 拖拽：顶部 guard 已拦下「两者皆空」，此处仅为收窄 sessionId 类型
      if (!sessionId) return

      // 判断拖拽位置
      const isHorizontalEdge = xPos < 0.3 || xPos > 0.7
      const isVerticalEdge = yPos < 0.25 || yPos > 0.7
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

      // dsh Web 拖拽落下：中心 = 改挂载，四边 = 独立分屏
      if (draggingDshWeb) {
        const rect = dropRef.current?.getBoundingClientRect()
        if (!rect) return
        if (e.clientX < rect.left || e.clientX > rect.right ||
            e.clientY < rect.top || e.clientY > rect.bottom) {
          return
        }
        const x = e.clientX - rect.left
        const y = e.clientY - rect.top
        const xPos = x / rect.width
        const yPos = y / rect.height
        setDraggingDshWeb(false)

        const isHorizontalEdge = xPos < 0.3 || xPos > 0.7
        const isVerticalEdge = yPos < 0.25 || yPos > 0.7
        const isCenter = !isHorizontalEdge && !isVerticalEdge

        if (isCenter) {
          moveDshWebToPane(node.id)
        } else if (isHorizontalEdge) {
          splitDshWebIntoPane(node.id, 'horizontal', xPos < 0.5 ? 'first' : 'second')
        } else {
          splitDshWebIntoPane(node.id, 'vertical', yPos < 0.5 ? 'first' : 'second')
        }
        return
      }

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

      // 如果光标不在终端区域内，不处理
      if (x < 0 || x > rect.width || y < 0 || y > rect.height) {
        return
      }

      // 使用与 handleDragOver 一致的判断逻辑
      const isHorizontalEdge = xPos < 0.3 || xPos > 0.7
      const isVerticalEdge = yPos < 0.25 || yPos > 0.7
      const isCenter = !isHorizontalEdge && !isVerticalEdge

      // 如果是自己的会话拖到中心区域，不处理
      const isOwnSession = node.sessions.includes(sessionId)
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
              const targetTop = yPos < 0.25
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
                : (yPos < 0.25 ? 'first' : 'second')
              splitPaneWithPosition(node.id, nestedDirection, sessionId, position)
            }
          } else {
            // 方向不同，在目标分屏内创建新分屏
            const nestedDirection: SplitDirection = isHorizontalEdge ? 'horizontal' : 'vertical'
            const position: 'first' | 'second' = isHorizontalEdge
              ? (xPos < 0.3 ? 'first' : 'second')
              : (yPos < 0.25 ? 'first' : 'second')
            splitPaneWithPosition(node.id, nestedDirection, sessionId, position)
          }
        } else {
          // 否则创建新分屏
          const direction: SplitDirection = isHorizontalEdge ? 'horizontal' : 'vertical'
          const position: 'first' | 'second' = isHorizontalEdge
            ? (xPos < 0.3 ? 'first' : 'second')
            : (yPos < 0.25 ? 'first' : 'second')
          splitPaneWithPosition(node.id, direction, sessionId, position)
        }
      }
    }

    const getDropZoneStyle = (zone: DropZone, action: 'swap' | 'changeDirection' | 'split' | 'moveWeb' | null) => {
      if (!zone) return null

      const colors = {
        swap: { bg: 'rgba(255, 140, 0, 0.3)', border: '#FF8C00' },      // 橙色 - 交换
        changeDirection: { bg: 'rgba(0, 200, 83, 0.3)', border: '#00C853' }, // 绿色 - 改变方向
        split: { bg: 'rgba(0, 120, 212, 0.3)', border: '#0078D4' },      // 蓝色 - 分屏
        moveWeb: { bg: 'rgba(0, 200, 200, 0.3)', border: '#00C8C8' }     // 青色 - 移动 Web 挂载
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
        swap: t('pane.actionSwap'),
        changeDirection: t('pane.actionChangeDirection'),
        split: t('pane.actionSplit'),
        moveWeb: t('pane.moveWebHere')
      }
      const label = labels[action || 'split']

      switch (zone) {
        case 'left':
          return { ...baseStyle, left: 0, top: 0, width: '30%', height: '100%', label: t('pane.zoneLeft', { label }) }
        case 'right':
          return { ...baseStyle, right: 0, top: 0, width: '30%', height: '100%', label: t('pane.zoneRight', { label }) }
        case 'top':
          return { ...baseStyle, left: 0, top: 0, width: '100%', height: '25%', label: t('pane.zoneTop', { label }) }
        case 'bottom':
          return { ...baseStyle, left: 0, bottom: 0, width: '100%', height: '25%', label: t('pane.zoneBottom', { label }) }
        case 'center':
          return { ...baseStyle, left: '30%', top: '25%', width: '40%', height: '50%', label: action === 'moveWeb' ? t('pane.moveWebHere') : t('pane.merge') }
        default:
          return null
      }
    }

    return (
      <div
        data-pane-id={node.id}
        onClick={handleClick}
        className={`
          relative w-full h-full flex flex-col
          ${isActive ? 'ring-1 ring-[#0078D4]' : ''}
        `}
      >
        <PaneTabBar pane={node} />

        <div
          ref={dropRef}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className="flex-1 flex overflow-hidden relative"
        >
          {/* 渲染所有 session 的终端,非活跃 / 被隐藏的用 CSS 隐藏,确保 xterm 实例不卸载、持续接收数据 */}
          {node.sessions.length > 0 ? (
            <>
              {node.sessions.map(sessionId => {
                // 被隐藏的页签:终端仍挂载(保留连接与输出),但不可见;活跃且未隐藏才显示
                const isVisible = sessionId === node.activeSessionId && !hiddenTabSessions[sessionId]
                return (
                  <div
                    key={sessionId}
                    className="absolute inset-0"
                    style={{
                      visibility: isVisible ? 'visible' : 'hidden',
                      zIndex: isVisible ? 1 : 0
                    }}
                  >
                    <TerminalView sessionId={sessionId} paneId={node.id} />
                  </div>
                )
              })}
              {/* 所有页签都被隐藏时叠加提示;终端实例仍挂载下层,保留连接与输出 */}
              {node.sessions.every(id => hiddenTabSessions[id]) && (
                <div className="absolute inset-0 flex items-center justify-center bg-[var(--terminal-bg)] text-gray-500 z-10 pointer-events-none">
                  <div className="text-center">
                    <p className="text-sm">{t('pane.allTabsHidden')}</p>
                    <p className="text-xs mt-1">{t('pane.allTabsHiddenHint')}</p>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="flex items-center justify-center flex-1 bg-[var(--terminal-bg)] text-gray-500">
              <div className="text-center">
                <p className="text-sm">{t('pane.emptyPane')}</p>
                <p className="text-xs mt-1">{t('pane.emptyPaneHint')}</p>
              </div>
            </div>
          )}

          {/* MCP 活动页签覆盖层 -- 单例，仅本 pane 激活时挂载；终端实例在底层继续接收数据，关掉页签原样复现 */}
          {mcpAuditPaneId === node.id && (
            <div className="absolute inset-0 z-10">
              <McpAuditPanel onClose={closeMcpAudit} />
            </div>
          )}

          {/* dsh Web UI 覆盖层 -- 单例，打开后挂载在本 pane；切到终端标签用 visibility 隐藏（webview 保持挂载、页面状态不丢），点 ✕ 才卸载销毁。导航由主进程锁定 */}
          {/* 拖拽 web 页签期间同样隐藏 webview：webview 是独立原生视图、会吞掉宿主页 dragover/drop，隐藏后 drop 目标区（终端/空 pane）才可接收 */}
          {dshWebPaneId === node.id && dshWeb && (
            <div
              className="absolute inset-0"
              style={{
                visibility: dshWebActive && !draggingDshWeb ? 'visible' : 'hidden',
                zIndex: dshWebActive && !draggingDshWeb ? 10 : 0
              }}
            >
              <webview
                partition="persist:dshweb"
                src={dshWeb.url}
                className="w-full h-full"
              />
            </div>
          )}

          {/* 分屏指示器 */}
          {dropZone && getDropZoneStyle(dropZone, dropAction) && (
            <div style={getDropZoneStyle(dropZone, dropAction) as React.CSSProperties}>
              {getDropZoneStyle(dropZone, dropAction)?.label}
            </div>
          )}
        </div>
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
