/** webview 框架导航判定：仅对已接管的抖音心跳子框架深链省略预期噪音日志。 */
export function decideWebviewFrameNavigation(
  rawUrl: string,
  isMainFrame: boolean,
  isWebbar: boolean,
  handledDeepLinkSchemes: ReadonlySet<string>
): 'allow' | 'cancel' | 'cancel-silent' {
  try {
    const url = new URL(rawUrl)
    const scheme = url.protocol.slice(0, -1).toLowerCase()
    if (scheme === 'http' || scheme === 'https') return 'allow'
    if (isWebbar && !isMainFrame && handledDeepLinkSchemes.has(scheme) &&
        url.href === 'bytedance://dispatch_message/') return 'cancel-silent'
  } catch { /* 畸形 URL 仍取消并记录 */ }
  return 'cancel'
}

/** 子框架直航与重定向共用同一闸；返回 true 表示已处理，调用方不再走主框架逻辑。 */
export function gateWebviewSubframeNavigation(
  event: { url: string; isMainFrame: boolean; preventDefault(): void },
  isWebbar: boolean,
  handledDeepLinkSchemes: ReadonlySet<string>,
  warnBlocked: (url: string) => void
): boolean {
  if (event.isMainFrame) return false
  const decision = decideWebviewFrameNavigation(event.url, false, isWebbar, handledDeepLinkSchemes)
  if (decision !== 'allow') {
    event.preventDefault()
    if (decision === 'cancel') warnBlocked(event.url)
  }
  return true
}
