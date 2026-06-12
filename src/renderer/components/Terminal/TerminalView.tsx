import React, { useEffect, useRef, useState } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import { SearchAddon } from 'xterm-addon-search'
import 'xterm/css/xterm.css'
import { DEFAULT_THEME_DARK, DEFAULT_FONT_FAMILY } from '@shared/constants'
import { useTerminalStore } from '../../stores/terminal-store'
import { useSessionStore } from '../../stores/session-store'
import { ConnectionStatus } from '@shared/types'

interface TerminalViewProps {
  sessionId: string
  paneId?: string
  onSearchAllTabs?: (text: string, direction: 'next' | 'prev') => void
}

/**
 * 终端视图组件
 * 终端实例存储在全局 store 中，与 sessionId 绑定，不受组件生命周期影响
 */
const TerminalView: React.FC<TerminalViewProps> = ({ sessionId, paneId, onSearchAllTabs }) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const resizeTimeoutRef = useRef<number | null>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const connectionStatusRef = useRef<ConnectionStatus | null>(null) // 记录连接状态
  const [showSearch, setShowSearch] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [searchDirection, setSearchDirection] = useState<'next' | 'prev'>('next')
  const [searchScope, setSearchScope] = useState<'current' | 'all'>('current')
  const [useRegex, setUseRegex] = useState(false)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [loopSearch, setLoopSearch] = useState(true)
  const [highlightOnType, setHighlightOnType] = useState(true)
  const [clearOnClose, setClearOnClose] = useState(true)
  const [searchBoxPos, setSearchBoxPos] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const dragStartPos = useRef({ x: 0, y: 0 })
  const searchInputRef = useRef<HTMLTextAreaElement>(null)
  const scrollbackLines = parseInt(localStorage.getItem('terminalScrollback') || '10000')
  const fontSize = parseInt(localStorage.getItem('terminalFontSize') || '16')
  const cursorBlink = localStorage.getItem('terminalCursorBlink') !== 'false'  // 默认开启，设为 'false' 才关闭

  const { getTerminal, registerTerminal } = useTerminalStore()
  const { sessions } = useSessionStore()
  const session = sessions.find(s => s.id === sessionId)
  const sessionConfig = session?.config

  // 初始化或获取终端实例
  useEffect(() => {
    if (!containerRef.current) return

    // 检查是否已有终端实例
    const existingInstance = getTerminal(sessionId)
    let terminal: Terminal
    let fitAddon: FitAddon

    if (existingInstance) {
      // 使用已有实例
      terminal = existingInstance.terminal
      fitAddon = existingInstance.fitAddon

      // 将终端元素添加到当前容器（温和方式，避免不必要的清理）
      const terminalElement = terminal.element
      if (terminalElement && terminalElement.parentElement !== containerRef.current) {
        // 暂时断开 ResizeObserver，避免移动时触发不必要的 fit
        if (resizeObserverRef.current) {
          resizeObserverRef.current.disconnect()
        }

        // 先从旧容器移除（如果有）
        if (terminalElement.parentElement) {
          terminalElement.parentElement.removeChild(terminalElement)
        }

        // 清理容器中可能存在的其他元素
        while (containerRef.current.firstChild) {
          containerRef.current.removeChild(containerRef.current.firstChild)
        }

        containerRef.current.appendChild(terminalElement)

        // 延迟后重新连接 ResizeObserver 并执行一次 fit
        setTimeout(() => {
          if (resizeObserverRef.current && containerRef.current) {
            resizeObserverRef.current.observe(containerRef.current)
          }
          const instance = getTerminal(sessionId)
          if (instance && containerRef.current) {
            try {
              const rect = containerRef.current.getBoundingClientRect()
              if (rect.width > 0 && rect.height > 0) {
                instance.fitAddon.fit()
                if (instance.terminal.cols && instance.terminal.rows) {
                  window.electronAPI?.terminalResize(sessionId, instance.terminal.cols, instance.terminal.rows)
                }
              }
            } catch {
              // 忽略错误
            }
          }
        }, 50)
      }
    } else {
      // 创建新终端实例 - 先清理容器
      while (containerRef.current.firstChild) {
        containerRef.current.removeChild(containerRef.current.firstChild)
      }

      terminal = new Terminal({
        fontFamily: DEFAULT_FONT_FAMILY,
        fontSize: fontSize,
        lineHeight: 1.2,
        theme: DEFAULT_THEME_DARK,
        cursorStyle: 'block',
        cursorBlink: cursorBlink,
        scrollback: scrollbackLines,
        allowTransparency: false,
        logLevel: 'off',
        convertEol: true  // 正确处理换行和回显
      })

      fitAddon = new FitAddon()
      terminal.loadAddon(fitAddon)

      // 加载 SearchAddon
      const searchAddon = new SearchAddon()
      searchAddonRef.current = searchAddon
      terminal.loadAddon(searchAddon)

      terminal.open(containerRef.current)

      // 显示欢迎信息和 Xshell 风格的连接信息
      const buildDate = new Date().toISOString().split('T')[0]
      terminal.writeln(`\x1b[1;36mLyShell v1.0.1\x1b[0m \x1b[90mBuild: ${buildDate}\x1b[0m`)
      terminal.writeln('')
      const sshConfig = sessionConfig?.ssh
      const host = sshConfig?.host || 'unknown'
      const port = sshConfig?.port || 22
      terminal.writeln(`Connecting to ${host}:${port}...`)

      // 注册到 store
      registerTerminal(sessionId, terminal, fitAddon)

      // 处理用户输入
      terminal.onData((data) => {
        window.electronAPI?.terminalWrite(sessionId, data)
      })

      // 选中后自动复制到剪贴板
      terminal.onSelectionChange(() => {
        const selection = terminal.getSelection()
        if (selection) {
          navigator.clipboard.writeText(selection)
        }
      })
    }

    // 延迟 fit 以确保容器尺寸正确
    setTimeout(() => {
      const instance = getTerminal(sessionId)
      if (instance && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) {
          instance.fitAddon.fit()
          if (instance.terminal.cols && instance.terminal.rows) {
            window.electronAPI?.terminalResize(sessionId, instance.terminal.cols, instance.terminal.rows)
          }
        }
      }
    }, 100)

    // 右键粘贴剪贴板内容
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      // 确保终端聚焦
      const instance = getTerminal(sessionId)
      if (instance) {
        instance.terminal.focus()
      }
      navigator.clipboard.readText().then(text => {
        if (text) {
          window.electronAPI?.terminalWrite(sessionId, text)
        }
      })
    }

    // 点击时聚焦终端
    const handleClick = (_e: MouseEvent) => {
      const instance = getTerminal(sessionId)
      if (instance) {
        instance.terminal.focus()
      }
    }

    // 鼠标滚轮点击（中键）打开查找
    const handleMouseDown = (e: MouseEvent) => {
      if (e.button === 1) {
        e.preventDefault()
        const container = containerRef.current
        if (container) {
          const rect = container.getBoundingClientRect()
          setSearchBoxPos({
            x: rect.width / 2 - 175,
            y: rect.height / 2 - 20
          })
        }
        setShowSearch(true)
      }
    }

    // 处理终端 resize - 使用 ResizeObserver 监听容器大小变化（带防抖）
    const handleResize = () => {
      const instance = getTerminal(sessionId)
      if (instance && containerRef.current) {
        try {
          const rect = containerRef.current.getBoundingClientRect()
          if (rect.width <= 0 || rect.height <= 0) {
            return
          }

          const oldCols = instance.terminal.cols
          const oldRows = instance.terminal.rows

          instance.fitAddon.fit()

          const newCols = instance.terminal.cols
          const newRows = instance.terminal.rows

          if (newCols && newRows && (newCols !== oldCols || newRows !== oldRows)) {
            window.electronAPI?.terminalResize(sessionId, newCols, newRows)
          }
        } catch {
          // 终端可能已销毁，忽略错误
        }
      }
    }

    // 防抖的 resize 处理（150ms 防抖，减少频繁重绘）
    const debouncedResize = () => {
      if (resizeTimeoutRef.current) {
        clearTimeout(resizeTimeoutRef.current)
      }
      resizeTimeoutRef.current = window.setTimeout(handleResize, 150)
    }

    const resizeObserver = new ResizeObserver(debouncedResize)
    resizeObserverRef.current = resizeObserver
    resizeObserver.observe(containerRef.current)

    // 处理窗口 resize（作为备用）
    const handleWindowResize = () => {
      const instance = getTerminal(sessionId)
      if (instance && containerRef.current) {
        try {
          const rect = containerRef.current.getBoundingClientRect()
          if (rect.width > 0 && rect.height > 0) {
            instance.fitAddon.fit()
            if (instance.terminal.cols && instance.terminal.rows) {
              window.electronAPI?.terminalResize(sessionId, instance.terminal.cols, instance.terminal.rows)
            }
          }
        } catch {
          // 终端可能已销毁，忽略错误
        }
      }
    }

    window.addEventListener('resize', handleWindowResize)
    containerRef.current.addEventListener('contextmenu', handleContextMenu)
    containerRef.current.addEventListener('mousedown', handleMouseDown)
    containerRef.current.addEventListener('click', handleClick)

    // 监听字体大小变化事件
    const handleFontSizeChanged = (e: CustomEvent) => {
      const instance = getTerminal(sessionId)
      if (instance) {
        instance.terminal.options.fontSize = e.detail
        instance.fitAddon.fit()
        if (instance.terminal.cols && instance.terminal.rows) {
          window.electronAPI?.terminalResize(sessionId, instance.terminal.cols, instance.terminal.rows)
        }
      }
    }
    window.addEventListener('terminalFontSizeChanged', handleFontSizeChanged as EventListener)

    // 监听光标闪烁变化事件
    const handleCursorBlinkChanged = (e: CustomEvent) => {
      const instance = getTerminal(sessionId)
      if (instance) {
        instance.terminal.options.cursorBlink = e.detail
      }
    }
    window.addEventListener('terminalCursorBlinkChanged', handleCursorBlinkChanged as EventListener)

    return () => {
      resizeObserver.disconnect()
      resizeObserverRef.current = null
      if (resizeTimeoutRef.current) {
        clearTimeout(resizeTimeoutRef.current)
        resizeTimeoutRef.current = null
      }
      window.removeEventListener('resize', handleWindowResize)
      containerRef.current?.removeEventListener('contextmenu', handleContextMenu)
      containerRef.current?.removeEventListener('mousedown', handleMouseDown)
      containerRef.current?.removeEventListener('click', handleClick)
      window.removeEventListener('terminalFontSizeChanged', handleFontSizeChanged as EventListener)
      window.removeEventListener('terminalCursorBlinkChanged', handleCursorBlinkChanged as EventListener)
      // 注意：不在这里 dispose 终端，终端实例保存在 store 中
      // 只有在 session 断开时才 dispose
    }
  }, [sessionId, getTerminal, registerTerminal])

  // Ctrl+F 快捷键查找
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        e.stopPropagation()
        // 初始化搜索框位置到中间
        const container = containerRef.current
        if (container) {
          const rect = container.getBoundingClientRect()
          setSearchBoxPos({
            x: Math.max(10, rect.width / 2 - 160),
            y: Math.max(10, rect.height / 2 - 80)
          })
        }
        setShowSearch(true)
      }
      if (e.key === 'Escape') {
        setShowSearch(false)
        setSearchText('')
      }
    }

    // 使用 capture 模式确保在其他处理器之前捕获
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [])

  // 监听分屏 resize 事件（带防抖）
  useEffect(() => {
    const handlePaneResize = () => {
      const instance = getTerminal(sessionId)
      if (instance && containerRef.current) {
        try {
          const rect = containerRef.current.getBoundingClientRect()
          if (rect.width > 0 && rect.height > 0) {
            // 使用防抖，避免频繁重绘
            if (resizeTimeoutRef.current) {
              clearTimeout(resizeTimeoutRef.current)
            }
            resizeTimeoutRef.current = window.setTimeout(() => {
              try {
                instance.fitAddon.fit()
                const cols = instance.terminal.cols
                const rows = instance.terminal.rows
                if (cols && rows) {
                  window.electronAPI?.terminalResize(sessionId, cols, rows)
                }
              } catch {
                // 终端可能已销毁，忽略错误
              }
            }, 100)
          }
        } catch {
          // 终端可能已销毁，忽略错误
        }
      }
    }

    window.addEventListener('pane-resize', handlePaneResize)
    return () => window.removeEventListener('pane-resize', handlePaneResize)
  }, [sessionId, paneId, getTerminal])

  // 标签页切换后重新 fit + resize（终端可能从隐藏变为可见）
  useEffect(() => {
    const handleTabSwitch = () => {
      const instance = getTerminal(sessionId)
      if (instance && containerRef.current) {
        try {
          const rect = containerRef.current.getBoundingClientRect()
          if (rect.width > 0 && rect.height > 0) {
            setTimeout(() => {
              try {
                instance.fitAddon.fit()
                const cols = instance.terminal.cols
                const rows = instance.terminal.rows
                if (cols && rows) {
                  window.electronAPI?.terminalResize(sessionId, cols, rows)
                }
              } catch {
                // 忽略错误
              }
            }, 50)
          }
        } catch {
          // 忽略错误
        }
      }
    }
    window.addEventListener('terminal-tab-switched', handleTabSwitch)
    return () => window.removeEventListener('terminal-tab-switched', handleTabSwitch)
  }, [sessionId, getTerminal])

  // 监听终端数据
  useEffect(() => {
    if (!window.electronAPI) return

    const cleanup = window.electronAPI.onTerminalData((_event, id, data) => {
      if (id === sessionId) {
        const instance = getTerminal(sessionId)
        if (instance) {
          instance.terminal.write(data)
        }
      }
    })

    return cleanup
  }, [sessionId, getTerminal])

  // 监听连接状态变化（显示连接错误信息 + 连接成功后 resize）
  useEffect(() => {
    if (!window.electronAPI) return

    const cleanup = window.electronAPI.onConnectionStatus((_event, data) => {
      if (data.id === sessionId) {
        const instance = getTerminal(sessionId)
        if (instance) {
          if (data.status === ConnectionStatus.CONNECTED) {
            // 连接成功后多次 fit + resize，确保终端尺寸同步到服务器
            const doFitResize = () => {
              try {
                instance.fitAddon.fit()
                const cols = instance.terminal.cols
                const rows = instance.terminal.rows
                if (cols && rows) {
                  window.electronAPI?.terminalResize(sessionId, cols, rows)
                }
              } catch {
                // 忽略错误
              }
            }
            // SSH channel 可能还没完全准备好，多次重试确保同步
            setTimeout(doFitResize, 100)
            setTimeout(doFitResize, 500)
            setTimeout(doFitResize, 1000)
            setTimeout(doFitResize, 2000)
          } else if (data.status === ConnectionStatus.ERROR) {
            // 显示 Xshell 风格的错误信息
            const sshConfig = sessionConfig?.ssh
            const host = sshConfig?.host || 'unknown'
            const port = sshConfig?.port || 22
            instance.terminal.writeln('')
            instance.terminal.writeln(`\x1b[31mCould not connect to '${host}' (port ${port}): ${data.error || 'Connection failed.'}\x1b[0m`)
            instance.terminal.writeln('')
            instance.terminal.writeln('\x1b[90mType `help\' to learn how to use LyShell prompt.\x1b[0m')
          }
        }
      }
    })

    return cleanup
  }, [sessionId, getTerminal, sessionConfig])

  // 执行搜索
  const doSearch = (direction: 'next' | 'prev') => {
    if (!searchText) return

    const searchOptions = {
      caseSensitive: caseSensitive,
      regex: useRegex,
      wholeWord: false
    }

    if (searchScope === 'current') {
      if (searchAddonRef.current) {
        if (direction === 'next') {
          searchAddonRef.current.findNext(searchText, searchOptions)
        } else {
          searchAddonRef.current.findPrevious(searchText, searchOptions)
        }
      }
    } else {
      // 所有选项卡搜索
      onSearchAllTabs?.(searchText, direction)
    }
  }

  // 清除搜索高亮
  const clearSearchHighlight = () => {
    if (searchAddonRef.current) {
      // 通过搜索空字符串来清除高亮
      searchAddonRef.current.clearDecorations()
    }
  }

  // 搜索按钮点击
  const handleSearchClick = (direction: 'next' | 'prev') => {
    setSearchDirection(direction)
    doSearch(direction)
  }

  // 关闭搜索框
  const closeSearch = () => {
    setShowSearch(false)
    setSearchText('')
    if (clearOnClose) {
      clearSearchHighlight()
    }
  }

  // 开始拖动
  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault()
    setIsDragging(true)
    dragStartPos.current = {
      x: e.clientX - searchBoxPos.x,
      y: e.clientY - searchBoxPos.y
    }
  }

  // 拖动中
  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      setSearchBoxPos({
        x: e.clientX - dragStartPos.current.x,
        y: e.clientY - dragStartPos.current.y
      })
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
  }, [isDragging])

  // 输入变化时自动搜索
  const handleSearchChange = (text: string) => {
    setSearchText(text)
    if (highlightOnType && text && searchScope === 'current' && searchAddonRef.current) {
      // SearchAddon 会自动高亮所有匹配项
      searchAddonRef.current.findNext(text, {
        caseSensitive: caseSensitive,
        regex: useRegex,
        wholeWord: false
      })
    }
  }

  return (
    <div className="w-full h-full bg-[#0C0C0C] relative overflow-hidden">
      {/* 终端容器 */}
      <div
        ref={containerRef}
        className="w-full h-full overflow-hidden"
      />

      {/* 查找对话框 - 可拖动 */}
      {showSearch && (
        <div
          className="absolute bg-[#2D2D30] border border-[#3C3C3C] rounded shadow-lg p-4 z-50 min-w-[320px]"
          style={{
            left: searchBoxPos.x,
            top: searchBoxPos.y,
            cursor: isDragging ? 'move' : 'default'
          }}
        >
          {/* 拖动标题栏 */}
          <div
            className="flex items-center justify-between mb-3 cursor-move select-none border-b border-[#3C3C3C] pb-2"
            onMouseDown={startDrag}
          >
            <span className="text-sm text-white font-medium">在终端中查找</span>
            <button
              onClick={closeSearch}
              className="text-gray-400 hover:text-white"
            >
              ✕
            </button>
          </div>

          {/* 搜索输入 - 支持多行 */}
          <div className="mb-3">
            <textarea
              ref={searchInputRef}
              value={searchText}
              onChange={(e) => handleSearchChange(e.target.value)}
              placeholder="输入搜索内容（支持多行）..."
              autoFocus
              rows={2}
              className="w-full px-3 py-2 bg-[#3C3C3C] border border-[#555] rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:border-[#0078D4] resize-none"
            />
          </div>

          {/* 搜索方向 */}
          <div className="flex items-center gap-2 mb-3">
            <button
              onClick={() => handleSearchClick('prev')}
              className={`flex-1 px-3 py-1.5 text-sm rounded ${
                searchDirection === 'prev'
                  ? 'bg-[#0078D4] text-white'
                  : 'bg-[#3C3C3C] text-gray-300 hover:bg-[#555]'
              }`}
            >
              ↑ 查找上一个
            </button>
            <button
              onClick={() => handleSearchClick('next')}
              className={`flex-1 px-3 py-1.5 text-sm rounded ${
                searchDirection === 'next'
                  ? 'bg-[#0078D4] text-white'
                  : 'bg-[#3C3C3C] text-gray-300 hover:bg-[#555]'
              }`}
            >
              ↓ 查找下一个
            </button>
          </div>

          {/* 搜索范围 */}
          <div className="flex items-center gap-2 mb-3">
            <button
              onClick={() => setSearchScope('current')}
              className={`flex-1 px-3 py-1.5 text-sm rounded ${
                searchScope === 'current'
                  ? 'bg-[#0078D4] text-white'
                  : 'bg-[#3C3C3C] text-gray-300 hover:bg-[#555]'
              }`}
            >
              当前选项卡
            </button>
            <button
              onClick={() => setSearchScope('all')}
              className={`flex-1 px-3 py-1.5 text-sm rounded ${
                searchScope === 'all'
                  ? 'bg-[#0078D4] text-white'
                  : 'bg-[#3C3C3C] text-gray-300 hover:bg-[#555]'
              }`}
            >
              所有选项卡
            </button>
          </div>

          {/* 搜索选项 - 两行排列 */}
          <div className="grid grid-cols-5 gap-2">
            <button
              onClick={() => setCaseSensitive(!caseSensitive)}
              className={`px-2 py-1.5 text-xs rounded text-center ${
                caseSensitive
                  ? 'bg-[#0078D4] text-white'
                  : 'bg-[#3C3C3C] text-gray-300 hover:bg-[#555]'
              }`}
              title="区分大小写"
            >
              Aa
            </button>
            <button
              onClick={() => setUseRegex(!useRegex)}
              className={`px-2 py-1.5 text-xs rounded text-center ${
                useRegex
                  ? 'bg-[#0078D4] text-white'
                  : 'bg-[#3C3C3C] text-gray-300 hover:bg-[#555]'
              }`}
              title="正则表达式"
            >
              .*
            </button>
            <button
              onClick={() => setLoopSearch(!loopSearch)}
              className={`px-2 py-1.5 text-xs rounded text-center ${
                loopSearch
                  ? 'bg-[#0078D4] text-white'
                  : 'bg-[#3C3C3C] text-gray-300 hover:bg-[#555]'
              }`}
              title="循环查找"
            >
              ↻
            </button>
            <button
              onClick={() => setHighlightOnType(!highlightOnType)}
              className={`px-2 py-1.5 text-xs rounded text-center ${
                highlightOnType
                  ? 'bg-[#0078D4] text-white'
                  : 'bg-[#3C3C3C] text-gray-300 hover:bg-[#555]'
              }`}
              title="输入时高亮"
            >
              高亮
            </button>
            <button
              onClick={() => setClearOnClose(!clearOnClose)}
              className={`px-2 py-1.5 text-xs rounded text-center ${
                clearOnClose
                  ? 'bg-[#0078D4] text-white'
                  : 'bg-[#3C3C3C] text-gray-300 hover:bg-[#555]'
              }`}
              title="关闭时清除"
            >
              清除
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default TerminalView