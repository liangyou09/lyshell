// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WEB_TERMINAL_ATTACH_SCRIPT,
  WEB_TERMINAL_SCAN_SCRIPT,
  WEB_TERMINAL_VALIDATE_SCRIPT
} from './web-terminal'

/**
 * 自动发现脚本的 DOM 行为验证：真实 jsdom 下运行页面模板，确认
 * 只读扫描、自动附着不聚焦、不派发输入事件，且能正确区分终端与普通表单。
 */

const MARK = 'data-lyshell-terminal'
const key = Symbol.for('lyshell.web-terminal.v1')
const state = globalThis as typeof globalThis & { [key: symbol]: unknown }

type ScanOutcome = { terminalCount: number; focused: boolean; href: string }
type AttachOutcome = { ok: boolean; token?: string; href: string; terminals: number; focused: boolean }
type ValidateOutcome = { ok: boolean; focused: boolean; href: string; docToken: string; elementToken: string }

const run = <T>(script: string): T => (0, eval)(script) as T

/** 造一个带 .xterm 根节点的终端；hidden 时根节点尺寸为 0。 */
function makeTerminal(options: { hidden?: boolean; disabled?: boolean } = {}): {
  root: HTMLDivElement
  input: HTMLTextAreaElement
} {
  const root = document.createElement('div')
  root.className = 'xterm'
  const rect = options.hidden ? { width: 0, height: 0 } : { width: 200, height: 120 }
  root.getBoundingClientRect = () => rect as DOMRect
  // jsdom 没有布局，显式提供一个稳定的可见性判定，隐藏用例仍由尺寸决定
  ;(root as unknown as { checkVisibility?: () => boolean }).checkVisibility = () => true
  const input = document.createElement('textarea')
  input.className = 'xterm-helper-textarea'
  input.disabled = options.disabled === true
  root.append(input)
  document.body.append(root)
  return { root, input }
}

const marked = (): number => document.querySelectorAll('[' + MARK + ']').length

afterEach(() => {
  document.body.innerHTML = ''
  document.documentElement.removeAttribute(MARK)
  delete state[key]
  vi.restoreAllMocks()
})

describe('网页终端发现：页面侧只读扫描', () => {
  it('只统计可见、可用的 xterm 输入面，忽略隐藏/禁用/只读与普通表单', () => {
    makeTerminal({ hidden: true })
    makeTerminal({ disabled: true })
    makeTerminal().input.readOnly = true
    const form = document.createElement('form')
    const field = document.createElement('input')
    field.type = 'password'
    form.append(field)
    document.body.append(form)
    const { input } = makeTerminal()

    const result = run<ScanOutcome>(WEB_TERMINAL_SCAN_SCRIPT)
    expect(result).toEqual({ terminalCount: 1, focused: false, href: location.href })
    // 扫描是只读的：不写标记、不移动焦点
    expect(marked()).toBe(0)
    expect(document.activeElement).toBe(document.body)
    expect(input.getAttribute(MARK)).toBeNull()
  })

  it('报告焦点是否落在终端上，且不改变焦点', () => {
    const first = makeTerminal()
    makeTerminal()
    first.input.focus()
    const result = run<ScanOutcome>(WEB_TERMINAL_SCAN_SCRIPT)
    expect(result.terminalCount).toBe(2)
    expect(result.focused).toBe(true)
    expect(document.activeElement).toBe(first.input)
  })

  it('多个终端且焦点不在终端上时不报告 focused', () => {
    makeTerminal()
    makeTerminal()
    const panel = document.createElement('input')
    panel.type = 'text'
    document.body.append(panel)
    panel.focus()
    const result = run<ScanOutcome>(WEB_TERMINAL_SCAN_SCRIPT)
    expect(result.terminalCount).toBe(2)
    expect(result.focused).toBe(false)
    expect(document.activeElement).toBe(panel)
  })
})

describe('网页终端发现：自动附着', () => {
  it('唯一终端即使没有焦点也能标记，且不聚焦、不派发输入事件', () => {
    const { root, input } = makeTerminal()
    const panel = document.createElement('input')
    panel.type = 'text'
    document.body.append(panel)
    panel.focus()

    const events: string[] = []
    const controller = new AbortController()
    for (const type of ['keydown', 'keypress', 'keyup', 'beforeinput', 'input', 'paste']) {
      document.addEventListener(type, event => events.push(event.type), { capture: true, signal: controller.signal })
    }
    const focusSpy = vi.spyOn(HTMLTextAreaElement.prototype, 'focus')
    const result = run<AttachOutcome>(WEB_TERMINAL_ATTACH_SCRIPT)
    controller.abort()

    expect(result.ok).toBe(true)
    expect(result.terminals).toBe(1)
    expect(result.focused).toBe(false)
    expect(result.token).toMatch(/^[0-9a-f]{32}$/)
    expect(document.activeElement).toBe(panel)
    expect(events).toEqual([])
    expect(input.value).toBe('')
    expect(input.getAttribute(MARK)).toBe(result.token)
    expect(root.getAttribute(MARK)).toBe(result.token)
    expect(document.documentElement.getAttribute(MARK)).toBe(result.token)
    expect(focusSpy).not.toHaveBeenCalled()
  })

  it('多个终端且没有焦点时拒绝猜测，不写入任何标记', () => {
    const first = makeTerminal()
    const second = makeTerminal()
    const panel = document.createElement('input')
    panel.type = 'text'
    document.body.append(panel)
    panel.focus()

    const result = run<AttachOutcome>(WEB_TERMINAL_ATTACH_SCRIPT)
    expect(result).toEqual({ ok: false, href: location.href, terminals: 2, focused: false })
    expect(marked()).toBe(0)
    expect(first.input.hasAttribute(MARK)).toBe(false)
    expect(second.input.hasAttribute(MARK)).toBe(false)
    expect(document.activeElement).toBe(panel)
  })

  it('多个终端时只标记焦点所在的那个，且不改变焦点', () => {
    const first = makeTerminal()
    const second = makeTerminal()
    second.input.focus()

    const result = run<AttachOutcome>(WEB_TERMINAL_ATTACH_SCRIPT)
    expect(result.ok).toBe(true)
    expect(result.focused).toBe(true)
    expect(second.input.getAttribute(MARK)).toBe(result.token)
    expect(first.input.hasAttribute(MARK)).toBe(false)
    expect(document.activeElement).toBe(second.input)
  })

  it('附着会清理旧标记，并且不会把普通表单/隐藏终端算作候选', () => {
    const stale = document.createElement('div')
    stale.setAttribute(MARK, 'f'.repeat(32))
    document.body.append(stale)
    makeTerminal({ hidden: true })
    const form = document.createElement('form')
    const textarea = document.createElement('textarea')
    form.append(textarea)
    document.body.append(form)
    const { input } = makeTerminal()

    const result = run<AttachOutcome>(WEB_TERMINAL_ATTACH_SCRIPT)
    expect(result.ok).toBe(true)
    expect(result.terminals).toBe(1)
    expect(stale.hasAttribute(MARK)).toBe(false)
    expect(input.getAttribute(MARK)).toBe(result.token)
    expect(document.querySelectorAll('[' + MARK + ']').length).toBe(3)
  })
})

describe('网页终端发现：旧绑定校验不要求焦点', () => {
  it('工具面板抢走焦点后旧绑定仍然有效', () => {
    const { input } = makeTerminal()
    const attached = run<AttachOutcome>(WEB_TERMINAL_ATTACH_SCRIPT)
    const panel = document.createElement('input')
    panel.type = 'text'
    document.body.append(panel)
    panel.focus()

    const result = run<ValidateOutcome>(WEB_TERMINAL_VALIDATE_SCRIPT)
    expect(result.ok).toBe(true)
    expect(result.focused).toBe(false)
    expect(result.docToken).toBe(attached.token)
    expect(result.elementToken).toBe(attached.token)
    expect(input.hasAttribute(MARK)).toBe(true)
    expect(document.activeElement).toBe(panel)
  })

  it('元素被克隆替换后校验失败', () => {
    const { root, input } = makeTerminal()
    const attached = run<AttachOutcome>(WEB_TERMINAL_ATTACH_SCRIPT)
    expect(attached.token).toBeTruthy()

    // 克隆会带走相同标记，但页面内弱引用仍指向旧元素
    const clone = input.cloneNode(true) as HTMLTextAreaElement
    const cloneRoot = document.createElement('div')
    cloneRoot.className = 'xterm'
    cloneRoot.getBoundingClientRect = () => ({ width: 200, height: 120 }) as DOMRect
    ;(cloneRoot as unknown as { checkVisibility?: () => boolean }).checkVisibility = () => true
    cloneRoot.append(clone)
    document.body.append(cloneRoot)
    root.remove()

    expect(run<ValidateOutcome>(WEB_TERMINAL_VALIDATE_SCRIPT).ok).toBe(false)
  })

  it('终端不可见或标记被改写后校验失败', () => {
    const { root, input } = makeTerminal()
    const attached = run<AttachOutcome>(WEB_TERMINAL_ATTACH_SCRIPT)
    expect(run<ValidateOutcome>(WEB_TERMINAL_VALIDATE_SCRIPT).ok).toBe(true)

    root.getBoundingClientRect = () => ({ width: 0, height: 0 }) as DOMRect
    expect(run<ValidateOutcome>(WEB_TERMINAL_VALIDATE_SCRIPT).ok).toBe(false)

    root.getBoundingClientRect = () => ({ width: 200, height: 120 }) as DOMRect
    input.setAttribute(MARK, 'e'.repeat(32))
    expect(run<ValidateOutcome>(WEB_TERMINAL_VALIDATE_SCRIPT).ok).toBe(false)

    document.documentElement.setAttribute(MARK, 'd'.repeat(32))
    expect(run<ValidateOutcome>(WEB_TERMINAL_VALIDATE_SCRIPT).ok).toBe(false)
    expect(input.getAttribute(MARK)).not.toBe(attached.token)
  })
})
