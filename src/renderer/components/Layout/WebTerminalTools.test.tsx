// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import WebTerminalTools from './WebTerminalTools'
import { webTerminalLines } from './web-terminal-script'
import { stageWebTerminalCommand } from './web-terminal-command'
import type { WebviewTag } from 'electron'
import '../../i18n'

vi.mock('./web-tab-controls', () => ({ activeWebTabId: () => 'web-test' }))
const request = vi.fn()
const originalApi = window.electronAPI
beforeEach(() => {
  request.mockReset().mockImplementation(async value => value.kind === 'bind'
    ? { success: true, bindingId: 'd4a84d64-a07c-4c8d-a5cb-96dd35abae7f' } : { success: true })
  window.electronAPI = { ...originalApi, webTerminal: request }
})
afterEach(() => { cleanup(); window.electronAPI = originalApi; vi.useRealTimers() })

function mount(): HTMLElement {
  const page = document.createElement('div')
  Object.assign(page, { getWebContentsId: () => 71 })
  render(<WebTerminalTools id="web-test" pageRef={{ current: page as unknown as WebviewTag }} />)
  fireEvent.click(screen.getByRole('button', { name: 'Web terminal' }))
  return page
}
async function bind(): Promise<void> {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Bind selected terminal' })) })
}

describe('网页终端工具', () => {
  it('快捷命令只载入草稿，普通网页不隐式执行', () => {
    mount()
    act(() => { stageWebTerminalCommand({ id: 'q', name: 'Inspect', content: 'echo ok', order: 1 }) })
    expect((screen.getByRole('textbox', { name: 'Command or script' }) as HTMLTextAreaElement).value).toBe('echo ok')
    expect(request).not.toHaveBeenCalled()
    expect((screen.getByRole('button', { name: 'Run lines' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('导航取消绑定，保留草稿，不因网络恢复或再次渲染重发', async () => {
    const page = mount()
    await bind()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'echo draft' } })
    act(() => { page.dispatchEvent(new Event('did-start-navigation')) })
    expect((screen.getByRole('button', { name: 'Run lines' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('echo draft')
    act(() => { window.dispatchEvent(new Event('online')) })
    expect(request.mock.calls.filter(([value]) => value.kind === 'send')).toHaveLength(0)
  })
  it('停止只阻止后续行；输入失败后不自动重试', async () => {
    mount()
    await bind()
    vi.useFakeTimers()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'first\n  second\nthird' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Run lines' })) })
    expect(request.mock.calls.filter(([value]) => value.kind === 'send').map(([value]) => value.text)).toEqual(['first'])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stop further input' })); await vi.runAllTimersAsync() })
    expect(request.mock.calls.filter(([value]) => value.kind === 'send')).toHaveLength(1)
    expect(screen.getByRole('status').textContent).toContain('1 / 3')
    request.mockImplementation(async value => value.kind === 'send' ? { success: false, error: 'uncertain' } : { success: true })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Run lines' })); await vi.runAllTimersAsync() })
    expect(request.mock.calls.filter(([value]) => value.kind === 'send')).toHaveLength(2)
    expect(screen.getByRole('status').textContent).toContain('uncertain')
    expect((screen.getByRole('button', { name: 'Run lines' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('绑定期间导航后迟到的成功不会恢复绑定', async () => {
    let finish!: (result: object) => void
    request.mockImplementation(value => value.kind === 'bind' ? new Promise(resolve => { finish = resolve }) : Promise.resolve({ success: true }))
    const page = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Bind selected terminal' }))
    act(() => { page.dispatchEvent(new Event('did-start-navigation')) })
    await act(async () => { finish({ success: true, bindingId: 'd4a84d64-a07c-4c8d-a5cb-96dd35abae7f' }) })
    expect(screen.getByText('Quick commands & scripts')).toBeTruthy()
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ kind: 'release' }))
  })
  it('按字面保留脚本结构，拒绝控制序列和超长单行', () => {
    expect(webTerminalLines('if true; then\r\n  echo ok\r\n\r\nfi\r\n')).toEqual(['if true; then', '  echo ok', '', 'fi'])
    expect(() => webTerminalLines('echo a\x1b[2J')).toThrow()
    expect(() => webTerminalLines('a'.repeat(16385))).toThrow()
  })
})
