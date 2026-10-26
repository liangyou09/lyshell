import http from 'node:http'
import type { HarnessWebActivitySnapshot, HarnessWebActivitySession, HarnessWebActivityEvent } from '@shared/harness-web-activity'
import { BRIDGE_KEY_HEADER } from './bridge'
import { dshWebManager } from './web'

type Endpoint = { port: number; key: string }
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const clean = (v: string) => [...v].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128 && clean(v)
const time = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0
const workspace = (v: unknown): v is string => typeof v === 'string' && v.length <= 2048 && clean(v)
const sameEndpoint = (a: Endpoint | null, b: Endpoint | null) => !!a && !!b && a.port === b.port && a.key === b.key

/** 精选字段，不把桥回包中的文本或其他控制数据透传给 Renderer。 */
export function parseWebActivity(body: unknown, observedAt: number): HarnessWebActivitySnapshot | null {
  if (!record(body) || body.ok !== true || !record(body.identity) || !id(body.identity.instanceId) || !time(body.identity.instanceEpoch) || !time(body.revision)) return null
  if (!Array.isArray(body.sessions) || body.sessions.length > 128 || !Array.isArray(body.events) || body.events.length > 100) return null
  const sessions: HarnessWebActivitySession[] = []
  const events: HarnessWebActivityEvent[] = []
  for (const row of body.sessions) {
    if (!record(row) || !id(row.sessionId) || !workspace(row.workspace) || !id(row.turnId) || !time(row.updatedAt) ||
      !['running', 'waiting-approval', 'turn-ended', 'failed', 'interrupted'].includes(row.state as string) ||
      !Array.isArray(row.approvalIds) || row.approvalIds.length > 128 || !row.approvalIds.every(id) || sessions.some(s => s.sessionId === row.sessionId)) return null
    sessions.push({ sessionId: row.sessionId, workspace: row.workspace, turnId: row.turnId, state: row.state as HarnessWebActivitySession['state'], updatedAt: row.updatedAt, approvalIds: [...row.approvalIds] })
  }
  for (const row of body.events) {
    if (!record(row) || !id(row.id) || !id(row.sessionId) || !workspace(row.workspace) || !id(row.turnId) || !time(row.at) ||
      !['turn-ended', 'failed', 'interrupted', 'approval'].includes(row.kind as string) || events.some(e => e.id === row.id)) return null
    events.push({ id: row.id, sessionId: row.sessionId, workspace: row.workspace, turnId: row.turnId, kind: row.kind as HarnessWebActivityEvent['kind'], at: row.at })
  }
  return { observedAt, connection: 'connected', identity: { instanceId: body.identity.instanceId, instanceEpoch: body.identity.instanceEpoch }, revision: body.revision, sessions, events }
}

async function request(endpoint: Endpoint): Promise<unknown> {
  return new Promise(resolve => {
    let settled = false
    const finish = (value: unknown) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value) } }
    const req = http.request({ hostname: '127.0.0.1', port: endpoint.port, path: '/', method: 'POST',
      headers: { [BRIDGE_KEY_HEADER]: endpoint.key, 'content-type': 'application/json' } }, res => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        // 128 个会话各含 128 个审批 ID，加上目录/事件的 JSON 转义可超过 1MiB。
        if (size > 16 * 1024 * 1024) { finish(null); req.destroy(); return }
        chunks.push(chunk)
      })
      res.on('error', () => finish(null))
      res.on('aborted', () => finish(null))
      res.on('end', () => {
        try { finish(res.statusCode === 200 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null) }
        catch { finish(null) }
      })
    })
    const timer = setTimeout(() => { finish(null); req.destroy() }, 3000)
    req.on('error', () => finish(null))
    req.end(JSON.stringify({ cmd: 'web-activity' }))
  })
}

/** 只读现有后台，不启动进程、取得租约或选择/提交会话。 */
export function createWebActivityReader(readEndpoint: () => Endpoint | null, read = request, now = Date.now) {
  let cached: HarnessWebActivitySnapshot | null = null
  let cachedEndpoint: Endpoint | null = null
  return async (): Promise<HarnessWebActivitySnapshot> => {
    const endpoint = readEndpoint()
    if (!sameEndpoint(cachedEndpoint, endpoint)) { cached = null; cachedEndpoint = endpoint }
    const empty = (connection: 'offline' | 'stale'): HarnessWebActivitySnapshot => ({ observedAt: now(), connection, identity: null, revision: 0, sessions: [], events: [] })
    if (!endpoint) return empty('offline')
    let body: unknown
    try { body = await read(endpoint) } catch { body = null }
    if (!sameEndpoint(endpoint, readEndpoint())) return empty('stale')
    const parsed = parseWebActivity(body, now())
    if (!parsed) return cached ? { ...cached, connection: 'stale', observedAt: now() } : empty('stale')
    if (cached?.identity && parsed.identity && (cached.identity.instanceEpoch > parsed.identity.instanceEpoch ||
      cached.identity.instanceId === parsed.identity.instanceId && cached.identity.instanceEpoch === parsed.identity.instanceEpoch && cached.revision > parsed.revision)) return { ...cached, connection: 'stale', observedAt: now() }
    cached = parsed
    return parsed
  }
}

export const readHarnessWebActivity = createWebActivityReader(() => dshWebManager.bridgeControlEndpoint)
