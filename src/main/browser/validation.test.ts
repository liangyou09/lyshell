import { describe, expect, it } from 'vitest'
import { DEFAULT_BROWSER_SETTINGS } from '@shared/browser-settings'
import { validateBrowserSettings } from './validation'

describe('浏览器配置校验', () => {
  it('接受完整默认配置并去掉未知字段', () => {
    expect(validateBrowserSettings({ ...DEFAULT_BROWSER_SETTINGS, injected: 'value' })).toEqual(DEFAULT_BROWSER_SETTINGS)
  })
  it.each([
    { homePage: 'file:///a' }, { homePage: 'javascript:alert(1)' }, { homePage: 'https://u:p@example.com' },
    { zoomFactor: NaN }, { zoomFactor: 3 }, { zoomFactor: 0.1 }, { rememberHistory: 'true' },
    { proxyMode: 'bad' }, { permissions: { camera: 'allow' } }, { searchEngine: '__proto__' },
    { proxyMode: ['system'] }, { searchEngine: ['bing'] },
    { proxyMode: 'fixed', proxyServer: 'http://user:password@localhost:8080' },
    { proxyMode: 'system', proxyServer: 'http://user:password@localhost:8080' },
    { proxyMode: 'fixed', proxyServer: 'file:///tmp/a' },
    { proxyMode: 'fixed', proxyServer: 'http://localhost:8080/path' }
  ])('拒绝无效配置 %j', patch => expect(() => validateBrowserSettings({ ...DEFAULT_BROWSER_SETTINGS, ...patch })).toThrow())
  it.each(['http://127.0.0.1:7890', 'socks5://localhost:1080', 'socks4://localhost:1080', 'https://proxy.example:8443'])('支持代理 %s', proxyServer => {
    expect(validateBrowserSettings({ ...DEFAULT_BROWSER_SETTINGS, proxyMode: 'fixed', proxyServer }).proxyServer).toBe(proxyServer)
  })
})
