import { ipcRenderer } from 'electron'
import { loginClickTarget, loginFieldsFor, type LoginFields } from './browser-login-fields'
import { installLoginSuggestions } from './browser-login-suggestions'

// 不暴露 contextBridge。仅顶层文档的登录区域可保存/填充密码。
if (window.top === window) {
  const origin = location.origin
  let lastCapture = 0
  const capture = (fields: LoginFields | null): void => {
    if (!fields || !fields.password.value || location.origin !== origin || Date.now() - lastCapture < 500) return
    lastCapture = Date.now()
    ipcRenderer.send('browser:password-capture', { origin, username: fields.username?.value ?? '', password: fields.password.value })
  }
  installLoginSuggestions({
    suggestions: () => ipcRenderer.invoke('browser:password-fill', { kind: 'suggestions' }),
    fill: id => ipcRenderer.invoke('browser:password-fill', { kind: 'fill', id })
  })
  document.addEventListener('submit', event => {
    if (!event.isTrusted || !(event.target instanceof HTMLFormElement) || location.origin !== origin) return
    capture(loginFieldsFor(event.target))
  }, true)
  // Vue/React 登录按钮常用 type=button + click/AJAX，不会产生原生 submit。
  // 在捕获阶段读取字段，页面的处理函数即使清空输入或切换路由也不会漏掉。
  document.addEventListener('click', event => {
    if (!event.isTrusted || !(event.target instanceof Element)) return
    const button = loginClickTarget(event.target)
    if (button) capture(loginFieldsFor(button))
  }, true)
  document.addEventListener('keydown', event => {
    if (!event.isTrusted || event.key !== 'Enter' || event.isComposing || event.ctrlKey || event.altKey || event.metaKey || !(event.target instanceof HTMLInputElement)) return
    const fields = loginFieldsFor(event.target)
    if (fields) capture(fields)
  }, true)
}
