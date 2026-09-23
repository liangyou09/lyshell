/**
 * 网页页签控制层 —— webview 元素注册表 + 「活动网页页签」导航操作。
 *
 * webview 是渲染层 DOM，pane-store 摸不到元素本身；这里用 module 级 Map 登记
 * （先例：registerDocLinkProvider 的 registeredTerminals WeakMap），WebTabOverlay
 * 挂载/卸载时注册/注销。面板按钮（WebPanel）、宿主快捷键（MainWindow keydown）、
 * 主进程转发（before-input-event → IPC）三方共用同一组操作，落点恒为
 * 「活动 pane 的活动网页页签」。
 *
 * 已知取舍：主进程转发不带 webview 身份（guest webContents ↔ overlay id 无映射
 * 通道），动作统一路由到活动页签 —— WebTabOverlay 的焦点激活（focus / focusin /
 * window blur 三保险）保证「用户正交互的 webview = 活动 pane 的活动页签」，常态自洽。
 */
import type { WebviewTag } from 'electron'
import type { PaneLayout } from '@shared/types'
import { usePaneStore, normalizeWebBarUrl, findPane } from '../../stores/pane-store'

/** overlay id → webview 元素（WebTabOverlay 挂载期登记，卸载即注销） */
const webviews = new Map<string, WebviewTag>()

export function registerWebview(id: string, el: WebviewTag): void {
  webviews.set(id, el)
}

export function unregisterWebview(id: string): void {
  webviews.delete(id)
}

export function getWebview(id: string): WebviewTag | null {
  return webviews.get(id) ?? null
}

/**
 * 快照安全的活动网页页签判定（浏览器态）：只读传入切片的 layout 树与
 * activePaneId —— 不经过 activeOverlayInPane 这类内部走 get() 的方法（会撕裂
 * selector 快照与活 store，React 18 并发渲染出错位中间态，见 MainWindow 顶注）。
 * WebPanel 的地址栏显示与本控制层的指令路由共用本判定，「活动网页页签」只有
 * 这一处定义。
 */
export const selectActiveWebTabId = (s: { layout: PaneLayout }): string | null => {
  const pane = findPane(s.layout.root, s.layout.activePaneId)
  const ref = pane?.type === 'leaf' ? pane.overlays.find(r => r.active) : undefined
  return ref !== undefined && ref.kind === 'web' ? ref.id : null
}

/** 活动 pane 的活动覆盖层是网页页签时返回其 overlay id，否则 null（浏览器态判定）。
 *  事件回调 / 指令路由用（读即时 state）；渲染期订阅一律用 selectActiveWebTabId */
export function activeWebTabId(): string | null {
  return selectActiveWebTabId(usePaneStore.getState())
}

function activeWebview(): WebviewTag | null {
  const id = activeWebTabId()
  return id !== null ? webviews.get(id) ?? null : null
}

/**
 * 地址栏就地导航（Mode B 的 Enter）。返回 false 仅当 URL 非法 —— 目标 webview
 * 瞬缺（页签刚开、覆盖层挂载竞态）按已导航处理返回 true：调用方此时就是活动
 * 页签，静默比误报「无效 URL」更接近事实。
 */
export function navigateActiveWebTab(raw: string): boolean {
  const url = normalizeWebBarUrl(raw)
  if (!url) return false
  activeWebview()?.loadURL(url)
  return true
}

/** 刷新活动网页页签（hard=true 忽略缓存强刷，对应 Ctrl+Shift+R） */
export function reloadActiveWebTab(hard: boolean): void {
  const el = activeWebview()
  if (!el) return
  if (hard) el.reloadIgnoringCache()
  else el.reload()
}

/** 停止活动网页页签的加载中导航 */
export function stopActiveWebTab(): void {
  activeWebview()?.stop()
}

export function activeWebTabGoBack(): void {
  activeWebview()?.goBack()
}

export function activeWebTabGoForward(): void {
  activeWebview()?.goForward()
}

/** 打开活动网页页签客体的 DevTools：页面行为异常（按钮点不动、脚本疑似报错）时
 *  的取证入口 —— 客体 console 的报错只进 guest devtools，不开则完全不可见 */
export function openActiveWebTabDevTools(): void {
  activeWebview()?.openDevTools()
}
