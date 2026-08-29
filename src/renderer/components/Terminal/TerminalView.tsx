import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import { DEFAULT_THEME_DARK, DEFAULT_THEME_LIGHT, DEFAULT_FONT_FAMILY, isCursorBlinkEnabled, DEFAULT_TERMINAL_FONT_SIZE, TERMINAL_FONT_SIZE_STEP, snapTerminalFontSize } from '@shared/constants'
import { isLightColor } from '@shared/color-utils'
import { useTerminalStore } from '../../stores/terminal-store'
import { useSessionStore } from '../../stores/session-store'
import { usePaneStore } from '../../stores/pane-store'
import { useThemeStore } from '../../stores/theme-store'
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n'
import { ConnectionStatus, type SessionConfig } from '@shared/types'
import { Unicode15Provider } from './unicode15-provider'

// 注意：本组件依赖 xterm.js 内部私有 API，无稳定性承诺，xterm 任何版本更新都可能改名或移除。
//   - IME 定位：_core、_compositionHelper、_textarea、updateCompositionElements、compositionstart
//     （升级前须人工回归中文 IME 输入）。
//   - 浮点测量：patchXtermFloatMeasure 依赖 _core._renderService._renderer.value 上的
//     WidthCache._measure / DomRenderer._setDefaultSpacing / _widthCache（升级前须人工回归滚动对齐）。
// 已验证版本：@xterm/xterm@5.5.0、@xterm/addon-fit@0.11.0、@xterm/addon-search@0.16.0。
// package.json 中已把这些包锁定到确切版本。

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
 * 解析当前主题下的 xterm 终端配色。
 * 终端画布底色取自 --terminal-bg(深色主题近黑 #0C0C0C、rack-paper 纯白 #FFFFFF);
 * 按其亮度选择深/浅配色集(DARK/LIGHT 仅 foreground/cursor/black/white 不同,ANSI 色共用),
 * 再把 background 覆写为 --terminal-bg,使终端画布与页签/审计面板的 var(--terminal-bg) 严丝合缝。
 * 主题切换时由下方 useEffect 实时调用,无需重建终端(xterm 5.5 支持 options.theme 热更新)。
 */
function resolveTerminalTheme(): ITheme {
  const bg = getComputedStyle(document.documentElement)
    .getPropertyValue('--terminal-bg')
    .trim() || '#0C0C0C'
  const base = isLightColor(bg) ? DEFAULT_THEME_LIGHT : DEFAULT_THEME_DARK
  return { ...base, background: bg }
}

/**
 * 取"连接目标"的展示信息：SSH/Telnet 用 host:port，串口用 path@baud。
 * 旧实现无条件读 sessionConfig.ssh，导致 telnet/serial 连接时误打印 "unknown:22"。
 */
function getConnectTarget(
  config: SessionConfig | undefined
): { kind: 'host'; host: string; port: number } | { kind: 'serial'; path: string; baudRate?: number } {
  switch (config?.type) {
    case 'telnet':
      return { kind: 'host', host: config.telnet?.host || 'unknown', port: config.telnet?.port || 23 }
    case 'ssh':
      return { kind: 'host', host: config.ssh?.host || 'unknown', port: config.ssh?.port || 22 }
    case 'serial':
      return { kind: 'serial', path: config.serial?.path || 'unknown', baudRate: config.serial?.baudRate }
    default:
      return { kind: 'host', host: 'unknown', port: 22 }
  }
}

/**
 * 猴补丁：让 DOM renderer 的 WidthCache 用浮点宽度测量，对齐 CharSizeService。
 * xterm 的 WidthCache._measure 用 el.offsetWidth（浏览器取整成整数）除以 32 求单字符宽，
 * 而 CharSizeService 用 canvas.measureText（浮点）求 char.width；二者的小数差
 * （约 0.006px/字符，CJK 翻倍）经 _setDefaultSpacing 转成非零的 letter-spacing 补偿，
 * 且每行/每字符残差各不相同，滚动时放大成「第一列文字漂移」（典型：claude 的 > 提示符列）。
 * 把测量换成 getBoundingClientRect().width（浮点）后两侧同源，残差归零，漂移消失。
 * 依赖 xterm 内部私有 API（WidthCache._measure / DomRenderer._setDefaultSpacing），
 * 无稳定性承诺；已锁定 @xterm/xterm@5.5.0，升级前须人工回归滚动对齐。
 */
function patchXtermFloatMeasure(terminal: Terminal): void {
  const core = (terminal as any)._core
  const renderer = core?._renderService?._renderer?.value
  const widthCache = renderer?._widthCache
  if (!widthCache) return
  const proto = Object.getPrototypeOf(widthCache) as any
  if (!proto || typeof proto._measure !== 'function' || (proto._measure as any).__lyshellFloatMeasure) {
    return
  }
  const REPEAT = 32
  proto._measure = function (this: any, c: string, variant: number): number {
    const el = this._measureElements[variant]
    el.textContent = c.repeat(REPEAT)
    return el.getBoundingClientRect().width / REPEAT
  }
  ;(proto._measure as any).__lyshellFloatMeasure = true
  // 清空旧缓存并重算 defaultSpacing，让新测量立即生效
  widthCache.clear()
  if (typeof renderer._setDefaultSpacing === 'function') {
    renderer._setDefaultSpacing()
  }
  try {
    if (terminal.rows > 0) terminal.refresh(0, terminal.rows - 1)
  } catch {
    // refresh 仅用于重绘旧内容，失败可忽略
  }
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
  const fontSize = snapTerminalFontSize(parseInt(localStorage.getItem('terminalFontSize') || String(DEFAULT_TERMINAL_FONT_SIZE)))
  const fontSizeRef = useRef(fontSize)
  const cursorBlink = isCursorBlinkEnabled()

  const { getTerminal, registerTerminal } = useTerminalStore()
  const { sessions } = useSessionStore()
  const themeId = useThemeStore(s => s.themeId)
  const session = sessions.find(s => s.id === sessionId)
  const sessionConfig = session?.config
  const blockInput = session?.lockedByMcp ?? false

  // 用 ref 让 onData / 右键粘贴回调读到最新的锁定状态：这两个回调注册在下方
  // 依赖数组不含 blockInput 的大 effect 里（terminal 创建时注册一次），闭包会捕获
  // 初始 blockInput=false；不加 ref，MCP 锁定后用户输入仍会写入 PTY。
  const blockInputRef = useRef(blockInput)
  useEffect(() => { blockInputRef.current = blockInput }, [blockInput])
  // IME 猴补丁控制器：restore 还原补丁，resetLock 解除位置锁定
  const imePatchRef = useRef<{
    restore: () => void
    resetLock: () => void
  } | null>(null)

  // 聚焦终端（仅当本 session 是其所在 pane 的活跃页签且未被隐藏时）。
  // 同一 pane 内所有 xterm 实例都保持挂载（非活跃用 visibility:hidden 隐藏），
  // 若不设守卫，多个实例会争抢焦点，导致「新建会话后无法直接输入」。
  const focusTerminalIfActive = useCallback(() => {
    const paneStore = usePaneStore.getState()
    const pane = paneId ? paneStore.getPaneById(paneId) : undefined
    const isActive = pane?.type === 'leaf' && pane.activeSessionId === sessionId && !paneStore.hiddenTabSessions[sessionId]
    if (isActive) {
      getTerminal(sessionId)?.terminal.focus()
    }
  }, [sessionId, paneId, getTerminal])

  // 初始化或获取终端实例
  useEffect(() => {
    if (!containerRef.current) return
    // ---- IME 候选框定位 ----
    // xterm 的 updateCompositionElements 会把 helper textarea 的宽度设为预编辑文本宽度，
    // caret 会跑到文本末端（光标右侧），导致 IME 候选框随拼音增长向右漂移。
    // 通过猴补丁让 xterm 原生定位 composition-view（预编辑文本），然后把 textarea
    // 压回 1px，使 caret 始终停留在光标处。同时补丁 compositionstart，在合成开始时
    // 立即强制定位（xterm 原生的 compositionstart 不会调用 updateCompositionElements，
    // textarea 会停留在 -9999em 直到第一次 compositionupdate，导致首字母漂移）。
    const patchCompositionHelper = (terminal: Terminal): { restore: () => void; resetLock: () => void } => {
      const core = (terminal as any)._core
      const helper = core?._compositionHelper
      if (!helper || typeof helper.updateCompositionElements !== 'function') {
        return { restore: () => {}, resetLock: () => {} }
      }
      const textarea = helper._textarea as HTMLTextAreaElement | undefined
      if (!textarea) return { restore: () => {}, resetLock: () => {} }

      const origUpdate = helper.updateCompositionElements.bind(helper)
      const origStart = typeof helper.compositionstart === 'function'
        ? helper.compositionstart.bind(helper) : null

      // 位置锁定：TUI 应用（Claude Code / Ink）重绘时会快速移动光标
      // （自动补全、加载动画、UI 刷新）。每次重绘触发 onRender -> updateCompositionElements，
      // 导致预编辑文本和候选框跳动。我们在 compositionstart 时保存位置，
      // 之后每次调用都恢复该位置，使预编辑文本保持不动。
      // 用户主动 resize/scroll/font-size 等场景会调用 resetLock() 重新捕获。
      let lockedLeft = ''
      let lockedTop = ''
      let lockedCvLeft = ''
      let lockedCvTop = ''
      let positionLocked = false

      const resetLock = () => {
        lockedLeft = ''
        lockedTop = ''
        lockedCvLeft = ''
        lockedCvTop = ''
        positionLocked = false
      }

      helper.updateCompositionElements = (force?: boolean) => {
        origUpdate(force)
        const cv = helper._compositionView as HTMLElement | undefined
        if (helper._isComposing) {
          if (!positionLocked) {
            lockedLeft = textarea.style.left
            lockedTop = textarea.style.top
            if (cv) { lockedCvLeft = cv.style.left; lockedCvTop = cv.style.top }
            positionLocked = true
          } else {
            textarea.style.left = lockedLeft
            textarea.style.top = lockedTop
            if (cv) { cv.style.left = lockedCvLeft; cv.style.top = lockedCvTop }
          }
        }
        textarea.style.width = '1px'
        textarea.style.height = '1px'
      }

      if (origStart) {
        helper.compositionstart = () => {
          origStart()
          resetLock()
          helper.updateCompositionElements(true)
        }
      }

      // 非合成期间 focus/click 时把 textarea 拉到光标处，避免 IME 在 -9999em 弹出。
      const onFocusSyncPosition = () => {
        if (!helper._isComposing) {
          helper.updateCompositionElements(true)
        }
      }
      textarea.addEventListener('focus', onFocusSyncPosition)

      // 用户手动滚动终端输出时，光标屏幕坐标变化，解除位置锁定让候选框跟随。
      const viewport = textarea.closest('.xterm')?.querySelector<HTMLElement>('.xterm-viewport') ?? null
      const onViewportScroll = () => resetLock()
      viewport?.addEventListener('scroll', onViewportScroll)

      return {
        restore: () => {
          helper.updateCompositionElements = origUpdate
          if (origStart) helper.compositionstart = origStart
          textarea.removeEventListener('focus', onFocusSyncPosition)
          viewport?.removeEventListener('scroll', onViewportScroll)
          // 卸载时若仍在合成中，等 compositionend 后再清空 textarea value。
          // 必须包进 setTimeout(0) 并带 !isComposing 守卫：xterm 的 compositionend
          // 监听器(先注册)只在 setTimeout(0) 里读取 textarea.value 发送最终字符，
          // 同步清空会抢在它之前把值清掉导致最后一个合成字符丢失；setTimeout(0) FIFO
          // 保证我们的清空排在 xterm 读取之后。
          if (helper._isComposing) {
            const onCompositionEnd = () => {
              setTimeout(() => {
                if (!helper._isComposing) {
                  textarea.value = ''
                }
              }, 0)
            }
            textarea.addEventListener('compositionend', onCompositionEnd, { once: true })
          }
        },
        resetLock
      }
    }

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

        // 复用终端实例时重新打 IME 猴补丁（先 restore 旧补丁再打新的，避免重复叠加）
        imePatchRef.current?.restore()
        imePatchRef.current = patchCompositionHelper(terminal)

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
        theme: resolveTerminalTheme(),
        cursorStyle: 'block',
        cursorBlink: cursorBlink,
        scrollback: scrollbackLines,
        logLevel: 'off',
        allowTransparency: false,
        // convertEol: false。设为 true 时 xterm 在每个 \n 前补 \r（归零列），
        // 修复 ConPTY 裸 \n 导致的历史输入右飘；但 raw-mode TUI(Claude Code/Ink)
        // 用 ANSI 绝对光标定位，额外 \r 会覆盖其列坐标，输出漂移更严重。
        // 保持 false，历史输入轻微右飘可接受。
        // windowsPty: 告诉 xterm 底层是 Windows ConPTY。不设时 xterm 默认按 Unix PTY 语义处理
        // resize/reflow —— ConPTY 增行时是「补空行 + 重印内容」而非「从 scrollback 上卷」，二者语义
        // 相反；缺此项会让 resize 时行被替换丢失、isWrapped 错乱，再经 reflow 把邻行错误合并/错列，
        // 表现为「首列漂移 / 文字落到上一行行尾 / 划选错位」——正是 raw-mode TUI(Claude Code/Ink)
        // 运行时的根因。backend='conpty' 触发 ConPTY 的增行语义(Buffer.resize 追加空行而非回卷)。
        // buildNumber: 设 < 21376 以关闭 xterm 内部 reflow，避免 ConPTY 与 xterm 双重重排打架；
        // 同时启用 Windows 换行启发式（末字符非空白即视为 wrapped），帮助 xterm 理解 ConPTY 的裸换行。
        // 当前 Win11 实际 >= 21376，但该版本差异仅影响 reflow 开关——设 21375 获得我们需要的关闭行为。
        windowsPty: { backend: 'conpty', buildNumber: 21375 },
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

      // 加载 Unicode 15 宽度表：按 Unicode 15.1（emoji-regex + eastasianwidth）计算
      // 宽字符/emoji 列宽，与 Claude Code / string-width 的宽度算法对齐。
      // 原 Unicode11Addon 只覆盖到 Unicode 12 的 emoji，Unicode 12+ emoji 与
      // ⚠️✌️ 等 emoji-presentation 符号会被算成 1 格，导致行内文字漂移。
      terminal.unicode.register(Unicode15Provider)
      terminal.unicode.activeVersion = '15'

      terminal.open(containerRef.current)

      // 浮点宽度测量：修复 DOM renderer 的 letter-spacing 补偿导致的第一列漂移
      patchXtermFloatMeasure(terminal)

      // 注意：此处曾尝试加载 WebglAddon 以提升渲染性能，但会导致
      // xterm 的 .xterm-helper-textarea 不再跟随光标位置同步，
      // 使输入法（IME）候选框漂到左上角或上次位置。默认 DOM renderer
      // 对当前负载性能足够，故移除 WebGL renderer。

      // IME 候选框定位：对 xterm CompositionHelper 打猴补丁
      imePatchRef.current = patchCompositionHelper(terminal)

      // 显示欢迎信息和 Xshell 风格的连接信息。
      // 用 i18n.t 单例而非 hook 的 t —— 这些是连接时一次性写入终端缓冲区的瞬态消息,
      // 不该随语言切换重跑 effect(会重复刷 banner)。用单例即不进入 effect 依赖。
      const buildDate = new Date().toISOString().split('T')[0]
      terminal.writeln(`\x1b[1;36m${i18n.t('terminal.banner')}\x1b[0m \x1b[90m${i18n.t('terminal.buildLabel', { date: buildDate })}\x1b[0m \x1b[90mby Liangyou\x1b[0m`)
      terminal.writeln('')
      if (sessionConfig?.type === 'local') {
        terminal.writeln(i18n.t('terminal.startingLocal'))
      } else {
        const target = getConnectTarget(sessionConfig)
        if (target.kind === 'serial') {
          terminal.writeln(i18n.t('terminal.connectingSerial', { path: target.path, baudRate: target.baudRate }))
        } else {
          terminal.writeln(i18n.t('terminal.connecting', { host: target.host, port: target.port }))
        }
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
          // writeText 同样可能因 document 未聚焦被拒,吞掉避免未处理 rejection
          navigator.clipboard.writeText(selection).catch(err => {
            console.warn('[TerminalView] clipboard writeText failed:', err)
          })
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
          // 新建/复用终端后自动聚焦，避免用户必须先点击才能输入
          focusTerminalIfActive()
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
          // 走 xterm 粘贴管线（terminal.paste → onData → terminalWrite）而非裸写 PTY：
          // 裸写会把剪贴板文本当按键流发给应用 —— 对开了括号粘贴模式(ESC[?2004h)的
          // raw-mode TUI(Claude Code 等)，尾部换行被当成回车，文本先插入输入框又被
          // 提交一次，表现为"粘贴两下"。paste() 会做行尾归一化并按需包 ESC[200~…201~，
          // 与 Ctrl+V 行为一致；MCP 锁定仍由 onData 里的 blockInputRef 兜底。
          const instance = getTerminal(sessionId)
          if (instance) {
            instance.terminal.paste(text)
          }
        }
      }).catch(err => {
        // 剪贴板读取失败(如 document 未聚焦时 Electron 会拒绝)——静默降级为不粘贴
        console.warn('[TerminalView] clipboard readText failed:', err)
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
      const next = snapTerminalFontSize(current + (e.deltaY < 0 ? TERMINAL_FONT_SIZE_STEP : -TERMINAL_FONT_SIZE_STEP))
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
      // container 滚动会改变光标相对视口位置，解除 IME 位置锁定以便重新捕获
      imePatchRef.current?.resetLock()
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
      // 尺寸变化当下立即解除 IME 位置锁定，避免防抖窗口内候选框仍锁在旧坐标
      imePatchRef.current?.resetLock()
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
            // 窗口 resize 后光标位置变化，解除 IME 位置锁定
            imePatchRef.current?.resetLock()
          }
        } catch {
          // 终端可能已销毁，忽略错误
        }
      }
    }

    window.addEventListener('resize', handleWindowResize)
    // 监听器统一挂到局部捕获的 container 上:cleanup 时 containerRef.current 可能已被
    // React 置空/换节点(HMR 重挂载、卸载竞态),届时 removeEventListener 会静默失败,
    // 在同一 DOM 容器上累积出重复的 contextmenu 监听 —— 表现为右键粘贴一次触发两下(dev 特有)。
    const container = containerRef.current
    container.addEventListener('contextmenu', handleContextMenu)
    container.addEventListener('mousedown', handleMouseDown)
    container.addEventListener('click', handleClick)
    // Ctrl + 滚轮缩放字号(capture + passive:false 才能 preventDefault 截住)
    container.addEventListener('wheel', handleWheel, { capture: true, passive: false })
    // 钉死 containerRef 的滚动位置,防止 IME 聚焦 textarea 触发 focus 自动滚动把终端内容左移
    container.addEventListener('scroll', handleContainerScroll)

    // 监听字体大小变化事件
    const handleFontSizeChanged = (e: CustomEvent) => {
      // 兜底吸附：无论事件来自设置面板还是 Ctrl+滚轮，终端只应用合法档位（5 的整数倍），
      // 避免任何来源把字号设置到「有问题」的非整数格宽档位。
      const next = snapTerminalFontSize(e.detail)
      fontSizeRef.current = next
      const instance = getTerminal(sessionId)
      if (instance) {
        instance.terminal.options.fontSize = next
        instance.fitAddon.fit()
        if (instance.terminal.cols && instance.terminal.rows) {
          window.electronAPI?.terminalResize(sessionId, instance.terminal.cols, instance.terminal.rows)
        }
        // 字号变化后光标位置变化，解除 IME 位置锁定
        imePatchRef.current?.resetLock()
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
      // 用 effect 挂载时捕获的 container 解绑,保证 remove 一定命中当初 add 的那个节点
      container.removeEventListener('contextmenu', handleContextMenu)
      container.removeEventListener('mousedown', handleMouseDown)
      container.removeEventListener('click', handleClick)
      container.removeEventListener('wheel', handleWheel, { capture: true })
      container.removeEventListener('scroll', handleContainerScroll)
      window.removeEventListener('terminalFontSizeChanged', handleFontSizeChanged as EventListener)
      window.removeEventListener('terminalCursorBlinkChanged', handleCursorBlinkChanged as EventListener)
      // 解绑搜索匹配计数订阅;否则切换 tab 时旧组件的回调还活在 SearchAddon 上,
      // 并且会触发已卸载组件的 setState 警告。
      resultsDisposable?.dispose()
      searchAddonRef.current = null
      // 恢复 IME 猴补丁并清理引用
      imePatchRef.current?.restore()
      imePatchRef.current = null
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

  // 主题切换时实时更新 xterm 配色 -- setTheme 已同步把 --terminal-bg 写入 :root,
  // 此处读 computed 值重选深/浅配色集并覆写 background,终端无需重建。
  useEffect(() => {
    const instance = getTerminal(sessionId)
    if (instance) {
      instance.terminal.options.theme = resolveTerminalTheme()
    }
  }, [themeId, sessionId, getTerminal])

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
            // 分屏 resize 当下立即解除 IME 位置锁定，避免防抖窗口内候选框仍锁在旧坐标
            imePatchRef.current?.resetLock()
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
            // tab 切换当下立即解除 IME 位置锁定，避免延时窗口内候选框仍锁在旧坐标
            imePatchRef.current?.resetLock()
            setTimeout(() => {
              try {
                instance.fitAddon.fit()
                const cols = instance.terminal.cols
                const rows = instance.terminal.rows
                if (cols && rows) {
                  window.electronAPI?.terminalResize(sessionId, cols, rows)
                }
                // 切换页签后自动聚焦，用户可立即输入
                focusTerminalIfActive()
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
            const target = getConnectTarget(sessionConfig)
            const errorText = data.error || i18n.t('terminal.connectionFailed')
            instance.terminal.writeln('')
            if (target.kind === 'serial') {
              instance.terminal.writeln(`\x1b[31m${i18n.t('terminal.connectFailedSerial', { path: target.path, error: errorText })}\x1b[0m`)
            } else {
              instance.terminal.writeln(`\x1b[31m${i18n.t('terminal.connectFailed', { host: target.host, port: target.port, error: errorText })}\x1b[0m`)
            }
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
    <div className="w-full h-full bg-[var(--terminal-bg)] relative overflow-hidden">
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
