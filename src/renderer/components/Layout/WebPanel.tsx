import React, { useEffect, useRef, useState } from 'react'
import cn from 'classnames'
import { useTranslation } from 'react-i18next'
import { usePaneStore } from '../../stores/pane-store'
import { useUiStore } from '../../stores/ui-store'
import { TOPBAR_HEIGHT } from './topbar-metrics'
import { WebTabFavicon } from './PaneTabBar'
import {
  selectActiveWebTabId, navigateActiveWebTab, reloadActiveWebTab, stopActiveWebTab,
  activeWebTabGoBack, activeWebTabGoForward, getWebview
} from './web-tab-controls'

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

      {/* 输入动作位 —— 44px 占位对齐 ActivityRail 槽位(轨上 36–80px),
          输入框 32px 居中悬浮,底部一条随卡片宽度的分割线(px-3 收进,不连接面板
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

      {/* 内容笼:p-3 + space-y-2(与 PluginPanel 同构);顶部 pt-1.5 贴分割线起排 */}
      <div className="flex-1 min-h-0 flex flex-col px-3 pt-1.5 pb-3 space-y-2">

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
                  onClick={() => openWebTab(url)}
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
    </div>
  )
}

export default WebPanel
