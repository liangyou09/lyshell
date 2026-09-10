import React, { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useTerminalStore } from '../../stores/terminal-store'

/**
 * 状态栏竖规 —— 各读数段之间的 1px 分隔(统一 rule 色、恒不收缩)。
 * 原是 TerminalSize 尺寸/行数之间的内联 span,编码读数加入左槽后
 * SessionsPanel 状态栏多处要用,抽出共用,规格只此一份。
 */
export const BarRule: React.FC = () => (
  <span aria-hidden className="w-px h-[10px] bg-[var(--rule)] flex-shrink-0" />
)

/**
 * 终端尺寸显示组件（从 StatusBar.tsx 迁出,现嵌在会话面板底部状态栏左槽）
 *
 * size 单击往 PTY 发 Ctrl+L 清屏重绘；行数单击滚回底部、双击清空 scrollback。
 * 按钮点击都 stopPropagation,不触发宿主容器的点击行为。
 * 行数靠 2s 轮询而非事件驱动:组件可能早于 xterm 实例挂载(会话连接中),轮询天然兜住
 * 晚到的实例;事件化要把 onResize/onLineFeed 穿进 store 层,已知取舍,后续有需要再换。
 *
 * hideLines:窄宽降级的第一档(侧栏 <300px)整段隐藏行数(连同其竖规) —— 行数是
 * 读数家族里价值最低的一段,先于尺寸退场,保住协议码/编码/尺寸;调用方是
 * SessionsPanel 状态栏的 ResizeObserver 阈值。
 *
 * 首竖规(与前方编码读数的分隔)放在本组件内而非调用方:xterm 实例未注册的窗口期
 * size 为 null、整段不渲染,竖规跟着一起消失 —— 放调用方会在该窗口期悬空
 * (左槽渲染成 "SSH │ GBK │" 尾巴上多一条没人隔的线)。
 */
const TerminalSize: React.FC<{ sessionId: string; hideLines?: boolean }> = ({ sessionId, hideLines }) => {
  const { getTerminal } = useTerminalStore()
  const { t } = useTranslation()
  const [size, setSize] = useState<{ cols: number; rows: number; bufferLines: number } | null>(null)
  // 行数单击/双击区分:单击滚回底部、双击清空 scrollback,用定时器避免单击动作在双击时先行触发
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const updateSize = () => {
      const instance = getTerminal(sessionId)
      if (instance) {
        const cols = instance.terminal.cols
        const rows = instance.terminal.rows
        const bufferLines = instance.terminal.buffer.active.length
        if (cols && rows) {
          setSize({ cols, rows, bufferLines })
        }
      }
    }
    updateSize()
    const interval = setInterval(updateSize, 2000)
    return () => clearInterval(interval)
  }, [sessionId, getTerminal])

  // 卸载时清掉待触发的单击定时器,避免组件销毁后仍 scrollToBottom
  useEffect(() => {
    return () => {
      if (clickTimer.current) clearTimeout(clickTimer.current)
    }
  }, [])

  if (!size) return null
  const lines = size.bufferLines
  const formattedLines = lines >= 10000 ? `${Math.floor(lines / 1000)}k`
    : lines >= 1000 ? `${(lines / 1000).toFixed(1)}k`
    : `${lines}`

  // size 单击:往 PTY 发 Ctrl+L(\x0c),清当前屏并重绘提示符,保留 scrollback
  const handleSizeClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    window.electronAPI?.terminalWrite(sessionId, '\x0c')
  }

  // 行数:首次点击起一个 250ms 定时器做"滚回底部";定时器未到期又来一次点击则取消并"清空 scrollback"
  const handleLinesClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    const instance = getTerminal(sessionId)
    if (!instance) return
    if (clickTimer.current) {
      clearTimeout(clickTimer.current)
      clickTimer.current = null
      instance.terminal.clear()
    } else {
      clickTimer.current = setTimeout(() => {
        clickTimer.current = null
        instance.terminal.scrollToBottom()
      }, 250)
    }
  }

  return (
    <>
      <BarRule />
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={handleSizeClick}
        title={t('statusbar.clearScreenHint')}
        className="bg-transparent border-0 p-0 cursor-pointer [font-family:inherit] [font-size:inherit] [line-height:inherit] hover:text-[var(--text-rack)] transition-colors"
      >
        {size.cols}×{size.rows}
      </button>
      {!hideLines && (
        <>
          <BarRule />
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleLinesClick}
            title={t('statusbar.scrollBottomHint')}
            className="tabular-nums bg-transparent border-0 p-0 cursor-pointer [font-family:inherit] [font-size:inherit] [line-height:inherit] hover:text-[var(--text-rack)] transition-colors"
          >
            {formattedLines}
          </button>
        </>
      )}
    </>
  )
}

export default TerminalSize
