// @vitest-environment jsdom
/**
 * 只读工作台 client 半（resources/dsh-bridge/client.js）的**异步竞态**回归（S4 审查修正 4）。
 *
 * 跑的是产品源码本身：按官方 clientModules 的装载方式注册模块，取 factory 返回的
 * `{ inject, apply }` 装载；官方服务（sessions / uiWorkspace / conversation）按真实形状替身，
 * fetch 全量拦截以便精确控制响应顺序。断言只走**对外可观测面**（装载时创建的
 * `__LYSHELL_HARNESS_CLIENT__` presence、被拦截的请求、官方导航调用记录），不依赖内部字段。
 *
 * 锁四个历史坑：
 *   ① 旧 ack 的 then 无条件清 state.navTimer —— 会把**新**导航的验证定时器清掉，
 *      新导航于是永远等不到落地判定（界面停在「等待官方界面确认」）；
 *   ② status 轮询可重叠 —— 旧响应不得把旧 nav / 只读态 / 浏览位置盖回新的；
 *   ③ 同一请求只 ack 一次；
 *   ④ 归属不属于本浏览器的请求不得应用（另一浏览器不能替我导航/ack）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const CLIENT_SOURCE = readFileSync(join(process.cwd(), 'resources', 'dsh-bridge', 'client.js'), 'utf8')

const STATUS_URL = '/__lyshell/harness/viewer/status'
const ACK_URL = '/__lyshell/harness/viewer/ack'
const BROWSE_URL = '/__lyshell/harness/viewer/browse'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

interface Presence {
  readOnly: boolean
  offline: boolean
  currentSessionId: string | null
  pendingViewerRequest: string | null
  pendingNavigation: string | null
  appliedViewerRequests: number
  gatedPathCount: number
}

interface Call {
  url: string
  deferred: Deferred<{ ok: boolean; json: () => Promise<unknown> }>
}

interface Harness {
  calls: Call[]
  opened: string[]
  presence: () => Presence
  setCurrentSession: (id: string | null) => void
  emitSessionsChanged: () => void
  respond: (index: number, body: Record<string, unknown>, ok?: boolean) => void
  lastCallFor: (url: string) => number
}

function mountClient(): Harness {
  const calls: Call[] = []
  const opened: string[] = []
  let currentSession: string | null = 'session-a'
  const sessionListeners: Array<() => void> = []
  const conversation = { blocks: { set: () => undefined } }

  const sessionsService = {
    list: {
      getSnapshot: () => ({ ids: currentSession ? [currentSession] : [] }),
      subscribe: (fn: () => void) => { sessionListeners.push(fn); return () => undefined }
    },
    retainInfo: (id: string) => ({
      getSnapshot: () => ({ retainedBy: { mainView: currentSession === id ? 1 : 0 } }),
      subscribe: () => () => undefined
    })
  }
  const uiWorkspace = {
    // 真实官方导航是「提交后下一拍生效」：由测试显式 setCurrentSession 推进
    openSession: (id: string) => { opened.push(id) }
  }
  const services: Record<string, unknown> = { sessions: sessionsService, uiWorkspace, conversation }
  const ctx = { get: (name: string) => services[name] ?? null }

  ;(window as unknown as { fetch: unknown }).fetch = (input: string | { url?: string }) => {
    const url = typeof input === 'string' ? input : String(input.url ?? '')
    const d = deferred<{ ok: boolean; json: () => Promise<unknown> }>()
    calls.push({ url, deferred: d })
    return d.promise as unknown as Promise<Response>
  }

  let module: { apply: (ctx: unknown) => void } | null = null
  ;(window as unknown as { __ModuleLoader__: unknown }).__ModuleLoader__ = {
    load: (entry: { factory: () => { apply: (ctx: unknown) => void } }) => {
      module = entry.factory()
      // 装载即 apply（与官方 loader 一致）：start() 在 apply 里完成
      module.apply(ctx)
    }
  }
  // 每次重新执行源码，保证拿到全新的 controller（模块级状态不跨用例）
  const run = new Function(`${CLIENT_SOURCE}\n//# sourceURL=lyshell-client-test.js`)
  run()

  return {
    calls,
    opened,
    presence: () => (globalThis as unknown as { __LYSHELL_HARNESS_CLIENT__: Presence }).__LYSHELL_HARNESS_CLIENT__,
    setCurrentSession: (id) => { currentSession = id },
    emitSessionsChanged: () => { for (const fn of sessionListeners) fn() },
    respond: (index, body, ok = true) => {
      calls[index].deferred.resolve({ ok, json: async () => body })
    },
    lastCallFor: (url) => {
      for (let i = calls.length - 1; i >= 0; i -= 1) if (calls[i].url === url) return i
      return -1
    }
  }
}

function statusBody(over: {
  request?: { requestId: string; sessionId: string; revision: number; epoch: number; requestedAt: number } | null
  owned?: boolean
  readOnly?: boolean
  currentSessionId?: string | null
  revision?: number
} = {}): Record<string, unknown> {
  return {
    ok: true,
    held: over.readOnly === true,
    readOnly: over.readOnly === true,
    phase: over.readOnly ? 'held' : 'free',
    epoch: 3,
    reason: over.readOnly ? 'held' : null,
    viewer: {
      revision: over.revision ?? 100,
      appliedRevision: 0,
      currentSessionId: over.currentSessionId ?? null,
      petSessionId: 'session-pet',
      request: over.request ?? null,
      lastAck: null,
      connected: true,
      updatedAt: Date.now(),
      ownedByCurrentViewer: over.owned !== false
    },
    gatedPaths: ['/api/session/prompt']
  }
}

const navRequest = (requestId: string, sessionId = 'session-pet', revision = 100) => ({
  requestId, sessionId, revision, epoch: 3, requestedAt: Date.now()
})

let harness: Harness

beforeEach(() => {
  vi.useFakeTimers()
  delete (globalThis as unknown as { __LYSHELL_HARNESS_CLIENT__?: unknown }).__LYSHELL_HARNESS_CLIENT__
  harness = mountClient()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('client 半：异步竞态与一次性语义', () => {
  it('重叠 status：只有最后发出那一次的响应能落地（旧响应不得覆盖新状态）', async () => {
    const first = harness.lastCallFor(STATUS_URL)
    // 第一次还没回，下一拍定时器又发了第二次
    await vi.advanceTimersByTimeAsync(1000)
    const second = harness.lastCallFor(STATUS_URL)
    expect(second).toBeGreaterThan(first)

    // 先让**旧**响应落地：它带着一条导航请求与旧只读态 —— 一个副作用都不许发生
    harness.respond(first, statusBody({
      request: navRequest('req-old', 'session-old-nav'),
      readOnly: false,
      currentSessionId: 'session-old',
      revision: 100
    }))
    await vi.advanceTimersByTimeAsync(600)
    expect(harness.opened).toEqual([])
    expect(harness.presence().pendingNavigation).toBeNull()

    // 新的那一拍才是有效状态
    harness.respond(second, statusBody({ readOnly: true, currentSessionId: 'session-new', revision: 200 }))
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.presence().readOnly).toBe(false)
  })

  it('旧 ack 的 then 不得清掉新导航的定时器（新导航仍能落地、且只 ack 一次）', async () => {
    harness.setCurrentSession('session-initial')
    const callA = harness.lastCallFor(STATUS_URL)
    harness.respond(callA, statusBody({ request: navRequest('req-A', 'session-a') }))
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.opened).toEqual(['session-a'])

    // A 触发 ack（官方 UI 实际到达 session-a）→ ack 请求悬挂，回调还没执行
    harness.setCurrentSession('session-a')
    await vi.advanceTimersByTimeAsync(400)
    const ackA = harness.lastCallFor(ACK_URL)
    expect(ackA).toBeGreaterThan(-1)
    expect(harness.presence().pendingNavigation).toBe('req-A')

    // 新的一拍带来请求 B：A 的验证定时器作废，B 登记自己的
    harness.setCurrentSession('session-c')
    await vi.advanceTimersByTimeAsync(1000)
    const callB = harness.lastCallFor(STATUS_URL)
    harness.respond(callB, statusBody({ request: navRequest('req-B', 'session-b'), currentSessionId: 'session-c', revision: 200 }))
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.opened).toEqual(['session-a', 'session-b'])
    expect(harness.presence().pendingNavigation).toBe('req-B')

    // 迟到的 A ack 回调落地：它绝不能把 B 的等待搞坏
    harness.respond(ackA, { ok: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.presence().pendingNavigation).toBe('req-B')

    // B 仍能正常落地：官方 UI 到达 session-b → ack 一次（响应照常回，pending 随之清空）
    const ackBefore = harness.calls.filter((c) => c.url === ACK_URL).length
    harness.setCurrentSession('session-b')
    await vi.advanceTimersByTimeAsync(400)
    const ackCalls = harness.calls.filter((c) => c.url === ACK_URL)
    expect(ackCalls.length).toBe(ackBefore + 1)
    harness.respond(harness.lastCallFor(ACK_URL), { ok: true })
    await vi.advanceTimersByTimeAsync(0)
    // 下一拍 status 里桥已不再报这条请求 ⇒ 本地等待也必须收尾（不会永远停在「等待确认」）
    await vi.advanceTimersByTimeAsync(1100)
    expect(harness.presence().pendingNavigation).toBeNull()

    // 同一请求只 ack 一次：继续推进时间不会重复上报
    await vi.advanceTimersByTimeAsync(3000)
    expect(harness.calls.filter((c) => c.url === ACK_URL).length).toBe(ackCalls.length)
  })

  it('官方界面已在目标会话时用真实当前状态 ack，不重复调用导航服务', async () => {
    harness.respond(harness.lastCallFor(STATUS_URL), statusBody({ request: navRequest('req-current', 'session-a') }))
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.opened).toEqual([])
    expect(harness.calls.filter(call => call.url === ACK_URL)).toHaveLength(1)
  })

  it('归属不属于本浏览器的请求：不应用导航（另一浏览器不能替我导航）', async () => {
    const call = harness.lastCallFor(STATUS_URL)
    harness.respond(call, statusBody({ request: navRequest('req-other'), owned: false }))
    await vi.advanceTimersByTimeAsync(600)
    expect(harness.opened).toEqual([])
    expect(harness.presence().pendingNavigation).toBeNull()
  })

  it('用户浏览推进 revision：作废未落地请求并如实上报 browse（不被拽回）', async () => {
    const call = harness.lastCallFor(STATUS_URL)
    harness.respond(call, statusBody({ request: navRequest('req-A', 'session-pet'), currentSessionId: 'session-other' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.presence().pendingNavigation).toBe('req-A')

    // 窗口内先静默观察（导航自身的过渡不算用户浏览）—— 之后用户才真的切到历史会话
    await vi.advanceTimersByTimeAsync(1300)
    harness.setCurrentSession('session-history')
    harness.emitSessionsChanged()
    await vi.advanceTimersByTimeAsync(0)

    expect(harness.calls.filter((c) => c.url === BROWSE_URL).length).toBe(1)
    expect(harness.presence().pendingNavigation).toBeNull()
  })

  it('共享工作台不拦写请求，即使迟到旧状态声称只读', async () => {
    const call = harness.lastCallFor(STATUS_URL)
    harness.respond(call, statusBody({ readOnly: true }))
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.presence().readOnly).toBe(false)

    // 写路径：被浏览器侧门禁拒绝（拒绝原因带固定码 lyshell/readonly）
    void window.fetch('/api/session/prompt', { method: 'POST' })
    expect(harness.calls.filter(c => c.url === '/api/session/prompt')).toHaveLength(1)
    // 只读路径（历史/列表）照常放行到真实 fetch（即被我们的替身记录下来）
    void window.fetch('/api/session/list', { method: 'GET' })
    const recorded = harness.calls.filter((c) => c.url === '/api/session/list')
    expect(recorded.length).toBe(1)
  })
})
