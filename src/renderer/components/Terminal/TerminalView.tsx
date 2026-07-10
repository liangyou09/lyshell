import React, { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import { DEFAULT_THEME_DARK, DEFAULT_FONT_FAMILY, isCursorBlinkEnabled } from '@shared/constants'
import { useTerminalStore } from '../../stores/terminal-store'
import { useSessionStore } from '../../stores/session-store'
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n'
import { ConnectionStatus } from '@shared/types'

// 注意：本组件的 IME 定位逻辑重度依赖 xterm.js 内部私有 API（_core、_compositionHelper、
// textarea、_renderService、_bufferService 等）。这些 API 无稳定性承诺，xterm 任何版本
// 更新都可能改名或移除。已验证版本：@xterm/xterm@5.5.0、@xterm/addon-fit@0.11.0、
// @xterm/addon-search@0.16.0。package.json 中已把这些包锁定到确切版本；升级前必须
// 人工回归中文 IME 输入。

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
  const { t } = useTranslation()
  // 匹配计数:SearchAddon.onDidChangeResults 推送,resultIndex 从 0 开始;total = -1 表示超过 highlightLimit
  const [matchInfo, setMatchInfo] = useState<{ idx: number; total: number }>({ idx: -1, total: 0 })
  // 搜索面板位置 (相对容器右上角的偏移,负数表示更靠左/上)。null 表示用默认贴右上。
  const [searchPos, setSearchPos] = useState<{ x: number; y: number } | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const dragOffsetRef = useRef({ x: 0, y: 0 })
  const searchInputRef = useRef<HTMLTextAreaElement>(null)
  const scrollbackLines = parseInt(localStorage.getItem('terminalScrollback') || '10000')
  const fontSize = parseInt(localStorage.getItem('terminalFontSize') || '16')
  const fontSizeRef = useRef(fontSize)
  const cursorBlink = isCursorBlinkEnabled()

  const { getTerminal, registerTerminal } = useTerminalStore()
  const { sessions } = useSessionStore()
  const session = sessions.find(s => s.id === sessionId)
  const sessionConfig = session?.config
  const blockInput = session?.lockedByMcp ?? false

  // 用 ref 让 onData / 右键粘贴回调读到最新的锁定状态：这两个回调注册在下方
  // 依赖数组不含 blockInput 的大 effect 里（terminal 创建时注册一次），闭包会捕获
  // 初始 blockInput=false；不加 ref，MCP 锁定后用户输入仍会写入 PTY。
  const blockInputRef = useRef(blockInput)
  useEffect(() => { blockInputRef.current = blockInput }, [blockInput])

  // IME 事件回调用 ref 保持稳定引用，避免组件复用终端实例时 add/removeEventListener 对不上。
  const imeCallbacksRef = useRef<{
    sync: (() => void) | null
    compositionUpdate: (() => void) | null
    input: (() => void) | null
    keyUp: (() => void) | null
    start: (() => void) | null
    stop: (() => void) | null
    focus: (() => void) | null
    beforeInput: (() => void) | null
    keyDown: (() => void) | null
  }>({ sync: null, compositionUpdate: null, input: null, keyUp: null, start: null, stop: null, focus: null, beforeInput: null, keyDown: null })
  const imeRefs = useRef<{
    helper: HTMLTextAreaElement | null
    viewport: HTMLElement | null
    isComposing: boolean
  }>({ helper: null, viewport: null, isComposing: false })

  // 初始化或获取终端实例
  useEffect(() => {
    if (!containerRef.current) return

    // 在 effect 内固定 ref 快照，cleanup 里用它避免 react-hooks/exhaustive-deps 误报。
    const imeRefSnapshot = imeRefs.current

    // 强制注入 textarea 样式:保持透明,避免 HMR/打包后 CSS 丢失导致预编辑字母
    // 或候选框位置异常。每次 effect 都重写,保证内容和代码一致。
    const IME_STYLE_ID = 'lyshell-ime-textarea-override'
    let imeStyle = document.getElementById(IME_STYLE_ID) as HTMLStyleElement | null
    if (!imeStyle) {
      imeStyle = document.createElement('style')
      imeStyle.id = IME_STYLE_ID
      document.head.appendChild(imeStyle)
    }
    imeStyle.textContent = `
      .xterm .xterm-helper-textarea {
        opacity: 0 !important;
        color: transparent !important;
        background: transparent !important;
        transform: translateX(-100%) !important;
      }
    `

    // ---- IME 定位同步 ----
    // xterm 默认在 compositionupdate 时把 helper textarea 的 width 撑成预编辑文本宽度，
    // 并把 left 定在光标处，导致 caret 跑到拼音末尾，IME 候选框跟着向右漂移。
    // 我们在 CSS 里给 textarea 加 translateX(-100%)：xterm 把 textarea 左边缘放在光标处、
    // 宽度设为拼音宽度后，transform 把它向左平移自身宽度，于是右边缘（caret）始终对齐
    // 光标。这样 .composition-view 正常显示拼音，候选框也固定在光标位置。

    // 触发 xterm 的 updateCompositionElements，让 .composition-view(预编辑字母)
    // 同步到当前光标；CSS transform 负责把 textarea 的 caret 拉回光标。
    const syncIMEPosition = () => {
      const instance = getTerminal(sessionId)
      if (!instance) return
      const core = (instance.terminal as any)._core
      const helper = core?._compositionHelper
      if (typeof helper?.updateCompositionElements !== 'function') return
      helper.updateCompositionElements(true)
    }

    // 强制刷新:临时把 _isComposing 设为 true 以绕过 updateCompositionElements 的早返回。
    // 只在 compositionstart 用一次,防御 xterm 内部监听器执行顺序不确定导致的首次定位失败。
    const forceSyncIMEPosition = () => {
      const instance = getTerminal(sessionId)
      if (!instance) return
      const core = (instance.terminal as any)._core
      const helper = core?._compositionHelper
      if (typeof helper?.updateCompositionElements !== 'function') return
      const wasComposing = helper._isComposing
      helper._isComposing = true
      try {
        helper.updateCompositionElements(true)
      } finally {
        helper._isComposing = wasComposing
      }
    }

    // 非合成期间直接把 helper textarea 拉到当前光标，并缩成 1x1，避免遮挡点击。
    // composition 期间 xterm 会通过 updateCompositionElements 管理位置，CSS transform
    // 会自动把 textarea 的 caret 拉回光标，这里不再改动 left/top/width。
    const syncTextAreaToCursor = () => {
      if (imeRefs.current.isComposing) return
      const instance = getTerminal(sessionId)
      if (!instance) return
      const core = (instance.terminal as any)._core
      const textarea = core?.textarea as HTMLTextAreaElement | undefined
      if (!textarea || !core?._renderService || !core?._bufferService) return
      const buffer = core._bufferService.buffer
      if (!buffer.isCursorInViewport) return
      const cols = core._bufferService.cols
      const cursorX = Math.min(buffer.x, cols - 1)
      const dims = core._renderService.dimensions
      if (!dims?.css?.cell) return
      const cellWidth = dims.css.cell.width
      const cellHeight = dims.css.cell.height
      if (!cellWidth || !cellHeight) return
      textarea.style.left = `${cursorX * cellWidth}px`
      textarea.style.top = `${buffer.y * cellHeight}px`
      textarea.style.width = '1px'
      textarea.style.height = '1px'
    }

    // compositionstart: xterm 自己只把 _isComposing 置 true,不会移动 composition-view/
    // helper-textarea。这里立刻强刷一次,把候选框/预编辑字母定位到光标。
    // 注意：不要在这里清 textarea.value 或改 _compositionPosition,否则会打断 IME 的
    // composition 流程,导致拼音被直接当成普通字符发给 shell。
    const startComposition = () => {
      imeRefs.current.isComposing = true
      forceSyncIMEPosition()
    }
    const stopComposition = () => {
      imeRefs.current.isComposing = false
      // 退出合成后把 textarea 归位,避免清空输入后立即开始新合成时 IME 读到旧位置。
      syncTextAreaToCursor()
      const textarea = imeRefs.current.helper
      if (textarea) {
        // 等 xterm 自己的 setTimeout 把最终字符发出去后再清空 value,
        // 防止下一次 compositionstart 把起始位置算到旧内容后面。
        setTimeout(() => {
          if (!imeRefs.current.isComposing) {
            textarea.value = ''
          }
        }, 0)
      }
    }

    // compositionupdate / input / keyup: xterm 内部已经调用过一次 updateCompositionElements,
    // 我们再补一次,并用 requestAnimationFrame 再追一帧,覆盖 IME 在 layout commit 前就读 caret。
    const syncIMEWithRaf = () => {
      syncIMEPosition()
      requestAnimationFrame(() => {
        syncIMEPosition()
      })
    }

    // 非合成期间的兜底：focus/keydown/beforeinput/pointerdown 直接把 textarea 拉到光标。
    const onFocusSyncIME = () => syncTextAreaToCursor()
    const onBeforeInputSyncIME = () => syncTextAreaToCursor()
    const onKeyDownSyncIME = () => syncTextAreaToCursor()
    const onPointerDownSyncIME = () => syncTextAreaToCursor()
    imeCallbacksRef.current = {
      sync: syncIMEPosition,
      compositionUpdate: syncIMEWithRaf,
      input: syncIMEWithRaf,
      keyUp: syncIMEWithRaf,
      start: startComposition,
      stop: stopComposition,
      focus: onFocusSyncIME,
      beforeInput: onBeforeInputSyncIME,
      keyDown: onKeyDownSyncIME
    }

    const bindIME = (helper: HTMLTextAreaElement | null, viewport: HTMLElement | null) => {
      const { start, compositionUpdate, input, keyUp, sync, stop, focus, beforeInput, keyDown } = imeCallbacksRef.current
      if (!start || !compositionUpdate || !input || !keyUp || !sync || !stop || !focus || !beforeInput || !keyDown) return
      helper?.addEventListener('compositionstart', start)
      helper?.addEventListener('compositionupdate', compositionUpdate)
      helper?.addEventListener('compositionend', stop)
      helper?.addEventListener('focus', focus)
      helper?.addEventListener('beforeinput', beforeInput)
      helper?.addEventListener('input', input)
      helper?.addEventListener('keydown', keyDown)
      helper?.addEventListener('keyup', keyUp)
      viewport?.addEventListener('scroll', sync)
    }
    const unbindIME = (helper: HTMLTextAreaElement | null, viewport: HTMLElement | null) => {
      const { start, compositionUpdate, input, keyUp, sync, stop, focus, beforeInput, keyDown } = imeCallbacksRef.current
      if (!start || !compositionUpdate || !input || !keyUp || !sync || !stop || !focus || !beforeInput || !keyDown) return
      helper?.removeEventListener('compositionstart', start)
      helper?.removeEventListener('compositionupdate', compositionUpdate)
      helper?.removeEventListener('compositionend', stop)
      helper?.removeEventListener('focus', focus)
      helper?.removeEventListener('beforeinput', beforeInput)
      helper?.removeEventListener('input', input)
      helper?.removeEventListener('keydown', keyDown)
      helper?.removeEventListener('keyup', keyUp)
      viewport?.removeEventListener('scroll', sync)
    }
    // ----------------------

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

        // 组件复用终端时重新绑定 IME 事件（旧 listener 先解绑避免重复）
        const helperTextarea = containerRef.current.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
        const xtermViewport = containerRef.current.querySelector<HTMLElement>('.xterm-viewport')
        unbindIME(helperTextarea, xtermViewport)
        bindIME(helperTextarea, xtermViewport)
        imeRefs.current.helper = helperTextarea
        imeRefs.current.viewport = xtermViewport

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
        // 双击选词边界符:在默认 ()[]{}'" 基础上额外切分 : / @ = + 等常见符号,
        // 但保留 . - _ 不切,使 app.js / foo-bar 仍整体选中(只切到「一个单词」)。
        wordSeparator: ' ()[]{}\'"`:/@=+,;!?*|<>&%^~',
        // 必须开 proposed api,否则 SearchAddon 的 decorations 选项无法使用,
        // 而 SearchAddon 又只在传 decorations 时才 fire onDidChangeResults,
        // 不传就拿不到匹配计数(显示 "no matches")。
        allowProposedApi: true,
        disableStdin: blockInput  // 只读或 MCP 锁定时禁止键盘输入
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

      // IME 候选框定位：xterm 的 compositionstart 本身不调 updateCompositionElements,
      // textarea 默认停在 -9999em，IME 在 compositionstart 瞬间读到最左，compositionupdate
      // 时才跳到光标，表现为"左右飘"。我们在合成全生命周期持续同步，并在 resize / 滚动
      // / 标签切换等可能改变光标坐标的时机刷新。
      const helperTextarea = containerRef.current.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
      const xtermViewport = containerRef.current.querySelector<HTMLElement>('.xterm-viewport')
      bindIME(helperTextarea, xtermViewport)
      imeRefs.current.helper = helperTextarea
      imeRefs.current.viewport = xtermViewport

      // 显示欢迎信息和 Xshell 风格的连接信息。
      // 用 i18n.t 单例而非 hook 的 t —— 这些是连接时一次性写入终端缓冲区的瞬态消息,
      // 不该随语言切换重跑 effect(会重复刷 banner)。用单例即不进入 effect 依赖。
      const buildDate = new Date().toISOString().split('T')[0]
      terminal.writeln(`\x1b[1;36m${i18n.t('terminal.banner')}\x1b[0m \x1b[90m${i18n.t('terminal.buildLabel', { date: buildDate })}\x1b[0m`)
      terminal.writeln('')
      if (sessionConfig?.type === 'local') {
        terminal.writeln(i18n.t('terminal.startingLocal'))
      } else {
        const sshConfig = sessionConfig?.ssh
        const host = sshConfig?.host || 'unknown'
        const port = sshConfig?.port || 22
        terminal.writeln(i18n.t('terminal.connecting', { host, port }))
      }

      // 注册到 store
      registerTerminal(sessionId, terminal, fitAddon, searchAddon)

      // 处理用户输入（只读页签或 MCP 锁定时忽略）
      terminal.onData((data) => {
        if (blockInputRef.current) return
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

    // 右键粘贴剪贴板内容（只读页签或 MCP 锁定时忽略）
    const handleContextMenu = (e: MouseEvent) => {
      if (blockInputRef.current) return
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

    // Ctrl + 滚轮 调整字号:在 capture 阶段截断,抢在 xterm 处理之前,
    // 这样 vim/less 开了鼠标捕获时也做缩放,而不是把滚轮上报给 app。
    const handleWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      e.stopPropagation()
      const current = fontSizeRef.current
      const next = Math.max(8, Math.min(32, current + (e.deltaY < 0 ? 1 : -1)))
      if (next === current) return
      fontSizeRef.current = next
      localStorage.setItem('terminalFontSize', next.toString())
      window.dispatchEvent(new CustomEvent('terminalFontSizeChanged', { detail: next }))
    }

    // IME 合成时 .xterm-helper-textarea 被聚焦,其 nowrap 预编辑文本向右溢出会让
    // containerRef(overflow:hidden,但仍是滚动容器、可被 focus 自动滚动)的 scrollLeft
    // 被往右拨,终端内容整体左移、左侧被裁(“左边缩进去、内容不可见”)。
    // 终端内容本就不该在 containerRef 内滚动(横向不滚、纵向滚动归 .xterm-viewport),
    // 故一旦发生滚动就强制归零。设回 0 会再触发一次 scroll,但已为 0 即 no-op,无环路。
    const handleContainerScroll = () => {
      const el = containerRef.current
      if (!el) return
      if (el.scrollLeft !== 0) el.scrollLeft = 0
      if (el.scrollTop !== 0) el.scrollTop = 0
      // container 滚动会把 textarea 推离光标，合成期间立即拉回
      if (imeRefs.current.isComposing) {
        imeCallbacksRef.current.sync?.()
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

          // 合成期间光标坐标可能因 fit 改变，立刻同步 IME 位置
          if (imeRefs.current.isComposing) {
            imeCallbacksRef.current.sync?.()
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
            if (imeRefs.current.isComposing) {
              imeCallbacksRef.current.sync?.()
            }
          }
        } catch {
          // 终端可能已销毁，忽略错误
        }
      }
    }

    window.addEventListener('resize', handleWindowResize)
    containerRef.current.addEventListener('contextmenu', handleContextMenu)
    containerRef.current.addEventListener('pointerdown', onPointerDownSyncIME)
    containerRef.current.addEventListener('mousedown', handleMouseDown)
    containerRef.current.addEventListener('click', handleClick)
    // Ctrl + 滚轮缩放字号(capture + passive:false 才能 preventDefault 截住)
    containerRef.current.addEventListener('wheel', handleWheel, { capture: true, passive: false })
    // 钉死 containerRef 的滚动位置,防止 IME 聚焦 textarea 触发 focus 自动滚动把终端内容左移
    containerRef.current.addEventListener('scroll', handleContainerScroll)

    // 监听字体大小变化事件
    const handleFontSizeChanged = (e: CustomEvent) => {
      fontSizeRef.current = e.detail
      const instance = getTerminal(sessionId)
      if (instance) {
        instance.terminal.options.fontSize = e.detail
        instance.fitAddon.fit()
        if (instance.terminal.cols && instance.terminal.rows) {
          window.electronAPI?.terminalResize(sessionId, instance.terminal.cols, instance.terminal.rows)
        }
        if (imeRefs.current.isComposing) {
          imeCallbacksRef.current.sync?.()
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
      containerRef.current?.removeEventListener('pointerdown', onPointerDownSyncIME)
      containerRef.current?.removeEventListener('mousedown', handleMouseDown)
      containerRef.current?.removeEventListener('click', handleClick)
      containerRef.current?.removeEventListener('wheel', handleWheel, { capture: true })
      containerRef.current?.removeEventListener('scroll', handleContainerScroll)
      window.removeEventListener('terminalFontSizeChanged', handleFontSizeChanged as EventListener)
      window.removeEventListener('terminalCursorBlinkChanged', handleCursorBlinkChanged as EventListener)
      // 解绑搜索匹配计数订阅;否则切换 tab 时旧组件的回调还活在 SearchAddon 上,
      // 并且会触发已卸载组件的 setState 警告。
      resultsDisposable?.dispose()
      searchAddonRef.current = null
      // 解绑 IME 事件并退出合成状态
      unbindIME(imeRefSnapshot.helper, imeRefSnapshot.viewport)
      stopComposition()
      // 注意：不在这里 dispose 终端，终端实例保存在 store 中
      // 只有在 session 断开时才 dispose
    }
  }, [sessionId, getTerminal, registerTerminal])

  // 当只读/MCP 锁定状态变化时，动态更新终端 disableStdin
  useEffect(() => {
    const instance = getTerminal(sessionId)
    if (instance) {
      instance.terminal.options.disableStdin = blockInput
    }
  }, [sessionId, blockInput, getTerminal])

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
                if (imeRefs.current.isComposing) {
                  imeCallbacksRef.current.sync?.()
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
                if (imeRefs.current.isComposing) {
                  imeCallbacksRef.current.sync?.()
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
            instance.terminal.writeln(`\x1b[31m${i18n.t('terminal.connectFailed', { host, port, error: data.error || i18n.t('terminal.connectionFailed') })}\x1b[0m`)
            instance.terminal.writeln('')
            instance.terminal.writeln(`\x1b[90m${i18n.t('terminal.helpHint')}\x1b[0m`)
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
            title={t('terminal.search.dragToMove')}
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
              placeholder={t('terminal.search.placeholder')}
              autoFocus
              rows={1}
              className="flex-1 bg-transparent border-none text-white text-[15px] outline-none resize-none py-0.5 placeholder-[#9CA3AF] leading-[1.4]"
              style={{ fontFamily: 'inherit' }}
            />
            <button
              onClick={() => doSearch('prev')}
              className="w-[28px] h-[28px] grid place-items-center text-[#D1D5DB] hover:text-white hover:bg-[#555] rounded text-[15px] font-light"
              title={t('terminal.search.previous')}
            >↑</button>
            <button
              onClick={() => doSearch('next')}
              className="w-[28px] h-[28px] grid place-items-center text-[#D1D5DB] hover:text-white hover:bg-[#555] rounded text-[15px] font-light"
              title={t('terminal.search.next')}
            >↓</button>
            <button
              onClick={closeSearch}
              className="w-[28px] h-[28px] grid place-items-center text-[#9CA3AF] hover:text-[#FF6A3D] hover:bg-[#555] rounded text-[15px]"
              title={t('terminal.search.close')}
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
                title={t('terminal.search.matchCase')}
              >Aa</button>
              <button
                onClick={() => setUseRegex(!useRegex)}
                className={`px-3 py-2 text-[14px] ${
                  useRegex ? 'text-[#5AA8FF]' : 'text-[#D1D5DB] hover:text-white'
                }`}
                title={t('terminal.search.regex')}
              >.*</button>
              <button
                onClick={() => setWholeWord(!wholeWord)}
                className={`px-3 py-2 text-[14px] ${
                  wholeWord ? 'text-[#5AA8FF]' : 'text-[#D1D5DB] hover:text-white'
                }`}
                title={t('terminal.search.wholeWord')}
              >word</button>
            </div>

            {/* 中:匹配计数 (两侧分隔线,无内容时只显示横线占位) */}
            <div className="flex items-center h-full border-x border-[#555]">
              <span className="px-4 text-[14px] tabular-nums whitespace-nowrap min-w-[100px] text-center">
                {searchScope === 'all'
                  ? <span className="text-[#6B7280]" title={t('terminal.search.allTabsNoCount')}>—</span>
                  : searchText
                    ? matchInfo.total === -1
                      ? <span className="text-[#E0A458] font-medium">{t('terminal.search.matchesOverLimit')}</span>
                      : matchInfo.total === 0
                        ? <span className="text-[#9CA3AF]">{t('terminal.search.noMatches')}</span>
                        : <><span className="text-white font-medium">{matchInfo.idx + 1}</span><span className="text-[#9CA3AF]"> / {matchInfo.total}</span></>
                    : <span className="text-[#6B7280]">—</span>}
              </span>
            </div>

            {/* 右:范围切换 - 同左侧一致的 underline 开关 */}
            <div className="flex items-center justify-end pr-2">
              <span className="text-[14px] text-[#9CA3AF] mr-1">{t('terminal.search.scopeLabel')}</span>
              <button
                onClick={() => setSearchScope('current')}
                className={`px-2.5 py-2 text-[14px] ${
                  searchScope === 'current' ? 'text-[#5AA8FF]' : 'text-[#D1D5DB] hover:text-white'
                }`}
                title={t('terminal.search.searchThisTab')}
              >{t('terminal.search.scopeCurrent')}</button>
              <button
                onClick={() => setSearchScope('all')}
                className={`px-2.5 py-2 text-[14px] ${
                  searchScope === 'all' ? 'text-[#5AA8FF]' : 'text-[#D1D5DB] hover:text-white'
                }`}
                title={t('terminal.search.searchAllTabs')}
              >{t('terminal.search.scopeAll')}</button>
            </div>
          </div>

          {/* 第三行:快捷键提示 */}
          <div className="flex gap-4 px-3 py-2 text-[12px] text-[#9CA3AF]">
            <span><kbd className="border border-[#6B7280] text-[#D1D5DB] px-1.5 rounded text-[11px] mr-1">↵</kbd>{t('terminal.search.hintNext')}</span>
            <span><kbd className="border border-[#6B7280] text-[#D1D5DB] px-1.5 rounded text-[11px] mr-1">⇧↵</kbd>{t('terminal.search.hintPrev')}</span>
            <span><kbd className="border border-[#6B7280] text-[#D1D5DB] px-1.5 rounded text-[11px] mr-1">⌥A</kbd>{t('terminal.search.hintScope')}</span>
            <span><kbd className="border border-[#6B7280] text-[#D1D5DB] px-1.5 rounded text-[11px] mr-1">esc</kbd>{t('terminal.search.hintClose')}</span>
          </div>
        </div>
      )}
    </div>
  )
}

export default TerminalView