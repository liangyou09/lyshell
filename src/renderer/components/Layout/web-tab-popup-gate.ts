/**
 * webview 弹窗转页签的防刷闸 —— 主进程把 guest 的开窗请求（deny 后）经
 * WEB_TAB_POPUP 转发过来，这里裁决「开不开完整网页页签」。
 *
 * 为什么需要闸：转发请求不带手势信号 —— guest 的 before-input-event 只对键盘
 * 触发（Electron 28 实测：mouseDown/mouseUp 不经过该事件），「用户点链接开的
 * 弹窗」与「脚本自刷的弹窗」无从分辨。抖音等站会无手势反复 window.open
 * （登录窗/广告/SSO），且弹窗开的页签自身又走同一条转发链路，不设闸就是
 * 无限弹页签的刷屏。
 *
 * 闸规则（手势信号缺失下的行为特征近似，Chrome 弹窗拦截器语义）：
 * 1. 同键去重：弹窗键 = origin + pathname（剥 query/hash —— 追踪参数变体同键）。
 *    某键已由弹窗开过、对应页签还开着 → 丢 —— 同址脚本重刷被压在 1 个页签；
 *    页签关了键出册，正常重开不受影响。「页签还开着」按 overlay 的 url 与
 *    nav.url（redirect 落点）双读对账。
 * 2. 短窗频控：滚动 5s 窗口内放行超 3 个 → 丢 —— 首载风暴/级联的硬顶；手点
 *    连开 3 个不同链接远到不了这个节奏。
 *
 * 裁决（gateWebTabPopup）与登记（recordWebTabPopup）两相分离：调用方先裁决，
 * openWebTab 挂载成功后才登记 —— URL 最终非法（normalizeWebBarUrl 拒收）或无
 * pane 可挂时，频控额度不被消耗、键册不留残键。
 *
 * 误伤面：关掉弹窗页签后极快同址再点、5s 内手点第 4 个不同链接 —— 边缘场景，
 * 换取刷屏免疫。被丢的地址 console.warn 留痕（devtools 可查），与
 * settleWebview 的异常口径一致。
 */
import { usePaneStore } from '../../stores/pane-store'

const POPUP_BURST_WINDOW_MS = 5000
const POPUP_BURST_MAX = 3
// 键册封顶：长会话防无界增长（200 个键已远超任何真实刷屏场景的判别需要）
const POPUP_KEYS_MAX = 200

/** 弹窗键：origin + pathname，剥 query/hash —— 同路径不同追踪参数视为同键 */
function popupKeyOf(url: string): string {
  try {
    const u = new URL(url)
    return `${u.origin}${u.pathname}`
  } catch {
    return url
  }
}

// 弹窗开过的键册（Map 保插入序，超顶删最旧）。条目随「该键的页签已全关」出册
const popupOpenedKeys = new Map<string, true>()
// 滚动窗口内的放行时间戳
const popupTimestamps: number[] = []

/** 开着的网页页签键全集：payload.url = 打开时地址，nav.url = redirect 落点 */
function openWebTabKeys(): Set<string> {
  const keys = new Set<string>()
  for (const p of Object.values(usePaneStore.getState().overlayPayloads)) {
    if (p?.kind !== 'web') continue
    keys.add(popupKeyOf(p.url))
    if (p.nav?.url) keys.add(popupKeyOf(p.nav.url))
  }
  return keys
}

/**
 * 弹窗地址闸门（只裁决，不记账）：true = 放行开完整网页页签，false = 丢。
 * 裁决通过后调用方须在 openWebTab 挂载成功时 recordWebTabPopup 登记，否则
 * 频控与键册不记本次（见模块注释的分离语义）。
 * 只经 IPC 边界转发弹窗路径调用（url 已过主进程 isHttpUrl，这里不再复验 ——
 * openWebTab 的 normalizeWebBarUrl 是最终闸）。
 */
export function gateWebTabPopup(url: string): boolean {
  const key = popupKeyOf(url)
  // 键册对账：弹窗开过的键里，页签已全关的出册（同址重弹允许再开一次）
  const open = openWebTabKeys()
  for (const k of popupOpenedKeys.keys()) {
    if (!open.has(k)) popupOpenedKeys.delete(k)
  }
  // 同键去重：该键的页签还开着，弹窗不再开第二份
  if (popupOpenedKeys.has(key)) {
    console.warn('[WebTabPopup] dropped: popup for already-open tab:', url)
    return false
  }
  // 短窗频控：滚动窗口内放行数封顶
  const now = Date.now()
  while (popupTimestamps.length > 0 && now - popupTimestamps[0] >= POPUP_BURST_WINDOW_MS) {
    popupTimestamps.shift()
  }
  if (popupTimestamps.length >= POPUP_BURST_MAX) {
    console.warn('[WebTabPopup] dropped: popup burst limit exceeded:', url)
    return false
  }
  return true
}

/**
 * 弹窗放行登记 —— 调用方在 openWebTab 挂载成功后调用（裁决与登记分离，
 * 见模块注释）：消耗一个短窗频控名额、键进册。
 */
export function recordWebTabPopup(url: string): void {
  popupTimestamps.push(Date.now())
  popupOpenedKeys.set(popupKeyOf(url), true)
  if (popupOpenedKeys.size > POPUP_KEYS_MAX) {
    popupOpenedKeys.delete(popupOpenedKeys.keys().next().value as string)
  }
}

/** 测试用：复位闸内两份模块态（生产不调用） */
export function resetWebTabPopupGateForTest(): void {
  popupOpenedKeys.clear()
  popupTimestamps.length = 0
}
