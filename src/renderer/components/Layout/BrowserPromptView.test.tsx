// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { BrowserPromptData } from '@shared/browser-prompt'
import BrowserPromptView from './BrowserPromptView'
import '../../i18n'
afterEach(cleanup)
const password: BrowserPromptData = { locale: 'en', theme: 'light', content: { kind: 'password', origin: 'https://example.com', username: 'alice' } }
describe('友好的密码确认', () => {
  it('默认聚焦暂不保存，只显示网站、用户名和本机加密说明', () => {
    const action = vi.fn().mockResolvedValue({ success: true })
    render(<BrowserPromptView data={password} onAction={action} />)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Not now' }))
    expect(screen.getByText('alice')).toBeTruthy(); expect(screen.getByText('https://example.com')).toBeTruthy()
    expect(screen.getByText(/Stored only on this device/)).toBeTruthy()
    expect(document.querySelector('input[type=password]')).toBeNull()
  })
  it('保存失败留在窗口中重试', async () => {
    const action = vi.fn().mockImplementation(async a => a.kind === 'confirm' ? { success: false, error: 'saveFailed' } : { success: true })
    render(<BrowserPromptView data={password} onAction={action} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save password' })) })
    expect(screen.getByRole('alert').textContent).toContain('not been saved')
    expect(screen.getByRole('button', { name: 'Retry saving' })).toBeTruthy()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
  it('Esc 取消；传输失败不能继续确认', async () => {
    const action = vi.fn().mockResolvedValue({ success: true })
    render(<BrowserPromptView data={password} onAction={action} />)
    fireEvent.keyDown(window, { key: 'Escape' }); expect(action).toHaveBeenCalledWith({ kind: 'cancel' })
    action.mockRejectedValueOnce(new Error('transport'))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save password' })) })
    expect((screen.getByRole('button', { name: 'Save password' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('alert')).toBeTruthy()
  })
})
