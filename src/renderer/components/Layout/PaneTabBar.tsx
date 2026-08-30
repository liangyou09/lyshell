import React, { useEffect, useRef, useState } from 'react'
import cn from 'classnames'
import { useTranslation } from 'react-i18next'
import { useSessionStore } from '../../stores/session-store'
import { usePaneStore } from '../../stores/pane-store'
import { setDraggingSessionId as setGlobalDraggingId } from './SplitPaneContainer'
import { harnessKindFromTags, type HarnessAgentKind } from '@shared/harness'
import DeepSeekWhaleIcon from './DeepSeekWhaleIcon'
import type { PaneLeaf } from '@shared/types'
import { TOPBAR_HEIGHT } from './topbar-metrics'

// codex/claude 品牌标资产 —— 与 ActivityRail 左轨同源（assets/agent-icons/*.png），
// mask 取资产 alpha 作剪影、bg-current 随页签文字色着色（空闲 dim / 激活亮）
const codexMarkIcon = new URL('../../assets/agent-icons/codex.png', import.meta.url).href
const claudeMarkIcon = new URL('../../assets/agent-icons/claude.png', import.meta.url).href

// 暗色灰阶图标判定:整体很暗的黑白标(GitHub 黑猫标是典型)在深色页签上不可辨。
// data URI 画到 16x16 canvas(不污染画布,可 getImageData),取不透明像素的平均亮度
// (HSL 的 L)与平均饱和度(max-min):亮度低且接近灰阶 → 判暗,交 CSS 按主题反转。
// 彩色暗标(深蓝/深紫 logo)不反转——invert 会把品牌色翻成怪色,宁可保持原样。
// 结果按 src 缓存,同一 data URI 只分析一次。
const darkIconCache = new Map<string, boolean>()
function isDarkGrayscaleIcon(src: string): Promise<boolean> {
  const cached = darkIconCache.get(src)
  if (cached !== undefined) return Promise.resolve(cached)
  const p = new Promise<boolean>(resolve => {
    const img = new Image()
    img.onload = () => {
      try {
        const size = 16
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) return resolve(false)
        ctx.drawImage(img, 0, 0, size, size)
        const data = ctx.getImageData(0, 0, size, size).data
        let lSum = 0
        let sSum = 0
        let n = 0
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 128) continue
          const r = data[i]
          const g = data[i + 1]
          const b = data[i + 2]
          const max = Math.max(r, g, b)
          const min = Math.min(r, g, b)
          lSum += (max + min) / 2
          sSum += max - min
          n++
        }
        // 无不透明像素(全透明图)或亮/彩不判暗
        resolve(n > 0 && lSum / n < 64 && sSum / n < 48)
      } catch {
        resolve(false)
      }
    }
    img.onerror = () => resolve(false)
    img.src = src
  })
  void p.then(v => darkIconCache.set(src, v))
  return p
}

/**
 * 网页页签 favicon —— data URI 由主进程代取（渲染层 CSP img-src 仅 'self' data:，
 * 远程图直挂 <img> 会被拦）。坏数据 onError 整块隐藏，页签回落纯文字；暗色灰阶标
 * 挂 .webtab-favicon-dark 由 CSS 按主题反转（浅色主题不反转）。
 * key 绑 src：favicon 更新时重挂组件清掉 broken/dark 态。
 */
export const WebTabFavicon: React.FC<{ src: string }> = ({ src }) => {
  const [broken, setBroken] = useState(false)
  const [dark, setDark] = useState(false)
  useEffect(() => {
    let alive = true
    void isDarkGrayscaleIcon(src).then(d => {
      if (alive) setDark(d)
    })
    return () => {
      alive = false
    }
  }, [src])
  if (broken) return null
  return (
    <img
      src={src}
      alt=""
      draggable={false}
      onError={() => setBroken(true)}
      className={cn(
        'w-[14px] h-[14px] flex-shrink-0 rounded-[2px] object-contain',
        dark && 'webtab-favicon-dark'
      )}
    />
  )
}

/**
 * harness 会话页签的品牌小标 —— 页签名左侧 13px 标识启动来源面板：
 * dsh 鲸鱼（currentColor 线稿）/ codex 花朵・claude 太阳花（mask 剪影）。
 * 悬停 tooltip 显示来源面板名（nav.dsh / nav.codex / nav.claude）。
 */
const HarnessKindMark: React.FC<{ kind: HarnessAgentKind | null }> = ({ kind }) => {
  const { t } = useTranslation()
  if (!kind) return null
  if (kind === 'dsh') {
    return (
      <span
        aria-hidden
        data-harness-mark={kind}
        title={t(`nav.${kind}`)}
        className="w-[13px] h-[13px] inline-flex flex-shrink-0"
      >
        <DeepSeekWhaleIcon className="w-full h-full" />
      </span>
    )
  }
  const src = kind === 'codex' ? codexMarkIcon : claudeMarkIcon
  return (
    <span
      aria-hidden
      data-harness-mark={kind}
      title={t(`nav.${kind}`)}
      className="w-[13px] h-[13px] inline-flex flex-shrink-0 bg-current"
      style={{
        maskImage: `url(${src})`,
        WebkitMaskImage: `url(${src})`,
        maskSize: 'contain',
        WebkitMaskSize: 'contain',
        maskPosition: 'center',
        WebkitMaskPosition: 'center',
        maskRepeat: 'no-repeat',
        WebkitMaskRepeat: 'no-repeat'
      }}
    />
  )
}

interface PaneTabBarProps {
  pane: PaneLeaf
  /** 处于窗口第一行(顶排 pane) -- 根容器启用窗口拖拽区;无页签时也渲染等高空条承载拖拽区 */
  isTop?: boolean
  /** 第一行最左 pane -- 左侧为侧栏开关 pill 留白(var(--top-left-reserve):收起 32px / 展开 0,MainWindow 发布) */
  isTopLeft?: boolean
  /** 第一行最右 pane -- 右侧为控制簇留白(--top-right-reserve,由 TopRightControls 实测发布) */
  isTopRight?: boolean
}

/**
 * 分屏内的标签栏组件 - 显示该分屏内的会话标签
 */
const PaneTabBar: React.FC<PaneTabBarProps> = ({ pane, isTop, isTopLeft, isTopRight }) => {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [draggingSessionId, setDraggingSessionIdLocal] = useState<string | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)  // 悬停位置索引
  const [dragOverWebTab, setDragOverWebTab] = useState(false)  // 会话悬停在 web 页签上（排序落点指示）
  const sessions = useSessionStore(s => s.sessions)
  const removeLiveSession = useSessionStore(s => s.removeLiveSession)
  // 逐字段 selector 订阅：本组件不读 layout 树（pane 由 prop 传入），整体解构会让无关的
  // pane-store 写入（拖分屏比例的高频 setSplitRatio、其它 pane 的布局变更）也触发所有
  // 页签条重渲染。action 引用在 create 时即固定，选中它们零成本。
  // 注意该结论只对"不消费 layout"的组件成立 —— PaneView 等真依赖布局的组件另论
  const setActiveSessionInPane = usePaneStore(s => s.setActiveSessionInPane)
  const removeSessionFromPane = usePaneStore(s => s.removeSessionFromPane)
  const addSessionToPane = usePaneStore(s => s.addSessionToPane)
  const reorderSessionsInPane = usePaneStore(s => s.reorderSessionsInPane)
  const toggleLiveSessionTabs = usePaneStore(s => s.toggleLiveSessionTabs)
  const setDraggingDshWeb = usePaneStore(s => s.setDraggingDshWeb)
  const setDshWebTabIndex = usePaneStore(s => s.setDshWebTabIndex)
  const mcpAuditPaneId = usePaneStore(s => s.mcpAuditPaneId)
  const mcpAuditActive = usePaneStore(s => s.mcpAuditActive)
  const dshWeb = usePaneStore(s => s.dshWeb)
  const dshWebPaneId = usePaneStore(s => s.dshWebPaneId)
  const dshWebActive = usePaneStore(s => s.dshWebActive)
  const dshWebTabIndex = usePaneStore(s => s.dshWebTabIndex)
  const draggingDshWeb = usePaneStore(s => s.draggingDshWeb)
  const webTabs = usePaneStore(s => s.webTabs)
  const docTabs = usePaneStore(s => s.docTabs)
  // 本 pane 的网页访问栏页签（多开）；激活态判定用于会话页签高亮互斥
  const paneWebTabs = webTabs.filter(t => t.paneId === pane.id)
  const webTabActiveHere = paneWebTabs.some(t => t.active)
  // 本 pane 的文档页签（多开）；激活态判定同上
  const paneDocTabs = docTabs.filter(t => t.paneId === pane.id)
  const docTabActiveHere = paneDocTabs.some(t => t.active)
  const { t } = useTranslation()
  // 被隐藏的页签(Sidebar LIVE 段会话标签点击 toggle)——不渲染对应页签,但终端实例保留
  const hiddenTabSessions = usePaneStore(s => s.hiddenTabSessions)

  // 防止重复双击
  const isCloning = useRef(false)

  // 获取该分屏内的会话（按照 pane.sessions 的顺序）；被隐藏的页签不显示
  const paneSessions = pane.sessions
    .map(sessionId => sessions.find(s => s.id === sessionId))
    .filter((s): s is typeof sessions[0] => s !== undefined)
    .filter(s => !hiddenTabSessions[s.id])

  // 获取所有分屏内的活跃会话（用于全局编号计算，只统计活跃的）
  const allPaneSessions = sessions.filter(s =>
    (s.status === 'connected' || s.status === 'connecting')
  )

  // 滚动到选中的标签
  const scrollToTab = (tabId: string) => {
    const container = scrollRef.current
    if (!container) return

    const tabElement = container.querySelector(`[data-tab-id="${tabId}"]`)
    if (tabElement) {
      const containerWidth = container.clientWidth
      const tabLeft = tabElement.getBoundingClientRect().left - container.getBoundingClientRect().left
      const tabWidth = tabElement.clientWidth

      if (tabLeft < 0) {
        container.scrollLeft += tabLeft
      } else if (tabLeft + tabWidth > containerWidth) {
        container.scrollLeft += tabLeft + tabWidth - containerWidth
      }
    }
  }

  // 点击标签时切换会话
  const handleTabClick = (sessionId: string) => {
    // 切到 session 页签前隐藏本 pane 的 MCP 覆盖层，否则它会挡住刚选中的终端
    // （MCP 页签保留，点 MCP 页签可切回 -- 对齐 web 页签的 deactivate 语义）
    const paneSt = usePaneStore.getState()
    if (paneSt.mcpAuditPaneId === pane.id) paneSt.deactivateMcpAudit()
    // 本 pane 正显示 dsh web 时，切到终端页签仅隐藏（webview 保持挂载、子进程不回收），点 web 页签可切回
    if (paneSt.dshWebPaneId === pane.id && paneSt.dshWebActive) paneSt.deactivateDshWeb()
    // 网页访问栏页签同理：仅隐藏（webview 保持挂载、页面状态不丢），点网页页签可切回
    if (paneSt.webTabs.some(t => t.paneId === pane.id && t.active)) paneSt.deactivateWebTabsInPane(pane.id)
    // 文档页签同理：仅隐藏（滚动位置保留），点文档页签可切回
    if (paneSt.docTabs.some(t => t.paneId === pane.id && t.active)) paneSt.deactivateDocTabsInPane(pane.id)
    setActiveSessionInPane(pane.id, sessionId)
    // 清除活动状态
    useSessionStore.getState().setSessionActivity(sessionId, false)
    scrollToTab(sessionId)
    // 通知终端重新 fit + resize
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('terminal-tab-switched'))
    }, 50)
  }

  // 点击 MCP 页签（仅本 pane 已开 MCP 时渲染）：显示中 → 关闭（toggle，原语义）；
  // 被终端/web 页签盖住 → 切回 MCP（openMcpAuditInPane 会隐藏同 pane 的 web）
  const handleMcpTabClick = () => {
    const paneSt = usePaneStore.getState()
    if (paneSt.mcpAuditPaneId === pane.id && paneSt.mcpAuditActive) paneSt.closeMcpAudit()
    else paneSt.openMcpAuditInPane(pane.id)
  }

  // 双击左键：断开状态重连，已连接状态克隆会话
  const handleTabDoubleClick = async (sessionId: string) => {
    // 防止重复触发
    if (isCloning.current) return
    isCloning.current = true

    try {
      // 检查会话状态
      const session = sessions.find(s => s.id === sessionId)

      if (session?.status === 'disconnected' || session?.status === 'error') {
        // 断开状态：重连
        await useSessionStore.getState().reconnectSession(sessionId)
      } else {
        // 已连接状态：克隆会话（创建新连接）
        const newSessionId = await useSessionStore.getState().cloneSession(sessionId, false)

        // 检查会话是否已经在某个分屏中
        const paneStore = usePaneStore.getState()
        const allPanes = paneStore.getAllLeafPanes()
        const isInPane = allPanes.some(p => p.sessions.includes(newSessionId))

        // 如果不在任何分屏中，才添加到当前分屏
        if (!isInPane) {
          addSessionToPane(pane.id, newSessionId)
        }
      }
    } catch (error) {
      console.error('Handle tab double click failed:', error)
    } finally {
      // 延迟解锁，防止快速重复双击
      setTimeout(() => {
        isCloning.current = false
      }, 500)
    }
  }

  // 双击右键克隆渠道（共享 SSH 连接）
  const handleTabRightDoubleClick = async (sessionId: string, sessionType: string) => {
    if (sessionType !== 'ssh') {
      // 非 SSH 会话不支持克隆渠道 —— 静默 return(TODO: 全局 toast 后接入提示)
      return
    }

    // 防止重复触发
    if (isCloning.current) return
    isCloning.current = true

    try {
      // 克隆渠道（共享 SSH 连接）
      const newSessionId = await useSessionStore.getState().cloneSession(sessionId, true)

      // 检查会话是否已经在某个分屏中
      const paneStore = usePaneStore.getState()
      const allPanes = paneStore.getAllLeafPanes()
      const isInPane = allPanes.some(p => p.sessions.includes(newSessionId))

      // 如果不在任何分屏中，才添加到当前分屏
      if (!isInPane) {
        addSessionToPane(pane.id, newSessionId)
      }
    } catch (error) {
      console.error('Clone channel failed:', error)
    } finally {
      // 延迟解锁
      setTimeout(() => {
        isCloning.current = false
      }, 500)
    }
  }

  // 处理右键双击（需要检测连续两次右键点击）
  const lastRightClickTime = useRef<number>(0)
  const lastRightClickSession = useRef<string>('')

  const handleTabRightClick = (sessionId: string, sessionType: string) => {
    const now = Date.now()
    const lastTime = lastRightClickTime.current
    const lastSession = lastRightClickSession.current

    // 如果在 300ms 内连续右键点击同一个标签，视为双击右键
    if (now - lastTime < 300 && sessionId === lastSession) {
      handleTabRightDoubleClick(sessionId, sessionType)
      lastRightClickTime.current = 0
      lastRightClickSession.current = ''
    } else {
      lastRightClickTime.current = now
      lastRightClickSession.current = sessionId
    }
  }

  // 开始拖拽
  const handleDragStart = (e: React.DragEvent, sessionId: string) => {
    setGlobalDraggingId(sessionId)
    setDraggingSessionIdLocal(sessionId)
    e.dataTransfer.setData('text/plain', sessionId)
    e.dataTransfer.effectAllowed = 'move'
  }

  // 结束拖拽
  const handleDragEnd = () => {
    setGlobalDraggingId(null)
    setDraggingSessionIdLocal(null)
    setDragOverIndex(null)
    setDragOverWebTab(false)
  }

  // 拖拽悬停在标签上
  const handleDragOverTab = (e: React.DragEvent, index: number) => {
    e.preventDefault()
    // 不阻止传播，让事件正常流动
    setDragOverIndex(index)
  }

  // 拖拽离开标签
  const handleDragLeaveTab = () => {
    setDragOverIndex(null)
  }

  // 拖拽放下到页签条空白处：仅对 web 页签拖拽有义 —— 移到末尾；
  // 会话拖放落空白处维持现状（无操作），与既有行为一致
  const handleDropOnBarEmpty = (e: React.DragEvent) => {
    // 拖拽标记与 dataTransfer 双重校验：标记可能在异常拖拽序列（dragend 未触发）下残留，
    // dataTransfer 是本次拖拽的事实。但部分浏览器/模式下 drop 里 getData 可能取不到（返回
    // 空串）—— 空串时退回标记判定，只有明确读到"不是 web 页签"的数据才拒绝，避免空白区落点失效
    const dragData = e.dataTransfer.getData('text/plain')
    if (!draggingDshWeb || (dragData !== '' && dragData !== '__dsh_web__')) return
    e.preventDefault()
    e.stopPropagation()
    setDraggingDshWeb(false)
    setDshWebTabIndex(pane.sessions.length)
  }

  // 拖拽放下到标签上
  const handleDropOnTab = (e: React.DragEvent, targetIndex: number) => {
    e.preventDefault()
    e.stopPropagation()

    const dragSessionId = e.dataTransfer.getData('text/plain')
    if (!dragSessionId) return

    // web 页签拖到会话页签上：页签条内排序 —— 只写 web 的插入序号，不动 pane.sessions。
    // 落点方向推导（往左拖 = 插目标前，往右拖 = 插目标后）下沉在 store 的
    // moveDshWebToSessionTab，与其它插槽维护路径单点维护
    if (dragSessionId === '__dsh_web__') {
      // 先复位拖拽态（onDragEnd 亦会触发，幂等），让 webview 立即恢复显隐
      setDraggingDshWeb(false)
      // 过滤后可见索引映射回目标会话，原始坐标换算在 store 侧完成
      usePaneStore.getState().moveDshWebToSessionTab(pane.id, paneSessions[targetIndex].id)
      setDragOverIndex(null)
      return
    }

    // 找到拖拽会话的当前索引(在过滤后的 paneSessions 里)
    const dragIndex = paneSessions.findIndex(s => s.id === dragSessionId)
    if (dragIndex === -1 || dragIndex === targetIndex) {
      setDragOverIndex(null)
      return
    }

    // paneSessions 已过滤掉隐藏标签,但 reorderSessionsInPane 对原始 pane.sessions 做 splice,
    // 直接传过滤后索引会在中间夹有隐藏标签时错位 —— 映射回原始数组索引
    const fromOrigIndex = pane.sessions.indexOf(paneSessions[dragIndex].id)
    const toOrigIndex = pane.sessions.indexOf(paneSessions[targetIndex].id)
    if (fromOrigIndex === -1 || toOrigIndex === -1 || fromOrigIndex === toOrigIndex) {
      setDragOverIndex(null)
      return
    }

    // 重排序
    reorderSessionsInPane(pane.id, fromOrigIndex, toOrigIndex)
    setDragOverIndex(null)
  }

  // 向左滚动
  const scrollLeft = () => {
    scrollRef.current?.scrollBy({ left: -150, behavior: 'smooth' })
  }

  // 向右滚动
  const scrollRight = () => {
    scrollRef.current?.scrollBy({ left: 150, behavior: 'smooth' })
  }

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'connected': return t('common.status.connected')
      case 'connecting': return ''
      case 'error': return t('common.status.error')
      default: return t('common.status.idle')
    }
  }

  // 获取友好的错误提示
  // errorMap 的 value 现在是 i18n key（而非字面文案）；map 的 key 是技术子串，
  // 用于匹配后端原始错误，永远不展示，不翻译。函数在渲染期调用，t 在闭包作用域。
  const getFriendlyError = (error?: string): string => {
    if (!error) return t('error.default')

    // 提取错误关键信息（去掉堆栈）
    let cleanError = error
    if (cleanError.includes('\n')) {
      cleanError = cleanError.split('\n')[0] // 只取第一行
    }
    if (cleanError.includes('Error:')) {
      cleanError = cleanError.replace(/Error:\s*/g, '')
    }

    // 常见错误转换 —— key=技术子串(匹配用), value=i18n key(展示用)
    const errorMap: Record<string, string> = {
      'Timed out while waiting for handshake': 'error.sshHandshakeTimeout',
      'handshake timeout': 'error.sshHandshakeTimeout',
      'Authentication failed': 'error.authFailed',
      'connection refused': 'error.connectionRefused',
      'Connection refused': 'error.connectionRefused',
      'Connection timeout': 'error.connectionTimeout',
      'connection timeout': 'error.connectionTimeout',
      'Host key verification failed': 'error.hostKeyVerification',
      'Network is unreachable': 'error.networkUnreachable',
      'ENOTFOUND': 'error.hostNotFound',
      'ECONNREFUSED': 'error.connectionRefused',
      'ETIMEDOUT': 'error.connectionTimeout',
      'EHOSTUNREACH': 'error.hostUnreachable',
      'getaddrinfo ENOTFOUND': 'error.dnsResolveFailed',
      'read ECONNRESET': 'error.connectionReset',
      'write ECONNRESET': 'error.connectionReset',
      'socket hang up': 'error.connectionClosed',
      'SSH connection error': 'error.sshConnectionError',
      'All configured authentication methods failed': 'error.allAuthMethodsFailed',
      'private key decrypt failed': 'error.privateKeyDecryptFailed',
      'no such file': 'error.fileNotFound',
      'Permission denied': 'error.permissionDenied',
      'Too many authentication failures': 'error.tooManyAuthFailures',
    }

    // 查找匹配的错误
    for (const [key, value] of Object.entries(errorMap)) {
      if (cleanError.includes(key)) {
        return t(value)
      }
    }

    // 如果还是太长，截断
    if (cleanError.length > 30) {
      return cleanError.substring(0, 30) + t('error.truncatedSuffix')
    }
    return cleanError
  }

  // 无会话且本 pane 未开 MCP / dsh Web / 网页页签时不渲染标签栏，避免中部空条；打开时仍需标签栏承载页签。
  // 顶排 pane 例外：渲染与第一行等高的空条，保证窗口第一行永远存在(承载窗口拖拽区 + pill/控制簇浮层下方的底色)
  if (paneSessions.length === 0 && mcpAuditPaneId !== pane.id && dshWebPaneId !== pane.id && paneWebTabs.length === 0) {
    if (!isTop) return null
    return (
      <div
        className="win-drag select-none bg-[var(--bg-rack)] border-b border-[var(--rule)] transition-[padding-left] duration-150 ease-out"
        style={{
          height: TOPBAR_HEIGHT,
          paddingLeft: isTopLeft ? 'var(--top-left-reserve)' : undefined,
          paddingRight: isTopRight ? 'var(--top-right-reserve)' : undefined
        }}
      />
    )
  }

  // 计算会话名称编号 - 基于全局所有分屏的同名会话
  const getNameWithIndex = (session: typeof paneSessions[0]) => {
    // 使用所有分屏内的会话来计算编号，保持名称稳定
    const sameNameSessions = allPaneSessions.filter(s => s.config.name === session.config.name)
    if (sameNameSessions.length <= 1) {
      return session.config.name
    }
    const getTime = (d: Date | string | undefined) => {
      if (!d) return 0
      return new Date(d).getTime()
    }
    const sorted = [...sameNameSessions].sort((a, b) =>
      getTime(a.config.createdAt) - getTime(b.config.createdAt)
    )
    const index = sorted.findIndex(s => s.id === session.id)
    if (index === 0) {
      return session.config.name
    }
    return `${session.config.name} (${index})`
  }

  // 本 pane 是否正显示 dsh web（web 页签激活态 / 终端标签激活态都据此判定）
  const webActiveHere = dshWebPaneId === pane.id && dshWebActive
  // 本 pane 是否正显示 MCP 面板（MCP 页签激活态 / 终端标签激活态都据此判定；未激活时页签保留）
  const mcpActiveHere = mcpAuditPaneId === pane.id && mcpAuditActive

  // web 页签插入位置：pane.sessions 原始坐标的序号换算到过滤隐藏页签后的可见序列
  // （null / 越界随会话关闭自然钳到末尾）。中段位置在下方 map 内按索引插入，末尾渲染在 MCP 页签后。
  const webInPane = dshWebPaneId === pane.id && dshWeb !== null
  const webInsertAt = webInPane && dshWebTabIndex != null
    ? paneSessions.filter(s => pane.sessions.indexOf(s.id) < dshWebTabIndex).length
    : paneSessions.length

  // dsh Web UI 页签 -- 单例，仅本 pane 打开 web 时渲染；点页签切回 web，✕ 关闭并回收子进程。
  // 始终可拖：拖到页签条内的会话页签上 = 排序，拖到页签条空白处 = 移到末尾，
  // 拖到本 pane 或其他 pane 的边缘 = 拆成独立分屏，拖到中心 = 改挂载到该 pane。
  const webTabEl = (dshWebPaneId === pane.id && dshWeb) ? (
    <div
      data-tab-id="__dsh_web__"
      onClick={() => usePaneStore.getState().activateDshWeb()}
      title={dshWeb.cwd ?? t('dsh.webTitle')}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', '__dsh_web__')
        e.dataTransfer.effectAllowed = 'move'
        setDraggingDshWeb(true)
      }}
      onDragOver={(e) => {
        // 会话拖到 web 页签上：合法排序落点（preventDefault 允许 drop），亮指示条；
        // 同时清掉普通页签残留的落点高亮 —— 相邻元素间 dragleave 并非总可靠触发，
        // 不清的话从普通页签滑到 web 页签时两条指示会同亮
        e.preventDefault()
        setDragOverWebTab(true)
        setDragOverIndex(null)
      }}
      onDragLeave={() => setDragOverWebTab(false)}
      onDragEnd={() => setDraggingDshWeb(false)}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setDragOverWebTab(false)
        const dragSessionId = e.dataTransfer.getData('text/plain')
        // web 拖到自身上：无操作（拦下防止冒泡到页签条空白处的"移到末尾"）
        if (!dragSessionId || dragSessionId === '__dsh_web__') return
        // 会话拖到 web 页签上：插到 web 紧前/紧后，方向语义与其他落点一致
        // （从右往左拖 = 插 web 前，从左往右拖 = 插 web 后），web 顺位让位。
        // 会话重排 + web 插槽在 store 侧一次 set 完成，避免两步写的中间态。
        usePaneStore.getState().insertSessionAtWebSlot(pane.id, dragSessionId)
        setDragOverIndex(null)
      }}
      className={cn(
        'win-no-drag flex items-center gap-1 px-2 h-full border-r border-[var(--rule)] cursor-pointer transition-colors flex-shrink-0 min-w-[120px]',
        webActiveHere
          ? 'bg-[var(--terminal-bg)] text-[var(--text-rack)] border-b-2 border-b-[var(--amber)]'
          : 'bg-[var(--bg-rack)] text-[var(--text-rack-mute)] hover:bg-[var(--bg-slot)] hover:text-[var(--text-rack)]',
        // 排序落点指示 —— 与会话页签的 amber border-l 同语言（仅会话拖拽悬停时亮）
        dragOverWebTab && draggingSessionId && 'border-l-2 border-l-[var(--amber)]'
      )}
    >
      <span className="text-xs truncate max-w-[150px]">{dshWeb.name}</span>
      <button
        onClick={(e) => { e.stopPropagation(); usePaneStore.getState().closeDshWeb() }}
        title={t('dsh.webClose')}
        className="win-no-drag ml-auto w-[14px] h-[14px] flex items-center justify-center text-xs hover:bg-[var(--error-rack)] hover:text-white rounded-[2px] transition-colors"
      >
        ✕
      </button>
    </div>
  ) : null

  return (
    <div
      className={cn(
        'flex items-center bg-[var(--bg-rack)] border-b border-[var(--rule)]',
        // 左留白随侧栏收起态切换(0↔32px),与左列宽度滑动同为 150ms ease-out --
        // 收起/展开时页签与滑动中的左列边缘同步让位,不跳变
        'transition-[padding-left] duration-150 ease-out',
        // 顶排 pane 的页签条即窗口第一行：空白处作为窗口拖拽区(drag 区吞鼠标事件，
        // 交互子元素须显式 win-no-drag)；左右留白给侧栏 pill / 控制簇浮层，防页签滚入其下方
        isTop && 'win-drag select-none'
      )}
      style={{
        height: TOPBAR_HEIGHT,
        paddingLeft: isTop && isTopLeft ? 'var(--top-left-reserve)' : undefined,
        paddingRight: isTop && isTopRight ? 'var(--top-right-reserve)' : undefined
      }}
    >
      {/* 左滚动按钮 */}
      <button
        onClick={scrollLeft}
        title={t('pane.scrollLeft')}
        className="win-no-drag w-[20px] h-full flex items-center justify-center text-[var(--text-rack-mute)] hover:text-[var(--text-rack)] hover:bg-[var(--bg-elev)] transition-colors"
      >
        ‹
      </button>

      {/* 标签容器 */}
      <div
        ref={scrollRef}
        onDragOver={(e) => {
          e.preventDefault()
          // 不阻止传播，让终端区域也能接收 dragover
        }}
        onDrop={handleDropOnBarEmpty}
        className="flex flex-nowrap items-center h-full overflow-x-auto scrollbar-hide overflow-y-hidden flex-1"
      >
        {paneSessions.map((session, index) => (
          <React.Fragment key={session.id}>
            {/* web 页签的中段插入位：按排序序号插在对应会话页签之前 */}
            {webInsertAt === index && webTabEl}
            <div
              data-tab-id={session.id}
            onClick={() => handleTabClick(session.id)}
            onDoubleClick={() => handleTabDoubleClick(session.id)}
            onContextMenu={() => handleTabRightClick(session.id, session.config.type)}
            draggable
            onDragStart={(e) => handleDragStart(e, session.id)}
            onDragEnd={handleDragEnd}
            onDragOver={(e) => handleDragOverTab(e, index)}
            onDragLeave={handleDragLeaveTab}
            onDrop={(e) => handleDropOnTab(e, index)}
            title={t('pane.tabHint')}
            className={cn(
              'win-no-drag flex items-center gap-1 px-2 h-full border-r border-[var(--rule)] cursor-pointer transition-colors flex-shrink-0 min-w-[120px]',
              pane.activeSessionId === session.id && !mcpActiveHere && !webActiveHere && !webTabActiveHere && !docTabActiveHere
                ? 'bg-[var(--terminal-bg)] text-[var(--text-rack)] border-b-2 border-b-[var(--amber)]'
                : session.hasActivity
                  ? 'bg-[var(--reachable)]/25 text-[var(--text-rack)] hover:bg-[var(--reachable)]/35 shadow-[inset_2px_0_0_var(--reachable)]' // 有未读输出:reachable 青调底 + 左侧 stripe
                  : 'bg-[var(--bg-rack)] text-[var(--text-rack-mute)] hover:bg-[var(--bg-slot)] hover:text-[var(--text-rack)]',
              draggingSessionId === session.id && 'opacity-50',
              // 拖拽位置指示器 —— amber border-l 与 activity 的 reachable inset stripe 共存,视觉上 amber 覆盖青色(border 渲染层 > inset shadow);
              // 调整时不要改成 border-l-[var(--reachable)] 否则两态视觉无差
              dragOverIndex === index && draggingSessionId !== session.id && 'border-l-2 border-l-[var(--amber)]'
            )}
          >
            {/* harness 启动来源标识 —— tags 带 <kind>:<id> 的瞬态会话在名称左侧亮品牌小标 */}
            <HarnessKindMark kind={harnessKindFromTags(session.config.tags)} />
            <span className="text-xs truncate max-w-[150px]">{getNameWithIndex(session)}</span>
            {session.lockedByMcp && (
              <span
                title={t('pane.lockedByMcp', { defaultValue: 'MCP is using this terminal' })}
                className="text-[10px] px-1 rounded bg-[var(--amber)]/20 text-[var(--amber)] flex-shrink-0"
              >
                🔒
              </span>
            )}
            {session.status === 'connecting' ? (
              // connecting 不显示文字,改用 amber 呼吸点指示"连接中",避免误读为空闲态
              <span
                title={t('pane.connecting')}
                aria-label={t('pane.connecting')}
                className="w-[6px] h-[6px] rounded-full bg-[var(--amber)] animate-pulse flex-shrink-0"
              />
            ) : (
              getStatusLabel(session.status) && (
                <span
                  title={session.status === 'error' ? getFriendlyError(session.lastError) : undefined}
                  className={cn(
                    'text-xs cursor-default',
                    session.status === 'connected' ? 'text-[var(--live)]' :
                    session.status === 'error' ? 'text-[var(--error-rack)] hover:opacity-80' : 'text-[var(--text-rack-mute)]'
                  )}
                >
                  {getStatusLabel(session.status)}
                </span>
              )
            )}
            <button
              onClick={async (e) => {
                e.stopPropagation()
                const sessionId = session.id
                // 1. 先从 pane 移除页签：同步、与连接状态无关，确保 UI 立刻响应
                removeSessionFromPane(pane.id, sessionId)
                // 2. 如果该 session 正被 LIVE 标签折叠隐藏，一并清掉 hidden 标记，避免残留
                if (hiddenTabSessions[sessionId]) {
                  toggleLiveSessionTabs([sessionId], false)
                }
                // 3. 通知后端断开并清理 store/terminal；已经 disconnected/error 的会话在前端短路，不再调后端
                try {
                  await useSessionStore.getState().disconnectSession(sessionId)
                } catch (error) {
                  // 最后一道防线：即使清理 store 也失败，页签已经关闭，避免未捕获 Promise rejection
                  console.error('Failed to disconnect session after closing tab:', error)
                }
                // 4. 从 sessions 数组彻底移除 —— 与 Sidebar LIVE 段的 handleCloseLive 保持一致
                removeLiveSession(sessionId)
              }}
              title={t('pane.closeConnection')}
              className="win-no-drag ml-auto w-[14px] h-[14px] flex items-center justify-center text-xs hover:bg-[var(--error-rack)] hover:text-white rounded-[2px] transition-colors"
            >
              ✕
            </button>
            </div>
          </React.Fragment>
        ))}
        {/* MCP 活动页签 -- 仅在本 pane 打开 MCP 时出现（非常驻）；入口为标题栏 MCP 状态片。 */}
        {/* 激活时 amber 高亮；切到终端/web 页签退为未激活（页签保留），点它切回；✕ / 显示中再点 / ESC 关闭 */}
        {mcpAuditPaneId === pane.id && (
          <div
            data-tab-id="__mcp_audit__"
            onClick={handleMcpTabClick}
            title={t('pane.mcpTabHint')}
            className={cn(
              'win-no-drag flex items-center gap-1 px-2 h-full border-r border-[var(--rule)] cursor-pointer transition-colors flex-shrink-0 min-w-[120px]',
              mcpActiveHere
                ? 'bg-[var(--terminal-bg)] text-[var(--text-rack)] border-b-2 border-b-[var(--amber)]'
                : 'bg-[var(--bg-rack)] text-[var(--text-rack-mute)] hover:bg-[var(--bg-slot)] hover:text-[var(--text-rack)]'
            )}
          >
            <span className="text-xs truncate max-w-[150px]">{t('pane.mcpTab')}</span>
            <button
              onClick={(e) => { e.stopPropagation(); usePaneStore.getState().closeMcpAudit() }}
              title={t('mcpAudit.close')}
              className="win-no-drag ml-auto w-[14px] h-[14px] flex items-center justify-center text-xs hover:bg-[var(--error-rack)] hover:text-white rounded-[2px] transition-colors"
            >
              ✕
            </button>
          </div>
        )}
        {/* 网页访问栏页签（多开）—— 插件面板 URL 栏打开的通用网页；点页签切回（activateWebTab */}
        {/* 会去活同 pane 其它 overlay），✕ 关闭并销毁 webview。样式对齐 dsh Web 页签。 */}
        {paneWebTabs.map(tab => (
          <div
            key={tab.id}
            data-tab-id={tab.id}
            onClick={() => usePaneStore.getState().activateWebTab(tab.id)}
            title={tab.url}
            className={cn(
              'win-no-drag flex items-center gap-1 px-2 h-full border-r border-[var(--rule)] cursor-pointer transition-colors flex-shrink-0 min-w-[120px]',
              tab.active
                ? 'bg-[var(--terminal-bg)] text-[var(--text-rack)] border-b-2 border-b-[var(--amber)]'
                : 'bg-[var(--bg-rack)] text-[var(--text-rack-mute)] hover:bg-[var(--bg-slot)] hover:text-[var(--text-rack)]'
            )}
          >
            {tab.favicon && <WebTabFavicon key={tab.favicon} src={tab.favicon} />}
            <span className="text-xs truncate max-w-[150px]">{tab.title}</span>
            <button
              onClick={(e) => { e.stopPropagation(); usePaneStore.getState().closeWebTab(tab.id) }}
              title={t('pane.webTabClose')}
              className="win-no-drag ml-auto w-[14px] h-[14px] flex items-center justify-center text-xs hover:bg-[var(--error-rack)] hover:text-white rounded-[2px] transition-colors"
            >
              ✕
            </button>
          </div>
        ))}
        {/* web 页签位于末尾时渲染在 MCP 页签之后（与既有次序一致）；中段位置已在上方 map 内插入 */}
        {webInsertAt >= paneSessions.length && webTabEl}

        {/* 文档页签（多开）—— 文件树双击 / 拖放 / Ctrl+O / 终端 Ctrl+点击打开的只读文档； */}
        {/* 点页签切回（activateDocTab 会去活同 pane 其它 overlay），✕ 关闭。 */}
        {/* 来源点色：琥珀=远端、青=本地（与 DocHeader 一致）。 */}
        {paneDocTabs.map(tab => (
          <div
            key={tab.id}
            data-tab-id={tab.id}
            onClick={() => usePaneStore.getState().activateDocTab(tab.id)}
            title={tab.path}
            className={cn(
              'win-no-drag flex items-center gap-1 px-2 h-full border-r border-[var(--rule)] cursor-pointer transition-colors flex-shrink-0 min-w-[120px]',
              tab.active
                ? 'bg-[var(--terminal-bg)] text-[var(--text-rack)] border-b-2 border-b-[var(--amber)]'
                : 'bg-[var(--bg-rack)] text-[var(--text-rack-mute)] hover:bg-[var(--bg-slot)] hover:text-[var(--text-rack)]'
            )}
          >
            <span
              aria-hidden
              className={cn(
                'w-[7px] h-[7px] rounded-full flex-shrink-0',
                tab.source === 'remote' ? 'bg-[var(--amber)]' : 'bg-[var(--reachable)]'
              )}
            />
            <span className="text-xs truncate max-w-[150px]">{tab.title}</span>
            <button
              onClick={(e) => { e.stopPropagation(); usePaneStore.getState().closeDocTab(tab.id) }}
              title={t('doc.close')}
              className="win-no-drag ml-auto w-[14px] h-[14px] flex items-center justify-center text-xs hover:bg-[var(--error-rack)] hover:text-white rounded-[2px] transition-colors"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {/* 右滚动按钮 */}
      <button
        onClick={scrollRight}
        title={t('pane.scrollRight')}
        className="win-no-drag w-[20px] h-full flex items-center justify-center text-[var(--text-rack-mute)] hover:text-[var(--text-rack)] hover:bg-[var(--bg-elev)] transition-colors"
      >
        ›
      </button>
    </div>
  )
}

export default PaneTabBar
