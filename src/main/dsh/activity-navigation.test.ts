import http from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BRIDGE_KEY_HEADER } from './bridge'
const deps = vi.hoisted(() => ({ endpoint: null as { port: number; key: string } | null, identity: { instanceId: 'instance-a', instanceEpoch: 1 }, read: vi.fn(), web: vi.fn(), acquire: vi.fn() }))
vi.mock('./web', () => ({ dshWebManager: { get bridgeControlEndpoint() { return deps.endpoint }, get instanceIdentity() { return deps.identity } } }))
vi.mock('./activity', () => ({ readWorkbenchActivity: deps.read }))
vi.mock('./web-activity', () => ({ readHarnessWebActivity: deps.web }))
vi.mock('./exclusive-runtime', () => ({ acquireWorkbenchDetail: deps.acquire }))
import { navigateWorkbenchActivity } from './activity-navigation'
let server: http.Server | null = null
const commands: Array<Record<string, unknown>> = []
beforeEach(() => {
  commands.length = 0
  deps.endpoint = null
  deps.web.mockReset().mockResolvedValue({ connection: 'offline', identity: null, sessions: [] })
  deps.read.mockReset().mockResolvedValue({ connection: 'connected', identity: deps.identity, sessions: [{ sessionId: 'session-a', workspace: 'C:/project', stale: false }] })
  deps.acquire.mockReset().mockResolvedValue({ ok: true, ...deps.identity, url: 'http://127.0.0.1:3000', cwd: 'C:/project' })
})
afterEach(async () => { await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()); server = null })
async function start(reply: Record<string, unknown>) {
  server = http.createServer(async (request, response) => {
    expect(request.headers[BRIDGE_KEY_HEADER]).toBe('host-key')
    let body = ''
    for await (const chunk of request) body += chunk
    commands.push(JSON.parse(body))
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(reply))
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  deps.endpoint = { port: (server.address() as { port: number }).port, key: 'host-key' }
}
describe('原生会话显式导航', () => {
  it('内置聊天独立核对身份，导航不提交任务或获取 native 控制权', async () => {
    await start({ ok: true })
    deps.read.mockResolvedValue({ connection: 'offline', identity: null, sessions: [] })
    deps.web.mockResolvedValue({ connection: 'connected', identity: deps.identity, sessions: [{ sessionId: 'web-a', workspace: 'D:/web' }] })
    expect(await navigateWorkbenchActivity({ kind: 'open', identity: deps.identity, sessionId: 'web-a' })).toMatchObject({ success: true, cwd: 'D:/web' })
    expect(commands).toEqual([{ cmd: 'native-viewer-nav', identity: deps.identity, sessionId: 'web-a', requestId: expect.any(String) }])
    deps.web.mockResolvedValue({ connection: 'stale', identity: deps.identity, sessions: [{ sessionId: 'web-a' }] })
    expect((await navigateWorkbenchActivity({ kind: 'open', identity: deps.identity, sessionId: 'web-a' })).success).toBe(false)
    expect(commands).toHaveLength(1)
  })
  it('旧后台身份、过期会话在打开页面前就被拒绝', async () => {
    expect((await navigateWorkbenchActivity({ kind: 'open', identity: { instanceId: 'old', instanceEpoch: 1 }, sessionId: 'session-a' })).success).toBe(false)
    expect(deps.acquire).not.toHaveBeenCalled()
    deps.read.mockResolvedValue({ connection: 'stale', identity: deps.identity, sessions: [] })
    expect((await navigateWorkbenchActivity({ kind: 'open', identity: deps.identity, sessionId: 'session-a' })).success).toBe(false)
    expect(deps.acquire).not.toHaveBeenCalled()
  })
  it('打开只提交一次查看请求，页面尚未 ack 时保持 pending', async () => {
    await start({ ok: true })
    const result = await navigateWorkbenchActivity({ kind: 'open', identity: deps.identity, sessionId: 'session-a' })
    expect(result).toMatchObject({ success: true, navigation: 'pending', cwd: 'C:/project' })
    expect(commands).toEqual([{ cmd: 'native-viewer-nav', identity: deps.identity, sessionId: 'session-a', requestId: expect.any(String) }])
    expect(JSON.stringify(result)).not.toContain('host-key')
  })
  it('必须核对同一请求、会话与当前实际位置才确认跳转', async () => {
    await start({ ok: true, identity: deps.identity, viewer: { currentSessionId: 'session-a', request: null, lastAck: { requestId: 'nav-a', sessionId: 'session-a', currentSessionId: 'session-a', status: 'navigated' } } })
    expect(await navigateWorkbenchActivity({ kind: 'navigation', identity: deps.identity, sessionId: 'session-a', requestId: 'nav-a' })).toMatchObject({ success: true, navigation: 'navigated' })
    expect(await navigateWorkbenchActivity({ kind: 'navigation', identity: deps.identity, sessionId: 'session-a', requestId: 'nav-other' })).toMatchObject({ success: true, navigation: 'failed' })
    expect(commands.every(command => command.cmd === 'snapshot')).toBe(true)
  })
})
