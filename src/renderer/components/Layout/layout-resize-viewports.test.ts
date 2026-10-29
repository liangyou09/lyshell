// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { retainWebviewViewports } from './layout-resize-viewports'

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks() })
describe('调宽期间保留网页视口', () => {
  it('批量读取后冻结实际尺寸，释放恢复原样式且不重建页面', () => {
    const root = document.createElement('div')
    root.innerHTML = '<webview src="https://example.org/"></webview><webview style="width:100% !important;height:80%"></webview>'
    document.body.append(root)
    const views = [...root.querySelectorAll<HTMLElement>('webview')]
    const reads: string[] = []
    views.forEach((view, index) => vi.spyOn(view, 'getBoundingClientRect').mockImplementation(() => {
      reads.push(views[0].style.width)
      return { width: 600 + index, height: 400 + index } as DOMRect
    }))
    const release = retainWebviewViewports(root)
    expect(reads).toEqual(['', ''])
    expect(views.map(view => [view.style.width, view.style.height])).toEqual([['600px', '400px'], ['601px', '401px']])
    release(); release()
    expect(root.querySelectorAll('webview')[0]).toBe(views[0])
    expect(views[0].getAttribute('src')).toBe('https://example.org/')
    expect(views[0].style.width).toBe('')
    expect(views[1].style.width).toBe('100%')
    expect(views[1].style.getPropertyPriority('width')).toBe('important')
    expect(views[1].style.height).toBe('80%')
  })
  it('不改动隐藏或尺寸为零的网页，卸载的节点也可安全释放', () => {
    const root = document.createElement('div'), view = document.createElement('webview')
    root.append(view)
    const release = retainWebviewViewports(root)
    expect(view.style.width).toBe('')
    view.remove(); expect(release).not.toThrow()
  })
})
