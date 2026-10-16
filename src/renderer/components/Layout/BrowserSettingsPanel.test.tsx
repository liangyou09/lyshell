// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BROWSER_SETTINGS, type BrowserRequest } from '@shared/browser-settings'
import { useBrowserSettingsStore } from '../../stores/browser-settings-store'
import BrowserSettingsPanel from './BrowserSettingsPanel'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const api = vi.fn()
beforeEach(() => {
  useBrowserSettingsStore.setState({ settings: structuredClone(DEFAULT_BROWSER_SETTINGS), loaded: true, error: null, encryptionAvailable: true })
  api.mockReset().mockImplementation(async (r: BrowserRequest) => ({ success: true, settings: r.kind === 'save' ? r.settings : structuredClone(DEFAULT_BROWSER_SETTINGS), passwords: [], encryptionAvailable: true }))
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { browserRequest: api } })
})
afterEach(cleanup)

describe('浏览器设置交互', () => {
  it('修改配置只有保存才提交，失败后保留草稿供重试', async () => {
    const view = render(<BrowserSettingsPanel />)
    await waitFor(() => expect(api).toHaveBeenCalledWith({ kind: 'get' }))
    await act(async () => {})
    fireEvent.change(view.getByLabelText('browser.homePage'), { target: { value: 'https://home.example.com' } })
    expect(api.mock.calls.some(([r]) => r.kind === 'save')).toBe(false)
    api.mockResolvedValueOnce({ success: false, error: 'browserOperationFailed' })
    fireEvent.submit(view.container.querySelector('form')!)
    await waitFor(() => expect(view.getByRole('alert').textContent).toContain('browser.browserOperationFailed'))
    expect((view.getByLabelText('browser.homePage') as HTMLInputElement).value).toBe('https://home.example.com')
    expect(useBrowserSettingsStore.getState().settings.homePage).toBe('')
    fireEvent.submit(view.container.querySelector('form')!)
    await waitFor(() => expect(useBrowserSettingsStore.getState().settings.homePage).toBe('https://home.example.com'))
  })
  it('清理登录数据前需要确认，缓存清理独立', async () => {
    const view = render(<BrowserSettingsPanel />)
    await act(async () => {})
    fireEvent.click(view.getByText('browser.clearSiteData'))
    expect(api.mock.calls.some(([r]) => r.kind === 'clear')).toBe(false)
    fireEvent.click(view.getByText('browser.cancel'))
    expect(api.mock.calls.some(([r]) => r.kind === 'clear')).toBe(false)
    fireEvent.click(view.getByText('browser.clearSiteData'))
    fireEvent.click(view.getByText('browser.confirmClear'))
    await waitFor(() => expect(api).toHaveBeenCalledWith({ kind: 'clear', target: 'siteData' }))
    await act(async () => {})
    fireEvent.click(view.getByText('browser.clearCache'))
    await waitFor(() => expect(api).toHaveBeenCalledWith({ kind: 'clear', target: 'cache' }))
  })
  it('密码列表不暴露秘密，新增后清空密码输入', async () => {
    api.mockImplementation(async (r: BrowserRequest) => r.kind === 'passwords' ? { success: true, passwords: [{ id: 'p1', origin: 'https://example.com', username: 'alice', updatedAt: 1 }] } : { success: true, settings: DEFAULT_BROWSER_SETTINGS, encryptionAvailable: true, passwords: [] })
    const view = render(<BrowserSettingsPanel />)
    await waitFor(() => expect(view.getByText('alice')).toBeTruthy())
    expect(api.mock.calls.some(([r]) => r.kind === 'savePassword')).toBe(false)
    fireEvent.click(view.getByText('browser.addPassword'))
    fireEvent.change(view.getByLabelText('browser.website'), { target: { value: 'https://example.com' } })
    fireEvent.change(view.getByLabelText('browser.username'), { target: { value: 'bob' } })
    fireEvent.change(view.getByLabelText('browser.password'), { target: { value: 'secret-123' } })
    expect((view.getByLabelText('browser.password') as HTMLInputElement).type).toBe('password')
    fireEvent.click(view.getByText('browser.savePassword'))
    await waitFor(() => expect(api).toHaveBeenCalledWith({ kind: 'savePassword', origin: 'https://example.com', username: 'bob', password: 'secret-123' }))
    await waitFor(() => expect(view.queryByLabelText('browser.password')).toBeNull())
    fireEvent.click(view.getByText('browser.addPassword'))
    expect((view.getByLabelText('browser.password') as HTMLInputElement).value).toBe('')
  })
})
