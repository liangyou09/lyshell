import { ipcRenderer } from 'electron'

// 不暴露 contextBridge。仅顶层文档的标准登录表单可保存/填充密码。
if (window.top === window) {
  const origin = location.origin
  let filling = false
  const loginFields = (form: HTMLFormElement) => {
    const passwords = Array.from(form.querySelectorAll<HTMLInputElement>('input[type="password"]')).filter(el => !el.disabled && el.autocomplete !== 'new-password')
    if (passwords.length !== 1 || form.querySelector('input[autocomplete="new-password"]')) return null
    const password = passwords[0]
    const inputs = Array.from(form.querySelectorAll<HTMLInputElement>('input')).filter(el => !el.disabled && !el.readOnly && ['text', 'email', 'tel'].includes(el.type))
    const username = inputs.find(el => el.autocomplete === 'username') ?? inputs.filter(el => !!(el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING)).at(-1)
    return { username, password }
  }
  const setValue = (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }
  // 用户聚焦登录表单才取密码，避免后台页面或隐藏表单自动提取。
  document.addEventListener('focusin', async event => {
    if (!event.isTrusted || !navigator.userActivation.isActive || filling || !(event.target instanceof HTMLInputElement) || !event.target.form) return
    const fields = loginFields(event.target.form)
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
    const fields = loginFields(event.target)
    if (!fields || !fields.password.value) return
    ipcRenderer.send('browser:password-capture', { origin, username: fields.username?.value ?? '', password: fields.password.value })
  }, true)
}
