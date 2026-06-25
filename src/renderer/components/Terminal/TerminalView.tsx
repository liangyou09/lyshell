import React, { useEffect, useRef, useState } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import { SearchAddon } from 'xterm-addon-search'
import 'xterm/css/xterm.css'
import { DEFAULT_THEME_DARK, DEFAULT_FONT_FAMILY, isCursorBlinkEnabled } from '@shared/constants'
import { useTerminalStore } from '../../stores/terminal-store'
import { useSessionStore } from '../../stores/session-store'
import { ConnectionStatus } from '@shared/types'

interface TerminalViewProps {
  sessionId: string
  paneId?: string
  onSearchAllTabs?: (text: string, direction: 'next' | 'prev') => void
}

// SearchAddon 装饰配置:必传 matchOverviewRuler。
// 没有它,SearchAddon 既不画高亮也不 fire onDidChangeResults,匹配计数永远是 0。
// 配色策略:
//   - 非活动匹配:只画边框 + 滚动条 ruler 小竖线,不涂 background。
//     原因:decoration 是 DOM 覆盖层、改不了底层字色,任何 background 都会出现
//     "黄底白字"读不清(终端字色固定是浅灰 #CCCCCC)。
//     退而求其次,边框仍能勾出每条匹配的位置,搭配 ruler 不丢失全局感知。
//   - 活动命中及一般鼠标划选:共用 DEFAULT_THEME_DARK 的 selection 值(黄底黑字)。
const SEARCH_DECORATIONS = {
  matchBorder: '#EAC54F',
  matchOverviewRuler: '#EAC54F',
  activeMatchColorOverviewRuler: '#FFD166'
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
  const [showSearch, setShowSearch] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [searchScope, setSearchScope] = useState<'current' | 'all'>('current')
  const [useRegex, setUseRegex] = useState(false)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  // 匹配计数:SearchAddon.onDidChangeResults 推送,resultIndex 从 0 开始;total = -1 表示超过 highlightLimit
  const [matchInfo, setMatchInfo] = useState<{ idx: number; total: number }>({ idx: -1, total: 0 })
  // 搜索面板位置 (相对容器右上角的偏移,负数表示更靠左/上)。null 表示用默认贴右上。
  const [searchPos, setSearchPos] = useState<{ x: number; y: number } | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const dragOffsetRef = useRef({ x: 0, y: 0 })
  const searchInputRef = useRef<HTMLTextAreaElement>(null)
  const scrollbackLines = parseInt(localStorage.getItem('terminalScrollback') || '10000')
  const fontSize = parseInt(localStorage.getItem('terminalFontSize') || '16')
  const cursorBlink = isCursorBlinkEnabled()

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
        convertEol: true,  // 正确处理换行和回显
        // 必须开 proposed api,否则 SearchAddon 的 decorations 选项无法使用,
        // 而 SearchAddon 又只在传 decorations 时才 fire onDidChangeResults,
        // 不传就拿不到匹配计数(显示 "no matches")。
        allowProposedApi: true
      })

      fitAddon = new FitAddon()
      terminal.loadAddon(fitAddon)

      // 加载 SearchAddon
      const searchAddon = new SearchAddon()
      terminal.loadAddon(searchAddon)

      terminal.open(containerRef.current)

      // 注意：此处曾尝试加载 WebglAddon 以提升渲染性能，但会导致
      // xterm 的 .xterm-helper-textarea 不再跟随光标位置同步，
      // 使输入法（IME）候选框漂到左上角或上次位置。默认 DOM renderer
      // 对当前负载性能足够，故移除 WebGL renderer。

      // 修复 IME 候选框漂出右边缘的问题：
      // xterm CompositionHelper.updateCompositionElements() 同步把 .xterm-helper-textarea
      // 的 left/width 设为预编辑文本的渲染尺寸，caret 位于文本末尾。Chromium/IMM 以 caret 屏幕
      // 坐标定位候选框，因此拼音越长 caret 越靠右；在窄分屏 / 行尾输入时会冲出可视区。
      // 解决：compositionupdate 之后同步把右边缘收回到容器内，且用下限避免冲出左边。
      const helperTextarea = containerRef.current.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
      if (helperTextarea) {
        // 仅在右边缘溢出容器时纠正，避免覆盖 xterm 正常的光标跟随定位
        helperTextarea.addEventListener('compositionupdate', () => {
          const container = containerRef.current
          if (!container) return
          const containerRect = container.getBoundingClientRect()
          const taRect = helperTextarea.getBoundingClientRect()
          const overflow = taRect.right - containerRect.right
          if (overflow > 0) {
            const targetLeft = Math.max(containerRect.right - 4 - taRect.width, 0)
            helperTextarea.style.left = `${targetLeft}px`
          }
        })
      }

      // 显示欢迎信息和 Xshell 风格的连接信息
      const buildDate = new Date().toISOString().split('T')[0]
      terminal.writeln(`\x1b[1;36mLyShell v1.0.2\x1b[0m \x1b[90mBuild: ${buildDate}\x1b[0m`)
      terminal.writeln('')
      if (sessionConfig?.type === 'local') {
        terminal.writeln('Starting local terminal...')
      } else {
        const sshConfig = sessionConfig?.ssh
        const host = sshConfig?.host || 'unknown'
        const port = sshConfig?.port || 22
        terminal.writeln(`Connecting to ${host}:${port}...`)
      }

      // 注册到 store
      registerTerminal(sessionId, terminal, fitAddon, searchAddon)

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

    // 把 searchAddon 同步到 ref:无论是新建还是复用终端,都必须拿到搜索器,
    // 否则搜索框打开了但 findNext/clearDecorations 全打在 null 上。
    // 订阅匹配计数(显示 "3/5");返回的 disposable 在清理函数里 dispose,
    // 防止同一 SearchAddon 被多次挂载时回调叠加并保留旧组件的 setMatchInfo。
    const currentInstance = getTerminal(sessionId)
    let resultsDisposable: { dispose: () => void } | null = null
    if (currentInstance?.searchAddon) {
      searchAddonRef.current = currentInstance.searchAddon
      resultsDisposable = currentInstance.searchAddon.onDidChangeResults(({ resultIndex, resultCount }) => {
        setMatchInfo({ idx: resultIndex, total: resultCount })
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

    // 鼠标滚轮点击(中键)打开查找
    const handleMouseDown = (e: MouseEvent) => {
      if (e.button === 1) {
        e.preventDefault()
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
      // 解绑搜索匹配计数订阅;否则切换 tab 时旧组件的回调还活在 SearchAddon 上,
      // 并且会触发已卸载组件的 setState 警告。
      resultsDisposable?.dispose()
      searchAddonRef.current = null
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
        setShowSearch(true)
        // 唤出后聚焦输入框,选中已有文本方便重新键入
        setTimeout(() => {
          searchInputRef.current?.focus()
          searchInputRef.current?.select()
        }, 0)
      }
      if (e.key === 'Escape' && showSearch) {
        setShowSearch(false)
        // 关闭时永远清掉装饰,避免遗留高亮干扰阅读
        searchAddonRef.current?.clearDecorations()
      }
    }

    // 使用 capture 模式确保在其他处理器之前捕获
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [showSearch])

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

  // 监听终端数据（带缓冲，防止 xterm 未就绪时丢失数据）
  useEffect(() => {
    if (!window.electronAPI) return

    let pendingData: string = ''
    let flushTimer: ReturnType<typeof setTimeout> | null = null

    const flushPending = () => {
      flushTimer = null
      const instance = getTerminal(sessionId)
      if (instance && pendingData) {
        instance.terminal.write(pendingData)
        pendingData = ''
      } else if (pendingData) {
        // terminal 还没创建，等下一次 flush
        flushTimer = setTimeout(flushPending, 50)
      }
    }

    const cleanup = window.electronAPI.onTerminalData((id, data) => {
      if (id === sessionId) {
        const instance = getTerminal(sessionId)
        if (instance) {
          instance.terminal.write(data)
        } else {
          // terminal 未就绪，缓冲数据
          pendingData += data
          if (!flushTimer) {
            flushTimer = setTimeout(flushPending, 50)
          }
        }
      }
    })

    return () => {
      if (flushTimer) clearTimeout(flushTimer)
      cleanup()
    }
  }, [sessionId, getTerminal])

  // 监听连接状态变化（显示连接错误信息 + 连接成功后 resize）
  useEffect(() => {
    if (!window.electronAPI) return

    const cleanup = window.electronAPI.onConnectionStatus((data) => {
      if (data.id === sessionId) {
        const instance = getTerminal(sessionId)
        if (instance) {
          if (data.status === ConnectionStatus.CONNECTED) {
            if (sessionConfig?.type === 'local') {
              // 本地终端：pending resize 机制已在 connectSession 中处理，无需额外 fit
            } else {
              // SSH channel 可能还没完全准备好，多次重试确保同步
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
              setTimeout(doFitResize, 100)
              setTimeout(doFitResize, 500)
              setTimeout(doFitResize, 1000)
              setTimeout(doFitResize, 2000)
            }
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
      caseSensitive,
      regex: useRegex,
      wholeWord,
      decorations: SEARCH_DECORATIONS
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

  // 关闭搜索框:始终清掉装饰,避免残留高亮干扰阅读
  const closeSearch = () => {
    setShowSearch(false)
    searchAddonRef.current?.clearDecorations()
  }

  // 输入变化时自动搜索(永远开启 — 这是搜索框该有的行为)
  const handleSearchChange = (text: string) => {
    setSearchText(text)
    if (!text) {
      // 清空时立即清掉高亮,匹配计数也归零
      searchAddonRef.current?.clearDecorations()
      setMatchInfo({ idx: -1, total: 0 })
      return
    }
    if (searchScope === 'current' && searchAddonRef.current) {
      searchAddonRef.current.findNext(text, {
        caseSensitive,
        regex: useRegex,
        wholeWord,
        decorations: SEARCH_DECORATIONS
      })
    }
  }

  // 输入框键盘:Enter=next, Shift+Enter=prev, Esc=close, Alt+A=切换 scope
  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      doSearch(e.shiftKey ? 'prev' : 'next')
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closeSearch()
    } else if (e.altKey && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault()
      setSearchScope(prev => prev === 'current' ? 'all' : 'current')
    }
  }

  // 切换搜索范围时同步当前标签的搜索状态:
  // 切到 all —— 清掉 current 留下的高亮与计数,避免显示过时的单标签结果;
  // 切回 current —— 若已有搜索词,重新 findNext 恢复高亮与计数。
  useEffect(() => {
    if (searchScope === 'all') {
      searchAddonRef.current?.clearDecorations()
      setMatchInfo({ idx: -1, total: 0 })
    } else if (searchText && searchAddonRef.current) {
      searchAddonRef.current.findNext(searchText, {
        caseSensitive,
        regex: useRegex,
        wholeWord,
        decorations: SEARCH_DECORATIONS
      })
    }
  }, [searchScope])

  // 拖动开始:按下顶栏时记录指针在面板内的偏移
  const startDrag = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const panel = (e.currentTarget as HTMLElement).closest('[data-search-panel]') as HTMLElement | null
    const container = containerRef.current
    if (!panel || !container) return
    const panelRect = panel.getBoundingClientRect()
    dragOffsetRef.current = {
      x: e.clientX - panelRect.left,
      y: e.clientY - panelRect.top
    }
    setIsDragging(true)
  }

  // 拖动中:把指针位置换算成容器坐标系,并夹在容器范围内
  useEffect(() => {
    if (!isDragging) return
    const SEARCH_W = 420

    const handleMove = (e: MouseEvent) => {
      const container = containerRef.current
      if (!container) return
      const cRect = container.getBoundingClientRect()
      let x = e.clientX - cRect.left - dragOffsetRef.current.x
      let y = e.clientY - cRect.top - dragOffsetRef.current.y
      // 夹边:保证至少有顶栏可见可拖回来
      x = Math.max(0, Math.min(x, cRect.width - SEARCH_W))
      y = Math.max(0, Math.min(y, cRect.height - 32))
      setSearchPos({ x, y })
    }
    const handleUp = () => setIsDragging(false)

    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [isDragging])

  return (
    <div className="w-full h-full bg-[#0C0C0C] relative overflow-hidden">
      {/* 终端容器 */}
      <div
        ref={containerRef}
        className="w-full h-full overflow-hidden"
      />

      {/* 查找面板 - 默认贴右上,可拖动 */}
      {showSearch && (
        <div
          data-search-panel
          className="absolute z-50 w-[420px] bg-[#2D2D30] border border-[#555] shadow-2xl"
          style={
            searchPos
              ? { left: searchPos.x, top: searchPos.y }
              : { right: 12, top: 8 }
          }
        >
          {/* 拖动条:窄,左侧 ⌕ 图标兼做"拖把手"暗示 */}
          <div
            onMouseDown={startDrag}
            className={`flex items-center gap-2 px-3 h-[10px] border-b border-[#555] bg-[#3C3C3C] ${isDragging ? 'cursor-grabbing' : 'cursor-grab'} select-none`}
            title="Drag to move"
          >
            <div className="flex gap-[3px]">
              <span className="w-[3px] h-[3px] bg-[#9CA3AF] rounded-full" />
              <span className="w-[3px] h-[3px] bg-[#9CA3AF] rounded-full" />
              <span className="w-[3px] h-[3px] bg-[#9CA3AF] rounded-full" />
            </div>
          </div>

          {/* 第一行:输入 + 上一个/下一个 + 关闭 (计数挪到第二行) */}
          <div className="flex items-center gap-2 px-3 py-2.5 border-b border-[#555]">
            <span className="text-[#D1D5DB] text-center text-[16px] select-none">⌕</span>
            <textarea
              ref={searchInputRef}
              value={searchText}
              onChange={(e) => handleSearchChange(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder="search…"
              autoFocus
              rows={1}
              className="flex-1 bg-transparent border-none text-white text-[15px] outline-none resize-none py-0.5 placeholder-[#9CA3AF] leading-[1.4]"
              style={{ fontFamily: 'inherit' }}
            />
            <button
              onClick={() => doSearch('prev')}
              className="w-[28px] h-[28px] grid place-items-center text-[#D1D5DB] hover:text-white hover:bg-[#555] rounded text-[15px] font-light"
              title="Previous (Shift+Enter)"
            >↑</button>
            <button
              onClick={() => doSearch('next')}
              className="w-[28px] h-[28px] grid place-items-center text-[#D1D5DB] hover:text-white hover:bg-[#555] rounded text-[15px] font-light"
              title="Next (Enter)"
            >↓</button>
            <button
              onClick={closeSearch}
              className="w-[28px] h-[28px] grid place-items-center text-[#9CA3AF] hover:text-[#FF6A3D] hover:bg-[#555] rounded text-[15px]"
              title="Close (Esc)"
            >✕</button>
          </div>

          {/* 第二行:开关 | 匹配计数 | 范围 (三段式,中间填充) */}
          <div className="grid items-center border-b border-[#555]" style={{ gridTemplateColumns: '1fr auto 1fr' }}>
            {/* 左:开关 */}
            <div className="flex items-center pl-2">
              <button
                onClick={() => setCaseSensitive(!caseSensitive)}
                className={`px-3 py-2 text-[14px] ${
                  caseSensitive ? 'text-[#5AA8FF]' : 'text-[#D1D5DB] hover:text-white'
                }`}
                title="Match case"
              >Aa</button>
              <button
                onClick={() => setUseRegex(!useRegex)}
                className={`px-3 py-2 text-[14px] ${
                  useRegex ? 'text-[#5AA8FF]' : 'text-[#D1D5DB] hover:text-white'
                }`}
                title="Regular expression"
              >.*</button>
              <button
                onClick={() => setWholeWord(!wholeWord)}
                className={`px-3 py-2 text-[14px] ${
                  wholeWord ? 'text-[#5AA8FF]' : 'text-[#D1D5DB] hover:text-white'
                }`}
                title="Whole word"
              >word</button>
            </div>

            {/* 中:匹配计数 (两侧分隔线,无内容时只显示横线占位) */}
            <div className="flex items-center h-full border-x border-[#555]">
              <span className="px-4 text-[14px] tabular-nums whitespace-nowrap min-w-[100px] text-center">
                {searchScope === 'all'
                  ? <span className="text-[#6B7280]" title="跨标签搜索时不显示单标签计数">—</span>
                  : searchText
                    ? matchInfo.total === -1
                      ? <span className="text-[#E0A458] font-medium">1k+ matches</span>
                      : matchInfo.total === 0
                        ? <span className="text-[#9CA3AF]">no matches</span>
                        : <><span className="text-white font-medium">{matchInfo.idx + 1}</span><span className="text-[#9CA3AF]"> / {matchInfo.total}</span></>
                    : <span className="text-[#6B7280]">—</span>}
              </span>
            </div>

            {/* 右:范围切换 - 同左侧一致的 underline 开关 */}
            <div className="flex items-center justify-end pr-2">
              <span className="text-[14px] text-[#9CA3AF] mr-1">scope:</span>
              <button
                onClick={() => setSearchScope('current')}
                className={`px-2.5 py-2 text-[14px] ${
                  searchScope === 'current' ? 'text-[#5AA8FF]' : 'text-[#D1D5DB] hover:text-white'
                }`}
                title="Search this tab (Alt+A)"
              >Tab</button>
              <button
                onClick={() => setSearchScope('all')}
                className={`px-2.5 py-2 text-[14px] ${
                  searchScope === 'all' ? 'text-[#5AA8FF]' : 'text-[#D1D5DB] hover:text-white'
                }`}
                title="Search all tabs (Alt+A)"
              >All</button>
            </div>
          </div>

          {/* 第三行:快捷键提示 */}
          <div className="flex gap-4 px-3 py-2 text-[12px] text-[#9CA3AF]">
            <span><kbd className="border border-[#6B7280] text-[#D1D5DB] px-1.5 rounded text-[11px] mr-1">↵</kbd>next</span>
            <span><kbd className="border border-[#6B7280] text-[#D1D5DB] px-1.5 rounded text-[11px] mr-1">⇧↵</kbd>prev</span>
            <span><kbd className="border border-[#6B7280] text-[#D1D5DB] px-1.5 rounded text-[11px] mr-1">⌥A</kbd>scope</span>
            <span><kbd className="border border-[#6B7280] text-[#D1D5DB] px-1.5 rounded text-[11px] mr-1">esc</kbd>close</span>
          </div>
        </div>
      )}
    </div>
  )
}

export default TerminalView