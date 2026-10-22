import { afterEach, expect, it, vi } from 'vitest'
import { runBoundedRegex, REGEX_SEARCH_TIMEOUT_MS } from './regex-search-client'

const options = { regex: true, caseSensitive: true, wholeWord: false }
class MockWorker {
  static instances: MockWorker[] = []
  onmessage?: (event: { data: unknown }) => void
  onerror?: () => void
  terminate = vi.fn()
  postMessage = vi.fn()
  constructor() { MockWorker.instances.push(this) }
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); MockWorker.instances = [] })

it('实际执行线程在预算用尽时被终止，Promise 明确失败', async () => {
  vi.useFakeTimers(); vi.stubGlobal('Worker', MockWorker)
  const pending = expect(runBoundedRegex('a'.repeat(35) + '!', '(a+)+$', options)).rejects.toThrow('timeout')
  await vi.advanceTimersByTimeAsync(REGEX_SEARCH_TIMEOUT_MS)
  await pending
  expect(MockWorker.instances[0].terminate).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('取消会终止 Worker；预取消不会创建线程', async () => {
  vi.stubGlobal('Worker', MockWorker)
  await expect(runBoundedRegex('text', '.', options, AbortSignal.abort())).rejects.toThrow('cancelled')
  expect(MockWorker.instances).toHaveLength(0)
  const controller = new AbortController()
  const pending = runBoundedRegex('text', '.', options, controller.signal)
  controller.abort()
  await expect(pending).rejects.toThrow('cancelled')
  expect(MockWorker.instances[0].terminate).toHaveBeenCalledOnce()
})

it('完成后释放 Worker，返回匹配位置', async () => {
  vi.stubGlobal('Worker', MockWorker)
  const pending = runBoundedRegex('text', '.', options)
  MockWorker.instances[0].onmessage!({ data: { result: { matches: [[0, 1]], truncated: false } } })
  expect(await pending).toEqual({ matches: [[0, 1]], truncated: false })
  expect(MockWorker.instances[0].terminate).toHaveBeenCalledOnce()
})
