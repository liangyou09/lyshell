import { EventEmitter } from 'node:events'
import type { Session, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { initializeReadonlySession } from './shelf-readonly-contract'
import {
  RELOADABLE_PROVIDER,
  ReloadablePageGuard,
  initializeReloadableSession,
} from './shelf-reloadable-guard'

const SAFE_URL = 'https://example.test/article'

// ---------------------------------------------------------------------------
// 假 Session / 假 WebContents
// ---------------------------------------------------------------------------

type RequestListener = (details: Record<string, unknown>, callback: (response: Record<string, unknown>) => void) => void
type CompleteListener = (details: Record<string, unknown>) => void

interface FakeSession {
  readonly session: Session
  readonly before: RequestListener | null
  readonly completed: CompleteListener | null
  readonly error: CompleteListener | null
  readonly serviceWorkers: {
    running: Record<number, Record<string, unknown>>
    throws: boolean
    asyncMode: boolean
  }
  readonly emitDownload: (guest?: { id: number }) => void
}

function makeSession(options: { persistent?: boolean; runningWorkers?: boolean } = {}): FakeSession {
  const emitter = new EventEmitter()
  let before: RequestListener | null = null
  let completed: CompleteListener | null = null
  let error: CompleteListener | null = null

  const serviceWorkers = {
    running: (options.runningWorkers ? { 7: { versionId: 1 } } : {}) as Record<number, Record<string, unknown>>,
    throws: false,
    asyncMode: false,
    getAllRunning(): unknown {
      if (serviceWorkers.throws) throw new Error('service worker lookup failed')
      if (serviceWorkers.asyncMode) return Promise.resolve(serviceWorkers.running)
      return serviceWorkers.running
    },
  }

  const webRequest = {
    onBeforeRequest(listener: RequestListener): void {
      before = listener
    },
    onCompleted(listener: CompleteListener): void {
      completed = listener
    },
    onErrorOccurred(listener: CompleteListener): void {
      error = listener
    },
  }

  const session = Object.assign(emitter, {
    webRequest,
    serviceWorkers,
    isPersistent: () => options.persistent !== false,
  }) as unknown as Session

  return {
    session,
    get before() {
      return before
    },
    get completed() {
      return completed
    },
    get error() {
      return error
    },
    serviceWorkers,
    emitDownload(guest?: { id: number }) {
      emitter.emit('will-download', {}, {}, guest)
    },
  }
}

function makeReadonlySession(): Session {
  const session = Object.assign(new EventEmitter(), {
    isPersistent: () => false,
    webRequest: {
      onBeforeRequest: () => undefined,
      onHeadersReceived: () => undefined,
    },
    setPermissionRequestHandler: () => undefined,
    setPermissionCheckHandler: () => undefined,
    setDevicePermissionHandler: () => undefined,
    setDisplayMediaRequestHandler: () => undefined,
    setSpellCheckerEnabled: () => undefined,
  })
  initializeReadonlySession(session as unknown as Session)
  return session as unknown as Session
}

interface FakeGuestOptions {
  session: Session
  id?: number
  url?: string
  loading?: boolean
  crashed?: boolean
  audible?: boolean
  devtools?: boolean
  debuggerAttached?: boolean
  frames?: number
  onExecute?: (code: string) => unknown
}

class FakeGuest extends EventEmitter {
  readonly id: number
  readonly session: Session
  currentUrl: string
  loading: boolean
  crashed: boolean
  audible: boolean
  devtools: boolean
  destroyed = false
  nonce: string | null = null
  readonly mainFrame: { framesInSubtree: unknown[] }
  readonly debuggerApi: {
    isAttached: () => boolean
    on: (...args: unknown[]) => unknown
    removeListener: (...args: unknown[]) => unknown
  }
  readonly executeCalls: string[] = []
  private readonly onExecute: (code: string) => unknown

  constructor(options: FakeGuestOptions) {
    super()
    this.id = options.id ?? 77
    this.session = options.session
    this.currentUrl = options.url ?? SAFE_URL
    this.loading = options.loading ?? false
    this.crashed = options.crashed ?? false
    this.audible = options.audible ?? false
    this.devtools = options.devtools ?? false
    this.mainFrame = { framesInSubtree: new Array(options.frames ?? 1).fill({}) }
    this.debuggerApi = {
      isAttached: () => options.debuggerAttached === true,
      on: () => undefined,
      removeListener: () => undefined,
    }
    this.onExecute =
      options.onExecute ??
      ((code: string) => {
        if (code.includes('MutationObserver')) return undefined
        return {
          ok: true,
          nonce: this.nonce,
          readyState: 'complete',
          top: true,
          activation: true,
          scrollY: 0,
          observer: true,
          shadow: false,
          reasons: [],
        }
      })
  }

  // 与真实 WebContents 同名：供观察器按原生 API 使用。
  get debugger(): FakeGuest['debuggerApi'] {
    return this.debuggerApi
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  getURL(): string {
    return this.currentUrl
  }

  isLoadingMainFrame(): boolean {
    return this.loading
  }

  isCrashed(): boolean {
    return this.crashed
  }

  isCurrentlyAudible(): boolean {
    return this.audible
  }

  isDevToolsOpened(): boolean {
    return this.devtools
  }

  executeJavaScriptInIsolatedWorld(_worldId: number, scripts: Array<{ code: string }>): Promise<unknown> {
    const code = scripts[0].code
    this.executeCalls.push(code)
    const match = /const NONCE = '([a-f0-9]{32})'/.exec(code)
    if (match) this.nonce = match[1]
    return Promise.resolve(this.onExecute(code))
  }
}

function makeNativeGuard(options: Partial<FakeGuestOptions> = {}) {
  const fake = makeSession()
  initializeReloadableSession(fake.session)
  const guest = new FakeGuest({ session: fake.session, ...options })
  const guard = new ReloadablePageGuard(guest as unknown as WebContents, fake.session)
  return { fake, guest, guard }
}

// ---------------------------------------------------------------------------
// 沙箱隔离世界：真实执行注入脚本，验证网页侧观察逻辑
// ---------------------------------------------------------------------------

interface SandboxOptions {
  controls?: boolean
  designMode?: string
  mediaPlaying?: boolean
  extraNodes?: Array<{ localName: string; shadowRoot: unknown }>
  activation?: boolean
  top?: boolean
  readyState?: string
  initialScrollY?: number
  ignoreScroll?: boolean
}

interface Sandbox {
  run: (code: string) => unknown
  readonly listeners: Map<string, Array<(event: unknown) => void>>
  readonly observers: Array<(records: unknown[]) => void>
  readonly nodes: Array<Record<string, unknown>>
  readonly windowObj: {
    scrollY: number
    scrollX: number
    top: unknown
    scrollTo: unknown
  }
}

function createSandbox(options: SandboxOptions = {}): Sandbox {
  const listeners = new Map<string, Array<(event: unknown) => void>>()
  const nodes: Array<Record<string, unknown>> = options.extraNodes ? [...options.extraNodes] : []
  const media = [{ paused: options.mediaPlaying !== true, ended: false }]
  const windowObj: Sandbox['windowObj'] = {
    scrollY: options.initialScrollY ?? 0,
    scrollX: 0,
    top: undefined,
    scrollTo: vi.fn((arg: unknown, maybeY?: number) => {
      if (options.ignoreScroll === true) return
      if (arg && typeof arg === 'object') windowObj.scrollY = Number((arg as { top?: unknown }).top ?? 0)
      else windowObj.scrollY = typeof maybeY === 'number' ? maybeY : 0
    }),
  }
  windowObj.top = options.top === false ? {} : windowObj
  const documentObj = {
    readyState: options.readyState ?? 'complete',
    designMode: options.designMode ?? 'off',
    addEventListener(type: string, listener: (event: unknown) => void): void {
      const existing = listeners.get(type)
      if (existing) existing.push(listener)
      else listeners.set(type, [listener])
    },
    querySelector(selector: string): unknown {
      if (options.controls === true && /input|textarea|contenteditable|role=/.test(selector)) {
        return { localName: 'input' }
      }
      return null
    },
    querySelectorAll(selector: string): unknown[] {
      if (selector === 'video, audio') return media
      if (selector === '*') return nodes
      return []
    },
  }
  const navigatorObj = { userActivation: { hasBeenActive: options.activation !== false } }
  const observers: Array<(records: unknown[]) => void> = []
  class FakeMutationObserver {
    constructor(callback: (records: unknown[]) => void) {
      observers.push(callback)
    }
    observe(): void {
      // 沙箱里由测试手动触发回调
    }
    disconnect(): void {
      // no-op
    }
  }
  const sandboxGlobal: Record<string, unknown> = {}
  const run = (code: string): unknown =>
    new Function(
      'globalThis',
      'window',
      'document',
      'navigator',
      'MutationObserver',
      'return (' + code + ')'
    )(sandboxGlobal, windowObj, documentObj, navigatorObj, FakeMutationObserver)
  return { run, listeners, observers, nodes, windowObj }
}

function makeSandboxGuard(options: SandboxOptions = {}) {
  const fake = makeSession()
  initializeReloadableSession(fake.session)
  const sandbox = createSandbox(options)
  const guest = new FakeGuest({ session: fake.session, onExecute: (code) => sandbox.run(code) })
  const guard = new ReloadablePageGuard(guest as unknown as WebContents, fake.session)
  return { fake, sandbox, guest, guard }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function emitFullNavigation(guest: FakeGuest, url: string): void {
  guest.currentUrl = url
  guest.emit('did-start-navigation', { url, isInPlace: false, isMainFrame: true }, url, false, true)
}

// ---------------------------------------------------------------------------
// Provider / Session 初始化
// ---------------------------------------------------------------------------

describe('provider 与 Session 初始化', () => {
  it('暴露可重载 provider 标识', () => {
    expect(RELOADABLE_PROVIDER).toBe('app:reloadable-v1')
  })

  it('每个 Session 只安装一次请求观察，且永远放行请求', () => {
    const fake = makeSession()
    initializeReloadableSession(fake.session)
    const installed = fake.before
    expect(typeof installed).toBe('function')
    initializeReloadableSession(fake.session)
    expect(fake.before).toBe(installed)

    const responses: Array<Record<string, unknown>> = []
    installed?.({ id: 1, method: 'GET', webContentsId: 5, resourceType: 'mainFrame' }, (response) => {
      responses.push(response)
    })
    expect(responses).toEqual([{}])
  })

  it('拒绝只读分区与非持久 Session', () => {
    expect(() => initializeReloadableSession(makeReadonlySession())).toThrow(/只读/)
    expect(() => initializeReloadableSession(makeSession({ persistent: false }).session)).toThrow(/持久/)
  })

  it('缺少 webRequest 的对象被拒绝', () => {
    expect(() => initializeReloadableSession({} as unknown as Session)).toThrow(TypeError)
  })
})

// ---------------------------------------------------------------------------
// 观察器生命周期
// ---------------------------------------------------------------------------

describe('观察器注册与清理', () => {
  it('无响应隔离世界检查超时后本导航保活，不继续排入执行请求', async () => {
    vi.useFakeTimers()
    const { guard, guest } = makeNativeGuard({ onExecute: () => new Promise(() => {}) })
    try {
      const pending = guard.snapshot()
      await vi.advanceTimersByTimeAsync(2001)
      expect(await pending).toMatchObject({ decision: 'unknown', reasonCodes: expect.arrayContaining(['inspection-timeout']) })
      const requests = guest.executeCalls.length
      await guard.snapshot()
      expect(guest.executeCalls).toHaveLength(requests)
    } finally { guard.dispose(); vi.useRealTimers() }
  })
  it('未初始化的 Session 一律 blocked，且不执行隔离世界脚本', async () => {
    const fake = makeSession()
    const guest = new FakeGuest({ session: fake.session })
    const guard = new ReloadablePageGuard(guest as unknown as WebContents, fake.session)
    const snapshot = await guard.snapshot()
    expect(snapshot.decision).toBe('blocked')
    expect(snapshot.reasonCodes).toContain('session-mismatch')
    expect(guest.executeCalls).toHaveLength(0)
  })

  it('guest 属于另一个 Session 时 blocked', async () => {
    const fake = makeSession()
    initializeReloadableSession(fake.session)
    const other = makeSession()
    initializeReloadableSession(other.session)
    const guest = new FakeGuest({ session: other.session })
    const guard = new ReloadablePageGuard(guest as unknown as WebContents, fake.session)
    const snapshot = await guard.snapshot()
    expect(snapshot.decision).toBe('blocked')
    expect(snapshot.reasonCodes).toContain('session-mismatch')
  })

  it('dispose 移除原生监听并阻断后续快照', async () => {
    const { guard, guest } = makeNativeGuard()
    expect((await guard.snapshot()).decision).toBe('safe')
    guard.dispose()
    guard.dispose()
    expect(guest.listenerCount('before-input-event')).toBe(0)
    expect(guest.listenerCount('dom-ready')).toBe(0)
    const snapshot = await guard.snapshot()
    expect(snapshot.decision).toBe('blocked')
    expect(snapshot.reasonCodes).toContain('guard-disposed')
  })

  it('guest destroyed 后返回 unknown 而不是 safe', async () => {
    const { guard, guest } = makeNativeGuard()
    guest.destroyed = true
    guest.emit('destroyed')
    const snapshot = await guard.snapshot()
    expect(snapshot.decision).toBe('unknown')
    expect(snapshot.reasonCodes).toContain('guest-destroyed')
  })

  it('安装脚本是带主进程 nonce 的静态 IIFE，不含未替换占位符', async () => {
    const { guard, guest } = makeNativeGuard()
    await guard.snapshot()
    const install = guest.executeCalls.find((code) => code.includes('MutationObserver'))
    expect(install).toBeDefined()
    expect(install).not.toContain('@@RELOADABLE_NONCE@@')
    expect(install).toMatch(/const NONCE = '[a-f0-9]{32}'/)
    expect(install).not.toContain('eval(')
    expect(install).not.toContain('require(')
  })
})

// ---------------------------------------------------------------------------
// 隔离世界观察（真实注入脚本 + 沙箱 DOM）
// ---------------------------------------------------------------------------

describe('隔离世界观察（真实注入脚本 + 沙箱 DOM）', () => {
  it('缺少用户激活仍保活，但提供同文档 nonce 供显式恢复滚动', async () => {
    const { guard, sandbox } = makeSandboxGuard({ activation: false })
    const snapshot = await guard.snapshot()
    expect(snapshot.decision).toBe('blocked')
    expect(snapshot.reasonCodes).toContain('no-user-activation')
    expect(snapshot.documentNonce).toMatch(/^[a-f0-9]{32}$/)
    await guard.restoreScroll(snapshot.documentNonce!, 600)
    expect(sandbox.windowObj.scrollY).toBe(600)
    expect((await guard.snapshot()).decision).toBe('blocked')
  })
  it('DOM 变更超出观察上限必须 unknown，不能静默跳过后放行', async () => {
    const { guard, sandbox } = makeSandboxGuard()
    await flush()
    sandbox.observers[0]?.(Array.from({ length: 65 }, () => ({ type: 'childList', addedNodes: [] })))
    expect(await guard.snapshot()).toMatchObject({ decision: 'unknown', reasonCodes: expect.arrayContaining(['dom-too-large']) })
  })
  it('干净文档返回 safe，并带上同文档 nonce 与滚动位置', async () => {
    const { guard } = makeSandboxGuard({ initialScrollY: 420 })
    const snapshot = await guard.snapshot()
    expect(snapshot.decision).toBe('safe')
    expect(snapshot.reasonCodes).toEqual([])
    expect(snapshot.url).toBe(SAFE_URL)
    expect(snapshot.documentNonce).toMatch(/^[a-f0-9]{32}$/)
    expect(snapshot.scrollY).toBe(420)
  })

  it('存在可编辑控件就 blocked', async () => {
    const { guard } = makeSandboxGuard({ controls: true })
    const snapshot = await guard.snapshot()
    expect(snapshot.decision).toBe('blocked')
    expect(snapshot.reasonCodes).toContain('editable-control')
  })

  it('designMode 非 off 就 blocked', async () => {
    const { guard } = makeSandboxGuard({ designMode: 'on' })
    const snapshot = await guard.snapshot()
    expect(snapshot.decision).toBe('blocked')
    expect(snapshot.reasonCodes).toContain('design-mode')
  })

  it('正在播放的媒体 blocked', async () => {
    const { guard } = makeSandboxGuard({ mediaPlaying: true })
    const snapshot = await guard.snapshot()
    expect(snapshot.decision).toBe('blocked')
    expect(snapshot.reasonCodes).toContain('media-playing')
  })

  it('自定义元素 / shadow 不确定性返回 unknown', async () => {
    const { guard } = makeSandboxGuard({ extraNodes: [{ localName: 'my-widget', shadowRoot: null }] })
    const snapshot = await guard.snapshot()
    expect(snapshot.decision).toBe('unknown')
    expect(snapshot.reasonCodes).toContain('custom-element-unknown')
  })

  it('没有粘性用户激活 blocked（beforeunload 必须可触发）', async () => {
    const { guard } = makeSandboxGuard({ activation: false })
    const snapshot = await guard.snapshot()
    expect(snapshot.decision).toBe('blocked')
    expect(snapshot.reasonCodes).toContain('no-user-activation')
  })

  it('非顶层文档 blocked', async () => {
    const { guard } = makeSandboxGuard({ top: false })
    const snapshot = await guard.snapshot()
    expect(snapshot.decision).toBe('blocked')
    expect(snapshot.reasonCodes).toContain('not-top-frame')
  })

  it('文档未 complete blocked', async () => {
    const { guard } = makeSandboxGuard({ readyState: 'interactive' })
    const snapshot = await guard.snapshot()
    expect(snapshot.decision).toBe('blocked')
    expect(snapshot.reasonCodes).toContain('document-not-ready')
  })

  it('安装后新增的可编辑控件通过 MutationObserver 标记 blocked', async () => {
    const { guard, sandbox } = makeSandboxGuard()
    await flush()
    const control = {
      nodeType: 1,
      localName: 'input',
      shadowRoot: null,
      matches: (selector: string) => selector.includes('input'),
      querySelector: () => null,
      querySelectorAll: () => [],
    }
    sandbox.nodes.push(control)
    sandbox.observers[0]?.([{ type: 'childList', addedNodes: [control] }])
    const snapshot = await guard.snapshot()
    expect(snapshot.decision).toBe('blocked')
    expect(snapshot.reasonCodes).toContain('editable-control')
  })

  it('输入事件（被动监听）标记 blocked', async () => {
    const { guard, sandbox } = makeSandboxGuard()
    await flush()
    for (const listener of sandbox.listeners.get('input') ?? []) listener({})
    const snapshot = await guard.snapshot()
    expect(snapshot.decision).toBe('blocked')
    expect(snapshot.reasonCodes).toContain('input-input')
  })
})

// ---------------------------------------------------------------------------
// 原生阻断信号
// ---------------------------------------------------------------------------

describe('原生阻断信号', () => {
  it('URL 带 query / hash / localhost 都 blocked', async () => {
    for (const url of [
      'https://example.test/a?q=1',
      'https://example.test/a#x',
      'http://localhost:3000/',
    ]) {
      const { guard } = makeNativeGuard({ url })
      const snapshot = await guard.snapshot()
      expect(snapshot.decision).toBe('blocked')
      expect(snapshot.reasonCodes).toContain('url-not-safe')
    }
  })

  it('存在子框架 blocked', async () => {
    const { guard } = makeNativeGuard({ frames: 2 })
    const snapshot = await guard.snapshot()
    expect(snapshot.decision).toBe('blocked')
    expect(snapshot.reasonCodes).toContain('subframe-present')
  })

  it('DevTools 打开 / debugger 附着 blocked', async () => {
    const { guard } = makeNativeGuard({ devtools: true })
    expect((await guard.snapshot()).reasonCodes).toContain('devtools-open')
    const attached = makeNativeGuard({ debuggerAttached: true })
    expect((await attached.guard.snapshot()).reasonCodes).toContain('devtools-open')
  })

  it('页面发声 blocked', async () => {
    const { guard } = makeNativeGuard({ audible: true })
    const snapshot = await guard.snapshot()
    expect(snapshot.decision).toBe('blocked')
    expect(snapshot.reasonCodes).toContain('page-audible')
  })

  it('渲染进程崩溃返回 unknown', async () => {
    const { guard } = makeNativeGuard({ crashed: true })
    const snapshot = await guard.snapshot()
    expect(snapshot.decision).toBe('unknown')
    expect(snapshot.reasonCodes).toContain('renderer-crashed')
  })

  it('主框架加载中 blocked', async () => {
    const { guard } = makeNativeGuard({ loading: true })
    const snapshot = await guard.snapshot()
    expect(snapshot.decision).toBe('blocked')
    expect(snapshot.reasonCodes).toContain('page-loading')
  })

  it('键盘输入 blocked 且不泄漏键值，鼠标输入不阻断', async () => {
    const keyboard = makeNativeGuard()
    keyboard.guest.emit('before-input-event', {}, { type: 'keyDown', key: 'SecretKey' })
    const blocked = await keyboard.guard.snapshot()
    expect(blocked.decision).toBe('blocked')
    expect(blocked.reasonCodes).toContain('key-input')
    expect(JSON.stringify(blocked)).not.toContain('SecretKey')

    const mouse = makeNativeGuard()
    mouse.guest.emit('before-input-event', {}, { type: 'mouseDown', key: 'Left' })
    expect((await mouse.guard.snapshot()).decision).toBe('safe')
  })

  it('媒体开始播放 blocked', async () => {
    const { guard, guest } = makeNativeGuard()
    guest.emit('media-started-playing')
    const snapshot = await guard.snapshot()
    expect(snapshot.decision).toBe('blocked')
    expect(snapshot.reasonCodes).toContain('media-playing')
  })

  it('显式 block 只接受有界机器码，自由文本被归一', async () => {
    const { guard } = makeNativeGuard()
    guard.block('user-timeout')
    expect((await guard.snapshot()).reasonCodes).toContain('user-timeout')

    const text = makeNativeGuard()
    text.guard.block('<img src=x onerror=alert(1)>')
    const snapshot = await text.guard.snapshot()
    expect(snapshot.reasonCodes).toContain('explicit-block')
    expect(JSON.stringify(snapshot)).not.toContain('<img')
    expect(JSON.stringify(snapshot)).not.toContain('alert(1)')
  })

  it('原生 latch 只在下一个主框架完整文档导航时清除', async () => {
    const { guard, guest } = makeNativeGuard()
    guest.emit('media-started-playing')
    expect((await guard.snapshot()).reasonCodes).toContain('media-playing')

    // 同文档导航（isInPlace）不清除 latch。
    guest.emit('did-start-navigation', { isInPlace: true, isMainFrame: true }, SAFE_URL, true, true)
    expect((await guard.snapshot()).reasonCodes).toContain('media-playing')

    emitFullNavigation(guest, 'https://example.test/next')
    guest.emit('dom-ready')
    await flush()
    const snapshot = await guard.snapshot()
    expect(snapshot.decision).toBe('safe')
    expect(snapshot.url).toBe('https://example.test/next')
  })

  it('devtools 关闭后当前导航仍然 blocked', async () => {
    const { guard, guest } = makeNativeGuard()
    guest.emit('devtools-opened')
    guest.devtools = false
    const snapshot = await guard.snapshot()
    expect(snapshot.decision).toBe('blocked')
    expect(snapshot.reasonCodes).toContain('devtools-open')
  })

  it('reasonCodes 有界且不会把自由文本带出', async () => {
    const { guard } = makeNativeGuard()
    for (let index = 0; index < 40; index += 1) guard.block(`r${index}`)
    const snapshot = await guard.snapshot()
    expect(snapshot.decision).toBe('blocked')
    expect(snapshot.reasonCodes.length).toBeLessThanOrEqual(16)
    for (const code of snapshot.reasonCodes) expect(code).toMatch(/^[a-z0-9][a-z0-9-]{0,47}$/)
  })
})

// ---------------------------------------------------------------------------
// 请求观察与 Session 级信号
// ---------------------------------------------------------------------------

describe('请求观察与 Session 级信号', () => {
  it('请求没有可核实的 guest 归属时保守 unknown，但不阻断网络', async () => {
    const { fake, guard } = makeNativeGuard()
    const callback = vi.fn()
    fake.before?.({ id: 9, method: 'POST', resourceType: 'xhr' }, callback)
    expect(callback).toHaveBeenCalledWith({})
    expect(await guard.snapshot()).toMatchObject({ decision: 'unknown', reasonCodes: expect.arrayContaining(['request-observation-unknown']) })
  })
  it('未完成请求阻断快照，完成后恢复 safe', async () => {
    const { fake, guest, guard } = makeNativeGuard()
    fake.before?.({ id: 11, method: 'GET', resourceType: 'xhr', webContentsId: guest.id }, () => undefined)
    const blocked = await guard.snapshot()
    expect(blocked.decision).toBe('blocked')
    expect(blocked.reasonCodes).toContain('request-pending')

    fake.completed?.({ id: 11, webContentsId: guest.id })
    expect((await guard.snapshot()).decision).toBe('safe')
  })

  it('非 GET 与 websocket 请求立即 blocked', async () => {
    const post = makeNativeGuard()
    post.fake.before?.(
      { id: 12, method: 'POST', resourceType: 'xhr', webContentsId: post.guest.id },
      () => undefined
    )
    expect((await post.guard.snapshot()).reasonCodes).toContain('non-get-request')

    const socket = makeNativeGuard()
    socket.fake.before?.(
      { id: 13, method: 'GET', resourceType: 'webSocket', webContentsId: socket.guest.id },
      () => undefined
    )
    expect((await socket.guard.snapshot()).reasonCodes).toContain('websocket')
  })

  it('未完成请求超过上限后 blocked', async () => {
    const { fake, guest, guard } = makeNativeGuard()
    for (let index = 0; index < 129; index += 1) {
      fake.before?.({ id: index + 1, method: 'GET', resourceType: 'image', webContentsId: guest.id }, () => undefined)
    }
    const snapshot = await guard.snapshot()
    expect(snapshot.decision).toBe('blocked')
    expect(snapshot.reasonCodes).toContain('request-overflow')
  })

  it('Session 内有运行中的 Service Worker 返回 unknown', async () => {
    const fake = makeSession({ runningWorkers: true })
    initializeReloadableSession(fake.session)
    const guest = new FakeGuest({ session: fake.session })
    const guard = new ReloadablePageGuard(guest as unknown as WebContents, fake.session)
    const snapshot = await guard.snapshot()
    expect(snapshot.decision).toBe('unknown')
    expect(snapshot.reasonCodes).toContain('service-worker-active')
  })

  it('Service Worker 查询异常 / 异步返回 unknown', async () => {
    const throwing = makeSession()
    throwing.serviceWorkers.throws = true
    initializeReloadableSession(throwing.session)
    const throwingGuest = new FakeGuest({ session: throwing.session })
    const throwingGuard = new ReloadablePageGuard(throwingGuest as unknown as WebContents, throwing.session)
    expect((await throwingGuard.snapshot()).reasonCodes).toContain('service-worker-unknown')

    const asyncMode = makeSession()
    asyncMode.serviceWorkers.asyncMode = true
    initializeReloadableSession(asyncMode.session)
    const asyncGuest = new FakeGuest({ session: asyncMode.session })
    const asyncGuard = new ReloadablePageGuard(asyncGuest as unknown as WebContents, asyncMode.session)
    expect((await asyncGuard.snapshot()).reasonCodes).toContain('service-worker-unknown')
  })

  it('下载事件 blocked', async () => {
    const { fake, guest, guard } = makeNativeGuard()
    fake.emitDownload({ id: guest.id })
    const snapshot = await guard.snapshot()
    expect(snapshot.decision).toBe('blocked')
    expect(snapshot.reasonCodes).toContain('download')
  })
})

// ---------------------------------------------------------------------------
// 快照竞态与隔离世界异常
// ---------------------------------------------------------------------------

describe('快照竞态与隔离世界异常', () => {
  function deferredGuard() {
    const fake = makeSession()
    initializeReloadableSession(fake.session)
    const deferred: { resolve: ((value: unknown) => void) | null } = { resolve: null }
    const guest = new FakeGuest({
      session: fake.session,
      onExecute: (code) => {
        if (code.includes('MutationObserver')) return undefined
        return new Promise<unknown>((resolve) => {
          deferred.resolve = resolve
        })
      },
    })
    const guard = new ReloadablePageGuard(guest as unknown as WebContents, fake.session)
    return { fake, guest, guard, deferred }
  }

  it('查询回包前发生主框架导航 => unknown', async () => {
    const { guest, guard, deferred } = deferredGuard()
    const pending = guard.snapshot()
    await flush()
    const resolve = deferred.resolve
    expect(resolve).not.toBeNull()
    emitFullNavigation(guest, 'https://example.test/other')
    resolve?.({
      ok: true,
      nonce: guest.nonce,
      readyState: 'complete',
      top: true,
      activation: true,
      scrollY: 0,
      observer: true,
      shadow: false,
      reasons: [],
    })
    const snapshot = await pending
    expect(snapshot.decision).toBe('unknown')
    expect(snapshot.reasonCodes).toContain('navigation-during-inspection')
  })

  it('快照等待期间的原生 block 不会被旧文档回包覆盖', async () => {
    const { guest, guard, deferred } = deferredGuard()
    const pending = guard.snapshot()
    await flush()
    const resolve = deferred.resolve
    expect(resolve).not.toBeNull()
    guard.block('download')
    resolve?.({
      ok: true,
      nonce: guest.nonce,
      readyState: 'complete',
      top: true,
      activation: true,
      scrollY: 0,
      observer: true,
      shadow: false,
      reasons: [],
    })
    const snapshot = await pending
    expect(snapshot.decision).toBe('blocked')
    expect(snapshot.reasonCodes).toContain('download')
  })

  it('隔离世界状态缺失 / nonce 不一致都返回 unknown', async () => {
    const fake = makeSession()
    initializeReloadableSession(fake.session)
    let reply: unknown = { ok: false, code: 'state-missing' }
    const guest = new FakeGuest({
      session: fake.session,
      onExecute: (code) => (code.includes('MutationObserver') ? undefined : reply),
    })
    const guard = new ReloadablePageGuard(guest as unknown as WebContents, fake.session)
    expect((await guard.snapshot()).reasonCodes).toContain('state-missing')

    reply = {
      ok: true,
      nonce: '0'.repeat(32),
      readyState: 'complete',
      top: true,
      activation: true,
      scrollY: 0,
      observer: true,
      shadow: false,
      reasons: [],
    }
    expect((await guard.snapshot()).reasonCodes).toContain('state-inconsistent')
  })

  it('隔离世界执行抛错返回 unknown', async () => {
    const fake = makeSession()
    initializeReloadableSession(fake.session)
    const guest = new FakeGuest({
      session: fake.session,
      onExecute: (code) => {
        if (code.includes('MutationObserver')) return undefined
        throw new Error('inspector failed')
      },
    })
    const guard = new ReloadablePageGuard(guest as unknown as WebContents, fake.session)
    const snapshot = await guard.snapshot()
    expect(snapshot.decision).toBe('unknown')
    expect(snapshot.reasonCodes).toContain('inspection-failed')
  })

  it('观察器安装抛错不会变成 safe', async () => {
    const fake = makeSession()
    initializeReloadableSession(fake.session)
    const guest = new FakeGuest({
      session: fake.session,
      onExecute: (code) => {
        if (code.includes('MutationObserver')) throw new Error('inject failed')
        return undefined
      },
    })
    const guard = new ReloadablePageGuard(guest as unknown as WebContents, fake.session)
    const snapshot = await guard.snapshot()
    expect(snapshot.decision).not.toBe('safe')
    expect(snapshot.reasonCodes).toContain('observer-failed')
  })

  it('主框架完整导航换新 nonce，旧 nonce 不再能恢复', async () => {
    const { guard, guest } = makeNativeGuard()
    const first = await guard.snapshot()
    expect(first.decision).toBe('safe')

    emitFullNavigation(guest, 'https://example.test/second')
    guest.emit('dom-ready')
    await flush()
    const second = await guard.snapshot()
    expect(second.decision).toBe('safe')
    expect(second.documentNonce).not.toBe(first.documentNonce)

    await guard.restoreScroll(first.documentNonce as string, 100)
    expect(guest.executeCalls.filter((code) => code.includes('window.scrollTo({'))).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 滚动恢复
// ---------------------------------------------------------------------------

describe('滚动恢复', () => {
  it('同一文档内恢复滚动位置', async () => {
    const { guard, sandbox } = makeSandboxGuard()
    const snapshot = await guard.snapshot()
    await guard.restoreScroll(snapshot.documentNonce as string, 300)
    expect(sandbox.windowObj.scrollY).toBe(300)
  })

  it('nonce 不匹配 / 越界 / 已 dispose 时不注入', async () => {
    const { guard, guest } = makeSandboxGuard()
    const snapshot = await guard.snapshot()
    const before = guest.executeCalls.length

    await guard.restoreScroll('0'.repeat(32), 100)
    await guard.restoreScroll(snapshot.documentNonce as string, -1)
    await guard.restoreScroll(snapshot.documentNonce as string, 10_000_001)
    expect(guest.executeCalls.length).toBe(before)

    guard.dispose()
    await guard.restoreScroll(snapshot.documentNonce as string, 100)
    expect(guest.executeCalls.length).toBe(before)
  })

  it('用户滚动后跳过恢复（网页侧静默窗口）', async () => {
    const { guard, sandbox } = makeSandboxGuard()
    const snapshot = await guard.snapshot()
    for (const listener of sandbox.listeners.get('wheel') ?? []) listener({ isTrusted: true })
    await guard.restoreScroll(snapshot.documentNonce as string, 300)
    expect(sandbox.windowObj.scrollY).toBe(0)
  })

  it('导航发生后停止重试，不触碰新文档', async () => {
    const { guard, sandbox, guest } = makeSandboxGuard({ ignoreScroll: true })
    const snapshot = await guard.snapshot()
    const pending = guard.restoreScroll(snapshot.documentNonce as string, 300)
    await flush()
    emitFullNavigation(guest, 'https://example.test/next')
    await pending
    expect(sandbox.windowObj.scrollTo).toHaveBeenCalledTimes(1)
  })

  it('最多重试 3 次', async () => {
    const { guard, guest } = makeSandboxGuard({ ignoreScroll: true })
    const snapshot = await guard.snapshot()
    const before = guest.executeCalls.length
    await guard.restoreScroll(snapshot.documentNonce as string, 300)
    const restoreCalls = guest.executeCalls
      .slice(before)
      .filter((code) => code.includes('window.scrollTo({'))
    expect(restoreCalls).toHaveLength(3)
  }, 5000)
})
