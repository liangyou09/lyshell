/**
 * 原生 Harness 可信状态登记处（供工作台活动面板读取）。
 *
 * 设计边界：
 *   - owner 是不可外传的桥内散列；本模块只在 main 内保存，快照里绝不出现。
 *   - 只读现有 `dshWebManager.bridgeControlEndpoint` 并复用注入的
 *     `requestNativeWorkBridge(owner, { kind: 'state' })`：不 acquire、不启动后台、
 *     不重发任务。所有轮询都是幂等读。
 *   - 只有同一 backend 身份（instanceId + instanceEpoch）的快照能更新条目；
 *     身份变化会丢弃全部旧会话与审批路由，断线/超时只把条目标为过期。
 *   - 空闲、断线、超时都不推导“完成”：未确认的 accepted/running 一律降级为 unknown。
 *   - 审批必须 fresh read 后逐项核对身份、会话、任务、审批 ID 与官方 options，
 *     永不自动批准，也不跨 owner 路由。
 *
 * 独立 registry + 注入 read bridge：work.ts 负责注入真实实现，测试注入 fixture，
 * 避免 activity ↔ work 的循环依赖。
 */
import type { HarnessWorkRequest } from '@shared/harness-work'
import {
  isWorkbenchApprovalOption,
  workbenchActivityKey,
  type WorkbenchActivityRequest,
  type WorkbenchActivitySession,
  type WorkbenchActivitySnapshot,
  type WorkbenchApprovalOption,
  type WorkbenchBackendIdentity,
  type WorkbenchTaskState
} from '@shared/workbench-activity'

export type WorkbenchActivityApproveRequest = Extract<WorkbenchActivityRequest, { kind: 'approve' }>

/** 与 work.ts 的 WorkReply 结构一致；此处不 import，避免 main 内循环依赖。 */
export interface WorkbenchActivityBridgeReply {
  status: number
  body: Record<string, unknown>
}

export interface WorkbenchActivityBridgeOptions {
  timeoutMs: number
}

export type WorkbenchActivityEndpoint = { port: number; key: string }

export type WorkbenchActivityBridgeReader = (
  endpoint: WorkbenchActivityEndpoint,
  owner: string,
  request: HarnessWorkRequest,
  options: WorkbenchActivityBridgeOptions
) => Promise<WorkbenchActivityBridgeReply>

export interface WorkbenchActivityDeps {
  /** 只读后台控制端点；null 表示进程没有可用的共享后台。 */
  readEndpoint: () => WorkbenchActivityEndpoint | null
  /** 转发原生工作请求；读状态时只会收到 { kind: 'state' }。 */
  readBridge: WorkbenchActivityBridgeReader
  now: () => number
}

const MAX_OWNERS = 64
const MAX_SESSIONS_PER_OWNER = 64
const MAX_APPROVALS_PER_TASK = 128
const MAX_TRANSCRIPT_ENTRIES = 256
/** 超过该长度的工具调用不当作可核对操作，避免把截断内容当完整命令展示。 */
const MAX_OPERATION_CHARS = 4096
const MAX_ID_CHARS = 128
const MAX_WORKSPACE_CHARS = 2048
const MAX_TOOL_NAME_CHARS = 256
const MAX_REASON_CHARS = 4000
const MAX_TRANSCRIPT_TEXT_CHARS = 1024
const READ_TIMEOUT_MS = 3000
const APPROVE_TIMEOUT_MS = 15000
/** 单次快照读取的总预算；超预算的 owner 保持过期状态，不阻塞界面。 */
const READ_BUDGET_MS = 6000
const READ_CONCURRENCY = 4
const OWNER_PATTERN = /^[a-f0-9]{64}$/

/** 可验证的当前任务状态；其余状态保留原意。 */
const TURN_STATES: readonly WorkbenchTaskState[] = [
  'accepted', 'running', 'completed', 'failed', 'cancelled', 'unconfirmed', 'unknown'
]
const TERMINAL_STATES: readonly WorkbenchTaskState[] = ['completed', 'failed', 'cancelled']
/** 只有这些种类的输出可以拼回“完整工具调用”；未知种类照常显示文本但不参与操作还原。 */
const TOOL_CALL_KIND = 'tool-call'

const deps: WorkbenchActivityDeps = {
  readEndpoint: () => null,
  readBridge: async () => ({ status: 503, body: { ok: false } }),
  now: () => Date.now()
}

export function configureWorkbenchActivity(next: Partial<WorkbenchActivityDeps>): void {
  if (next.readEndpoint) deps.readEndpoint = next.readEndpoint
  if (next.readBridge) deps.readBridge = next.readBridge
  if (next.now) deps.now = next.now
}

interface ApprovalRecord {
  id: string
  toolName: string
  callId?: string
  reason: string
  options: WorkbenchApprovalOption[]
  askedAt: number
  operation?: string
}

interface SessionRecord {
  sessionId: string
  workspace: string
  taskId: string | null
  taskAcceptedAt: number | null
  taskState: WorkbenchTaskState
  updatedAt: number
  stale: boolean
  approvals: Map<string, ApprovalRecord>
}

interface OwnerRecord {
  owner: string
  identity: WorkbenchBackendIdentity | null
  connection: 'connected' | 'offline' | 'stale'
  error?: string
  sessions: Map<string, SessionRecord>
  touchedAt: number
  revision: number
}

/** owner → 该凭据已调用过的原生任务状态。 */
const owners = new Map<string, OwnerRecord>()
/** 最近一次确认的后台身份；身份换代后旧数据整体作废。 */
let backendIdentity: WorkbenchBackendIdentity | null = null
/** 与 readWorkbenchActivity 共用一把锁，避免并发读和审批互相覆盖。 */
let lane: Promise<unknown> = Promise.resolve()

interface ParsedApproval {
  id: string
  toolName: string
  callId?: string
  reason: string
  options: WorkbenchApprovalOption[]
  askedAt: number
}

interface ParsedTranscriptEntry {
  seq: number
  kind: string
  text: string
  callId?: string
}

interface ParsedState {
  offline: boolean
  identity: WorkbenchBackendIdentity | null
  /** 该凭据当前选择的会话；disconnect 后为 null。 */
  sessionId: string | null
  /** 快照中任务实际所属的会话（disconnect 后仍指向旧会话）。 */
  taskSessionId: string | null
  taskId: string | null
  taskAcceptedAt: number | null
  taskState: WorkbenchTaskState
  sessions: Array<{ sessionId: string; workspace: string }>
  approvals: ParsedApproval[]
  transcript: ParsedTranscriptEntry[]
  transcriptTruncated: boolean
}

export function registerWorkbenchActivityOwner(owner: string): void {
  if (!OWNER_PATTERN.test(owner)) return
  const now = deps.now()
  const existing = owners.get(owner)
  if (existing) {
    existing.touchedAt = now
    return
  }
  if (owners.size >= MAX_OWNERS) evictOldestOwner()
  owners.set(owner, {
    owner, identity: null, connection: 'stale', sessions: new Map(), touchedAt: now, revision: 0
  })
}

/**
 * 登记一次原生工作回执（含 new/select/submit/cancel 的权威快照）。
 * 畸形或拒绝对话不会被当成状态更新，也不会把已有条目误标成败。
 */
export function recordWorkbenchActivityReply(
  owner: string, reply: WorkbenchActivityBridgeReply
): void {
  if (!OWNER_PATTERN.test(owner) || reply.status !== 200) return
  const parsed = parseStateBody(reply.body)
  if (!parsed) return
  registerWorkbenchActivityOwner(owner)
  const record = owners.get(owner)
  if (record) {
    record.revision++
    applyParsedState(record, parsed, deps.now())
  }
}

/** 清空登记内容（测试与后台整体回收时使用）；保留注入依赖。 */
export function resetWorkbenchActivityState(): void {
  owners.clear()
  backendIdentity = null
}

/**
 * 读取所有已登记凭据的权威状态。
 * 绝不 acquire、不启动后台、不重发任务；失败只会让条目过期。
 */
export async function readWorkbenchActivity(): Promise<WorkbenchActivitySnapshot> {
  try {
    return await serialize(readSnapshotLocked)
  } catch (error) {
    return buildSnapshot(deps.now(), 'stale', describeError(error))
  }
}

/** 用户显式点击后才会走到这里；发送前 fresh read 并逐项核对。 */
export async function approveWorkbenchActivity(
  request: WorkbenchActivityApproveRequest
): Promise<WorkbenchActivitySnapshot> {
  try {
    return await serialize(() => approveLocked(request))
  } catch (error) {
    return buildSnapshot(deps.now(), 'stale', describeError(error))
  }
}

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = (): Promise<T> => task()
  const result = lane.then(run, run)
  lane = result.then(() => {}, () => {})
  return result
}

async function readSnapshotLocked(): Promise<WorkbenchActivitySnapshot> {
  const now = deps.now()
  const endpoint = readEndpoint()
  if (!endpoint) {
    for (const record of owners.values()) {
      markUnavailable(record, 'offline', 'Native Harness backend is not running', now)
    }
    return buildSnapshot(now, 'offline', 'Native Harness backend is not running')
  }
  await pollOwners(endpoint, now + READ_BUDGET_MS)
  const observedAt = deps.now()
  const connection = connectionOf()
  const error = connection === 'connected'
    ? undefined
    : connection === 'offline'
      ? 'Native Harness backend is not running'
      : firstOwnerError() ?? 'Native Harness state is stale'
  return buildSnapshot(observedAt, connection, error)
}

async function approveLocked(
  request: WorkbenchActivityApproveRequest
): Promise<WorkbenchActivitySnapshot> {
  const now = deps.now()
  if (!validApprovalRequest(request)) {
    return buildSnapshot(now, connectionOf(), 'Invalid approval request')
  }
  const endpoint = readEndpoint()
  if (!endpoint) {
    for (const record of owners.values()) {
      markUnavailable(record, 'offline', 'Native Harness backend is not running', now)
    }
    return buildSnapshot(now, 'offline', 'Native Harness backend is not running')
  }
  const route = findApprovalRoute(request)
  if (!route) {
    return buildSnapshot(now, connectionOf(), 'This approval is no longer available. Refresh the activity list.')
  }
  const { record, owner } = route
  const revision = record.revision
  // 1) 发送前 fresh read：只有同一后台身份、同一会话、同一任务、同一审批且选项合法才继续。
  const fresh = await readOwnerState(endpoint, owner)
  if (record.revision !== revision || !sameEndpoint(endpoint, readEndpoint())) {
    return buildSnapshot(deps.now(), 'stale', 'Harness state changed during approval verification; the approval was not sent.')
  }
  if (!fresh) {
    markUnavailable(record, 'stale', 'Could not confirm the approval with the native Harness backend', deps.now())
    return buildSnapshot(deps.now(), connectionOf(), 'Could not confirm the approval with the native Harness backend.')
  }
  if (fresh.offline) {
    markUnavailable(record, 'offline', 'Native Harness backend reported offline', deps.now())
    return buildSnapshot(deps.now(), 'offline', 'Native Harness backend is not running')
  }
  const relation = identityRelation(fresh.identity)
  if (relation !== 'equal') {
    // 后台身份已变化：旧审批路由一律作废，绝不把旧身份的审批发给新实例。
    resetRetained()
    if (relation === 'newer') {
      backendIdentity = fresh.identity
      applyParsedState(record, fresh, deps.now())
    }
    return buildSnapshot(deps.now(), connectionOf(),
      'The native Harness backend identity changed; the approval was not sent.')
  }
  applyParsedState(record, fresh, deps.now())
  if (fresh.sessionId !== request.sessionId || fresh.taskId !== request.taskId) {
    return buildSnapshot(deps.now(), connectionOf(),
      'This approval no longer matches the current session or task; it was not sent.')
  }
  const approval = fresh.approvals.find(entry => entry.id === request.approvalId)
  if (!approval || !approval.options.includes(request.optionId)) {
    return buildSnapshot(deps.now(), connectionOf(),
      'The requested option is not offered by the native Harness backend; the approval was not sent.')
  }
  if (request.optionId === 'allowed-once' && !resolveOperation(approval, fresh)) {
    return buildSnapshot(deps.now(), connectionOf(),
      'The operation details are incomplete. Verify the request in the official workbench before allowing it.')
  }
  // 2) 只提交官方返回的审批 ID 与该审批声明的选项，不自动选择。
  let reply: WorkbenchActivityBridgeReply | null = null
  try {
    reply = await deps.readBridge(endpoint, owner,
      { kind: 'approve', id: approval.id, optionId: request.optionId }, { timeoutMs: APPROVE_TIMEOUT_MS })
  } catch {
    reply = null
  }
  if (!reply || reply.status >= 500) {
    markUnavailable(record, 'stale', 'Approval outcome is unknown', deps.now())
    return buildSnapshot(deps.now(), connectionOf(), 'The approval request failed; its outcome is unknown. Read the state before retrying.')
  }
  if (reply.status === 200) {
    const after = parseStateBody(reply.body)
    if (after && !after.offline && identityRelation(after.identity) === 'equal') {
      applyParsedState(record, after, deps.now())
    } else if (after?.offline) {
      markUnavailable(record, 'offline', 'Native Harness backend reported offline', deps.now())
    } else {
      markUnavailable(record, 'stale', 'Approval outcome could not be verified', deps.now())
    }
  }
  const accepted = reply.status === 200 && reply.body.ok === true
  return buildSnapshot(deps.now(), connectionOf(),
    accepted ? undefined : 'The native Harness backend refused the approval; read the state again.')
}

/** 解析 owner 的 state 回执；畸形、不一致或身份不明一律返回 null（不应用）。 */
async function readOwnerState(
  endpoint: WorkbenchActivityEndpoint, owner: string
): Promise<ParsedState | null> {
  let reply: WorkbenchActivityBridgeReply
  try {
    reply = await deps.readBridge(endpoint, owner, { kind: 'state' }, { timeoutMs: READ_TIMEOUT_MS })
  } catch {
    return null
  }
  if (!reply || reply.status !== 200 || !isRecord(reply.body)) return null
  return parseStateBody(reply.body)
}

async function pollOwners(endpoint: WorkbenchActivityEndpoint, deadline: number): Promise<void> {
  const queue = [...owners.values()]
  const workers = Math.min(READ_CONCURRENCY, queue.length)
  const poll = async (): Promise<void> => {
    for (;;) {
      const record = queue.shift()
      if (!record) return
      const now = deps.now()
      if (now >= deadline) {
        markUnavailable(record, 'stale', 'Native Harness state read timed out', now)
        continue
      }
      const timeoutMs = Math.min(READ_TIMEOUT_MS, Math.max(500, deadline - now))
      let reply: WorkbenchActivityBridgeReply | null = null
      const revision = record.revision
      try {
        reply = await deps.readBridge(endpoint, record.owner, { kind: 'state' }, { timeoutMs })
      } catch {
        reply = null
      }
      // 在途读不能覆盖期间已落地的新提交/终态回执，旧端点也不提供当前状态。
      if (record.revision !== revision) continue
      if (!sameEndpoint(endpoint, readEndpoint())) {
        markUnavailable(record, 'stale', 'Native Harness backend changed during the state read', deps.now())
        continue
      }
      const parsed = reply && reply.status === 200 && isRecord(reply.body)
        ? parseStateBody(reply.body)
        : null
      if (!parsed) {
        markUnavailable(record, 'stale', 'Native Harness state is unavailable', deps.now())
        continue
      }
      applyParsedState(record, parsed, deps.now())
    }
  }
  await Promise.all(Array.from({ length: workers }, poll))
}

function applyParsedState(record: OwnerRecord, parsed: ParsedState, now: number): void {
  if (parsed.offline) {
    markUnavailable(record, 'offline', 'Native Harness backend reported offline', now)
    return
  }
  if (!parsed.identity) return
  const relation = identityRelation(parsed.identity)
  if (relation === 'stale') {
    // 更旧身份的回执：不得覆盖新实例的数据。
    markUnavailable(record, 'stale', 'Native Harness backend identity changed', now)
    return
  }
  if (relation === 'newer') {
    resetRetained()
    backendIdentity = parsed.identity
  }
  // 外部并行读取的旧回执可能迟于新任务到达；官方 acceptedAt 是任务的创建证据。
  if (parsed.taskAcceptedAt !== null && [...record.sessions.values()].some(session =>
    session.taskAcceptedAt !== null && session.taskAcceptedAt > parsed.taskAcceptedAt!
  )) return
  record.identity = parsed.identity
  record.connection = 'connected'
  record.error = undefined
  record.touchedAt = now

  const present = new Set(parsed.sessions.map(entry => entry.sessionId))
  for (const key of [...record.sessions.keys()]) {
    if (!present.has(key)) record.sessions.delete(key)
  }
  for (const entry of parsed.sessions) {
    let session = record.sessions.get(entry.sessionId)
    if (!session) {
      session = {
        sessionId: entry.sessionId, workspace: entry.workspace, taskId: null, taskAcceptedAt: null,
        taskState: 'unknown', updatedAt: now, stale: false, approvals: new Map()
      }
      record.sessions.set(entry.sessionId, session)
    } else if (session.workspace !== entry.workspace) {
      session.workspace = entry.workspace
      session.updatedAt = now
    }
    if (entry.sessionId === parsed.taskSessionId && parsed.taskId !== null) {
      if (session.taskId === parsed.taskId && (
        TERMINAL_STATES.includes(session.taskState) && session.taskState !== parsed.taskState ||
        session.taskState === 'running' && parsed.taskState === 'accepted'
      )) continue
      // 本次快照明确描述了该会话的当前任务：可信更新。
      if (session.taskId !== parsed.taskId) {
        session.taskId = parsed.taskId
        session.taskAcceptedAt = parsed.taskAcceptedAt
        session.updatedAt = now
      }
      if (session.taskState !== parsed.taskState) {
        session.taskState = parsed.taskState
        session.updatedAt = now
      }
      session.stale = false
      const approvals = new Map<string, ApprovalRecord>()
      for (const approval of parsed.approvals) {
        const record_ = toApprovalRecord(approval, parsed)
        approvals.set(record_.id, record_)
      }
      session.approvals = approvals
    } else {
      // 非当前任务：已见终态保留为历史，未进入终态的降级为未知（不推导完成）。
      if (isPending(session.taskState)) {
        session.taskState = 'unknown'
        session.updatedAt = now
        session.stale = true
      } else if (session.taskState !== 'unknown') {
        session.stale = false
      }
      session.approvals.clear()
    }
  }
}

function toApprovalRecord(approval: ParsedApproval, parsed: ParsedState): ApprovalRecord {
  const operation = resolveOperation(approval, parsed)
  return {
    id: approval.id,
    toolName: approval.toolName,
    ...(approval.callId ? { callId: approval.callId } : {}),
    reason: approval.reason,
    options: [...approval.options],
    askedAt: approval.askedAt,
    ...(operation ? { operation } : {})
  }
}

/**
 * 只从“同 taskId/sessionId/callId 且完整”的 tool-call 文本还原操作。
 * 输出被截断、分块不连续、过长或缺少 callId 时不提供操作。
 */
function resolveOperation(approval: ParsedApproval, parsed: ParsedState): string | undefined {
  if (!approval.callId || parsed.transcriptTruncated) return undefined
  const chunks = parsed.transcript
    .filter(entry => entry.kind === TOOL_CALL_KIND && entry.callId === approval.callId)
    .sort((left, right) => left.seq - right.seq)
  if (!chunks.length) return undefined
  for (let index = 1; index < chunks.length; index += 1) {
    if (chunks[index].seq !== chunks[index - 1].seq + 1) return undefined
  }
  const text = chunks.map(entry => entry.text).join('')
  if (!text.trim() || text.length > MAX_OPERATION_CHARS) return undefined
  return text
}

function markUnavailable(
  record: OwnerRecord,
  connection: 'offline' | 'stale',
  error: string,
  now: number
): void {
  record.connection = connection
  record.error = error
  record.touchedAt = now
  for (const session of record.sessions.values()) {
    session.stale = true
    session.approvals.clear()
    if (isPending(session.taskState)) {
      session.taskState = 'unknown'
      session.updatedAt = now
    }
  }
}

/** 后台身份换代：旧会话与旧审批路由全部作废。 */
function resetRetained(): void {
  const now = deps.now()
  for (const record of owners.values()) {
    record.sessions.clear()
    record.identity = null
    record.connection = 'stale'
    record.error = 'Native Harness backend identity changed'
    record.touchedAt = now
  }
  backendIdentity = null
}

function evictOldestOwner(): void {
  let oldest: OwnerRecord | null = null
  for (const record of owners.values()) {
    if (!oldest || record.touchedAt < oldest.touchedAt) oldest = record
  }
  if (oldest) owners.delete(oldest.owner)
}

function findApprovalRoute(
  request: WorkbenchActivityApproveRequest
): { record: OwnerRecord; owner: string } | null {
  if (!backendIdentity || !sameIdentity(backendIdentity, request.identity)) return null
  const matches: OwnerRecord[] = []
  for (const record of owners.values()) {
    if (!record.identity || !sameIdentity(record.identity, request.identity)) continue
    const session = record.sessions.get(request.sessionId)
    if (!session || session.taskId !== request.taskId) continue
    if (!session.approvals.has(request.approvalId)) continue
    matches.push(record)
  }
  // 只允许唯一归属；多 owner 同时命中说明数据不可信，不做任何审批。
  return matches.length === 1 ? { record: matches[0], owner: matches[0].owner } : null
}

function buildSnapshot(
  observedAt: number,
  connection: 'connected' | 'offline' | 'stale',
  error?: string
): WorkbenchActivitySnapshot {
  const sessions: WorkbenchActivitySession[] = []
  const seen = new Map<string, number>()
  for (const record of owners.values()) {
    if (!record.identity) continue
    for (const session of record.sessions.values()) {
      const row = toPublicSession(record.identity, session)
      // 同一后台身份下同一会话/任务只应有一条；重复时保留更新时间较新的那条。
      const existing = seen.get(row.key)
      if (existing !== undefined) {
        const previous = sessions[existing]
        if (row.updatedAt > previous.updatedAt) sessions[existing] = row
        continue
      }
      seen.set(row.key, sessions.length)
      sessions.push(row)
    }
  }
  sessions.sort((left, right) => right.updatedAt - left.updatedAt || left.key.localeCompare(right.key))
  const identity = backendIdentity ? { ...backendIdentity } : null
  return { observedAt, connection, identity, sessions, ...(error ? { error } : {}) }
}

function toPublicSession(
  identity: WorkbenchBackendIdentity, session: SessionRecord
): WorkbenchActivitySession {
  return {
    key: workbenchActivityKey(identity, session.sessionId, session.taskId),
    sessionId: session.sessionId,
    workspace: session.workspace,
    taskId: session.taskId,
    taskState: session.taskState,
    source: 'native-harness',
    updatedAt: session.updatedAt,
    stale: session.stale,
    approvals: [...session.approvals.values()].map(approval => ({
      id: approval.id,
      toolName: approval.toolName,
      ...(approval.callId ? { callId: approval.callId } : {}),
      reason: approval.reason,
      options: [...approval.options],
      askedAt: approval.askedAt,
      ...(approval.operation ? { operation: approval.operation } : {})
    }))
  }
}

function connectionOf(): 'connected' | 'offline' | 'stale' {
  if (!readEndpoint()) return 'offline'
  const records = [...owners.values()]
  if (!records.length) return 'connected'
  if (records.every(record => record.connection === 'connected')) return 'connected'
  if (records.some(record => record.connection === 'connected')) return 'stale'
  if (records.every(record => record.connection === 'offline')) return 'offline'
  return 'stale'
}

function firstOwnerError(): string | undefined {
  for (const record of owners.values()) if (record.error) return record.error
  return undefined
}

function readEndpoint(): WorkbenchActivityEndpoint | null {
  try {
    const endpoint = deps.readEndpoint()
    if (!endpoint || !Number.isSafeInteger(endpoint.port) || endpoint.port <= 0) return null
    if (typeof endpoint.key !== 'string' || !endpoint.key) return null
    return endpoint
  } catch {
    return null
  }
}

function sameEndpoint(left: WorkbenchActivityEndpoint, right: WorkbenchActivityEndpoint | null): boolean {
  return !!right && left.port === right.port && left.key === right.key
}

function validApprovalRequest(request: WorkbenchActivityApproveRequest): boolean {
  return isRecord(request) &&
    isBoundedId(request.sessionId) && isBoundedId(request.taskId) && isBoundedId(request.approvalId) &&
    isWorkbenchApprovalOption(request.optionId) &&
    isRecord(request.identity) &&
    typeof request.identity.instanceId === 'string' &&
    request.identity.instanceId.length > 0 && request.identity.instanceId.length <= MAX_ID_CHARS &&
    Number.isSafeInteger(request.identity.instanceEpoch) && request.identity.instanceEpoch >= 1
}

function identityRelation(
  incoming: WorkbenchBackendIdentity | null
): 'equal' | 'newer' | 'stale' {
  if (!incoming) return 'stale'
  if (!backendIdentity) return 'newer'
  if (sameIdentity(backendIdentity, incoming)) return 'equal'
  // epoch 单调递增；更旧的回执不得覆盖新实例。
  return incoming.instanceEpoch > backendIdentity.instanceEpoch ? 'newer' : 'stale'
}

function sameIdentity(
  left: WorkbenchBackendIdentity, right: WorkbenchBackendIdentity
): boolean {
  return left.instanceId === right.instanceId && left.instanceEpoch === right.instanceEpoch
}

function isPending(state: WorkbenchTaskState): boolean {
  return state === 'accepted' || state === 'running'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isBoundedId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS
}

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

function describeError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Workbench activity is unavailable'
}

function parseIdentity(value: unknown): WorkbenchBackendIdentity | null {
  if (!isRecord(value)) return null
  const instanceId = typeof value.instanceId === 'string' &&
    value.instanceId.length > 0 && value.instanceId.length <= MAX_ID_CHARS ? value.instanceId : null
  const instanceEpoch = typeof value.instanceEpoch === 'number' &&
    Number.isSafeInteger(value.instanceEpoch) && value.instanceEpoch >= 1 ? value.instanceEpoch : null
  return instanceId !== null && instanceEpoch !== null ? { instanceId, instanceEpoch } : null
}

function parseTaskState(value: unknown): WorkbenchTaskState | null {
  if (value === null || value === undefined) return 'unknown'
  return typeof value === 'string' && (TURN_STATES as readonly string[]).includes(value)
    ? value as WorkbenchTaskState
    : null
}

/**
 * 严格校验原生 state 回执。任何前后不一致（任务/会话/审批/输出归属对不上）
 * 都整份拒绝，避免把错误归属的终态或审批显示给用户。
 */
function parseStateBody(body: Record<string, unknown>): ParsedState | null {
  if (body.ok !== true) return null
  const status = body.status
  // 只把 offline 当断线语义；无法识别的状态名不影响 taskState 的权威性。
  if (typeof status !== 'string' || status.length === 0 || status.length > 32) return null
  const offline = status === 'offline'
  const identity = body.identity === undefined || body.identity === null
    ? null
    : parseIdentity(body.identity)
  if (!offline && !identity) return null

  if (body.sessionId !== null && body.sessionId !== undefined && !isBoundedId(body.sessionId)) return null
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : null
  if (body.taskId !== null && body.taskId !== undefined && !isBoundedId(body.taskId)) return null
  const taskId = typeof body.taskId === 'string' ? body.taskId : null
  const taskState = parseTaskState(body.taskState)
  if (!taskState) return null
  if ((taskId === null) !== (taskState === 'unknown')) return null

  // 任务归属：优先取官方 task.sessionId；disconnect 后 body.sessionId 为 null，任务仍属旧会话。
  let taskSessionId: string | null = sessionId
  let taskAcceptedAt: number | null = null
  if (body.task !== undefined && body.task !== null) {
    if (!isRecord(body.task)) return null
    if (body.task.taskId !== taskId) return null
    if (body.task.state !== undefined && body.task.state !== taskState) return null
    if (!isBoundedId(body.task.sessionId)) return null
    taskSessionId = body.task.sessionId
    if (body.task.acceptedAt !== undefined) {
      if (!isSafeTimestamp(body.task.acceptedAt)) return null
      taskAcceptedAt = body.task.acceptedAt
    }
  }
  if (taskId !== null && taskSessionId === null) return null

  const workspaceOk = body.workspace === undefined || body.workspace === null ||
    (typeof body.workspace === 'string' && body.workspace.length <= MAX_WORKSPACE_CHARS &&
      !body.workspace.includes('\0'))
  if (!workspaceOk) return null

  if (!Array.isArray(body.sessions) || body.sessions.length > MAX_SESSIONS_PER_OWNER) return null
  const sessions: ParsedState['sessions'] = []
  const seenSessions = new Set<string>()
  for (const raw of body.sessions) {
    if (!isRecord(raw) || !isBoundedId(raw.sessionId)) return null
    const workspace = typeof raw.workspace === 'string' && raw.workspace.length > 0 &&
      raw.workspace.length <= MAX_WORKSPACE_CHARS && !raw.workspace.includes('\0') ? raw.workspace : null
    if (workspace === null || seenSessions.has(raw.sessionId)) return null
    seenSessions.add(raw.sessionId)
    sessions.push({ sessionId: raw.sessionId, workspace })
  }
  if (sessionId !== null && !seenSessions.has(sessionId)) return null
  if (taskSessionId !== null && !seenSessions.has(taskSessionId)) return null
  if (sessionId !== null && typeof body.workspace === 'string') {
    const selected = sessions.find(entry => entry.sessionId === sessionId)
    if (!selected || selected.workspace !== body.workspace) return null
  }

  if (!Array.isArray(body.approvals) || body.approvals.length > MAX_APPROVALS_PER_TASK) return null
  if (body.approvals.length > 0 && taskId === null) return null
  const approvals: ParsedApproval[] = []
  const seenApprovals = new Set<string>()
  for (const raw of body.approvals) {
    if (!isRecord(raw)) return null
    if (!isBoundedId(raw.id) || seenApprovals.has(raw.id)) return null
    if (typeof raw.toolName !== 'string' || raw.toolName.length === 0 ||
      raw.toolName.length > MAX_TOOL_NAME_CHARS) return null
    if (typeof raw.reason !== 'string' || raw.reason.length > MAX_REASON_CHARS) return null
    if (!isSafeTimestamp(raw.askedAt)) return null
    if (!Array.isArray(raw.options) || raw.options.length === 0 || raw.options.length > 3) return null
    const options: WorkbenchApprovalOption[] = []
    for (const option of raw.options) {
      if (!isWorkbenchApprovalOption(option) || options.includes(option)) return null
      options.push(option)
    }
    if (raw.callId !== undefined && raw.callId !== null && !isBoundedId(raw.callId)) return null
    const callId = typeof raw.callId === 'string' ? raw.callId : undefined
    // 官方只为当前任务创建审批；归属必须与任务一致，否则整份快照不可信。
    if (raw.taskId !== undefined && raw.taskId !== null && raw.taskId !== taskId) return null
    if (raw.sessionId !== undefined && raw.sessionId !== null && raw.sessionId !== taskSessionId) return null
    seenApprovals.add(raw.id)
    approvals.push({ id: raw.id, toolName: raw.toolName, ...(callId ? { callId } : {}),
      reason: raw.reason, options, askedAt: raw.askedAt })
  }

  if (!Array.isArray(body.transcript) || body.transcript.length > MAX_TRANSCRIPT_ENTRIES) return null
  const transcript: ParsedTranscriptEntry[] = []
  for (const raw of body.transcript) {
    if (!isRecord(raw)) return null
    if (!isSafeTimestamp(raw.seq) || typeof raw.kind !== 'string' ||
      raw.kind.length === 0 || raw.kind.length > 32) return null
    if (typeof raw.text !== 'string' || raw.text.length > MAX_TRANSCRIPT_TEXT_CHARS) return null
    if (!isSafeTimestamp(raw.at)) return null
    // 输出必须属于本任务的同一会话，不能把别的回合当成审批依据。
    if (raw.taskId !== taskId || raw.sessionId !== taskSessionId) return null
    if (raw.callId !== undefined && !isBoundedId(raw.callId)) return null
    transcript.push({ seq: raw.seq, kind: raw.kind, text: raw.text,
      ...(typeof raw.callId === 'string' ? { callId: raw.callId } : {}) })
  }

  // 官方离线回执不带 transcript/transcriptTruncated；离线时也绝不会据此展示操作。
  const truncated = body.transcriptTruncated === undefined ? offline : body.transcriptTruncated
  if (typeof truncated !== 'boolean') return null

  if (terminalStateOf(approvals, taskState) === null) return null
  return {
    offline, identity, sessionId, taskSessionId, taskId, taskAcceptedAt, taskState,
    sessions, approvals, transcript, transcriptTruncated: truncated
  }
}

/** 已进入终态的会话不应再有待处理审批；发现则视为不一致。 */
function terminalStateOf(
  approvals: ParsedApproval[], taskState: WorkbenchTaskState
): true | null {
  if (approvals.length > 0 && TERMINAL_STATES.includes(taskState)) return null
  return true
}
