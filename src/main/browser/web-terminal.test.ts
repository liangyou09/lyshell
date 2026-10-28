import { EventEmitter } from 'events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { WebTerminalRequest } from '@shared/web-terminal'
import { WEB_TERMINAL_INPUT_PREFIX } from './web-terminal-input'

const mocks = vi.hoisted(() => ({
  browser: {},
  contents: new Map<number, unknown>()
}))

vi.mock('electron', () => ({
  session: { fromPartition: () => mocks.browser },
  webContents: { fromId: (id: number) => mocks.contents.get(id) }
}))

const {
  WEB_TERMINAL_ATTACH_SCRIPT,
  WEB_TERMINAL_CHECK_SCRIPT,
  WEB_TERMINAL_MAX_FRAMES,
  WEB_TERMINAL_PROBE_SCRIPT,
  WEB_TERMINAL_SCAN_SCRIPT,
  WEB_TERMINAL_STAMP_SCRIPT,
  WEB_TERMINAL_VALIDATE_SCRIPT,
  webTerminalRequest
} = await import('./web-terminal')

const never = (): Promise<unknown> => new Promise<unknown>(() => undefined)

let nextId = 100

class FakeFrame {
  page?: FakePage
  inputCount = 0
  readonly frameTreeNodeId: number
  readonly routingId: number
  readonly processId = 1
  url: string
  destroyed = false
  /** 本帧 activeElement 是否落在可见的 xterm 输入面上 */
  terminal = false
  /** .xterm 根节点不可见 */
  hidden = false
  docToken: string | undefined
  elementToken: string | undefined
  focused = false
  executed: string[] = []
  gestures: boolean[] = []
  onAttach?: () => void
  probeCount = 0
  stampCount = 0
  checkCount = 0
  scanCount = 0
  attachCount = 0
  validateCount = 0
  /** 覆盖 SCAN 返回的终端数量；null 时按 terminal/hidden 推导 */
  scanTerminals: number | null = null
  /** 覆盖 SCAN 返回的 focused；null 时按 focused/terminal/hidden 推导 */
  scanFocused: boolean | null = null
  hangProbe = false
  hangStamp = false
  hangCheck = false
  hangScan = false
  hangAttach = false
  hangValidate = false
  holdCheck = false
  private held: ((value: unknown) => void) | null = null
  private seed = 0

  constructor(id: number, url = 'https://bastion.example/ssh') {
    this.frameTreeNodeId = id
    this.routingId = id
    this.url = url
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  releaseCheck(): void {
    const held = this.held
    this.held = null
    if (held) held(this.checkPayload())
  }

  executeJavaScript = (script: string, userGesture = false): Promise<unknown> => {
    this.executed.push(script)
    this.gestures.push(userGesture)
    if (script === WEB_TERMINAL_PROBE_SCRIPT) {
      this.probeCount++
      if (this.hangProbe) return never()
      return Promise.resolve({ terminal: this.terminal && !this.hidden, href: this.url, marked: !!this.docToken })
    }
    if (script === WEB_TERMINAL_STAMP_SCRIPT) {
      this.stampCount++
      if (this.hangStamp) return never()
      if (!this.terminal || this.hidden) return Promise.resolve({ ok: false, href: this.url })
      this.seed += 1
      const token = this.seed.toString(16).padStart(32, '0')
      this.docToken = token
      this.elementToken = token
      this.focused = true
      return Promise.resolve({ ok: true, token, href: this.url, terminals: 1 })
    }
    if (script === WEB_TERMINAL_CHECK_SCRIPT) {
      this.checkCount++
      if (this.hangCheck) return never()
      if (this.holdCheck) {
        return new Promise<unknown>(resolve => {
          this.held = resolve
        })
      }
      return Promise.resolve(this.checkPayload())
    }
    if (script === WEB_TERMINAL_SCAN_SCRIPT) {
      this.scanCount++
      if (this.hangScan) return never()
      const terminalCount = this.scanTerminals ?? (this.terminal && !this.hidden ? 1 : 0)
      const focused = this.scanFocused ?? (this.focused && this.terminal && !this.hidden)
      return Promise.resolve({ terminalCount, focused, href: this.url })
    }
    if (script === WEB_TERMINAL_VALIDATE_SCRIPT) {
      this.validateCount++
      if (this.hangValidate) return never()
      const ok = !!this.docToken && this.elementToken === this.docToken && this.terminal && !this.hidden
      return Promise.resolve({
        ok,
        focused: ok && this.focused,
        href: this.url,
        docToken: this.docToken ?? '',
        elementToken: this.elementToken ?? ''
      })
    }
    if (script === WEB_TERMINAL_ATTACH_SCRIPT) {
      this.attachCount++
      this.onAttach?.()
      if (this.hangAttach) return never()
      if (!this.terminal || this.hidden) {
        return Promise.resolve({ ok: false, href: this.url, terminals: 0, focused: false })
      }
      this.seed += 1
      const token = this.seed.toString(16).padStart(32, '0')
      this.docToken = token
      this.elementToken = token
      // 关键：自动附着绝不改变焦点
      return Promise.resolve({
        ok: true,
        token,
        href: this.url,
        terminals: this.scanTerminals ?? 1,
        focused: this.scanFocused ?? this.focused
      })
    }
    if (script.startsWith('((token) =>')) {
      this.docToken = undefined
      this.elementToken = undefined
      return Promise.resolve(true)
    }
    if (script.startsWith(WEB_TERMINAL_INPUT_PREFIX)) {
      this.inputCount++
      const payload = JSON.parse(script.split('\n').at(-2)!) as { text: string; enter: boolean; token: string }
      if (this.docToken !== payload.token || this.elementToken !== payload.token) return Promise.resolve({ok:false,partial:false})
      const page = this.page!
      return (async () => {
        if (payload.text) {
          page.events.push(`insert:${payload.text}`)
          if (page.onInsert) await page.onInsert()
          if (page.failInsert) throw new Error('input failed')
        }
        if (page.url !== 'https://bastion.example/ssh' || this.elementToken !== payload.token) return {ok:false,partial:true}
        if (payload.enter) page.events.push('key:keyDown:Return', 'key:keyUp:Return')
        return {ok:true}
      })()
    }
    return Promise.reject(new Error(`unexpected script: ${script.slice(0, 40)}`))
  }

  private checkPayload(): unknown {
    if (!this.docToken || !this.elementToken || this.hidden) {
      return { ok: false, docToken: this.docToken ?? '', elementToken: this.elementToken ?? '', href: this.url }
    }
    this.focused = true
    return { ok: true, docToken: this.docToken, elementToken: this.elementToken, href: this.url }
  }
}

class FakePage extends EventEmitter {
  readonly id = nextId++
  hostWebContents: unknown
  session: object = mocks.browser
  type = 'webview'
  url = 'https://bastion.example/ssh'
  destroyed = false
  frames: FakeFrame[] = []
  focused: FakeFrame | null = null
  events: string[] = []
  onInsert: (() => void | Promise<void>) | null = null
  failInsert = false
  insertText = vi.fn(async (text: string): Promise<void> => {
    this.events.push(`insert:${text}`)
    if (this.onInsert) await this.onInsert()
    if (this.failInsert) throw new Error('insert failed')
  })
  sendInputEvent = vi.fn((event: { type: string; keyCode?: string }): void => {
    this.events.push(`key:${event.type}:${event.keyCode ?? ''}`)
  })

  getType(): string {
    return this.type
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  getURL(): string {
    return this.url
  }

  get mainFrame(): { framesInSubtree: FakeFrame[] } {
    return { framesInSubtree: this.frames }
  }

  get focusedFrame(): FakeFrame | null {
    return this.focused
  }

  get probeCount(): number {
    return this.frames.reduce((total, frame) => total + frame.probeCount, 0)
  }

  get stampCount(): number {
    return this.frames.reduce((total, frame) => total + frame.stampCount, 0)
  }

  get scanCount(): number {
    return this.frames.reduce((total, frame) => total + frame.scanCount, 0)
  }

  get attachCount(): number {
    return this.frames.reduce((total, frame) => total + frame.attachCount, 0)
  }

  get validateCount(): number {
    return this.frames.reduce((total, frame) => total + frame.validateCount, 0)
  }
}

class FakeOwner extends EventEmitter {
  readonly id = nextId++
  type = 'window'
  destroyed = false

  getType(): string {
    return this.type
  }

  isDestroyed(): boolean {
    return this.destroyed
  }
}

const wc = (value: object): WebContents => value as unknown as WebContents
const request = (value: object): WebTerminalRequest => value as unknown as WebTerminalRequest

function createPage(owner: object, frameCount = 1): FakePage {
  const page = new FakePage()
  page.hostWebContents = owner
  for (let index = 0; index < frameCount; index++) { const frame = new FakeFrame(index + 1); frame.page = page; page.frames.push(frame) }
  page.focused = page.frames[0] ?? null
  mocks.contents.set(page.id, page)
  return page
}

function createOwner(): FakeOwner {
  const owner = new FakeOwner()
  mocks.contents.set(owner.id, owner)
  return owner
}

/** 标记第一帧为可见终端并完成绑定，返回 bindingId。 */
async function bindTerminal(owner: FakeOwner, page: FakePage): Promise<string> {
  const frame = page.frames[0]
  frame.terminal = true
  page.focused = frame
  const result = await webTerminalRequest(wc(owner), { kind: 'bind', pageId: page.id })
  expect(result.success).toBe(true)
  expect(result.bindingId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  return result.bindingId as string
}

const send = (owner: object, pageId: number, bindingId: string, text = 'ls', enter = false) =>
  webTerminalRequest(wc(owner), { kind: 'send', pageId, bindingId, text, enter })

const discover = (owner: object, pageId: number) =>
  webTerminalRequest(wc(owner), { kind: 'discover', pageId })

afterEach(() => {
  vi.useRealTimers()
  mocks.contents.clear()
})

describe('网页终端：归属与请求校验', () => {
  it('只接受本窗口托管、webbar 分区的 http(s) webview', async () => {
    const owner = createOwner()
    const other = createOwner()
    const unknown = await webTerminalRequest(wc(owner), { kind: 'bind', pageId: 9999 })
    expect(unknown).toEqual({ success: false, error: 'unavailable' })

    const foreign = createPage(other)
    expect(await webTerminalRequest(wc(owner), { kind: 'bind', pageId: foreign.id }))
      .toEqual({ success: false, error: 'denied' })

    const page = createPage(owner)
    page.type = 'window'
    expect(await webTerminalRequest(wc(owner), { kind: 'bind', pageId: page.id }))
      .toEqual({ success: false, error: 'denied' })

    page.type = 'webview'
    page.session = {}
    expect(await webTerminalRequest(wc(owner), { kind: 'bind', pageId: page.id }))
      .toEqual({ success: false, error: 'denied' })

    page.session = mocks.browser
    page.url = 'about:blank'
    expect(await webTerminalRequest(wc(owner), { kind: 'bind', pageId: page.id }))
      .toEqual({ success: false, error: 'unavailable' })

    page.url = 'file:///etc/passwd'
    expect(await webTerminalRequest(wc(owner), { kind: 'bind', pageId: page.id }))
      .toEqual({ success: false, error: 'unavailable' })

    page.url = 'https://bastion.example/ssh'
    page.destroyed = true
    expect(await webTerminalRequest(wc(owner), { kind: 'bind', pageId: page.id }))
      .toEqual({ success: false, error: 'unavailable' })

    expect(page.probeCount).toBe(0)
  })

  it('拒绝非窗口宿主、自身 pageId 和已销毁的窗口', async () => {
    const owner = createOwner()
    const page = createPage(owner)
    owner.type = 'webview'
    expect(await webTerminalRequest(wc(owner), { kind: 'bind', pageId: page.id }))
      .toEqual({ success: false, error: 'denied' })
    owner.type = 'window'
    expect(await webTerminalRequest(wc(owner), { kind: 'bind', pageId: owner.id }))
      .toEqual({ success: false, error: 'denied' })
    owner.destroyed = true
    expect(await webTerminalRequest(wc(owner), { kind: 'bind', pageId: page.id }))
      .toEqual({ success: false, error: 'unavailable' })
    expect(page.probeCount).toBe(0)
  })

  it('非法请求在触达网页前就被拒绝', async () => {
    const owner = createOwner()
    const page = createPage(owner)
    page.frames[0].terminal = true
    const bindingId = await bindTerminal(owner, page)
    page.frames[0].checkCount = 0

    const invalid = [
      { kind: 'bind', pageId: 0 },
      { kind: 'bind', pageId: page.id, extra: true },
      { kind: 'send', pageId: page.id, bindingId, text: 'rm -rf /\x1b[2J', enter: true },
      { kind: 'send', pageId: page.id, bindingId: 'not-a-uuid', text: 'ls', enter: true },
      { kind: 'send', pageId: page.id, bindingId, text: '', enter: false },
      { kind: 'release', pageId: page.id }
    ]
    for (const value of invalid) {
      expect(await webTerminalRequest(wc(owner), request(value)), JSON.stringify(value))
        .toEqual({ success: false, error: 'invalid' })
    }
    expect(page.frames[0].checkCount).toBe(0)
    expect(page.insertText).not.toHaveBeenCalled()
  })
})

describe('网页终端：跨 frame 识别与绑定', () => {
  it('选择用户最后点选的终端所在 frame，并在该 frame 内写入随机标记', async () => {
    const owner = createOwner()
    const page = createPage(owner, 3)
    const [main, shell, popup] = page.frames
    main.terminal = false
    shell.terminal = true
    shell.hidden = true
    popup.terminal = true
    page.focused = popup

    const result = await webTerminalRequest(wc(owner), { kind: 'bind', pageId: page.id })
    expect(result.success).toBe(true)
    expect(result.url).toBe(page.url)
    expect(page.probeCount).toBe(3)
    expect(main.stampCount).toBe(0)
    expect(shell.stampCount).toBe(0)
    expect(popup.stampCount).toBe(1)
    expect(popup.docToken).toBe(popup.elementToken)
    expect(popup.focused).toBe(true)
    // 页面侧脚本必须是固定模板，附带信息一律在页面内生成
    expect(popup.executed).toContain(WEB_TERMINAL_STAMP_SCRIPT)
    expect(WEB_TERMINAL_PROBE_SCRIPT).not.toContain('hasFocus')
    expect(WEB_TERMINAL_STAMP_SCRIPT).not.toContain('hasFocus')
  })

  it('唯一候选终端即使没有焦点帧也接受', async () => {
    const owner = createOwner()
    const page = createPage(owner, 2)
    page.frames[1].terminal = true
    page.focused = null
    const result = await webTerminalRequest(wc(owner), { kind: 'bind', pageId: page.id })
    expect(result.success).toBe(true)
  })

  it('多个 frame 都有终端却无法确定最后焦点时拒绝猜测', async () => {
    const owner = createOwner()
    const page = createPage(owner, 2)
    page.frames[0].terminal = true
    page.frames[1].terminal = true
    page.focused = null
    expect(await webTerminalRequest(wc(owner), { kind: 'bind', pageId: page.id }))
      .toEqual({ success: false, error: 'unsupported' })
    expect(page.stampCount).toBe(0)
  })

  it('最后焦点不在终端上时不把其它 frame 的终端当作目标', async () => {
    const owner = createOwner()
    const page = createPage(owner, 2)
    page.frames[0].terminal = true
    page.frames[1].terminal = false
    page.focused = page.frames[1]
    expect(await webTerminalRequest(wc(owner), { kind: 'bind', pageId: page.id }))
      .toEqual({ success: false, error: 'unsupported' })
  })

  it('普通表单/密码框不被识别为终端', async () => {
    const owner = createOwner()
    const page = createPage(owner)
    page.frames[0].terminal = false
    expect(await webTerminalRequest(wc(owner), { kind: 'bind', pageId: page.id }))
      .toEqual({ success: false, error: 'unsupported' })
    expect(page.insertText).not.toHaveBeenCalled()
  })

  it('探测帧数量有上限，避免超大 iframe 页面产生无界任务', async () => {
    const owner = createOwner()
    const page = createPage(owner, WEB_TERMINAL_MAX_FRAMES + 12)
    page.focused = page.frames[0]
    expect(await webTerminalRequest(wc(owner), { kind: 'bind', pageId: page.id }))
      .toEqual({ success: false, error: 'unsupported' })
    expect(page.probeCount).toBe(WEB_TERMINAL_MAX_FRAMES)
  })

  it('探测超时后不写入标记，也不留下可用绑定', async () => {
    vi.useFakeTimers()
    const owner = createOwner()
    const page = createPage(owner)
    page.frames[0].terminal = true
    page.frames[0].hangProbe = true
    const pending = webTerminalRequest(wc(owner), { kind: 'bind', pageId: page.id })
    await vi.advanceTimersByTimeAsync(2000)
    expect(await pending).toEqual({ success: false, error: 'unsupported' })
    expect(page.stampCount).toBe(0)
    expect(page.listenerCount('did-start-navigation')).toBe(0)
  })
})

describe('网页终端：绑定失效', () => {
  it('主框架导航后立即失效并停止输入', async () => {
    const owner = createOwner()
    const page = createPage(owner)
    const bindingId = await bindTerminal(owner, page)
    page.emit('did-start-navigation', { isMainFrame: true, url: 'https://bastion.example/other' })
    expect(await send(owner, page.id, bindingId)).toEqual({ success: false, error: 'stale' })
    expect(page.insertText).not.toHaveBeenCalled()
    expect(page.listenerCount('did-start-navigation')).toBe(0)
  })

  it('兼容旧版位置参数的主框架导航事件', async () => {
    const owner = createOwner()
    const page = createPage(owner)
    const bindingId = await bindTerminal(owner, page)
    page.emit('did-start-navigation', {}, 'https://bastion.example/other', false, true)
    expect(await send(owner, page.id, bindingId)).toEqual({ success: false, error: 'stale' })
  })

  it('SPA 的页内导航也要求重新绑定', async () => {
    const owner = createOwner()
    const page = createPage(owner)
    const bindingId = await bindTerminal(owner, page)
    page.emit('did-navigate-in-page', {}, 'https://bastion.example/ssh#session/2', true)
    expect(await send(owner, page.id, bindingId)).toEqual({ success: false, error: 'stale' })
  })

  it('绑定 frame 自身重载会失效，其它子 frame 导航不影响', async () => {
    const owner = createOwner()
    const page = createPage(owner, 2)
    const bindingId = await bindTerminal(owner, page)
    page.emit('did-start-navigation', { isMainFrame: false, frame: page.frames[1] })
    expect((await send(owner, page.id, bindingId)).success).toBe(true)
    page.emit('did-start-navigation', { isMainFrame: false, frame: page.frames[0] })
    expect(await send(owner, page.id, bindingId)).toEqual({ success: false, error: 'stale' })
  })

  it('地址变化、frame 销毁和终端元素被替换都会失效', async () => {
    const owner = createOwner()
    const page = createPage(owner)
    const bindingId = await bindTerminal(owner, page)
    page.url = 'https://bastion.example/other'
    expect(await send(owner, page.id, bindingId)).toEqual({ success: false, error: 'stale' })

    const second = createPage(owner)
    const secondBinding = await bindTerminal(owner, second)
    second.frames[0].elementToken = undefined
    expect(await send(owner, second.id, secondBinding)).toEqual({ success: false, error: 'stale' })
    expect(second.insertText).not.toHaveBeenCalled()

    const third = createPage(owner)
    const thirdBinding = await bindTerminal(owner, third)
    third.frames[0].docToken = 'f'.repeat(32)
    expect(await send(owner, third.id, thirdBinding)).toEqual({ success: false, error: 'stale' })

    const fourth = createPage(owner)
    const fourthBinding = await bindTerminal(owner, fourth)
    fourth.frames[0].destroyed = true
    expect(await send(owner, fourth.id, fourthBinding)).toEqual({ success: false, error: 'stale' })
  })

  it('guest 销毁或页面崩溃后清理全部监听器', async () => {
    const owner = createOwner()
    const page = createPage(owner)
    await bindTerminal(owner, page)
    page.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(page.listenerCount('did-start-navigation')).toBe(0)
    expect(page.listenerCount('did-navigate-in-page')).toBe(0)
    expect(page.listenerCount('render-process-gone')).toBe(0)
    expect(owner.listenerCount('destroyed')).toBe(0)

    const second = createPage(owner)
    await bindTerminal(owner, second)
    second.emit('destroyed')
    expect(second.listenerCount('did-start-navigation')).toBe(0)
    expect(owner.listenerCount('destroyed')).toBe(0)
  })
})

describe('网页终端：释放与并发', () => {
  it('release 清理监听并让绑定失效，重复释放返回 stale', async () => {
    const owner = createOwner()
    const page = createPage(owner)
    const bindingId = await bindTerminal(owner, page)
    expect(await webTerminalRequest(wc(owner), { kind: 'release', pageId: page.id, bindingId }))
      .toEqual({ success: true })
    expect(page.listenerCount('did-start-navigation')).toBe(0)
    expect(page.frames[0].docToken).toBeUndefined()
    expect(await send(owner, page.id, bindingId)).toEqual({ success: false, error: 'stale' })
    expect(await webTerminalRequest(wc(owner), { kind: 'release', pageId: page.id, bindingId }))
      .toEqual({ success: false, error: 'stale' })
  })

  it('其它窗口不能释放或使用别人的绑定', async () => {
    const owner = createOwner()
    const other = createOwner()
    const page = createPage(owner)
    const bindingId = await bindTerminal(owner, page)
    expect(await webTerminalRequest(wc(other), { kind: 'release', pageId: page.id, bindingId }))
      .toEqual({ success: false, error: 'denied' })
    expect(await send(other, page.id, bindingId)).toEqual({ success: false, error: 'denied' })
    expect((await send(owner, page.id, bindingId)).success).toBe(true)
  })

  it('同一页面的并发操作返回 busy，串行完成后再放行', async () => {
    const owner = createOwner()
    const page = createPage(owner)
    const bindingId = await bindTerminal(owner, page)
    page.frames[0].holdCheck = true
    const first = send(owner, page.id, bindingId, 'a', false)
    expect(await send(owner, page.id, bindingId, 'b', false)).toEqual({ success: false, error: 'busy' })
    expect(await webTerminalRequest(wc(owner), { kind: 'bind', pageId: page.id }))
      .toEqual({ success: false, error: 'busy' })
    page.frames[0].releaseCheck()
    expect((await first).success).toBe(true)
    expect(page.events).toEqual(['insert:a'])
  })
})

describe('网页终端：输入语义', () => {
  it('先插入文本，再在目标仍有效时发 Return 的按下与抬起', async () => {
    const owner = createOwner()
    const page = createPage(owner)
    const bindingId = await bindTerminal(owner, page)
    expect((await send(owner, page.id, bindingId, 'ls -la', true)).success).toBe(true)
    expect(page.events).toEqual(['insert:ls -la', 'key:keyDown:Return', 'key:keyUp:Return'])
  })

  it('空行只在带回车时发送，且不调用 insertText', async () => {
    const owner = createOwner()
    const page = createPage(owner)
    const bindingId = await bindTerminal(owner, page)
    expect((await send(owner, page.id, bindingId, '', true)).success).toBe(true)
    expect(page.events).toEqual(['key:keyDown:Return', 'key:keyUp:Return'])
    expect(page.insertText).not.toHaveBeenCalled()
  })

  it('仅输入时不发送任何按键', async () => {
    const owner = createOwner()
    const page = createPage(owner)
    const bindingId = await bindTerminal(owner, page)
    expect((await send(owner, page.id, bindingId, 'echo hi', false)).success).toBe(true)
    expect(page.events).toEqual(['insert:echo hi'])
    expect(page.sendInputEvent).not.toHaveBeenCalled()
  })

  it('输入失败后不重试：返回 uncertain 并作废绑定', async () => {
    const owner = createOwner()
    const page = createPage(owner)
    const bindingId = await bindTerminal(owner, page)
    page.failInsert = true
    expect(await send(owner, page.id, bindingId, 'reboot', true)).toEqual({ success: false, error: 'uncertain' })
    expect(page.events).toEqual(['insert:reboot'])
    expect(page.sendInputEvent).not.toHaveBeenCalled()
    expect(await send(owner, page.id, bindingId, 'reboot', true)).toEqual({ success: false, error: 'stale' })
    expect(page.frames[0].inputCount).toBe(1)
    expect(page.insertText).not.toHaveBeenCalled()
  })

  it('文本插入期间发生导航时返回 uncertain 且不发 Return', async () => {
    const owner = createOwner()
    const page = createPage(owner)
    const bindingId = await bindTerminal(owner, page)
    page.onInsert = () => {
      page.url = 'https://bastion.example/other'
    }
    expect(await send(owner, page.id, bindingId, 'exit', true)).toEqual({ success: false, error: 'uncertain' })
    expect(page.events).toEqual(['insert:exit'])
  })

  it('回车前目标失效时返回 uncertain，不按键', async () => {
    const owner = createOwner()
    const page = createPage(owner)
    const bindingId = await bindTerminal(owner, page)
    page.onInsert = () => { page.frames[0].elementToken = undefined }
    expect(await send(owner, page.id, bindingId, 'ls', true)).toEqual({ success: false, error: 'uncertain' })
    expect(page.events).toEqual(['insert:ls'])
  })

  it('校验脚本超时不发送任何内容', async () => {
    vi.useFakeTimers()
    const owner = createOwner()
    const page = createPage(owner)
    const bindingId = await bindTerminal(owner, page)
    page.frames[0].hangCheck = true
    const pending = send(owner, page.id, bindingId, 'shutdown -h now', true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await pending).toEqual({ success: false, error: 'stale' })
    expect(page.events).toEqual([])
    expect(page.frames[0].docToken).toBeUndefined()
  })
})

describe('网页终端：自动发现与附着', () => {
  it('唯一可见终端即使没有焦点也自动绑定，但不聚焦、不输入', async () => {
    const owner = createOwner()
    const page = createPage(owner)
    const frame = page.frames[0]
    frame.terminal = true
    frame.focused = false
    page.focused = null

    const result = await discover(owner, page.id)
    expect(result.success).toBe(true)
    expect(result.terminalCount).toBe(1)
    expect(result.bindingId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(frame.attachCount).toBe(1)
    // 绑定成功也不得改变页面焦点或产生任何输入
    expect(frame.focused).toBe(false)
    expect(frame.inputCount).toBe(0)
    expect(page.events).toEqual([])
    expect(page.insertText).not.toHaveBeenCalled()
    expect(page.sendInputEvent).not.toHaveBeenCalled()
    for (const script of [WEB_TERMINAL_SCAN_SCRIPT, WEB_TERMINAL_VALIDATE_SCRIPT, WEB_TERMINAL_ATTACH_SCRIPT]) {
      expect(script).not.toContain('.focus(')
      expect(script).not.toContain('dispatchEvent')
      expect(script).not.toContain('ClipboardEvent')
      expect(script).not.toContain('insertText')
    }
  })

  it('探测和释放不模拟用户手势，只有主动发送输入才携带手势', async () => {
    const owner = createOwner()
    const page = createPage(owner)
    const frame = page.frames[0]
    frame.terminal = true
    const first = await discover(owner, page.id)
    await discover(owner, page.id)
    expect(frame.gestures.every(value => !value)).toBe(true)
    expect((await send(owner, page.id, first.bindingId as string)).success).toBe(true)
    expect(frame.gestures.filter(Boolean)).toHaveLength(1)
    expect(frame.executed[frame.gestures.indexOf(true)].startsWith(WEB_TERMINAL_INPUT_PREFIX)).toBe(true)
  })

  it('扫描后焦点切到其它 frame，不再附着过时的选择', async () => {
    const owner = createOwner()
    const page = createPage(owner, 2)
    const [first, second] = page.frames
    first.terminal = second.terminal = true
    first.focused = true
    page.focused = first
    first.onAttach = () => { page.focused = second }
    const result = await discover(owner, page.id)
    expect(result.bindingId).toBeUndefined()
    expect(page.events).toEqual([])
    expect(page.listenerCount('did-start-navigation')).toBe(0)
  })

  it('扫描后焦点移到表单，不再按帧内唯一终端猜测附着', async () => {
    const owner = createOwner()
    const page = createPage(owner, 2)
    const [first, second] = page.frames
    first.terminal = second.terminal = true
    first.focused = true
    page.focused = first
    first.onAttach = () => { first.focused = false }
    expect((await discover(owner, page.id)).bindingId).toBeUndefined()
    expect(page.events).toEqual([])
    expect(page.listenerCount('did-start-navigation')).toBe(0)
  })

  it('旧绑定仍有效时复用同一 bindingId，不因焦点转移而重新标记', async () => {
    const owner = createOwner()
    const page = createPage(owner)
    const frame = page.frames[0]
    frame.terminal = true
    frame.focused = true
    page.focused = frame
    const first = await discover(owner, page.id)
    const token = frame.docToken
    expect(frame.attachCount).toBe(1)

    // 工具面板获得焦点：终端元素不再聚焦，但旧绑定必须保持可用
    frame.focused = false
    page.focused = null
    const second = await discover(owner, page.id)
    expect(second).toEqual({ success: true, terminalCount: 1, bindingId: first.bindingId, url: page.url })
    expect(frame.attachCount).toBe(1)
    expect(frame.docToken).toBe(token)
    expect(frame.validateCount).toBeGreaterThanOrEqual(1)
    expect(frame.focused).toBe(false)
    // 发送脚本自行校验 token/URL，不依赖上一轮 discover
    expect((await send(owner, page.id, first.bindingId as string, 'whoami', false)).success).toBe(true)
  })

  it('多个终端但没有聚焦终端时只返回数量，并保留仍有效的旧绑定', async () => {
    const owner = createOwner()
    const page = createPage(owner, 2)
    const [main, shell] = page.frames
    main.terminal = true
    main.focused = true
    page.focused = main
    const bound = await discover(owner, page.id)
    expect(bound.bindingId).toBeTruthy()

    shell.terminal = true
    main.focused = false
    page.focused = null
    const result = await discover(owner, page.id)
    expect(result).toEqual({ success: true, terminalCount: 2, bindingId: bound.bindingId, url: page.url })
    expect(shell.attachCount).toBe(0)
    expect(main.attachCount).toBe(1)
  })

  it('多个终端且没有旧绑定时只返回数量，让用户自行点选', async () => {
    const owner = createOwner()
    const page = createPage(owner, 2)
    for (const frame of page.frames) {
      frame.terminal = true
      frame.focused = false
    }
    page.focused = null
    const result = await discover(owner, page.id)
    expect(result).toEqual({ success: true, terminalCount: 2, url: page.url })
    expect(page.attachCount).toBe(0)
    expect(page.insertText).not.toHaveBeenCalled()
  })

  it('多个终端时按 focusedFrame 的 activeElement 选择并绑定', async () => {
    const owner = createOwner()
    const page = createPage(owner, 2)
    const [main, shell] = page.frames
    main.terminal = true
    shell.terminal = true
    shell.focused = true
    page.focused = shell
    const result = await discover(owner, page.id)
    expect(result.success).toBe(true)
    expect(result.terminalCount).toBe(2)
    expect(result.bindingId).toBeTruthy()
    expect(shell.attachCount).toBe(1)
    expect(main.attachCount).toBe(0)
  })

  it('iframe 内的唯一终端也能自动附着', async () => {
    const owner = createOwner()
    const page = createPage(owner, 3)
    const [main, banner, shell] = page.frames
    main.terminal = false
    banner.terminal = false
    shell.terminal = true
    page.focused = null
    const result = await discover(owner, page.id)
    expect(result.bindingId).toBeTruthy()
    expect(shell.attachCount).toBe(1)
    expect(main.attachCount).toBe(0)
    expect(banner.attachCount).toBe(0)
  })

  it('普通表单/密码框不会被自动识别为终端', async () => {
    const owner = createOwner()
    const page = createPage(owner)
    page.frames[0].terminal = false
    const result = await discover(owner, page.id)
    expect(result).toEqual({ success: true, terminalCount: 0, url: page.url })
    expect(page.attachCount).toBe(0)
    expect(page.insertText).not.toHaveBeenCalled()
  })

  it('同一 frame 内焦点移到另一个终端时切换绑定', async () => {
    const owner = createOwner()
    const page = createPage(owner)
    const frame = page.frames[0]
    frame.terminal = true
    frame.focused = true
    page.focused = frame
    const first = await discover(owner, page.id)
    expect(first.bindingId).toBeTruthy()

    // 同一 frame 内出现第二个终端，焦点移到新终端上
    frame.scanTerminals = 2
    frame.scanFocused = true
    frame.focused = false
    const second = await discover(owner, page.id)
    expect(second.terminalCount).toBe(2)
    expect(second.bindingId).toBeTruthy()
    expect(second.bindingId).not.toBe(first.bindingId)
    expect(frame.attachCount).toBe(2)

    // 焦点回到已绑定终端后保持稳定，不再重复标记
    frame.focused = true
    const third = await discover(owner, page.id)
    expect(third.bindingId).toBe(second.bindingId)
    expect(frame.attachCount).toBe(2)
  })
})

describe('网页终端：自动附着的失效处理', () => {
  it('终端元素被替换或文档标记不一致时释放旧绑定并重新附着', async () => {
    const owner = createOwner()
    const page = createPage(owner)
    const frame = page.frames[0]
    frame.terminal = true
    frame.focused = true
    page.focused = frame
    const first = await discover(owner, page.id)

    // 元素被替换：旧元素 token 与新元素不一致
    frame.elementToken = 'f'.repeat(32)
    const second = await discover(owner, page.id)
    expect(second.success).toBe(true)
    expect(second.bindingId).toBeTruthy()
    expect(second.bindingId).not.toBe(first.bindingId)
    expect(frame.attachCount).toBe(2)
    expect(await send(owner, page.id, first.bindingId as string)).toEqual({ success: false, error: 'stale' })

    // 文档标记被换掉：同文档校验失败，旧绑定不可再用
    frame.docToken = 'e'.repeat(32)
    const third = await discover(owner, page.id)
    expect(third.success).toBe(true)
    expect(third.bindingId).toBeTruthy()
    expect(await send(owner, page.id, second.bindingId as string)).toEqual({ success: false, error: 'stale' })
  })

  it('终端隐藏或 frame 销毁后释放旧绑定', async () => {
    const owner = createOwner()
    const page = createPage(owner)
    const frame = page.frames[0]
    frame.terminal = true
    frame.focused = true
    page.focused = frame
    const bound = await discover(owner, page.id)

    frame.hidden = true
    const hidden = await discover(owner, page.id)
    expect(hidden).toEqual({ success: true, terminalCount: 0, url: page.url })
    expect(page.listenerCount('did-start-navigation')).toBe(0)
    expect(await send(owner, page.id, bound.bindingId as string)).toEqual({ success: false, error: 'stale' })

    const second = createPage(owner)
    const secondFrame = second.frames[0]
    secondFrame.terminal = true
    secondFrame.focused = true
    second.focused = secondFrame
    const secondBound = await discover(owner, second.id)
    secondFrame.destroyed = true
    const destroyed = await discover(owner, second.id)
    expect(destroyed).toEqual({ success: true, terminalCount: 0, url: second.url })
    expect(second.listenerCount('did-start-navigation')).toBe(0)
    expect(await send(owner, second.id, secondBound.bindingId as string)).toEqual({ success: false, error: 'stale' })
  })

  it('页面导航后旧绑定立即失效，下一次发现重新附着新文档', async () => {
    const owner = createOwner()
    const page = createPage(owner)
    const frame = page.frames[0]
    frame.terminal = true
    frame.focused = true
    page.focused = frame
    const first = await discover(owner, page.id)
    expect(page.listenerCount('did-start-navigation')).toBe(1)

    page.url = 'https://bastion.example/other'
    frame.url = page.url
    frame.docToken = undefined
    frame.elementToken = undefined
    page.emit('did-start-navigation', { isMainFrame: true, url: page.url })
    expect(page.listenerCount('did-start-navigation')).toBe(0)

    const second = await discover(owner, page.id)
    expect(second.success).toBe(true)
    expect(second.url).toBe(page.url)
    expect(second.bindingId).toBeTruthy()
    expect(second.bindingId).not.toBe(first.bindingId)
    expect(await send(owner, page.id, first.bindingId as string)).toEqual({ success: false, error: 'stale' })
  })

  it('其它 frame 扫描超时时不把剩余一个终端当作全页唯一', async () => {
    vi.useFakeTimers()
    const owner = createOwner()
    const page = createPage(owner, 2)
    const [shell, slow] = page.frames
    shell.terminal = true
    shell.focused = false
    page.focused = null
    slow.hangScan = true
    const pending = discover(owner, page.id)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await pending).toEqual({ success: true, terminalCount: 1, url: page.url })
    expect(page.attachCount).toBe(0)

    // 有明确焦点时仍允许定向附着，不受超时帧影响
    shell.focused = true
    page.focused = shell
    const directed = discover(owner, page.id)
    await vi.advanceTimersByTimeAsync(2000)
    const result = await directed
    expect(result.success).toBe(true)
    expect(result.bindingId).toBeTruthy()
    expect(shell.attachCount).toBe(1)
  })

  it('扫描帧数超限时不会把已扫描的唯一终端当作全页唯一', async () => {
    const owner = createOwner()
    const page = createPage(owner, WEB_TERMINAL_MAX_FRAMES + 2)
    page.frames[0].terminal = true
    page.frames[0].focused = false
    page.focused = null
    const result = await discover(owner, page.id)
    expect(result.success).toBe(true)
    expect(result.terminalCount).toBe(1)
    expect(result.bindingId).toBeUndefined()
    expect(page.attachCount).toBe(0)
  })

  it('自动附着超时后不留下绑定或监听，只保守返回数量', async () => {
    vi.useFakeTimers()
    const owner = createOwner()
    const page = createPage(owner)
    const frame = page.frames[0]
    frame.terminal = true
    frame.hangAttach = true
    const pending = discover(owner, page.id)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await pending).toEqual({ success: true, terminalCount: 1, url: page.url })
    expect(frame.attachCount).toBe(1)
    expect(page.listenerCount('did-start-navigation')).toBe(0)
    expect(frame.docToken).toBeUndefined()
  })
})

describe('网页终端：discover 请求校验', () => {
  it('discover 白名单在触达网页前生效', async () => {
    const owner = createOwner()
    const page = createPage(owner)
    page.frames[0].terminal = true
    const invalid = [
      { kind: 'discover' },
      { kind: 'discover', pageId: 0 },
      { kind: 'discover', pageId: page.id, extra: true },
      { kind: 'discover', pageId: page.id, bindingId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' }
    ]
    for (const value of invalid) {
      expect(await webTerminalRequest(wc(owner), request(value)), JSON.stringify(value))
        .toEqual({ success: false, error: 'invalid' })
    }
    expect(page.scanCount).toBe(0)
  })

  it('discover 仍受窗口归属、分区与页面类型限制', async () => {
    const owner = createOwner()
    const other = createOwner()
    const foreign = createPage(other)
    foreign.frames[0].terminal = true
    expect(await discover(owner, foreign.id)).toEqual({ success: false, error: 'denied' })
    expect(foreign.scanCount).toBe(0)

    const page = createPage(owner)
    page.frames[0].terminal = true
    page.type = 'window'
    expect(await discover(owner, page.id)).toEqual({ success: false, error: 'denied' })
    page.type = 'webview'
    page.session = {}
    expect(await discover(owner, page.id)).toEqual({ success: false, error: 'denied' })
    page.session = mocks.browser
    page.url = 'about:blank'
    expect(await discover(owner, page.id)).toEqual({ success: false, error: 'unavailable' })
    owner.destroyed = true
    expect(await discover(owner, page.id)).toEqual({ success: false, error: 'unavailable' })
    expect(page.scanCount).toBe(0)
  })

  it('同一页面的并发 discover/bind 返回 busy，串行完成后放行', async () => {
    vi.useFakeTimers()
    const owner = createOwner()
    const page = createPage(owner)
    page.frames[0].terminal = true
    page.frames[0].hangScan = true
    const first = discover(owner, page.id)
    expect(await discover(owner, page.id)).toEqual({ success: false, error: 'busy' })
    expect(await webTerminalRequest(wc(owner), { kind: 'bind', pageId: page.id }))
      .toEqual({ success: false, error: 'busy' })
    await vi.advanceTimersByTimeAsync(2000)
    const result = await first
    expect(result.success).toBe(true)
    expect(result.terminalCount).toBe(0)
  })
})
