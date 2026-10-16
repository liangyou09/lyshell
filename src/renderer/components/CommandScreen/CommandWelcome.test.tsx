// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import CommandWelcome from './CommandWelcome'
import CommandScreen from './CommandScreen'
import { useBrowserSettingsStore } from '../../stores/browser-settings-store'
import { usePaneStore } from '../../stores/pane-store'
import { DEFAULT_BROWSER_SETTINGS, BROWSER_NEW_TAB_URL } from '@shared/browser-settings'

vi.mock('react-i18next', async importOriginal => ({ ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string) => key }) }))
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  useBrowserSettingsStore.setState({ settings: structuredClone(DEFAULT_BROWSER_SETTINGS), loaded: true, error: null })
  usePaneStore.setState({ layout: { root: { type: 'leaf', id: 'p1', sessions: [], activeSessionId: null, overlays: [] }, activePaneId: 'p1' }, overlayPayloads: {} })
})
afterEach(cleanup)

describe('欢迎页网址与搜索', () => {
  it('冷启动仅聚焦搜索框，命令按需展开，Escape 返回搜索', () => {
    const view = render(<CommandScreen mode="embedded" paneActive paneId="p1" />)
    expect(document.activeElement).toBe(view.getByRole('searchbox'))
    expect(view.queryByRole('textbox')).toBeNull()
    fireEvent.change(view.getByRole('searchbox'), { target: { value: '/?' } })
    expect(view.queryByRole('searchbox')).toBeNull()
    expect((view.getByRole('textbox') as HTMLInputElement).value).toBe('/?')
    expect(document.activeElement).toBe(view.getByRole('textbox'))
    fireEvent.keyDown(view.getByRole('textbox'), { key: 'Escape' })
    expect(document.activeElement).toBe(view.getByRole('searchbox'))
    expect(view.queryByRole('textbox')).toBeNull()
  })
  it('组合输入期间不切换命令模式，完成组合后再交接', () => {
    const start = vi.fn()
    const view = render(<CommandWelcome onCommand={vi.fn()} onNavigate={() => true} onStartCommand={start} />)
    const input = view.getByRole('searchbox')
    fireEvent.input(input, { target: { value: '/' }, isComposing: true })
    expect(start).not.toHaveBeenCalled()
    fireEvent.compositionEnd(input)
    expect(start).toHaveBeenCalledWith('/')
  })
  it('网址直接打开，关键词使用默认搜索引擎', () => {
    const navigate = vi.fn(() => true)
    const view = render(<CommandWelcome onCommand={vi.fn()} onNavigate={navigate} />)
    const input = view.getByRole('searchbox')
    fireEvent.change(input, { target: { value: 'example.com/path' } })
    fireEvent.submit(view.getByRole('search'))
    expect(navigate).toHaveBeenLastCalledWith('https://example.com/path')
    fireEvent.change(input, { target: { value: 'LyShell 使用方法' } })
    fireEvent.submit(view.getByRole('search'))
    expect(navigate).toHaveBeenLastCalledWith('https://www.bing.com/search?q=' + encodeURIComponent('LyShell 使用方法'))
    fireEvent.change(input, { target: { value: 'javascript:alert(1)' } })
    fireEvent.submit(view.getByRole('search'))
    expect(navigate).toHaveBeenCalledTimes(2)
    expect(view.getByRole('alert').textContent).toBe('webBar.invalid')
  })
  it('欢迎页切换搜索引擎会保存全局默认值', async () => {
    const request = vi.fn(async (value) => ({ success: true, settings: value.settings }))
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { browserRequest: request } })
    const view = render(<CommandWelcome onCommand={vi.fn()} onNavigate={() => true} />)
    fireEvent.change(view.getByRole('combobox'), { target: { value: 'duckduckgo' } })
    await waitFor(() => expect(useBrowserSettingsStore.getState().settings.searchEngine).toBe('duckduckgo'))
    expect(request).toHaveBeenCalledWith({ kind: 'save', settings: { ...DEFAULT_BROWSER_SETTINGS, searchEngine: 'duckduckgo' } })
  })
  it('新欢迎页签优先聚焦地址栏，提交后在原页签加载网址', () => {
    const id = usePaneStore.getState().openStartTab('p1')!
    const view = render(<CommandScreen mode="embedded" paneActive paneId="p1" webTabId={id} />)
    const input = view.getByRole('searchbox')
    expect(document.activeElement).toBe(input)
    fireEvent.mouseDown(input)
    expect(document.activeElement).toBe(input)
    fireEvent.change(input, { target: { value: 'https://example.com' } })
    fireEvent.submit(view.getByRole('search'))
    expect(usePaneStore.getState().overlayPayloads[id]).toEqual({ kind: 'web', url: 'https://example.com/', title: 'example.com' })
    expect(Object.values(usePaneStore.getState().overlayPayloads)).toHaveLength(1)
  })
  it('原位导航保留插槽和身份，失效的欢迎页签不能改写现有网页', () => {
    const store = usePaneStore.getState()
    const id = store.openStartTab('p1')!
    expect(usePaneStore.getState().overlayPayloads[id]).toMatchObject({ url: BROWSER_NEW_TAB_URL })
    const before = usePaneStore.getState().layout.root
    expect(store.openWebTab('https://example.com', 'p1', { replaceStartTabId: id }).ok).toBe(true)
    const after = usePaneStore.getState().layout.root
    expect(before.type === 'leaf' && after.type === 'leaf' && after.overlays[0].id === before.overlays[0].id).toBe(true)
    expect(store.openWebTab('https://other.example', 'p1', { replaceStartTabId: id }).ok).toBe(false)
    expect(usePaneStore.getState().overlayPayloads[id]).toMatchObject({ url: 'https://example.com/' })
  })
})
