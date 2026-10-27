/** xterm frame 内输入。命令只经 JSON 序列化成为固定函数的数据参数。 */
export const WEB_TERMINAL_INPUT_PREFIX = '/* lyshell-web-terminal-input */'
const INPUT = String.raw`function(payload) {
  const state = globalThis[Symbol.for('lyshell.web-terminal.v1')]
  const target = state && state.target.deref()
  const root = state && state.root.deref()
  let partial = false
  const valid = () => Date.now() < payload.expires && location.href === payload.href &&
    state && state.token === payload.token && target && root && target.isConnected && root.isConnected &&
    target.tagName === 'TEXTAREA' && !target.disabled && !target.readOnly &&
    target.closest('.xterm') === root && root.getBoundingClientRect().width > 1 && root.getBoundingClientRect().height > 1 &&
    (!root.checkVisibility || root.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) &&
    document.documentElement.getAttribute('data-lyshell-terminal') === payload.token &&
    target.getAttribute('data-lyshell-terminal') === payload.token
  if (!valid()) return {ok:false,partial:false}
  target.focus()
  if (document.activeElement !== target || !valid()) return {ok:false,partial:false}
  if (payload.text) {
    const data = new DataTransfer()
    data.setData('text/plain', payload.text)
    partial = true
    target.dispatchEvent(new ClipboardEvent('paste', {clipboardData:data,bubbles:true,cancelable:true}))
  }
  if (!valid() || document.activeElement !== target) return {ok:false,partial}
  if (payload.enter) {
    partial = true
    target.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true}))
    target.dispatchEvent(new KeyboardEvent('keyup', {key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true}))
  }
  return {ok:true,partial}
}`
export function webTerminalInputScript(payload: { text: string; enter: boolean; token: string; href: string; expires: number }): string {
  return `${WEB_TERMINAL_INPUT_PREFIX}(${INPUT})(\n${JSON.stringify(payload)}\n)`
}

/** 迟到的释放只清理旧 token，不能撤掉后来建立的绑定。 */
export function webTerminalClearScript(token: string): string {
  return `((token) => {
    const key = Symbol.for('lyshell.web-terminal.v1')
    if (globalThis[key]?.token !== token) return false
    delete globalThis[key]
    for (const node of document.querySelectorAll('[data-lyshell-terminal]')) {
      if (node.getAttribute('data-lyshell-terminal') === token) node.removeAttribute('data-lyshell-terminal')
    }
    return true
  })(${JSON.stringify(token)})`
}
