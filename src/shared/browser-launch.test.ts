import { describe, expect, it } from 'vitest'
import { externalBrowserUrl, parseBrowserLaunchUrls } from './browser-launch'

describe('系统网页链接解析', () => {
  it('保留查询、转义、片段和国际域名', () => {
    expect(parseBrowserLaunchUrls(['--open-url', 'https://例子.测试/路径?q=a%20b&n=2#片段']))
      .toEqual([new URL('https://例子.测试/路径?q=a%20b&n=2#片段').href])
    expect(parseBrowserLaunchUrls(['--open-url=http://localhost:8080/a', 'https://example.com/b']))
      .toEqual(['http://localhost:8080/a', 'https://example.com/b'])
  })

  it('拒绝非网页协议、凭据、畸形值和控制字符', () => {
    for (const raw of [null, 1, 'example.com', 'file:///C:/a.html', 'javascript:alert(1)', 'lyshell://new-tab',
      'https://user:pass@example.com', 'https://example.com/\npath', 'https://example.com/a b', 'https://', 'https://a/' + 'x'.repeat(16384)]) {
      expect(externalBrowserUrl(raw)).toBeNull()
    }
    expect(parseBrowserLaunchUrls(['--open-url', '--inspect=9222', '--open-url=javascript:alert(1)'])).toEqual([])
    expect(parseBrowserLaunchUrls(['--open-url'])).toEqual([])
  })

  it('不将普通参数、目录和引擎开关当网页，并限制单次批量', () => {
    expect(parseBrowserLaunchUrls(['--open-directory', 'C:/工作区', '--user-data-dir=https://example.com'])).toEqual([])
    expect(parseBrowserLaunchUrls(Array(40).fill('https://example.com'))).toHaveLength(32)
  })
})
