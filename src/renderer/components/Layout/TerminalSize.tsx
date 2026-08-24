import React, { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useTerminalStore } from '../../stores/terminal-store'

/**
 * 终端尺寸显示组件（从 StatusBar.tsx 迁出）
 *
 * size 单击往 PTY 发 Ctrl+L 清屏重绘；行数单击滚回底部、双击清空 scrollback。
 * 嵌在可点击行内使用（侧栏 LIVE 行）——按钮点击都 stopPropagation,不触发行自身的动作。
 */
const TerminalSize: React.FC<{ sessionId: string }> = ({ sessionId }) => {
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
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={handleSizeClick}
        title={t('statusbar.clearScreenHint')}
        className="bg-transparent border-0 p-0 cursor-pointer [font-family:inherit] [font-size:inherit] [line-height:inherit] hover:text-[var(--text-rack)] transition-colors"
      >
        {size.cols}×{size.rows}
      </button>
      <span aria-hidden className="w-px h-[10px] bg-[var(--rule)] flex-shrink-0" />
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
  )
}

export default TerminalSize
