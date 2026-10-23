// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { buildBrowserMenu, type BrowserMenuContext } from '@shared/browser-context-menu'
import BrowserContextMenu from './BrowserContextMenu'
afterEach(cleanup)
const context: BrowserMenuContext = {
  locale: 'zh', theme: 'light', pageUrl: 'https://github.com', canGoBack: false, canGoForward: false,
  linkUrl: 'https://github.com/docs', linkText: 'GitHub 文档', srcUrl: '', mediaType: 'none', hasImageContents: false,
  isEditable: false, isPassword: false, selectionText: '', canSearch: true,
  editFlags: { canUndo: false, canRedo: false, canCopy: false, canCut: false, canPaste: false, canSelectAll: false }
}
describe('浏览器主题菜单', () => {
  it('菜单根节点聚焦时向上从最后一个可用项开始', () => {
    const request = vi.fn().mockResolvedValue(true)
    render(<BrowserContextMenu data={buildBrowserMenu(context)} onRequest={request} />)
    const root = screen.getByRole('menu')
    expect(document.activeElement).toBe(root)
    fireEvent.keyDown(root, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: /检查元素/ }))
    fireEvent.keyDown(root, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '刷新' }))
  })
  it('F12与F5能执行标示的操作，禁用的后退快捷键无效', () => {
    const request = vi.fn().mockResolvedValue(true)
    const first = render(<BrowserContextMenu data={buildBrowserMenu(context)} onRequest={request} />)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowLeft', altKey: true })
    expect(request).not.toHaveBeenCalledWith({ kind: 'action', id: 'back' })
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'F12' })
    expect(request).toHaveBeenCalledWith({ kind: 'action', id: 'inspect' })
    first.unmount(); request.mockClear()
    render(<BrowserContextMenu data={buildBrowserMenu(context)} onRequest={request} />)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'F5' })
    expect(request).toHaveBeenCalledWith({ kind: 'action', id: 'reload' })
  })
  it('常驻导航与上下文分组，点击只发送动作ID', () => {
    const request = vi.fn().mockResolvedValue(true)
    render(<BrowserContextMenu data={buildBrowserMenu(context)} onRequest={request} />)
    expect(screen.getByRole('group', { name: '页面导航' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '后退' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('menuitem', { name: '复制链接文字' }))
    expect(request).toHaveBeenCalledWith({ kind: 'action', id: 'copy-link-text' })
    expect(screen.getByText('github.com/docs')).toBeTruthy()
  })
  it('方向键跳过禁用项，Escape收起，Tab不会把焦点留在独立窗口', () => {
    const request = vi.fn().mockResolvedValue(true)
    const { unmount } = render(<BrowserContextMenu data={buildBrowserMenu(context)} onRequest={request} />)
    const root = screen.getByRole('menu')
    fireEvent.keyDown(root, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '刷新' }))
    fireEvent.keyDown(root, { key: 'End' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: /检查元素/ }))
    fireEvent.keyDown(root, { key: 'Escape' })
    expect(request).toHaveBeenCalledWith({ kind: 'dismiss' })
    unmount(); request.mockClear()
    render(<BrowserContextMenu data={buildBrowserMenu(context)} onRequest={request} />)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Tab' })
    expect(request).toHaveBeenCalledWith({ kind: 'dismiss' })
  })
})
