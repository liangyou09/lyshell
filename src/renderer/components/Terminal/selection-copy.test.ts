// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { bindSelectionCopy } from './selection-copy'

describe('终端鼠标划选复制', () => {
  let container: HTMLElement
  let screen: HTMLElement
  let terminal: Terminal
  let selection: string
  let dispose: () => void
  const writeText = vi.fn(() => Promise.resolve())
  const mouse = (target: EventTarget, type: string, button = 0, modifiers: MouseEventInit = {}): void => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, button, ...modifiers }))
  }

  beforeEach(() => {
    vi.useFakeTimers()
    writeText.mockClear()
    vi.stubGlobal('navigator', { platform: 'Win32', clipboard: { writeText } })
    container = document.createElement('div')
    screen = document.createElement('div')
    screen.className = 'xterm-screen'
    container.appendChild(screen)
    document.body.appendChild(container)
    selection = ''
    terminal = {
      element: container,
      options: {},
      modes: { mouseTrackingMode: 'none' },
      getSelection: () => selection
    } as Terminal
    dispose = bindSelectionCopy(terminal, container)
  })

  afterEach(() => {
    dispose()
    container.remove()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('等待 xterm 的 mouseup 处理结束，拖出终端松手也复制最终选区', async () => {
    const finishSelection = (): void => {
      queueMicrotask(() => { selection = '最终选中的完整内容' })
    }
    document.addEventListener('mouseup', finishSelection, { once: true })
    mouse(screen, 'mousedown')
    selection = '拖动中的部分内容'
    mouse(document, 'mouseup')
    await vi.runOnlyPendingTimersAsync()
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith(selection)
  })

  it('搜索产生和刷新选区不会覆盖手动复制的内容', async () => {
    selection = '搜索命中'
    mouse(document, 'mouseup')
    await vi.runOnlyPendingTimersAsync()
    expect(writeText).not.toHaveBeenCalled()
    mouse(screen, 'mousedown')
    selection = '手动划选'
    mouse(document, 'mouseup')
    await vi.runOnlyPendingTimersAsync()
    selection = '刷新后的搜索命中'
    await vi.runOnlyPendingTimersAsync()
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith('手动划选')
  })

  it('相同内容再次划选仍复制，空选区和右键不复制', async () => {
    for (let i = 0; i < 2; i++) {
      mouse(screen, 'mousedown')
      selection = '相同内容'
      mouse(document, 'mouseup')
      await vi.runOnlyPendingTimersAsync()
    }
    expect(writeText).toHaveBeenCalledTimes(2)
    mouse(screen, 'mousedown', 2)
    mouse(document, 'mouseup', 2)
    mouse(screen, 'mousedown')
    selection = ''
    mouse(document, 'mouseup')
    await vi.runOnlyPendingTimersAsync()
    expect(writeText).toHaveBeenCalledTimes(2)
  })

  it('卸载后取消尚未执行的复制并移除监听', async () => {
    mouse(screen, 'mousedown')
    selection = '旧终端内容'
    mouse(document, 'mouseup')
    dispose()
    await vi.runOnlyPendingTimersAsync()
    mouse(screen, 'mousedown')
    mouse(document, 'mouseup')
    await vi.runOnlyPendingTimersAsync()
    expect(writeText).not.toHaveBeenCalled()
  })

  it('重新绑定复用终端后，每次划选只复制一次', async () => {
    dispose()
    dispose = bindSelectionCopy(terminal, container)
    mouse(screen, 'mousedown')
    selection = '复用终端选区'
    mouse(document, 'mouseup')
    await vi.runOnlyPendingTimersAsync()
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith(selection)
  })

  it('xterm 截停鼠标事件冒泡时仍复制划选结果', async () => {
    screen.addEventListener('mousedown', event => event.stopPropagation())
    screen.addEventListener('mouseup', event => event.stopPropagation())
    mouse(screen, 'mousedown')
    selection = 'Shift 划选结果'
    mouse(screen, 'mouseup')
    await vi.runOnlyPendingTimersAsync()
    expect(writeText).toHaveBeenCalledWith(selection)
  })

  it('滚动条和容器空白点击不复制残留的搜索选区', async () => {
    const viewport = document.createElement('div')
    viewport.className = 'xterm-viewport'
    container.appendChild(viewport)
    selection = '残留搜索命中'
    for (const target of [container, viewport]) {
      mouse(target, 'mousedown')
      mouse(document, 'mouseup')
      await vi.runOnlyPendingTimersAsync()
    }
    expect(writeText).not.toHaveBeenCalled()
  })

  it.each([
    ['Win32', { shiftKey: true }, false],
    ['MacIntel', { altKey: true }, true]
  ])('%s 鼠标上报时只有强制划选才复制', async (platform, modifiers, macOptionClickForcesSelection) => {
    vi.stubGlobal('navigator', { platform, clipboard: { writeText } })
    Object.defineProperty(terminal.modes, 'mouseTrackingMode', { value: 'vt200' })
    terminal.options.macOptionClickForcesSelection = macOptionClickForcesSelection
    selection = '残留搜索命中'
    mouse(screen, 'mousedown')
    mouse(document, 'mouseup')
    await vi.runOnlyPendingTimersAsync()
    expect(writeText).not.toHaveBeenCalled()

    mouse(screen, 'mousedown', 0, modifiers)
    selection = '强制划选'
    mouse(document, 'mouseup')
    await vi.runOnlyPendingTimersAsync()
    expect(writeText).toHaveBeenCalledWith(selection)
  })

  it('失焦后松手不复制，下一次划选仍可复制', async () => {
    mouse(screen, 'mousedown')
    selection = '失焦前的选区'
    window.dispatchEvent(new Event('blur'))
    mouse(document, 'mouseup')
    await vi.runOnlyPendingTimersAsync()
    expect(writeText).not.toHaveBeenCalled()
    mouse(screen, 'mousedown')
    mouse(document, 'mouseup')
    await vi.runOnlyPendingTimersAsync()
    expect(writeText).toHaveBeenCalledWith(selection)
  })
})
