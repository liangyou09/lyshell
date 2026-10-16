// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loginClickTarget, loginFieldsFor } from './browser-login-fields'

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
    return (this.closest('[hidden], [style*="display: none"]') ? [] : [{}]) as unknown as DOMRectList
  })
})
afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks() })
function element(selector: string): HTMLElement { return document.querySelector<HTMLElement>(selector)! }

describe('component login form detection', () => {
  it('captures the Element UI click login form and ignores the captcha field', () => {
    document.body.innerHTML = `<form class="el-form">
      <div><input id="username" autocomplete="off"></div>
      <div><input id="password" type="password"></div>
      <div><input id="captcha" placeholder="请输入验证码"></div>
      <button type="button"><span>登录</span></button>
    </form>`
    const button = loginClickTarget(element('button span'))!
    expect(button).toBe(element('button'))
    expect(loginFieldsFor(button)).toEqual({ username: element('#username'), password: element('#password') })
    expect(loginFieldsFor(element('#captcha'))).toEqual(loginFieldsFor(button))
  })

  it('supports a component login region without a native form', () => {
    document.body.innerHTML = `<main><section><div><input id="username" type="email"></div>
      <div><input id="password" type="password"></div><button type="button">Sign in</button></section></main>`
    expect(loginFieldsFor(element('button'))).toEqual({ username: element('#username'), password: element('#password') })
    expect(loginFieldsFor(element('#password'))).toEqual(loginFieldsFor(element('button')))
  })

  it('uses the native form association for fields outside the form', () => {
    document.body.innerHTML = `<form id="login"></form><input id="username" form="login" autocomplete="username">
      <input id="password" form="login" type="password"><button form="login">Go</button>`
    expect(loginFieldsFor(element('button'))).toEqual({ username: element('#username'), password: element('#password') })
    expect(loginClickTarget(element('button'))).toBe(element('button'))
    expect(loginFieldsFor(element('form'))).toEqual(loginFieldsFor(element('button')))
  })

  it('prefers the explicit username over intervening captcha fields', () => {
    document.body.innerHTML = `<form><input id="username" autocomplete="section-login username">
      <input id="captcha" name="verificationCode"><input id="password" type="password"></form>`
    expect(loginFieldsFor(element('#password'))?.username).toBe(element('#username'))
  })

  it('does not let invisible registration fields interfere with a visible login', () => {
    document.body.innerHTML = `<form><input id="username"><input id="password" type="password">
      <div hidden><input type="password" autocomplete="new-password"></div></form>`
    expect(loginFieldsFor(element('form'))?.password).toBe(element('#password'))
  })

  it('keeps a known password field when the site toggles password visibility', () => {
    document.body.innerHTML = `<form><input id="username"><input id="password" type="password"></form>`
    const password = element('#password') as HTMLInputElement
    expect(loginFieldsFor(password)?.password).toBe(password)
    password.type = 'text'
    expect(loginFieldsFor(element('form'))?.password).toBe(password)
  })

  it('rejects registration and password-change forms', () => {
    document.body.innerHTML = `<form><input autocomplete="username"><input type="password">
      <input type="password" autocomplete="new-password"><button>Continue</button></form>`
    expect(loginFieldsFor(element('button'))).toBeNull()
    element('[autocomplete="new-password"]').removeAttribute('autocomplete')
    expect(loginFieldsFor(element('button'))).toBeNull()
  })

  it('does not cross an explicit form boundary looking for a password', () => {
    document.body.innerHTML = `<form><input id="username"><input type="password"></form>
      <form><input name="search"><button type="button">Next</button></form>`
    expect(loginFieldsFor(element('button'))).toBeNull()
  })

  it('requires a username for unmarked component regions', () => {
    document.body.innerHTML = '<div><input type="password"><button type="button">Continue</button></div>'
    expect(loginFieldsFor(element('button'))).toBeNull()
  })

  it.each(['显示密码', '刷新验证码', '取消', 'Register'])('ignores unrelated action %s', text => {
    document.body.innerHTML = `<form><button type="button"><span>${text}</span></button></form>`
    expect(loginClickTarget(element('span'))).toBeNull()
  })

  it.each(['disabled', 'aria-disabled="true"'])('ignores disabled login buttons: %s', disabled => {
    document.body.innerHTML = `<button ${disabled}>登录</button>`
    expect(loginClickTarget(element('button'))).toBeNull()
  })
})
