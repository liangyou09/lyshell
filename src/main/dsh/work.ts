import http from 'http'
import { createHash } from 'crypto'
import { statSync } from 'fs'
import { isAbsolute } from 'path'
import { app } from 'electron'
import type { HarnessWorkRequest } from '@shared/harness-work'
import { BRIDGE_KEY_HEADER, locateBridgePackage } from './bridge'
import { persistentGlobalWorkOwner, readSavedWorkState } from './work-history'
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
export function harnessWorkOwner(token: string, global = false): string {
  if (global) return persistentGlobalWorkOwner(app.getPath('userData'))
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
  if (!stillAuthorized()) return { status: 403, body: { ok: false, error: 'Work credential revoked' } }
  if (reply.body.ok === true && reply.body.identity && reply.body.status !== 'offline') {
    if (lastSnapshots.size >= 64 && !lastSnapshots.has(owner)) lastSnapshots.delete(lastSnapshots.keys().next().value!)
    lastSnapshots.set(owner, structuredClone(reply.body))
  }
  reply.body.backend = dshWebManager.recoveryStatus ?? null
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
const lastSnapshots = new Map<string, Record<string, unknown>>()

async function offlineState(owner: string, request: HarnessWorkRequest): Promise<WorkReply> {
  // 离线只降级观测维度：最后确认状态保留既有事实，不用 unconfirmed 覆盖。
  const offlineView = (value: Record<string, unknown>): Record<string, unknown> => {
    const task = value.task && typeof value.task === 'object' ? value.task as Record<string, unknown> : null
    return { ...value, observationState: 'offline', ...(task ? { task: {
      ...task, observationState: 'offline',
      lastConfirmedState: task.lastConfirmedState ?? (task.state === 'unconfirmed' ? null : task.state),
      submissionState: task.submissionState ?? (String(value.taskState) === 'unconfirmed' ? 'unknown' : 'accepted')
    } } : {}) }
  }
  try {
    if (typeof app?.getPath === 'function' && typeof app?.isPackaged === 'boolean') {
      const location = locateBridgePackage({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, devRoot: app.getAppPath() })
      const saved = location && await readSavedWorkState(app.getPath('userData'), location.dir, owner, request)
      if (saved) return { status: saved.ok ? 200 : 409, body: offlineView(saved) }
    }
  } catch { return { status: 503, body: { ok: false, code: 'journal/unavailable', error: 'Saved Harness state unavailable; do not resubmit unknown work' } } }
  const previous = lastSnapshots.get(owner)
  if (previous) {
    const body = structuredClone(previous)
    const stale = (value: Record<string, unknown>): Record<string, unknown> => {
      const interrupted = ['accepted', 'running', 'unconfirmed'].includes(String(value.taskState))
      const task = value.task && typeof value.task === 'object' ? value.task as Record<string, unknown> : null
      const confirmed = task ? task.lastConfirmedState ?? (task.state === 'unconfirmed' ? null : task.state) : null
      return offlineView({ ...value, status: 'offline', stale: true, taskState: interrupted ? 'unconfirmed' : value.taskState,
        task: task ? { ...task, ...(interrupted ? { lastConfirmedState: confirmed, state: 'unconfirmed', recoveryRequired: true,
          // 提交是否已知与观测是否可用是两件事：已确认派发的提交不能降级成 unknown。
          submissionState: task.submissionState ?? (task.state === 'unconfirmed' ? 'unknown' : 'accepted') } : {}) } : value.task,
        approvals: [], recoveryRequired: interrupted })
    }
    const sessions = Array.isArray(body.sessions) ? body.sessions.map(row => stale(row as Record<string, unknown>)) : []
    let target = stale(body)
    if (request.kind === 'state' && (request.sessionId || request.taskId)) {
      const matches = (row: Record<string, unknown>): boolean => (!request.sessionId || row.sessionId === request.sessionId) && (!request.taskId || row.taskId === request.taskId)
      const found = matches(body) ? body : sessions.find(matches)
      if (!found) return { status: 409, body: { ok: false, code: 'task/not-found', error: 'No saved task for this selector' } }
      target = stale(found)
    }
    return { status: 200, body: { ...body, ...target, sessions, identity: null, lastKnownIdentity: body.identity,
      recovery: 'Backend unavailable; progress retained, execution outcome may be unknown' } }
  }
  return { status: 200, body: { ok: true, status: 'offline', identity: null, sessionId: null, taskId: null, taskState: null,
    sessions: [], approvals: [], transcript: [], recovery: 'Backend unavailable; previous task outcome is unknown' } }
}

async function executeHarnessWork(
  owner: string, request: HarnessWorkRequest, stillAuthorized: () => boolean
): Promise<WorkReply> {
  const holder = `native-work:${owner}`
  if (!stillAuthorized()) return { status: 403, body: { ok: false, error: 'Work credential revoked' } }
  // 一旦该凭据发起过原生工作，就纳入活动面板观察；之后的失败只会让条目标为过期。
  registerWorkbenchActivityOwner(owner)
  if (request.kind === 'recover') {
    if (!dshWebManager.bridgeControlEndpoint) {
      const recovered = await dshWebManager.recoverBackend?.()
      if (!recovered && !dshWebManager.running) {
        const resolver = createDshWebLaunchResolver(HARNESS_AGENTS.dsh)
        const started = await dshWebManager.acquire(target => resolver.resolve(target))
        if (!started.ok) return { status: 409, body: { ok: false, code: started.code, error: started.error } }
      }
    }
    if (!stillAuthorized()) return { status: 403, body: { ok: false, error: 'Work credential revoked' } }
    const endpoint = dshWebManager.bridgeControlEndpoint
    return endpoint ? requestNativeWorkBridge(endpoint, owner, { kind: 'targets' }) : unavailable()
  }
  if (request.kind === 'new' && request.workspace !== undefined) {
    let valid = false
    try { valid = isAbsolute(request.workspace) && statSync(request.workspace).isDirectory() } catch { /* 无效目录 */ }
    if (!valid) return { status: 400, body: { ok: false, code: 'bad-request', error: 'workspace must be an existing absolute directory' } }
  }
  if (!dshWebManager.bridgeControlEndpoint && request.kind !== 'new') {
    if (request.kind !== 'state' && request.kind !== 'targets') return unavailable()
    return offlineState(owner, request)
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
