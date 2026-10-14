import { describe, it, expect, vi } from 'vitest'
import http from 'http'
import { createBridgeControlRunner } from './exclusive-bridge-client'
vi.mock('electron-log', () => ({ default: { warn: () => {}, info: () => {} } }))
async function fixture(handler: http.RequestListener, test: (port: number) => Promise<void>): Promise<void> {
  const server = http.createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try { await test((server.address() as { port: number }).port) }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
}
describe('独占桥客户端：真实 HTTP 故障与安全诊断', () => {
  it('冷后台的 revision=0 查看器可解码，随后能分配首个导航请求', async () => {
    await fixture((_req, res) => res.end(JSON.stringify({ ok: true, viewer: {
      revision: 0, appliedRevision: 0, currentSessionId: null, request: null, lastAck: null, connected: false
    } })), async port => {
      const result = await createBridgeControlRunner(() => ({ port, key: 'SECRET' }))({ cmd: 'snapshot' })
      expect(result.viewer).toMatchObject({ revision: 0, appliedRevision: 0, connected: false, request: null })
    })
  })
  it('响应流中断有界返回，不丢 error/aborted；阶段与响应证据准确', async () => {
    await fixture((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '5000' })
      res.write('{"ok":true,'); setTimeout(() => res.destroy(), 10)
    }, async port => {
      const result = await createBridgeControlRunner(() => ({ port, key: 'SECRET' }))({ cmd: 'snapshot' })
      expect(result).toMatchObject({ ok: false, diagnostic: { code: 'ECONNRESET', phase: 'response-body', httpResponse: true } })
      expect(JSON.stringify(result)).not.toContain('SECRET')
    })
  })
  it('连接拒绝保留 ECONNREFUSED，未获 HTTP 响应', async () => {
    let closedPort = 0
    await fixture((_req, res) => res.end(), async port => { closedPort = port })
    const result = await createBridgeControlRunner(() => ({ port: closedPort, key: 'SECRET' }))({ cmd: 'snapshot' })
    expect(result).toMatchObject({ ok: false, diagnostic: { code: 'ECONNREFUSED', phase: 'connect', httpResponse: false } })
  })
  it('任务 cause 在真正解码边界保留，未知敏感字段丢弃', async () => {
    await fixture((_req, res) => res.end(JSON.stringify({ ok: true, holding: true,
      task: { taskId: 't', sessionId: 's', epoch: 1, state: 'failed', acceptedAt: 1,
        diagnostic: { code: 'ECONNRESET', causeCodes: ['UND_ERR_SOCKET', 'SECRET'], phase: 'agent', httpResponse: 'unknown', body: 'SECRET' } } })),
    async port => {
      const result = await createBridgeControlRunner(() => ({ port, key: 'SECRET' }))({ cmd: 'snapshot' })
      expect(result.task?.diagnostic).toEqual({ code: 'ECONNRESET', causeCodes: ['UND_ERR_SOCKET'], phase: 'agent', httpResponse: 'unknown' })
      expect(JSON.stringify(result)).not.toContain('SECRET')
    })
  })
  it('无响应时超时有固定分类，不重发命令', async () => {
    let requests = 0
    await fixture(() => { requests++ }, async port => {
      const result = await createBridgeControlRunner(() => ({ port, key: 'SECRET' }), 40)({ cmd: 'snapshot' })
      expect(result).toMatchObject({ ok: false, code: 'bridge/timeout', diagnostic: { code: 'ETIMEDOUT' } })
      expect(requests).toBe(1)
    })
  })
})
