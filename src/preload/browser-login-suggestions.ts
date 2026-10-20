import { loginFieldsFor, type LoginFields } from './browser-login-fields'

interface Account { id: string; username: string }
interface LoginValue { username: string; password: string }
interface PasswordAccess {
  suggestions(): Promise<Account[] | null>
  fill(id: string): Promise<LoginValue | null>
}

/** 隔离世界中的候选列表。网页无法访问封闭 shadow root，也不能合成可信选择事件。 */
export function installLoginSuggestions(access: PasswordAccess): () => void {
  const origin = location.origin
  const zh = navigator.language.startsWith('zh')
  let version = 0
  let host: HTMLDivElement | null = null
  let anchor: HTMLInputElement | null = null
  let buttons: HTMLButtonElement[] = []
  let selecting = false
  let restoringFocus = false
  const restoreFocus = (input: HTMLInputElement) => {
    restoringFocus = true
    try { input.focus() } finally { restoringFocus = false }
  }
  const close = () => {
    version++
    host?.remove()
    host = null
    anchor = null
    buttons = []
  }
  const usable = (input: HTMLInputElement) => input.isConnected && !input.disabled && !input.readOnly &&
    !!input.getClientRects().length && getComputedStyle(input).visibility !== 'hidden'
  const currentFields = (input: HTMLInputElement, fields: LoginFields) => {
    const current = loginFieldsFor(input)
    return location.origin === origin && usable(input) && usable(fields.password) &&
      (!fields.username || usable(fields.username)) && current?.password === fields.password && current.username === fields.username && !fields.password.value
  }
  const show = async (input: HTMLInputElement) => {
    close()
    const fields = loginFieldsFor(input)
    if (!fields || ![fields.username, fields.password].includes(input) || !currentFields(input, fields)) return
    const request = version
    const username = fields.username?.value ?? ''
    try {
      const accounts = await access.suggestions()
      if (request !== version || document.activeElement !== input || !currentFields(input, fields) || !accounts?.length) return
      const matches = accounts.filter(account => !username || account.username.toLocaleLowerCase().startsWith(username.toLocaleLowerCase()))
      if (!matches.length) return
      anchor = input
      host = document.createElement('div')
      // Popover top layer 避免被网页祖先的 overflow、transform 或 z-index 裁切。
      host.setAttribute('popover', 'manual')
      host.style.cssText = 'all:initial;color-scheme:light dark;position:fixed;margin:0;padding:0;border:0;background:transparent;overflow:visible;'
      const root = host.attachShadow({ mode: 'closed' })
      const style = document.createElement('style')
      style.textContent = `
        :host { color-scheme: light dark; }
        .accounts { box-sizing:border-box; max-height:min(240px,calc(100vh - 16px)); overflow:auto; border:1px solid light-dark(#dadce0,#55585e); border-radius:8px; background:light-dark(#fff,#292a2d); color:light-dark(#202124,#e8eaed); font:13px/1.4 'Segoe UI','Microsoft YaHei',sans-serif; scrollbar-color:light-dark(#5f6368,#bdc1c6) transparent; }
        .title { padding:10px 12px 6px; color:light-dark(#5f6368,#bdc1c6); font-size:12px; }
        button { box-sizing:border-box; display:block; width:100%; padding:9px 12px; border:0; background:transparent; color:inherit; text-align:start; font:inherit; cursor:pointer; }
        button:hover, button:focus-visible { background:light-dark(#edf3ef,#3a4941); outline:2px solid light-dark(#37624d,#b1d0ba); outline-offset:-2px; }
        .name { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; unicode-bidi:plaintext; }
        .secret { display:block; color:light-dark(#5f6368,#bdc1c6); font-size:12px; letter-spacing:2px; }
        ::selection { background:light-dark(#edf3ef,#3a4941); }
      `
      const list = document.createElement('div')
      list.className = 'accounts'
      list.setAttribute('role', 'group')
      list.setAttribute('aria-label', zh ? '选择已保存的账号' : 'Choose a saved account')
      const title = document.createElement('div')
      title.className = 'title'
      title.textContent = zh ? '选择已保存的账号' : 'Choose a saved account'
      list.append(title)
      const choose = async (account: Account) => {
        if (selecting || request !== version || !currentFields(input, fields)) return
        selecting = true
        const before = fields.username?.value ?? ''
        try {
          const value = await access.fill(account.id)
          if (request !== version || !value || !currentFields(input, fields) || (fields.username?.value ?? '') !== before) return
          close()
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
          // 先写入两个值，再派发事件，避免框架同步重绘使另一字段失联。
          if (fields.username) setter?.call(fields.username, value.username)
          setter?.call(fields.password, value.password)
          for (const field of [fields.username, fields.password]) if (field) {
            field.dispatchEvent(new Event('input', { bubbles: true }))
            field.dispatchEvent(new Event('change', { bubbles: true }))
          }
          input.focus()
        } catch { /* 后台不可用时保留手动输入 */ }
        finally { selecting = false }
      }
      buttons = matches.map(account => {
        const button = document.createElement('button')
        button.type = 'button'
        const name = document.createElement('span')
        name.className = 'name'
        name.textContent = account.username || (zh ? '无用户名' : 'No username')
        button.title = name.textContent
        const secret = document.createElement('span')
        secret.className = 'secret'
        secret.textContent = '••••••••'
        secret.setAttribute('aria-hidden', 'true')
        button.append(name, secret)
        button.addEventListener('pointerdown', event => { if (event.isTrusted) event.preventDefault() })
        button.addEventListener('click', event => { if (event.isTrusted) { event.preventDefault(); event.stopPropagation(); void choose(account) } })
        list.append(button)
        return button
      })
      root.addEventListener('keydown', event => {
        const key = event as KeyboardEvent
        if (!key.isTrusted || key.isComposing) return
        if (key.key === 'Escape') { key.preventDefault(); key.stopPropagation(); close(); restoreFocus(input) }
        if (key.key === 'ArrowDown' || key.key === 'ArrowUp') {
          key.preventDefault()
          const index = buttons.indexOf(root.activeElement as HTMLButtonElement)
          buttons[(index + (key.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus()
        }
      })
      root.append(style, list)
      const rect = input.getBoundingClientRect()
      const width = Math.min(Math.max(rect.width, 260), Math.max(0, window.innerWidth - 16))
      host.style.width = `${width}px`
      host.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`
      document.documentElement.append(host)
      host.showPopover()
      const height = Math.min(list.getBoundingClientRect().height, 240)
      host.style.top = `${Math.max(8, Math.min(rect.bottom + 4 + height > window.innerHeight - 8 ? rect.top - height - 4 : rect.bottom + 4, window.innerHeight - height - 8))}px`
    } catch { close() }
  }
  const focus = (event: FocusEvent) => {
    if (!event.isTrusted || selecting || restoringFocus) return
    if (event.target === host) return
    if (event.target instanceof HTMLInputElement && navigator.userActivation.isActive) void show(event.target)
    else close()
  }
  const pointer = (event: PointerEvent) => {
    if (!event.isTrusted) return
    if (event.target === host) return
    if (event.target instanceof HTMLInputElement && document.activeElement === event.target) void show(event.target)
    else close()
  }
  const input = (event: Event) => {
    if (event.isTrusted && event.target instanceof HTMLInputElement && document.activeElement === event.target) void show(event.target)
  }
  const key = (event: KeyboardEvent) => {
    if (!event.isTrusted || event.isComposing || !host || event.target !== anchor) return
    if (event.key === 'Escape') { event.preventDefault(); close() }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      ;(event.key === 'ArrowDown' ? buttons[0] : buttons.at(-1))?.focus()
    }
  }
  const blur = (event: Event) => { if (event.target !== host) close() }
  const focusOut = () => { queueMicrotask(() => { if (host && document.activeElement !== anchor && document.activeElement !== host) close() }) }
  document.addEventListener('focusin', focus, true)
  document.addEventListener('focusout', focusOut, true)
  document.addEventListener('pointerdown', pointer, true)
  document.addEventListener('input', input, true)
  document.addEventListener('keydown', key, true)
  document.addEventListener('scroll', blur, true)
  window.addEventListener('resize', blur)
  window.addEventListener('blur', blur)
  return () => {
    close()
    document.removeEventListener('focusin', focus, true)
    document.removeEventListener('focusout', focusOut, true)
    document.removeEventListener('pointerdown', pointer, true)
    document.removeEventListener('input', input, true)
    document.removeEventListener('keydown', key, true)
    document.removeEventListener('scroll', blur, true)
    window.removeEventListener('resize', blur)
    window.removeEventListener('blur', blur)
  }
}
