// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { WebTabOverlay } from './WebTabLayer'
import '../../i18n'

vi.mock('./task-shelf-web-frame', () => ({
  openShelfWebPreview: () => ({ release: vi.fn() }),
  refreshShelfWebPreview: async () => ({ image: 'data:image/png;base64,fixture', width: 800, height: 600 })
}))
vi.mock('../Search/SearchableTab', () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('保存网页首帧输入门槛', () => {
  it('截图成功但原生实例核验失败时保持禁用，用户可显式显示当前页面', async () => {
    vi.useFakeTimers()
    const previous = window.electronAPI
    const request = vi.fn().mockImplementation(async input => input.kind === 'permit'
      ? { success: true, permitId: 'fixture-permit', deepSleepSupported: false }
      : { success: false, error: 'not-found' })
    window.electronAPI = { ...previous, shelfBrowserRequest: request }
    try {
      await act(async () => { render(<WebTabOverlay id="presentation-unconfirmed" url="https://fixture.test/" shelfTaskId="saved-fixture" />) })
      const page = document.querySelector<HTMLElement>('webview')!
      expect(page.hasAttribute('inert')).toBe(true)
      act(() => { page.dispatchEvent(new Event('dom-ready')) })
      await act(async () => { await vi.advanceTimersByTimeAsync(200) })
      expect(page.hasAttribute('inert')).toBe(true)
      expect(page.style.pointerEvents).toBe('none')
      fireEvent.click(screen.getByRole('button', { name: 'Show current page' }))
      expect(page.hasAttribute('inert')).toBe(false)
      expect(request.mock.calls.some(([input]) => input.kind === 'presented')).toBe(false)
    } finally { window.electronAPI = previous }
  })
})
