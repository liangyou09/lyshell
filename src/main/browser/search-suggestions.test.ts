import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from 'electron'
import { browserSearchSuggestions, clearBrowserSearchSuggestions, parseBingSuggestions } from './search-suggestions'

const fetch = vi.fn()
const ses = { fetch } as unknown as Session
beforeEach(() => { clearBrowserSearchSuggestions(); fetch.mockReset() })
afterEach(() => { vi.useRealTimers() })

describe('搜索联想网络边界', () => {
  it('只解析有界纯文本，拒绝坏数据并去重', () => {
    expect(parseBingSuggestions(['query', [' A ', 'A', 1, '', 'bad\nword', 'x'.repeat(201), '<b>plain text</b>']]))
      .toEqual(['A', '<b>plain text</b>'])
    expect(parseBingSuggestions({ items: ['forged'] })).toEqual([])
  })
  it('只请求固定 Bing 地址，省略 Cookie，复用并发请求与短期缓存', async () => {
    fetch.mockResolvedValue(new Response(JSON.stringify(['中文', ['中文输入法', '中文词典']])))
    const [first, second] = await Promise.all([browserSearchSuggestions(ses, '中文', 'bing'), browserSearchSuggestions(ses, '中文', 'bing')])
    expect(first).toEqual(['中文输入法', '中文词典'])
    expect(second).toEqual(first)
    expect(await browserSearchSuggestions(ses, '中文', 'bing')).toEqual(first)
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledWith('https://www.bing.com/osjson.aspx?query=%E4%B8%AD%E6%96%87', expect.objectContaining({ credentials: 'omit', redirect: 'error', signal: expect.any(AbortSignal) }))
  })
  it('地址、账号、其他引擎不发给 Bing；失败与超大响应安静回落', async () => {
    for (const query of ['https://example.com/private', 'user@example.com']) expect(await browserSearchSuggestions(ses, query, 'bing')).toEqual([])
    expect(await browserSearchSuggestions(ses, 'hello', 'google')).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
    fetch.mockRejectedValueOnce(new Error('offline'))
    expect(await browserSearchSuggestions(ses, 'offline', 'bing')).toEqual([])
    fetch.mockResolvedValueOnce(new Response('x'.repeat(65537)))
    expect(await browserSearchSuggestions(ses, 'oversize', 'bing')).toEqual([])
    fetch.mockResolvedValueOnce(new Response('<html>not JSON</html>'))
    expect(await browserSearchSuggestions(ses, 'invalid', 'bing')).toEqual([])
  })
  it('慢请求在 2.5 秒中止，清空缓存后重新请求', async () => {
    vi.useFakeTimers()
    fetch.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')))
    }))
    const request = browserSearchSuggestions(ses, 'slow', 'bing')
    await vi.advanceTimersByTimeAsync(2500)
    expect(await request).toEqual([])
    fetch.mockResolvedValue(new Response('["slow",["slow query"]]'))
    await browserSearchSuggestions(ses, 'slow', 'bing')
    clearBrowserSearchSuggestions()
    await browserSearchSuggestions(ses, 'slow', 'bing')
    expect(fetch).toHaveBeenCalledTimes(3)
  })
})
