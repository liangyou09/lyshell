import { describe, expect, it } from 'vitest'
import { browserAddress, browserOrigin, browserSearchQuery } from './browser-settings'

describe('浏览器地址栏', () => {
  it('只为普通搜索词请求联想，不发送网址、路径、账号或控制字符', () => {
    expect(browserSearchQuery('  中文搜索  ', 'bing')).toBe('中文搜索')
    for (const value of ['https://example.com/?token=secret', 'example.com', 'localhost:3000', 'user@example.com', 'D:\\work', '/etc/passwd', '../project', 'line\nbreak', 'x', 'x'.repeat(201)]) {
      expect(browserSearchQuery(value, 'bing')).toBeNull()
    }
    expect(browserSearchQuery('中文搜索', 'none')).toBeNull()
  })
  it.each([
    ['example.com/path', 'https://example.com/path'],
    ['localhost:3000/login', 'https://localhost:3000/login'],
    ['http://127.0.0.1:8080', 'http://127.0.0.1:8080/'],
    ['[::1]:3000', 'https://[::1]:3000/']
  ])('网址 %s 不走搜索', (raw, expected) => expect(browserAddress(raw, 'bing')).toBe(expected))
  it('搜索词经过编码，并尊重引擎', () => {
    expect(browserAddress('终端 设置 & proxy', 'bing')).toBe('https://www.bing.com/search?q=' + encodeURIComponent('终端 设置 & proxy'))
    expect(browserAddress('test query', 'duckduckgo')).toBe('https://duckduckgo.com/?q=test%20query')
    expect(browserAddress('test query', 'none')).toBeNull()
  })
  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'https://user:secret@example.com', 'http://', ''])('危险或无效地址不被搜索掩盖：%s', raw => expect(browserAddress(raw, 'bing')).toBeNull())
  it('密码来源按完整 origin 隔离协议及端口', () => {
    expect(browserOrigin('https://EXAMPLE.com/a?q=x')).toBe('https://example.com')
    expect(browserOrigin('http://example.com:8080')).toBe('http://example.com:8080')
    expect(browserOrigin('file:///a')).toBeNull()
    expect(browserOrigin('https://user:password@example.com')).toBeNull()
  })
})
