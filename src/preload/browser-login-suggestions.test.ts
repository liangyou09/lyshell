// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installLoginSuggestions } from './browser-login-suggestions'

type Handler = EventListenerOrEventListenerObject
let handlers: Map<EventTarget, Map<string, Handler[]>>
let roots: ShadowRoot[]
let dispose: (() => void) | undefined
const accounts = [{ id: 'alice-id', username: 'alice' }, { id: 'bob-id', username: 'bob' }]
const access = { suggestions: vi.fn(), fill: vi.fn() }
function field(id: string): HTMLInputElement { return document.getElementById(id) as HTMLInputElement }
async function emit(target: EventTarget, type: string, properties: Record<string, unknown> = {}) {
  const event = { isTrusted: true, target, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...properties } as unknown as Event
  for (const handler of handlers.get(target)?.get(type) ?? []) {
    if (typeof handler === 'function') handler.call(target, event)
    else handler.handleEvent(event)
  }
  await new Promise(resolve => setTimeout(resolve, 0))
  return event
}
async function focus(id = 'u') {
  const input = field(id)
  input.focus()
  await emit(document, 'focusin', { target: input })
}
function buttons(): HTMLButtonElement[] { return Array.from(roots.at(-1)!.querySelectorAll('button')) }
beforeEach(() => {
  vi.clearAllMocks()
  handlers = new Map()
  roots = []
  const add = EventTarget.prototype.addEventListener
  vi.spyOn(EventTarget.prototype, 'addEventListener').mockImplementation(function (this: EventTarget, type, handler, options) {
    if (handler) {
      const events = handlers.get(this) ?? new Map<string, Handler[]>()
      events.set(type, [...(events.get(type) ?? []), handler])
      handlers.set(this, events)
    }
    add.call(this, type, handler, options)
  })
  const attach = HTMLElement.prototype.attachShadow
  vi.spyOn(HTMLElement.prototype, 'attachShadow').mockImplementation(function (this: HTMLElement, options) {
    const root = attach.call(this, options)
    roots.push(root)
    return root
  })
  Object.defineProperty(HTMLElement.prototype, 'showPopover', { configurable: true, value: vi.fn() })
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList)
  Object.defineProperty(navigator, 'userActivation', { configurable: true, value: { isActive: true } })
  document.body.innerHTML = '<form><input id="u" autocomplete="username"><input id="p" type="password"><button>Sign in</button></form><input id="other">'
  access.suggestions.mockResolvedValue(accounts)
  access.fill.mockImplementation(async (id: string) => ({ username: id === 'bob-id' ? 'bob' : 'alice', password: 'fixture-secret' }))
  dispose = installLoginSuggestions(access)
})
afterEach(() => { dispose?.(); document.body.innerHTML = ''; vi.restoreAllMocks() })

describe('explicit saved account selection', () => {
  it('focus only offers metadata, even for one saved account; a trusted click fills the chosen account', async () => {
    access.suggestions.mockResolvedValue([accounts[1]])
    await focus()
    expect(buttons()).toHaveLength(1)
    expect(field('u').value).toBe('')
    expect(field('p').value).toBe('')
    expect(access.fill).not.toHaveBeenCalled()
    expect(roots[0].textContent).not.toContain('fixture-secret')
    expect(roots[0].host.shadowRoot).toBeNull()
    await emit(buttons()[0], 'click', { isTrusted: false })
    expect(access.fill).not.toHaveBeenCalled()
    await emit(buttons()[0], 'click')
    expect(access.fill).toHaveBeenCalledWith('bob-id')
    expect(field('u').value).toBe('bob')
    expect(field('p').value).toBe('fixture-secret')
    expect(document.querySelector('[popover]')).toBeNull()
  })
  it('lets arrows focus an account; Escape restores field focus without reopening or filling', async () => {
    await focus()
    const root = roots.at(-1)!
    await emit(document, 'keydown', { target: field('u'), key: 'ArrowDown' })
    expect(root.activeElement).toBe(buttons()[0])
    await emit(root, 'keydown', { key: 'ArrowDown' })
    expect(root.activeElement).toBe(buttons()[1])
    await emit(root, 'keydown', { key: 'Escape' })
    expect(document.activeElement).toBe(field('u'))
    expect(document.querySelector('[popover]')).toBeNull()
    expect(access.fill).not.toHaveBeenCalled()
  })
  it('filters usernames and dismisses on outside click without reading a password', async () => {
    field('u').value = 'bo'
    await focus()
    expect(buttons().map(button => button.title)).toEqual(['bob'])
    await emit(document, 'pointerdown', { target: field('other') })
    expect(document.querySelector('[popover]')).toBeNull()
    expect(access.fill).not.toHaveBeenCalled()
  })
  it('discards delayed suggestions when focus moves away', async () => {
    let resolve!: (value: typeof accounts) => void
    access.suggestions.mockImplementation(() => new Promise(r => { resolve = r }))
    await focus()
    await focus('other')
    resolve(accounts)
    await new Promise(r => setTimeout(r, 0))
    expect(document.querySelector('[popover]')).toBeNull()
  })
  it.each(['password', 'username', 'removed', 'dismissed'])('discards a pending fill after %s changes', async change => {
    await focus()
    let resolve!: (value: { username: string; password: string }) => void
    access.fill.mockImplementation(() => new Promise(r => { resolve = r }))
    await emit(buttons()[1], 'click')
    if (change === 'password') field('p').value = 'manual'
    if (change === 'username') field('u').value = 'manual'
    if (change === 'removed') field('p').remove()
    if (change === 'dismissed') await emit(document, 'pointerdown', { target: document.body })
    resolve({ username: 'bob', password: 'fixture-secret' })
    await new Promise(r => setTimeout(r, 0))
    expect(document.querySelector<HTMLInputElement>('#p')?.value).not.toBe('fixture-secret')
  })
  it('leaves typed passwords, registration forms, and untrusted focus alone', async () => {
    await emit(document, 'focusin', { target: field('u'), isTrusted: false })
    expect(access.suggestions).not.toHaveBeenCalled()
    field('p').value = 'manual'
    await focus()
    expect(access.suggestions).not.toHaveBeenCalled()
    field('p').value = ''
    field('p').autocomplete = 'new-password'
    await focus()
    expect(access.suggestions).not.toHaveBeenCalled()
  })
})
