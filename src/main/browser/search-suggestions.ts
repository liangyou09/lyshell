import type { Session } from 'electron'
import { browserSearchQuery, type SearchEngine } from '@shared/browser-settings'

const cache = new Map<string, { at: number; items: string[] }>()
const pending = new Map<string, Promise<string[]>>()
const CACHE_TTL = 5 * 60_000
const MAX_BYTES = 64 * 1024
let generation = 0

export function clearBrowserSearchSuggestions(): void { generation++; cache.clear() }

/** Bing 的 OpenSearch JSON；拒绝畸形响应，只收有界的纯文字候选。 */
export function parseBingSuggestions(raw: unknown): string[] {
  if (!Array.isArray(raw) || !Array.isArray(raw[1])) return []
  const items = raw[1].filter((item): item is string => typeof item === 'string'
    && !!item.trim() && item.length <= 200 && !/[\p{Cc}\p{Cf}]/u.test(item)).map(item => item.trim())
  return [...new Set(items)].slice(0, 6)
}

/** 复用浏览器代理，省略登录 Cookie；短超时和内存缓存不阻塞实际搜索。 */
export async function browserSearchSuggestions(ses: Session, raw: string, engine: SearchEngine): Promise<string[]> {
  const query = browserSearchQuery(raw, engine)
  if (engine !== 'bing' || !query) return []
  const cached = cache.get(query)
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.items
  const running = pending.get(query)
  if (running) return running
  if (pending.size >= 4) return []
  const startedGeneration = generation
  const task = (async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2500)
    try {
      const response = await ses.fetch(`https://www.bing.com/osjson.aspx?query=${encodeURIComponent(query)}`, {
        credentials: 'omit', redirect: 'error', signal: controller.signal
      })
      if (!response.ok || !response.body) return []
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        let next = await reader.read()
        while (!next.done) {
          const value = next.value
          size += value.byteLength
          if (size > MAX_BYTES) { controller.abort(); return [] }
          chunks.push(value)
          next = await reader.read()
        }
      } finally { reader.releaseLock() }
      const items = parseBingSuggestions(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      if (generation === startedGeneration) {
        if (cache.size >= 64) cache.delete(cache.keys().next().value!)
        cache.set(query, { at: Date.now(), items })
      }
      return items
    } catch { return [] }
    finally { clearTimeout(timer) }
  })()
  pending.set(query, task)
  try { return await task }
  finally { pending.delete(query) }
}
