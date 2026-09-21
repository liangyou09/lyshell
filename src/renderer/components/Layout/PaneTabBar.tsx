import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import cn from 'classnames'
import { useTranslation } from 'react-i18next'
import { useSessionStore, type SessionState } from '../../stores/session-store'
import { usePaneStore } from '../../stores/pane-store'
import { dispatchOpenPalette } from '../../commands/palette'
import { OVERLAY_DRAG_MARKER, parseOverlayDragMarker, resolveOverlayDragId } from './overlay-drag'
import { harnessKindFromTags, type HarnessAgentKind } from '@shared/harness'
import DeepSeekWhaleIcon from './DeepSeekWhaleIcon'
import type { PaneLeaf, OverlayKind, OverlayPayload, OverlayRef } from '@shared/types'
import { TOPBAR_HEIGHT, TOPBAR_GRIP_WIDTH } from './topbar-metrics'

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

// ===== 覆盖层页签：种类规格表 + 统一外壳 =====

/** 各种类覆盖层页签的内容渲染器 —— 只管「页签里画什么」，外壳行为见 OverlayTab */
type OverlayTabContent = React.FC<{ payload: OverlayPayload }>

const DshWebTabContent: OverlayTabContent = ({ payload }) =>
  payload.kind === 'dshWeb'
    ? <span className="text-xs truncate flex-1 min-w-0">{payload.name}</span>
    : null

const WebTabContent: OverlayTabContent = ({ payload }) => {
  if (payload.kind !== 'web') return null
  return (
    <>
      {payload.favicon && <WebTabFavicon key={payload.favicon} src={payload.favicon} />}
      <span className="text-xs truncate flex-1 min-w-0">{payload.title}</span>
    </>
  )
}

const DocTabContent: OverlayTabContent = ({ payload }) => {
  if (payload.kind !== 'doc') return null
  return (
    <>
      {/* 来源色点：琥珀=远端（会话 amber 语义）、青=本地、灰=内置（与 DocHeader 一致） */}
      <span
        aria-hidden
        className={cn(
          'w-[7px] h-[7px] rounded-full flex-shrink-0',
          payload.source === 'remote' ? 'bg-[var(--amber)]'
            : payload.source === 'builtin' ? 'bg-[var(--text-rack-dim)]'
            : 'bg-[var(--reachable)]'
        )}
      />
      <span className="text-xs truncate flex-1 min-w-0">{payload.title}</span>
    </>
  )
}

const McpTabContent: OverlayTabContent = () => {
  const { t } = useTranslation()
  return <span className="text-xs truncate flex-1 min-w-0">{t('pane.mcpTab')}</span>
}

/**
 * 各种类覆盖层页签的规格 —— 新增覆盖层种类在此加一个条目即可获得页签
 * （拖拽/高亮/落点/关闭钮由 OverlayTab 外壳统一处理，无须再抄一遍页签 JSX）。
 */
interface OverlayTabSpec {
  /** 页签内容（品牌图标/favicon/来源点 + 标题） */
  Content: OverlayTabContent
  /** 页签 title 提示 */
  tabTitle: (payload: OverlayPayload, t: (key: string) => string) => string
  /** 关闭钮 title */
  closeTitle: (t: (key: string) => string) => string
  /** 激活态下再点页签 = 关闭（MCP toggle 语义，原行为） */
  toggleCloseOnActive?: boolean
}

const OVERLAY_TAB_SPECS: Record<OverlayKind, OverlayTabSpec> = {
  dshWeb: {
    Content: DshWebTabContent,
    tabTitle: (p, t) => (p.kind === 'dshWeb' && p.cwd) || t('dsh.webTitle'),
    closeTitle: t => t('dsh.webClose')
  },
  web: {
    Content: WebTabContent,
    tabTitle: p => (p.kind === 'web' ? p.url : ''),
    closeTitle: t => t('pane.webTabClose')
  },
  doc: {
    Content: DocTabContent,
    tabTitle: p => (p.kind === 'doc' ? p.path : ''),
    closeTitle: t => t('doc.close')
  },
  mcpAudit: {
    Content: McpTabContent,
    tabTitle: (_p, t) => t('pane.mcpTabHint'),
    closeTitle: t => t('mcpAudit.close'),
    toggleCloseOnActive: true
  }
}

/**
 * 覆盖层页签外壳 —— 所有种类共用一套 JSX：
 * - 拖拽：dataTransfer 统一 `'__overlay__:<id>'` 标记 + store 的 draggingOverlayId
 *   （拖到 pane 边缘拆屏 / 中心改挂载在 PaneView 落区；拖到会话页签上 = 条内排序写插槽）
 * - 会话拖到覆盖层页签上：合法排序落点（insertSessionAtOverlaySlot），亮 amber 指示条
 * - 关闭钮 + 激活高亮；种类差异只剩 OVERLAY_TAB_SPECS 的内容渲染器与 toggle 语义
 */
const OverlayTab: React.FC<{
  pane: PaneLeaf
  overlay: OverlayRef
  draggingSessionId: string | null
  dragOverOverlayId: string | null
  setDragOverOverlayId: React.Dispatch<React.SetStateAction<string | null>>
  setDragOverIndex: (i: number | null) => void
}> = ({ pane, overlay, draggingSessionId, dragOverOverlayId, setDragOverOverlayId, setDragOverIndex }) => {
  const { t } = useTranslation()
  const spec = OVERLAY_TAB_SPECS[overlay.kind]
  const activateOverlay = usePaneStore(s => s.activateOverlay)
  const closeOverlay = usePaneStore(s => s.closeOverlay)
  const setDraggingOverlay = usePaneStore(s => s.setDraggingOverlay)
  // payload 订阅按实例收敛（favicon/标题回写只重渲染所属页签，不再整字典联动
  // 所有页签条）；引用无 payload 的异常中间态不渲染，与旧序列构建口径一致
  const payload = usePaneStore(s => s.overlayPayloads[overlay.id])
  if (!payload) return null
  const { Content } = spec

  return (
    <div
      data-tab-id={overlay.id}
      onClick={() => {
        // 激活态下再点 = 关闭（MCP toggle 原语义），其余种类为幂等激活
        if (overlay.active && spec.toggleCloseOnActive) closeOverlay(overlay.id)
        else activateOverlay(overlay.id)
      }}
      title={spec.tabTitle(payload, t)}
      draggable
      onDragStart={(e) => {
        // 统一标记拖拽：PaneView 落区 / 页签条排序靠 dataTransfer 判种属。
        // 先写 dataTransfer 再置 store 标记，标记置放异常也不至于杀掉整个拖拽
        e.dataTransfer.setData('text/plain', OVERLAY_DRAG_MARKER + overlay.id)
        e.dataTransfer.effectAllowed = 'move'
        setDraggingOverlay(overlay.id)
      }}
      onDragEnd={() => setDraggingOverlay(null)}
      onDragOver={(e) => {
        // 会话拖到覆盖层页签上：合法排序落点（preventDefault 允许 drop），亮指示条；
        // 同时清掉普通页签残留的落点高亮 —— 相邻元素间 dragleave 并非总可靠触发，
        // 不清的话从普通页签滑到覆盖层页签时两条指示会同亮
        e.preventDefault()
        setDragOverIndex(null)
        setDragOverOverlayId(overlay.id)
      }}
      onDragLeave={() => setDragOverOverlayId(prev => (prev === overlay.id ? null : prev))}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setDragOverOverlayId(null)
        const dragData = e.dataTransfer.getData('text/plain')
        // 覆盖层拖到自身/彼此上：无操作（拦下防止冒泡到页签条空白处的"移到末尾"）
        if (parseOverlayDragMarker(dragData)) return
        // getData 空串兜底（对齐 handleDropOnTab / handleDropOnBarEmpty 的浏览器怪癖）：
        // 空串时退回本地会话拖拽标记；store 侧还会校验会话确在本 pane，残留标记无害
        const sessionId = dragData !== '' ? dragData : draggingSessionId
        if (!sessionId) return
        // 会话拖到覆盖层页签上：插到紧前/紧后并同步插槽（方向语义与其他落点一致），
        // 会话重排 + 插槽在 store 侧一次 set 完成，避免两步写的中间态
        usePaneStore.getState().insertSessionAtOverlaySlot(overlay.id, pane.id, sessionId)
        setDragOverIndex(null)
      }}
      className={cn(
        'win-no-drag pane-tab flex items-center gap-1 px-2 h-full border-r border-[var(--rule)] cursor-pointer transition-colors flex-1 min-w-0 max-w-[220px]',
        overlay.active
          ? 'bg-[var(--terminal-bg)] text-[var(--text-rack)] border-b-2 border-b-[var(--amber)]'
          : 'bg-[var(--bg-rack)] text-[var(--text-rack-mute)] hover:bg-[var(--bg-slot)] hover:text-[var(--text-rack)]',
        // 排序落点指示 —— 与会话页签的 amber border-l 同语言（仅会话拖拽悬停时亮）
        dragOverOverlayId === overlay.id && draggingSessionId && 'border-l-2 border-l-[var(--amber)]'
      )}
    >
      <Content payload={payload} />
      <button
        onClick={(e) => { e.stopPropagation(); closeOverlay(overlay.id) }}
        // 点击即关闭、按钮随之卸载:拦下 mousedown 的默认焦点搬迁,键盘留在原地
        // (空态命令屏的 prompt / 终端),不给"关完页签焦点落到 body"留缝
        onMouseDown={(e) => e.preventDefault()}
        title={spec.closeTitle(t)}
        className={cn(
          'win-no-drag pane-tab-close w-[14px] h-[14px] flex items-center justify-center text-xs hover:bg-[var(--error-rack)] hover:text-white rounded-[2px] transition-colors',
          // 窄页签上非激活态隐藏关闭钮(悬停恢复),激活页签任何宽度保留 —— Edge 式渐进披露;
          // pane-tab-close 基类供 80px 极窄档统一隐藏(见 globals.css)
          !overlay.active && 'pane-tab-close-idle'
        )}
      >
        ✕
      </button>
    </div>
  )
}

// ===== 会话页签悬停详情卡(状态/错误文案工具与页签本体共用) =====

/** 状态短文案(connecting 无文案,由调用方给呼吸点/连接中提示) */
const getStatusLabel = (status: string, t: (key: string) => string) => {
  switch (status) {
    case 'connected': return t('common.status.connected')
    case 'connecting': return ''
    case 'error': return t('common.status.error')
    default: return t('common.status.idle')
  }
}

// 获取友好的错误提示
// errorMap 的 value 现在是 i18n key（而非字面文案）；map 的 key 是技术子串，
// 用于匹配后端原始错误，永远不展示，不翻译。t 由调用方传入（页签状态字与悬停详情卡共用）。
const getFriendlyError = (error: string | undefined, t: (key: string) => string): string => {
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

/**
 * 会话页签悬停详情卡 —— 页签被 Edge 式收缩截断后,悬停补全完整信息:
 * 完整名称 / 连接类型与目标(等宽字体,终端语汇) / 状态与错误详情 / 用户自述
 * (summary + usageNotes) / 操作提示。fixed 定位挂 body(不被条内 overflow 裁切),
 * pointer-events-none 保证卡永不拦截鼠标(不与下方终端争抢,也不会卡住自身显隐)。
 * 视觉语汇对齐 McpAuditPanel 的悬浮提示(bg-slot + rule 发丝线 + shadow-xl)。
 */
const TabHoverCard: React.FC<{ session: SessionState; rect: DOMRect }> = ({ session, rect }) => {
  const { t } = useTranslation()
  const { config, status, lastError } = session

  // 连接目标描述:按类型配置取最短可辨识字段(SSH user@host:port / 串口 path+波特率 / 本地 shell)
  const target =
    config.ssh ? `${config.ssh.username}@${config.ssh.host}:${config.ssh.port}` :
    config.telnet ? `${config.telnet.host}:${config.telnet.port}` :
    config.serial ? `${config.serial.path} · ${config.serial.baudRate}` :
    config.local?.shell ?? ''
  const statusText = status === 'connecting' ? t('pane.connecting') : getStatusLabel(status, t)
  // 双缘钳制:左值先夹进 [8, ∞),再夹到右缘上限(视口宽 - 卡宽 360 - 8px 边距)。
  // 极窄视口(<376px,实际窗口最小宽远大于此)两个约束冲突时,优先保右缘不出界,
  // 左侧可能贴 8px 或溢出 —— 卡是右对齐读数的详情,右溢比左溢更遮内容
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - 368)

  return createPortal(
    <div
      aria-hidden
      className="pane-tab-hover-card fixed z-[300] pointer-events-none w-max max-w-[360px] px-2.5 py-2 rounded-[3px] bg-[var(--bg-slot)] border border-[var(--rule)] shadow-xl flex flex-col gap-1"
      style={{ top: rect.bottom + 4, left }}
    >
      {/* 完整会话名 —— 窄页签截断的补全 */}
      <div className="text-[13px] text-[var(--text-rack)] font-medium break-all">{config.name}</div>
      {/* 连接类型 + 目标 —— data 档字色(数据读数专用,mute 档在浮卡上偏暗) */}
      {target && (
        <div className="font-mono text-xs text-[var(--text-rack-data)] break-all">
          {config.type.toUpperCase()} · {target}
        </div>
      )}
      {/* local 工作目录 —— spawn 初始值 + OSC 报告实时更新(pwsh 每次 prompt 报告;
          cmd 不发目录序列,停留在启动值) */}
      {config.local && session.cwd && (
        <div className="font-mono text-xs text-[var(--text-rack-data)] break-all">{session.cwd}</div>
      )}
      {/* 状态行:与页签同源配色,圆点取字色 */}
      <div className={cn(
        'flex items-center gap-1.5 text-xs',
        status === 'connected' ? 'text-[var(--live)]' :
        status === 'error' ? 'text-[var(--error-rack)]' : 'text-[var(--text-rack-mute)]'
      )}>
        <span aria-hidden className="w-[6px] h-[6px] rounded-full bg-current flex-shrink-0" />
        <span>{statusText}</span>
      </div>
      {/* 错误详情(页签状态字 hover 提示的完整版) */}
      {status === 'error' && lastError && (
        <div className="text-xs text-[var(--error-rack)] break-all">{getFriendlyError(lastError, t)}</div>
      )}
      {session.lockedByMcp && (
        <div className="text-xs text-[var(--amber)]">🔒 {t('pane.lockedByMcp')}</div>
      )}
      {/* 用户自述:一句话摘要 + 使用说明(说明可长,行数夹取) */}
      {config.summary && (
        <div className="text-xs text-[var(--text-rack)] break-all">{config.summary}</div>
      )}
      {config.usageNotes && (
        <div className="text-xs text-[var(--text-rack-data)] whitespace-pre-wrap break-all line-clamp-4">
          {config.usageNotes}
        </div>
      )}
    </div>,
    document.body
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
 * 分屏内的标签栏组件 - 终端会话页签 + 覆盖层页签（web / 文档 / dsh web / MCP）单循环渲染。
 * 覆盖层挂载点在 pane.overlays（slot != null 按 RAW→可见坐标插进会话序列，null 钉尾按打开序追加）。
 */
const PaneTabBar: React.FC<PaneTabBarProps> = ({ pane, isTop, isTopLeft, isTopRight }) => {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)  // 悬停位置索引（可见坐标）
  const [dragOverOverlayId, setDragOverOverlayId] = useState<string | null>(null)  // 会话悬停在覆盖层页签上（排序落点指示）

  // 会话页签悬停详情卡:悬停 400ms(意图延迟)出卡,移开/拖拽即隐 —— 收缩截断后的信息补全通道
  const [hoveredTab, setHoveredTab] = useState<{ sessionId: string; rect: DOMRect } | null>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 悬停中的页签节点 —— 出卡后的跟位/收卡判定要用(见下方 ResizeObserver effect)
  const hoveredElRef = useRef<HTMLElement | null>(null)
  const showHoverCard = (sessionId: string, el: HTMLElement) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoveredElRef.current = el
    // rect 在定时器触发时取:页签条可能滚动/收缩,enter 时的快照会漂移
    hoverTimer.current = setTimeout(() => {
      setHoveredTab({ sessionId, rect: el.getBoundingClientRect() })
    }, 400)
  }
  const hideHoverCard = () => {
    if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null }
    hoveredElRef.current = null
    setHoveredTab(null)
  }
  useEffect(() => () => { if (hoverTimer.current) clearTimeout(hoverTimer.current) }, [])

  // 卡片打开期间盯住页签自身尺寸:Edge 式收缩(flex 等分)下任何重排 —— 窗口 resize、
  // 状态字增删、远端关页签挤宽 —— 都会改页签宽度,变化即重取 rect 让卡跟位。
  // 页签节点被移出 DOM 时 RO 亦会送一次 0 尺寸通知,顺手收卡,兜住"节点重建导致
  // mouseleave 丢失"的残留卡(单指针下 React 按 sessionId 复用节点,常态不会发生)。
  // 测试环境(jsdom)无 ResizeObserver,守卫对齐 TopRightControls 的既有模式
  const hoverCardOpen = hoveredTab !== null
  useEffect(() => {
    if (!hoverCardOpen || typeof ResizeObserver === 'undefined') return
    const el = hoveredElRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      if (!el.isConnected) {
        setHoveredTab(null)
        return
      }
      setHoveredTab(prev => (prev ? { ...prev, rect: el.getBoundingClientRect() } : prev))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [hoverCardOpen])

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
  // 会话拖拽标记（原本地 useState + 模块变量）：迁进 store 后由 SplitPaneContainer
  // 的 window 级 dragend/pointerdown 兜底统一复位，本组件无须再挂自己的兜底监听
  const draggingSessionId = usePaneStore(s => s.draggingSessionId)
  const setDraggingSession = usePaneStore(s => s.setDraggingSession)
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

  // 全局已连接/连接中的会话（含尚未挂进任何 pane 的）—— 同名页签编号用全局口径
  // 才稳定：会话在 pane 间移动或暂未挂载都不改变编号
  const connectedSessions = sessions.filter(s =>
    (s.status === 'connected' || s.status === 'connecting')
  )

  // 本 pane 是否有激活中的覆盖层（终端页签激活态高亮据此互斥）
  const overlayActiveHere = pane.overlays.some(r => r.active)

  // 终端页签激活态判定（高亮与关闭钮窄页签显隐共用）：
  // 有覆盖层激活时终端页签一律视为非激活 —— 关闭钮也随非激活规则让位
  const isSessionTabActive = (sessionId: string) =>
    pane.activeSessionId === sessionId && !overlayActiveHere

  // 滚动安全网：页签只缩不滚（无地板宽度），仅极端数量把条挤溢出后才接管滚轮 ——
  // 替代原常驻左右滚动钮（按钮占的 40px 还给页签）。须非被动监听才能拦掉垂直滚动链。
  // 依赖条是否渲染：空 pane 走下方早退分支不渲染条容器，首个页签出现后条容器才挂载，
  // mount-once 的空依赖会漏掉"先空后有页签"的条
  const stripRendered = paneSessions.length > 0 || pane.overlays.length > 0
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      // 页签还能收缩（无溢出）时不接管滚轮 —— Edge 式收缩下的常见态，零干预
      if (el.scrollWidth <= el.clientWidth) return
      // 触控板原生横向手势优先，否则竖转横
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
      if (delta === 0) return
      e.preventDefault()
      el.scrollLeft += delta
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [stripRendered])

  // 滚动到选中的标签
  const scrollToTab = (tabId: string) => {
    const container = scrollRef.current
    if (!container) return

    // id 目前由系统生成,但 CSS.escape 统一兜底 —— 未来 id 若接受用户输入,
    // 含引号/反斜杠/冒号也不会拼出越权选择器
    const tabElement = container.querySelector(`[data-tab-id="${CSS.escape(tabId)}"]`)
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
    // 切到 session 页签前去活本 pane 全部覆盖层（页签保留、webview/面板仅隐藏，
    // 点各自页签可切回）—— 归一前这里是四段手工枚举，漏一种就是"盖住终端"的坑
    usePaneStore.getState().deactivateOverlaysInPane(pane.id)
    setActiveSessionInPane(pane.id, sessionId)
    // 清除活动状态
    useSessionStore.getState().setSessionActivity(sessionId, false)
    scrollToTab(sessionId)
    // 通知终端重新 fit + resize
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('terminal-tab-switched'))
    }, 50)
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
      // 延迟解锁，防止快速重复双击
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
    // 拖拽中收起悬停详情卡(拖拽幽灵与悬浮卡同时飘着会互相干扰)
    hideHoverCard()
    setDraggingSession(sessionId)
    e.dataTransfer.setData('text/plain', sessionId)
    e.dataTransfer.effectAllowed = 'move'
  }

  // 结束拖拽
  const handleDragEnd = () => {
    setDraggingSession(null)
    setDragOverIndex(null)
    setDragOverOverlayId(null)
  }

  // 拖拽悬停在标签上
  const handleDragOverTab = (e: React.DragEvent, index: number) => {
    e.preventDefault()
    // 会话与覆盖层页签拖拽都亮插入指示：两者落在本页签上都是合法排序动作
    // （会话重排 / moveOverlayToSessionTab 插槽排序），悬停暗示与放下行为须一致。
    // 例外：跨 pane 拖来的覆盖层 —— moveOverlayToSessionTab 会静默拒绝非本 pane
    // 的实例，亮了指示放下却无动作
    const st = usePaneStore.getState()
    if (st.draggingOverlayId && st.getOverlayPaneId(st.draggingOverlayId) !== pane.id) {
      setDragOverIndex(null)
      return
    }
    setDragOverIndex(index)
  }

  // 拖拽离开标签
  const handleDragLeaveTab = () => {
    setDragOverIndex(null)
  }

  // 拖拽放下到页签条空白处：仅对覆盖层页签拖拽有义 —— 移到末尾（插槽钉到会话序列末位）；
  // 会话拖放落空白处维持现状（无操作），与既有行为一致
  const handleDropOnBarEmpty = (e: React.DragEvent) => {
    // 拖拽标记与 dataTransfer 双重校验：标记可能在异常拖拽序列（dragend 未触发）下残留，
    // dataTransfer 是本次拖拽的事实。但部分浏览器/模式下 drop 里 getData 可能取不到（返回
    // 空串）—— 空串时退回标记判定，只有明确读到"不是覆盖层页签"的数据才拒绝，避免空白区落点失效。
    // 会话标记优先（对齐 PaneView）：正在拖会话页签时残留的覆盖层标记不得劫持落点
    const dragData = e.dataTransfer.getData('text/plain')
    const st = usePaneStore.getState()
    const dragId = resolveOverlayDragId(dragData, draggingSessionId ? null : st.draggingOverlayId)
    if (!dragId) return
    // 只对本 pane 的覆盖层生效：跨 pane 的空白落点交给 PaneView 的分屏/挂载区
    if (st.getOverlayPaneId(dragId) !== pane.id) return
    e.preventDefault()
    e.stopPropagation()
    st.setDraggingOverlay(null)
    st.setOverlaySlot(dragId, pane.sessions.length)
  }

  // 拖拽放下到标签上
  const handleDropOnTab = (e: React.DragEvent, targetIndex: number) => {
    e.preventDefault()
    e.stopPropagation()

    const dragData = e.dataTransfer.getData('text/plain')
    const st = usePaneStore.getState()

    // 覆盖层页签拖到会话页签上：页签条内排序 —— 只写插槽，不动 pane.sessions。
    // 落点方向推导（往左拖 = 插目标前，往右拖 = 插目标后）下沉在 store 的
    // moveOverlayToSessionTab，与其它插槽维护路径单点维护。
    // getData 空串兜底与 handleDropOnBarEmpty 同源（部分浏览器/模式下 drop 里取不到
    // 数据时退回拖拽标记判定）—— 协议解析统一走 resolveOverlayDragId；
    // 会话标记优先守卫对齐 PaneView，残留覆盖层标记不得劫持会话落点
    const dragId = resolveOverlayDragId(dragData, draggingSessionId ? null : st.draggingOverlayId)
    if (dragId) {
      // 先复位拖拽态（onDragEnd 亦会触发，幂等），让 webview 立即恢复显隐
      st.setDraggingOverlay(null)
      // 过滤后可见索引映射回目标会话，原始坐标换算在 store 侧完成
      st.moveOverlayToSessionTab(dragId, pane.id, paneSessions[targetIndex].id)
      setDragOverIndex(null)
      return
    }

    // 会话页签重排：getData 空串兜底与覆盖层落点对称（OverlayTab.onDrop 同款），
    // 否则最常见的重排手势在空串模式下静默失效；外来文本由下方 findIndex 校验拦下
    const sessionId = dragData !== '' ? dragData : draggingSessionId
    if (!sessionId) return

    // 找到拖拽会话的当前索引(在过滤后的 paneSessions 里)
    const dragIndex = paneSessions.findIndex(s => s.id === sessionId)
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

  // 无会话且本 pane 无任何覆盖层页签时不渲染标签栏，避免中部空条；打开时仍需标签栏承载页签。
  // 顶排 pane 例外：渲染与第一行等高的空条，保证窗口第一行永远存在(承载窗口拖拽区 + pill/控制簇浮层下方的底色)
  if (paneSessions.length === 0 && pane.overlays.length === 0) {
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

  // 计算会话名称编号 - 基于全局同名会话
  const getNameWithIndex = (session: typeof paneSessions[0]) => {
    // 使用全局已连接会话来计算编号，保持名称稳定
    const sameNameSessions = connectedSessions.filter(s => s.config.name === session.config.name)
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

  // 页签条目序列：终端页签（过滤隐藏）+ 覆盖层页签单循环。
  // - slot != null：按 pane.sessions RAW 坐标插在「首个原始坐标 >= slot 的可见会话」之前
  //   （RAW→可见换算，隐藏页签在场不错位；越界随会话关闭自然钳到末尾）
  // - slot == null：钉尾，按 pane.overlays 数组序（= 打开序）追加
  // 序列只依赖 pane 树（prop），不读 payload —— payload 订阅收敛在 OverlayTab
  // 按实例进行，页签序构建对 payload 写入零敏感
  type TabItem =
    | { kind: 'session'; session: typeof paneSessions[0]; index: number }
    | { kind: 'overlay'; overlay: OverlayRef }
  const tabItems: TabItem[] = []
  const pendingSlotted = pane.overlays
    .filter(r => r.slot != null)
    .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))
  const tailOverlays = pane.overlays.filter(r => r.slot == null)
  let visibleIndex = 0
  for (const session of paneSessions) {
    const rawIndex = pane.sessions.indexOf(session.id)
    while (pendingSlotted.length > 0 && (pendingSlotted[0].slot ?? 0) <= rawIndex) {
      const r = pendingSlotted.shift()!
      tabItems.push({ kind: 'overlay', overlay: r })
    }
    tabItems.push({ kind: 'session', session, index: visibleIndex++ })
  }
  // 残留的 slotted（slot 越界）与钉尾覆盖层一并按序追加
  for (const r of [...pendingSlotted, ...tailOverlays]) {
    tabItems.push({ kind: 'overlay', overlay: r })
  }

  // 悬停卡数据源:按 id 现查 —— 悬停期间状态/错误实时反映,会话被关闭则查不到即不渲染
  const hoveredSession = hoveredTab ? sessions.find(s => s.id === hoveredTab.sessionId) : undefined

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
        {tabItems.map(item => item.kind === 'session' ? (
          <React.Fragment key={item.session.id}>
            <div
              data-tab-id={item.session.id}
              onClick={() => handleTabClick(item.session.id)}
              onDoubleClick={() => handleTabDoubleClick(item.session.id)}
              onContextMenu={() => handleTabRightClick(item.session.id, item.session.config.type)}
              draggable
              onDragStart={(e) => handleDragStart(e, item.session.id)}
              onDragEnd={handleDragEnd}
              onDragOver={(e) => handleDragOverTab(e, item.index)}
              onDragLeave={handleDragLeaveTab}
              onDrop={(e) => handleDropOnTab(e, item.index)}
              // 悬停详情卡(替代原生 title:收缩截断后的完整信息,见 TabHoverCard)
              onMouseEnter={(e) => showHoverCard(item.session.id, e.currentTarget)}
              onMouseLeave={hideHoverCard}
              className={cn(
                'win-no-drag pane-tab flex items-center gap-1 px-2 h-full border-r border-[var(--rule)] cursor-pointer transition-colors flex-1 min-w-0 max-w-[220px]',
                isSessionTabActive(item.session.id)
                  ? 'bg-[var(--terminal-bg)] text-[var(--text-rack)] border-b-2 border-b-[var(--amber)]'
                  : item.session.hasActivity
                    ? 'bg-[var(--reachable)]/25 text-[var(--text-rack)] hover:bg-[var(--reachable)]/35 shadow-[inset_2px_0_0_var(--reachable)]' // 有未读输出:reachable 青调底 + 左侧 stripe
                    : 'bg-[var(--bg-rack)] text-[var(--text-rack-mute)] hover:bg-[var(--bg-slot)] hover:text-[var(--text-rack)]',
                draggingSessionId === item.session.id && 'opacity-50',
                // 拖拽位置指示器 —— amber border-l 与 activity 的 reachable inset stripe 共存,视觉上 amber 覆盖青色(border 渲染层 > inset shadow);
                // 调整时不要改成 border-l-[var(--reachable)] 否则两态视觉无差。
                // 会话与覆盖层拖拽都亮（两者落在会话页签上都是合法排序动作）；
                // draggingSessionId !== 自身只是会话重排时排除源页签自身
                dragOverIndex === item.index && draggingSessionId !== item.session.id && 'border-l-2 border-l-[var(--amber)]'
              )}
            >
              {/* harness 启动来源标识 —— tags 带 <kind>:<id> 的瞬态会话在名称左侧亮品牌小标 */}
              <HarnessKindMark kind={harnessKindFromTags(item.session.config.tags)} />
              <span className="text-xs truncate flex-1 min-w-0">{getNameWithIndex(item.session)}</span>
              {item.session.lockedByMcp && (
                <span
                  title={t('pane.lockedByMcp')}
                  className="pane-tab-lock text-[10px] px-1 rounded bg-[var(--amber)]/20 text-[var(--amber)] flex-shrink-0"
                >
                  🔒
                </span>
              )}
              {item.session.status === 'connecting' ? (
                // connecting 不显示文字,改用 amber 呼吸点指示"连接中",避免误读为空闲态
                <span
                  title={t('pane.connecting')}
                  aria-label={t('pane.connecting')}
                  className="w-[6px] h-[6px] rounded-full bg-[var(--amber)] animate-pulse flex-shrink-0"
                />
              ) : (
                getStatusLabel(item.session.status, t) && (
                  <span
                    className={cn(
                      // pane-tab-status:极窄页签(<=80px)状态字让位标题,见 globals.css
                      'pane-tab-status text-xs cursor-default',
                      item.session.status === 'connected' ? 'text-[var(--live)]' :
                      item.session.status === 'error' ? 'text-[var(--error-rack)] hover:opacity-80' : 'text-[var(--text-rack-mute)]'
                    )}
                  >
                    {getStatusLabel(item.session.status, t)}
                  </span>
                )
              )}
              <button
                onClick={async (e) => {
                  e.stopPropagation()
                  const sessionId = item.session.id
                  // 1. 先从 pane 移除页签：同步、与连接状态无关，确保 UI 立刻响应
                  removeSessionFromPane(pane.id, sessionId)
                  // 1.5 关掉的是活动页签且 pane 还有存活页签 → 切换后的新活动终端
                  // 接回键盘（与点页签同款事件链：focus + fit）；pane 被回收/清空
                  // 走命令屏挂载聚焦，不发。不发的后果是焦点悬在 body，剩下的
                  // 终端看得见打不进
                  const after = usePaneStore.getState().getPaneById(pane.id)
                  if (after?.type === 'leaf' && after.sessions.length > 0) {
                    setTimeout(() => {
                      window.dispatchEvent(new CustomEvent('terminal-tab-switched'))
                    }, 50)
                  }
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
                className={cn(
                  'win-no-drag pane-tab-close w-[14px] h-[14px] flex items-center justify-center text-xs hover:bg-[var(--error-rack)] hover:text-white rounded-[2px] transition-colors',
                  // 窄页签上非激活态隐藏关闭钮(悬停恢复),激活页签任何宽度保留 —— Edge 式渐进披露;
                  // pane-tab-close 基类供 80px 极窄档统一隐藏(见 globals.css)
                  !isSessionTabActive(item.session.id) && 'pane-tab-close-idle'
                )}
              >
                ✕
              </button>
            </div>
          </React.Fragment>
        ) : (
          <OverlayTab
            key={item.overlay.id}
            pane={pane}
            overlay={item.overlay}
            draggingSessionId={draggingSessionId}
            dragOverOverlayId={dragOverOverlayId}
            setDragOverOverlayId={setDragOverOverlayId}
            setDragOverIndex={setDragOverIndex}
          />
        ))}

        {/* 「+」新建页签钮(仅顶排) —— 跟随最后一个页签:紧贴末签而非钉在条尾
            右缘,页签增删它随行进退;空 pane 不渲染(命令屏常驻,无须再开 REPL)。
            flex-shrink-0 常驻占位:页签只缩不滚,28px 永不被挤占。点击打开全局
            命令面板(与空状态同一 REPL,/new、/local 都在那里)。非顶排条以 pane
            边框收尾,不放 + 避免中部多出占位 */}
        {isTop && (
          <button
            onClick={dispatchOpenPalette}
            title={t('pane.newTab')}
            aria-label={t('pane.newTab')}
            className="pane-tab-newtab win-no-drag w-[28px] h-full flex-shrink-0 flex items-center justify-center text-[var(--text-rack-mute)] hover:bg-[var(--bg-slot)] hover:text-[var(--text-rack)] cursor-pointer select-none transition-colors"
          >
            {/* SVG 十字标:以视盒中心对称作图,永远正中 —— 文字 + 挂在字体基线上,
                大号下光学偏移肉眼可见;描边方头与右上控制簇的 chevron 同语言 */}
            <svg
              aria-hidden
              viewBox="0 0 12 12"
              className="w-[16px] h-[16px]"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="square"
            >
              <path d="M6 1.5 V10.5 M1.5 6 H10.5" />
            </svg>
          </button>
        )}
      </div>

      {/* 保底拖拽抓手(仅顶排) -- 页签 flex-1 伸长铺满整条后(Edge 式只缩不滚),条内
          空白归零,而左右留白分别被展开 pill / 右上控制簇盖住(win-no-drag 浮层),
          窗口第一行将无任何 drag 区,窗口拖不动。抓手挂在滚动容器外(容器内会随页签
          滚动离场),页签再满也挤不掉;未满时与空白底连成一片,视觉无感。非顶排条
          是 pane 内部行不参与拖窗,不放(镜像「+」钮的顶排专属取舍) */}
      {isTop && (
        <div aria-hidden className="pane-tab-grip win-drag flex-shrink-0" style={{ width: TOPBAR_GRIP_WIDTH }} />
      )}

      {/* 会话页签悬停详情卡(fixed 挂 body,不占条内布局) */}
      {hoveredTab && hoveredSession && (
        <TabHoverCard session={hoveredSession} rect={hoveredTab.rect} />
      )}
    </div>
  )
}

export default PaneTabBar
