export interface LoginFields { username?: HTMLInputElement; password: HTMLInputElement }
const knownPasswords = new WeakSet<HTMLInputElement>()

function visible(input: HTMLInputElement): boolean {
  return !input.disabled && !input.readOnly && input.type !== 'hidden' && !!input.getClientRects().length &&
    getComputedStyle(input).visibility !== 'hidden'
}

/** 同时支持原生 form、关联在 form 外的字段，以及常见组件化登录区域。 */
function fieldsWithin(scope: Element): LoginFields | null {
  const inputs = (scope instanceof HTMLFormElement ? Array.from(scope.elements).filter((el): el is HTMLInputElement => el instanceof HTMLInputElement)
    : Array.from(scope.querySelectorAll<HTMLInputElement>('input'))).filter(visible)
  const autocomplete = (input: HTMLInputElement, token: string) => input.autocomplete.split(/\s+/).includes(token)
  if (inputs.some(input => autocomplete(input, 'new-password'))) return null
  const passwords = inputs.filter(input => {
    if (input.type === 'password' || autocomplete(input, 'current-password')) knownPasswords.add(input)
    return knownPasswords.has(input)
  })
  if (passwords.length !== 1) return null
  const password = passwords[0]
  const usernames = inputs.filter(input => input !== password && ['text', 'email', 'tel'].includes(input.type) &&
    !/captcha|verification|verify|one[-_ ]?time|验证码|驗證碼|动态码|otp/i.test([input.name, input.id, input.autocomplete, input.placeholder, input.getAttribute('aria-label')].join(' ')))
  const username = usernames.find(input => autocomplete(input, 'username')) ?? usernames.filter(input => !!(input.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING)).at(-1)
  return { username, password }
}

export function loginFieldsFor(target: Element): LoginFields | null {
  const form = target instanceof HTMLInputElement || target instanceof HTMLButtonElement ? target.form : target.closest('form')
  if (form) return fieldsWithin(form)
  const explicit = target.closest('[role="form"]')
  if (explicit) return fieldsWithin(explicit)
  // 无 form 的页面必须找到同时包含用户名和密码的共同区域，避免把单独的密码
  // 输入框或注册/修改密码的子区域误判成登录表单。
  for (let scope = target.parentElement; scope; scope = scope.parentElement) {
    const fields = fieldsWithin(scope)
    if (fields?.username) return fields
  }
  return null
}

export function loginClickTarget(target: Element): Element | null {
  const button = target.closest('button, input[type="submit"], input[type="image"], [role="button"], a')
  if (!button || button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true') return null
  if (button instanceof HTMLButtonElement && button.type === 'submit' && button.form || button instanceof HTMLInputElement && ['submit', 'image'].includes(button.type) && button.form) return button
  const text = [button.textContent, button.getAttribute('aria-label'), button.getAttribute('title'), button instanceof HTMLInputElement ? button.value : ''].join(' ')
  return /\b(log\s*in|sign\s*in|login|signin|continue|next)\b|登[录錄陆陸入]|继续|下一步/i.test(text) ? button : null
}
