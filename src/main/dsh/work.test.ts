import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import http from 'http'
const deps = vi.hoisted(() => ({
  endpoint: null as { port: number; key: string } | null,
  acquire: vi.fn(), release: vi.fn(), retain: vi.fn(), unretain: vi.fn()
}))
vi.mock('./web', () => ({ dshWebManager: {
  get bridgeControlEndpoint() { return deps.endpoint }, acquire: deps.acquire,
  release: deps.release, retainBackend: deps.retain, unretainBackend: deps.unretain
} }))
vi.mock('./launch-resolve', () => ({ createDshWebLaunchResolver: () => ({ resolve: vi.fn() }) }))
vi.mock('../harness/config', () => ({ HARNESS_AGENTS: { dsh: {} } }))
import { harnessWorkOwner, runHarnessWork, requestNativeWorkBridge } from './work'
import { readWorkbenchActivity, resetWorkbenchActivityState } from './activity'

/** 与 resources/dsh-bridge 的 snapshot 形状一致的在线回执。 */
function liveState(): Record<string, unknown> {
  return {
    ok: true,
    identity: { instanceId: 'inst-live', instanceEpoch: 3 },
    status: 'running',
    sessionId: 's-live',
    workspace: 'D:/ws/live',
    taskId: 'task-live',
    taskState: 'running',
    task: { taskId: 'task-live', sessionId: 's-live', requestId: 'req-live', state: 'running' },
    sessions: [{ sessionId: 's-live', workspace: 'D:/ws/live' }],
    approvals: [],
    transcript: [],
    transcriptTruncated: false
  }
}

let server: http.Server | null = null
beforeEach(() => {
  vi.clearAllMocks()
  deps.endpoint = null
  deps.acquire.mockResolvedValue({ ok: true })
  resetWorkbenchActivityState()
})
afterEach(async () => { if (server) { await new Promise<void>(resolve => server!.close(() => resolve())); server = null } })
describe('Harness 原生宿主边界', () => {
  it.each(['submit', 'approve'] as const)('慢 %s 不阻塞同凭据另一会话或取消；在途变更阻止释放整个凭据租约', async kind => {
    let releaseFirst!: () => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const blocked = new Promise<void>(resolve => { releaseFirst = resolve })
    const received: Array<Record<string, unknown>> = []
    server = http.createServer(async (req, res) => {
      let text = ''; for await (const chunk of req) text += chunk
      const { request } = JSON.parse(text) as { request: Record<string, unknown> }
      received.push(request)
      if (request.kind === kind && request.sessionId === 's1') { entered(); await blocked }
      res.end(JSON.stringify({ ok: true, sessionId: request.sessionId, taskId: request.taskId }))
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    deps.endpoint = { port: (server.address() as { port: number }).port, key: 'fixture' }
    const owner = harnessWorkOwner('token')
    const first = runHarnessWork(owner, kind === 'submit'
      ? { kind, sessionId: 's1', requestId: 'r1', text: 'one' }
      : { kind, sessionId: 's1', id: 'approval', optionId: 'rejected' }, () => true)
    await started
    try {
      expect((await runHarnessWork(owner, { kind: 'submit', sessionId: 's2', requestId: 'r2', text: 'two' }, () => true)).status).toBe(200)
      expect((await runHarnessWork(owner, { kind: 'state', taskId: 'task-1' }, () => true)).status).toBe(200)
      expect((await runHarnessWork(owner, { kind: 'cancel', taskId: 'task-1' }, () => true)).status).toBe(200)
      expect((await runHarnessWork(owner, { kind: 'disconnect' }, () => true)).body.code).toBe('task/busy')
      expect(received.some(request => request.kind === 'disconnect')).toBe(false)
      expect(deps.release).not.toHaveBeenCalled()
    } finally { releaseFirst(); await first }
    expect((await runHarnessWork(owner, { kind: 'disconnect' }, () => true)).status).toBe(200)
    expect(deps.release).toHaveBeenCalledWith(`native-work:${owner}`)
  })
  it('无后台的读状态不启动进程，变更明确失败', async () => {
    const result = await runHarnessWork('a'.repeat(64), { kind: 'state' }, () => true)
    expect(result.body.status).toBe('offline')
    expect(deps.acquire).not.toHaveBeenCalled()
    expect((await runHarnessWork('a'.repeat(64), { kind: 'select', sessionId: 's' }, () => true)).status).toBe(503)
  })
  it('启动期间撤权不发送工作命令并释放刚取得的租约', async () => {
    let authorized = true
    deps.acquire.mockImplementation(async () => { authorized = false; return { ok: true } })
    const owner = harnessWorkOwner('token')
    expect((await runHarnessWork(owner, { kind: 'new' }, () => authorized)).status).toBe(403)
    expect(deps.release).toHaveBeenCalledWith(`native-work:${owner}`)
    expect(deps.retain).not.toHaveBeenCalled()
  })
  it('拒绝相对工作目录，撤权请求没有启动副作用', async () => {
    expect((await runHarnessWork('a', { kind: 'new', workspace: 'relative' }, () => true)).status).toBe(400)
    expect((await runHarnessWork('a', { kind: 'new' }, () => false)).status).toBe(403)
    expect(deps.acquire).not.toHaveBeenCalled()
  })
  it('真实回环协议只发宿主 key 和散列 owner，不向桥发送客户端 token', async () => {
    const key = 'bridge-secret', token = 'client-secret'
    const owner = harnessWorkOwner(token)
    let received: unknown, header: unknown
    server = http.createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk
      received = JSON.parse(body); header = req.headers['x-lyshell-harness-key']
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, status: 'idle' }))
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const endpoint = { port: (server.address() as { port: number }).port, key }
    expect((await requestNativeWorkBridge(endpoint, owner, { kind: 'state' })).status).toBe(200)
    expect(header).toBe(key)
    expect(received).toEqual({ cmd: 'native-work', owner, request: { kind: 'state' } })
    expect(JSON.stringify(received)).not.toContain(token)
    expect(owner).toMatch(/^[a-f0-9]{64}$/)
  })
  it('接收含大量审批及转义输出的合法状态，仍拒绝超限响应', async () => {
    const view = { status: 'approval',
      approvals: Array.from({ length: 128 }, (_, id) => ({ id: String(id), reason: '\u0001'.repeat(2000) })),
      transcript: Array.from({ length: 256 }, () => ({ text: '\u0001'.repeat(512) })) }
    const payload = { ok: true, ...view, sessions: [view] }
    let body = JSON.stringify(payload)
    expect(Buffer.byteLength(body)).toBeGreaterThan(4 * 1024 * 1024)
    server = http.createServer((_req, res) => { res.end(body) })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const endpoint = { port: (server.address() as { port: number }).port, key: 'key' }
    expect((await requestNativeWorkBridge(endpoint, harnessWorkOwner('token'), { kind: 'state' })).body).toEqual(payload)
    body = JSON.stringify({ ok: true, text: 'x'.repeat(8 * 1024 * 1024) })
    expect((await requestNativeWorkBridge(endpoint, harnessWorkOwner('token'), { kind: 'state' })).status).toBe(503)
  })
  it('工作台活动复用同一 owner 只读授权状态，不启动后台、不外泄 owner', async () => {
    const owner = harnessWorkOwner('token-a')
    server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(liveState()))
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    deps.endpoint = { port: (server.address() as { port: number }).port, key: 'key' }
    expect((await runHarnessWork(owner, { kind: 'state' }, () => true)).status).toBe(200)

    const snapshot = await readWorkbenchActivity()
    expect(snapshot.connection).toBe('connected')
    expect(snapshot.identity).toEqual({ instanceId: 'inst-live', instanceEpoch: 3 })
    expect(snapshot.sessions).toHaveLength(1)
    expect(snapshot.sessions[0]).toMatchObject({
      key: '["inst-live",3,"s-live","task-live"]', taskState: 'running', source: 'native-harness'
    })
    expect(JSON.stringify(snapshot)).not.toContain(owner)
    expect(deps.acquire).not.toHaveBeenCalled()
    expect(deps.retain).not.toHaveBeenCalled()
  })
  it('活动读请求带自己的超时，不会按 30 秒挂住界面', async () => {
    server = http.createServer(() => { /* 永不回执 */ })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const endpoint = { port: (server.address() as { port: number }).port, key: 'key' }
    const startedAt = Date.now()
    const reply = await requestNativeWorkBridge(endpoint, harnessWorkOwner('token'), { kind: 'state' }, 100)
    expect(reply.status).toBe(503)
    expect(Date.now() - startedAt).toBeLessThan(5000)
  })
})
