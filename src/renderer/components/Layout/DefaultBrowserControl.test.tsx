// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DefaultBrowserControl from './DefaultBrowserControl'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const api = vi.fn()
const available = { supported: true, registered: true, isDefault: false, canRegister: true }
beforeEach(() => {
  api.mockReset().mockResolvedValue({ success: true, defaultBrowserStatus: available })
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { browserRequest: api } })
})
afterEach(cleanup)

describe('默认浏览器设置', () => {
  it('显式点击才打开系统设置，不把打开设置当作已经成为默认', async () => {
    const view = render(<DefaultBrowserControl />)
    await waitFor(() => expect(view.getByText('browser.defaultBrowserInactive')).toBeTruthy())
    expect(api).toHaveBeenCalledTimes(1)
    fireEvent.click(view.getByRole('button', { name: 'browser.defaultBrowserSet' }))
    await waitFor(() => expect(view.getByText('browser.defaultBrowserOpened')).toBeTruthy())
    expect(api).toHaveBeenCalledWith({ kind: 'requestDefaultBrowser' })
    expect(view.queryByText('browser.defaultBrowserActive')).toBeNull()
    api.mockResolvedValue({ success: true, defaultBrowserStatus: { ...available, isDefault: true } })
    fireEvent.focus(window)
    await waitFor(() => expect(view.getByText('browser.defaultBrowserActive')).toBeTruthy())
    expect(view.queryByText('browser.defaultBrowserOpened')).toBeNull()
    expect(view.getByRole('button', { name: 'browser.defaultBrowserManage' })).toBeTruthy()
  })
  it.each([
    [{ ...available, supported: false, canRegister: false }, 'browser.defaultBrowserUnsupported'],
    [{ ...available, canRegister: false }, 'browser.defaultBrowserDevelopment']
  ])('不支持的运行环境说明原因且不提供注册按钮', async (status, label) => {
    api.mockResolvedValue({ success: true, defaultBrowserStatus: status })
    const view = render(<DefaultBrowserControl />)
    await waitFor(() => expect(view.getByText(label)).toBeTruthy())
    expect(view.queryByRole('button')).toBeNull()
  })
  it('注册失败清除过期状态，并允许重新检查', async () => {
    const view = render(<DefaultBrowserControl />)
    await waitFor(() => expect(view.getByRole('button')).toBeTruthy())
    api.mockResolvedValueOnce({ success: false, error: 'defaultBrowserFailed' })
    fireEvent.click(view.getByRole('button'))
    await waitFor(() => expect(view.getByRole('alert').textContent).toContain('browser.defaultBrowserFailed'))
    fireEvent.click(view.getByRole('button', { name: 'browser.defaultBrowserRetry' }))
    await waitFor(() => expect(view.queryByRole('alert')).toBeNull())
    expect(view.getByText('browser.defaultBrowserInactive')).toBeTruthy()
  })
  it('请求中禁用按钮，避免重复注册', async () => {
    const view = render(<DefaultBrowserControl />)
    await waitFor(() => expect(view.getByRole('button')).toBeTruthy())
    let resolve!: (value: unknown) => void
    api.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    fireEvent.click(view.getByRole('button'))
    fireEvent.click(view.getByRole('button'))
    expect((view.getByRole('button') as HTMLButtonElement).disabled).toBe(true)
    expect(api.mock.calls.filter(([request]) => request.kind === 'requestDefaultBrowser')).toHaveLength(1)
    await act(async () => resolve({ success: true, defaultBrowserStatus: available }))
  })
})
