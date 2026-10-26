/**
 * webview 弹窗转页签的短窗频控：5 秒内最多放行 3 次，限制脚本弹窗风暴。
 * 相同链接允许重复打开；不再根据已有页签或 URL 合并用户的开页请求。
 * 裁决与登记分离：只有 openWebTab 挂载成功才消耗额度。
 */
const POPUP_BURST_WINDOW_MS = 5000
const POPUP_BURST_MAX = 3
const popupTimestamps: number[] = []

/** 只裁决，不记账；URL 合法性由调用方的 openWebTab 校验。 */
export function gateWebTabPopup(url: string): boolean {
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

/** 调用方在页签挂载成功后登记；GET 与 POST 使用相同频控。 */
export function recordWebTabPopup(): void {
  popupTimestamps.push(Date.now())
}

/** 测试用：复位频控状态（生产不调用）。 */
export function resetWebTabPopupGateForTest(): void {
  popupTimestamps.length = 0
}
