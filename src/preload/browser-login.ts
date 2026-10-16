import { ipcRenderer } from 'electron'
import { loginClickTarget, loginFieldsFor, type LoginFields } from './browser-login-fields'

// 不暴露 contextBridge。仅顶层文档的登录区域可保存/填充密码。
if (window.top === window) {
  const origin = location.origin
  let filling = false
  let lastCapture = 0
  const capture = (fields: LoginFields | null): void => {
    if (!fields || !fields.password.value || location.origin !== origin || Date.now() - lastCapture < 500) return
    lastCapture = Date.now()
    ipcRenderer.send('browser:password-capture', { origin, username: fields.username?.value ?? '', password: fields.password.value })
  }
  const setValue = (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }
  // 用户聚焦登录表单才取密码，避免后台页面或隐藏表单自动提取。
  document.addEventListener('focusin', async event => {
    if (!event.isTrusted || !navigator.userActivation.isActive || filling || !(event.target instanceof HTMLInputElement)) return
    const fields = loginFieldsFor(event.target)
    if (!fields || ![fields.username, fields.password].includes(event.target) || fields.password.value || !fields.password.getClientRects().length || getComputedStyle(fields.password).visibility === 'hidden') return
    filling = true
    try {
      const value = await ipcRenderer.invoke('browser:password-fill') as { username: string; password: string } | null
      if (!value || location.origin !== origin || !fields.password.isConnected || fields.password.value || fields.username?.value && fields.username.value !== value.username) return
      if (fields.username && !fields.username.value) setValue(fields.username, value.username)
      setValue(fields.password, value.password)
    } catch { /* 后台不可用时保留普通网页输入 */ }
    finally { filling = false }
  }, true)
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
