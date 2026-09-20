import React, { useEffect, useRef, useState } from 'react'
import cn from 'classnames'
import { useTranslation } from 'react-i18next'
import type { WebviewTag } from 'electron'
import { usePaneStore, normalizeWebBarUrl } from '../../stores/pane-store'
import { useUiStore } from '../../stores/ui-store'
import { TOPBAR_HEIGHT } from './topbar-metrics'
import { WebTabFavicon } from './PaneTabBar'
import {
  selectActiveWebTabId, navigateActiveWebTab, reloadActiveWebTab, stopActiveWebTab,
  activeWebTabGoBack, activeWebTabGoForward, getWebview
} from './web-tab-controls'
import { ScrollTie } from './ScrollFold'

/** datalist 选项 label 用:取 hostname,取不到回落原样字符串(与页签 title 初始值同源);
    历史行本身直接显示完整 URL,不再缩略为 hostname */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname || url
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

/** 导航图标组(lucide 线稿风格,stroke 随 currentColor,同 TrashIcon 12x12)——后退/前进/刷新/停止 */
const ChevronLeftIcon: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="m15 18-6-6 6-6" />
  </svg>
)
const ChevronRightIcon: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="m9 18 6-6-6-6" />
  </svg>
)
const RotateCwIcon: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
  </svg>
)
const StopIcon: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect width="13" height="13" x="5.5" y="5.5" rx="1" />
  </svg>
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

/** 升格图标（lucide external-link 线稿风格）——把小窗当前页开成完整网页页签 */
const PromoteIcon: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M13 4h7v7" />
    <path d="M20 4 9 15" />
    <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </svg>
)

/** 垃圾桶图标(lucide trash 线稿风格,stroke 随 currentColor)——「清空」按钮用 */
const TrashIcon: React.FC = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <line x1="10" y1="11" x2="10" y2="17" />
    <line x1="14" y1="11" x2="14" y2="17" />
  </svg>
)

/**
 * 历史行 favicon:优先取持久化映射(打开网页页签时捕获的官方 favicon),
 * 没有再回落猜 origin/favicon.ico。两者都没有则不占位,行内只显示 URL。
 */
const RecentFavicon: React.FC<{ url: string; favicon?: string }> = ({ url, favicon }) => {
  const [src, setSrc] = useState<string | null>(favicon ?? null)
  useEffect(() => {
    if (favicon) {
      setSrc(favicon)
      return
    }
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
 * 网页访问面板(机柜左列 Web 页签)。
 * 双模式:活动分屏正显示网页页签时是「浏览器 chrome」—— 地址栏同步当前 URL
 * (payload.nav,did-navigate 回写)、Enter 就地导航、后退/前进/刷新/停止按钮
 * (指令经 web-tab-controls 落到活动页签);否则是「启动器」—— 顶部 URL 栏输入
 * 完整网址,以终端页签形式打开在活动分屏(多页签,类似 dsh Web 页签),打开的网页
 * 一律走终端页签栏切换/关闭,面板不再列清单。
 * 下方是「最近访问」历史(localStorage 持久化,pane-store webTabHistory):
 * 点击重开、✕ 删除单条、段头清空;输入框挂 datalist 原生补全。
 * URL 归一化/校验在 pane-store 的 normalizeWebBarUrl;webview 的导航/弹窗由主进程
 * 按 persist:webbar partition 分流锁定(仅 http/https,见 main/index.ts)。
 *
 * 栏底是「写轮眼小窗」—— 模拟会话面板文件管理器的栏底语法(4px 拖高条 + config
 * 持久化高度)的迷你浏览器:不动用终端分屏的快速查阅面,Ctrl+点击历史行在此预览,
 * ↗ 升格为完整网页页签;webview 与完整网页页签共用 partition persist:webbar
 * (cookie/localStorage 同仓,登录态互通 —— 页签里登过小窗即登录态),快捷键转发
 * 不挂(经 dom-ready 登记 webContentsId 排除,避免路由到活动页签的错位,见
 * main/index.ts),上次地址 localStorage 恢复。
 *
 * 样式沿用面板令牌(--bg-elev/--bg-slot/--rule/--amber/--text-rack*)与
 * [font-family:inherit] 12px 基线,头条与 SessionsPanel/PluginPanel 同构。
 */
const WebPanel: React.FC = () => {
  const { t } = useTranslation()
  const openWebTab = usePaneStore((s) => s.openWebTab)
  const webTabHistory = usePaneStore((s) => s.webTabHistory)
  const webTabFavicons = usePaneStore((s) => s.webTabFavicons)
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
  // redirect 后的真实地址而非输入原值）。挂载即从 localStorage 恢复上次页面 ——
  // 切回 Web 页签小窗原页还在，像「常驻的地方」而不是每次重填的表单
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
  // 小窗地址栏聚焦态 —— 双开画轴的开合裁决之一:开 = 聚焦或有址(有址即开眼,
  // 未编辑时 miniInput 恒同步当前页地址);收 = 失焦且未开眼 —— 与勾玉指示同一
  // 状态语言(闭眼 = 双卷拴绳,开眼 = 纸展墨落)
  const [miniInputFocused, setMiniInputFocused] = useState(false)
  const [miniLoading, setMiniLoading] = useState(false)
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
  // 挂载即带 src 也绕开「无 src 的 webview 是否触发 dom-ready」的不确定面
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
  // 对账落定前不挂小窗本体(miniConfigLoaded 门):本面板随 Web 页签条件挂载,
  // 存档 closed=true 时若先按默认 false 渲染,每次进页签都会挂 webview 拉起
  // guest 进程抓一次页面再拆 —— 闪现 + 白费一次真实导航
  const [miniConfigLoaded, setMiniConfigLoaded] = useState(false)
  // 双开画轴内容挂载裁决:开 = 立即挂(工具条/浏览面随纸展开);合 = 延迟
  // 360ms 卸载(合向 320ms 纸卷完再收内容)—— 纸裹着内容卷回。与 FM 不同,
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

  // 双开画轴内容挂载裁决(状态声明处注释):开 = 立即挂;合 = 延迟 360ms 卸载,
  // 合向动画期间重开则 cleanup 掐掉定时器、内容原样还在(webview 免重挂,
  // src 冻结纪律不受扰动)
  const [miniContentMounted, setMiniContentMounted] = useState(false)
  useEffect(() => {
    if (!miniClosed) {
      setMiniContentMounted(true)
      return undefined
    }
    const timer = setTimeout(() => setMiniContentMounted(false), 360)
    return () => clearTimeout(timer)
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

  // 关闭期间冻结 src 跟随 miniUrl：恢复重挂以「关闭时的页面」首航，而不是停在
  // 首航定格的旧地址（否则 src 首航触发 did-navigate 回写旧落点，既冲掉真实
  // miniUrl 又把旧地址写进 localStorage 存档）。src 恒不变纪律只约束同一元素
  // 的生命周期 —— 合卷改走延迟卸载后，关闭后的 360ms 里元素还活着，此刻改
  // 冻结值会原地改写活 webview 的 src（真机上 = 卷纸期间整页白拉重载一次）。
  // 门在 miniEl === null：卷上的元素真卸了（回调 ref 落 null 重跑本 effect）
  // 才跟随，无元素时更新冻结值不触发任何重载
  useEffect(() => {
    if (miniClosed && miniEl === null && miniSrc !== miniUrl) setMiniSrc(miniUrl)
  }, [miniClosed, miniEl, miniSrc, miniUrl])

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
      // 摘树(关闭摘 UI)即复位就绪门：恢复重挂时本 effect 晚于导航 effect
      // (声明序)跑，若 miniReady 留着上一元素的陈旧 true，导航 effect 会在
      // dom-ready 门开前调 getURL() —— 真机直接炸（jsdom 桩测不出）
      setMiniReady(false)
      return
    }
    // 新元素一律先判未就绪:未来若有「关小窗」重挂路径,防上一元素的陈旧 true
    setMiniReady(false)
    const onDomReady = (): void => {
      setMiniReady(true)
      // 小窗与完整页签共用 webbar partition(登录态互通):主进程的快捷键转发凭
      // webContentsId 登记区分两者,这里把小窗报上去 —— 之后小窗内的按键不再被
      // 拦截转发到「活动完整页签」,reload/后退由 guest 原生处理。登记晚于
      // did-attach(getWebContentsId 在 dom-ready 前调用会抛错,只能在这拍报)。
      // 重挂(关再开/切回 Web 页签)产生新 id、新元素 dom-ready 重报覆盖
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
    const onStartLoading = (): void => { setMiniLoading(true); setMiniFailed(null) }
    const onStopLoading = (): void => setMiniLoading(false)
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
    // 小窗处于关闭态时的载入(Ctrl+点击历史行) = 预览意图,顺手重开:否则
    // URL 只落 state 而 webview 摘着树,点击像静默无反馈,落点回写还会
    // 冲掉 localStorage 存档的旧地址
    if (miniClosed) setMiniClosed(false)
    const el = miniEl
    if (el && miniReady && el.getURL() === norm) {
      settleWebview(() => el.reload())
      return true
    }
    if (miniSrc === null) setMiniSrc(norm)
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
      className="w-full h-full flex flex-col bg-[var(--bg-base)]"
      style={{ fontFamily: 'ui-monospace, "JetBrains Mono", "Cascadia Code", Consolas, monospace' }}
    >
      {/* 头条:网页铭牌 —— 与 SessionsPanel/PluginPanel 头行同构(行高对齐终端第一行、
          满幅 border-b 发丝线、铭牌走系统 UI 字体做「厂牌丝印」) */}
      <div
        className="flex items-center justify-between gap-1 px-3 border-b border-[var(--rule)] flex-shrink-0"
        style={{ height: TOPBAR_HEIGHT }}
      >
        <span
          className="flex-1 min-w-0 truncate font-bold tracking-[-0.01em] text-[16px] text-[var(--text-rack)] select-none"
          style={{ fontFamily: '"Segoe UI Variable Display", "Segoe UI", system-ui, "PingFang SC", "Microsoft YaHei", sans-serif' }}
        >
          {t('webBar.title')}
        </span>
      </div>

      {/* 输入动作位 —— 44px 输入行(32px 输入框居中悬浮,上下各 6px 呼吸),
          底部一条随卡片宽度的分割线(px-3 收进,不连接面板
          左右边缘)把动作区与历史区分开 */}
      <div className="flex-shrink-0 h-[44px] px-3 flex flex-col">
        <div className="flex-1 flex items-center">
          {/* 网页访问栏 —— 浏览器模式(活动分屏正显示网页页签)时是地址栏:
              同步当前 URL、Enter 就地导航;启动器模式输入完整 URL 回车即开新页签
              (无 scheme 自动补 https://),datalist 挂最近历史做原生补全 */}
          <div className="flex items-center gap-1 w-full">
            {/* 导航按钮 —— 落点 = 活动网页页签(web-tab-controls 控制层) */}
            <NavButton title={t('webBar.back')} disabled={!activeNav?.canGoBack} onClick={activeWebTabGoBack}>
              <ChevronLeftIcon />
            </NavButton>
            <NavButton title={t('webBar.forward')} disabled={!activeNav?.canGoForward} onClick={activeWebTabGoForward}>
              <ChevronRightIcon />
            </NavButton>
            <NavButton
              title={activeNav?.loading ? t('webBar.stop') : t('webBar.reload')}
              disabled={activeWebTabId === null}
              onClick={() => (activeNav?.loading ? stopActiveWebTab() : reloadActiveWebTab(false))}
            >
              {activeNav?.loading ? <StopIcon /> : <RotateCwIcon />}
            </NavButton>
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
              className="flex-1 min-w-0 px-2 h-[32px] text-xs [font-family:inherit] rounded-[2px] bg-[var(--bg-elev)] border border-[var(--rule)] text-[var(--text-rack)] placeholder:text-[var(--text-rack-mute)] focus:outline-none focus:border-[var(--amber)]"
            />
            {/* datalist 选项 = 全量历史(store 已封顶 30 条,无需再截) */}
            <datalist id="lyshell-webbar-history">
              {webTabHistory.map(url => (
                <option key={url} value={url}>{hostOf(url)}</option>
              ))}
            </datalist>
          </div>
        </div>
        <div aria-hidden className="h-px bg-[var(--rule-soft)]" />
      </div>

      {/* 内容笼:p-3 + space-y-2(与 PluginPanel 同构);顶部 pt-1.5 贴分割线起排,
          底部 pb-1.5 贴小窗拖高条(栏底语法:历史卡与拖高条之间只留 6px 空气) */}
      <div className="flex-1 min-h-0 flex flex-col px-3 pt-1.5 pb-1.5 space-y-2">

        {notice && <div className="text-[10.5px] [font-family:inherit] text-[var(--text-rack-data)] break-all">{notice}</div>}

        {/* 最近访问 —— localStorage 持久化历史:行样式对齐终端页签(favicon + 单行
            truncate+tooltip 看全量、bg-rack 底、hover bg-slot、行高 32px);点击重开、
            ✕ 删除单条、段头清空。常占剩余空间(打开的网页不再在此列出,切换/关闭走终端页签栏) */}
        {webTabHistory.length > 0 && (
          <div
            className={cn(
              'border border-[var(--rule)] rounded-[2px] min-h-0 overflow-y-auto flex-1 flex-shrink-0'
            )}
          >
            <div className="flex items-center justify-between gap-1 px-1.5 py-1 border-b border-[var(--rule)] sticky top-0 bg-[var(--bg-base)]">
              <span className="text-[10.5px] [font-family:inherit] text-[var(--text-rack)] select-none">
                {t('webBar.recent')}
              </span>
              <button
                onClick={clearWebTabHistory}
                title={t('webBar.clear')}
                className="w-[18px] h-[18px] flex items-center justify-center text-[var(--text-rack)] hover:text-[var(--error-rack)] hover:bg-[var(--error-rack)]/10 rounded-[2px] cursor-pointer transition-colors"
              >
                <TrashIcon />
              </button>
            </div>
            {webTabHistory.map(url => (
              <div
                key={url}
                className="flex items-center gap-1.5 px-2 h-[32px] border-b border-[var(--rule-soft)] last:border-b-0 bg-[var(--bg-rack)] hover:bg-[var(--bg-slot)] transition-colors"
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
          绳(320ms 加速收,内容延迟 360ms 卸载)。画心立在纸面中央
          (body 裱边四周各 8px)。装配总高(= 双辊 20 + 裱边 16 + 画心)
          沿用 miniHeight 存档语义,拖动映射 1:1 不变 */}
      <div
        className={cn(
          'scroll-dual flex-shrink-0 select-none',
          miniClosed ? 'rolled' : 'open',
          miniResizing && 'resizing'
        )}
        style={{
          height: miniClosed ? MINI_ROLLED_H : `${miniHeight}px`,
          // 渲染期钳(拖动/恢复夹取之外的第二道防线):存档值超当前面板或窗口
          // 临时缩小时视觉收敛,保底铭牌/地址栏/历史留座的粗钳;存档值
          // 不被临时小屏毁掉,窗口回弹即恢复原高 —— 恢复时面板多半未布局,
          // rect 量不到,上限靠这里
          maxHeight: `calc(100% - ${MINI_RESERVE_HEIGHT}px)`,
          '--dual-h': `${miniHeight}px`
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
                    复用主地址栏的全量历史)+ 升格。tooltip 不写快捷键提示 —— 小窗不挂
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
                      .scroll-search 系列,此处只挂态):两端各一竖辊,开 = 聚焦或有址 ——
                      有址即开眼(未编辑时 miniInput 恒同步当前页地址,URL 作墨 mono 居中
                      落于纸面、横跨正中合缝);收 = 失焦且未开眼 —— 双卷拴绳、题签金墨的
                      占位浮在两卷之间,与勾玉「闭眼」同一状态语言。label 承接点击(点纸即
                      落墨,点辊也聚焦);IME/datalist/Esc 的键盘机械原样 */}
                  <label
                    className={cn(
                      'scroll-search flex-1 min-w-0 h-[32px] relative flex items-center cursor-text',
                      miniInputFocused || miniInput !== '' ? 'open' : 'rolled'
                    )}
                  >
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
                      onFocus={(e) => { setMiniInputFocused(true); e.target.select() }}
                      onBlur={() => setMiniInputFocused(false)}
                      placeholder={t('webBar.miniPlaceholder')}
                      spellCheck={false}
                      className="scroll-search-input relative z-[2] flex-1 min-w-0 mx-[18px] bg-transparent border-none outline-none font-mono text-[11px] text-center text-[var(--text-rack)] caret-[var(--amber)]"
                    />
                  </label>
                  <NavButton title={t('webBar.miniOpenTab')} disabled={miniUrl === null} onClick={handleMiniPromote}>
                    <PromoteIcon />
                  </NavButton>
                </div>
                {/* 浏览面:未开眼 = 空态指引(空屏是行动邀请);开眼 = webview + 加载/
                    失败浮层(WebTabOverlay 同款,webview 无内建 UI)。
                    webview 额外双门(见 config 对账 effect 注释 + 合卷机械):
                    miniConfigLoaded —— 存档关闭态落定前不挂 guest,本面板随
                    Web 页签条件挂载,closed=true 与 loaded=true 同批落定时卷
                    从未挂起,零闪挂/零白拉;「!miniClosed || miniEl 非空」——
                    关着的卷不新挂 guest,合卷动画期间已挂的卷随纸同卷(360ms
                    延迟卸载随父层走,miniEl 非空即「卷上还有页面」的自证)。
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
                      <webview ref={setMiniEl} partition="persist:webbar" src={miniSrc ?? undefined} className="w-full h-full" />
                      {miniLoading && (
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
