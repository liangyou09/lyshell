import type { TextSearchOptions } from './dom-search'
import type { searchText } from './text-search'

export const REGEX_SEARCH_TIMEOUT_MS = 500

/** 每次搜索独立 Worker；超时、换查询、隐藏或卸载都终止实际正则执行。 */
export function runBoundedRegex(text: string, query: string, options: TextSearchOptions, signal?: AbortSignal): Promise<ReturnType<typeof searchText>> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Search cancelled')); return }
    if (query.length > 4096 || text.length > 2 * 1024 * 1024) { reject(new Error('Search content limit exceeded')); return }
    const worker = new Worker(new URL('./regex-search.worker.ts', import.meta.url), { type: 'module' })
    let settled = false
    const finish = (error?: Error, result?: ReturnType<typeof searchText>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      worker.terminate()
      if (error) reject(error)
      else resolve(result!)
    }
    const abort = () => finish(new Error('Search cancelled'))
    const timer = setTimeout(() => finish(new Error('Search timeout')), REGEX_SEARCH_TIMEOUT_MS)
    signal?.addEventListener('abort', abort, { once: true })
    worker.onmessage = event => finish(event.data.error ? new Error(event.data.error) : undefined, event.data.result)
    worker.onerror = () => finish(new Error('Search worker failed'))
    try { worker.postMessage({ text, query, options }) } catch (error) { finish(error as Error) }
  })
}
