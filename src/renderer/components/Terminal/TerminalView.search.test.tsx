// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type { SearchAddon, ISearchOptions, ISearchResultChangeEvent } from '@xterm/addon-search'
import { useTerminalStore } from '@/stores/terminal-store'
import i18n from '@/i18n'
import TerminalView from './TerminalView'
import ErrorBoundary from '../ErrorBoundary'

// jsdom 不绘制终端；保留真实 TerminalView、搜索选项和结果订阅回路。
vi.mock('@xterm/xterm', () => ({ Terminal: class {} }))
vi.mock('../DocPanel/registerDocLinkProvider', () => ({ registerDocLinkProvider: vi.fn() }))

const findNext = vi.fn<[term: string, options?: ISearchOptions], boolean>()
const findPrevious = vi.fn(() => true)
const clearDecorations = vi.fn()
let onResults: ((results: ISearchResultChangeEvent) => void) | undefined
let savedFonts: PropertyDescriptor | undefined

beforeEach(async () => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  onResults = undefined
  savedFonts = Object.getOwnPropertyDescriptor(document, 'fonts')
  Object.defineProperty(document, 'fonts', { configurable: true, value: new EventTarget() })
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    disconnect(): void {}
  })
  await i18n.changeLanguage('en')

  findNext.mockImplementation((term, options) => {
    // 与真实 addon 一样，无效正则会抛 SyntaxError，不能让替身掩盖崩溃。
    if (options?.regex) new RegExp(term, options.caseSensitive ? 'g' : 'gi')
    // 模拟 addon 刷新装饰后推送不同计数，检查 UI 是否消费最新结果。
    onResults?.({ resultIndex: 0, resultCount: options?.caseSensitive || options?.regex || options?.wholeWord ? 1 : 3 })
    return true
  })
  useTerminalStore.getState().registerTerminal(
    'search-test',
    { options: {}, cols: 80, rows: 24 } as unknown as Terminal,
    { fit: vi.fn() } as unknown as FitAddon,
    {
      findNext,
      findPrevious,
      clearDecorations,
      onDidChangeResults: (listener: (results: ISearchResultChangeEvent) => void) => {
        onResults = listener
        return { dispose: () => { onResults = undefined } }
      }
    } as unknown as SearchAddon
  )
})

afterEach(() => {
  cleanup()
  useTerminalStore.setState({ terminals: new Map() })
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  if (savedFonts) Object.defineProperty(document, 'fonts', savedFonts)
  else Reflect.deleteProperty(document, 'fonts')
})

function openSearch(): HTMLTextAreaElement {
  const view: React.ReactElement = <ErrorBoundary><TerminalView sessionId="search-test" /></ErrorBoundary>
  render(view)
  fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
  return screen.getByRole('textbox', { name: 'search…' }) as HTMLTextAreaElement
}

describe('TerminalView 实时搜索', () => {
  it.each([
    ['Match case', 'caseSensitive'],
    ['Regular expression', 'regex'],
    ['Whole word', 'wholeWord']
  ])('切换 %s 立即刷新搜索选项与计数，无需回车', (label, option) => {
    const input = openSearch()
    fireEvent.change(input, { target: { value: 'shell' } })
    expect(screen.getByRole('status').textContent).toBe('1 / 3')
    findNext.mockClear()
    clearDecorations.mockClear()

    fireEvent.click(screen.getByRole('checkbox', { name: label }))
    expect(findNext).toHaveBeenCalledTimes(1)
    expect(clearDecorations).toHaveBeenCalledTimes(1)
    expect(clearDecorations.mock.invocationCallOrder[0]).toBeLessThan(findNext.mock.invocationCallOrder[0])
    expect(findNext).toHaveBeenLastCalledWith('shell', expect.objectContaining({ [option]: true, incremental: true }))
    expect(screen.getByRole('status').textContent).toBe('1 / 1')

    fireEvent.click(screen.getByRole('checkbox', { name: label }))
    expect(findNext).toHaveBeenLastCalledWith('shell', expect.objectContaining({ [option]: false }))
    expect(screen.getByRole('status').textContent).toBe('1 / 3')
  })

  it('输入只刷新一次，Enter 和 Shift+Enter 仍执行前后导航', () => {
    const input = openSearch()
    fireEvent.change(input, { target: { value: 'shell' } })
    expect(findNext).toHaveBeenCalledTimes(1)
    expect(findNext.mock.calls[0][1]?.incremental).toBe(true)

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(findNext).toHaveBeenCalledTimes(2)
    expect(findNext.mock.calls[1][1]?.incremental).toBeUndefined()
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(findPrevious).toHaveBeenCalledWith('shell', expect.objectContaining({ caseSensitive: false, regex: false, wholeWord: false }))
  })

  it('全部标签模式下不留下当前标签高亮，切回时应用最新选项', () => {
    const input = openSearch()
    fireEvent.change(input, { target: { value: 'shell' } })
    fireEvent.click(screen.getByRole('radio', { name: 'All' }))
    expect(clearDecorations).toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toBe('—')
    findNext.mockClear()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Match case' }))
    expect(findNext).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('radio', { name: 'Tab' }))
    expect(findNext).toHaveBeenCalledWith('shell', expect.objectContaining({ caseSensitive: true }))
    expect(screen.getByRole('status').textContent).toBe('1 / 1')
  })

  it('清空词后归零，切换选项不对空词发起搜索', () => {
    const input = openSearch()
    fireEvent.change(input, { target: { value: 'shell' } })
    clearDecorations.mockClear()
    findNext.mockClear()
    fireEvent.change(input, { target: { value: '' } })
    expect(clearDecorations).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status').textContent).toBe('—')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Regular expression' }))
    expect(findNext).not.toHaveBeenCalled()
  })

  it('关闭时清除高亮，重新打开恢复原词的最新搜索结果', () => {
    const input = openSearch()
    fireEvent.change(input, { target: { value: 'shell' } })
    clearDecorations.mockClear()
    findNext.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Close (Esc)' }))
    expect(clearDecorations).toHaveBeenCalledTimes(1)
    expect(findNext).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    expect(findNext).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status').textContent).toBe('1 / 3')
  })

  it.each(['[', '(', '\\'])('输入 %s 后开启正则仍可编辑，导航不会调用 addon', (pattern) => {
    const input = openSearch()
    fireEvent.change(input, { target: { value: pattern } })
    findNext.mockClear()
    clearDecorations.mockClear()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Regular expression' }))

    expect(screen.getByRole('textbox', { name: 'search…' })).toBe(input)
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('status').textContent).toBe('Invalid regular expression')
    expect(clearDecorations).toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    fireEvent.click(screen.getByRole('button', { name: 'Next (Enter)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Previous (Shift+Enter)' }))
    expect(findNext).not.toHaveBeenCalled()
    expect(findPrevious).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: '[a]' } })
    expect(input.getAttribute('aria-invalid')).not.toBe('true')
    expect(findNext).toHaveBeenCalledWith('[a]', expect.objectContaining({ regex: true }))
    expect(screen.getByRole('status').textContent).toBe('1 / 1')
  })

  it('开启正则后输入未完成表达式，清空后可恢复合法搜索', () => {
    const input = openSearch()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Regular expression' }))
    fireEvent.change(input, { target: { value: 'shell' } })
    findNext.mockClear()
    fireEvent.change(input, { target: { value: '[' } })
    expect(screen.getByRole('status').textContent).toBe('Invalid regular expression')
    expect(findNext).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: '' } })
    expect(input.getAttribute('aria-invalid')).not.toBe('true')
    expect(screen.getByRole('status').textContent).toBe('—')
    fireEvent.change(input, { target: { value: 'sh.ll' } })
    expect(findNext).toHaveBeenCalledWith('sh.ll', expect.objectContaining({ regex: true }))
  })

  it('关闭正则后以字面量搜索，关闭重开无效正则也不会崩溃', () => {
    const input = openSearch()
    fireEvent.change(input, { target: { value: '[' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Regular expression' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close (Esc)' }))
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    expect(screen.getByRole('status').textContent).toBe('Invalid regular expression')

    findNext.mockClear()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Regular expression' }))
    expect(screen.getByRole('textbox', { name: 'search…' }).getAttribute('aria-invalid')).not.toBe('true')
    expect(findNext).toHaveBeenCalledWith('[', expect.objectContaining({ regex: false }))
    expect(screen.getByRole('status').textContent).toBe('1 / 3')
  })
})
