import { DEFAULT_BROWSER_SETTINGS, browserOrigin, type BrowserSettings } from '@shared/browser-settings'

export function validateBrowserSettings(raw: unknown): BrowserSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid browser settings')
  const v = raw as Record<string, unknown>
  const text = (key: string, max: number): string => {
    if (typeof v[key] !== 'string' || (v[key] as string).length > max) throw new Error(`Invalid ${key}`)
    return (v[key] as string).trim()
  }
  const homePage = text('homePage', 4096)
  if (homePage && !browserOrigin(homePage)) throw new Error('Home page requires an HTTP or HTTPS URL')
  if (typeof v.searchEngine !== 'string' || !['none', 'bing', 'google', 'baidu', 'duckduckgo'].includes(v.searchEngine)) throw new Error('Invalid search engine')
  if (typeof v.zoomFactor !== 'number' || !Number.isFinite(v.zoomFactor) || v.zoomFactor < 0.5 || v.zoomFactor > 2) throw new Error('Zoom must be between 50% and 200%')
  for (const key of ['rememberHistory', 'restoreTabs', 'restoreMini', 'savePasswords']) {
    if (typeof v[key] !== 'boolean') throw new Error(`Invalid ${key}`)
  }
  if (typeof v.proxyMode !== 'string' || !['system', 'direct', 'fixed'].includes(v.proxyMode)) throw new Error('Invalid proxy mode')
  const proxyServer = text('proxyServer', 2048)
  const proxyBypass = text('proxyBypass', 2048)
  if (v.proxyMode === 'fixed' && !proxyServer) throw new Error('A proxy server is required')
  if (proxyServer) {
    let url: URL
    try { url = new URL(proxyServer) } catch { throw new Error('Proxy requires a URL such as http://127.0.0.1:7890') }
    if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.pathname !== '/' && url.pathname !== '' || url.search || url.hash) throw new Error('Invalid proxy URL (credentials and paths are not supported)')
  }
  if (!v.permissions || typeof v.permissions !== 'object') throw new Error('Invalid permissions')
  const permissions = { ...DEFAULT_BROWSER_SETTINGS.permissions }
  for (const key of Object.keys(permissions) as Array<keyof typeof permissions>) {
    const mode = (v.permissions as Record<string, unknown>)[key]
    if (mode !== 'ask' && mode !== 'deny') throw new Error(`Invalid permission: ${key}`)
    permissions[key] = mode
  }
  return { homePage, searchEngine: v.searchEngine as BrowserSettings['searchEngine'], zoomFactor: v.zoomFactor, rememberHistory: v.rememberHistory as boolean, restoreTabs: v.restoreTabs as boolean, restoreMini: v.restoreMini as boolean, savePasswords: v.savePasswords as boolean, proxyMode: v.proxyMode as BrowserSettings['proxyMode'], proxyServer, proxyBypass, permissions }
}
