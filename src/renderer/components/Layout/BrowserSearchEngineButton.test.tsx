// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DEFAULT_BROWSER_SETTINGS } from '@shared/browser-settings'
import { useBrowserSettingsStore } from '../../stores/browser-settings-store'
import BrowserAddressField from './BrowserAddressField'
import BrowserSearchEngineButton from './BrowserSearchEngineButton'
import '../../i18n'

const oldApi = window.electronAPI
beforeEach(() => {
  useBrowserSettingsStore.setState({ settings: structuredClone(DEFAULT_BROWSER_SETTINGS), loaded: true, error: null })
  window.electronAPI = { ...oldApi, browserRequest: vi.fn(async raw => raw.kind === 'save' ? { success: true, settings: raw.settings } : { success: false }) }
})
afterEach(() => { cleanup(); window.electronAPI = oldApi })

describe('地址栏地球仪切换搜索引擎', () => {
  it('当前引擎只出现在提示框，选择后保存且不改输入或发起导航', async () => {
    const submit = vi.fn()
    render(<BrowserAddressField inputRef={{ current: null }} value="正在编辑的内容" placeholder="Search" aria-label="URL"
      suggestions={[]} renderIcon={() => null} onChange={vi.fn()} onKeyDown={vi.fn()} onSubmit={submit} visible />)
    const trigger = screen.getByRole('button', { name: 'Search engine: Bing' })
    expect(trigger.title).toBe('Search engine: Bing')
    expect(screen.queryByText('Search engine: Bing')).toBeNull()
    fireEvent.click(trigger)
    expect(screen.getByRole('menuitemradio', { name: 'Bing' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Google' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Search engine: Google' })).toBeTruthy())
    expect(window.electronAPI.browserRequest).toHaveBeenCalledWith({ kind: 'save', settings: { ...DEFAULT_BROWSER_SETTINGS, searchEngine: 'google' } })
    expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('正在编辑的内容')
    expect(submit).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
  })
  it('保存失败时保留旧引擎，在提示框和无障碍状态中报告失败', async () => {
    window.electronAPI.browserRequest = vi.fn(async () => ({ success: false, error: 'browserOperationFailed' }))
    render(<BrowserSearchEngineButton visible onOpen={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Search engine: Bing' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Google' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('failed'))
    expect(useBrowserSettingsStore.getState().settings.searchEngine).toBe('bing')
    expect(screen.getByRole('button', { name: /Search engine: Bing/ }).title).toContain('failed')
  })
  it('支持键盘、关闭搜索和Escape收起，设置未就绪时不允许保存', async () => {
    const { rerender } = render(<BrowserSearchEngineButton visible onOpen={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Search engine: Bing' }))
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'End' })
    const off = screen.getByRole('menuitemradio', { name: 'Off (URLs only)' })
    expect(document.activeElement).toBe(off)
    fireEvent.click(off)
    await waitFor(() => expect(useBrowserSettingsStore.getState().settings.searchEngine).toBe('none'))
    fireEvent.click(screen.getByRole('button', { name: 'Search engine: Off (URLs only)' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    useBrowserSettingsStore.setState({ loaded: false })
    rerender(<BrowserSearchEngineButton visible onOpen={vi.fn()} />)
    expect((screen.getByRole('button', { name: 'Search engine: Off (URLs only)' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
