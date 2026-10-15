// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { usePaneStore } from '../../stores/pane-store'
import i18n from '../../i18n'
import SearchableTab, { FIND_IN_TAB_EVENT } from './SearchableTab'

beforeEach(async () => {
  await i18n.changeLanguage('en')
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { fn(); return 1 })
  usePaneStore.setState({ layout: { activePaneId: 'p', root: { id: 'p', type: 'leaf', sessions: [], activeSessionId: null, overlays: [{ id: 'doc', kind: 'doc', active: true, slot: null }, { id: 'web', kind: 'web', active: false, slot: null }] } } })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const open = () => {
  fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
  return screen.getByRole('textbox', { name: 'search…' })
}
describe('当前非终端页签查找', () => {
  it('内容刷新后重算匹配，搜索框自身不进入计数', async () => {
    const { rerender } = render(<SearchableTab id="doc"><article>hello hello</article></SearchableTab>)
    const input = open()
    fireEvent.change(input, { target: { value: 'hello' } })
    expect(screen.getByRole('status').textContent).toBe('1 / 2')
    rerender(<SearchableTab id="doc"><article>hello updated</article></SearchableTab>)
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('1 / 1'))
  })
  it('只有活动页签打开，支持计数、前后循环、无效正则和 ESC 清理', () => {
    render(<><SearchableTab id="doc"><article>shell Shell shells</article></SearchableTab><SearchableTab id="web"><p>inactive</p></SearchableTab></>)
    const input = open()
    expect(screen.getAllByRole('search')).toHaveLength(1)
    expect(screen.queryByRole('radiogroup')).toBeNull()
    fireEvent.change(input, { target: { value: 'shell' } })
    expect(screen.getByRole('status').textContent).toBe('1 / 3')
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(screen.getByRole('status').textContent).toBe('3 / 3')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Whole word' }))
    expect(screen.getByRole('status').textContent).toBe('1 / 2')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Regular expression' }))
    fireEvent.change(input, { target: { value: '[' } })
    expect(screen.getByRole('status').textContent).toBe('Invalid regular expression')
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('search')).toBeNull()
    expect(document.head.querySelector('style')).toBeNull()
  })
  it('接入同源 HTML iframe 内的 Ctrl+F', () => {
    const { container } = render(<SearchableTab id="doc"><iframe title="html" /></SearchableTab>)
    const frame = container.querySelector('iframe')!
    vi.spyOn(frame.contentDocument!, 'getSelection').mockReturnValue(null)
    frame.contentDocument!.body.innerHTML = '<p>frame hello hello</p>'
    fireEvent.load(frame)
    fireEvent.keyDown(frame.contentWindow!, { key: 'f', ctrlKey: true })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } })
    expect(screen.getByRole('status').textContent).toBe('1 / 2')
  })
  it('网页隐藏不支持的选项，过滤旧请求回报，切走后清理', () => {
    // web 参数代表搜索引擎，测试沿用活动 doc 身份以隔离 store 的页签操作。
    const { container } = render(<SearchableTab id="doc" web>{React.createElement('webview')}</SearchableTab>)
    const view = container.querySelector('webview')! as HTMLElement & { findInPage: ReturnType<typeof vi.fn>; stopFindInPage: ReturnType<typeof vi.fn> }
    view.findInPage = vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(11).mockReturnValueOnce(12)
    view.stopFindInPage = vi.fn()
    act(() => { window.dispatchEvent(new Event(FIND_IN_TAB_EVENT)) })
    const input = screen.getByRole('textbox')
    expect(screen.queryByRole('checkbox', { name: 'Regular expression' })).toBeNull()
    expect(screen.queryByRole('checkbox', { name: 'Whole word' })).toBeNull()
    fireEvent.change(input, { target: { value: 'hello' } })
    const report = (requestId: number, matches: number, activeMatchOrdinal: number) => {
      const event = new Event('found-in-page')
      Object.assign(event, { result: { requestId, matches, activeMatchOrdinal } })
      act(() => { view.dispatchEvent(event) })
    }
    report(10, 3, 1)
    expect(screen.getByRole('status').textContent).toBe('1 / 3')
    fireEvent.change(input, { target: { value: 'other' } })
    report(10, 99, 1)
    expect(screen.getByRole('status').textContent).toBe('no matches')
    report(11, 2, 1)
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(view.findInPage).toHaveBeenLastCalledWith('other', { forward: false, findNext: true, matchCase: false })
    act(() => { usePaneStore.getState().deactivateOverlay('doc') })
    expect(screen.queryByRole('search')).toBeNull()
    expect(view.stopFindInPage).toHaveBeenCalledWith('clearSelection')
  })
})
