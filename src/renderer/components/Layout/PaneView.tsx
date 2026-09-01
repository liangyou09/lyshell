import React, { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { WebviewTag } from 'electron'
import { usePaneStore } from '../../stores/pane-store'
import { OVERLAY_KINDS } from '../../stores'
import TerminalView from '../Terminal/TerminalView'
import PaneTabBar from './PaneTabBar'
import { McpAuditPanel } from './McpAuditPanel'
import DocTabOverlay from '../DocPanel/DocTabOverlay'
import SplitDivider from './SplitDivider'
import { resolveOverlayDragId } from './overlay-drag'
import type { PaneNode, SplitDirection, OverlayKind, OverlayPayload, OverlayRef } from '@shared/types'

type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'center' | null

// 落区分带阈值（pane 内归一化坐标）：近侧边缘带宽度（水平 30% / 垂直 25%，垂直
// 空间紧张收得更窄）与远侧边缘线 70%。dragOver 预览与 handleDrop 判定共用 ——
// 此前 0.3/0.25 在两处混抄（垂直 swap 判定一处 0.3 一处 0.25），靠外围条件才
// 没有行为分叉
const EDGE_NEAR_X = 0.3
const EDGE_NEAR_Y = 0.25
const EDGE_FAR = 0.7

// favicon 代取缓存：成功（data URI）LRU 缓存；失败不缓存——下次 page-favicon-updated
// （切回页签/页内刷新触发）自然重试，事件只在 favicon 列表变化时才发，天然限频。
// 超限逐出最旧一条（Map 迭代序 = 插入序，首键即最旧）而非整表清空——高频页签组
// 在容量边界反复进出时，整表清空会触发整轮重新代取，逐出只多取一条
const FAVICON_CACHE_MAX = 200
const faviconCache = new Map<string, Promise<string | null>>()
function fetchFaviconDataUri(url: string): Promise<string | null> {
  // 内联 data:image/* favicon 无需代取，直接透传
  if (url.startsWith('data:image/')) return Promise.resolve(url)
  const cached = faviconCache.get(url)
  if (cached) {
    // 命中刷新新鲜度：删掉重插挪到 Map 尾部
    faviconCache.delete(url)
    faviconCache.set(url, cached)
    return cached
  }
  if (faviconCache.size >= FAVICON_CACHE_MAX) {
    const oldest = faviconCache.keys().next().value
    if (oldest !== undefined) faviconCache.delete(oldest)
  }
  const p: Promise<string | null> = window.electronAPI.fetchFavicon(url)
    .then(r => {
      if (r.success) return r.dataUri
      faviconCache.delete(url)
      return null
    })
    .catch(() => {
      faviconCache.delete(url)
      return null
    })
  faviconCache.set(url, p)
  return p
}

// 从 page-favicon-updated 事件提取首个 favicon URL。Electron 28 实测（探针验证）：
// 参数挂在事件自身属性上（e.favicons），detail 为 undefined；兼容 detail 形状只为稳妥。
function faviconUrlFromEvent(e: Event): string | undefined {
  const detail = (e as CustomEvent<unknown>).detail
  const candidates: unknown[] = [
    (e as { favicons?: unknown }).favicons,
    (detail as { favicons?: unknown } | undefined)?.favicons,
    Array.isArray(detail) ? detail : undefined
  ]
  for (const c of candidates) {
    if (Array.isArray(c)) {
      const first = c.find(u => typeof u === 'string' && u.length > 0)
      if (first) return first
    }
  }
  return undefined
}

/**
 * 网页访问栏页签的 webview 覆盖层（单页签实例）。
 * partition 固定 persist:webbar（与 dsh web 隔离的浏览会话）；导航/弹窗由主进程
 * did-attach-webview 按 partition 分流锁定（仅 http/https）。标题经 page-title-updated
 * 回写 store，页签显示页面标题而非裸 hostname；favicon 经 page-favicon-updated 由
 * 主进程代取转 data URI 回写（渲染层 CSP 只放行 data: 图）。首次 did-finish-load 时
 * 把 URL 记入「最近访问」历史（加载失败的 URL 不算访问过）。
 */
const WebTabOverlay: React.FC<{ id: string; url: string }> = ({ id, url }) => {
  const setWebTabTitle = usePaneStore(s => s.setWebTabTitle)
  const setWebTabFavicon = usePaneStore(s => s.setWebTabFavicon)
  const recordWebTabVisit = usePaneStore(s => s.recordWebTabVisit)
  const ref = useRef<WebviewTag | null>(null)
  // 每 tab 只记一次：did-finish-load 对页内刷新/锚点跳转也会触发，重复记录靠 store 去重，
  // 这里用 ref 闸掉后续事件省 setState（url 固定为打开时的 URL，页内导航不另记）
  const historyRecorded = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onTitle = (e: Event): void => {
      // Electron 28 实测：webview 事件参数挂在事件自身属性上（e.title），detail 为
      // undefined —— 原来只读 detail 的写法一直取不到，两者兼容
      const evt = e as CustomEvent<{ title?: string }> & { title?: string }
      const title = evt.title ?? evt.detail?.title
      if (title) setWebTabTitle(id, title)
    }
    const onFavicon = (e: Event): void => {
      // 取首个 favicon，代取失败静默回落纯文字页签（下次事件自动重试）
      const src = faviconUrlFromEvent(e)
      if (!src) return
      void fetchFaviconDataUri(src).then(dataUri => {
        // 异步回来时页签可能已关闭，setWebTabFavicon 对未知 id 是 no-op
        if (dataUri) setWebTabFavicon(id, dataUri)
      })
    }
    const onLoadFinish = (): void => {
      if (historyRecorded.current) return
      historyRecorded.current = true
      recordWebTabVisit(url)
    }
    el.addEventListener('page-title-updated', onTitle)
    el.addEventListener('page-favicon-updated', onFavicon)
    el.addEventListener('did-finish-load', onLoadFinish)
    return () => {
      el.removeEventListener('page-title-updated', onTitle)
      el.removeEventListener('page-favicon-updated', onFavicon)
      el.removeEventListener('did-finish-load', onLoadFinish)
    }
  }, [id, url, setWebTabTitle, setWebTabFavicon, recordWebTabVisit])

  return (
    <webview
      ref={ref}
      partition="persist:webbar"
      src={url}
      className="w-full h-full"
    />
  )
}

// 「去活即卸载」的种类行为规则已上移 OVERLAY_KINDS 注册表，此处直接查表；
// webview/iframe 吞宿主拖拽事件的问题由渲染层的拖拽盾（见下方 JSX）统一兜住

/**
 * 覆盖层内容渲染注册表 —— PaneView 侧「每种类一个渲染器」。
 * 外壳（absolute 定位 / visibility 显隐 / 层级）由 OverlayHost 统一处理，
 * 这里只管「这一种覆盖层长什么样」。新增覆盖层种类 = 此处加一个条目。
 * 全员 React.memo：PaneView 整体重渲染时，props 未变的覆盖层（ref 对象与
 * payload 对象都还是旧引用）直接跳过 —— 否则一次重渲染会让本 pane 所有
 * 文档面板跟着重跑 react-markdown。
 */
interface OverlayContentProps {
  paneId: string
  overlay: OverlayRef
  payload: OverlayPayload
}

// MCP 审计面板：单例纯 DOM；「去活即卸载」由 OVERLAY_KINDS.unmountWhenInactive 承担
const McpAuditOverlay = React.memo<OverlayContentProps>(({ overlay }) => {
  const closeOverlay = usePaneStore(s => s.closeOverlay)
  return <McpAuditPanel onClose={() => closeOverlay(overlay.id)} />
})
McpAuditOverlay.displayName = 'McpAuditOverlay'

// dsh Web UI：webview 单例。partition 与主进程 will-attach-webview 分流锁定耦合，勿改
const DshWebOverlay = React.memo<OverlayContentProps>(({ payload }) => (
  payload.kind === 'dshWeb'
    ? <webview partition="persist:dshweb" src={payload.url} className="w-full h-full" />
    : null
))
DshWebOverlay.displayName = 'DshWebOverlay'

const WebOverlay = React.memo<OverlayContentProps>(({ overlay, payload }) => (
  payload.kind === 'web'
    ? <WebTabOverlay id={overlay.id} url={payload.url} />
    : null
))
WebOverlay.displayName = 'WebOverlay'

const DocOverlay = React.memo<OverlayContentProps>(({ paneId, overlay, payload }) => (
  payload.kind === 'doc'
    ? <DocTabOverlay id={overlay.id} paneId={paneId} payload={payload} />
    : null
))
DocOverlay.displayName = 'DocOverlay'


const overlayContentRenderers: Record<OverlayKind, React.FC<OverlayContentProps>> = {
  mcpAudit: McpAuditOverlay,
  dshWeb: DshWebOverlay,
  web: WebOverlay,
  doc: DocOverlay
}

/**
 * 覆盖层挂载 gate：payload 订阅按实例收敛（s => s.overlayPayloads[id]）——
 * 任一 payload 回写（标题/favicon/文档刷新）只重渲染所属实例，不再整字典换
 * 引用联动所有 pane。外壳统一 absolute inset-0 + visibility（保 webview/滚动
 * 状态）+ 激活态层级；「去活即卸载」的种类（MCP）在这里拦截。
 */
const OverlayHost: React.FC<{ paneId: string; overlay: OverlayRef }> = ({ paneId, overlay }) => {
  const payload = usePaneStore(s => s.overlayPayloads[overlay.id])
  if (!payload) return null // 防御：引用无 payload（异常中间态）不渲染
  if (!overlay.active && OVERLAY_KINDS[overlay.kind].unmountWhenInactive) return null
  const Renderer = overlayContentRenderers[overlay.kind]
  return (
    <div
      className="absolute inset-0"
      style={{ visibility: overlay.active ? 'visible' : 'hidden', zIndex: overlay.active ? 10 : 0 }}
    >
      <Renderer paneId={paneId} overlay={overlay} payload={payload} />
    </div>
  )
}

interface PaneViewProps {
  node: PaneNode
  /** 处于窗口第一行(顶排) -- 该 pane 的页签条成为窗口第一行,启用拖拽区/留白 */
  isTop?: boolean
  /** 第一行最左叶子 -- 页签条左侧为侧栏开关 pill 留白 */
  isTopLeft?: boolean
  /** 第一行最右叶子 -- 页签条右侧为控制簇留白 */
  isTopRight?: boolean
}

/**
 * 分屏视图组件 - 递归渲染分屏树。
 *
 * 顶排 flag 沿递归下传,判定规则:
 * - horizontal(左右并排):两子都继承 isTop;isTopLeft 归 firstChild,isTopRight 归 secondChild
 * - vertical(上下堆叠):仅 firstChild 继承三个 flag(下 pane 的页签条在窗口中部,不是第一行)
 */
const PaneView: React.FC<PaneViewProps> = ({ node, isTop, isTopLeft, isTopRight }) => {
  // 逐字段 selector 订阅：本组件从 store 只读 activePaneId / 拖拽态
  // （布局树由 node prop 传入；payload 字典的订阅收敛在 OverlayHost 按实例进行，
  //  任一 payload 回写不再联动所有 pane 重渲染）。
  // action 引用在 create 时即固定，选中它们零成本
  const setActivePane = usePaneStore(s => s.setActivePane)
  const addSessionToPane = usePaneStore(s => s.addSessionToPane)
  const splitPaneWithPosition = usePaneStore(s => s.splitPaneWithPosition)
  const swapPanePosition = usePaneStore(s => s.swapPanePosition)
  const setDraggingOverlay = usePaneStore(s => s.setDraggingOverlay)
  const setDraggingSession = usePaneStore(s => s.setDraggingSession)
  const moveOverlayToPane = usePaneStore(s => s.moveOverlayToPane)
  const splitOverlayIntoPane = usePaneStore(s => s.splitOverlayIntoPane)
  const activePaneId = usePaneStore(s => s.layout.activePaneId)
  const draggingOverlayId = usePaneStore(s => s.draggingOverlayId)
  const draggingSessionId = usePaneStore(s => s.draggingSessionId)
  const { getPaneBySessionId, getParentPane, getPanePositionInParent } = usePaneStore.getState()
  // 被隐藏的终端页签记录(Sidebar LIVE 段会话标签点击 toggle);订阅整个记录,任何 toggle 都会触发本组件重渲染。
  // 实际负载很小(仅 visibility 切换),未做按 pane 过滤的选择器。
  const hiddenTabSessions = usePaneStore(s => s.hiddenTabSessions)
  const { t } = useTranslation()
  const isActive = activePaneId === node.id
  const [dropZone, setDropZone] = useState<DropZone>(null)
  const [dropAction, setDropAction] = useState<'swap' | 'split' | 'moveOverlay' | null>(null)
  const dropRef = useRef<HTMLDivElement>(null)
  // 拖拽中覆盖层的种类（落区配色/文案分族用）：响应式从 payload 字典取（payload 与
  // 引用同 set 原子增删，kind 一致；不用 getState 读树 —— 渲染期非响应式读取在并发
  // set 下会撕裂）。拖拽中就被关掉的异常态回落 undefined → 按 web 系配色
  const draggedOverlayKind = usePaneStore(s =>
    s.draggingOverlayId ? s.overlayPayloads[s.draggingOverlayId]?.kind : undefined)

  // 点击激活分屏
  const handleClick = () => {
    if (node.type === 'leaf') {
      setActivePane(node.id)
    }
  }

  // 叶子节点 - 渲染标签栏 + 终端
  if (node.type === 'leaf') {
    const handleDragOver = (e: React.DragEvent) => {
      // 会话标记优先：异常拖拽序列（源页签 dragend 丢失）下覆盖层标记可能残留，
      // 此刻用户又在拖会话页签 —— 按会话处理，别让僵尸标记劫持落区
      const draggingOverlay = draggingOverlayId !== null && !draggingSessionId
      if (!draggingSessionId && !draggingOverlay) {
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

      // 覆盖层页签拖拽（web / 文档 / dsh web / MCP 通用）：
      // 四边 = 独立分屏，中心 = 改挂载到本 pane（live 预览沿用 dropZone 指示器）
      if (draggingOverlay) {
        const isHorizontalEdge = xPos < EDGE_NEAR_X || xPos > EDGE_FAR
        const isVerticalEdge = yPos < EDGE_NEAR_Y || yPos > EDGE_FAR
        const isCenter = !isHorizontalEdge && !isVerticalEdge
        setDropAction(isCenter ? 'moveOverlay' : 'split')
        if (isCenter) {
          setDropZone('center')
        } else if (isHorizontalEdge) {
          setDropZone(xPos < 0.5 ? 'left' : 'right')
        } else {
          setDropZone(yPos < 0.5 ? 'top' : 'bottom')
        }
        return
      }

      // 非覆盖层拖拽：顶部 guard 已拦下「两者皆空」，此处仅为收窄 sessionId 类型
      const sessionId = draggingSessionId
      if (!sessionId) return

      // 判断拖拽位置
      const isHorizontalEdge = xPos < EDGE_NEAR_X || xPos > EDGE_FAR
      const isVerticalEdge = yPos < EDGE_NEAR_Y || yPos > EDGE_FAR
      const isCenter = !isHorizontalEdge && !isVerticalEdge

      // 如果是自己的会话拖到中心区域，不显示drop提示
      const isOwnSession = node.sessions.includes(sessionId)
      if (isOwnSession && isCenter) {
        setDropZone(null)
        setDropAction(null)
        return
      }

      // 检查是否是兄弟分屏（可以交换位置或在目标内嵌套分屏）
      const sourcePane = getPaneBySessionId(sessionId)
      const sourceParent = sourcePane ? getParentPane(sourcePane.id) : undefined
      const targetParent = getParentPane(node.id)

      // 判断操作类型：默认 split（drop 侧在目标 pane 内做嵌套分屏），
      // 兄弟同向对边时为 swap（源/目标整体换位）
      let action: 'swap' | 'split' | null = 'split'

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
            const targetLeft = xPos < EDGE_NEAR_X
            const targetRight = xPos > EDGE_FAR
            // 拖到左边缘但源在右边 → 交换让源去左边
            if (targetLeft && sourcePosition === 'second') action = 'swap'
            // 拖到右边缘但源在左边 → 交换让源去右边
            if (targetRight && sourcePosition === 'first') action = 'swap'
          } else {
            const targetTop = yPos < EDGE_NEAR_Y
            const targetBottom = yPos > EDGE_FAR
            // 拖到上边缘但源在下边 → 交换让源去上边
            if (targetTop && sourcePosition === 'second') action = 'swap'
            // 拖到下边缘但源在上边 → 交换让源去下边
            if (targetBottom && sourcePosition === 'first') action = 'swap'
          }
        }
        // 方向不同（垂直于父 split）：drop 侧同样是在目标 pane 内做嵌套分屏
        // （见 handleDrop 同分支），预览保持 split —— 不再显示与实际行为不符的
        // 「改变方向」
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

      // 覆盖层页签落下（所有种类同一落点语义）：中心 = 改挂载，四边 = 拆独立分屏。
      // 与 handleDragOver 同序：会话标记优先；再以 dataTransfer 交叉校验覆盖层
      // 标记（标记残留时 dataTransfer 是本次拖拽的事实，非覆盖层数据不放行）
      const overlayDragId = resolveOverlayDragId(
        e.dataTransfer.getData('text/plain'),
        draggingSessionId ? null : draggingOverlayId
      )
      if (overlayDragId) {
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
        const overlayId = overlayDragId
        // 先复位拖拽态（onDragEnd 亦会触发，幂等），让 webview 立即恢复显隐
        setDraggingOverlay(null)

        const isHorizontalEdge = xPos < EDGE_NEAR_X || xPos > EDGE_FAR
        const isVerticalEdge = yPos < EDGE_NEAR_Y || yPos > EDGE_FAR
        const isCenter = !isHorizontalEdge && !isVerticalEdge

        if (isCenter) {
          moveOverlayToPane(overlayId, node.id)
        } else if (isHorizontalEdge) {
          splitOverlayIntoPane(overlayId, node.id, 'horizontal', xPos < 0.5 ? 'first' : 'second')
        } else {
          splitOverlayIntoPane(overlayId, node.id, 'vertical', yPos < 0.5 ? 'first' : 'second')
        }
        return
      }

      const sessionId = draggingSessionId
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
      setDraggingSession(null)

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
      const isHorizontalEdge = xPos < EDGE_NEAR_X || xPos > EDGE_FAR
      const isVerticalEdge = yPos < EDGE_NEAR_Y || yPos > EDGE_FAR
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
              const targetLeft = xPos < EDGE_NEAR_X
              const targetRight = xPos > EDGE_FAR
              if (targetLeft && sourcePosition === 'second') needSwap = true
              if (targetRight && sourcePosition === 'first') needSwap = true
            } else {
              const targetTop = yPos < EDGE_NEAR_Y
              const targetBottom = yPos > EDGE_FAR
              if (targetTop && sourcePosition === 'second') needSwap = true
              if (targetBottom && sourcePosition === 'first') needSwap = true
            }

            if (needSwap) {
              swapPanePosition(sourcePane.id)
            } else {
              // 方向相同但不需要交换，在目标分屏内创建新分屏
              const nestedDirection: SplitDirection = parentDirection === 'horizontal' ? 'vertical' : 'horizontal'
              const position: 'first' | 'second' = isHorizontalEdge
                ? (xPos < EDGE_NEAR_X ? 'first' : 'second')
                : (yPos < EDGE_NEAR_Y ? 'first' : 'second')
              splitPaneWithPosition(node.id, nestedDirection, sessionId, position)
            }
          } else {
            // 方向不同（垂直于父 split）：在目标分屏内做垂直方向的嵌套分屏
            const nestedDirection: SplitDirection = isHorizontalEdge ? 'horizontal' : 'vertical'
            const position: 'first' | 'second' = isHorizontalEdge
              ? (xPos < EDGE_NEAR_X ? 'first' : 'second')
              : (yPos < EDGE_NEAR_Y ? 'first' : 'second')
            splitPaneWithPosition(node.id, nestedDirection, sessionId, position)
          }
        } else {
          // 否则创建新分屏
          const direction: SplitDirection = isHorizontalEdge ? 'horizontal' : 'vertical'
          const position: 'first' | 'second' = isHorizontalEdge
            ? (xPos < EDGE_NEAR_X ? 'first' : 'second')
            : (yPos < EDGE_NEAR_Y ? 'first' : 'second')
          splitPaneWithPosition(node.id, direction, sessionId, position)
        }
      }
    }

    // 落区指示器视图模型：样式与文案分开返回 —— 此前 label 混进 style 对象里
    // （靠浏览器忽略未知 CSS 属性才没炸），且一次渲染重复调用三次
    const getDropZoneView = (zone: DropZone, action: 'swap' | 'split' | 'moveOverlay' | null):
      { style: React.CSSProperties; label: string } | null => {
      if (!zone) return null

      // moveOverlay 配色/文案按拖拽中种类从注册表取（doc=amber、web 系=reachable，
      // 均与各自页签点色同源的主题令牌）；异常态（拖拽中就被关掉）按 web 系兜底
      const dragDef = draggedOverlayKind ? OVERLAY_KINDS[draggedOverlayKind] : undefined
      const moveColor = dragDef?.dropAccent ?? OVERLAY_KINDS.web.dropAccent
      const moveLabel = t(dragDef?.dropLabelKey ?? OVERLAY_KINDS.web.dropLabelKey)

      const colors = {
        swap: { bg: 'rgba(255, 140, 0, 0.3)', border: '#FF8C00' },  // 橙色 - 交换
        split: { bg: 'rgba(0, 120, 212, 0.3)', border: '#0078D4' }, // 蓝色 - 分屏
        moveOverlay: moveColor
      }

      const color = colors[action || 'split']

      const baseStyle: React.CSSProperties = {
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
        split: t('pane.actionSplit'),
        moveOverlay: moveLabel
      }
      const actionLabel = labels[action || 'split']

      switch (zone) {
        case 'left':
          return { style: { ...baseStyle, left: 0, top: 0, width: '30%', height: '100%' }, label: t('pane.zoneLeft', { label: actionLabel }) }
        case 'right':
          return { style: { ...baseStyle, right: 0, top: 0, width: '30%', height: '100%' }, label: t('pane.zoneRight', { label: actionLabel }) }
        case 'top':
          return { style: { ...baseStyle, left: 0, top: 0, width: '100%', height: '25%' }, label: t('pane.zoneTop', { label: actionLabel }) }
        case 'bottom':
          return { style: { ...baseStyle, left: 0, bottom: 0, width: '100%', height: '25%' }, label: t('pane.zoneBottom', { label: actionLabel }) }
        case 'center':
          return { style: { ...baseStyle, left: '30%', top: '25%', width: '40%', height: '50%' }, label: action === 'moveOverlay' ? moveLabel : t('pane.merge') }
        default:
          return null
      }
    }
    const dropZoneView = dropZone ? getDropZoneView(dropZone, dropAction) : null

    return (
      <div
        data-pane-id={node.id}
        onClick={handleClick}
        className={`
          relative w-full h-full flex flex-col
          ${isActive ? 'ring-1 ring-[#0078D4]' : ''}
        `}
      >
        <PaneTabBar pane={node} isTop={isTop} isTopLeft={isTopLeft} isTopRight={isTopRight} />

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

          {/* 覆盖层统一循环 —— 挂载点在 pane 树上（node.overlays）；外壳/卸载规则/ */}
          {/* payload 订阅收敛在 OverlayHost（按实例 gate）。 */}
          {node.overlays.map(ref => (
            <OverlayHost key={ref.id} paneId={node.id} overlay={ref} />
          ))}

          {/* 拖拽盾：任何页签拖拽（覆盖层 / 会话）期间盖在内容区最上层的无 handler */}
          {/* 薄层。webview / html iframe 是独立浏览上下文会吞宿主 dragover/drop —— */}
          {/* 会话拖拽同样会被吞（此前只给覆盖层拖拽挂盾，拖会话页签经过显示 web 系 */}
          {/* 覆盖层的 pane 时落区无指示、drop 静默失效）。事件打到盾上再冒泡回本 */}
          {/* 容器的落区判定（handleDragLeave 的 contains 判定把盾当子节点，不会误清 */}
          {/* 指示器），落区恒可达且 webview 保持可见；替代原先「吞没种类拖拽期 */}
          {/* visibility:hidden」造成的整 pane 闪空 */}
          {(draggingOverlayId !== null || draggingSessionId !== null) && (
            <div className="absolute inset-0 z-20" aria-hidden="true" />
          )}

          {/* 分屏指示器 */}
          {dropZoneView && (
            <div style={dropZoneView.style}>
              {dropZoneView.label}
            </div>
          )}
        </div>
      </div>
    )
  }

  // 分屏节点 - 渲染两个子节点(顶排 flag 按方向规则传播,见组件头注释)
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
        <PaneView node={node.firstChild} isTop={isTop} isTopLeft={isTopLeft}
          isTopRight={node.direction === 'horizontal' ? false : isTopRight} />
      </div>

      <SplitDivider paneId={node.id} direction={node.direction} />

      <div className="flex-1 overflow-hidden">
        {/* secondChild 恒非最左;vertical 时它整列位于下方,三个 flag 全 false */}
        <PaneView node={node.secondChild}
          isTop={node.direction === 'horizontal' ? isTop : false}
          isTopRight={node.direction === 'horizontal' ? isTopRight : false} />
      </div>
    </div>
  )
}

export default PaneView
