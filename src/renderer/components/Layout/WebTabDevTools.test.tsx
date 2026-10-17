// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { WebTabOverlay } from './WebTabLayer'
import WebTabDevTools from './WebTabDevTools'
import type { WebviewTag } from 'electron'
import { openActiveWebTabDevTools } from './web-tab-controls'
import { usePaneStore } from '../../stores/pane-store'
import type { BrowserDevToolsEvent } from '@shared/browser-devtools'
import '../../i18n'

vi.mock('../Search/SearchableTab', () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('网页页签内嵌开发者工具', () => {
  it('guest 在布局 effect 前销毁时呈现失败提示', () => {
    const page = { getWebContentsId: () => { throw new Error('destroyed') } } as unknown as WebviewTag
    render(<WebTabDevTools id="destroyed-page" pageRef={{ current: page }} onClose={vi.fn()} />)
    expect(screen.getByRole('alert').textContent).toBe('Could not open DevTools. Close the panel and try again.')
  })

  it('开关只增删承载区，不重挂网页；主进程关闭通知和卸载会清理工具', async () => {
    usePaneStore.setState({ layout: {
      root: { id: 'pane-devtools', type: 'leaf', sessions: [], activeSessionId: null,
        overlays: [{ id: 'web-devtools', kind: 'web', active: true, slot: null }] },
      activePaneId: 'pane-devtools'
    } })
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    let notify!: (event: BrowserDevToolsEvent) => void
    const unsubscribe = vi.fn()
    const request = vi.fn().mockResolvedValue({ success: true, inspectorId: 13 })
    const oldApi = window.electronAPI
    window.electronAPI = { ...oldApi, webTabDevTools: request, onWebTabDevToolsEvent: callback => { notify = callback; return unsubscribe } }
    try {
      render(<WebTabOverlay id="web-devtools" url="https://example.com" />)
      const page = document.querySelector('webview')!
      Object.assign(page, { getWebContentsId: () => 12, closeDevTools: vi.fn() })
      await act(async () => { openActiveWebTabDevTools() })
      expect(request).toHaveBeenCalledWith({ kind: 'open', pageId: 12, bounds: { x: 0, y: 0, width: 0, height: 0 } })
      expect(document.querySelectorAll('webview')).toHaveLength(1)
      expect(document.querySelector('webview')).toBe(page)
      const separator = screen.getByRole('separator')
      fireEvent.keyDown(separator, { key: 'ArrowUp' })
      expect(separator.getAttribute('aria-valuenow')).toBe('47')
      Object.assign(separator, { setPointerCapture: vi.fn() })
      fireEvent(separator, Object.assign(new Event('pointerdown', { bubbles: true }), { button: 0, pointerId: 1 }))
      expect(document.querySelector('[data-webtab-devtools] .absolute.cursor-row-resize')).toBeTruthy()
      fireEvent.pointerUp(window)
      expect(document.querySelector('[data-webtab-devtools] .absolute.cursor-row-resize')).toBeNull()
      act(() => notify({ kind: 'closed', pageId: 999, inspectorId: 13 }))
      act(() => notify({ kind: 'closed', pageId: 12, inspectorId: 99 }))
      expect(screen.getByRole('separator')).toBeTruthy()
      act(() => notify({ kind: 'closed', pageId: 12, inspectorId: 13 }))
      expect(screen.queryByRole('separator')).toBeNull()
      expect(request).toHaveBeenCalledWith({ kind: 'close', pageId: 12, inspectorId: 13 })
      expect(unsubscribe).toHaveBeenCalled()
      await act(async () => { openActiveWebTabDevTools() })
      fireEvent.click(screen.getByRole('button', { name: 'Close DevTools (F12)' }))
      expect(screen.queryByRole('separator')).toBeNull()
      expect(document.querySelector('webview')).toBe(page)
    } finally { cleanup(); window.electronAPI = oldApi }
  })
})
