import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { WebviewTag } from 'electron'
import { usePaneStore } from '../../stores/pane-store'
import { registerWebview, unregisterWebview, activeWebTabId } from './web-tab-controls'
import type { OverlayPayload, PaneNode } from '@shared/types'
import { WEBBAR_PARTITION } from '@shared/constants'

// 占位（PaneView 内）与实体（本层内）互认的 DOM 锚点；值本身写入字面量属性
export const WEB_TAB_PLACEHOLDER_ATTR = 'data-webtab-placeholder'
export const WEB_TAB_WRAPPER_ATTR = 'data-webtab-wrapper'

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
 * 网页页签的 webview 实体（单页签实例，访问栏 URL 与终端 Ctrl+点击共用）。
 * 挂在 WebTabLayer 常驻层（PaneView 内只有测位占位），partition 固定
 * persist:webbar（与 dsh web 隔离的浏览会话）；导航/弹窗由主进程
 * did-attach-webview 按 partition 分流锁定（仅 http/https）。标题经
 * page-title-updated 回写 store，页签显示页面标题而非裸 hostname；favicon 经
 * page-favicon-updated 由主进程代取转 data URI 回写（渲染层 CSP 只放行 data: 图）。
 * did-finish-load 时把最近一次主框架导航的落点 URL 记入「最近访问」历史（地址栏
 * 导航/redirect 后的最终地址同样入册；加载失败的 URL 不算访问过）。加载中/失败铺
 * 浮层提示（webview 无内建 UI，失败原先是纯白屏零反馈）。
 * 导航态（当前 URL / 前后可用 / 加载中）经 did-navigate 系事件回写 payload.nav，
 * WebPanel 地址栏与导航按钮消费；元素登记进 web-tab-controls 注册表，
 * 面板按钮与宿主/主进程快捷键经它对本页签下指令。
 */
const WebTabOverlay: React.FC<{ id: string; url: string; postToken?: string }> = ({ id, url, postToken }) => {
  const setWebTabTitle = usePaneStore(s => s.setWebTabTitle)
  const setWebTabFavicon = usePaneStore(s => s.setWebTabFavicon)
  const setWebTabNav = usePaneStore(s => s.setWebTabNav)
  const recordWebTabVisit = usePaneStore(s => s.recordWebTabVisit)
  const settleWebTabPost = usePaneStore(s => s.settleWebTabPost)
  const { t } = useTranslation()
  const ref = useRef<WebviewTag | null>(null)
  const postRequestedRef = useRef(false)
  // 最近一次主框架导航的落点 URL：历史记录与地址栏数据都吃它而非打开时的 url ——
  // redirect 链的每一跳都会触发 did-navigate，落点才是用户真正到达的地址
  const lastUrlRef = useRef('')
  // 加载态：webview 无内建 UI，失败=纯白屏零反馈（外站不可达与「没打开」无法
  // 区分）。loading 铺轻提示挡白闪，failed 铺错误浮层把 errno 直接亮出来
  const [loadState, setLoadState] = useState<'loading' | 'done' | 'failed'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)
  // src 按实例快照：POST 页签首航落定后 settleWebTabPost 会把 payload.url 改写为
  // 落点 —— 若 src 直读 prop，存活 webview 的 src 属性变化会再触发一次 GET 导航
  // 把刚登录的页面顶掉。普通页签 url 恒定，快照与原行为等价。
  // 常态下本组件存续期 = 页签存续期（常驻层不随拖动重挂）；万一异常重挂（开发态
  // StrictMode、层容器重建），POST 页签的令牌已被首航认领销毁，按 payload.url
  // GET 恢复落点（或打开 URL），不再重放正文
  const [initialSrc] = useState(() => (postToken ? 'about:blank' : url))

  // webview 注册表登记：面板按钮/快捷键经 web-tab-controls 对本页签下指令
  // （元素随 JSX 位置稳定，src 恒为打开时 URL 不触发重挂）
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    registerWebview(id, el)
    return () => unregisterWebview(id)
  }, [id])

  // 焦点激活所属 pane：点击网页不冒泡到宿主 DOM，activePaneId 不跟随 ——
  // 多分屏时快捷键/面板会打错页签。接两个可见信号：focusin（webview 元素
  // 获得焦点）与 window blur + activeElement（HtmlDoc 焦点陷阱同款反向利用）。
  // Electron 28 实测（探针验证）：guest→guest 焦点转移（点另一个 pane 的网页）
  // 既无 focusin 也无 window blur，只派发不冒泡的 focus —— 补 focus 监听兜住。
  // 幂等：已是活动 pane 不再 set，避免无谓重渲染
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const activate = (): void => {
      const st = usePaneStore.getState()
      const paneId = st.getOverlayPaneId(id)
      if (paneId && st.layout.activePaneId !== paneId) st.setActivePane(paneId)
    }
    const onWinBlur = (): void => {
      if (document.activeElement === el) activate()
    }
    el.addEventListener('focusin', activate)
    el.addEventListener('focus', activate)
    window.addEventListener('blur', onWinBlur)
    return () => {
      el.removeEventListener('focusin', activate)
      el.removeEventListener('focus', activate)
      window.removeEventListener('blur', onWinBlur)
    }
  }, [id])

  useLayoutEffect(() => {
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
      // 落点 URL 记历史（含 redirect 后的最终地址；地址栏导航同样走这里）。
      // 页内刷新/锚点跳转也会触发 did-finish-load，重复记录靠 store 去重
      if (postToken && !lastUrlRef.current) return // about:blank 引导页并非一次访问
      recordWebTabVisit(lastUrlRef.current || url)
    }
    // 导航态回写：地址栏显示与导航按钮可用性的数据源。did-navigate（顶层跳转）
    // 与 did-navigate-in-page（SPA pushState / 锚点）都跟 —— 子框架的页内事件
    // （isMainFrame=false）不跟。参数双读（事件自身属性 ?? detail，同 onTitle
    // 的 Electron 28 实测经验）。canGoBack/Forward 是同步 IPC
    // （guestViewInternal.invokeSync），主进程忙时可阻塞渲染层秒级 —— 只在本
    // 页签正处于活动态（地址栏正在消费）时读；后台页签只回写 url，停驻期间
    // 的前后可用性由 WebPanel 重新激活时补读
    const onNav = (e: Event): void => {
      const evt = e as CustomEvent<unknown> & { url?: string; isMainFrame?: boolean; detail?: { url?: string; isMainFrame?: boolean } }
      const url = evt.url ?? evt.detail?.url
      const isMainFrame = evt.isMainFrame ?? evt.detail?.isMainFrame
      if (isMainFrame === false) return
      if (!url) return
      if (postToken && url === 'about:blank') return
      // POST 首航落点即页签新身份：摘令牌 + payload.url 改写为落点（settle 后再调
      // 是 no-op，无需实例侧一次性标记）—— 异常重挂按落点 GET 恢复；主进程令牌
      // 认领即销毁、正文不重放（重放已提交的 POST 有二次提交风险，见
      // PendingWebbarPostStore 注）
      if (postToken) settleWebTabPost(id, url)
      lastUrlRef.current = url
      if (activeWebTabId() === id) {
        setWebTabNav(id, { url, canGoBack: el.canGoBack(), canGoForward: el.canGoForward() })
      } else {
        setWebTabNav(id, { url })
      }
    }
    // 加载遮罩 dom-ready 即收(主框架文档就绪、内容可渐进上屏),不等
    // did-stop-loading —— 后者要等全部子资源落定,一个慢三方资源(广告/统计/
    // 超时域)就能把不透明遮罩压 10-30s+,页面明明早已可交互却被盖死(实机
    // 探针:本地页 28ms 可画、遮罩整压 12s)。工具条的停止/刷新(activeNav
    // .loading)仍跟完整加载周期;failed 态不被冲掉(同 onStopLoading 的保序)
    const startPost = (): void => {
      if (!postToken || postRequestedRef.current) return
      let guestId: number
      try {
        if (el.getURL() !== 'about:blank') return
        guestId = el.getWebContentsId()
      } catch { return }
      postRequestedRef.current = true
      void window.electronAPI.loadWebTabPost(postToken, guestId).then(result => {
        if (result.success) return
        // 认领被拒（30s 过期 / guest 校验不过）。常态下常驻层不重挂、令牌只会被
        // 本实例认领一次，走到这里即令牌已失效：没有首航就没有 did-navigate，
        // 此处即终局 —— 摘除死令牌，防异常重挂再撞一次拒（重挂改按打开 URL
        // GET 回落；终局长相不变：本实例仍铺失败浮层）
        settleWebTabPost(id)
        setLoadError('POST navigation rejected')
        setLoadState('failed')
      }).catch(err => {
        settleWebTabPost(id)
        setLoadError(String(err))
        setLoadState('failed')
      })
    }
    const onDomReady = (): void => {
      // about:blank 只是 POST 页签的引导页；首航交给主进程，不把空白页当作加载完成。
      if (postToken && !postRequestedRef.current) { startPost(); return }
      setLoadState(prev => (prev === 'loading' ? 'done' : prev))
    }
    const onStartLoading = (): void => {
      setLoadState('loading')
      setLoadError(null)
      setWebTabNav(id, { loading: true })
    }
    // did-stop-loading 在成功/失败后都会到；失败浮层由 did-fail-load 先铺，
    // 这里收尾时保住 failed 不被冲掉
    const onStopLoading = (): void => {
      setLoadState(prev => (prev === 'failed' ? 'failed' : 'done'))
      setWebTabNav(id, { loading: false })
    }
    const onLoadFail = (e: Event): void => {
      const evt = e as CustomEvent<unknown> & {
        errorCode?: number; errorDescription?: string; isMainFrame?: boolean
      }
      // 子框架资源失败不铺满屏浮层；ERR_ABORTED(-3) 是重定向/中途取消的常态噪音
      if (evt.isMainFrame === false) return
      if (evt.errorCode === -3) return
      setLoadError(evt.errorDescription || (evt.errorCode !== undefined ? `ERR_${evt.errorCode}` : 'ERROR'))
      setLoadState('failed')
    }
    el.addEventListener('page-title-updated', onTitle)
    el.addEventListener('page-favicon-updated', onFavicon)
    el.addEventListener('dom-ready', onDomReady)
    el.addEventListener('did-finish-load', onLoadFinish)
    el.addEventListener('did-navigate', onNav)
    el.addEventListener('did-navigate-in-page', onNav)
    el.addEventListener('did-start-loading', onStartLoading)
    el.addEventListener('did-stop-loading', onStopLoading)
    el.addEventListener('did-fail-load', onLoadFail)
    // about:blank 很快完成时，dom-ready 可能早于监听器；方法面已就绪则补认领。
    startPost()
    return () => {
      el.removeEventListener('page-title-updated', onTitle)
      el.removeEventListener('page-favicon-updated', onFavicon)
      el.removeEventListener('dom-ready', onDomReady)
      el.removeEventListener('did-finish-load', onLoadFinish)
      el.removeEventListener('did-navigate', onNav)
      el.removeEventListener('did-navigate-in-page', onNav)
      el.removeEventListener('did-start-loading', onStartLoading)
      el.removeEventListener('did-stop-loading', onStopLoading)
      el.removeEventListener('did-fail-load', onLoadFail)
    }
  }, [id, url, postToken, setWebTabTitle, setWebTabFavicon, setWebTabNav, recordWebTabVisit, settleWebTabPost])

  return (
    <div className="relative w-full h-full">
      {/* Electron webview 专属属性，React 的通用 DOM 规则不认识。 */}
      {/* eslint-disable react/no-unknown-property */}
      <webview
        ref={ref}
        partition={WEBBAR_PARTITION}
        src={initialSrc}
        allowpopups=""
        className="w-full h-full"
      />
      {/* eslint-enable react/no-unknown-property */}
      {loadState === 'loading' && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--terminal-bg)] text-sm text-gray-400 pointer-events-none">
          {t('webBar.loading')}
        </div>
      )}
      {loadState === 'failed' && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-[var(--terminal-bg)]">
          <p className="text-sm text-gray-300">{t('webBar.loadFailed')}</p>
          <p className="max-w-[80%] truncate font-mono text-xs text-gray-500">
            {t('webBar.loadFailedHint', { error: loadError ?? 'ERROR', url })}
          </p>
        </div>
      )}
    </div>
  )
}

/** 常驻层清单条目：布局树里全部网页页签（含隐藏），附宿主 pane 与激活态 */
export interface WebTabLayerEntry {
  id: string
  paneId: string
  active: boolean
  url: string
  postToken?: string
}

/** 收集布局树里全部网页页签（树序）—— 常驻层渲染清单的纯函数。 */
export function collectWebTabEntries(
  root: PaneNode,
  payloads: Record<string, OverlayPayload | undefined>
): WebTabLayerEntry[] {
  const out: WebTabLayerEntry[] = []
  const walk = (node: PaneNode): void => {
    if (node.type === 'split') {
      walk(node.firstChild)
      walk(node.secondChild)
      return
    }
    for (const ref of node.overlays) {
      const p = payloads[ref.id]
      if (p && p.kind === 'web') {
        out.push({
          id: ref.id,
          paneId: node.id,
          active: ref.active,
          url: p.url,
          ...(p.postToken ? { postToken: p.postToken } : {})
        })
      }
    }
  }
  walk(root)
  return out
}

export interface WebTabRect { left: number; top: number; width: number; height: number }

/** 占位矩形换算成相对常驻层容器的实体矩形 —— 拖动/拆分只改坐标，webview 不重挂。 */
export function webTabWrapperRect(base: WebTabRect, placeholder: WebTabRect): WebTabRect {
  return {
    left: placeholder.left - base.left,
    top: placeholder.top - base.top,
    width: placeholder.width,
    height: placeholder.height
  }
}

/**
 * 网页页签常驻层 —— 拖动不再销毁页面（POST 结果页与普通页签通用）。
 *
 * 网页页签的 <webview> 实体不再挂进 pane 树（PaneView 只渲染测位占位），统一挂
 * 本层，按宿主 pane 占位矩形绝对定位。跨分屏拖动/拆分只改 store 挂载点，本层
 * 按 overlay id 键控不重挂 → webview 存续期与页签一致：POST 加载中拖动请求照常
 * 在原 webview 里完成（无重放、无二次提交），结果页原样保留，普通页签不再退回
 * 打开时 URL。页签关闭时清单移除、实体随之卸载（真正的销毁点）。
 *
 * 层级纪律（z 阶梯，改动前先读）：
 * - 本层 z-[15]：盖过 pane 内容（终端 1 / 覆盖层 10），被 pane 内拖拽盾（z-20）
 *   压住 —— webview 是独立浏览上下文会吞宿主 dragover/drop，拖拽期间全 pane 的
 *   盾必须始终压住本层，事件才能冒泡给 pane 落区判定；落区指示器相应提到 z-30。
 * - 之上是既有窗口级 UI：边框/命中条 z-40、模态 z-50、悬浮提示 z-[300]。
 * - 生效前提：terminal-wrapper → 分屏树 → 拖拽盾沿途不得引入层叠上下文
 *   （transform / filter / opacity<1 / will-change / 带 z-index 的定位），否则
 *   盾压不住 webview，网页上方的拖拽落区失效。PaneView / SplitPaneContainer
 *   现状均无层叠上下文，改动时留意。
 *
 * 定位同步：占位矩形由 ResizeObserver（容器 + 各占位）与布局树引用变化（等尺寸
 * 换位不产生尺寸事件）驱动；useLayoutEffect 在绘制前追平，首帧不闪空。
 */
const WebTabLayer: React.FC = () => {
  const layout = usePaneStore(s => s.layout)
  const overlayPayloads = usePaneStore(s => s.overlayPayloads)
  const containerRef = useRef<HTMLDivElement>(null)
  const entries = useMemo(() => collectWebTabEntries(layout.root, overlayPayloads), [layout, overlayPayloads])
  // 同步回调经 ref 读最新清单：payload 高频回写（标题/导航态/favicon）只重渲染
  // 实体 props，不重建 ResizeObserver
  const entriesRef = useRef(entries)
  entriesRef.current = entries
  // 清单按 id + 宿主 pane 变化（开/关页签、跨 pane 拖动换挂载点）才重建观察 ——
  // 换 pane 后占位是新的 DOM 节点，观察器必须重挂到新节点上；active 显隐走渲染路径
  const entryIdsKey = entries.map(e => `${e.id}@${e.paneId}`).join('\u0000')

  const sync = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    const base = container.getBoundingClientRect()
    for (const entry of entriesRef.current) {
      const wrapper = document.querySelector<HTMLElement>(`[${WEB_TAB_WRAPPER_ATTR}="${entry.id}"]`)
      const placeholder = document.querySelector<HTMLElement>(`[${WEB_TAB_PLACEHOLDER_ATTR}="${entry.id}"]`)
      if (!wrapper || !placeholder) continue
      const r = placeholder.getBoundingClientRect()
      const rect = webTabWrapperRect(base, { left: r.left, top: r.top, width: r.width, height: r.height })
      wrapper.style.left = `${rect.left}px`
      wrapper.style.top = `${rect.top}px`
      wrapper.style.width = `${rect.width}px`
      wrapper.style.height = `${rect.height}px`
    }
  }, [])

  // 布局树任何编辑（含等尺寸换位、active 切换引发的挂载点变动）都重测一次
  useLayoutEffect(() => { sync() }, [sync, layout])

  useLayoutEffect(() => {
    sync()
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver(() => sync())
    observer.observe(container)
    for (const entry of entriesRef.current) {
      const placeholder = document.querySelector(`[${WEB_TAB_PLACEHOLDER_ATTR}="${entry.id}"]`)
      if (placeholder) observer.observe(placeholder)
    }
    return () => observer.disconnect()
  }, [sync, entryIdsKey])

  return (
    <div ref={containerRef} className="absolute inset-0 z-[15] pointer-events-none">
      {entries.map(entry => (
        <div
          key={entry.id}
          data-webtab-wrapper={entry.id}
          className="absolute"
          style={{
            visibility: entry.active ? 'visible' : 'hidden',
            pointerEvents: entry.active ? 'auto' : 'none'
          }}
        >
          <WebTabOverlay id={entry.id} url={entry.url} postToken={entry.postToken} />
        </div>
      ))}
    </div>
  )
}

export default WebTabLayer
