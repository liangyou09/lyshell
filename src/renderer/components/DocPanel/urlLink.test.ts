// @vitest-environment jsdom
/**
 * matchHttpUrls 单测 —— 纯函数直调（与 docLink.test.ts 同型）。
 * 覆盖：句读剥离（ASCII/全角/括号平衡）、CJK 终止、与文档路径识别的
 * 无重叠约定、有效性闸门（与 normalizeWebBarUrl 同口径）。
 */
import { describe, expect, it } from 'vitest'
import { matchHttpUrls } from './urlLink'

const urlsOf = (text: string): string[] => matchHttpUrls(text).map(m => m.url)

describe('matchHttpUrls：URL 识别', () => {
  it('基础 http/https', () => {
    expect(urlsOf('访问 https://example.com 查看详情')).toEqual(['https://example.com'])
    expect(urlsOf('http://127.0.0.1:3080/ 已就绪')).toEqual(['http://127.0.0.1:3080/'])
  })

  it('整条 URL 归这里（含 .md 路径不被文档路径识别截走）', () => {
    expect(urlsOf('https://example.com/docs/README.md')).toEqual(['https://example.com/docs/README.md'])
  })

  it('尾部句读剥离：ASCII 与全角', () => {
    expect(urlsOf('see https://example.com.')).toEqual(['https://example.com'])
    expect(urlsOf('see https://example.com, next')).toEqual(['https://example.com'])
    expect(urlsOf('（https://example.com）。')).toEqual(['https://example.com'])
    expect(urlsOf('https://example.com，然后')).toEqual(['https://example.com'])
  })

  it('右括号：无对应左括号剥掉，成对保留（维基词条路径）', () => {
    expect(urlsOf('(https://example.com)')).toEqual(['https://example.com'])
    expect(urlsOf('https://en.wikipedia.org/wiki/Stack_(software)')).toEqual(['https://en.wikipedia.org/wiki/Stack_(software)'])
  })

  it('多 URL 同行按出现序', () => {
    expect(urlsOf('https://a.com 和 https://b.com')).toEqual(['https://a.com', 'https://b.com'])
  })

  it('大写 scheme 认（URL 解析协议不区分大小写，原文保留）', () => {
    expect(urlsOf('HTTPS://EXAMPLE.COM')).toEqual(['HTTPS://EXAMPLE.COM'])
  })

  it('非 http(s) 协议 / 无 hostname 不成链（与网页访问栏同口径）', () => {
    expect(urlsOf('ftp://example.com')).toEqual([])
    expect(urlsOf('file:///C:/Windows')).toEqual([])
    expect(urlsOf('javascript:alert(1)')).toEqual([])
    expect(urlsOf('https://')).toEqual([])
    expect(urlsOf('https://.')).toEqual([]) // 剥掉句读后无 hostname
  })

  it('CJK 终止 URL 主体（已知取舍：raw CJK 路径截断）', () => {
    expect(urlsOf('https://a.com/文件.html 详情')).toEqual(['https://a.com/'])
  })

  it('区间坐标与文本一致（尾部句读不入区间）', () => {
    const text = 'docs: https://example.com/a.md.'
    const [m] = matchHttpUrls(text)
    expect(text.slice(m.start, m.end)).toBe('https://example.com/a.md')
    expect(m.url).toBe('https://example.com/a.md')
  })

  it('无 URL 行返回空数组', () => {
    expect(matchHttpUrls('no urls here, just README.md talk')).toEqual([])
  })
})
