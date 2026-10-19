// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BROWSER_BOOKMARKS_KEY, loadBrowserBookmarks, normalizeBookmarkUrl, useBrowserBookmarksStore } from './browser-bookmarks-store'

beforeEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  useBrowserBookmarksStore.setState({ bookmarks: [] })
})

describe('浏览器收藏', () => {
  it('独立持久化标题与完整 URL，重载仍可读取，规范化去重', () => {
    const store = useBrowserBookmarksStore.getState()
    expect(store.addBookmark('https://EXAMPLE.com:443/docs?q=1#part', '  文档  ')).toEqual({ success: true })
    store.addBookmark('https://example.com/docs?q=1#part', '重复')
    localStorage.removeItem('lyshell.webTabHistory.v1')
    expect(loadBrowserBookmarks()).toEqual([{ url: 'https://example.com/docs?q=1#part', title: '文档' }])
    expect(useBrowserBookmarksStore.getState().bookmarks).toEqual(loadBrowserBookmarks())
    store.removeBookmark('https://EXAMPLE.com/docs?q=1#part')
    expect(loadBrowserBookmarks()).toEqual([])
  })

  it.each(['lyshell://new-tab', 'javascript:alert(1)', 'file:///secret', 'https://user:password@example.com', 'https://', 'not a url'])('拒绝不可收藏地址 %s', url => {
    expect(normalizeBookmarkUrl(url)).toBeNull()
    expect(useBrowserBookmarksStore.getState().addBookmark(url).success).toBe(false)
    expect(localStorage.getItem(BROWSER_BOOKMARKS_KEY)).toBeNull()
  })

  it('坏档不阻断启动，逐条过滤无效条目并去重', () => {
    localStorage.setItem(BROWSER_BOOKMARKS_KEY, '{')
    expect(loadBrowserBookmarks()).toEqual([])
    localStorage.setItem(BROWSER_BOOKMARKS_KEY, JSON.stringify([null, {}, { url: 4 }, { url: 'javascript:bad' }, { url: 'https://example.com', title: ' ' }, { url: 'https://EXAMPLE.com:443/' }, { url: 'https://other.example/', title: '<b>标题</b>' }]))
    expect(loadBrowserBookmarks()).toEqual([{ url: 'https://example.com/', title: 'example.com' }, { url: 'https://other.example/', title: '<b>标题</b>' }])
  })

  it('存储失败时不报告成功，不丢失原收藏；恢复后可重试', () => {
    const store = useBrowserBookmarksStore.getState()
    store.addBookmark('https://example.com/', '原收藏')
    const before = localStorage.getItem(BROWSER_BOOKMARKS_KEY)
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError') })
    expect(store.addBookmark('https://other.example/')).toEqual({ success: false, error: 'storageFailed' })
    expect(store.removeBookmark('https://example.com/')).toEqual({ success: false, error: 'storageFailed' })
    expect(useBrowserBookmarksStore.getState().bookmarks).toHaveLength(1)
    expect(localStorage.getItem(BROWSER_BOOKMARKS_KEY)).toBe(before)
    write.mockRestore()
    expect(store.removeBookmark('https://example.com/').success).toBe(true)
    expect(loadBrowserBookmarks()).toEqual([])
  })
})
