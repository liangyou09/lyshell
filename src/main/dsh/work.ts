import http from 'http'
import { createHash } from 'crypto'
import { statSync } from 'fs'
import { isAbsolute } from 'path'
import type { HarnessWorkRequest } from '@shared/harness-work'
import { BRIDGE_KEY_HEADER } from './bridge'
import { dshWebManager } from './web'
import { createDshWebLaunchResolver } from './launch-resolve'
import {
  configureWorkbenchActivity, recordWorkbenchActivityReply, registerWorkbenchActivityOwner
} from './activity'
import { HARNESS_AGENTS } from '../harness/config'

export interface WorkReply { status: number; body: Record<string, unknown> }
const unavailable = (): WorkReply => ({ status: 503, body: {
  ok: false, code: 'bridge/unavailable', error: 'Harness response unavailable; execution may be unconfirmed. Read state before any retry.'
} })

/** 凭据本身不离开 main；hash 只是桥内租户键，不是可用于鉴权的 token。 */
export function harnessWorkOwner(token: string): string {
  return createHash('sha256').update('lyshell-native-work\0').update(token).digest('hex')
}

// 工作台活动面板只复用这里的读端点与转发函数：不 acquire、不启动后台、不重发任务。
// 注入而非 import，避免 activity ↔ work 的循环依赖；owner 始终留在 main 内。
configureWorkbenchActivity({
  readEndpoint: () => dshWebManager.bridgeControlEndpoint,
  readBridge: (endpoint, owner, request, options) =>
    requestNativeWorkBridge(endpoint, owner, request, options.timeoutMs)
})

export async function requestNativeWorkBridge(
  endpoint: { port: number; key: string }, owner: string, request: HarnessWorkRequest,
  timeoutMs = 30000
): Promise<WorkReply> {
  const body = JSON.stringify({ cmd: 'native-work', owner, request })
  return new Promise(resolve => {
    let settled = false
    const done = (reply: WorkReply): void => { if (!settled) { settled = true; resolve(reply) } }
    const req = http.request({ hostname: '127.0.0.1', port: endpoint.port, path: '/', method: 'POST',
      headers: { [BRIDGE_KEY_HEADER]: endpoint.key, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: Math.min(Math.max(500, timeoutMs), 30000)
    }, res => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        // 默认任务视图与 sessions 行可能重复同一审批/输出；全转义后也须容纳合法总预算。
        if (size > 8 * 1024 * 1024) { req.destroy(); done(unavailable()); return }
        chunks.push(chunk)
      })
      res.on('error', () => done(unavailable()))
      res.on('aborted', () => done(unavailable()))
      res.on('end', () => {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
          if (payload?.ok === true && res.statusCode === 200) done({ status: 200, body: payload })
          else if (payload?.ok === false) done({ status: res.statusCode === 400 ? 400 : 409, body: {
            ok: false, code: typeof payload.code === 'string' ? payload.code : 'bridge/unavailable', error: 'Harness refused the work request'
          } })
          else done(unavailable())
        } catch { done(unavailable()) }
      })
    })
    req.on('error', () => done(unavailable()))
    req.on('timeout', () => { req.destroy(); done(unavailable()) })
    req.end(body)
  })
}

/** 使用现有后台租约；Pet 的 acquire/release/revoke 不涉及此 holder。 */
export async function runHarnessWork(
  owner: string, request: HarnessWorkRequest, stillAuthorized: () => boolean
): Promise<WorkReply> {
  const reply = await dispatchHarnessWork(owner, request, stillAuthorized)
  // 把权威快照留在 main 内（owner 不外传），供工作台活动面板聚合；失败回执不会被当成状态。
  recordWorkbenchActivityReply(owner, reply)
  return reply
}

async function dispatchHarnessWork(
  owner: string, request: HarnessWorkRequest, stillAuthorized: () => boolean
): Promise<WorkReply> {
  if (request.kind === 'state' || request.kind === 'targets') return executeHarnessWork(owner, request, stillAuthorized)
  // 会话串行性由权威桥保证。宿主不能把慢 submit 排在整个 owner 的队首，
  // 但租约释放必须与所有在途变更互斥，避免 disconnect 与 acquire 交错。
  const lane = mutations.get(owner) ?? { pending: 0, disconnecting: false }
  if (lane.disconnecting || request.kind === 'disconnect' && lane.pending > 0) {
    return { status: 409, body: { ok: false, code: 'task/busy', error: 'Harness work mutation in progress' } }
  }
  mutations.set(owner, lane)
  lane.pending++
  if (request.kind === 'disconnect') lane.disconnecting = true
  try { return await executeHarnessWork(owner, request, stillAuthorized) }
  finally {
    lane.pending--
    if (request.kind === 'disconnect') lane.disconnecting = false
    if (!lane.pending) mutations.delete(owner)
  }
}

const mutations = new Map<string, { pending: number; disconnecting: boolean }>()

async function executeHarnessWork(
  owner: string, request: HarnessWorkRequest, stillAuthorized: () => boolean
): Promise<WorkReply> {
  const holder = `native-work:${owner}`
  if (!stillAuthorized()) return { status: 403, body: { ok: false, error: 'Work credential revoked' } }
  // 一旦该凭据发起过原生工作，就纳入活动面板观察；之后的失败只会让条目标为过期。
  registerWorkbenchActivityOwner(owner)
  if (request.kind === 'new' && request.workspace !== undefined) {
    let valid = false
    try { valid = isAbsolute(request.workspace) && statSync(request.workspace).isDirectory() } catch { /* 无效目录 */ }
    if (!valid) return { status: 400, body: { ok: false, code: 'bad-request', error: 'workspace must be an existing absolute directory' } }
  }
  if (!dshWebManager.bridgeControlEndpoint && request.kind !== 'new') {
    if (request.kind !== 'state' && request.kind !== 'targets') return unavailable()
    return { status: 200, body: { ok: true, status: 'offline', sessionId: null, taskId: null, taskState: null,
      sessions: [], approvals: [], transcript: [], recovery: 'Backend unavailable; previous task outcome is unknown' } }
  }
  // 读状态无启动副作用。变更先持有后台，避免用户重开工作台终止在途任务。
  if (!['state', 'targets', 'disconnect'].includes(request.kind)) {
    const resolver = createDshWebLaunchResolver(HARNESS_AGENTS.dsh)
    const result = await dshWebManager.acquire(target => resolver.resolve(target), { bindingId: holder })
    if (!result.ok) return { status: 409, body: { ok: false, code: result.code, error: result.error } }
    if (!stillAuthorized()) { dshWebManager.release(holder); return { status: 403, body: { ok: false, error: 'Work credential revoked' } } }
    dshWebManager.retainBackend(holder)
  }
  const endpoint = dshWebManager.bridgeControlEndpoint
  if (!endpoint) return unavailable()
  if (!stillAuthorized()) return { status: 403, body: { ok: false, error: 'Work credential revoked' } }
  const result = await requestNativeWorkBridge(endpoint, owner, request)
  if (request.kind === 'disconnect' && result.body.ok === true) {
    dshWebManager.unretainBackend(holder)
    dshWebManager.release(holder)
  }
  if (!stillAuthorized()) return { status: 403, body: { ok: false, error: 'Work credential revoked' } }
  return result
}
