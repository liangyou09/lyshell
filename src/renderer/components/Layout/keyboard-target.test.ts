// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { isWebTabShortcutTarget } from './keyboard-target'
import { matchWebTabShortcut } from '@shared/webtab-shortcut'

const actionFor = (target: HTMLElement, key = 'F5', shift = false) =>
  isWebTabShortcutTarget(target, key, 'active')
    ? matchWebTabShortcut({ type: 'keyDown', key, shift, control: false, alt: false, isAutoRepeat: false })
    : null

describe('宿主网页快捷键焦点范围', () => {
  it.each(['input', 'textarea', 'div'])('设置、命令和编辑器中的 F5 不刷新网页：%s', tag => {
    const editor = document.createElement(tag)
    if (tag === 'div') Object.defineProperty(editor, 'isContentEditable', { value: true })
    expect(actionFor(editor)).toBeNull()
    expect(actionFor(editor, 'F5', true)).toBeNull()
    expect(actionFor(editor, 'F12')).toBe('toggle-devtools')
  })

  it('主地址栏允许刷新与强刷，小窗地址栏交回小窗处理', () => {
    const input = document.createElement('input')
    input.setAttribute('list', 'lyshell-webbar-history')
    expect(actionFor(input)).toBe('reload')
    expect(actionFor(input, 'F5', true)).toBe('reload-hard')
    const mini = document.createElement('div')
    mini.className = 'web-mini-browser'
    mini.append(input)
    expect(actionFor(input)).toBeNull()
    expect(actionFor(input, 'F12')).toBeNull()
  })

  it('残留在其他分屏终端的焦点不能刷新活动网页', () => {
    const pane = document.createElement('div')
    pane.dataset.paneId = 'other'
    const terminal = document.createElement('div')
    terminal.className = 'xterm'
    const input = document.createElement('textarea')
    terminal.append(input)
    pane.append(terminal)
    expect(actionFor(input)).toBeNull()
    pane.dataset.paneId = 'active'
    expect(actionFor(input)).toBe('reload')
    expect(actionFor(document.createElement('button'))).toBe('reload')
  })
})
