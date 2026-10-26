import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gateWebTabPopup, recordWebTabPopup, resetWebTabPopupGateForTest } from './web-tab-popup-gate'

describe('网页弹窗短窗频控', () => {
  let nowMs: number
  beforeEach(() => {
    resetWebTabPopupGateForTest()
    nowMs = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs)
  })
  afterEach(() => { vi.restoreAllMocks() })

  const admit = (url: string): boolean => {
    if (!gateWebTabPopup(url)) return false
    recordWebTabPopup()
    return true
  }

  it('挂载失败不登记，不消耗频控额度', () => {
    for (let i = 0; i < 5; i++) expect(gateWebTabPopup('https://example.com/')).toBe(true)
    for (let i = 0; i < 3; i++) expect(admit('https://example.com/')).toBe(true)
    expect(admit('https://example.com/')).toBe(false)
  })

  it('相同链接可反复打开，不会因已有页签永久拦截', () => {
    for (let i = 0; i < 10; i++) {
      expect(admit('https://www.bing.com/ck/a?u=a1same')).toBe(true)
      nowMs += 2000
    }
  })

  it.each([false, true])('5 秒内仍限制突发请求，改变查询参数=%s', varyQuery => {
    const url = (n: number) => `https://example.com/?id=${varyQuery ? n : 1}`
    expect(admit(url(1))).toBe(true)
    nowMs += 100
    expect(admit(url(2))).toBe(true)
    nowMs += 100
    expect(admit(url(3))).toBe(true)
    nowMs += 100
    expect(admit(url(4))).toBe(false)
    nowMs += 4700
    expect(admit(url(5))).toBe(true)
  })
})
