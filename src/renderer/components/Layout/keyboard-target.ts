/** 真正的文本编辑目标；xterm 的隐藏 textarea 属于终端。 */
export const isTextEditingTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false
  if (target.closest('.xterm')) return false
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
}

/** 宿主浏览器快捷键的焦点边界：小窗自行处理，普通编辑器保留输入。 */
export function isWebTabShortcutTarget(target: EventTarget | null, key: string, activePaneId: string | null): boolean {
  if (!(target instanceof HTMLElement)) return true
  if (target.closest('.web-mini-browser')) return false
  if (isTextEditingTarget(target) && key !== 'F12') {
    // F5 只在网页地址栏内刷新活动网页，不能波及设置、命令或其他表单。
    if (key !== 'F5' || !target.matches('input[list="lyshell-webbar-history"]')) return false
  }
  return !target.closest('.xterm') || target.closest('[data-pane-id]')?.getAttribute('data-pane-id') === activePaneId
}
