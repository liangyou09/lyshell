import { create } from 'zustand'

export interface BrowserBookmark { url: string; title: string }
export const BROWSER_BOOKMARKS_KEY = 'lyshell.browser.bookmarks.v1'
type BookmarkResult = { success: true } | { success: false; error: 'invalid' | 'storageFailed' }

/** 只收藏实际网页地址，拒绝内部页和含登录凭据的 URL。 */
export function normalizeBookmarkUrl(raw: string): string | null {
  try {
    if (raw.length > 8192) return null
    const url = new URL(raw)
    return /^https?:$/.test(url.protocol) && url.hostname && !url.username && !url.password ? url.href : null
  } catch { return null }
}

export function loadBrowserBookmarks(): BrowserBookmark[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(BROWSER_BOOKMARKS_KEY) ?? '[]')
    if (!Array.isArray(raw)) return []
    const seen = new Set<string>()
    return raw.flatMap((item: unknown) => {
      if (!item || typeof item !== 'object' || !('url' in item) || typeof item.url !== 'string') return []
      const url = normalizeBookmarkUrl(item.url)
      if (!url || seen.has(url)) return []
      seen.add(url)
      const title = 'title' in item && typeof item.title === 'string' ? item.title.trim().slice(0, 240) : ''
      return [{ url, title: title || new URL(url).hostname }]
    })
  } catch { return [] }
}

interface BrowserBookmarksStore {
  bookmarks: BrowserBookmark[]
  addBookmark: (url: string, title?: string) => BookmarkResult
  removeBookmark: (url: string) => BookmarkResult
}

export const useBrowserBookmarksStore = create<BrowserBookmarksStore>((set, get) => {
  // 写盘成功后才更新界面，避免磁盘已满时显示「已收藏」。收藏与历史独立存储。
  const save = (bookmarks: BrowserBookmark[]): BookmarkResult => {
    try { localStorage.setItem(BROWSER_BOOKMARKS_KEY, JSON.stringify(bookmarks)) }
    catch { return { success: false, error: 'storageFailed' } }
    set({ bookmarks })
    return { success: true }
  }
  return {
    bookmarks: loadBrowserBookmarks(),
    addBookmark: (raw, title) => {
      const url = normalizeBookmarkUrl(raw)
      if (!url) return { success: false, error: 'invalid' }
      if (get().bookmarks.some(item => item.url === url)) return { success: true }
      return save([{ url, title: title?.trim().slice(0, 240) || new URL(url).hostname }, ...get().bookmarks])
    },
    removeBookmark: raw => {
      const url = normalizeBookmarkUrl(raw)
      if (!url) return { success: false, error: 'invalid' }
      return save(get().bookmarks.filter(item => item.url !== url))
    }
  }
})
