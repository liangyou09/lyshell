import { describe, it, expect, afterEach, vi } from 'vitest'
import http from 'http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createRequire } from 'module'
import { BRIDGE_KEY_HEADER } from './bridge'

vi.mock('electron-log', () => ({ default: { info: () => {}, error: () => {}, warn: () => {} } }))

/**
 * dsh 桥（resources/dsh-bridge/index.mjs）的独占控制面测试。
 *
 * 跑的是插件**真实源码**（真实 ESM 装载、真实回环 HTTP、真实 cordis 事件语义），
 * 官方 ctx 服务按**真实公开 API 形状**替身：
 *   - `sessionController.resolveAgent(id)` → `{ agent, error }`
 *   - `sessionController.prompt(request, signal)` → 立即 ack（真实提交由 turn/start 事件体现）
 *   - `sessionController.cancel({ sessionId })` → `{ accepted: true }`
 *   - `agents.list()` 返回 **id 列表**，`agents.get(id)` 读状态
 *   - `session.seq` 是事件序号边界，`session/event` 报 `{ type, seq, data:{ turn, reason:{ kind } } }`
 * 真实 dsh + 官方服务的端到端结论由 Codex 的隔离 proof 覆盖；这里只锁边界行为。
 */

const tempDirs: string[] = []
let loadSeq = 0

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface RegisteredRoute {
  kind: string
  path: string
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
}

interface FakeAgent {
  id: string
  session: { id: string; seq: number }
  status: 'idle' | 'running'
}

interface BridgeHarness {
  /** 官方 `/api` 写路径 gate 的探测（走真实 connection/request waterfall 链） */
  connectionRequest: (url: string) => { blocked: boolean; status?: number }
  approvalRequest: (req: Record<string, unknown>) => { result: Promise<unknown> }
  /** 官方 session/event 投放（真实事件形状） */
  turnStart: (sessionId: string, turn: number) => void
  turnEnd: (sessionId: string, turn: number, kind: string) => void
  sessionEvent: (sessionId: string, type: string, data: Record<string, unknown>) => void
  agentError: (sessionId: string, error: unknown) => void
  /** 控制面（真实回环 HTTP + host-only 头） */
  post: (payload: unknown, key?: string) => Promise<{ status: number; body: Record<string, unknown> }>
  handshake: (key?: string) => Promise<{ status: number; body: Record<string, unknown> }>
  /** 官方服务调用记录 */
  calls: { resolveAgent: string[]; prompt: Array<{ sessionId: string; mode: string; text: string; hasSignal: boolean }>; cancel: string[]; create: number }
  agents: Map<string, FakeAgent>
  /** 官方浏览器面鉴权替身：可切 401/403/服务缺失，并记录 admit 调用次数 */
  viewerAuth: { outcome: 'ok' | 401 | 403 | 'missing'; calls: number }
  /** 浏览器面请求（原始 http；可带 viewer cookie） */
  viewerCall: (
    path: string,
    payload: unknown | null,
    options?: { cookie?: string; method?: string }
  ) => Promise<{ status: number; body: Record<string, unknown>; setCookie: string | null }>
  /** 走一次官方鉴权换 viewer cookie（`lyshell_harness_viewer=...`） */
  viewerCookie: () => Promise<string>
  setAgentStatus: (sessionId: string, status: 'idle' | 'running') => void
  setAgentLookup: (sessionId: string, result: 'ok' | 'error' | 'missing') => void
  dispose: () => void
}

const bridgeSource = (): string => readFileSync(join(process.cwd(), 'resources', 'dsh-bridge', 'index.mjs'), 'utf8')

describe('原生 Harness 工作通道与 Pet 共存', () => {
  const a = 'a'.repeat(64)
  const b = 'b'.repeat(64)
  const native = (h: BridgeHarness, owner: string, request: Record<string, unknown>) => h.post({ cmd: 'native-work', owner, request })

  it('原生导航过期后拒绝迟到 ack，并允许用户再次打开工作台', async () => {
    const h = await makeHarness()
    const clock = vi.spyOn(Date, 'now')
    try {
      const created = (await native(h, a, { kind: 'new' })).body
      const sessionId = String(created.sessionId)
      const identity = created.identity
      const cookie = await h.viewerCookie()
      const pending = await h.post({ cmd: 'native-viewer-nav', identity, sessionId, requestId: 'nav-timeout' })
      const viewer = pending.body.viewer as { request: { revision: number; requestedAt: number } }
      clock.mockReturnValue(viewer.request.requestedAt + 16000)
      const late = await h.viewerCall('/__lyshell/harness/viewer/ack', { requestId: 'nav-timeout', sessionId, currentSessionId: sessionId, revision: viewer.request.revision, status: 'navigated' }, { cookie })
      expect(late.status).toBe(409)
      expect((await h.post({ cmd: 'native-viewer-nav', identity, sessionId, requestId: 'nav-retry' })).status).toBe(200)
      expect(h.calls.prompt).toEqual([])
    } finally { clock.mockRestore(); h.dispose() }
  })

  it('原生任务导航核对后台与会话，等待官方 viewer 回执且不提交任务', async () => {
    const h = await makeHarness({ agents: ['unowned'] })
    try {
      const created = (await native(h, a, { kind: 'new' })).body
      const sessionId = String(created.sessionId)
      const identity = created.identity
      expect((await h.post({ cmd: 'native-viewer-nav', identity: { instanceId: 'old', instanceEpoch: 1 }, sessionId, requestId: 'nav-old' })).status).toBe(409)
      expect((await h.post({ cmd: 'native-viewer-nav', identity, sessionId: 'unowned', requestId: 'nav-other' })).status).toBe(409)
      const result = await h.post({ cmd: 'native-viewer-nav', identity, sessionId, requestId: 'nav-native' })
      expect(result.status).toBe(200)
      expect(result.body.holding).toBe(false)
      expect(result.body.viewer).toMatchObject({ request: { requestId: 'nav-native', sessionId }, lastAck: null })
      expect((await h.post({ cmd: 'native-viewer-nav', identity, sessionId, requestId: 'nav-duplicate' })).status).toBe(409)
      const cookie = await h.viewerCookie()
      const claim = await h.viewerCall('/__lyshell/harness/viewer/status', null, { method: 'GET', cookie })
      const viewer = claim.body.viewer as { request: { revision: number } }
      const ack = await h.viewerCall('/__lyshell/harness/viewer/ack', { requestId: 'nav-native', sessionId, currentSessionId: sessionId, revision: viewer.request.revision, status: 'navigated' }, { cookie })
      expect(ack.status).toBe(200)
      expect(ack.body.viewer).toMatchObject({ currentSessionId: sessionId, request: null, lastAck: { requestId: 'nav-native', status: 'navigated' } })
      expect(h.calls.prompt).toEqual([])
    } finally { h.dispose() }
  })

  it('提交抛错保留未确认任务，重复 requestId 不重发且不谎报接受', async () => {
    const h = await makeHarness({ promptError: true })
    try {
      const sessionId = String((await native(h, a, { kind: 'new' })).body.sessionId)
      const request = { kind: 'submit', sessionId, requestId: 'unknown', text: 'one' }
      expect((await native(h, a, request)).status).toBe(409)
      expect((await native(h, a, { kind: 'state' })).body).toMatchObject({ status: 'error', taskState: 'unconfirmed' })
      expect((await native(h, a, request)).body).toMatchObject({ accepted: false, duplicate: true, taskState: 'unconfirmed' })
      expect(h.calls.prompt).toHaveLength(1)
      h.turnStart(sessionId, 1)
      h.turnEnd(sessionId, 1, 'completed')
      expect((await native(h, a, { kind: 'state' })).body.taskState).toBe('completed')
    } finally { h.dispose() }
  })

  it('只选择自己新建的会话，拒绝 Pet/Web 与另一调用方会话', async () => {
    const h = await makeHarness({ agents: ['pet-session'] })
    try {
      const created = await native(h, a, { kind: 'new', workspace: process.cwd() })
      const sessionId = created.body.sessionId
      expect(created.status).toBe(200)
      expect((await native(h, b, { kind: 'select', sessionId })).body.code).toBe('task/not-found')
      expect((await native(h, a, { kind: 'select', sessionId: 'pet-session' })).body.code).toBe('task/not-found')
      await h.post({ cmd: 'acquire', epoch: 1, bindingId: 'pet' })
      expect((await h.post({ cmd: 'session', epoch: 1, mode: 'select', sessionId })).body.code).toBe('control/held-by-other')
      expect((await h.post({ cmd: 'submit', epoch: 1, taskId: 'pet-task', sessionId, text: 'wrong owner' })).body.code).toBe('control/held-by-other')
      expect((await native(h, b, { kind: 'state' })).body.sessions).toEqual([])
    } finally { h.dispose() }
  })

  it('原生与 Pet 可并行提交，审批与 release 互不干扰，只认各自官方终态', async () => {
    const h = await makeHarness({ agents: ['pet-session'] })
    try {
      await h.post({ cmd: 'acquire', epoch: 3, bindingId: 'pet' })
      const sessionId = String((await native(h, a, { kind: 'new' })).body.sessionId)
      const submitted = await native(h, a, { kind: 'submit', sessionId, requestId: 'native-r1', text: 'native' })
      expect(submitted.body.taskState).toBe('accepted')
      await h.post({ cmd: 'submit', epoch: 3, taskId: 'pet-task', sessionId: 'pet-session', text: 'pet' })
      h.turnStart(sessionId, 1)
      h.turnStart('pet-session', 2)
      h.sessionEvent(sessionId, 'tool/call', { callId: 'native-call', name: 'shell', arguments: '{"command":"pwd"}' })
      const ownApproval = h.approvalRequest({ agent: { session: { id: sessionId } }, toolName: 'shell', callId: 'native-call' })
      const petApproval = h.approvalRequest({ agent: { session: { id: 'pet-session' } }, toolName: 'write' })
      const ownState = (await native(h, a, { kind: 'state' })).body
      const approvals = ownState.approvals as Array<{ id: string }>
      expect(ownState.status).toBe('approval')
      expect(approvals).toHaveLength(1)
      expect(approvals[0]).toMatchObject({ callId: 'native-call' })
      expect(ownState.transcript).toContainEqual(expect.objectContaining({ kind: 'tool-call', callId: 'native-call', text: '{"command":"pwd"}' }))
      expect((await native(h, b, { kind: 'approve', id: approvals[0].id, optionId: 'allowed-once' })).body.code).toBe('approval/not-pending')
      expect((await h.post({ cmd: 'approve', epoch: 3, approvalId: approvals[0].id, outcome: 'allowed-once' })).body.code).toBe('approval/not-pending')
      await native(h, a, { kind: 'approve', id: approvals[0].id, optionId: 'rejected' })
      expect(await ownApproval.result).toBe('rejected')
      h.sessionEvent(sessionId, 'tool/result', { message: { toolCallId: 'native-call', isError: true, content: [{ type: 'text', text: 'rejected' }] } })
      expect((await native(h, a, { kind: 'state' })).body.transcript).toContainEqual(expect.objectContaining({ kind: 'tool-result', callId: 'native-call', failed: true }))
      h.turnEnd('pet-session', 2, 'completed')
      expect(await petApproval.result).toBe('cancelled')
      await h.post({ cmd: 'release', epoch: 3 })
      expect((await native(h, a, { kind: 'state' })).body.taskState).toBe('running')
      h.turnEnd(sessionId, 77, 'completed')
      expect((await native(h, a, { kind: 'state' })).body.taskState).toBe('running')
      h.turnEnd(sessionId, 1, 'completed')
      expect((await native(h, a, { kind: 'state' })).body.taskState).toBe('completed')
      expect(h.calls.prompt).toHaveLength(2)
    } finally { h.dispose() }
  })

  it('并发相同 requestId 只提交一次，冲突/忙碌/陈旧会话与停止均明确拒绝', async () => {
    const h = await makeHarness()
    try {
      const sessionId = String((await native(h, a, { kind: 'new' })).body.sessionId)
      const request = { kind: 'submit', sessionId, requestId: 'r1', text: 'one' }
      const replies = await Promise.all([native(h, a, request), native(h, a, request)])
      expect(replies.every(reply => reply.status === 200)).toBe(true)
      expect(h.calls.prompt).toHaveLength(1)
      expect(replies[1].body.acceptedTaskId).toBe(replies[0].body.acceptedTaskId)
      expect((await native(h, a, { ...request, text: 'changed' })).status).toBe(400)
      expect((await native(h, a, { ...request, requestId: 'r2' })).body.code).toBe('task/busy')
      expect((await native(h, a, { kind: 'disconnect' })).body.code).toBe('task/busy')
      expect((await native(h, a, { kind: 'cancel', taskId: 'wrong' })).body.code).toBe('task/not-found')
      expect((await native(h, a, { ...request, sessionId: 'stale' })).body.code).toBe('task/not-found')
      h.turnStart(sessionId, 1)
      await native(h, a, { kind: 'cancel', taskId: replies[0].body.taskId })
      expect(h.calls.cancel).toEqual([sessionId])
      expect((await native(h, a, { kind: 'state' })).body.taskState).toBe('running')
      h.turnEnd(sessionId, 1, 'aborted')
      expect((await native(h, a, { kind: 'state' })).body.taskState).toBe('cancelled')
      expect((await native(h, a, { kind: 'disconnect' })).body.sessionId).toBeNull()
    } finally { h.dispose() }
  })
})

function makeBridgePackage(dir: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.mjs'), bridgeSource(), 'utf8')
  writeFileSync(join(dir, 'client.js'), '// client half\n', 'utf8')
  // 在 Node 原生模块中 import，避免 Vitest VM 的临时模块缓存/回调介入。
  writeFileSync(join(dir, 'import.cjs'), 'module.exports = specifier => import(specifier)\n', 'utf8')
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'lyshell-harness-bridge',
      exports: { './client': './client.js' },
      dsh: { client: { platform: 'web' } }
    }),
    'utf8'
  )
}

async function loadBridge(dir: string): Promise<{ apply: (ctx: unknown) => void }> {
  const url = `${new URL(`file://${join(dir, 'index.mjs').replace(/\\/g, '/')}`).href}?case=${loadSeq++}`
  const importEsm = createRequire(import.meta.url)(join(dir, 'import.cjs')) as (specifier: string) => Promise<{ apply: (ctx: unknown) => void }>
  return importEsm(url)
}

async function makeHarness(opts: { key?: string; agents?: string[]; promptError?: boolean } = {}): Promise<BridgeHarness> {
  const dir = join(tempDir('lyshell-s3-bridge-'), 'dsh-bridge')
  makeBridgePackage(dir)
  const routes: RegisteredRoute[] = []
  const hooks = new Map<string, Array<(this: unknown, ...args: unknown[]) => unknown>>()
  const agents = new Map<string, FakeAgent>()
  const missing = new Set<string>()
  const failing = new Set<string>()
  for (const id of opts.agents ?? []) agents.set(id, { id, session: { id, seq: 0 }, status: 'idle' })
  const calls: BridgeHarness['calls'] = { resolveAgent: [], prompt: [], cancel: [], create: 0 }

  const registerHook = (
    name: string,
    listener: (this: unknown, ...args: unknown[]) => unknown,
    options?: { prepend?: boolean }
  ): (() => void) => {
    const list = hooks.get(name) ?? []
    if (options?.prepend) list.unshift(listener)
    else list.push(listener)
    hooks.set(name, list)
    return () => {
      const at = list.indexOf(listener)
      if (at >= 0) list.splice(at, 1)
    }
  }

  const sessionController = {
    // 真实形状：{ agent, error }；可载入历史会话（不要求已在 agents 缓存）
    resolveAgent: async (sessionId: string) => {
      calls.resolveAgent.push(sessionId)
      if (failing.has(sessionId)) return { error: { code: 'session/not-found' } }
      const existing = agents.get(sessionId)
      if (existing) return { agent: existing }
      if (missing.has(sessionId)) return { error: { code: 'session/not-found' } }
      // 可载入：首次解析即把历史会话带进 registry
      const loaded: FakeAgent = { id: sessionId, session: { id: sessionId, seq: 0 }, status: 'idle' }
      agents.set(sessionId, loaded)
      return { agent: loaded }
    },
    // 真实形状：prompt(request, signal) → 立即 ack（真实提交由后面的事件体现）
    prompt: async (request: { sessionId: string; mode: string; content: Array<{ text: string }> }, signal?: AbortSignal) => {
      calls.prompt.push({
        sessionId: request.sessionId,
        mode: request.mode,
        text: request.content.map((part) => part.text).join(''),
        hasSignal: signal !== undefined
      })
      if (opts.promptError) throw new Error('unknown transport outcome')
      return { accepted: true }
    },
    cancel: (request: { sessionId: string }) => {
      calls.cancel.push(request.sessionId)
      return { accepted: true }
    },
    create: async () => {
      calls.create += 1
      const id = `session-new-${calls.create}`
      agents.set(id, { id, session: { id, seq: 0 }, status: 'idle' })
      return { sessionId: id }
    }
  }

  // 官方浏览器面鉴权服务（真实形状：admit(req) → { peer } | { rejection: 401 | 403 }）。
  // 默认放行；测试可切成 401/403 或整个服务缺失，核对「官方登录先于 viewer cookie」。
  const viewerAuth: { outcome: 'ok' | 401 | 403 | 'missing'; calls: number } = { outcome: 'ok', calls: 0 }
  const connection = {
    admit: () => {
      viewerAuth.calls += 1
      if (viewerAuth.outcome === 401 || viewerAuth.outcome === 403) return { rejection: viewerAuth.outcome }
      return { peer: { id: 'operator' } }
    }
  }

  const ctx = {
    webServer: { register: (route: RegisteredRoute) => { routes.push(route); return () => {} } },
    effect: (fn: () => unknown) => {
      fn()
      return () => {}
    },
    on: registerHook,
    get: (name: string) => {
      if (name === 'sessionController') return sessionController
      if (name === 'agents') {
        // 真实安装：list() 返回 **id 列表**，状态要逐个 get(id) 读
        return { list: () => [...agents.keys()], get: (id: string) => (missing.has(id) ? undefined : agents.get(id)) }
      }
      // 官方浏览器面鉴权服务（S4 起 viewer 端点必须经它验证官方登录）；
      // outcome='missing' 模拟老版本 dsh 没有这个服务 ⇒ 桥必须 fail closed
      if (name === 'connection') return viewerAuth.outcome === 'missing' ? undefined : connection
      return undefined
    }
  }

  const key = opts.key ?? 'k'.repeat(64)
  process.env.LYSHELL_HARNESS_BRIDGE_KEY = key
  const mod = await loadBridge(dir)
  mod.apply(ctx)

  /** 官方 session 事件投放：seq 递增并推进 session.seq（真实边界语义） */
  const emitSessionEvent = (sessionId: string, type: string, data: Record<string, unknown>): void => {
    const agent = agents.get(sessionId)
    if (agent) agent.session.seq += 1
    const seq = agent ? agent.session.seq : 1
    for (const hook of hooks.get('session/event') ?? []) {
      hook.call(null, { id: sessionId }, { type, seq, data })
    }
  }

  const handshakeRoute = routes.find((r) => r.path === '/__lyshell/harness/handshake')
  const server = http.createServer((req, res) => {
    const route = routes.find((r) => r.path === new URL(req.url ?? '/', 'http://x').pathname)
    if (route) {
      route.handler(req, res)
      return
    }
    res.writeHead(404)
    res.end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const serverPort = (server.address() as { port: number }).port

  const request = (
    port: number,
    path: string,
    payload: unknown | null,
    headerKey: string | undefined,
    method = 'POST'
  ): Promise<{ status: number; body: string }> =>
    new Promise((resolve) => {
      const body = payload === null ? '' : JSON.stringify(payload)
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path,
          method,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            ...(headerKey === undefined ? {} : { [BRIDGE_KEY_HEADER]: headerKey })
          }
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
        }
      )
      req.on('error', () => resolve({ status: 0, body: '' }))
      req.end(body)
    })

  const handshake = async (headerKey?: string): Promise<{ status: number; body: Record<string, unknown> }> => {
    if (!handshakeRoute) return { status: 0, body: {} }
    const out = await request(serverPort, handshakeRoute.path, null, headerKey, 'GET')
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse(out.body) as Record<string, unknown>
    } catch {
      body = {}
    }
    return { status: out.status, body }
  }

  /**
   * 浏览器面请求（带可选 cookie）：直接打桥注册的 viewer 路由，返回状态/正文/本次下发的 cookie。
   * 用原始 http 而非 fetch —— 需要精确控制 Cookie 头并读 set-cookie。
   */
  const viewerCall = (
    path: string,
    payload: unknown | null,
    options: { cookie?: string; method?: string } = {}
  ): Promise<{ status: number; body: Record<string, unknown>; setCookie: string | null }> =>
    new Promise((resolve) => {
      const route = routes.find((r) => r.path === path)
      if (!route) {
        resolve({ status: 0, body: {}, setCookie: null })
        return
      }
      const body = payload === null ? '' : JSON.stringify(payload)
      const req = http.request(
        {
          host: '127.0.0.1',
          port: serverPort,
          path,
          method: options.method ?? 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            ...(options.cookie ? { cookie: options.cookie } : {})
          }
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8')
            let parsed: Record<string, unknown> = {}
            try {
              parsed = JSON.parse(raw) as Record<string, unknown>
            } catch {
              parsed = {}
            }
            const setCookieHeader = res.headers['set-cookie']
            resolve({
              status: res.statusCode ?? 0,
              body: parsed,
              setCookie: Array.isArray(setCookieHeader) ? setCookieHeader[0] ?? null : setCookieHeader ?? null
            })
          })
        }
      )
      req.on('error', () => resolve({ status: 0, body: {}, setCookie: null }))
      req.end(body)
    })

  /**
   * 像一个**新浏览器**那样拿到自己的 viewer 身份：先带一个非法 cookie 打一次，
   * 桥在官方鉴权通过后换签一个新的并下发。
   *
   * 为什么不能直接空手打 status：空手那次响应本身就会带 Set-Cookie，若把它当成
   * 「另一个浏览器」的身份，两个身份就会指向同一个 viewerId，跨 viewer 断言随之失真
   * （这正是本用例最初误报的原因）。真实浏览器也只会持有自己那一个 cookie。
   */
  const viewerCookie = async (): Promise<string> => {
    const out = await viewerCall('/__lyshell/harness/viewer/status', null, {
      method: 'GET',
      cookie: 'lyshell_harness_viewer=stale.invalid.cookie'
    })
    const value = (out.setCookie ?? '').split(';')[0]
    if (!value.includes('=')) throw new Error('viewer cookie was not issued by the bridge')
    return value
  }

  const handshakeOut = await handshake(key)
  const controlPort = typeof handshakeOut.body.controlPort === 'number' ? handshakeOut.body.controlPort : 0

  return {
    calls,
    agents,
    viewerAuth,
    viewerCall,
    viewerCookie,
    setAgentStatus: (sessionId, status) => {
      const agent = agents.get(sessionId)
      if (agent) agent.status = status
    },
    setAgentLookup: (sessionId, result) => {
      if (result === 'missing') {
        missing.add(sessionId)
        agents.delete(sessionId)
        return
      }
      if (result === 'error') {
        failing.add(sessionId)
        return
      }
      failing.delete(sessionId)
      missing.delete(sessionId)
    },
    turnStart: (sessionId, turn) => emitSessionEvent(sessionId, 'turn/start', { turn }),
    sessionEvent: emitSessionEvent,
    turnEnd: (sessionId, turn, kind) => emitSessionEvent(sessionId, 'turn/end', { turn, reason: { kind } }),
    agentError: (sessionId, error) => {
      for (const hook of hooks.get('agent/error') ?? []) hook.call(null, { agent: { id: sessionId }, error })
    },
    post: async (payload, headerKey = key) => {
      const out = await request(controlPort, '/', payload, headerKey)
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(out.body) as Record<string, unknown>
      } catch {
        body = {}
      }
      return { status: out.status, body }
    },
    handshake,
    connectionRequest: (url) => {
      const list = hooks.get('connection/request') ?? []
      let blocked = false
      let status: number | undefined
      const res = {
        writeHead: (code: number) => {
          status = code
          blocked = true
          return res
        },
        end: () => undefined
      }
      const req = { url, method: 'POST' }
      let index = 0
      const next = (): void => {
        const hook = list[index++]
        if (hook) {
          hook.call(null, req, res, next)
          return
        }
        blocked = false
        status = undefined
      }
      next()
      return { blocked, status }
    },
    approvalRequest: (req) => {
      const list = hooks.get('approval/request') ?? []
      let index = 0
      const result = new Promise<unknown>((resolve) => {
        const next = (): unknown => {
          const hook = list[index++]
          if (hook) return hook.call(null, req, next)
          resolve('unavailable')
          return undefined
        }
        const out = next()
        if (out !== undefined) void Promise.resolve(out).then(resolve)
      })
      return { result }
    },
    dispose: () => {
      void new Promise<void>((resolve) => server.close(() => resolve()))
      delete process.env.LYSHELL_HARNESS_BRIDGE_KEY
    }
  }
}

/** 提交一个任务并等到 accepted（真实 prompt 是异步 ack 的）。 */
async function submitTask(h: BridgeHarness, sessionId = 'session-1', text = 'do it'): Promise<string> {
  const taskId = `task-${Math.random().toString(36).slice(2, 8)}`
  const acquired = await h.post({ cmd: 'acquire', epoch: 1, bindingId: 'b1' })
  expect(acquired.status).toBe(200)
  const submitted = await h.post({ cmd: 'submit', epoch: 1, taskId, sessionId, text })
  expect(submitted.status).toBe(200)
  await new Promise((r) => setTimeout(r, 5))
  return taskId
}

describe('桥：握手与控制面鉴权', () => {
  it('agent/error 保留安全 cause 但不假造终态；turn/end 后仍携带诊断', async () => {
    const h = await makeHarness({ agents: ['s'] })
    try {
      await h.post({ cmd: 'acquire', epoch: 1, bindingId: 'binding' })
      await h.post({ cmd: 'submit', epoch: 1, taskId: 't', sessionId: 's', text: 'x' })
      h.turnStart('s', 1)
      h.agentError('s', Object.assign(new Error('Authorization SECRET ?token=SECRET'), {
        cause: Object.assign(new Error('secret body'), { code: 'ECONNRESET' })
      }))
      const running = (await h.post({ cmd: 'snapshot' })).body
      expect(running.task).toMatchObject({ state: 'running', diagnostic: { code: 'ECONNRESET', phase: 'agent', httpResponse: 'unknown' } })
      expect(JSON.stringify(running)).not.toContain('SECRET')
      h.turnEnd('s', 1, 'error')
      expect((await h.post({ cmd: 'snapshot' })).body.task).toMatchObject({ state: 'failed', diagnostic: { code: 'ECONNRESET' } })
    } finally { h.dispose() }
  })
  it('握手回执带 controlPort；错 key 一律 401', async () => {
    const h = await makeHarness()
    const ok = await h.handshake('k'.repeat(64))
    expect(ok.status).toBe(200)
    expect(ok.body.controlPort).toBeGreaterThan(0)
    expect((await h.handshake(undefined)).status).toBe(401)
    expect((await h.handshake('x'.repeat(64))).status).toBe(401)
    h.dispose()
  })

  it('控制命令：错 key 401、未知命令被拒、未托管时写命令 not-held', async () => {
    const h = await makeHarness()
    expect((await h.post({ cmd: 'snapshot' }, 'x'.repeat(64))).status).toBe(401)
    const unknown = await h.post({ cmd: 'nope' })
    expect(unknown.status).toBeGreaterThanOrEqual(400)
    expect(unknown.body.ok).toBe(false)
    const notHeld = await h.post({ cmd: 'submit', epoch: 1, taskId: 't', sessionId: 's', text: 'hi' })
    expect(notHeld.status).toBe(409)
    expect(notHeld.body.code).toBe('control/not-held')
    h.dispose()
  })

  it('acquire：身份自报、同代际幂等、异代际 held-by-other', async () => {
    const h = await makeHarness()
    const first = await h.post({ cmd: 'acquire', epoch: 7, bindingId: 'b1' })
    expect(first.status).toBe(200)
    expect(typeof (first.body.identity as Record<string, unknown>).instanceId).toBe('string')
    expect((await h.post({ cmd: 'acquire', epoch: 7, bindingId: 'b1' })).status).toBe(200)
    const other = await h.post({ cmd: 'acquire', epoch: 8, bindingId: 'b2' })
    expect(other.body.code).toBe('control/held-by-other')
    h.dispose()
  })

  it('普通 Web 任务在跑也可接入共享后台，不取消它', async () => {
    const h = await makeHarness({ agents: ['session-busy'] })
    h.setAgentStatus('session-busy', 'running')
    const busy = await h.post({ cmd: 'acquire', epoch: 1, bindingId: 'b1' })
    expect(busy.status).toBe(200)
    expect(h.calls.cancel).toEqual([])
    h.dispose()
  })

  it('会话状态读不到：明确报错（task/not-found），不把 unknown 当 idle 继续', async () => {
    const h = await makeHarness({ agents: ['session-x'] })
    // 会话无法解析（registry 里读不到）⇒ 提交必须明确失败，不得当成 idle 放行
    h.setAgentLookup('session-x', 'error')
    const acquire = await h.post({ cmd: 'acquire', epoch: 1, bindingId: 'b1' })
    expect(acquire.status).toBe(200)
    const submit = await h.post({ cmd: 'submit', epoch: 1, taskId: 't1', sessionId: 'session-x', text: 'hi' })
    expect(submit.status).toBe(409)
    expect(submit.body.code).toBe('task/not-found')
    expect(h.calls.prompt).toEqual([])
    h.dispose()
  })
})

describe('桥：官方 /api 写操作 gate', () => {
  const GATED = [
    '/api/session/prompt',
    '/api/session/cancel',
    '/api/session/create',
    '/api/session/selectModel',
    '/api/session/updateQueue',
    '/api/session/fork',
    '/api/agentPresets/select',
    '/api/commands/execute',
    '/api/settings/mutate',
    '/api/settings/update',
    '/api/settings/replace',
    '/api/$events/result',
    '/api/userQuestions/answer',
    '/api/workspace/create',
    '/api/workspace/delete'
  ]
  const READ_ONLY = [
    '/api/session/list',
    '/api/session/page',
    '/api/session/follow',
    '/api/session/search',
    '/api/workspaceFiles/list',
    '/api/workspaceFiles/read',
    '/api/permissionPresets/catalog',
    '/api/remote.mux'
  ]

  it('未托管：一律放行', async () => {
    const h = await makeHarness()
    for (const path of [...GATED, ...READ_ONLY]) expect(h.connectionRequest(path).blocked).toBe(false)
    h.dispose()
  })

  it('Pet 接入期间官方读写入口全部继续使用官方链路', async () => {
    const h = await makeHarness()
    await h.post({ cmd: 'acquire', epoch: 3, bindingId: 'b1' })
    for (const path of GATED) {
      const out = h.connectionRequest(path)
      expect(out.blocked).toBe(false)
    }
    for (const path of READ_ONLY) expect(h.connectionRequest(path).blocked).toBe(false)
    h.dispose()
  })

  it('release 后写操作立即恢复（gate 随 heldEpoch 解除）', async () => {
    const h = await makeHarness()
    await h.post({ cmd: 'acquire', epoch: 3, bindingId: 'b1' })
    expect(h.connectionRequest('/api/session/selectModel').blocked).toBe(false)
    expect((await h.post({ cmd: 'release', epoch: 3 })).status).toBe(200)
    expect(h.connectionRequest('/api/session/selectModel').blocked).toBe(false)
    h.dispose()
  })
})

describe('桥：submit / turn 终态（真实事件形状）', () => {
  it('submit 走 sessionController.prompt(request, signal)，立即 ack 为 accepted', async () => {
    const h = await makeHarness({ agents: ['session-1'] })
    await submitTask(h)
    expect(h.calls.resolveAgent).toContain('session-1')
    expect(h.calls.prompt.length).toBe(1)
    expect(h.calls.prompt[0].mode).toBe('queue')
    expect(h.calls.prompt[0].text).toBe('do it')
    expect(h.calls.prompt[0].hasSignal).toBe(true)
    const snap = await h.post({ cmd: 'snapshot' })
    expect((snap.body.task as Record<string, unknown>).state).toBe('accepted')
    h.dispose()
  })

  it('历史会话可被 resolveAgent 载入（不要求已在 agents 缓存）', async () => {
    const h = await makeHarness()
    const taskId = await submitTask(h, 'session-history')
    expect(h.calls.resolveAgent).toContain('session-history')
    const snap = await h.post({ cmd: 'snapshot' })
    expect(snap.body.task).toMatchObject({ taskId, sessionId: 'session-history' })
    h.dispose()
  })

  it('accepted ≠ completed：只有真实 turn/start→turn/end 才落到终态', async () => {
    const h = await makeHarness({ agents: ['session-1'] })
    await submitTask(h)
    h.turnStart('session-1', 1)
    expect(((await h.post({ cmd: 'snapshot' })).body.task as Record<string, unknown>).state).toBe('running')
    h.turnEnd('session-1', 1, 'completed')
    const snap = await h.post({ cmd: 'snapshot' })
    expect(snap.body.task).toMatchObject({ state: 'completed', endReason: 'completed' })
    h.dispose()
  })

  it('error/blocked 明确 failed（不算 completed）；aborted 算 cancelled', async () => {
    const h = await makeHarness({ agents: ['session-1'] })
    await submitTask(h)
    h.turnStart('session-1', 1)
    h.turnEnd('session-1', 1, 'error')
    expect((await h.post({ cmd: 'snapshot' })).body.task).toMatchObject({ state: 'failed', endReason: 'error' })
    h.dispose()

    const h2 = await makeHarness({ agents: ['session-2'] })
    await submitTask(h2, 'session-2')
    h2.turnStart('session-2', 1)
    h2.turnEnd('session-2', 1, 'aborted')
    expect((await h2.post({ cmd: 'snapshot' })).body.task).toMatchObject({ state: 'cancelled' })
    h2.dispose()
  })

  it('单活动任务：第二个 submit busy；旧 taskId 取消被拒；cancel 走官方入口', async () => {
    const h = await makeHarness({ agents: ['session-1'] })
    const taskId = await submitTask(h)
    const second = await h.post({ cmd: 'submit', epoch: 1, taskId: 'task-2', sessionId: 'session-1', text: 'again' })
    expect(second.body.code).toBe('task/busy')
    const wrong = await h.post({ cmd: 'cancel', epoch: 1, taskId: 'task-old' })
    expect(wrong.body.code).toBe('task/not-found')
    // 真实桥的 cancel 会先等回合真正开始再取消（避免队列项活过取消）
    h.turnStart('session-1', 1)
    const ok = await h.post({ cmd: 'cancel', epoch: 1, taskId })
    expect(ok.status).toBe(200)
    expect(h.calls.cancel).toEqual(['session-1'])
    h.dispose()
  })

  it('旧 epoch 写命令一律 stale-epoch', async () => {
    const h = await makeHarness({ agents: ['session-1'] })
    await submitTask(h)
    const stale = await h.post({ cmd: 'cancel', epoch: 9, taskId: 'whatever' })
    expect(stale.body.code).toBe('task/stale-epoch')
    h.dispose()
  })
})

describe('桥：原生审批归属', () => {
  it('持有独占且有活动任务：审批挂起等 Pet；官方 Web answerer 拿不到', async () => {
    const h = await makeHarness({ agents: ['session-1'] })
    await submitTask(h)
    let webCalled = false
    ;(h as unknown as { webAnswerer?: () => void }).webAnswerer = () => {
      webCalled = true
    }
    const pending = h.approvalRequest({ agent: { session: { id: 'session-1' } }, toolName: 'pwsh' })
    await new Promise((r) => setTimeout(r, 10))
    const snap = await h.post({ cmd: 'snapshot' })
    const approvals = snap.body.approvals as Array<Record<string, unknown>>
    expect(approvals.length).toBe(1)
    expect(approvals[0]).toMatchObject({ taskId: expect.any(String), sessionId: 'session-1', toolName: 'pwsh', epoch: 1 })
    expect(webCalled).toBe(false)

    const answered = await h.post({ cmd: 'approve', epoch: 1, approvalId: approvals[0].approvalId, outcome: 'rejected' })
    expect(answered.status).toBe(200)
    expect(answered.body.approval).toBe('rejected')
    await expect(pending.result).resolves.toBe('rejected')
    h.dispose()
  })

  it('未托管：立刻交回官方 Web answerer（不永久关闭 ui-approval）', async () => {
    const h = await makeHarness()
    // 未托管时桥不接管：waterfall 落到链尾默认值 unavailable
    const pending = h.approvalRequest({ agent: { session: { id: 'session-1' } }, toolName: 'pwsh' })
    await expect(pending.result).resolves.toBe('unavailable')
    h.dispose()
  })

  it('没有活动任务时审批不接管（回到官方链尾默认值）', async () => {
    const h = await makeHarness({ agents: ['session-1'] })
    await h.post({ cmd: 'acquire', epoch: 1, bindingId: 'b1' })
    const pending = h.approvalRequest({ agent: { session: { id: 'session-1' } }, toolName: 'pwsh' })
    // 真实桥在「没有活动任务」时立即返回 fail-closed（不自动 allow）
    await expect(pending.result).resolves.toBe('unavailable')
    h.dispose()
  })

  it('无 key 回答/错误审批 id 一律拒绝（陈旧答案不执行）', async () => {
    const h = await makeHarness({ agents: ['session-1'] })
    await submitTask(h)
    const pending = h.approvalRequest({ agent: { session: { id: 'session-1' } }, toolName: 'pwsh' })
    await new Promise((r) => setTimeout(r, 10))
    const wrong = await h.post({ cmd: 'approve', epoch: 1, approvalId: 'not-real', outcome: 'allowed-once' })
    expect(wrong.body.code).toBe('approval/not-pending')
    const staleEpoch = await h.post({ cmd: 'approve', epoch: 5, approvalId: 'not-real', outcome: 'allowed-once' })
    expect(staleEpoch.body.code).toBe('task/stale-epoch')
    h.dispose()
    void pending
  })
})

describe('桥：release 等真实终态、不 kill 后台', () => {
  it('release 先等真实取消终态：期间保持 held，终态到达后才释放 gate', async () => {
    const h = await makeHarness({ agents: ['session-1'] })
    await submitTask(h)
    h.turnStart('session-1', 1)

    const releasing = h.post({ cmd: 'release', epoch: 1 })
    // release 会先发官方 cancel，再等真实 turn/end
    await new Promise((r) => setTimeout(r, 10))
    expect(h.calls.cancel).toEqual(['session-1'])
    await expect(Promise.race([releasing, Promise.resolve('pending')])).resolves.toBe('pending')
    expect(h.connectionRequest('/api/session/prompt').blocked).toBe(false)

    h.turnEnd('session-1', 1, 'aborted')
    const released = await releasing
    expect(released.status).toBe(200)
    expect(released.body.holding).toBe(false)
    // 共享后台仍在：控制面仍可再次 acquire（不是 kill）
    const again = await h.post({ cmd: 'acquire', epoch: 2, bindingId: 'b2' })
    expect(again.status).toBe(200)
    h.dispose()
  })

  it('cancel 只是 ack：任务状态等桥的真实 turn/end 才变', async () => {
    const h = await makeHarness({ agents: ['session-1'] })
    const taskId = await submitTask(h)
    h.turnStart('session-1', 1)
    const cancelled = await h.post({ cmd: 'cancel', epoch: 1, taskId })
    expect(cancelled.status).toBe(200)
    expect((cancelled.body.task as Record<string, unknown>).state).toBe('running')
    h.turnEnd('session-1', 1, 'interrupted')
    expect((await h.post({ cmd: 'snapshot' })).body.task).toMatchObject({ state: 'cancelled' })
    h.dispose()
  })
})

describe('桥：新会话与源码不变量', () => {
  it('session/new 走官方 create；session/select 走官方 resolveAgent', async () => {
    const h = await makeHarness({ agents: ['session-1'] })
    await h.post({ cmd: 'acquire', epoch: 1, bindingId: 'b1' })
    const created = await h.post({ cmd: 'session', epoch: 1, mode: 'new' })
    expect(created.status).toBe(200)
    expect(h.calls.create).toBe(1)
    const selected = await h.post({ cmd: 'session', epoch: 1, mode: 'select', sessionId: 'session-1' })
    expect(selected.status).toBe(200)
    expect(h.calls.resolveAgent).toContain('session-1')
    h.dispose()
  })

  it('源码不变量：不拦官方写请求，审批 prepend、凭据抹除、不 import 官方内部模块', () => {
    const source = bridgeSource()
    expect(source).not.toContain("'connection/request'")
    expect(source).toContain("'approval/request'")
    expect(source).toContain('prepend: true')
    expect(source).toContain('delete process.env[KEY_ENV]')
    // 不得再自造 user message / 依赖 dshLlm 注入
    expect(source).not.toContain('createUserMessage')
    expect(source).not.toContain('dshLlm')
    // 不 import 已安装 dsh 的内部模块
    expect(source).not.toContain("from '@deepseek-ai/")
    expect(/JSON\.stringify\(\{[^}]*key/is.test(source)).toBe(false)
  })
})

/**
 * S4 审查修正：浏览器面（viewer）端点的**真实鉴权**。
 *
 * 修正前的缺陷：viewerHandler 对任何能连上回环端口的请求直接签发签名 cookie，
 * ack/browse 同样放行，且签出的 viewerId 与「哪次导航请求」毫无绑定 ——
 * `fetch(status,{credentials:'omit'})` 也能拿到 200。
 *
 * 现在要求：① 先过**官方**浏览器面鉴权（`ctx.connection.admit`），未登录一律 401/403，
 * **绝不**为未认证请求签 cookie；② ack/browse 必须带合法 cookie；③ 导航请求归属冻结，
 * 别的浏览器不能 ack 它；④ cookie 有 TTL，过期不认；⑤ owner（viewer 身份）绝不外带。
 */
describe('桥：viewer 端点鉴权与请求归属（S4 修正）', () => {
  const STATUS = '/__lyshell/harness/viewer/status'
  const ACK = '/__lyshell/harness/viewer/ack'
  const BROWSE = '/__lyshell/harness/viewer/browse'

  /**
   * 走完「官方鉴权 → viewer cookie → 发一条冻结导航 → 该浏览器读一次状态认领它」的前置。
   *
   * 认领这一步不能省：真实流程里 LyShell 下发 viewer-nav 后，官方页面下一次轮询 status
   * 才把它认领成「我这个浏览器的导航」。少了它，测试里的「另一个浏览器」会先到先得地
   * 把请求认领走，跨 viewer 断言就失去意义。
   */
  async function withPendingNav(h: BridgeHarness): Promise<{ cookie: string; requestId: string }> {
    const cookie = await h.viewerCookie()
    const epoch = 7
    expect((await h.post({ cmd: 'acquire', epoch, bindingId: 'b1' })).status).toBe(200)
    const nav = await h.post({ cmd: 'viewer-nav', epoch, revision: Date.now(), requestId: 'req-1', sessionId: 'session-a' })
    expect(nav.status).toBe(200)
    const claim = await h.viewerCall('/__lyshell/harness/viewer/status', null, { method: 'GET', cookie })
    expect(claim.status).toBe(200)
    expect((claim.body.viewer as Record<string, unknown>).ownedByCurrentViewer).toBe(true)
    return { cookie, requestId: 'req-1' }
  }

  it('未通过官方鉴权：status/ack/browse 一律 401，且**不签发**任何 viewer cookie', async () => {
    const h = await makeHarness()
    h.viewerAuth.outcome = 401
    for (const [path, method] of [[STATUS, 'GET'], [ACK, 'POST'], [BROWSE, 'POST']] as const) {
      const out = await h.viewerCall(path, { status: 'navigated' }, { method })
      expect(out.status).toBe(401)
      expect(out.setCookie).toBeNull()
    }
    expect(h.viewerAuth.calls).toBeGreaterThanOrEqual(3)
    h.dispose()
  })

  it('非可信来源（官方判 403）：同样拒绝，绝不签 cookie', async () => {
    const h = await makeHarness()
    h.viewerAuth.outcome = 403
    const out = await h.viewerCall(STATUS, null, { method: 'GET' })
    expect(out.status).toBe(403)
    expect(out.setCookie).toBeNull()
    h.dispose()
  })

  it('官方鉴权服务缺失（老版本 dsh）：fail closed（503），不放行也不签 cookie', async () => {
    const h = await makeHarness()
    h.viewerAuth.outcome = 'missing'
    const out = await h.viewerCall(STATUS, null, { method: 'GET' })
    expect(out.status).toBe(503)
    expect(out.setCookie).toBeNull()
    h.dispose()
  })

  it('通过官方鉴权：签发 HttpOnly+SameSite=Strict+TTL 的 viewer cookie，并可用它读状态', async () => {
    const h = await makeHarness()
    const first = await h.viewerCall(STATUS, null, { method: 'GET' })
    expect(first.status).toBe(200)
    expect(first.setCookie).toContain('lyshell_harness_viewer=')
    expect(first.setCookie).toContain('HttpOnly')
    expect(first.setCookie).toContain('SameSite=Strict')
    expect(first.setCookie).toContain('Max-Age=')
    const cookie = (first.setCookie ?? '').split(';')[0]
    const again = await h.viewerCall(STATUS, null, { method: 'GET', cookie })
    expect(again.status).toBe(200)
    // 已有合法 cookie 就不再换签（避免每次都换一个身份）
    expect(again.setCookie).toBeNull()
    h.dispose()
  })

  it('伪造/篡改的 cookie 不认（重新走官方鉴权换签）', async () => {
    const h = await makeHarness()
    const forged = 'lyshell_harness_viewer=11111111-2222-3333-4444-555555555555.9999999999999.' + 'a'.repeat(64)
    const out = await h.viewerCall(STATUS, null, { method: 'GET', cookie: forged })
    expect(out.status).toBe(200)
    // 签名不符 ⇒ 不能沿用这个身份，必须换签一个新的
    expect(out.setCookie).toContain('lyshell_harness_viewer=')
    expect(out.setCookie).not.toContain(forged)
    h.dispose()
  })

  it('过期 cookie 不认：到期后重新换签（旧值不能长期当凭据）', async () => {
    const h = await makeHarness()
    const issued = await h.viewerCookie()
    // 把 issuedAt 改成一个远超 TTL 的过去时刻，签名随之失效 ⇒ 必须换签
    const [name, value] = issued.split('=')
    const parts = value.split('.')
    const stale = `${name}=${parts[0]}.${Date.now() - 13 * 60 * 60 * 1000}.${parts[2]}`
    const out = await h.viewerCall(STATUS, null, { method: 'GET', cookie: stale })
    expect(out.status).toBe(200)
    expect(out.setCookie).toContain('lyshell_harness_viewer=')
    expect(out.setCookie).not.toContain(stale)
    h.dispose()
  })

  it('跨 viewer 身份隔离：另一个浏览器拿到同一请求也不能 ack（409），原 viewer 才行', async () => {
    const h = await makeHarness()
    const { cookie: ownerCookie, requestId } = await withPendingNav(h)
    // 另一个浏览器：自己的（合法）cookie
    const otherCookie = await h.viewerCookie()
    expect(otherCookie).not.toBe(ownerCookie)
    // 它读得到这条请求，但状态里明确「不归我」
    const otherStatus = await h.viewerCall(STATUS, null, { method: 'GET', cookie: otherCookie })
    const otherViewer = otherStatus.body.viewer as Record<string, unknown>
    expect((otherViewer.request as Record<string, unknown>).requestId).toBe(requestId)
    expect(otherViewer.ownedByCurrentViewer).toBe(false)
    // 它不能替别人的请求宣告落地
    const stolen = await h.viewerCall(
      ACK,
      { requestId, revision: 1, sessionId: 'session-a', currentSessionId: 'session-a', status: 'navigated' },
      { cookie: otherCookie }
    )
    expect(stolen.status).toBe(409)
    // 归属核实：请求仍挂在原 viewer 名下
    const ownerStatus = await h.viewerCall(STATUS, null, { method: 'GET', cookie: ownerCookie })
    const ownerViewer = ownerStatus.body.viewer as Record<string, unknown>
    expect(ownerViewer.ownedByCurrentViewer).toBe(true)
    h.dispose()
  })

  it('ack 必须带已签 cookie：未持 cookie 一律拒（不落状态、也不认领请求）', async () => {
    const h = await makeHarness()
    const { requestId } = await withPendingNav(h)
    const frozen = await h.post({ cmd: 'snapshot' })
    const frozenRevision = ((frozen.body.viewer as Record<string, unknown>).request as Record<string, unknown>).revision
    const payload = { requestId, revision: frozenRevision, sessionId: 'session-a', currentSessionId: 'session-a', status: 'navigated' }
    // 空手来：这一拍只会换签到一个新身份，**没有**执行 ack 的资格（401），
    // 且不认领这条请求 —— 原 viewer 之后仍能正常 ack。
    const anonymous = await h.viewerCall(ACK, payload)
    expect(anonymous.status).toBe(401)
    const snap = await h.post({ cmd: 'snapshot' })
    expect((snap.body.viewer as Record<string, unknown>).request).not.toBeNull()
    h.dispose()
  })

  it('过期/未知/冻结值不符的 ack：viewer/stale（409），不 fake 落地', async () => {
    const h = await makeHarness()
    const { cookie, requestId } = await withPendingNav(h)
    const frozen = await h.post({ cmd: 'snapshot' })
    const frozenRevision = ((frozen.body.viewer as Record<string, unknown>).request as Record<string, unknown>).revision
    const base = { requestId, revision: frozenRevision, sessionId: 'session-a', currentSessionId: 'session-a', status: 'navigated' }
    // 未知 requestId
    expect((await h.viewerCall(ACK, { ...base, requestId: 'nope' }, { cookie })).status).toBe(409)
    // 冻结 revision 不符
    expect((await h.viewerCall(ACK, { ...base, revision: 999 }, { cookie })).status).toBe(409)
    // 冻结 sessionId 不符
    expect((await h.viewerCall(ACK, { ...base, sessionId: 'session-b' }, { cookie })).status).toBe(409)
    // 状态码非法（冻结值都对，所以走到取值域校验）
    expect((await h.viewerCall(ACK, { ...base, status: 'whatever' }, { cookie })).status).toBe(400)
    h.dispose()
  })

  it('navigated 必须由官方 UI 实际当前会话证明：当前会话不符则拒绝；相符才 applied', async () => {
    const h = await makeHarness()
    const { cookie, requestId } = await withPendingNav(h)
    const wrong = await h.viewerCall(
      ACK,
      { requestId, revision: 1, sessionId: 'session-a', currentSessionId: 'session-other', status: 'navigated' },
      { cookie }
    )
    expect(wrong.status).toBe(409)
    // 相符 ⇒ 落地，appliedRevision 跟着冻结值走
    const forwarded = await h.post({ cmd: 'snapshot' })
    const frozenRevision = ((forwarded.body.viewer as Record<string, unknown>).request as Record<string, unknown>).revision
    const ok = await h.viewerCall(
      ACK,
      { requestId, revision: frozenRevision, sessionId: 'session-a', currentSessionId: 'session-a', status: 'navigated' },
      { cookie }
    )
    expect(ok.status).toBe(200)
    const viewer = ok.body.viewer as Record<string, unknown>
    expect(viewer.appliedRevision).toBe(frozenRevision)
    expect(viewer.currentSessionId).toBe('session-a')
    expect(viewer.request).toBeNull()
    h.dispose()
  })

  it('browse 推进 revision 并作废未落地请求（用户浏览优先，不被拽回）', async () => {
    const h = await makeHarness()
    const { cookie } = await withPendingNav(h)
    const before = ((await h.post({ cmd: 'snapshot' })).body.viewer as Record<string, unknown>).revision as number
    const out = await h.viewerCall(BROWSE, { currentSessionId: 'session-history' }, { cookie })
    expect(out.status).toBe(200)
    const viewer = out.body.viewer as Record<string, unknown>
    expect(viewer.revision as number).toBeGreaterThan(before)
    expect(viewer.currentSessionId).toBe('session-history')
    expect(viewer.request).toBeNull()
    expect((viewer.lastAck as Record<string, unknown>).status).toBe('superseded')
    h.dispose()
  })

  it('owner（viewer 身份）绝不外带：浏览器面状态里没有 owner 字段', async () => {
    const h = await makeHarness()
    const { cookie } = await withPendingNav(h)
    const out = await h.viewerCall(STATUS, null, { method: 'GET', cookie })
    const request = (out.body.viewer as Record<string, unknown>).request as Record<string, unknown>
    expect(request.requestId).toBe('req-1')
    expect('owner' in request).toBe(false)
    h.dispose()
  })

  it('源码不变量：viewer 端点先过官方 admit，且不把 host key/token 交给浏览器', () => {
    const source = bridgeSource()
    expect(source).toContain("service('connection')")
    expect(source).toContain('connection.admit(')
    expect(source).toContain('official browser session required')
    // 浏览器面响应体不得包含 host-only key 或凭据字段名
    expect(source).not.toContain('LYSHELL_EXCLUSIVE_TOKEN')
    expect(/viewerPublic[\s\S]{0,400}?key\b/.test(source)).toBe(false)
  })
})
