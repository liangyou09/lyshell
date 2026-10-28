// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WebviewTag } from 'electron'
import TaskShelfBrowserBar from './TaskShelfBrowserBar'
import { registerWebview, unregisterWebview } from './web-tab-controls'
import { usePaneStore } from '../../stores/pane-store'
import '../../i18n'

const page = { canGoBack: vi.fn(() => true), canGoForward: vi.fn(() => false), goBack: vi.fn(), goForward: vi.fn(), reload: vi.fn(), stop: vi.fn(), loadURL: vi.fn(async () => {}) }
beforeEach(() => {
  vi.clearAllMocks()
  usePaneStore.setState({ overlayPayloads: { web: { kind: 'web', title: 'Reference', url: 'https://page.test/', nav: { url: 'https://page.test/next', canGoBack: true, canGoForward: false, loading: false } } } })
  registerWebview('web', page as unknown as WebviewTag)
})
afterEach(() => { cleanup(); unregisterWebview('web') })

it('小浏览器导航使用原 guest，地址按已有协议规则校验', async () => {
  const view = render(<TaskShelfBrowserBar id="web" interactive />)
  fireEvent.click(view.getByRole('button', { name: 'Back' }))
  expect(page.goBack).toHaveBeenCalledOnce()
  expect((view.getByRole('button', { name: 'Forward' }) as HTMLButtonElement).disabled).toBe(true)
  const address = view.getByRole('textbox', { name: 'Page address' })
  fireEvent.change(address, { target: { value: 'example.org/docs' } })
  await act(async () => { fireEvent.submit(address.closest('form')!) })
  expect(page.loadURL).toHaveBeenCalledWith('https://example.org/docs')
  fireEvent.change(address, { target: { value: 'javascript:alert(1)' } })
  fireEvent.submit(address.closest('form')!)
  expect(page.loadURL).toHaveBeenCalledTimes(1)
  expect(address.getAttribute('aria-invalid')).toBe('true')
})

it('窄栏只读，放大后可刷新，加载时同一按钮停止原页面', () => {
  const view = render(<TaskShelfBrowserBar id="web" interactive={false} />)
  const reload = view.getByRole('button', { name: 'Reload or stop' })
  fireEvent.click(reload); expect(page.reload).not.toHaveBeenCalled()
  expect((view.getByRole('textbox') as HTMLInputElement).readOnly).toBe(true)
  view.rerender(<TaskShelfBrowserBar id="web" interactive />)
  fireEvent.click(reload); expect(page.reload).toHaveBeenCalledOnce()
  act(() => usePaneStore.setState({ overlayPayloads: { web: { kind: 'web', title: 'Reference', url: 'https://page.test/', nav: { url: 'https://page.test/', canGoBack: false, canGoForward: false, loading: true } } } }))
  fireEvent.click(reload); expect(page.stop).toHaveBeenCalledOnce()
})
