import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PostBody, Referrer } from 'electron'
import { PendingWebbarPostStore, webbarPostLoadOptions, webbarPostRawBytesWithinLimit } from './webbar-post'

const referrer: Referrer = { url: 'https://example.com/form', policy: 'strict-origin-when-cross-origin' }

describe('webbarPostLoadOptions', () => {
  it('保留 urlencoded 表单正文和来源', () => {
    const data: PostBody['data'] = [{ type: 'rawData', bytes: Buffer.from('name=%E5%BC%A0%E4%B8%89') }]
    expect(webbarPostLoadOptions({ contentType: 'application/x-www-form-urlencoded', data }, referrer)).toEqual({
      postData: data,
      extraHeaders: 'Content-Type: application/x-www-form-urlencoded\n',
      httpReferrer: referrer
    })
  })

  it('保留 multipart 边界及文件段', () => {
    const data: PostBody['data'] = [
      { type: 'rawData', bytes: Buffer.from('--boundary\r\n') },
      { type: 'file', filePath: 'C:\\tmp\\upload.txt' }
    ]
    expect(webbarPostLoadOptions({ contentType: 'multipart/form-data', boundary: 'boundary', data }, referrer)).toEqual({
      postData: data,
      extraHeaders: 'Content-Type: multipart/form-data; boundary=boundary\n',
      httpReferrer: referrer
    })
  })

  it('只累计原始字节，文件段交给网络栈按路径读取', () => {
    const body: PostBody = {
      contentType: 'multipart/form-data',
      data: [
        { type: 'rawData', bytes: Buffer.from('1234') },
        { type: 'file', filePath: 'C:\\tmp\\large.bin' }
      ]
    }
    expect(webbarPostRawBytesWithinLimit(body, 4)).toBe(true)
    expect(webbarPostRawBytesWithinLimit(body, 3)).toBe(false)
  })
})

describe('PendingWebbarPostStore', () => {
  const request = {
    url: 'https://example.com/submit',
    body: { contentType: 'application/x-www-form-urlencoded', data: [{ type: 'rawData' as const, bytes: Buffer.from('a=1') }] },
    referrer
  }

  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('未认领的正文到期主动释放，不等下一次弹窗', () => {
    const store = new PendingWebbarPostStore(1, 30_000)
    expect(store.enqueue('first', request)).toBe(true)
    expect(store.enqueue('second', request)).toBe(false)
    vi.advanceTimersByTime(30_000)
    expect(store.take('first')).toBeNull()
    expect(store.enqueue('second', request)).toBe(true)
  })

  it('认领即清除定时器，令牌与正文不可二次取用', () => {
    const store = new PendingWebbarPostStore(1, 30_000)
    expect(store.enqueue('first', request)).toBe(true)
    expect(vi.getTimerCount()).toBe(1)
    expect(store.take('first')).toBe(request)
    expect(store.take('first')).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('定时器执行延迟时也按截止时间拒绝旧令牌', () => {
    const store = new PendingWebbarPostStore(1, 30_000)
    expect(store.enqueue('first', request)).toBe(true)
    vi.setSystemTime(Date.now() + 30_001)
    expect(store.take('first')).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })
})
