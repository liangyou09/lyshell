import { PanelHeader } from './PanelHeader'
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import cn from 'classnames'
import { useTranslation } from 'react-i18next'
import type { WebviewTag } from 'electron'
import { usePaneStore, normalizeWebBarUrl } from '../../stores/pane-store'
import { useUiStore } from '../../stores/ui-store'
import { usePluginStore } from '../../stores/plugin-store'
import { matchesPluginWebOrigin, uniquePluginWebOrigins } from '@shared/plugin-web-resources'
import { TOPBAR_HEIGHT } from './topbar-metrics'
import { WebTabFavicon } from './PaneTabBar'
import {
  selectActiveWebTabId, navigateActiveWebTab, stopActiveWebTab,
  activeWebTabGoBack, activeWebTabGoForward, getWebview,
  registerMiniWebview, unregisterMiniWebview
} from './web-tab-controls'
import { ScrollTie } from './ScrollFold'
import { IconBtn } from './IconBtn'
import { useDismiss } from '../../hooks'
import { WEBBAR_PARTITION } from '@shared/constants'
import WebLoadError from './WebLoadError'
import { webLoadFailureFromEvent, type WebLoadFailure } from './web-load-error'
import { browserAddress, BROWSER_NEW_TAB_URL } from '@shared/browser-settings'
import { useBrowserSettingsStore } from '../../stores/browser-settings-store'
import { matchWebTabShortcut } from '@shared/webtab-shortcut'
import { normalizeBookmarkUrl, useBrowserBookmarksStore } from '../../stores/browser-bookmarks-store'
import { useBrowserDownloads } from '../../stores/browser-downloads-store'
import BrowserDownloads from './BrowserDownloads'
import BrowserAddressField from './BrowserAddressField'
import './WebPanel.css'

/** 地址候选缺少收藏名称时使用主机名；历史行保留完整网址。 */
function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

// 历史行 favicon 的回落猜测:多数站点在根路径放 /favicon.ico。按 origin 缓存 Promise
// (成功/失败都缓存,本次会话不重试 —— 猜测是尽力而为,不该反复打网络)。
const originFaviconCache = new Map<string, Promise<string | null>>()

// 并发闸:历史列表首帧渲染会按 origin 逐行触发猜测,30 条历史不该 30 个请求同时
// 在飞。FIFO 队列限 3 并发;排队中也计数,后来者看到满员直接排到队尾不插队。
const GUESS_MAX_INFLIGHT = 3
let guessInflight = 0
const guessQueue: Array<() => void> = []
async function withGuessSlot<T>(task: () => Promise<T>): Promise<T> {
  guessInflight++
  if (guessInflight > GUESS_MAX_INFLIGHT) {
    await new Promise<void>(resolve => guessQueue.push(resolve))
  }
  try {
    return await task()
  } finally {
    guessInflight--
    const next = guessQueue.shift()
    if (next) next()
  }
}

function guessOriginFavicon(url: string): Promise<string | null> {
  let origin: string
  try {
    origin = new URL(url).origin
  } catch {
    return Promise.resolve(null)
  }
  const cached = originFaviconCache.get(origin)
  if (cached) return cached
  const p: Promise<string | null> = withGuessSlot(() =>
    window.electronAPI
      .fetchFavicon(`${origin}/favicon.ico`)
      .then(r => (r.success ? r.dataUri : null))
      .catch(() => null)
  )
  originFaviconCache.set(origin, p)
  return p
}

/** 线稿图标底座 —— 本文件所有 lucide 风格图标的统一外壳:24 viewBox、stroke
 *  随 currentColor、圆帽圆角,描边随渲染尺寸反比提粗(小尺寸细线发虚 ——
 *  顶栏 18px 档 2.5、感知 ~1.88px,12px 档 2、感知 1px:提粗只落在
 *  铭牌行的 lg 档,小窗工具条原样)。各图标只写路径,不再各自拼 svg 属性 */
const Glyph: React.FC<{ size?: number; children: React.ReactNode }> = ({ size = 12, children }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={size >= 14 ? 2.5 : 2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    {children}
  </svg>
)

/** 导航图标组(lucide 线稿风格)——后退/前进/停止。size 供铭牌行(IconBtn
 *  lg 档)放大到 18,缺省 12 = 小窗工具条原尺 */
/** 后退/前进使用与活动轨一致的 chevron；18px 档占高 13.5px，
 *  与刷新图标保持相近的视觉份量。小窗仍由 size=12 缩放。 */
const ChevronLeftIcon: React.FC<{ size?: number }> = ({ size = 12 }) => (
  <Glyph size={size}>
    <path d="m17 3-10 9 10 9" />
  </Glyph>
)
const ChevronRightIcon: React.FC<{ size?: number }> = ({ size = 12 }) => (
  <Glyph size={size}>
    <path d="m7 3 10 9-10 9" />
  </Glyph>
)
const StopIcon: React.FC<{ size?: number }> = ({ size = 12 }) => (
  <Glyph size={size}>
    {/* 圆角提到 2(浏览器 stop 的读形):描边 2.5 下 rx1 已被吃成直角,
        rx2 恰好保住一点软边 */}
    <rect width="13" height="13" x="5.5" y="5.5" rx="2" />
  </Glyph>
)
const BookmarkIcon: React.FC<{ filled?: boolean; size?: number }> = ({ filled, size = 14 }) => (
  <Glyph size={size}>
    <path fill={filled ? 'currentColor' : 'none'} d="m12 3 2.78 5.63L21 9.54l-4.5 4.39 1.06 6.2L12 17.2l-5.56 2.93 1.06-6.2L3 9.54l6.22-.91L12 3Z" />
  </Glyph>
)

/** 导航按钮 —— 18px 图标钮（对齐面板既有图标钮规格），disabled 走 40% 透明度 */
const NavButton: React.FC<{
  title: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}> = ({ title, disabled, onClick, children }) => (
  <button
    type="button"
    title={title}
    disabled={disabled}
    onClick={onClick}
    className="w-[18px] h-[18px] flex-shrink-0 flex items-center justify-center text-[var(--text-rack)] hover:text-[var(--amber)] hover:bg-[var(--bg-slot)] disabled:opacity-40 disabled:hover:text-[var(--text-rack)] disabled:hover:bg-transparent disabled:cursor-default rounded-[2px] cursor-pointer transition-colors"
  >
    {children}
  </button>
)

// 窄栏保留题名、前后导航与停止钮，设置和主页收进更多菜单。
const WEBBAR_NAMEPLATE_COMPACT_WIDTH = 280

// ===== 写轮眼小窗（栏底迷你浏览器）的持久化与几何常量 =====
// 高度走 config（键名/防抖/夹取对齐会话面板 fileManagerHeight 的栏底语法）；上次
// 浏览地址走 localStorage 镜像 —— 重开面板即恢复原页,小窗是「常在的地方」而非表单
const MINI_HEIGHT_KEY = 'webMiniHeight'
const MINI_CLOSED_KEY = 'webMiniClosed'
const MINI_URL_STORAGE_KEY = 'lyshell.webbarMini.url.v1'
// 高度语义 = 双开画轴装配总高(上下双辊 20 + 裱边 8 + 画心):旧存档值(纯纸
// 幅语义)经 clampMiniHeight 下限自愈上抬;默认 228 与 138 保画心(200/110)
// 与旧默认/旧下限同尺寸 —— 细棍化收 12 画心不动,裱边减半再收 8(旧档画心
// 随之各得 8px)
const MINI_DEFAULT_HEIGHT = 228  // 双辊 20 + 裱边 8 + 工具条 32 + 浏览面 168(旧默认的浏览面)
const MINI_MIN_HEIGHT = 138      // 双辊 20 + 裱边 8 + 工具条 32 + 网页可视 ~78px 的下限(旧下限 110 的同等内容)
// 小窗装配高度上限的两个口径,同一目标:装配顶缘离根顶恒占 = 铭牌
// TOPBAR_HEIGHT + 地址栏 44 + 历史留座 120(卡头+两行余量)。
// 根高口径(MINI_RESERVE_HEIGHT):拖动 clamp(onMiniDividerPointerMove 的
// rootRef rect)与根高观察钳量的是根元素 —— rect 含头行,减全量;
// 壳内口径(MINI_SHELL_RESERVE_HEIGHT):装配的 CSS maxHeight 以内容壳为
// 含块(壳从头行之下起排,100% 不含 TOPBAR_HEIGHT),只减 44+120 ——
// 2026/09/29 修正:装配随内容壳入栏后 CSS 仍减全量,顶栏被扣两次,
// 矮窗口/拖到上限时装配比计算值矮一档顶栏、画心被裁。
// 历史座是设计裁量非布局硬限(卡内自滚,还能更矮),整把故为粗钳:拖动
// 上限已精确锚装配底缘(rootRef 底缘,见 onMiniDividerPointerMove),要再
// 精确须逐帧量上方实高,粗防线保底即可
const MINI_SHELL_RESERVE_HEIGHT = 44 + 120
const MINI_RESERVE_HEIGHT = TOPBAR_HEIGHT + MINI_SHELL_RESERVE_HEIGHT
const MINI_ABS_MAX_HEIGHT = 4000 // 存档值绝对上限（防手改 config 的离谱值；运行期布局上限另由渲染期 maxHeight 钳）
const MINI_ROLLED_H = 20         // 收起叠高:上下双卷 10×2(与 SessionsPanel 的 DUAL_ROLLED_H 同族几何)

/** 小窗高度统一夹取（config 恢复与拖动共用同一逻辑）：整数像素，免半像素渲染。
 *  max 小于 MIN（面板未布局/极矮）时 MIN 兜底 —— 恢复值只可能被夹小不会被夹死 */
const clampMiniHeight = (v: number, max = MINI_ABS_MAX_HEIGHT): number =>
  Math.round(Math.max(MINI_MIN_HEIGHT, Math.min(max, v)))

/** webview 方法面调用收口：loadURL/reload/goBack 等返回 Promise，元素已卸载或
 *  导航竞态的拒绝是常态噪音 —— 吞掉不上未处理拒绝；jsdom 桩返回 undefined 同样
 *  兼容（非 Promise 直接放过），同步抛错也兜一道（未就绪窗口的理论防线，
 *  调用点已门在 miniReady，这里不重复门）。吞归吞，留一条 console.warn 落地
 *  痕迹 —— 异常路径真发生时 devtools 里有迹可循，不至于无声无息难排查 */
const settleWebview = (task: () => unknown): void => {
  try {
    const r = task()
    if (r instanceof Promise) {
      r.catch(err => console.warn('[WebPanel] webview call rejected:', err))
    }
  } catch (err) {
    console.warn('[WebPanel] webview call threw:', err)
  }
}

/** 勾玉开眼指示 —— 小窗工具条 leading 状态灯：未浏览 = faint（闭眼），有页面 =
 *  text-rack 点亮（开眼，与活动轨 web 槽位激活同一状态语言）。13px 下细节收敛为
 *  眼眶 + 瞳孔 + 三枚勾玉圆点（尾迹在此尺寸不可读，略去）。 */
const MiniEyeGlyph: React.FC<{ lit: boolean; label: string; size?: number }> = ({ lit, label, size = 13 }) => (
  <span
    role="img"
    aria-label={label}
    title={label}
    className={cn(
      'flex-shrink-0 flex items-center justify-center transition-colors',
      lit ? 'text-[var(--text-rack)]' : 'text-[var(--text-rack-faint)]'
    )}
  >
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="12" cy="12" r="10.5" />
      <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="4.9" r="2.1" fill="currentColor" stroke="none" />
      <g transform="rotate(120 12 12)"><circle cx="12" cy="4.9" r="2.1" fill="currentColor" stroke="none" /></g>
      <g transform="rotate(240 12 12)"><circle cx="12" cy="4.9" r="2.1" fill="currentColor" stroke="none" /></g>
    </svg>
  </span>
)

/** 升格图标(lucide external-link 线稿风格)——把小窗当前页开成完整网页页签 */
const PromoteIcon: React.FC<{ size?: number }> = ({ size = 12 }) => (
  <Glyph size={size}>
    <path d="M13 4h7v7" />
    <path d="M20 4 9 15" />
    <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </Glyph>
)

/** 小窗打开图标(lucide picture-in-picture 线稿风格)——历史行「在小窗打开」按钮:
 *  外屏 + 右下小窗,读作「在下方小窗里打开」 */
const MiniOpenIcon: React.FC<{ size?: number }> = ({ size = 12 }) => (
  <Glyph size={size}>
    <path d="M21 9V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4" />
    <rect x="12" y="13" width="9" height="7" rx="1" />
  </Glyph>
)

/** 关页图标(lucide x 线稿风格)——关闭小窗当前页,回到未开眼空态 */
const XIcon: React.FC<{ size?: number }> = ({ size = 12 }) => (
  <Glyph size={size}>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </Glyph>
)

/** 垃圾桶图标(lucide trash 线稿风格)——「清空」按钮用;size 同导航图标组
 *  (铭牌行 14,缺省 12)。素桶:不画桶内两道竖线(那是 trash-2 的进阶细节,
 *  14px 下两线只隔 ~2.3px,描边一提粗就糊成一团脏斑)—— 桶口横梁 + 桶身 +
 *  提手三笔,小尺寸读形干净 */
const TrashIcon: React.FC<{ size?: number }> = ({ size = 12 }) => (
  <Glyph size={size}>
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <path d="M10 10v7M14 10v7" />
  </Glyph>
)

/** 溢出菜单钮(lucide more-horizontal 线稿风格)—— 设置、主页与清空入口;
 *  三点走实心圆(1 半径描边在 14px 下只剩亚像素点,填色才读得出「省略号」) */
const MoreIcon: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <Glyph size={size}>
    <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />
  </Glyph>
)

/**
 * 历史行 favicon:优先取持久化映射(打开网页页签时捕获的官方 favicon),
 * 没有再回落猜 origin/favicon.ico；两者都没有则显示通用网页图标。
 * url/favicon 变化先清旧 src，避免复用组件时残留上一条 URL 的图标。
 */
const RecentFavicon: React.FC<{ url: string; favicon?: string }> = ({ url, favicon }) => {
  const [src, setSrc] = useState<string | null>(favicon ?? null)
  useEffect(() => {
    if (favicon) {
      setSrc(favicon)
      return
    }
    setSrc(null)
    let alive = true
    void guessOriginFavicon(url).then(uri => {
      if (alive && uri) setSrc(uri)
    })
    return () => {
      alive = false
    }
  }, [url, favicon])
  if (!src) return <Glyph size={14}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18" /></Glyph>
  return <WebTabFavicon src={src} />
}

/**
 * 网页访问面板(机柜左列 Web 页签)。
 * 双模式:活动分屏正显示网页页签时是「浏览器 chrome」—— 地址栏同步当前 URL
 * (payload.nav,did-navigate 回写)、Enter 就地导航、后退/前进/停止
 * 按钮住铭牌行(IconBtn,指令经 web-tab-controls 落到活动页签);否则是「启动器」
 * —— 顶部 URL 栏输入完整网址,以终端页签形式打开在活动分屏(多页签,类似 dsh
 * Web 页签),打开的网页一律走终端页签栏切换/关闭,面板不再列清单。
 * 下方是「最近访问」历史(localStorage 持久化,pane-store webTabHistory)，
 * 按最近访问顺序平铺，不按域名重排。点击重开、Ctrl+点击或行上按钮在小窗
 * 预览；支持收藏和删除单条，更多菜单清空历史，地址栏提供最近访问与收藏补全。
 * URL 归一化/校验在 pane-store 的 normalizeWebBarUrl;webview 的导航/弹窗由主进程
 * 按 persist:webbar partition 分流锁定(仅 http/https,见 main/index.ts)。
 *
 * 栏底是「写轮眼小窗」—— 模拟会话面板文件管理器的栏底语法(4px 拖高条 + config
 * 持久化高度)的迷你浏览器:不动用终端分屏的快速查阅面,历史行上的
 * 「在小窗打开」按钮或 Ctrl+点击历史行在此预览,↗ 升格为完整网页页签,✕ 关页回空态(guest 销毁、localStorage 存档清掉);
 * webview 与完整网页页签共用 partition persist:webbar
 * (cookie/localStorage 同仓,登录态互通 —— 页签里登过小窗即登录态),F5 刷新小窗自身，
 * 其余快捷键不转发到活动完整页签(经 dom-ready 登记 webContentsId 区分，见
 * main/index.ts),上次地址 localStorage 恢复。
 * webview 保活:本面板经 MainWindow 的 webPanelAlive 门首次激活后常挂载,此后
 * 切机柜页签只 display:none 隐藏、合卷只由纸(overflow:hidden)裁掉画心 ——
 * webview 元素不摘树 guest 即存活,页面状态(滚动/表单/SPA 内存态)跨开合与
 * 切换保留,localStorage 仅作冷启动首航地址。visible=false 即隐藏态,组件本身
 * 不卸载。
 *
 * 样式沿用面板令牌(--bg-elev/--bg-slot/--rule/--amber/--text-rack*)与
 * [font-family:inherit] 12px 基线,头条与 SessionsPanel/PluginPanel 同构。
 */
const WebPanel: React.FC<{ visible?: boolean; onOpenSettings?: () => void }> = ({ visible = true, onOpenSettings }) => {
  const { t } = useTranslation()
  const browserSettings = useBrowserSettingsStore(s => s.settings)
  const browserLoaded = useBrowserSettingsStore(s => s.loaded)
  const browserError = useBrowserSettingsStore(s => s.error)
  const openWebTab = usePaneStore((s) => s.openWebTab)
  const webTabHistory = usePaneStore((s) => s.webTabHistory)
  const webTabFavicons = usePaneStore((s) => s.webTabFavicons)
  const bookmarks = useBrowserBookmarksStore(s => s.bookmarks)
  const addBookmark = useBrowserBookmarksStore(s => s.addBookmark)
  const removeBookmark = useBrowserBookmarksStore(s => s.removeBookmark)
  const [listView, setListView] = useState<'recent' | 'bookmarks' | 'downloads'>('recent')
  const { downloads } = useBrowserDownloads()
  const activeDownloads = downloads.filter(item => item.active).length
  const bookmarkUrls = useMemo(() => new Set(bookmarks.map(item => item.url)), [bookmarks])
  const addressSuggestions = useMemo(() => {
    const titles = new Map(bookmarks.map(item => [item.url, item.title]))
    return Array.from(new Set([...webTabHistory, ...bookmarks.map(item => item.url)]))
      .map(url => ({ url, title: titles.get(url) || hostOf(url) }))
  }, [webTabHistory, bookmarks])
  const isBookmarked = (url: string): boolean => bookmarkUrls.has(normalizeBookmarkUrl(url) ?? '')
  const toggleBookmark = (url: string, title?: string): void => {
    const page = Object.values(usePaneStore.getState().overlayPayloads).find(item => item.kind === 'web' && normalizeBookmarkUrl(item.nav?.url ?? item.url) === normalizeBookmarkUrl(url))
    const result = isBookmarked(url) ? removeBookmark(url) : addBookmark(url, title || (page?.kind === 'web' ? page.title : undefined))
    setNotice(result.success ? null : t(`webBar.${result.error === 'storageFailed' ? 'bookmarkSaveFailed' : 'invalid'}`))
  }
  const removeWebTabHistory = usePaneStore((s) => s.removeWebTabHistory)
  const clearWebTabHistory = usePaneStore((s) => s.clearWebTabHistory)
  const setWebTabNav = usePaneStore((s) => s.setWebTabNav)
  const [webBarInput, setWebBarInput] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  // ───── 写轮眼小窗（栏底迷你浏览器）─────
  const recordWebTabVisit = usePaneStore((s) => s.recordWebTabVisit)
  const [miniHeight, setMiniHeight] = useState(MINI_DEFAULT_HEIGHT)
  const [miniResizing, setMiniResizing] = useState(false)
  const [miniClosed, setMiniClosed] = useState(false)
  // null = 未开眼（空态指引，不挂 webview）；有值 = 当前浏览地址（did-navigate 回写落点，
  // redirect 后的真实地址而非输入原值）。冷启动从 localStorage 恢复上次页面作首航 ——
  // 保活下全 session 仅此一次真导航，切机柜页签/合卷/回切都零重载，像「常驻的地方」
  // 而不是每次重填的表单
  const [miniUrl, setMiniUrl] = useState<string | null>(() => {
    const config = useBrowserSettingsStore.getState()
    if (!config.loaded || config.error || !config.settings.restoreMini) return null
    try {
      const v = localStorage.getItem(MINI_URL_STORAGE_KEY)
      // 前缀门 + normalizeWebBarUrl 双校验：存档只可能来自归一化后的地址或导航
      // 落点（必带 scheme），裸词按毒数据直接落空态；前缀对但畸形的值（手改/
      // 旧格式残留，如 'https://' 空 host）在 normalize 处解析失败 → 同样落回
      // 未开眼，而不是挂一个注定失败的 src 去等失败反馈。归一化成功的存档
      // 顺手自愈（miniUrl 变化触发下方存档 effect 重写）
      if (!v || !/^https?:\/\//.test(v)) return null
      return normalizeWebBarUrl(v) || null
    } catch { return null }
  })
  const [miniInput, setMiniInput] = useState(miniUrl ?? '')
  const miniRestoreChecked = useRef(browserLoaded && !browserError)
  useEffect(() => {
    if (!browserLoaded || browserError || miniRestoreChecked.current) return
    miniRestoreChecked.current = true
    if (!browserSettings.restoreMini) return
    try {
      const saved = localStorage.getItem(MINI_URL_STORAGE_KEY)
      const url = saved && /^https?:\/\//.test(saved) ? normalizeWebBarUrl(saved) : null
      if (url) { setMiniUrl(url); setMiniSrc(url); setMiniInput(url) }
    } catch { /* 恢复失败保留空页 */ }
  }, [browserLoaded, browserError, browserSettings.restoreMini])
  const [miniLoading, setMiniLoading] = useState(false)
  // 加载遮罩与 miniLoading(工具条停止钮跟的完整加载周期)分离:遮罩 dom-ready
  // 即收 —— did-stop-loading 要等全部子资源(广告/统计/慢图)落定,真实站点上
  // 一个慢三方资源就把不透明遮罩压 10-30s+,而页面内容 commit 后几十毫秒已可
  // 渐进上屏(实机探针:本地页 28ms 可画、遮罩整压 12s)。工具条停止钮仍跟
  // miniLoading,慢资源期间仍可点停
  const [miniCovering, setMiniCovering] = useState(false)
  const [miniFailed, setMiniFailed] = useState<WebLoadFailure | null>(null)
  const [miniNav, setMiniNav] = useState({ canGoBack: false, canGoForward: false })
  // webview 元素经回调 ref 落 state：只有开眼后才挂载，事件/导航 effect 以它为 dep
  const [miniEl, setMiniEl] = useState<WebviewTag | null>(null)
  // dom-ready 门：webview 的方法面（getURL/loadURL/canGoBack…）在 guest 挂载、
  // dom-ready 触发之前一律抛错（Electron WebViewElement 硬约束；jsdom 桩测不出,
  // 真机挂载当拍调 getURL 会直接炸）—— 所有元素方法调用都门在它后面
  const [miniReady, setMiniReady] = useState(false)
  // 挂载 src 冻结值：webview 一旦挂载 src 恒不变（React 只在值变时才动 DOM 属性，
  // 后续导航全走 loadURL —— 同完整页签「src 永不变」纪律），首航地址在此定格；
  // 挂载即带 src 也绕开「无 src 的 webview 是否触发 dom-ready」的不确定面。
  // 保活下元素不重挂，冻结值只在挂载前有意义 —— 未挂载期由 loadMini 同步跟随
  // miniUrl（见 loadMini），保证首航即目标地址、不白拉一次旧存档页
  const [miniSrc, setMiniSrc] = useState<string | null>(miniUrl)
  // 最近一次主框架导航落点（WebTabOverlay 的 lastUrlRef 同款）：初始化为挂载目标，
  // onNav 每次覆写 —— did-finish-load 记历史吃它而非 getURL()，事件回调一律
  // 不碰方法面，也不赌 did-finish-load 与 dom-ready 的时序（ref 无闭包陈旧问题）
  const miniLastUrlRef = useRef<string>(miniUrl ?? '')
  const miniTitleRef = useRef('')
  const miniInputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // 浏览器 chrome 模式判定:活动 pane 的活动覆盖层是网页页签时,本面板从
  // 「开新页签的启动器」切换为「该页签的地址栏 + 导航按钮」(判定收敛在
  // selectActiveWebTabId —— 快照安全,与指令路由共用同一定义)
  const activeWebTabId = usePaneStore(selectActiveWebTabId)
  // 活动网页页签的 payload(地址栏显示数据源;对象引用随 store set 稳定)
  const activeWebTab = usePaneStore((s) =>
    activeWebTabId !== null ? s.overlayPayloads[activeWebTabId] : undefined)
  const activeNav = activeWebTab?.kind === 'web' ? activeWebTab.nav : undefined
  const activeUrl = activeWebTab?.kind === 'web' ? activeWebTab.url : undefined
  // 当前 URL:导航回写优先,首航未完成(nav 缺省)回落打开时 URL
  const displayUrl = activeUrl === BROWSER_NEW_TAB_URL ? '' : activeNav?.url ?? activeUrl ?? ''

  const inputRef = useRef<HTMLInputElement>(null)

  // 地址栏编辑标记:用户改动输入为 true,Enter 提交/Esc 放弃/切换活动页签时
  // 清 —— 跟随导航的回写不得覆盖进行中的编辑(Chrome omnibox 对后台导航同样
  // 保留输入;此前无守卫,redirect/SPA 跳转会冲掉打到一半的地址)
  const editingRef = useRef(false)

  // 切换活动页签 = 新的编辑上下文:先清标记(本 effect 先于下方跟随 effect
  // 声明,同批提交按声明序跑),再由跟随 effect 同步新页签 URL —— 草稿不跨
  // 页签保留是浏览器惯例;退出浏览器模式不重置,保留最后 URL,启动器模式
  // Enter 即「以该地址重开新页签」
  useEffect(() => {
    editingRef.current = false
  }, [activeWebTabId])

  useEffect(() => {
    if (activeWebTabId !== null && !editingRef.current) setWebBarInput(displayUrl)
  }, [activeWebTabId, displayUrl])

  // Ctrl+L 聚焦请求(ui-store 请求令牌):请求与「切到 Web 面板/展开侧栏」
  // 同批提交,本 effect 在提交后才跑 —— 面板必然已挂载且脱离 inert(侧栏
  // 收起时整体 inert,旧事件+pending+rAF 重试三件套在提交竞态下会静默丢失)。
  // 消费后归零,二次进页签不误聚焦
  const webBarFocusRequest = useUiStore((s) => s.webBarFocusRequest)
  useEffect(() => {
    if (!webBarFocusRequest) return
    inputRef.current?.focus()
    inputRef.current?.select()
    useUiStore.getState().consumeWebBarFocusRequest()
  }, [webBarFocusRequest])

  // 值同步后保住全选:Ctrl+L 的挂载路径里,聚焦/全选 effect 与值回写同批跑,
  // 提交前输入还是空串 —— select() 落在空值上,值落定后光标被推到末尾(没有
  // 全选)。输入持有焦点且非编辑态时值一变就补一次全选:Chrome omnibox 同款,
  // 未编辑时 URL 更新保持全选;启动器模式点击落位不受影响(follow 不写值)
  useEffect(() => {
    const el = inputRef.current
    if (el && document.activeElement === el && !editingRef.current) el.select()
  }, [webBarInput])

  // 重新激活活动页签时补读前后可用性:onNav 只在页签处于活动态时同步读
  // canGoBack/canGoForward(同步 IPC,后台页签的高频导航不该冻结渲染层),
  // 停驻期间导航留下的旧值在此刻校正;页签刚开、元素尚未注册(挂载竞态)
  // 时跳过 —— 首次 did-navigate 会带全量 nav
  // 注册发生在 WebTabOverlay 的 useLayoutEffect(提交期),远早于 guest 的
  // dom-ready;而 canGoBack/Forward 在 dom-ready 前调用会抛(小窗的 miniReady
  // 门与 registerWebbarMini 注释同一规则)。冷启动恢复布局 / 页签重挂后本
  // effect 拿到的是「已注册未就绪」元素 —— try/catch 跳过,nav 同样留给首次
  // did-navigate 补全。此处曾是全局黑屏元凶:effect 内同步抛 → 无边界时
  // 整棵 React 树卸载,只剩深色 body(进程存活、日志干净)。
  useEffect(() => {
    if (activeWebTabId === null) return
    const el = getWebview(activeWebTabId)
    if (!el) return
    try {
      setWebTabNav(activeWebTabId, { canGoBack: el.canGoBack(), canGoForward: el.canGoForward() })
    } catch { /* dom-ready 未到,guest 方法面未就绪 */ }
  }, [activeWebTabId, setWebTabNav])

  // 小窗高度/关闭态:config 异步对账 + 500ms 防抖双写(fileManagerHeight 同款栏底语法)。
  // 恢复值走与拖动同一把 clampMiniHeight:Number.isFinite 拦 NaN/Infinity,typeof
  // 拦字符串数字,夹取拦过小/离谱过大 —— 恢复时面板多半尚未布局,量不到
  // rect.height,「当前布局上限」由渲染期 maxHeight(见 JSX)承担。
  // 对账落定前不挂 webview(miniConfigLoaded 门):存档 closed=true 时若先按
  // 默认 false 渲染,首帧即挂 webview 拉起 guest 进程抓一次页面再拆 ——
  // 闪现 + 白费一次真实导航(面板常挂载后,本门与「未开卷不挂」的
  // miniContentMounted 合流扛这道防线)
  const [miniConfigLoaded, setMiniConfigLoaded] = useState(false)
  // 双开画轴内容挂载裁决:首次开卷即挂(工具条/浏览面随纸展开),此后常驻不卸载
  // (保活,机械见下方 effect 与组件 docstring)。与 FM 不同,
  // 本体(工具条/空态)不受 config 门控(面板挂载即同步可交互,行为对齐旧
  // 代码);冷启动 closed 存档的闪挂防线只压在 webview 自己的门上(见 JSX)
  // 写门(读档成功才置 true):存档 closed=true 时 state 初值是默认 false,若允许
  // 未读档就写,防抖 500ms 会把 false 落盘、读档未落定即卸载时补写也会把 false
  // 落盘 —— 两条路都会冲掉存档的 true。config 读取失败时门保持关:回落默认
  // 渲染但不写,存档留给下次可读时用
  const miniConfigReadRef = useRef(false)
  useEffect(() => {
    window.electronAPI?.getConfig(MINI_HEIGHT_KEY).then((v: unknown) => {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) setMiniHeight(clampMiniHeight(v))
      return window.electronAPI?.getConfig(MINI_CLOSED_KEY).then((closed: unknown) => {
        if (typeof closed === 'boolean') setMiniClosed(closed)
        // 开在 setMiniClosed 同一微任务内:随后重跑的写 effect(见下)立即看到门已开
        miniConfigReadRef.current = true
      })
    }).catch(() => { /* config 不可达回落默认 */ }).finally(() => setMiniConfigLoaded(true))
  }, [])

  // 根高观察(小窗装配的运行期布局钳输入):装配 maxHeight 只钳装配盒本身,
  // 画心(--dual-h 派生)若仍按存档 miniHeight 恒高、居中锚定在纸上,钳制时
  // 上下对称溢出纸外,overflow:hidden 的裁剪首先吃掉画心顶部的工具条 ——
  // 小窗存档 953 / 面板高 800 时工具条整条不可见而 webview 中段照常显示
  // (实机探测复现)。这里把拖动/恢复同款钳(根高 - MINI_RESERVE_HEIGHT)
  // 提前算进 --dual-h 与内联高度:纸与画心同步收缩,工具条永在;存档值
  // 不动,窗口回弹即恢复原高(与 maxHeight 粗钳注释同一取舍)
  const [rootHeight, setRootHeight] = useState(0)
  // 根宽同源观察:铭牌行收纳(WEBBAR_NAMEPLATE_COMPACT_WIDTH)的输入
  const [rootWidth, setRootWidth] = useState(0)
  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect()
      setRootHeight(rect.height)
      setRootWidth(rect.width)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // 未布局(根高 0)回落存档值,视觉由 maxHeight 兜底;钳后仍过 clampMiniHeight:
  // 极矮根高下 146 下限优先 —— 与拖动 clamp 同语义,矮到放不下是最小装配问题
  const miniFitHeight =
    rootHeight > 0 ? clampMiniHeight(miniHeight, rootHeight - MINI_RESERVE_HEIGHT) : miniHeight

  // 铭牌行收纳(阈值见常量注):根宽未量得(0)不收 —— RO 的初始通知在首次
  // 绘制前落,按全簇渲染不产生闪变;jsdom 无 RO 恒全簇(测试桩依赖)
  const navCompact = rootWidth > 0 && rootWidth < WEBBAR_NAMEPLATE_COMPACT_WIDTH + (onOpenSettings ? 32 : 0) + (browserSettings.homePage ? 32 : 0)
  // 清空始终收进更多菜单，窄栏再收纳设置和主页；避免首行误点清空历史。
  // 收层机械(useDismiss 外点/ESC,与状态栏编码菜单/图标选择器同一套)
  const [navMoreOpen, setNavMoreOpen] = useState(false)
  const navMoreRef = useRef<HTMLDivElement>(null)
  const navMoreTriggerRef = useRef<HTMLButtonElement>(null)
  const navMoreId = useId()
  const closeNavMore = useCallback((): void => {
    setNavMoreOpen(false)
    // 菜单项卸载前归还焦点，Esc/执行动作后继续从触发钮导航。
    if (navMoreRef.current?.contains(document.activeElement)) navMoreTriggerRef.current?.focus()
  }, [])
  useDismiss(navMoreOpen && visible, closeNavMore, [navMoreRef])
  useEffect(() => {
    if (navMoreOpen && visible) navMoreRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
  }, [navMoreOpen, visible])
  // 切换布局、列表或面板时收口，避免隐藏菜单继续占用 ESC 栈。
  useEffect(() => {
    if (visible) closeNavMore()
    else setNavMoreOpen(false)
  }, [navCompact, listView, visible, closeNavMore])

  // 双开画轴内容挂载裁决(保活):首次开卷挂载,此后不再卸载 —— 合卷的裁剪由纸
  // 承担(.scroll-dual-paper overflow:hidden,纸高收到 0 整体裁掉画心),内容留树
  // 即 webview guest 存活,重开卷/切机柜页签零重挂零重载;收起稳态纸上的 inert
  // 把内容挡在 Tab 序外。未开卷不挂:冷启动存档 closed=true 不为卷着的纸拉
  // guest(与 miniConfigLoaded 门合流,见其注释)
  const [miniContentMounted, setMiniContentMounted] = useState(false)
  useEffect(() => {
    if (!miniClosed) setMiniContentMounted(true)
  }, [miniClosed])
  useEffect(() => {
    const timer = setTimeout(() => {
      // setConfig 走 IPC 返回 Promise：失败不上未处理拒绝，但留 warn 痕迹与
      // settleWebview 同口径 —— 高度已在内存态，下次拖动变更会再试
      window.electronAPI?.setConfig(MINI_HEIGHT_KEY, miniHeight).catch(
        err => console.warn('[WebPanel] webMiniHeight config write failed:', err)
      )
    }, 500)
    return () => clearTimeout(timer)
  }, [miniHeight])

  // 小窗关闭态独立存档：关闭 = 摘 UI 不清状态，恢复后原页仍在。
  // 500ms 防抖 + 卸载补写：面板随页签切换即卸载，关闭后 500ms 内切走页签时
  // 防抖 timer 被 cleanup 掐掉且没有后续触发（高度丢了下次拖动还能自愈，关闭
  // 决策不补写就永久丢失）—— 卸载时值未落盘就立即写
  const miniClosedRef = useRef(miniClosed)
  const miniClosedSavedRef = useRef<boolean | null>(null)
  useEffect(() => {
    miniClosedRef.current = miniClosed
    // 写门未开(读档未成功)不排写:state 还是默认 false,排了就是把默认值写进档
    if (!miniConfigReadRef.current) return
    const timer = setTimeout(() => {
      miniClosedSavedRef.current = miniClosed
      window.electronAPI?.setConfig(MINI_CLOSED_KEY, miniClosed)
        .catch(err => console.warn('[WebPanel] webMiniClosed config write failed:', err))
    }, 500)
    return () => clearTimeout(timer)
  }, [miniClosed])
  useEffect(() => () => {
    if (miniConfigReadRef.current && miniClosedSavedRef.current !== miniClosedRef.current) {
      window.electronAPI?.setConfig(MINI_CLOSED_KEY, miniClosedRef.current)
        .catch(err => console.warn('[WebPanel] webMiniClosed config write failed:', err))
    }
  }, [])

  // 小窗上次地址存档:miniUrl 每变即写(did-navigate 回写后的落点,非输入原值)
  useEffect(() => {
    if (!browserLoaded || browserError) return
    if (!browserSettings.restoreMini) {
      try { localStorage.removeItem(MINI_URL_STORAGE_KEY) } catch { /* quota */ }
      return
    }
    if (miniUrl === null) return
    try { localStorage.setItem(MINI_URL_STORAGE_KEY, miniUrl) } catch { /* quota */ }
  }, [miniUrl, browserLoaded, browserError, browserSettings.restoreMini])

  // 小窗导航:miniUrl 是「应显示的地址」,元素 getURL() 是「实际所在地址」,不等才
  // loadURL —— 幂等设计:did-navigate 把落点回写进 miniUrl 后两者相等自然停手
  // (redirect 落点同步亦然),Enter / localStorage 恢复 / Ctrl+点击历史行共用同一入口。
  // 门在 miniReady:getURL/loadURL 在 dom-ready 前调用会抛错(见 state 注释);
  // loadURL 返回 Promise,经 settleWebview 吞掉常态拒绝
  // 挂失败不重试:effect 只随 miniUrl 变化重跑,失败的地址停在原地等用户改址
  useEffect(() => {
    const el = miniEl
    if (miniUrl === null || !el || !miniReady || !el.loadURL) return
    if (el.getURL() !== miniUrl) settleWebview(() => el.loadURL(miniUrl))
  }, [miniUrl, miniEl, miniReady])

  // 工具条地址跟随落点:输入未持焦点才回写(编辑中不冲掉打到一半的地址 ——
  // focus 即编辑态的简化守卫,小窗无跨页签切换的复杂度,不需要主地址栏的 ref 机制)
  useEffect(() => {
    const el = miniInputRef.current
    if (el && document.activeElement === el) return
    setMiniInput(miniUrl ?? '')
  }, [miniUrl])

  // 小窗 webview 事件:与 WebTabOverlay 同一套口径(Electron 28 参数挂事件自身
  // 属性的双读、ERR_ABORTED(-3) 常态噪音过滤、子框架失败不铺浮层)。落点入册
  // 共享「最近访问」—— 小窗预览也是真实访问,store 去重封顶。canGoBack 是同步
  // IPC,但小窗事件只在自身面板可见时才会来(无后台页签),直接读无冻结顾虑
  useEffect(() => {
    if (!miniEl) {
      // 无元素(首挂前/面板级卸载)即复位就绪门 —— 保活下元素不摘树,此分支
      // 只服务挂载前与未来可能的卸载路径：若 miniReady 留着上一元素的陈旧
      // true，导航 effect 会在 dom-ready 门开前调 getURL() —— 真机直接炸
      // （jsdom 桩测不出）
      setMiniReady(false)
      return
    }
    registerMiniWebview(miniEl)
    // 新元素一律先判未就绪(元素级重建仅存于极端路径),防上一元素的陈旧 true
    setMiniReady(false)
    const onDomReady = (): void => {
      setMiniReady(true)
      // 遮罩在这里收(主框架文档就绪、内容可画),不等 did-stop-loading(理由见
      // miniCovering 注释);失败浮层是独立 state,did-fail-load 自行铺
      setMiniCovering(false)
      // 小窗与完整页签共用 webbar partition(登录态互通):主进程的快捷键转发凭
      // webContentsId 登记区分两者,这里把小窗报上去 —— 之后小窗内的按键不再被
      // 拦截转发到「活动完整页签」，F5 由主进程刷新小窗自身。登记晚于
      // did-attach(getWebContentsId 在 dom-ready 前调用会抛错,只能在这拍报)。
      // 保活下元素不重挂,dom-ready 每元素生命周期一次;元素级重建(极端路径)
      // 产生新 id、新元素 dom-ready 重报覆盖
      window.electronAPI?.registerWebbarMini(miniEl.getWebContentsId())
        .catch(err => console.warn('[WebPanel] webbar-mini register failed:', err))
    }
    const onNav = (e: Event): void => {
      const evt = e as CustomEvent<unknown> & { url?: string; isMainFrame?: boolean; detail?: { url?: string; isMainFrame?: boolean } }
      const url = evt.url ?? evt.detail?.url
      const isMainFrame = evt.isMainFrame ?? evt.detail?.isMainFrame
      if (isMainFrame === false || !url) return
      if (miniLastUrlRef.current !== url && e.type !== 'did-navigate-in-page') miniTitleRef.current = ''
      miniLastUrlRef.current = url
      setMiniUrl(url)
      setMiniNav({ canGoBack: miniEl.canGoBack(), canGoForward: miniEl.canGoForward() })
    }
    const onStartLoading = (): void => { setMiniLoading(true); setMiniCovering(true); setMiniFailed(null) }
    const onTitle = (e: Event): void => {
      const event = e as CustomEvent<{ title?: string }> & { title?: string }
      miniTitleRef.current = event.title ?? event.detail?.title ?? ''
    }
    // stop-loading 收遮罩是 dom-ready 的兜底:异常路径(不触发 dom-ready 的失败)防遮罩滞留
    const onStopLoading = (): void => { setMiniLoading(false); setMiniCovering(false) }
    const onFail = (e: Event): void => {
      const failure = webLoadFailureFromEvent(e, miniLastUrlRef.current)
      if (failure) setMiniFailed(failure)
    }
    // 记历史吃 miniLastUrlRef（导航落点，初始化即挂载目标）而非 getURL()：
    // 事件回调不碰方法面，did-finish-load 理论晚于 dom-ready 但不赌时序
    const onLoadFinish = (): void => recordWebTabVisit(miniLastUrlRef.current)
    miniEl.addEventListener('dom-ready', onDomReady)
    miniEl.addEventListener('did-navigate', onNav)
    miniEl.addEventListener('did-navigate-in-page', onNav)
    miniEl.addEventListener('did-start-loading', onStartLoading)
    miniEl.addEventListener('did-stop-loading', onStopLoading)
    miniEl.addEventListener('did-fail-load', onFail)
    miniEl.addEventListener('did-finish-load', onLoadFinish)
    miniEl.addEventListener('page-title-updated', onTitle)
    return () => {
      unregisterMiniWebview(miniEl)
      miniEl.removeEventListener('dom-ready', onDomReady)
      miniEl.removeEventListener('did-navigate', onNav)
      miniEl.removeEventListener('did-navigate-in-page', onNav)
      miniEl.removeEventListener('did-start-loading', onStartLoading)
      miniEl.removeEventListener('did-stop-loading', onStopLoading)
      miniEl.removeEventListener('did-fail-load', onFail)
      miniEl.removeEventListener('did-finish-load', onLoadFinish)
      miniEl.removeEventListener('page-title-updated', onTitle)
    }
  }, [miniEl, recordWebTabVisit])

  // 小窗导航统一入口:同址重进 = 刷新(omnibox 惯例,dom-ready 后才有方法面);
  // 否则落 miniUrl 交给导航 effect 起航,首航同时冻结挂载 src。非法地址走面板
  // 公共 notice 通道(与主地址栏同一条错误路径)。reload 的 Promise 拒绝经
  // settleWebview 收口(工具条按钮同)
  const loadMini = (raw: string): boolean => {
    const norm = browserAddress(raw, browserSettings.searchEngine)
    if (!norm) {
      setNotice(t('webBar.invalid'))
      return false
    }
    // 显式输入优先，不能被尚未返回的冷启动设置覆盖。
    miniRestoreChecked.current = true
    // 小窗处于关闭态时的载入(Ctrl+点击历史行) = 预览意图,顺手重开:未挂载过时
    // URL 只落 state 而画心还是空态,点击像静默无反馈;已挂载(保活)则只是重新展卷
    if (miniClosed) setMiniClosed(false)
    const el = miniEl
    if (el && miniReady && el.getURL() === norm) {
      settleWebview(() => el.reload())
      return true
    }
    if (miniLastUrlRef.current !== norm) miniTitleRef.current = ''
    // 未挂载期冻结 src 跟随目标:挂载提交即首航地址,不先白拉一次旧存档页
    // (已挂载则 src 冻结纪律生效,导航交给 loadURL effect)
    if (el === null) setMiniSrc(norm)
    setMiniUrl(norm)
    return true
  }
  // 升格:以小窗当前页开完整网页页签(小窗保留原页,两条浏览线互不打断)
  const handleMiniPromote = (): void => {
    if (miniUrl !== null) openWebTab(miniUrl)
  }

  // 关闭页面:回到未开眼空态 —— webview 摘树销毁 guest,是保活(页面常驻)的
  // 资源释放对面:不再需要页面状态时由用户显式放弃,内存即还。localStorage
  // 存档一并清掉,冷启动不再恢复;导航/加载/失败态同步复位(元素卸载只触发
  // miniReady 复位,loading/failed 是独立 state 得自己收)。按钮只在开卷可及
  // (卷着时纸 inert 且裁掉工具条)
  const handleMiniClosePage = useCallback((): void => {
    // 同步撤掉弹窗来源，不能等 React 卸载 effect 才阻止排队中的 IPC。
    if (miniEl) unregisterMiniWebview(miniEl)
    setMiniUrl(null)
    setMiniSrc(null)
    setMiniInput('')
    setMiniNav({ canGoBack: false, canGoForward: false })
    setMiniLoading(false)
    setMiniCovering(false)
    setMiniFailed(null)
    miniLastUrlRef.current = ''
    try { localStorage.removeItem(MINI_URL_STORAGE_KEY) } catch { /* quota */ }
  }, [miniEl])

  // 本机聊天页也可能处于左列保活小窗，禁用时要真正摘树并清掉恢复地址。
  useEffect(() => {
    if (!window.electronAPI?.onPluginResourcesReleased) return
    return window.electronAPI.onPluginResourcesReleased((pluginId, webOrigins) => {
      const origins = webOrigins ?? uniquePluginWebOrigins(usePluginStore.getState().items.flatMap(p => p.views), pluginId)
      if ([miniUrl, miniSrc, miniLastUrlRef.current].some(url => url && matchesPluginWebOrigin(url, origins))) {
        handleMiniClosePage()
      }
    })
  }, [miniUrl, miniSrc, handleMiniClosePage])

  // 小窗拖高:pointer 捕获而非文件管理器的 document mousemove —— 小窗本体是
  // webview,指针一进页面范围 mousemove 就被 guest 吞掉(同跨域 iframe),捕获后
  // pointermove 恒回流本元素(同 MainWindow 侧栏调宽条的经验)
  // 拖高与点合分流:按下记起点,捕获期 pointermove 位移越过 3px 记真拖动 ——
  // 拖完浏览器补发的 click 被重定目标到本行(pointer capture 的固有行为,恰好
  // 落在开合热区上),靠它识别并吞掉
  const miniDragStartYRef = useRef(0)
  const miniDragMovedRef = useRef(false)
  // 抓握补偿:高度公式「锚底缘 - 指针」把指针位置当作装配顶缘,而抓点落在
  // 辊行命中区内(辊心在顶缘下 5px)—— 记下抓点相对上辊行顶的偏移、拖动
  // 全程加回,辊才真正贴指针 1:1(不补的话起步高度先跳一截,辊脱离指针)
  const miniGrabOffsetRef = useRef(0)
  const onMiniDividerPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    // 起点恒记(收起态也记):onClick 的位移复量要拿它对拍;只在开态记的话,
    // 收起态的 click 拿旧拖动的起点量 —— 收起行位置早错开,开合点击被误吞
    miniDragStartYRef.current = e.clientY
    if (miniClosed) return
    miniDragMovedRef.current = false
    // 抓握补偿:抓点相对上辊行顶(=装配顶缘)的偏移,move 里加回
    miniGrabOffsetRef.current = e.clientY - e.currentTarget.getBoundingClientRect().top
    e.currentTarget.setPointerCapture(e.pointerId)
    setMiniResizing(true)
  }
  const onMiniDividerPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!miniResizing) return
    if (Math.abs(e.clientY - miniDragStartYRef.current) > 3) miniDragMovedRef.current = true
    const rect = rootRef.current?.getBoundingClientRect()
    if (!rect) return
    // 锚底缘 = WebPanel 根底缘(小窗装配是根的最后一个子节点,两者底缘重合;
    // 根高不随小窗高度动,拖动全程恒定),加抓握补偿后辊贴指针真 1:1。
    // 与 config 恢复共用 clampMiniHeight(同一夹取逻辑);rect 未布局/极矮时
    // max < MIN,MIN 兜底 —— 只夹小不夹死
    setMiniHeight(clampMiniHeight(rect.bottom - e.clientY + miniGrabOffsetRef.current, rect.height - MINI_RESERVE_HEIGHT))
  }
  const endMiniResize = (): void => setMiniResizing(false)

  // 输入完整 URL(无 scheme 自动补 https://)→ 浏览器模式就地导航,启动器模式
  // 以终端页签形式打开在活动分屏。非法输入走 notice 提示(对齐其他面板的错误
  // 路径)。rawArg 供候选选择和前往按钮传入当前输入值
  const handleOpenWebTab = (rawArg?: string): void => {
    setNotice(null)
    const input = (rawArg ?? webBarInput).trim()
    if (!input) return
    const raw = browserAddress(input, browserSettings.searchEngine)
    if (!raw) { setNotice(t('webBar.invalid')); return }
    if (activeWebTabId !== null) {
      if (!navigateActiveWebTab(raw)) {
        setNotice(t('webBar.invalid'))
        return
      }
      editingRef.current = false  // 已提交:放开跟随,导航落地后地址栏同步新 URL
    } else {
      const res = openWebTab(raw)
      if (res.ok) {
        editingRef.current = false
        setWebBarInput('')
      } else {
        setNotice(t('webBar.invalid'))
      }
    }
  }

  return (
    <div
      ref={rootRef}
      // visible=false = 保活隐藏态(MainWindow 常挂载,见组件 docstring):display:none
      // 摘出布局但元素留树,webview guest 存活(Tailwind .hidden 在 display 组内后
      // 于 .flex 生成,恒压过 flex)
      className={cn('web-panel w-full h-full flex flex-col bg-[var(--bg-base)]', !visible && 'hidden')}
      data-narrow={rootWidth > 0 && rootWidth < 300 || undefined}
      style={{ fontFamily: 'ui-monospace, "JetBrains Mono", "Cascadia Code", Consolas, monospace' }}
    >
      <PanelHeader
        title={t('webBar.title')}
        count={navCompact ? undefined : listView === 'downloads' ? downloads.length : listView === 'bookmarks' ? bookmarks.length : webTabHistory.length}
        countHint={t(listView === 'downloads' ? 'browser.downloads' : listView === 'bookmarks' ? 'webBar.bookmarks' : 'panelHeader.recentVisits')}
        actions={<>
          {!navCompact && onOpenSettings && <IconBtn title={t('browser.title')} amber size="lg" bright onClick={onOpenSettings}>
            <Glyph size={18}><path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1m-8.6 8.6-2.1 2.1" /><circle cx="12" cy="12" r="5" /></Glyph>
          </IconBtn>}
          {!navCompact && browserSettings.homePage && <IconBtn title={t('browser.openHome')} amber size="lg" bright onClick={() => handleOpenWebTab(browserSettings.homePage)}>
            <Glyph size={18}><path d="m3 10 9-7 9 7M5 9v12h5v-7h4v7h5V9" /></Glyph>
          </IconBtn>}
        {/* 导航簇 —— 落点 = 活动网页页签(web-tab-controls 控制层);可用性随
            活动页签:无页签前后禁用，前后随 nav 快照，加载时显示停止按钮。
            IconBtn lg + bright 档:按钮簇共用 28px 透明操作面、rack 前景和悬停浅底，
            18px 图标的视觉描边为 1.5px。窄栏收纳
            (WEBBAR_NAMEPLATE_COMPACT_WIDTH):副操作设置/主页离场让位题名,
            前后导航恒在，刷新使用 F5 */}
        <IconBtn title={t('webBar.back')} amber size="lg" bright disabled={!activeNav?.canGoBack} onClick={activeWebTabGoBack}>
          <ChevronLeftIcon size={18} />
        </IconBtn>
        <IconBtn title={t('webBar.forward')} amber size="lg" bright disabled={!activeNav?.canGoForward} onClick={activeWebTabGoForward}>
          <ChevronRightIcon size={18} />
        </IconBtn>
        {activeNav?.loading && <IconBtn
          title={t('webBar.stop')}
          amber
          size="lg"
          bright
          onClick={stopActiveWebTab}
        >
          <StopIcon size={18} />
        </IconBtn>}
        {/* 清空仅在更多菜单中提供；窄栏额外收纳设置与主页。 */}
        {(navCompact || listView === 'recent') && (
          <div ref={navMoreRef} className="relative flex-shrink-0">
            <IconBtn ref={navMoreTriggerRef} title={t('webBar.more')} aria-haspopup="menu" aria-expanded={navMoreOpen} aria-controls={navMoreOpen ? navMoreId : undefined} amber size="lg" bright onClick={() => setNavMoreOpen(o => !o)}>
              <MoreIcon size={18} />
            </IconBtn>
            {navMoreOpen && (
              <div id={navMoreId} role="menu" aria-label={t('webBar.more')}
                onKeyDown={event => {
                  if (event.key === 'Tab') { closeNavMore(); return }
                  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
                  event.preventDefault()
                  const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'))
                  const index = items.indexOf(document.activeElement as HTMLButtonElement)
                  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
                    : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
                  items[next]?.focus()
                }}
                className="win-no-drag absolute top-full right-0 mt-1 z-50 w-[168px] bg-[var(--bg-rack)] border border-[var(--rule)] rounded-sm p-1 shadow-xl [&_button:focus-visible]:outline [&_button:focus-visible]:outline-2 [&_button:focus-visible]:outline-[var(--amber)]">
                {navCompact && onOpenSettings && <button type="button" role="menuitem" onClick={() => { closeNavMore(); onOpenSettings() }} className="w-full px-2.5 py-1.5 text-left text-[12px] text-[var(--text-rack)] rounded-sm hover:bg-[var(--bg-slot)]">{t('browser.title')}</button>}
                {navCompact && browserSettings.homePage && <button type="button" role="menuitem" onClick={() => { closeNavMore(); handleOpenWebTab(browserSettings.homePage) }} className="w-full px-2.5 py-1.5 text-left text-[12px] text-[var(--text-rack)] rounded-sm hover:bg-[var(--bg-slot)]">{t('browser.openHome')}</button>}
                {listView === 'recent' && <button
                  type="button"
                  role="menuitem"
                  disabled={webTabHistory.length === 0}
                  onClick={() => { closeNavMore(); clearWebTabHistory() }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[12px] text-[var(--text-rack)] rounded-sm hover:bg-[var(--bg-slot)] disabled:opacity-40 disabled:cursor-default transition-colors"
                >
                  <TrashIcon size={13} />
                  <span className="truncate">{t('webBar.clear')}</span>
                </button>}
              </div>
            )}
          </div>
        )}
        </>}
      />

      {/* ===== 内容壳 ===== 头行以下整列离缘 6(mx-1.5) —— 与会话栏器物两端同线
          (栏内器物一律离缘,不再通铺到面板两缘);段内既有垫距保留;壳不定位,
          fixed 弹窗/浮层与绝对定位的小窗不受影响 */}
      <div className="mx-1.5 flex-1 min-h-0 flex flex-col min-w-0">

      {/* 地址栏固定占 44px；沿用补全、IME 与 Esc 的导航行为。 */}
      <div className="web-address-row">
            <BrowserAddressField
              inputRef={inputRef} visible={visible} suggestions={addressSuggestions}
              renderIcon={url => <RecentFavicon url={url} favicon={webTabFavicons[url]} />}
              onSubmit={url => { setWebBarInput(url); handleOpenWebTab(url) }}
              value={webBarInput}
              onChange={(e) => {
                editingRef.current = true
                setWebBarInput(e.target.value)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && activeWebTabId !== null) {
                  // 浏览器模式 Esc:放弃编辑,复位为当前 URL
                  editingRef.current = false
                  setWebBarInput(displayUrl)
                  inputRef.current?.blur()
                }
              }}
              onFocus={(e) => {
                // 浏览器模式聚焦全选(omnibox 惯例);启动器模式保留点击落点,
                // 半选输入中间改一段的场景不强制全选
                if (activeWebTabId !== null) e.target.select()
              }}
              aria-label={t('webBar.placeholder')}
              placeholder={t(browserSettings.searchEngine === 'none' ? 'commandBar.welcome.urlPlaceholder' : 'commandBar.welcome.searchPlaceholder')}
            />
      </div>

      {/* 内容笼:space-y-2(与 PluginPanel 同构);侧距归内容壳(6),上下垫
          保留 —— 顶部 pt-1.5 贴分割线起排,底部 pb-1.5 贴小窗拖高条(栏底
          语法:历史卡与拖高条之间只留 6px 空气);旧 px-3 已撤不叠两层 */}
      <div className="flex-1 min-h-0 flex flex-col pt-1.5 pb-1.5 space-y-2">

        {notice && <div role="status" className="text-[10.5px] [font-family:inherit] text-[var(--text-rack-data)] break-all">{notice}</div>}

        <div role="tablist" aria-label={t('webBar.websiteLists')} className="web-list-tabs">
          {(['recent', 'bookmarks', 'downloads'] as const).map(view => (
            <button
              key={view}
              type="button"
              role="tab"
              id={`web-list-tab-${view}`}
              aria-selected={listView === view}
              aria-controls="web-list-content"
              title={t(view === 'downloads' ? 'browser.downloads' : `webBar.${view}`)}
              tabIndex={listView === view ? 0 : -1}
              onClick={() => setListView(view)}
              onKeyDown={e => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
                e.preventDefault()
                const views = ['recent', 'bookmarks', 'downloads'] as const
                const next = e.key === 'Home' ? 'recent' : e.key === 'End' ? 'downloads' : views[(views.indexOf(view) + (e.key === 'ArrowLeft' ? 2 : 1)) % views.length]
                setListView(next)
                document.getElementById(`web-list-tab-${next}`)?.focus()
              }}
              className="web-list-tab"
            >
              {view === 'bookmarks' && <BookmarkIcon />}
              <span className="web-list-label">{t(view === 'downloads' ? 'browser.downloads' : `webBar.${view}`)}</span>
              <span className="web-list-count">{view === 'downloads' ? activeDownloads || downloads.length : view === 'recent' ? webTabHistory.length : bookmarks.length}</span>
            </button>
          ))}
        </div>

        <div id="web-list-content" role="tabpanel" aria-labelledby={`web-list-tab-${listView}`} className="flex-1 min-h-0 flex flex-col">
        {listView === 'downloads' && <BrowserDownloads />}
        {listView === 'bookmarks' && (
          <div className="rack-scroll flex-1 min-h-0 overflow-y-auto">
            {bookmarks.length === 0 ? (
              <p className="px-3 py-4 text-xs leading-relaxed text-[var(--text-rack-data)]">{t('webBar.bookmarksEmpty')}</p>
            ) : bookmarks.map(item => (
              <div key={item.url} className="flex items-center gap-1 px-2 py-1 border-b border-[var(--rule-soft)] hover:bg-[var(--bg-slot)]">
                <button type="button" onClick={e => { if (e.ctrlKey || e.metaKey) loadMini(item.url); else openWebTab(item.url) }} title={item.url} className="flex flex-1 min-w-0 items-center gap-2 py-1 text-left text-xs text-[var(--text-rack)] hover:text-[var(--amber)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--amber)]">
                  <span aria-hidden className="web-history-favicon"><RecentFavicon url={item.url} favicon={webTabFavicons[item.url]} /></span>
                  <span className="min-w-0 truncate">{item.title}</span>
                </button>
                <button type="button" title={t('webBar.openMini')} onClick={() => loadMini(item.url)} className="w-6 h-6 flex-shrink-0 flex items-center justify-center text-[var(--text-rack)] hover:text-[var(--amber)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--amber)]"><MiniOpenIcon size={14} /></button>
                <button type="button" title={t('webBar.removeBookmark')} onClick={() => toggleBookmark(item.url)} className="w-6 h-6 flex-shrink-0 flex items-center justify-center text-[var(--amber)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--amber)]"><BookmarkIcon filled /></button>
              </div>
            ))}
          </div>
        )}

        {listView === 'recent' && (
          <div className="web-history rack-scroll">
            {webTabHistory.length === 0 ? (
              <p className="web-history-empty">{t('webBar.recentEmpty')}</p>
            ) : (
              <ol aria-label={t('webBar.recent')} className="web-history-list">
                {webTabHistory.map(url => (
                  <li key={url} className="web-history-row">
                    <button type="button" title={url} className="web-history-open"
                      onClick={e => { if (e.ctrlKey || e.metaKey) loadMini(url); else openWebTab(url) }}>
                      <span aria-hidden className="web-history-favicon"><RecentFavicon url={url} favicon={webTabFavicons[url]} /></span>
                      <span className="web-history-address">{url}</span>
                    </button>
                    <div className="web-history-actions">
                      <button type="button"
                        title={t(isBookmarked(url) ? 'webBar.removeBookmark' : 'webBar.addBookmark')}
                        aria-pressed={isBookmarked(url)} disabled={!normalizeBookmarkUrl(url)}
                        onClick={() => toggleBookmark(url)}>
                        <BookmarkIcon filled={isBookmarked(url)} />
                      </button>
                      <button type="button" title={t('webBar.openMini')} onClick={() => loadMini(url)}><MiniOpenIcon size={14} /></button>
                      <button type="button" className="web-history-remove" title={t('webBar.removeRecent')} onClick={() => removeWebTabHistory(url)}>
                        <Glyph size={14}><path d="m6 6 12 12M18 6 6 18" /></Glyph>
                      </button>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
        </div>
      </div>

      {/* ===== 写轮眼小窗双开画轴 —— 栏底面板的展开/收起挂轴化 =====
          点任一辊行即开/合(双向 toggle,上辊行带 role=button 承接键盘;
          收起 = 纸裹回双辊成上下双卷、各拴一只蝴蝶结,题签居中浮在双卷
          之间的合缝上作纯名牌,不再设 ✕、也不带方向符号)。开态上辊整行
          兼拖高手势位(10px 命中区,双开轴细棍化):pointer capture 机械原样(小窗本体
          是 webview,指针一进页面 mousemove 就被 guest 吞,捕获后
          pointermove 恒回流本元素 —— 捕获还会把拖完补发的 click 重定目
          标到本行,拖动/点按靠位移阈值分流:位移超 3px 记真拖动,补发的
          click 被吞掉);拖示线 = 行顶缘的 1px 发丝线、整幅贯通,悬停/聚焦
          才显(读作「最上面的线」亮起,不与辊混读)。开合机械全在
          globals.css 的 .scroll-dual 系列(辊/绳/纸复用 rod-caps 与
          scroll-tie 家族):开 = 纸自两辊相向铺开、内容锚定合缝自中部
          显影(440ms 纸坠),合 = 窗口向正中收拢、纸裹着内容卷回双辊拴
          绳(320ms 加速收;内容常驻不卸载 —— 保活,纸 overflow:hidden
          裁掉画心,guest 存活)。画心立在纸面中央
          (body 裱边四周各 4px)。装配总高(= 双辊 20 + 裱边 8 + 画心)
          沿用 miniHeight 存档语义,拖动映射 1:1 不变。轴头/系绳/解绳辉光
          挂 scroll-dual-web 青蓝段身份(与最近访问墙同一件物,取
          --web-group,不取 amber) */}
      <div
        onKeyDownCapture={e => {
          const action = matchWebTabShortcut({
            type: 'keyDown', key: e.key, control: e.ctrlKey, alt: e.altKey,
            shift: e.shiftKey, meta: e.metaKey, isAutoRepeat: e.repeat,
            isComposing: e.nativeEvent.isComposing
          })
          if (action !== 'reload' && action !== 'reload-hard') return
          e.preventDefault()
          e.stopPropagation()
          if (!miniReady || !miniUrl) return
          settleWebview(() => action === 'reload-hard' ? miniEl?.reloadIgnoringCache() : miniEl?.reload())
        }}
        className={cn(
          'scroll-dual scroll-dual-compact scroll-dual-web web-mini-browser -mx-1.5 flex-shrink-0 select-none',
          miniClosed ? 'rolled' : 'open',
          miniResizing && 'resizing'
        )}
        style={{
          height: miniClosed ? `var(--scroll-dual-rolled-height, ${MINI_ROLLED_H}px)` : `${miniFitHeight}px`,
          // 渲染期钳(拖动/恢复夹取之外的第二道防线):存档值超当前面板或窗口
          // 临时缩小时视觉收敛,保底地址栏/历史留座的粗钳(壳内口径:
          // 100% 的含块是内容壳,不含头行 —— 见 MINI_SHELL_RESERVE_HEIGHT 注);
          // 存档值不被临时小屏毁掉,窗口回弹即恢复原高 —— 恢复时面板多半未布局,
          // rect 量不到,上限靠这里。贴合值(miniFitHeight)先行把同一把钳
          // 算进 height/--dual-h,本条只在未布局首帧兜底(见其注释)
          maxHeight: `calc(100% - ${MINI_SHELL_RESERVE_HEIGHT}px)`,
          '--dual-h': `${miniFitHeight}px`
        } as React.CSSProperties}
      >
        {/* 上辊行 —— 开合钮 + 开态拖高手势位:点行开/合(双向),拖高靠位移
            阈值分流(pointer 捕获期 move 超 3px 记真拖动,松手补发的 click
            被重定目标到本行后吞掉);面板名称由悬停提示与 aria-label 提供,
            轴上不叠加题签 */}
        <div
          className={cn('scroll-dual-rod group', miniClosed ? 'cursor-pointer' : 'cursor-row-resize')}
          role="button"
          tabIndex={0}
          aria-expanded={!miniClosed}
          aria-label={t('webBar.mini')}
          title={miniClosed ? t('webBar.miniOpen') : t('webBar.miniClose')}
          onPointerDown={onMiniDividerPointerDown}
          onPointerMove={onMiniDividerPointerMove}
          onPointerUp={endMiniResize}
          onPointerCancel={endMiniResize}
          onLostPointerCapture={endMiniResize}
          onClick={(e) => {
            // 拖高结束浏览器会补发 click(pointer capture 会把 click 重定目标到本行):
            // 位移越过阈值 = 真拖动,吞掉这一拍。判据双保险:move 越 3px 记真
            // 拖动之外,click 自带松手坐标再对按下起点量一遍 —— move 一帧没到
            // (webview 客页截走指针等)也能判出真拖动,不会误当点合把小窗卷起
            if (miniDragMovedRef.current || Math.abs(e.clientY - miniDragStartYRef.current) > 3) {
              miniDragMovedRef.current = false
              return
            }
            setMiniClosed(v => !v)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setMiniClosed(v => !v) }
          }}
        >
          {/* 辊本体(rod-caps)—— 行内垂直居中的横置圆柱,垫在题签/按钮后
              (z-index -1);纸带锚底:纸自辊底缘引出/裹回,满卷即上卷 */}
          <span aria-hidden className="rod-caps" />
          <span aria-hidden className="scroll-dual-tie"><ScrollTie /></span>
          {/* 开态拖示线 —— 上辊行顶缘(装配最上面的线)的 1px 发丝线、整
              幅贯通,悬停/聚焦才显:读作边界线亮起、不与辊混读(旧 30×2
              短杠贴辊顶,悬停时读作辊长粗变形);常亮线会被读作 border,
              手势位本身已是整行 */}
          {!miniClosed && (
            <div
              aria-hidden
              className="absolute top-0 left-0 right-0 h-px bg-[var(--text-rack-dim)] opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity"
            />
          )}
        </div>
        {/* 纸窗(开合窗)—— 内容锚合缝:开 = 自中部相向显影,合 = 向正中收拢
            随纸卷回;收起稳态 inert(卷起的纸不进 Tab 序,同 ScrollFold) */}
        <div className="scroll-dual-paper" {...(miniClosed ? { inert: '' } : {})}>
          <div className="scroll-dual-body">
            {miniContentMounted && (
              <div className="flex flex-col h-full">
                {/* 迷你工具条:勾玉开眼指示 + 后退/前进/加载时停止 + 小窗地址(与主地址栏共用最近访问和收藏候选)+ 升格 + 关页。刷新由 F5 处理，
                    guest 内的按键由主进程直接刷新小窗，不转发到完整页签。
                    工具条保持 32px 高，地址框 24px，预留上下各 4px */}
                <div className="flex items-center gap-[3px] px-2 h-[32px] flex-shrink-0 bg-[var(--bg-rack)] border-b border-[var(--rule)]">
                  <MiniEyeGlyph lit={miniUrl !== null} label={t('webBar.mini')} />
                  <NavButton title={t('webBar.miniBack')} disabled={!miniNav.canGoBack} onClick={() => settleWebview(() => miniEl?.goBack())}>
                    <ChevronLeftIcon />
                  </NavButton>
                  <NavButton title={t('webBar.miniForward')} disabled={!miniNav.canGoForward} onClick={() => settleWebview(() => miniEl?.goForward())}>
                    <ChevronRightIcon />
                  </NavButton>
                  {miniLoading && <NavButton
                    title={t('webBar.miniStop')}
                    disabled={miniUrl === null || !miniReady}
                    onClick={() => settleWebview(() => miniEl?.stop())}
                  >
                    <StopIcon />
                  </NavButton>}
                  {/* 小窗沿用同款输入框，24px 高度适配紧凑工具条。 */}
                    <BrowserAddressField
                      inputRef={miniInputRef} mini visible={visible} suggestions={addressSuggestions}
                      renderIcon={url => <RecentFavicon url={url} favicon={webTabFavicons[url]} />}
                      onSubmit={url => { setMiniInput(url); setNotice(null); loadMini(url) }}
                      value={miniInput}
                      onChange={(e) => setMiniInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape' && miniUrl !== null) {
                          // Esc 放弃编辑,复位为当前页地址(同主地址栏语法)
                          setMiniInput(miniUrl)
                          miniInputRef.current?.blur()
                        }
                      }}
                      onFocus={(e) => e.target.select()}
                      aria-label={t('webBar.miniPlaceholder')}
                      placeholder={t('webBar.miniPlaceholder')}
                    />
                  <NavButton title={t(isBookmarked(miniUrl ?? '') ? 'webBar.removeBookmark' : 'webBar.addBookmark')} disabled={!normalizeBookmarkUrl(miniUrl ?? '')} onClick={() => toggleBookmark(miniUrl ?? '', miniTitleRef.current)}>
                    <BookmarkIcon filled={isBookmarked(miniUrl ?? '')} size={12} />
                  </NavButton>
                  <NavButton title={t('webBar.miniOpenTab')} disabled={miniUrl === null} onClick={handleMiniPromote}>
                    <PromoteIcon />
                  </NavButton>
                  {/* 关页:闭眼回到空态,guest 销毁(见 handleMiniClosePage 注释) */}
                  <NavButton title={t('webBar.miniClosePage')} disabled={miniUrl === null} onClick={handleMiniClosePage}>
                    <XIcon />
                  </NavButton>
                </div>
                {/* 浏览面:未开眼 = 空态指引(空屏是行动邀请);开眼 = webview + 加载/
                    失败浮层(WebTabOverlay 同款,webview 无内建 UI)。
                    webview 额外双门(见 config 对账 effect 注释 + 内容挂载裁决):
                    miniConfigLoaded —— 存档关闭态落定前不挂 guest,零闪挂/零白拉;
                    「!miniClosed || miniEl 非空」—— 关着的卷不新挂 guest,已挂的
                    卷合卷不卸载(保活:纸裁画心,guest 存活,miniEl 非空即自证)。
                    工具条/空态不受门控,挂载即同步可交互 */}
                <div className="flex-1 min-h-0 relative bg-[var(--terminal-bg)]">
                  {miniUrl === null ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 select-none px-3 text-center">
                      <MiniEyeGlyph lit={false} label={t('webBar.miniHintTitle')} size={20} />
                      <span className="text-[11.5px] text-[var(--text-rack-mute)]">{t('webBar.miniHintTitle')}</span>
                      <span className="text-[10.5px] text-[var(--text-rack-faint)]">{t('webBar.miniHint')}</span>
                    </div>
                  ) : miniConfigLoaded && (!miniClosed || miniEl !== null) ? (
                    <>
                      {/* src = 冻结的首航地址(挂载后恒不变,后续导航走 loadURL,见 miniSrc 注释);
                          partition 与完整网页页签同仓(登录态互通),快捷键转发的排除见 onDomReady 登记 */}
                      {/* Electron webview 专属属性，React 的通用 DOM 规则不认识。 */}
                      {/* eslint-disable react/no-unknown-property */}
                      <webview ref={setMiniEl} partition={WEBBAR_PARTITION} src={miniSrc ?? undefined} allowpopups="" className="w-full h-full" />
                      {/* eslint-enable react/no-unknown-property */}
                      {miniCovering && (
                        <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--terminal-bg)] text-sm text-gray-400 pointer-events-none">
                          {t('webBar.loading')}
                        </div>
                      )}
                      {miniFailed && (
                        <WebLoadError compact failure={miniFailed} getGuestId={() => miniEl?.getWebContentsId()} onLeave={() => {
                          try { if (miniReady && miniEl?.canGoBack()) { miniEl.goBack(); return } } catch { /* guest 可能已销毁。 */ }
                          handleMiniClosePage()
                        }} onRetry={() => {
                          if (miniEl) settleWebview(() => miniEl.loadURL(miniFailed.url))
                        }} />
                      )}
                    </>
                  ) : null}
                </div>
              </div>
            )}
          </div>
        </div>
        {/* 下辊行 —— 纸尾辊:开态随纸幅走在底缘(纸自其上缘引出),不参与拖拽;
            收起与上辊叠成下卷;点行同样开/合(双向 toggle,鼠标入口 —— 键盘
            由上辊行独占,不给 title 免得与上辊重复) */}
        <div
          className="scroll-dual-rod scroll-dual-rod-b cursor-pointer"
          onClick={() => setMiniClosed(v => !v)}
        >
          {/* 辊本体 —— 下辊镜像(纸带锚顶、落影投上,机械在 .scroll-dual-rod-b) */}
          <span aria-hidden className="rod-caps" />
          <span aria-hidden className="scroll-dual-tie"><ScrollTie /></span>
        </div>
      </div>
      </div>{/* ===== /内容壳 ===== */}
    </div>
  )
}

export default WebPanel
