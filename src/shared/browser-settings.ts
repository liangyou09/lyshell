export const BROWSER_CHANNEL = 'browser:request'
/** 内置新标签页标识，只由 renderer 绘制，不交给 webview 导航。 */
export const BROWSER_NEW_TAB_URL = 'lyshell://new-tab'
export const BROWSER_CAPTURE_CHANNEL = 'browser:password-capture'
export const BROWSER_FILL_CHANNEL = 'browser:password-fill'
export type SearchEngine = 'none' | 'bing' | 'google' | 'baidu' | 'duckduckgo'
export type BrowserPermission = 'camera' | 'microphone' | 'notifications' | 'geolocation' | 'clipboard'
export interface BrowserSettings {
  homePage: string
  searchEngine: SearchEngine
  zoomFactor: number
  rememberHistory: boolean
  restoreTabs: boolean
  restoreMini: boolean
  savePasswords: boolean
  proxyMode: 'system' | 'direct' | 'fixed'
  proxyServer: string
  proxyBypass: string
  permissions: Record<BrowserPermission, 'ask' | 'deny'>
}
export const DEFAULT_BROWSER_SETTINGS: BrowserSettings = {
  homePage: '', searchEngine: 'bing', zoomFactor: 1, rememberHistory: true,
  restoreTabs: false, restoreMini: true, savePasswords: true,
  proxyMode: 'system', proxyServer: '', proxyBypass: '<local>',
  permissions: { camera: 'ask', microphone: 'ask', notifications: 'ask', geolocation: 'ask', clipboard: 'ask' }
}
export interface BrowserPasswordInfo { id: string; origin: string; username: string; updatedAt: number }
export type BrowserRequest =
  | { kind: 'get' }
  | { kind: 'save'; settings: BrowserSettings }
  | { kind: 'clear'; target: 'cache' | 'siteData' }
  | { kind: 'passwords' }
  | { kind: 'savePassword'; origin: string; username: string; password: string }
  | { kind: 'deletePassword'; id: string }
export interface BrowserResult {
  success: boolean
  error?: string
  settings?: BrowserSettings
  passwords?: BrowserPasswordInfo[]
  encryptionAvailable?: boolean
}

/** 地址栏才支持搜索；导航/弹窗的 URL 闸不接受搜索词。 */
export function browserAddress(raw: string, engine: SearchEngine): string | null {
  const value = raw.trim()
  if (!value) return null
  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(value) && !/^[\w.-]+:\d+(?:\/|$)/.test(value)
  if (hasScheme && !/^https?:\/\//i.test(value)) return null
  const looksLikeAddress = hasScheme || /^(localhost|\[[\da-f:]+\]|[^\s/]+\.[^\s/]+)(?::\d+)?(?:[/?#]|$)/i.test(value) || /^[\w.-]+:\d+(?:\/|$)/.test(value)
  if (looksLikeAddress || engine === 'none') {
    try {
      const url = new URL(hasScheme ? value : `https://${value}`)
      return /^https?:$/.test(url.protocol) && url.hostname && !url.username && !url.password ? url.href : null
    } catch { return null }
  }
  const bases = { bing: 'https://www.bing.com/search?q=', google: 'https://www.google.com/search?q=', baidu: 'https://www.baidu.com/s?wd=', duckduckgo: 'https://duckduckgo.com/?q=' }
  return bases[engine] + encodeURIComponent(value)
}

export function browserOrigin(raw: string): string | null {
  try {
    const u = new URL(raw)
    return /^https?:$/.test(u.protocol) && u.hostname && !u.username && !u.password ? u.origin : null
  } catch { return null }
}
