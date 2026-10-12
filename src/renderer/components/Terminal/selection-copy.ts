import type { Terminal } from '@xterm/xterm'

/** 只复制鼠标划选结果，避免搜索插件的程序化选区覆盖剪贴板。 */
export function bindSelectionCopy(terminal: Terminal, container: HTMLElement): () => void {
  const ownerDocument = container.ownerDocument
  let selecting = false
  const pendingCopies = new Set<ReturnType<typeof setTimeout>>()

  const onMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) return
    // 滚动条和容器空白不产生划选，不能复制残留的搜索选区。
    const screen = terminal.element?.querySelector('.xterm-screen')
    const isMac = ['Macintosh', 'MacIntel', 'MacPPC', 'Mac68K'].includes(navigator.platform)
    const forceSelection = isMac
      ? event.altKey && terminal.options.macOptionClickForcesSelection
      : event.shiftKey
    selecting = !!screen && screen.contains(event.target as Node) &&
      (terminal.modes.mouseTrackingMode === 'none' || !!forceSelection)
  }
  const onMouseUp = (event: MouseEvent): void => {
    if (event.button !== 0 || !selecting) return
    selecting = false
    // 原生事件的监听器之间可能执行微任务；用下一轮任务等待 xterm 完成 mouseup。
    // 监听 document，保证拖出终端后松手也能复制。
    const timer = setTimeout(() => {
      pendingCopies.delete(timer)
      const selection = terminal.getSelection()
      if (selection) {
        navigator.clipboard.writeText(selection).catch(err => {
          console.warn('[TerminalView] clipboard writeText failed:', err)
        })
      }
    }, 0)
    pendingCopies.add(timer)
  }
  const onBlur = (): void => { selecting = false }

  // 捕获阶段记录手势，兼容 xterm 在鼠标捕获模式下截停冒泡（如 Shift 划选）。
  container.addEventListener('mousedown', onMouseDown, true)
  ownerDocument.addEventListener('mouseup', onMouseUp, true)
  ownerDocument.defaultView?.addEventListener('blur', onBlur)
  return () => {
    for (const timer of pendingCopies) clearTimeout(timer)
    pendingCopies.clear()
    container.removeEventListener('mousedown', onMouseDown, true)
    ownerDocument.removeEventListener('mouseup', onMouseUp, true)
    ownerDocument.defaultView?.removeEventListener('blur', onBlur)
  }
}
