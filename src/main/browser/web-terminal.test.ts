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
  WEB_TERMINAL_CHECK_SCRIPT,
  WEB_TERMINAL_MAX_FRAMES,
  WEB_TERMINAL_PROBE_SCRIPT,
  WEB_TERMINAL_STAMP_SCRIPT,
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
  probeCount = 0
  stampCount = 0
  checkCount = 0
  hangProbe = false
  hangStamp = false
  hangCheck = false
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

  executeJavaScript = (script: string): Promise<unknown> => {
    this.executed.push(script)
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
