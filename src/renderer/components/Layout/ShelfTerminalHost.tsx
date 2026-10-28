import React, { useCallback, useEffect, useRef, type CSSProperties } from 'react'
import TerminalView from '../Terminal/TerminalView'
import {
  focusShelfSurface,
  leaveShelfSurface,
  SHELF_SURFACE_ENTER,
  shelfSurfaceStyle,
  useShelfSurface,
  type ShelfSurfaceSnapshot
} from './task-shelf-surfaces'

export interface ShelfTerminalHostProps {
  sessionId: string
  paneId?: string
  /** 主分屏是否露出这个终端：true = 走普通分屏形态（PaneView 现用名）。 */
  mainVisible?: boolean
  /** 同 mainVisible 的早期命名（任务书契约），与 mainVisible 取其一即可。 */
  visible?: boolean
}

/**
 * 任务架迷你终端宿主。
 *
 * 同一个 TerminalView 实例（连同它的 xterm、PTY 与输出订阅）始终挂在这一个 DOM
 * 位置上，宿主只切换外层容器的几何与交互额度，绝不另开实例、不截图、不代理按键：
 * 迷你里的打字、IME、选择、粘贴、滚轮都由终端本体直接处理。
 *
 * 两种形态：
 *  - 主视图（mainVisible=true）：absolute inset0 / visible / z1，与原先 PaneView 的包装
 *    完全一致。主视图可见时，注册表里残留的迷你矩形一律不作数。
 *  - 迷你（mainVisible=false 且存在登记）：用 registry 返回的固定定位样式贴到侧栏登记的
 *    矩形上（fixed 可以跨越分屏裁剪边界，clipPath 再裁回侧栏内容区）。只有登记为
 *    「可见 + 可交互」时才真正露出并接受指针/焦点，否则 inert。
 *
 * 侧栏收起（登记注销）而主视图仍不可见时，沿用最后一帧迷你几何并保持隐藏/inert：
 * 回落成「大而不可见」的分屏尺寸会触发一次 ConPTY 整屏重印，且每次开合侧栏都重来一次。
 */
const ShelfTerminalHost: React.FC<ShelfTerminalHostProps> = ({ sessionId, paneId, mainVisible, visible }) => {
  // 两个名字取其一（PaneView 传 mainVisible，任务书契约叫 visible）
  const visibleInMain = mainVisible ?? visible ?? false
  const surface = useShelfSurface('terminal', sessionId)
  const hostRef = useRef<HTMLDivElement>(null)
  const lastSurfaceRef = useRef<ShelfSurfaceSnapshot | null>(null)

  // 登记期间持续记住最后一帧几何；主视图一旦可见立即清空，免得旧的迷你矩形在
  // 「收起侧栏 → 主视图短暂不可见」之间被误当成本次布局。
  useEffect(() => {
    if (surface) lastSurfaceRef.current = surface
  }, [surface])
  useEffect(() => {
    if (visibleInMain) lastSurfaceRef.current = null
  }, [visibleInMain])

  const mini: ShelfSurfaceSnapshot | null = visibleInMain ? null : surface ?? lastSurfaceRef.current
  // 登记已注销、只剩最后一帧几何：位置保留占位，但不再对外暴露
  const exposed = !!mini && surface !== null && surface.visible
  const interactive = exposed && surface.interactive

  const style: CSSProperties = mini
    ? {
        ...shelfSurfaceStyle(mini),
        ...(exposed
          ? {}
          : { visibility: 'hidden' as const, pointerEvents: 'none' as const, clipPath: 'inset(100%)' })
      }
    : {
        position: 'absolute',
        inset: 0,
        visibility: visibleInMain ? 'visible' : 'hidden',
        zIndex: visibleInMain ? 1 : 0
      }

  // 不可交互（侧栏收起、被别的任务顶掉、或未登记可交互）时不接受 Tab 焦点：
  // pointerEvents:none 只管指针，键盘聚焦要靠 inert 才拦得住。
  useEffect(() => {
    const element = hostRef.current
    if (!element) return
    if (mini && !interactive) element.setAttribute('inert', '')
    else element.removeAttribute('inert')
  }, [mini, interactive])

  // 点到 / 聚焦到真实终端就认领这个面：右侧面板据此保持展开，键盘归属也随之切换
  const claimSurface = useCallback(() => {
    if (!interactive) return
    focusShelfSurface('terminal', sessionId)
  }, [interactive, sessionId])

  // 悬停进出同样通报 registry，让侧栏的悬停开合把「指针在原生终端上」算作仍在架内
  const enterSurface = useCallback(() => {
    if (!interactive) return
    window.dispatchEvent(new Event(SHELF_SURFACE_ENTER))
  }, [interactive])

  const leaveSurface = useCallback(() => {
    if (!interactive) return
    leaveShelfSurface()
  }, [interactive])

  return (
    <div
      ref={hostRef}
      className={mini ? 'shelf-terminal-host' : 'absolute inset-0'}
      style={style}
      data-shelf-native={exposed ? '' : undefined}
      onMouseDownCapture={claimSurface}
      onClickCapture={claimSurface}
      onFocusCapture={claimSurface}
      onMouseEnter={enterSurface}
      onMouseLeave={leaveSurface}
    >
      <TerminalView
        sessionId={sessionId}
        paneId={paneId}
        shelfHost={mini ? { active: mini.active, interactive } : undefined}
      />
    </div>
  )
}

export default ShelfTerminalHost
