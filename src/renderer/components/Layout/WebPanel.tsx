import React, { useEffect, useMemo, useRef, useState } from 'react'
import cn from 'classnames'
import { useTranslation } from 'react-i18next'
import type { WebviewTag } from 'electron'
import { usePaneStore, normalizeWebBarUrl } from '../../stores/pane-store'
import { useUiStore } from '../../stores/ui-store'
import { TOPBAR_HEIGHT } from './topbar-metrics'
import { WebTabFavicon } from './PaneTabBar'
import {
  selectActiveWebTabId, navigateActiveWebTab, reloadActiveWebTab, stopActiveWebTab,
  activeWebTabGoBack, activeWebTabGoForward, getWebview, openActiveWebTabDevTools
} from './web-tab-controls'
import ScrollFold, { ScrollTie } from './ScrollFold'
import { IconBtn } from './IconBtn'
import { useDismiss } from '../../hooks'
import { WEBBAR_PARTITION } from '@shared/constants'

/** datalist 选项 label 用:取 hostname,取不到回落原样字符串(与页签 title 初始值同源);
    历史行本身直接显示完整 URL,不再缩略为 hostname */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname || url
  } catch {
    return url
  }
}

/** 域名分组的组键:hostname + 非默认端口 —— localhost:3000 与 :8080 是两个
    应用,不该并成一个组;裸端口默认值(80/443)不进键,常规站点组键即域名 */
function hostKeyOf(url: string): string {
  try {
    const u = new URL(url)
    return (u.hostname || url) + (u.port ? `:${u.port}` : '')
  } catch {
    return url
  }
}

/** 最近历史按域名分组:Map 保序,组序 = 各组最近一条的落位(历史本身是
    最近优先序,所以整墙「最近用过的域名在最上」),组内同吃最近序 */
function groupHistoryByHost(history: string[]): Array<[string, string[]]> {
  const groups = new Map<string, string[]>()
  for (const url of history) {
    const key = hostKeyOf(url)
    const bucket = groups.get(key)
    if (bucket) bucket.push(url)
    else groups.set(key, [url])
  }
  return [...groups.entries()]
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
 *  14px 档 2.5、感知 ~1.45px,12px 档 2、感知 1px 与旧值一致:提粗只落在
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

/** 导航图标组(lucide 线稿风格)——后退/前进/刷新/停止。size 供铭牌行(IconBtn
 *  lg 档)放大到 14,缺省 12 = 小窗工具条原尺 */
/** 后退/前进 = 单笔角括号 —— 读形对齐左窗栏收起控位(ActivityRail
 *  IconCollapseRail)的 chevron,大小也对齐它的物理份量:那颗在 24px 盒里
 *  占 6×10.8(口高 45%),本行图标盒只有 14px,等比放大即 24vb 下 10×18
 *  (口高 75%)—— 之前 7×12 渲染才 4×7px,比邻位的刷新/检查矮一头,读作
 *  缩水;进深:口高仍是 5:9 同比例 */
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
const RotateCwIcon: React.FC<{ size?: number }> = ({ size = 12 }) => (
  <Glyph size={size}>
    <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
  </Glyph>
)
const StopIcon: React.FC<{ size?: number }> = ({ size = 12 }) => (
  <Glyph size={size}>
    {/* 圆角提到 2(浏览器 stop 的读形):描边 2.5 下 rx1 已被吃成直角,
        rx2 恰好保住一点软边 */}
    <rect width="13" height="13" x="5.5" y="5.5" rx="2" />
  </Glyph>
)
/** 检查网页(客体 DevTools)图标 —— 同组线稿风格,code 括号 */
const CodeIcon: React.FC<{ size?: number }> = ({ size = 12 }) => (
  <Glyph size={size}>
    <path d="m16 18 6-6-6-6" />
    <path d="m8 6-6 6 6 6" />
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

// 铭牌行按钮簇收纳阈值:全簇预算 5×28(面) + 5×gap-1(题名与 5 钮间 5 缝)
// + px-3×2 = 184px,加「Sharingan」全宽 ~72 + 呼吸 ≈ 264 —— 根宽低于它时
// 收起副操作钮(检查/清空),保主导航三钮(3 钮预算 120)与完整题名:默认
// 240 宽下题名得 120px,拖到下限 180 也有 60px(「写轮眼」48px 仍在,题名
// 另有 min-w-[48px] 兜底);根宽回涨全簇归位。rootWidth 未量得(首帧/jsdom)
// 不收,行为同旧
const WEBBAR_NAMEPLATE_COMPACT_WIDTH = 264

// ===== 写轮眼小窗（栏底迷你浏览器）的持久化与几何常量 =====
// 高度走 config（键名/防抖/夹取对齐会话面板 fileManagerHeight 的栏底语法）；上次
// 浏览地址走 localStorage 镜像 —— 重开面板即恢复原页,小窗是「常在的地方」而非表单
const MINI_HEIGHT_KEY = 'webMiniHeight'
const MINI_CLOSED_KEY = 'webMiniClosed'
const MINI_URL_STORAGE_KEY = 'lyshell.webbarMini.url.v1'
// 高度语义 = 双开画轴装配总高(上下双辊 20 + 裱边 16 + 画心):旧存档值(纯纸
// 幅语义)经 clampMiniHeight 下限自愈上抬;默认 236 与 146 的画心(200/110)恰
// 是旧默认/旧下限 —— 浏览面尺寸对旧档零感知(细棍化收 12,画心不动)
const MINI_DEFAULT_HEIGHT = 236  // 双辊 20 + 裱边 16 + 工具条 32 + 浏览面 168(旧默认的浏览面)
const MINI_MIN_HEIGHT = 146      // 双辊 20 + 裱边 16 + 工具条 32 + 网页可视 ~78px 的下限(旧下限 110 的同等内容)
// 面板高减去它 = 小窗装配高度上限(拖动 clamp 与 CSS maxHeight 同一把钳)。
// 上方恒占 = 铭牌 TOPBAR_HEIGHT + 地址栏 44 + 历史留座 120(卡头+两行余量)
// —— 历史座是设计裁量非布局硬限(卡内自滚,还能更矮),整把故为粗钳:拖动
// 上限已精确锚装配底缘(rootRef 底缘,见 onMiniDividerPointerMove),要再
// 精确须逐帧量上方实高,粗防线保底即可
const MINI_RESERVE_HEIGHT = TOPBAR_HEIGHT + 44 + 120
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
  </Glyph>
)

/** 溢出菜单钮(lucide more-horizontal 线稿风格)—— 窄栏收纳的检查/清空住这里;
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
 * 没有再回落猜 origin/favicon.ico。两者都没有则不占位,行内只显示 URL。
 * url/favicon 变化先清旧 src:组件可被同位置复用(域名组头随组内最新一条
 * 换 url),不清的话,上一条 URL 的图标会在新条没有持久化图标、且回落猜测
 * 失败(按 origin 缓存 null)时长期残留 —— 展示成「张冠李戴」的旧图
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
  if (!src) return null
  return <WebTabFavicon src={src} />
}

/**
 * 域名分组画轴头 —— SessionsPanel 会话墙 GroupHeader 的 Web 版(同一套卷轴
 * 语言,机械全在 globals.css:.scroll-head 栏 + .rod-caps 辊轴头 + ScrollTie
 * 蝴蝶结 + .scroll-slip 题签 + flex-1 发丝线 + 右缘计数,纸幅走 ScrollFold
 * 里的 .paper-sheet mx-2)。段身份走 --web-group 青蓝(段级组语义,轴头/系绳
 * 同色 —— 同一件物的两处署名,inline 注入同会话墙 toneVar 的方式;题签仍
 * 全栏一只金,不跟身份走)。题签前落组内最近一条的 favicon —— 14px 恒占座,
 * 图标迟到/缺席都不推挤题签,各组题签起点对齐。开合态由父级存(collapsedHosts),
 * 本组件只挂态。
 */
const WebGroupHeader: React.FC<{
  label: string
  count: number
  /** 组内最近一条(最近序首位)—— favicon 持久化映射的取值键与回落猜测源 */
  recentUrl: string
  favicon?: string
  collapsed: boolean
  onToggle: () => void
}> = ({ label, count, recentUrl, favicon, collapsed, onToggle }) => (
  <div
    onClick={onToggle}
    role="button"
    tabIndex={0}
    aria-expanded={!collapsed}
    onKeyDown={(e: React.KeyboardEvent) => {
      // 键盘开合:target 不在自己身上不接(行内嵌套钮聚焦时 Enter 不误触折叠)
      if (e.target !== e.currentTarget) return
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle() }
    }}
    className={cn(
      'relative flex items-center gap-2.5 pl-3 pr-[20px] py-[3px] text-[10px] text-[var(--text-rack-mute)]',
      'scroll-head group cursor-pointer',
      collapsed && 'rolled'
    )}
  >
    {/* 卷轴辊 —— 轴头恒跟辊同径、随辊居中,段身份青蓝(--web-group) */}
    <span aria-hidden className="rod-caps" style={{ color: 'var(--web-group)' }}>
      <span className="scroll-rod-collar scroll-rod-collar-l" />
      <span className="scroll-rod-collar scroll-rod-collar-r" />
    </span>
    {/* 蝴蝶结:收起系上、展开随纸飘落淡出(槽位恒占防行首跳动);绳色随轴头
        (inline 注入压过 hover 变色类,提亮只走 opacity 一档 —— 会话墙同款) */}
    <span
      aria-hidden
      className="inline-flex transition opacity-80 group-hover:opacity-100"
      style={{ color: 'var(--web-group)' }}
    >
      <ScrollTie group />
    </span>
    {/* 组 favicon —— 恒占 14px 座,迟到的猜测结果不推挤题签 */}
    <span aria-hidden className="w-[14px] h-[14px] flex-shrink-0 flex items-center justify-center">
      <RecentFavicon url={recentUrl} favicon={favicon} />
    </span>
    {/* 题签 —— 组键(hostname[:port]),金墨书体同会话分组;长域名可缩可截断
        (flex-shrink-0 会把右缘计数挤出栏外 —— 发丝线 flex-1 先缩到 0,题签
        随后 ellipsis),全名走 title(tooltip 看全量,行内 URL 同一约定) */}
    <span title={label} className="min-w-0 truncate scroll-slip text-[13px]">{label}</span>
    <span className="flex-1 h-px bg-[var(--rule)]" />
    <span className="[font-family:inherit] text-[11px] text-[var(--text-rack-data)] tracking-[.04em]">{count}</span>
  </div>
)

/**
 * 网页访问面板(机柜左列 Web 页签)。
 * 双模式:活动分屏正显示网页页签时是「浏览器 chrome」—— 地址栏同步当前 URL
 * (payload.nav,did-navigate 回写)、Enter 就地导航、后退/前进/刷新/停止/检查
 * 按钮住铭牌行(IconBtn,指令经 web-tab-controls 落到活动页签);否则是「启动器」
 * —— 顶部 URL 栏输入完整网址,以终端页签形式打开在活动分屏(多页签,类似 dsh
 * Web 页签),打开的网页一律走终端页签栏切换/关闭,面板不再列清单。
 * 下方是「最近访问」历史(localStorage 持久化,pane-store webTabHistory),
 * 立在会话墙同款的双开画轴墙上(scroll-dual-wall 几何 + scroll-dual-web 青蓝
 * 段身份:上/下辊行一键收/放全体域名分组 —— 会话墙「全体」同语义,组态与
 * 单组折叠同管线不存档;组头 = GroupHeader 同款卷轴,ScrollFold 纸幅,组序/
 * 组内序吃历史最近优先序;组键 = hostname + 非默认端口):点击重开、行上
 * 按钮在小窗打开、✕ 删除单条;清空整段历史的钮在铭牌行(IconBtn);输入框
 * 挂 datalist 原生补全。
 * URL 归一化/校验在 pane-store 的 normalizeWebBarUrl;webview 的导航/弹窗由主进程
 * 按 persist:webbar partition 分流锁定(仅 http/https,见 main/index.ts)。
 *
 * 栏底是「写轮眼小窗」—— 模拟会话面板文件管理器的栏底语法(4px 拖高条 + config
 * 持久化高度)的迷你浏览器:不动用终端分屏的快速查阅面,历史行上的
 * 「在小窗打开」按钮或 Ctrl+点击历史行在此预览,↗ 升格为完整网页页签,✕ 关页回空态(guest 销毁、localStorage 存档清掉);
 * webview 与完整网页页签共用 partition persist:webbar
 * (cookie/localStorage 同仓,登录态互通 —— 页签里登过小窗即登录态),快捷键转发
 * 不挂(经 dom-ready 登记 webContentsId 排除,避免路由到活动页签的错位,见
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
const WebPanel: React.FC<{ visible?: boolean }> = ({ visible = true }) => {
  const { t } = useTranslation()
  const openWebTab = usePaneStore((s) => s.openWebTab)
  const webTabHistory = usePaneStore((s) => s.webTabHistory)
  const webTabFavicons = usePaneStore((s) => s.webTabFavicons)
  // 最近历史的域名分组视图(组序/组内序吃历史本身的最近优先序)与组开合态:
  // host → 收起?。组件随机柜页签切换保活,开合态跨切页签留存;历史增删后
  // 消失的组在表里留的陈旧键无害
  const webGroups = useMemo(() => groupHistoryByHost(webTabHistory), [webTabHistory])
  const [collapsedHosts, setCollapsedHosts] = useState<Record<string, boolean>>({})
  const toggleHostCollapsed = (host: string): void =>
    setCollapsedHosts(s => ({ ...s, [host]: !s[host] }))
  // 一键收/放(会话墙 toggleAllGroups 同语义):收 = 把最近访问里展开着的
  // 域名卷全卷起,放 = 全部展开 —— 组态与单组折叠同管线(直接改
  // collapsedHosts,不另存档,保活下跨机柜页签留存);判据只看现存各组,
  // 历史增删留下的陈旧键不掺和
  const allGroupsCollapsed =
    webGroups.length > 0 && webGroups.every(([host]) => !!collapsedHosts[host])
  const toggleAllGroups = (): void => {
    const collapsed = !allGroupsCollapsed
    setCollapsedHosts(prev => {
      const next = { ...prev }
      for (const [host] of webGroups) next[host] = collapsed
      return next
    })
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
  const [miniLoading, setMiniLoading] = useState(false)
  // 加载遮罩与 miniLoading(工具条停止钮跟的完整加载周期)分离:遮罩 dom-ready
  // 即收 —— did-stop-loading 要等全部子资源(广告/统计/慢图)落定,真实站点上
  // 一个慢三方资源就把不透明遮罩压 10-30s+,而页面内容 commit 后几十毫秒已可
  // 渐进上屏(实机探针:本地页 28ms 可画、遮罩整压 12s)。工具条停止钮仍跟
  // miniLoading,慢资源期间仍可点停
  const [miniCovering, setMiniCovering] = useState(false)
  const [miniFailed, setMiniFailed] = useState<string | null>(null)
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
  const displayUrl = activeNav?.url ?? activeUrl ?? ''

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
  useEffect(() => {
    if (activeWebTabId === null) return
    const el = getWebview(activeWebTabId)
    if (!el) return
    setWebTabNav(activeWebTabId, { canGoBack: el.canGoBack(), canGoForward: el.canGoForward() })
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
  const navCompact = rootWidth > 0 && rootWidth < WEBBAR_NAMEPLATE_COMPACT_WIDTH
  // 溢出菜单(navCompact 时检查/清空的落点,功能不随收纳消失):开合 state +
  // 收层机械(useDismiss 外点/ESC,与状态栏编码菜单/图标选择器同一套)
  const [navMoreOpen, setNavMoreOpen] = useState(false)
  const navMoreRef = useRef<HTMLDivElement>(null)
  useDismiss(navMoreOpen, () => setNavMoreOpen(false), [navMoreRef])
  // 退出窄栏(拉宽回平铺簇)时随收菜单:浮层虽卸载,open=true 仍占 useDismiss
  // 的 ESC 回退栈顶(再按 ESC 会被它消费截停,又不落在任何可见层上);不复位的
  // 话再缩窄时菜单还自行重现。与收纳态同源驱动,不必等外点/ESC 收层
  useEffect(() => {
    if (!navCompact) setNavMoreOpen(false)
  }, [navCompact])

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
    if (miniUrl === null) return
    try { localStorage.setItem(MINI_URL_STORAGE_KEY, miniUrl) } catch { /* quota */ }
  }, [miniUrl])

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
    // 新元素一律先判未就绪(元素级重建仅存于极端路径),防上一元素的陈旧 true
    setMiniReady(false)
    const onDomReady = (): void => {
      setMiniReady(true)
      // 遮罩在这里收(主框架文档就绪、内容可画),不等 did-stop-loading(理由见
      // miniCovering 注释);失败浮层是独立 state,did-fail-load 自行铺
      setMiniCovering(false)
      // 小窗与完整页签共用 webbar partition(登录态互通):主进程的快捷键转发凭
      // webContentsId 登记区分两者,这里把小窗报上去 —— 之后小窗内的按键不再被
      // 拦截转发到「活动完整页签」,reload/后退由 guest 原生处理。登记晚于
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
      miniLastUrlRef.current = url
      setMiniUrl(url)
      setMiniNav({ canGoBack: miniEl.canGoBack(), canGoForward: miniEl.canGoForward() })
    }
    const onStartLoading = (): void => { setMiniLoading(true); setMiniCovering(true); setMiniFailed(null) }
    // stop-loading 收遮罩是 dom-ready 的兜底:异常路径(不触发 dom-ready 的失败)防遮罩滞留
    const onStopLoading = (): void => { setMiniLoading(false); setMiniCovering(false) }
    const onFail = (e: Event): void => {
      const evt = e as CustomEvent<unknown> & { errorCode?: number; errorDescription?: string; isMainFrame?: boolean }
      if (evt.isMainFrame === false) return
      if (evt.errorCode === -3) return
      setMiniFailed(evt.errorDescription || (evt.errorCode !== undefined ? `ERR_${evt.errorCode}` : 'ERROR'))
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
    return () => {
      miniEl.removeEventListener('dom-ready', onDomReady)
      miniEl.removeEventListener('did-navigate', onNav)
      miniEl.removeEventListener('did-navigate-in-page', onNav)
      miniEl.removeEventListener('did-start-loading', onStartLoading)
      miniEl.removeEventListener('did-stop-loading', onStopLoading)
      miniEl.removeEventListener('did-fail-load', onFail)
      miniEl.removeEventListener('did-finish-load', onLoadFinish)
    }
  }, [miniEl, recordWebTabVisit])

  // 小窗导航统一入口:同址重进 = 刷新(omnibox 惯例,dom-ready 后才有方法面);
  // 否则落 miniUrl 交给导航 effect 起航,首航同时冻结挂载 src。非法地址走面板
  // 公共 notice 通道(与主地址栏同一条错误路径)。reload 的 Promise 拒绝经
  // settleWebview 收口(工具条按钮同)
  const loadMini = (raw: string): boolean => {
    const norm = normalizeWebBarUrl(raw)
    if (!norm) {
      setNotice(t('webBar.invalid'))
      return false
    }
    // 小窗处于关闭态时的载入(Ctrl+点击历史行) = 预览意图,顺手重开:未挂载过时
    // URL 只落 state 而画心还是空态,点击像静默无反馈;已挂载(保活)则只是重新展卷
    if (miniClosed) setMiniClosed(false)
    const el = miniEl
    if (el && miniReady && el.getURL() === norm) {
      settleWebview(() => el.reload())
      return true
    }
    // 未挂载期冻结 src 跟随目标:挂载提交即首航地址,不先白拉一次旧存档页
    // (已挂载则 src 冻结纪律生效,导航交给 loadURL effect)
    if (el === null) setMiniSrc(norm)
    setMiniUrl(norm)
    return true
  }
  const handleMiniEnter = (): void => {
    setNotice(null)
    const raw = (miniInputRef.current?.value ?? '').trim()
    if (!raw) return
    loadMini(raw)
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
  const handleMiniClosePage = (): void => {
    setMiniUrl(null)
    setMiniSrc(null)
    setMiniInput('')
    setMiniNav({ canGoBack: false, canGoForward: false })
    setMiniLoading(false)
    setMiniCovering(false)
    setMiniFailed(null)
    miniLastUrlRef.current = ''
    try { localStorage.removeItem(MINI_URL_STORAGE_KEY) } catch { /* quota */ }
  }

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
  // 路径)。rawArg 供 Enter 的延迟路径传入 datalist 提交后的 DOM 值
  const handleOpenWebTab = (rawArg?: string): void => {
    setNotice(null)
    const raw = (rawArg ?? webBarInput).trim()
    if (!raw) return
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
      className={cn('w-full h-full flex flex-col bg-[var(--bg-base)]', !visible && 'hidden')}
      style={{ fontFamily: 'ui-monospace, "JetBrains Mono", "Cascadia Code", Consolas, monospace' }}
    >
      {/* 头条:网页铭牌 —— 与 SessionsPanel/PluginPanel 头行同构(行高对齐终端
          第一行、满幅 border-b 发丝线、铭牌走系统 UI 字体做「厂牌丝印」)。
          挂 win-drag 做窗口拖拽区(头行是第一行横带的左列段);交互子元素
          (导航簇/清空)统一 IconBtn(win-no-drag 内建让位,lg + bright 档:
          按钮簇是这行的主体操作)—— 浏览器导航键与清空都住这行,44px 输入行
          只留地址栏 */}
      <div
        className="win-drag flex items-center justify-between gap-1 px-3 border-b border-[var(--rule)] flex-shrink-0"
        style={{ height: TOPBAR_HEIGHT }}
      >
        <span
          title={t('webBar.title')}
          className="flex-1 min-w-[48px] truncate font-bold tracking-[-0.01em] text-[16px] text-[var(--text-rack)] select-none"
          style={{ fontFamily: '"Segoe UI Variable Display", "Segoe UI", system-ui, "PingFang SC", "Microsoft YaHei", sans-serif' }}
        >
          {t('webBar.title')}
        </span>
        {/* 导航簇 —— 落点 = 活动网页页签(web-tab-controls 控制层);可用性随
            活动页签:无页签全禁,前后随 nav 快照,刷新/停止随加载周期换图。
            IconBtn lg + bright 档:按钮簇是这行的主体操作,面 28px、字面 rack
            常亮(五处头条默认档不受影响),图标同提 14。窄栏收纳
            (WEBBAR_NAMEPLATE_COMPACT_WIDTH):副操作检查/清空离场让位题名,
            主导航三钮恒在 */}
        <IconBtn title={t('webBar.back')} amber size="lg" bright disabled={!activeNav?.canGoBack} onClick={activeWebTabGoBack}>
          <ChevronLeftIcon size={14} />
        </IconBtn>
        <IconBtn title={t('webBar.forward')} amber size="lg" bright disabled={!activeNav?.canGoForward} onClick={activeWebTabGoForward}>
          <ChevronRightIcon size={14} />
        </IconBtn>
        <IconBtn
          title={activeNav?.loading ? t('webBar.stop') : t('webBar.reload')}
          amber
          size="lg"
          bright
          disabled={activeWebTabId === null}
          onClick={() => (activeNav?.loading ? stopActiveWebTab() : reloadActiveWebTab(false))}
        >
          {activeNav?.loading ? <StopIcon size={14} /> : <RotateCwIcon size={14} />}
        </IconBtn>
        {/* 检查网页:打开活动网页页签客体的 DevTools —— 页面行为异常(按钮点不动、
            疑似脚本报错)时的取证入口,报错只进客体 devtools 不开则完全不可见 */}
        {!navCompact && (
          <IconBtn title={t('webBar.devtools')} amber size="lg" bright disabled={activeWebTabId === null} onClick={openActiveWebTabDevTools}>
            <CodeIcon size={14} />
          </IconBtn>
        )}
        {/* 清空最近访问 —— 历史空时禁用,无物可清 */}
        {!navCompact && (
          <IconBtn onClick={clearWebTabHistory} title={t('webBar.clear')} size="lg" bright disabled={webTabHistory.length === 0}>
            <TrashIcon size={14} />
          </IconBtn>
        )}
        {/* 溢出菜单 —— 窄栏收纳时检查/清空的落点(功能不随收纳消失):触发钮
            「…」+ 下拉两项。收层走 useDismiss(外点/ESC,见 state 处注);浮层
            挂 win-no-drag 脱离整行拖拽区,点击才落得进;项的禁用条件与平铺
            钮完全一致,行为同源不分叉 */}
        {navCompact && (
          <div ref={navMoreRef} className="relative flex-shrink-0">
            <IconBtn title={t('webBar.more')} amber size="lg" bright onClick={() => setNavMoreOpen(o => !o)}>
              <MoreIcon />
            </IconBtn>
            {navMoreOpen && (
              <div className="win-no-drag absolute top-full right-0 mt-1 z-50 w-[168px] bg-[var(--bg-rack)] border border-[var(--rule)] rounded-sm p-1 shadow-xl">
                <button
                  type="button"
                  role="menuitem"
                  disabled={activeWebTabId === null}
                  onClick={() => { setNavMoreOpen(false); openActiveWebTabDevTools() }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[12px] text-[var(--text-rack)] rounded-sm hover:bg-[var(--bg-slot)] disabled:opacity-40 disabled:cursor-default transition-colors"
                >
                  <CodeIcon size={13} />
                  <span className="truncate">{t('webBar.devtools')}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={webTabHistory.length === 0}
                  onClick={() => { setNavMoreOpen(false); clearWebTabHistory() }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[12px] text-[var(--text-rack)] rounded-sm hover:bg-[var(--bg-slot)] disabled:opacity-40 disabled:cursor-default transition-colors"
                >
                  <TrashIcon size={13} />
                  <span className="truncate">{t('webBar.clear')}</span>
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 输入动作位 —— 44px 输入行(36px 画轴居中悬浮,上下各 4px 呼吸),
          底部一条随卡片宽度的分割线(px-3 收进,不连接面板
          左右边缘)把动作区与历史区分开;导航键已迁铭牌行,此行只留地址栏 */}
      <div className="flex-shrink-0 h-[44px] px-3 flex flex-col">
        <div className="flex-1 flex items-center">
          {/* 网页访问栏 —— 双开画轴(与小窗地址栏/会话搜索框同款挂轴化,机械全在
              globals.css 的 .scroll-search 系列):两端各一竖辊,常开不随聚焦
              收放(同会话搜索框「常在的动作位」语义)—— 地址作墨 mono 居中
              落于纸面、横跨正中合缝。再挂 scroll-search-web 青蓝变体(轴头/
              系绳/解绳辉光取 --web-group,与最近访问墙的组头署名同一件物),
              合缝去痕读作整幅。启动器模式输入完整 URL 回车即开新页签(无
              scheme 自动补 https://),datalist 挂最近历史做原生补全;label
              承接点击(点纸即落墨,点辊也聚焦);IME/datalist/Esc 的键盘机械
              原样 */}
          <label className="scroll-search scroll-search-web scroll-search-lg open flex-1 min-w-0 h-[36px] relative flex items-center cursor-text">
            {/* 纸幅 —— 两半:左半自左辊后向右铺、右半自右辊后向左铺,合缝在
                容器正中;垫在辊与墨之下(纸自辊后引出),自由端带残余卷曲 */}
            <span aria-hidden className="scroll-search-paper scroll-search-paper-l" />
            <span aria-hidden className="scroll-search-paper scroll-search-paper-r" />
            {/* 双辊 —— 两端竖轴:辊体(光辊)+ 裹辊纸带(收=满卷,开=纸下
                辊)+ 上下青蓝轴头;几何「辊比纸长」(轴头探出纸外) */}
            <span aria-hidden className="scroll-search-rod scroll-search-rod-l" />
            <span aria-hidden className="scroll-search-rod scroll-search-rod-r" />
            {/* 蝴蝶结 —— 收卷时双卷各拴一只(绳色随轴头,机械共用
                .scroll-tie 的 :is 列表);开卷解绳飘走 */}
            <span aria-hidden className="scroll-search-tie scroll-search-tie-l"><ScrollTie /></span>
            <span aria-hidden className="scroll-search-tie scroll-search-tie-r"><ScrollTie /></span>
            {/* 墨 —— 纸面输入:地址居中落合缝(mono 13 配 20px 纸幅),
                占位=题签金墨(样式在 ::placeholder);左让位避开左辊区,
                右让位收窄到 12 —— datalist 的原生下拉三角贴着纸右缘,
                靠近右辊但留 5px 气不贴上 */}
            <input
              ref={inputRef}
              type="text"
              list="lyshell-webbar-history"
              value={webBarInput}
              onChange={(e) => {
                editingRef.current = true
                setWebBarInput(e.target.value)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  // IME 组合中的 Enter 是候选确认,不导航
                  if (e.nativeEvent.isComposing) return
                  // datalist 高亮项的提交是 Enter 的默认动作,晚于 keydown ——
                  // 同步读 state 只拿到输入前缀(浏览器模式会拿前缀就地导航,
                  // 毁掉当前页)。不 preventDefault(掐掉默认动作补全就丢了),
                  // 延后一拍从 DOM 读已提交值
                  setTimeout(() => handleOpenWebTab(inputRef.current?.value), 0)
                } else if (e.key === 'Escape' && activeWebTabId !== null) {
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
              placeholder={t('webBar.placeholder')}
              spellCheck={false}
              className="scroll-search-input relative z-[2] flex-1 min-w-0 ml-[18px] mr-[12px] bg-transparent border-none outline-none font-mono text-[13px] text-center text-[var(--text-rack)] caret-[var(--amber)]"
            />
            {/* datalist 选项 = 全量历史(store 已封顶 30 条,无需再截) */}
            <datalist id="lyshell-webbar-history">
              {webTabHistory.map(url => (
                <option key={url} value={url}>{hostOf(url)}</option>
              ))}
            </datalist>
          </label>
        </div>
        <div aria-hidden className="h-px bg-[var(--rule-soft)]" />
      </div>

      {/* 内容笼:p-3 + space-y-2(与 PluginPanel 同构);顶部 pt-1.5 贴分割线起排,
          底部 pb-1.5 贴小窗拖高条(栏底语法:历史卡与拖高条之间只留 6px 空气) */}
      <div className="flex-1 min-h-0 flex flex-col px-3 pt-1.5 pb-1.5 space-y-2">

        {notice && <div className="text-[10.5px] [font-family:inherit] text-[var(--text-rack-data)] break-all">{notice}</div>}

        {/* 最近访问 —— localStorage 持久化历史,立在会话墙同款的双开画轴墙上
            (scroll-dual-wall 变体:墙恒开,收起的是纸里的垂卷分组们;再挂
            scroll-dual-web 青蓝段身份 —— 轴头/系绳/解绳辉光取 --web-group,
            与纸里组头同一件物的三处署名,机械在 globals.css 的变体规则):
            上/下辊行一键收/放全体分组(会话墙「全体」同语义,aria-expanded 与
            键盘入口在上辊行,下辊纯鼠标);组头 = GroupHeader 同款卷轴
            (scroll-head 辊轴头 + 蝴蝶结 + 题签金墨 + 右缘计数,点击/Enter
            开合),内容落 ScrollFold 的 paper-sheet(与辊上卷纸带同宽同边
            mx-2);组序 = 各组最近一条的落位(历史最近优先序),组内同吃最近序。
            行样式对齐终端页签(favicon + 单行 truncate+tooltip 看全量、hover
            bg-slot、行高 32px):点击重开、行上按钮在小窗打开、✕ 删除单条
            (清空整段历史的钮在铭牌行)。常占剩余空间(打开的网页不再在此
            列出,切换/关闭走终端页签栏) */}
        {webGroups.length > 0 && (
          <div className="scroll-dual scroll-dual-wall scroll-dual-web flex-1 min-h-0 open">
            {/* 上辊行 —— 一键收/放钮(会话墙「全体」同款):点行把纸里展开着的
                域名卷全卷起/全放,键盘入口在此(下辊行纯鼠标);两态 title 即
                展开/折叠全部分组,aria-label 记段名 */}
            <div
              className="scroll-dual-rod cursor-pointer"
              role="button"
              tabIndex={0}
              aria-expanded={!allGroupsCollapsed}
              aria-label={t('webBar.recent')}
              title={allGroupsCollapsed ? t('webBar.expandAllGroups') : t('webBar.collapseAllGroups')}
              onClick={toggleAllGroups}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleAllGroups() }
              }}
            >
              {/* 辊本体(rod-caps)—— 行内垂直居中的细棍,垫在绳后;墙恒开,
                  辊面恒是光辊(解绳态:轴头恒亮,青蓝身份见 scroll-dual-web) */}
              <span aria-hidden className="rod-caps" />
              <span aria-hidden className="scroll-dual-tie"><ScrollTie /></span>
            </div>
            {/* 纸窗(恒铺开,纸包内容)—— 域名分组垂卷立在纸面上;内容超出
                剩余高时纸收缩到剩高、内心滚(滚动容器 = 纸窗,滚条 rack-scroll) */}
            <div className="scroll-dual-paper rack-scroll">
              <div className="scroll-dual-body">
                {webGroups.map(([host, urls]) => (
                  <div key={host}>
                    <WebGroupHeader
                      label={host}
                      count={urls.length}
                      recentUrl={urls[0]}
                      favicon={webTabFavicons[urls[0]]}
                      collapsed={!!collapsedHosts[host]}
                      onToggle={() => toggleHostCollapsed(host)}
                    />
                    <ScrollFold open={!collapsedHosts[host]}>
                      {/* 纸幅:与辊上卷纸带同宽同边 mx-2,辊探出一对轴头(会话墙同款);
                          行保留 rule-soft 底线 —— 最后一行的折线正是纸尾收口 */}
                      <div className="paper-sheet mx-2">
                        {urls.map(url => (
                          <div
                            key={url}
                            className="flex items-center gap-1.5 px-2 h-[32px] border-b border-[var(--rule-soft)] hover:bg-[var(--bg-slot)] transition-colors"
                          >
                            <RecentFavicon url={url} favicon={webTabFavicons[url]} />
                            <button
                              onClick={(e) => {
                                // Ctrl/Cmd+点击 = 小窗预览(应用内 Ctrl+点击是备选动作的通用
                                // 语法,同终端 Ctrl+点击 URL 开页签);普通点击仍开完整页签
                                if (e.ctrlKey || e.metaKey) loadMini(url)
                                else openWebTab(url)
                              }}
                              title={url}
                              className="flex-1 min-w-0 text-left text-xs [font-family:inherit] truncate text-[var(--text-rack)] hover:text-[var(--amber)] cursor-pointer transition-colors"
                            >
                              {url}
                            </button>
                            {/* 在小窗打开 —— 显式按钮(此前只有 Ctrl+点击隐藏手势):与 Ctrl+点击
                                同走 loadMini 入口,小窗收着时顺手重开(见 loadMini),同址 = 刷新 */}
                            <button
                              onClick={() => loadMini(url)}
                              title={t('webBar.openMini')}
                              className="w-[14px] h-[14px] flex-shrink-0 flex items-center justify-center text-[var(--text-rack-mute)] hover:text-[var(--amber)] hover:bg-[var(--bg-slot)] rounded-[2px] transition-colors cursor-pointer"
                            >
                              <MiniOpenIcon />
                            </button>
                            <button
                              onClick={() => removeWebTabHistory(url)}
                              title={t('webBar.removeRecent')}
                              className="w-[14px] h-[14px] flex-shrink-0 flex items-center justify-center text-xs text-[var(--text-rack-mute)] hover:bg-[var(--error-rack)] hover:text-white rounded-[2px] transition-colors cursor-pointer"
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                      </div>
                    </ScrollFold>
                  </div>
                ))}
              </div>
            </div>
            {/* 下辊行 —— 纸尾辊:贴在纸尾、跟着最底下的分组卷走(纸包内容,
                短内容随纸上浮,内容满列时贴底不动);点行同样一键收/放(鼠标
                入口 —— 键盘由上辊行独占,不给 title 免得与上辊重复) */}
            <div
              className="scroll-dual-rod scroll-dual-rod-b cursor-pointer"
              onClick={toggleAllGroups}
            >
              {/* 辊本体 —— 下辊镜像(纸带锚顶、落影投上,机械在 .scroll-dual-rod-b) */}
              <span aria-hidden className="rod-caps" />
              <span aria-hidden className="scroll-dual-tie"><ScrollTie /></span>
            </div>
          </div>
        )}
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
          (body 裱边四周各 8px)。装配总高(= 双辊 20 + 裱边 16 + 画心)
          沿用 miniHeight 存档语义,拖动映射 1:1 不变。轴头/系绳/解绳辉光
          挂 scroll-dual-web 青蓝段身份(与最近访问墙同一件物,取
          --web-group,不取 amber) */}
      <div
        className={cn(
          'scroll-dual scroll-dual-web flex-shrink-0 select-none',
          miniClosed ? 'rolled' : 'open',
          miniResizing && 'resizing'
        )}
        style={{
          height: miniClosed ? MINI_ROLLED_H : `${miniFitHeight}px`,
          // 渲染期钳(拖动/恢复夹取之外的第二道防线):存档值超当前面板或窗口
          // 临时缩小时视觉收敛,保底铭牌/地址栏/历史留座的粗钳;存档值
          // 不被临时小屏毁掉,窗口回弹即恢复原高 —— 恢复时面板多半未布局,
          // rect 量不到,上限靠这里。贴合值(miniFitHeight)先行把同一把钳
          // 算进 height/--dual-h,本条只在未布局首帧兜底(见其注释)
          maxHeight: `calc(100% - ${MINI_RESERVE_HEIGHT}px)`,
          '--dual-h': `${miniFitHeight}px`
        } as React.CSSProperties}
      >
        {/* 上辊行 —— 开合钮 + 开态拖高手势位:点行开/合(双向),拖高靠位移
            阈值分流(pointer 捕获期 move 超 3px 记真拖动,松手补发的 click
            被重定目标到本行后吞掉);题签已升到装配层居中(行自身即按钮) */}
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
                {/* 迷你工具条:勾玉开眼指示 + 后退/前进/刷新停止 + 小窗地址(datalist
                    复用主地址栏的全量历史)+ 升格 + 关页。tooltip 不写快捷键提示 —— 小窗不挂
                    before-input-event 转发(路由错位问题,见 main/index.ts),写了就是假话。
                    条高 32px = 双开画轴地址栏的满高(辊 24px 上下各留 4px 气) */}
                <div className="flex items-center gap-[3px] px-2 h-[32px] flex-shrink-0 bg-[var(--bg-rack)] border-b border-[var(--rule)]">
                  <MiniEyeGlyph lit={miniUrl !== null} label={t('webBar.mini')} />
                  <NavButton title={t('webBar.miniBack')} disabled={!miniNav.canGoBack} onClick={() => settleWebview(() => miniEl?.goBack())}>
                    <ChevronLeftIcon />
                  </NavButton>
                  <NavButton title={t('webBar.miniForward')} disabled={!miniNav.canGoForward} onClick={() => settleWebview(() => miniEl?.goForward())}>
                    <ChevronRightIcon />
                  </NavButton>
                  <NavButton
                    title={miniLoading ? t('webBar.miniStop') : t('webBar.miniReload')}
                    disabled={miniUrl === null || !miniReady}
                    onClick={() => settleWebview(() => (miniLoading ? miniEl?.stop() : miniEl?.reload()))}
                  >
                    {miniLoading ? <StopIcon /> : <RotateCwIcon />}
                  </NavButton>
                  {/* 小窗地址 —— 双开画轴(与会话搜索框同款挂轴化,机械全在 globals.css 的
                      .scroll-search 系列):两端各一竖辊,常开不随聚焦收放(同主地址栏/
                      会话搜索框「常在动作位」语义)—— 地址作墨 mono 居中落于纸面、
                      横跨正中合缝。再挂 scroll-search-web 青蓝变体(轴头/系绳/解绳辉光
                      取 --web-group,与主地址栏/最近访问墙的组头署名同一件物;几何保持
                      16/24 原档不加高,加高档 scroll-search-lg 只挂主地址栏)。
                      label 承接点击(点纸即落墨,点辊也聚焦);IME/datalist/Esc 的键盘
                      机械原样 */}
                  <label className="scroll-search scroll-search-web open flex-1 min-w-0 h-[32px] relative flex items-center cursor-text">
                    <span aria-hidden className="scroll-search-paper scroll-search-paper-l" />
                    <span aria-hidden className="scroll-search-paper scroll-search-paper-r" />
                    <span aria-hidden className="scroll-search-rod scroll-search-rod-l" />
                    <span aria-hidden className="scroll-search-rod scroll-search-rod-r" />
                    <span aria-hidden className="scroll-search-tie scroll-search-tie-l"><ScrollTie /></span>
                    <span aria-hidden className="scroll-search-tie scroll-search-tie-r"><ScrollTie /></span>
                    <input
                      ref={miniInputRef}
                      type="text"
                      list="lyshell-webbar-history"
                      value={miniInput}
                      onChange={(e) => setMiniInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          // IME 组合中的 Enter 是候选确认,不导航(同主地址栏)
                          if (e.nativeEvent.isComposing) return
                          // datalist 高亮项的提交晚于 keydown(同主地址栏竞态),延后一拍读 DOM
                          setTimeout(handleMiniEnter, 0)
                        } else if (e.key === 'Escape' && miniUrl !== null) {
                          // Esc 放弃编辑,复位为当前页地址(同主地址栏语法)
                          setMiniInput(miniUrl)
                          miniInputRef.current?.blur()
                        }
                      }}
                      onFocus={(e) => e.target.select()}
                      placeholder={t('webBar.miniPlaceholder')}
                      spellCheck={false}
                      className="scroll-search-input relative z-[2] flex-1 min-w-0 mx-[18px] bg-transparent border-none outline-none font-mono text-[11px] text-center text-[var(--text-rack)] caret-[var(--amber)]"
                    />
                  </label>
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
                      <webview ref={setMiniEl} partition={WEBBAR_PARTITION} src={miniSrc ?? undefined} className="w-full h-full" />
                      {miniCovering && (
                        <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--terminal-bg)] text-sm text-gray-400 pointer-events-none">
                          {t('webBar.loading')}
                        </div>
                      )}
                      {miniFailed && (
                        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-[var(--terminal-bg)]">
                          <p className="text-sm text-gray-300">{t('webBar.loadFailed')}</p>
                          <p className="max-w-[80%] truncate font-mono text-xs text-gray-500">
                            {t('webBar.loadFailedHint', { error: miniFailed, url: miniUrl })}
                          </p>
                        </div>
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
        {/* 题签 —— 收起态的卷面名牌:居中浮在上下双卷之间的合缝上(与搜索框
            占位同一位置 —— 双卷之间正是双开画轴的门面),纯展示非交互件
            (pointer-events 穿透,点击落在下方辊行上);开态不渲染,让位给
            画心 */}
        {miniClosed && (
          <span className="pointer-events-none absolute inset-0 z-[2] flex items-center justify-center">
            <span className="scroll-slip text-[11.5px] truncate max-w-full px-3">{t('webBar.mini')}</span>
          </span>
        )}
      </div>
    </div>
  )
}

export default WebPanel
