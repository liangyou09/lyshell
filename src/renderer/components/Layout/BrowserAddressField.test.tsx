// @vitest-environment jsdom
import { useRef, useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BrowserAddressField from './BrowserAddressField'
import { useBrowserSettingsStore } from '../../stores/browser-settings-store'
import { DEFAULT_BROWSER_SETTINGS, type BrowserResult } from '@shared/browser-settings'
import '../../i18n'

vi.mock('./BrowserSearchEngineButton', () => ({ default: () => null }))
const request = vi.fn()
const submit = vi.fn()
function Field({ visible = true, mini = false }: { visible?: boolean; mini?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState('')
  return <BrowserAddressField inputRef={inputRef} value={value} placeholder="Search" aria-label="Address" visible={visible} mini={mini}
    suggestions={[]} renderIcon={() => null} onChange={e => setValue(e.target.value)} onKeyDown={() => undefined} onSubmit={submit} />
}
const input = () => screen.getByRole('combobox')
const type = (value: string) => fireEvent.change(input(), { target: { value } })
const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(220) })
beforeEach(() => {
  vi.useFakeTimers(); request.mockReset(); submit.mockReset()
  useBrowserSettingsStore.setState({ settings: { ...structuredClone(DEFAULT_BROWSER_SETTINGS) }, loaded: true, error: null })
  window.electronAPI = { browserRequest: request } as unknown as typeof window.electronAPI
  request.mockResolvedValue({ success: true, searchEngine: 'bing', searchSuggestions: ['中文输入法', '中文词典'] })
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('地址栏搜索词联想', () => {
  it('网址形态的远程候选仍作为搜索词提交', async () => {
    request.mockResolvedValue({ success: true, searchEngine: 'bing', searchSuggestions: ['example.com'] })
    render(<Field />)
    type('example'); await tick()
    fireEvent.click(screen.getByText('example.com', { exact: true }))
    expect(submit).toHaveBeenCalledWith('https://www.bing.com/search?q=example.com')
  })
  it.each([false, true])('没有历史也能防抖获取建议并用方向键搜索，小窗=%s', async mini => {
    render(<Field mini={mini} />)
    type('中'); type('中文')
    expect(request).not.toHaveBeenCalled()
    await tick()
    expect(request).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith({ kind: 'searchSuggestions', query: '中文' })
    expect(screen.getAllByRole('option')).toHaveLength(3)
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(submit).toHaveBeenCalledWith('https://www.bing.com/search?q=' + encodeURIComponent('中文输入法'))
    expect(screen.queryByRole('listbox')).toBeNull()
  })
  it('旧响应、失焦、关闭和隐藏都不会重新弹出联想', async () => {
    let first!: (value: BrowserResult) => void
    request.mockImplementationOnce(() => new Promise(resolve => { first = resolve }))
    const view = render(<Field />)
    type('first'); await tick()
    type('second'); await tick()
    await act(async () => { first({ success: true, searchEngine: 'bing', searchSuggestions: ['stale result'] }) })
    expect(screen.queryByText('stale result')).toBeNull()
    fireEvent.keyDown(input(), { key: 'Escape' })
    await tick()
    expect(screen.queryByRole('listbox')).toBeNull()
    type('third')
    view.rerender(<Field visible={false} />)
    await tick()
    view.rerender(<Field visible />)
    expect(screen.queryByRole('listbox')).toBeNull()
    type('fourth')
    fireEvent.blur(input())
    await tick()
    expect(screen.queryByRole('listbox')).toBeNull()
  })
  it('输入法组合期间不请求、不导航；提交中文后才联想', async () => {
    render(<Field />)
    fireEvent.compositionStart(input())
    type('zhong wen'); await tick()
    fireEvent.keyDown(input(), { key: 'Enter', isComposing: true })
    expect(request).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
    type('中文'); fireEvent.compositionEnd(input()); await tick()
    expect(request).toHaveBeenCalledWith({ kind: 'searchSuggestions', query: '中文' })
  })
  it('网址和账号不发请求，切换到其他引擎后不发送给 Bing', async () => {
    render(<Field />)
    for (const value of ['https://example.com/private?key=secret', 'user@example.com', 'D:\\workspace']) { type(value); await tick() }
    expect(request).not.toHaveBeenCalled()
    act(() => useBrowserSettingsStore.setState({ settings: { ...DEFAULT_BROWSER_SETTINGS, searchEngine: 'google' } }))
    type('中文'); await tick()
    expect(request).not.toHaveBeenCalled()
    expect(screen.getAllByRole('option')).toHaveLength(1)
    act(() => useBrowserSettingsStore.setState({ settings: { ...DEFAULT_BROWSER_SETTINGS, searchEngine: 'none' } }))
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})
