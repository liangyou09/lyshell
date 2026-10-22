// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import type { SearchAddon } from '@xterm/addon-search'
import type { FitAddon } from '@xterm/addon-fit'
import type { PaneLeaf } from '@shared/types'
import { usePaneStore } from '../../stores/pane-store'
import { useTerminalStore } from '../../stores/terminal-store'
import { searchAllTerminals } from './search-all-terminals'

const leaf = (id: string, sessions: string[]): PaneLeaf => ({ id, type: 'leaf', sessions, activeSessionId: sessions[0], overlays: [] })
function register(id: string, rows: number[], row: number | null) {
  let selected = row
  const terminal = {
    cols: 80, rows: 24,
    dispose: vi.fn(),
    getSelectionPosition: () => selected === null ? undefined : { start: { x: 0, y: selected }, end: { x: 3, y: selected } },
    clearSelection: () => { selected = null }
  }
  const next = vi.fn(() => { selected = rows.find(value => selected === null || value > selected) ?? rows[0] ?? null; return selected !== null })
  const prev = vi.fn(() => { selected = [...rows].reverse().find(value => selected === null || value < selected) ?? rows.at(-1) ?? null; return selected !== null })
  // 真实 addon 清理装饰不会清除终端选区，两者必须独立模拟。
  const clear = vi.fn()
  useTerminalStore.getState().registerTerminal(id, terminal as unknown as Terminal, {} as FitAddon, { findNext: next, findPrevious: prev, clearDecorations: clear } as unknown as SearchAddon)
  return { next, prev, clear }
}
beforeEach(() => {
  useTerminalStore.setState({ terminals: new Map() })
  usePaneStore.setState({ layout: { root: { id: 'split', type: 'split', direction: 'horizontal', splitRatio: .5, firstChild: leaf('p1', ['a', 'hidden']), secondChild: leaf('p2', ['empty', 'b']) }, activePaneId: 'p1' }, hiddenTabSessions: { hidden: true }, overlayPayloads: {} })
})
describe('仅终端跨页签搜索', () => {
  it('当前终端还有下一条时不切换', () => {
    register('a', [1, 3], 1)
    const other = register('b', [2], null)
    expect(searchAllTerminals('a', 'foo', 'next', { caseSensitive: true })).toBe('a')
    expect(other.next).not.toHaveBeenCalled()
  })
  it('到达末尾跳过隐藏和无匹配页签，切到其它分屏', () => {
    register('a', [1], 1)
    const hidden = register('hidden', [1], null)
    register('empty', [], null)
    const other = register('b', [2], null)
    expect(searchAllTerminals('a', 'foo', 'next', { regex: true, wholeWord: true })).toBe('b')
    expect(hidden.next).not.toHaveBeenCalled()
    expect(other.next).toHaveBeenCalledWith('foo', { regex: true, wholeWord: true })
    expect(usePaneStore.getState().layout.activePaneId).toBe('p2')
  })
  it('反向跨页签取上一终端的最后一个匹配', () => {
    register('a', [1], 1)
    const other = register('b', [2, 4], 4)
    expect(searchAllTerminals('a', 'foo', 'prev', {})).toBe('b')
    expect(other.prev).toHaveBeenCalled()
    expect(useTerminalStore.getState().getTerminal('b')!.terminal.getSelectionPosition()!.start.y).toBe(4)
  })
  it('进入其它终端时从头查找，不沿用旧选区', () => {
    register('a', [1], 1)
    register('b', [2, 4, 6], 4)
    expect(searchAllTerminals('a', 'foo', 'next', {})).toBe('b')
    expect(useTerminalStore.getState().getTerminal('b')!.terminal.getSelectionPosition()!.start.y).toBe(2)
  })
  it('其它终端无匹配时回到当前终端；全部无匹配返回 null', () => {
    register('a', [1], 1)
    register('b', [], null)
    expect(searchAllTerminals('a', 'foo', 'next', {})).toBe('a')
    register('a', [], null)
    expect(searchAllTerminals('a', 'foo', 'next', {})).toBeNull()
  })
})
