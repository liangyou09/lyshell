import { describe, expect, it, vi } from 'vitest'
import http from 'node:http'
vi.mock('./web', () => ({ dshWebManager: { bridgeControlEndpoint: null } }))
import { createWebActivityReader, parseWebActivity } from './web-activity'

const body = () => ({ ok: true, identity: { instanceId: 'backend-a', instanceEpoch: 1 }, revision: 2,
  sessions: [{ sessionId: 'web-a', workspace: 'D:/project', turnId: 'turn-1', state: 'waiting-approval', updatedAt: 100, approvalIds: ['approval-a'] }],
  events: [{ id: 'approval-a', sessionId: 'web-a', workspace: 'D:/project', turnId: 'turn-1', kind: 'approval', at: 100 }] })

describe('内置聊天只读状态采集', () => {
  it('合法的多会话并行审批快照超过 1MiB 时仍可读取', async () => {
    const payload = { ...body(), events: [], sessions: Array.from({ length: 128 }, (_, index) => ({
      ...body().sessions[0], sessionId: `web-${index}`, approvalIds: Array.from({ length: 128 }, (_, i) => `${i}`.padEnd(128, 'x'))
    })) }
    const json = JSON.stringify(payload)
    expect(Buffer.byteLength(json)).toBeGreaterThan(1024 * 1024)
    const server = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(json) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const endpoint = { port: (server.address() as { port: number }).port, key: 'fixture' }
      expect(await createWebActivityReader(() => endpoint)()).toMatchObject({ connection: 'connected', revision: 2 })
    } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  })
  it('只选通知字段，拒绝畸形/重复身份与过量状态', () => {
    expect(parseWebActivity({ ...body(), prompt: 'secret', token: 'secret' }, 200)).toEqual({ observedAt: 200, connection: 'connected', ...Object.fromEntries(Object.entries(body()).filter(([key]) => key !== 'ok')) })
    expect(parseWebActivity({ ...body(), sessions: [body().sessions[0], body().sessions[0]] }, 200)).toBeNull()
    expect(parseWebActivity({ ...body(), events: [{ ...body().events[0], id: 'bad\n' }] }, 200)).toBeNull()
    expect(parseWebActivity({ ...body(), revision: NaN }, 200)).toBeNull()
    expect(parseWebActivity({ ...body(), sessions: Array(129).fill(body().sessions[0]) }, 200)).toBeNull()
    expect(parseWebActivity({ ...body(), sessions: [{ ...body().sessions[0], workspace: '' }] }, 200)?.sessions[0].workspace).toBe('')
  })
  it('无后台不执行请求，失败保留过期历史，不将等待审批误判结束', async () => {
    let endpoint: { port: number; key: string } | null = null
    const read = vi.fn().mockResolvedValue(body())
    const snapshot = createWebActivityReader(() => endpoint, read, () => 200)
    expect(await snapshot()).toMatchObject({ connection: 'offline', identity: null, sessions: [] })
    expect(read).not.toHaveBeenCalled()
    endpoint = { port: 4000, key: 'private-key' }
    expect(await snapshot()).toMatchObject({ connection: 'connected', revision: 2 })
    read.mockRejectedValue(new Error('transport secret'))
    const stale = await snapshot()
    expect(stale).toMatchObject({ connection: 'stale', sessions: [{ state: 'waiting-approval' }] })
    expect(JSON.stringify(stale)).not.toContain('secret')
    endpoint = { port: 4001, key: 'new-key' }
    expect(await snapshot()).toMatchObject({ connection: 'stale', identity: null, sessions: [] })
  })
  it('在途响应来自旧端点时丢弃，不让旧代际/旧 revision 回退当前状态', async () => {
    let endpoint = { port: 4000, key: 'private' }
    const read = vi.fn().mockImplementation(async () => { endpoint = { port: 4001, key: 'new' }; return body() })
    const snapshot = createWebActivityReader(() => endpoint, read, () => 200)
    expect(await snapshot()).toMatchObject({ connection: 'stale', identity: null })
    read.mockResolvedValue(body())
    expect(await snapshot()).toMatchObject({ connection: 'connected', revision: 2 })
    read.mockResolvedValue({ ...body(), revision: 1 })
    expect(await snapshot()).toMatchObject({ connection: 'stale', revision: 2 })
    read.mockResolvedValue({ ...body(), identity: { instanceId: 'old', instanceEpoch: 0 } })
    expect(await snapshot()).toMatchObject({ connection: 'stale', identity: { instanceId: 'backend-a' } })
  })
})
