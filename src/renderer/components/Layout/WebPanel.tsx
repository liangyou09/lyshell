import React, { useEffect, useState } from 'react'
import cn from 'classnames'
import { useTranslation } from 'react-i18next'
import { usePaneStore } from '../../stores/pane-store'
import { TOPBAR_HEIGHT } from './topbar-metrics'
import { WebTabFavicon } from './PaneTabBar'

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
 * 顶部 URL 栏输入完整网址,以终端页签形式打开在活动分屏(多页签,类似 dsh Web 页签);
 * 打开的网页一律走终端页签栏切换/关闭,面板不再列清单。
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
  const [webBarInput, setWebBarInput] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  // 输入完整 URL(无 scheme 自动补 https://)→ 以终端页签形式打开在活动分屏。
  // 非法输入走 notice 提示(对齐其他面板的错误路径)
  const handleOpenWebTab = (): void => {
    setNotice(null)
    const raw = webBarInput.trim()
    if (!raw) return
    const res = openWebTab(raw)
    if (res.ok) {
      setWebBarInput('')
    } else {
      setNotice(t('webBar.invalid'))
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

      {/* 输入动作位 —— 与 HarnessPanel 新增条同构:44px 占位对齐 ActivityRail 槽位,
          输入框 32px 居中悬浮,底部一条随卡片宽度的分割线(px-3 收进,不连接面板
          左右边缘)把动作区与历史区分开 */}
      <div className="flex-shrink-0 h-[44px] px-3 flex flex-col">
        <div className="flex-1 flex items-center">
          {/* 网页访问栏 —— 输入完整 URL 回车即开;无 scheme 自动补 https://;
              datalist 挂最近历史做原生补全 */}
          <div className="flex items-center gap-1 w-full">
            <input
              type="text"
              list="lyshell-webbar-history"
              value={webBarInput}
              onChange={(e) => setWebBarInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleOpenWebTab()
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
