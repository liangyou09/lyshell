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

let server: http.Server | null = null
beforeEach(() => { vi.clearAllMocks(); deps.endpoint = null; deps.acquire.mockResolvedValue({ ok: true }) })
afterEach(async () => { if (server) { await new Promise<void>(resolve => server!.close(() => resolve())); server = null } })
describe('Harness 原生宿主边界', () => {
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
    const payload = { ok: true, status: 'approval',
      approvals: Array.from({ length: 128 }, (_, id) => ({ id: String(id), reason: '中'.repeat(2000) })),
      transcript: Array.from({ length: 256 }, () => ({ text: '\u0001'.repeat(512) })) }
    let body = JSON.stringify(payload)
    expect(Buffer.byteLength(body)).toBeGreaterThan(1024 * 1024)
    server = http.createServer((_req, res) => { res.end(body) })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const endpoint = { port: (server.address() as { port: number }).port, key: 'key' }
    expect((await requestNativeWorkBridge(endpoint, harnessWorkOwner('token'), { kind: 'state' })).body).toEqual(payload)
    body = JSON.stringify({ ok: true, text: 'x'.repeat(4 * 1024 * 1024) })
    expect((await requestNativeWorkBridge(endpoint, harnessWorkOwner('token'), { kind: 'state' })).status).toBe(503)
  })
})
