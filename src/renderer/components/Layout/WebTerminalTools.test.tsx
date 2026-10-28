// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import WebTerminalTools from './WebTerminalTools'
import WebTerminalButton from './WebTerminalButton'
import { webTerminalLines } from './web-terminal-script'
import { stageWebTerminalCommand } from './web-terminal-command'
import type { WebviewTag } from 'electron'
import '../../i18n'

const routing = vi.hoisted(() => ({ active: 'web-test' }))
vi.mock('./web-tab-controls', () => ({ activeWebTabId: () => routing.active }))
const request = vi.fn()
const bindingId = 'd4a84d64-a07c-4c8d-a5cb-96dd35abae7f'
const originalApi = window.electronAPI
beforeEach(() => {
  routing.active = 'web-test'
  let bound = false
  request.mockReset().mockImplementation(async value => {
    if (value.kind === 'bind') { bound = true; return { success: true, bindingId } }
    if (value.kind === 'discover') return { success: true, terminalCount: bound ? 1 : 0, ...(bound ? { bindingId } : {}) }
    return { success: true }
  })
  window.electronAPI = { ...originalApi, webTerminal: request }
})
afterEach(() => { cleanup(); window.electronAPI = originalApi; vi.useRealTimers() })

function mount(): HTMLElement {
  const page = document.createElement('div')
  Object.assign(page, { getWebContentsId: () => 71 })
  render(<><WebTerminalButton id="web-test" /><WebTerminalTools id="web-test" pageRef={{ current: page as unknown as WebviewTag }} /></>)
  act(() => { stageWebTerminalCommand({ id: 'empty', name: '', content: '', order: 0 }) })
  return page
}
async function bind(): Promise<void> {
  await act(async () => {})
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Bind selected terminal' })) })
}

describe('网页终端工具', () => {
  it('快捷命令只载入草稿，普通网页不隐式执行', () => {
    mount()
    act(() => { stageWebTerminalCommand({ id: 'q', name: 'Inspect', content: 'echo ok', order: 1 }) })
    expect((screen.getByRole('textbox', { name: 'Command or script' }) as HTMLTextAreaElement).value).toBe('echo ok')
    expect(request.mock.calls.filter(([value]) => value.kind === 'send' || value.kind === 'bind')).toHaveLength(0)
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
    request.mockImplementation(async value => value.kind === 'send' ? { success: false, error: 'uncertain' } : { success: true, terminalCount: 1, bindingId })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Run lines' })); await vi.runAllTimersAsync() })
    expect(request.mock.calls.filter(([value]) => value.kind === 'send')).toHaveLength(2)
    expect(screen.getByRole('status').textContent).toContain('uncertain')
    expect((screen.getByRole('button', { name: 'Run lines' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('绑定期间导航后迟到的成功不会恢复绑定', async () => {
    let finish!: (result: object) => void
    request.mockImplementation(value => value.kind === 'bind' ? new Promise(resolve => { finish = resolve }) : Promise.resolve({ success: true }))
    const page = mount()
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: 'Bind selected terminal' }))
    act(() => { page.dispatchEvent(new Event('did-start-navigation')) })
    await act(async () => { finish({ success: true, bindingId: 'd4a84d64-a07c-4c8d-a5cb-96dd35abae7f' }) })
    expect(screen.getByText('Quick commands & scripts')).toBeTruthy()
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ kind: 'release' }))
  })

  it('普通网页没有常驻横条或入口，检测到单终端后显示顶部按钮并自动附着', async () => {
    vi.useFakeTimers()
    const page = document.createElement('div')
    Object.assign(page, { getWebContentsId: () => 71 })
    render(<><WebTerminalButton id="web-test" /><WebTerminalTools id="web-test" pageRef={{ current: page as unknown as WebviewTag }} /></>)
    await act(async () => {})
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('region')).toBeNull()
    request.mockResolvedValue({ success: true, terminalCount: 1, bindingId })
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    fireEvent.click(screen.getByRole('button', { name: 'Web terminal · Attached' }))
    expect(screen.getByRole('textbox')).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'echo ok' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Run lines' })) })
    expect(request).toHaveBeenCalledWith({ kind: 'send', pageId: 71, bindingId, text: 'echo ok', enter: true })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Web terminal · Attached' }))
  })
  it('多个终端先提示点击选择，探测不输入，选中后沿用后端绑定', async () => {
    vi.useFakeTimers()
    request.mockResolvedValue({ success: true, terminalCount: 2 })
    mount()
    await act(async () => {})
    expect(screen.getByRole('button', { name: 'Web terminal · Click a terminal' })).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Run lines' }) as HTMLButtonElement).disabled).toBe(true)
    request.mockResolvedValue({ success: true, terminalCount: 2, bindingId })
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    expect(screen.getByRole('button', { name: 'Web terminal · Attached' })).toBeTruthy()
    expect(request.mock.calls.every(([value]) => value.kind === 'discover')).toBe(true)
  })
  it('发送过程中暂停探测，不确定结果不会被重新附着提示覆盖', async () => {
    vi.useFakeTimers()
    mount()
    await bind()
    request.mockImplementation(async value => value.kind === 'discover'
      ? { success: true, terminalCount: 1, bindingId }
      : value.kind === 'send' ? { success: false, error: 'uncertain' } : { success: true })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'first' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Run lines' })) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    expect(screen.getByRole('status').textContent).toContain('uncertain')
    expect(request.mock.calls.filter(([value]) => value.kind === 'send')).toHaveLength(1)
  })
  it('导航后迟到的自动附着被释放，不恢复旧目标', async () => {
    let finish!: (result: object) => void
    request.mockImplementation(value => value.kind === 'discover'
      ? new Promise(resolve => { finish = resolve }) : Promise.resolve({ success: true }))
    const page = mount()
    act(() => { page.dispatchEvent(new Event('did-start-navigation')) })
    await act(async () => { finish({ success: true, terminalCount: 1, bindingId }) })
    expect(request).toHaveBeenCalledWith({ kind: 'release', pageId: 71, bindingId })
    expect((screen.getByRole('button', { name: 'Run lines' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('发送前发现用户已选择另一终端时停止，防止发送给旧目标', async () => {
    mount()
    await bind()
    request.mockResolvedValue({ success: true, terminalCount: 2, bindingId: 'a4a84d64-a07c-4c8d-a5cb-96dd35abae7f' })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'danger' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Run lines' })) })
    expect(request.mock.calls.filter(([value]) => value.kind === 'send')).toHaveLength(0)
    expect(screen.getByRole('status').textContent).toContain('Input target changed')
  })
  it('逐行发送时不轮询，停止后可恢复发现但不续发脚本', async () => {
    vi.useFakeTimers()
    mount()
    await bind()
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '3000' } })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'first\nsecond' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Run lines' })) })
    const before = request.mock.calls.filter(([value]) => value.kind === 'discover').length
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    expect(request.mock.calls.filter(([value]) => value.kind === 'discover')).toHaveLength(before)
    fireEvent.click(screen.getByRole('button', { name: 'Stop further input' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(request.mock.calls.filter(([value]) => value.kind === 'send')).toHaveLength(1)
    expect(request.mock.calls.filter(([value]) => value.kind === 'discover').length).toBeGreaterThan(before)
  })
  it('后台网页不探测，导航过程中等待就绪后再发现', async () => {
    vi.useFakeTimers()
    routing.active = 'another-tab'
    const page = mount()
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(request).not.toHaveBeenCalled()
    routing.active = 'web-test'
    act(() => { page.dispatchEvent(new Event('did-start-navigation')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(request).not.toHaveBeenCalled()
    await act(async () => { page.dispatchEvent(new Event('dom-ready')) })
    expect(request).toHaveBeenCalledWith({ kind: 'discover', pageId: 71 })
  })
  it('导航失败或取消后没有 dom-ready，也能在加载停止后重新发现', async () => {
    vi.useFakeTimers()
    const page = mount()
    await act(async () => {})
    request.mockClear()
    act(() => { page.dispatchEvent(new Event('did-start-navigation')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(request.mock.calls.filter(([value]) => value.kind === 'discover')).toHaveLength(0)
    request.mockResolvedValue({ success: true, terminalCount: 1, bindingId })
    await act(async () => { page.dispatchEvent(new Event('did-stop-loading')) })
    expect(request).toHaveBeenCalledWith({ kind: 'discover', pageId: 71 })
    expect(screen.getByRole('button', { name: 'Web terminal · Attached' })).toBeTruthy()
    expect(request.mock.calls.filter(([value]) => value.kind === 'send')).toHaveLength(0)
  })
  it('按字面保留脚本结构，拒绝控制序列和超长单行', () => {
    expect(webTerminalLines('if true; then\r\n  echo ok\r\n\r\nfi\r\n')).toEqual(['if true; then', '  echo ok', '', 'fi'])
    expect(() => webTerminalLines('echo a\x1b[2J')).toThrow()
    expect(() => webTerminalLines('a'.repeat(16385))).toThrow()
  })
})
