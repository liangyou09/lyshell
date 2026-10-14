/**
 * PetLink 共享后台控制 —— LyShell 与 dsh 桥共用的契约（类型 + 校验 + 路由常量）。
 * Exclusive 名称与 /api/exclusive-control 路径为兼容保留，不表示 Web 独占或只读。
 *
 * 有效方案见 docs/petlink-shared-harness.md（v3）：安装启用 PetLink 插件 = **一次完整工作授权**；
 * 不为 read/submit/cancel/approve/ui 分项授权，不建多 owner。这里的类型只描述
 * 「LyShell（受控方）↔ dsh 桥（执行方）」这一条控制通道。
 *
 * 边界（务必与实现一致）：
 *   - 本文件的任何类型**不含凭据**。token 只在 env/请求头里走，绝不进状态、日志或快照。
 *   - 本模块是纯逻辑（main 与 renderer 两侧都可 import），不依赖 Node/Electron。
 *   - 校验函数只做「形状 + 长度 + 取值域」，业务拒绝（busy / epoch 过期 / 无桥）在服务端判定。
 */

/** Pet 托管控制的状态机取值。`held` = 当前存在一个 PetLink 任务绑定；所有相位均放行官方 Web 写操作。 */
export type ExclusiveControlPhase = 'free' | 'acquiring' | 'held' | 'releasing'

export interface ExclusiveDiagnostic {
  code: string
  causeCodes: string[]
  phase: 'agent' | 'connect' | 'response-body' | 'protocol' | 'unknown'
  httpResponse: boolean | 'unknown'
}

const DIAGNOSTIC_CODES = new Set(['TRANSPORT', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'TimeoutError', 'AbortError'])
export function exclusiveDiagnostic(error: unknown, phase: ExclusiveDiagnostic['phase'], httpResponse: ExclusiveDiagnostic['httpResponse']): ExclusiveDiagnostic {
  const found: string[] = [], seen = new Set<unknown>()
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object' || seen.has(value) || seen.size >= 8) return
    seen.add(value)
    const item = value as Record<string, unknown>
    const code = typeof item.code === 'string' && DIAGNOSTIC_CODES.has(item.code) ? item.code
      : typeof item.name === 'string' && DIAGNOSTIC_CODES.has(item.name) ? item.name : null
    if (code && !found.includes(code)) found.push(code)
    visit(item.cause)
    if (Array.isArray(item.errors)) item.errors.slice(0, 4).forEach(visit)
  }
  visit(error)
  return { code: found[0] ?? 'unknown', causeCodes: found.slice(1), phase, httpResponse }
}
export function readExclusiveDiagnostic(value: unknown): ExclusiveDiagnostic | undefined {
  if (!value || typeof value !== 'object') return undefined
  const data = value as Record<string, unknown>
  const causes = Array.isArray(data.causeCodes) ? data.causeCodes.slice(0, 7).map(code => ({ code })) : []
  const phase = ['agent', 'connect', 'response-body', 'protocol'].includes(String(data.phase)) ? data.phase as ExclusiveDiagnostic['phase'] : 'unknown'
  return exclusiveDiagnostic({ code: data.code, cause: { errors: causes } }, phase,
    data.httpResponse === true || data.httpResponse === false ? data.httpResponse : 'unknown')
}

/** 一次控制绑定的权威身份（跨进程可见，**不含凭据**）。 */
export interface ExclusiveBindingView {
  bindingId: string
  /** Pet 绑定代际：每次 acquire 递增；旧代际的取消/审批/事件一律拒绝 */
  epoch: number
  /** 插件身份（谁在控制） */
  pluginId: string
  /** 插件实例 id（同一插件的不同进程实例必须区分） */
  pluginInstanceId: string
  /** LyShell 托管的 dsh 后台实例身份（由 dsh 进程铸造） */
  instanceId: string
  /** dsh 实例代际 */
  instanceEpoch: number
  acquiredAt: number
  /** 当前被控制的会话（submit/session 之后更新；供 S4 显示） */
  sessionIdForTask?: string
}

// ========== 共享工作台查看器（S4：官方 Web 的工作台导航与 ack） ==========

/**
 * 一次工作台导航请求 —— **冻结 viewer/session/epoch/revision**。
 *
 * 语义（S4 要求）：请求只在这个 revision 上有效；用户浏览历史会推进 viewer revision，
 * 从而作废先前未落地的请求。绝不能用「持续轮询的旧 desiredSession」把用户拽回来。
 */
export interface ExclusiveViewerRequest {
  requestId: string
  /** 目标会话（冻结值；ack 必须核对官方 UI 实际当前会话等于它） */
  sessionId: string
  /** 请求冻结的 viewer revision（单调递增整数，ms 量级） */
  revision: number
  /** 提交时的Pet 绑定代际 */
  epoch: number
  requestedAt: number
}

/** 导航结果：`navigated` 只能由「官方 UI 实际已在该会话」证明，调用 openSession 本身不算。 */
export type ExclusiveViewerAckStatus = 'navigated' | 'failed' | 'superseded'

/** 一次导航的落地回执（浏览器半上报 → 桥 → LyShell）。不含任何凭据与页面内容。 */
export interface ExclusiveViewerAck {
  requestId: string
  revision: number
  /** 请求的冻结目标 */
  sessionId: string
  /** ack 时刻官方 UI **实际**当前会话（navigated 时必须等于 sessionId） */
  currentSessionId: string | null
  status: ExclusiveViewerAckStatus
  at: number
  /** 固定分类的失败原因（不回显页面/模型原文） */
  reason?: string
}

/** 工作台查看器状态（浏览器可消费；**不含凭据**）。 */
export interface ExclusiveViewerState {
  /** 最高已观察到的 viewer revision（用户浏览历史会推进它） */
  revision: number
  /** 最后一次真实落地的请求 revision（官方 UI 已导航到位） */
  appliedRevision: number
  /** 官方 UI 当前所在会话（由浏览器半上报；null = 未知） */
  currentSessionId: string | null
  /** Pet 正在控制的会话（Pet target）；null = 当前无活动任务 */
  petSessionId: string | null
  /** 尚未落地的导航请求；null = 没有 */
  request: ExclusiveViewerRequest | null
  /** 最近一次导航结果 */
  lastAck: ExclusiveViewerAck | null
  /** 浏览器半是否在线（近期有过 status/ack 往返） */
  connected: boolean
  /**
   * 未落地请求是否属于**读到这份状态的这个浏览器**。
   * viewer cookie 是 HttpOnly，浏览器无法自证身份，只能由桥按 viewer 身份如实告知 ——
   * 别的浏览器既不能 ack 这条请求，也不该把「导航待落地」显示成自己的。
   */
  ownedByCurrentViewer?: boolean
  updatedAt: number
}

/**
 * 共享工作台「详情面」—— 主进程 → 渲染层推送的窄事件负载（**不含凭据**）。
 *
 * 为什么需要它：详情页签的打开必须由**真实控制状态变化**驱动，而不是渲染层轮询里
 * 「看起来该开了」的猜测。`key` 是这一面的稳定身份（phase/epoch/taskId/sessionId 的
 * 组合），渲染层只在 key 变化时动作 —— 重复的同一实例同一会话 ⇒ 复用单页签、不重发导航、
 * 不 restart；用户浏览过的历史位置也不会被同一个 key 的重复推送拽回。
 */
export interface ExclusiveWorkbenchDetail {
  /** 详情面身份（相同 ⇒ 渲染层无需任何动作）；无活动控制时为 null */
  key: string | null
  phase: ExclusiveControlPhase
  /** 被控制的会话（Pet target）；null = 当前无活动任务 */
  petSessionId: string | null
  /** 活动任务 id（无任务 = null；任务刚挂上时也用于区分新的控制轮次） */
  taskId: string | null
  /** 实例代际（后台换代后旧详情面作废） */
  instanceEpoch: number | null
  /** 兼容字段：v3 始终为 false，官方 Web 可操作 */
  readOnly: boolean
  updatedAt: number
}

/** 控制状态快照 —— S4 的共享工作台直接消费它（不得含凭据/env 值）。 */
export interface ExclusiveControlSnapshot {
  phase: ExclusiveControlPhase
  /** 当前绑定；phase !== 'held' 时为 null */
  binding: ExclusiveBindingView | null
  /** 是否有活动任务（accepted 之后、completed 之前） */
  activeTask: ExclusiveTaskView | null
  /** 当前最早的一条待答原生审批（兼容字段；完整列表见 approvals） */
  pendingApproval: ExclusiveApprovalView | null
  /** 全部待答原生审批（并发审批用；Pet 据此逐条展示与回答） */
  approvals: ExclusiveApprovalView[]
  /** 已发生的工作输出（有界；S5 展示用） */
  transcript: ExclusiveTranscriptEntry[]
  /** 事件序号（有界事件的游标；快照本身可用于恢复） */
  lastEventSeq: number
  /** 普通 Web 是否已有任务在跑（诊断信息；v3 不作为 Pet 准入条件） */
  webBusy: boolean
  /** 工作台查看器状态（S4 工作台消费；未接线/未开始时为 null） */
  viewer?: ExclusiveViewerState
}

/** 工作输出条目类型：只放**已存在的官方 session 事件**，不新造状态。 */
export type ExclusiveTranscriptKind = 'user' | 'assistant' | 'tool-call' | 'tool-result'

/**
 * 有界工作输出（S5 展示用）。
 * 来源：官方 `session/event`（`user/message` / `assistant/message` / `tool/call` / `tool/result`）。
 * 文本一律截断到上限，绝不回传模型/工具的完整原文；不含凭据。
 */
export interface ExclusiveTranscriptEntry {
  seq: number
  at: number
  kind: ExclusiveTranscriptKind
  /** 会话 id（多会话时区分） */
  sessionId: string
  /** 归属任务（提交后才有） */
  taskId?: string
  /** 工具名（tool-call / tool-result） */
  toolName?: string
  /** 截断后的文本（assistant 文本 / 工具参数摘要 / 工具结果摘要） */
  text: string
  /** 失败的工具结果 */
  failed?: boolean
}

export type ExclusiveTaskState = 'accepted' | 'running' | 'completed' | 'cancelled' | 'failed'

/** 任务视图：`accepted !== completed` —— 提交被接受不等于回合完成。 */
export interface ExclusiveTaskView {
  /** 应用边界保留的脱敏 cause；没有阶段/HTTP 证据时明确 unknown。 */
  diagnostic?: ExclusiveDiagnostic
  taskId: string
  /** dsh 会话 id（明确到哪一个会话在执行） */
  sessionId: string
  /** 提交时冻结的Pet 绑定代际 */
  epoch: number
  state: ExclusiveTaskState
  acceptedAt: number
  /** 仅终态有值 */
  endedAt?: number
  /** 终态原因（completed 的真实官方证据：正常结束 / 取消 / 失败），不回显模型输出 */
  endReason?: string
}

export type ExclusiveApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

export interface ExclusiveApprovalView {
  /** 桥侧审批请求 id（由 dsh 的 approval 服务铸造） */
  approvalId: string
  taskId: string | null
  sessionId: string
  epoch: number
  toolName: string
  callId?: string
  reason?: string
  askedAt: number
}

/** 有界事件：从 lastEventSeq 之后拉取；缓冲区有上限，超限只保留最近的并回传 snapshot。 */
export type ExclusiveControlEventType =
  | 'control/acquired'
  | 'control/released'
  | 'control/revoked'
  | 'task/accepted'
  | 'task/started'
  | 'task/completed'
  | 'task/cancelled'
  | 'task/failed'
  | 'approval/asked'
  | 'approval/decided'
  | 'viewer/navigation-requested'
  | 'viewer/navigated'
  | 'viewer/failed'
  | 'viewer/browsed'
  | 'bridge/error'

export interface ExclusiveControlEvent {
  seq: number
  type: ExclusiveControlEventType
  at: number
  epoch: number
  taskId?: string
  sessionId?: string
  approvalId?: string
  outcome?: ExclusiveApprovalOutcome
  /** 查看器导航请求/落地的关联 id（viewer/* 事件） */
  requestId?: string
  /** 查看器 revision（viewer/* 事件冻结的那个值） */
  revision?: number
  /** 固定分类的失败原因（**不回显**子进程/模型原文） */
  reason?: string
}

/** 事件拉取响应：`gap: true` 表示游标太旧，必须用 snapshot 重新对齐（不做盲目重发）。 */
export interface ExclusiveEventBatch {
  events: ExclusiveControlEvent[]
  lastEventSeq: number
  gap: boolean
  snapshot: ExclusiveControlSnapshot
}

/** 控制面错误码（服务端判定，客户端不得自行猜测）。 */
export type ExclusiveErrorCode =
  | 'auth/not-enabled'
  | 'auth/impersonation'
  | 'auth/invalid-token'
  | 'auth/generation-stale'
  | 'instance/no-bridge'
  | 'instance/unavailable'
  | 'instance/busy'
  | 'control/not-held'
  | 'control/held-by-other'
  | 'task/stale-epoch'
  | 'task/busy'
  | 'task/not-found'
  | 'approval/stale'
  | 'approval/not-pending'
  | 'bridge/timeout'
  | 'bridge/unavailable'
  /** 工作台查看器的导航请求已被更新的 viewer 状态作废（用户浏览历史 / 请求太旧） */
  | 'viewer/stale'
  /** 工作台查看器不可用（浏览器半不在线 / 无待答请求） */
  | 'viewer/unavailable'
  | 'bad-request'

export interface ExclusiveErrorBody {
  ok: false
  code: ExclusiveErrorCode
  error: string
  /** 冲突时给出当前权威快照（只读，无凭据） */
  snapshot?: ExclusiveControlSnapshot
}

// ========== 路由常量（http-server 与 dsh 桥共用同一份） ==========

/** 控制面根路径（LyShell 本机 HTTP API 上；**不**通过 stdio MCP 暴露） */
export const EXCLUSIVE_CONTROL_BASE = '/api/exclusive-control'

export const EXCLUSIVE_CONTROL_ROUTES = {
  acquire: `${EXCLUSIVE_CONTROL_BASE}/acquire`,
  release: `${EXCLUSIVE_CONTROL_BASE}/release`,
  snapshot: `${EXCLUSIVE_CONTROL_BASE}/snapshot`,
  events: `${EXCLUSIVE_CONTROL_BASE}/events`,
  submit: `${EXCLUSIVE_CONTROL_BASE}/submit`,
  cancel: `${EXCLUSIVE_CONTROL_BASE}/cancel`,
  approve: `${EXCLUSIVE_CONTROL_BASE}/approve`,
  session: `${EXCLUSIVE_CONTROL_BASE}/session`,
  /**
   * 托管工作台详情（S5）：受控插件请求打开/回到官方工作台。
   * 复用渲染层 `dsh:web:detail` 同一条 runtime 路径与详情面广播，**不**新造导航实现。
   */
  detail: `${EXCLUSIVE_CONTROL_BASE}/detail`,
  /** 历史保留常量；v3 不注册这两条路由，不用于 Web 写门禁。 */
  gate: `${EXCLUSIVE_CONTROL_BASE}/gate`,
  approvalDecision: `${EXCLUSIVE_CONTROL_BASE}/approval-decision`
} as const

/** 历史保留变量名；当前不注入。实际桥凭据见 dsh/bridge.ts 的 BRIDGE_KEY_ENV。 */
export const EXCLUSIVE_CONTROL_ENV = {
  PORT: 'LYSHELL_EXCLUSIVE_PORT',
  TOKEN: 'LYSHELL_EXCLUSIVE_TOKEN',
  INSTANCE: 'LYSHELL_EXCLUSIVE_INSTANCE'
} as const

/** 历史保留请求头；当前 Pet 用 x-lyshell-token，主进程桥用 x-lyshell-harness-key。 */
export const EXCLUSIVE_CONTROL_HEADER = 'x-lyshell-exclusive-token'

/**
 * 共享工作台的**浏览器面**端点（注册在 dsh 自己的 webServer 上，与官方页面同源）。
 *
 * 鉴权：桥签发的 viewer cookie（HMAC over viewerId+issuedAt，密钥只在本机桥内存里）。
 * 浏览器**永远**拿不到 LyShell 全局 token、插件 host token 或 host bridge key ——
 * 这三个面各自独立，这里只发一个作用域限于「读只读状态 / 报导航结果」的凭据。
 */
export const EXCLUSIVE_VIEWER_ROUTES = {
  /** 拉取只读状态（含未落地的导航请求）；无 cookie 时首次下发签名 cookie */
  status: '/__lyshell/harness/viewer/status',
  /** 上报导航落地结果（必须核对官方 UI 实际当前会话） */
  ack: '/__lyshell/harness/viewer/ack',
  /** 上报用户自己的浏览（推进 viewer revision，作废先前未落地请求） */
  browse: '/__lyshell/harness/viewer/browse'
} as const

/** 桥签发的 viewer cookie 名（HttpOnly，浏览器脚本读不到值） */
export const EXCLUSIVE_VIEWER_COOKIE = 'lyshell_harness_viewer'

/** 浏览器半的上报间隔上限：超过它没往返即视为离线（只读状态里 connected=false） */
export const EXCLUSIVE_VIEWER_STALE_MS = 15_000

/** 事件缓冲上限：超限丢弃最旧并置 gap（有界事件；恢复靠 snapshot）。 */
export const EXCLUSIVE_EVENT_BUFFER_LIMIT = 512

/** 工作输出缓冲上限（transcript 有界；超限丢弃最旧，与事件同一恢复口径）。 */
export const EXCLUSIVE_TRANSCRIPT_LIMIT = 256

/** 单条 transcript 文本上限（截断，绝不回传完整模型/工具输出）。 */
export const EXCLUSIVE_TRANSCRIPT_TEXT_LIMIT = 512

/**
 * 受控 PetLink 插件的 id —— **唯一**对外控制凭据的归属（一次完整授权，不建多 owner）。
 * 只有这个 pluginId 的 **host** token 能 acquire；其他插件/global/session/UI token 一律拒绝。
 * 真实值来自已安装 PetLink 插件的 manifest id（aipet）。
 */
export const EXCLUSIVE_CONTROLLER_PLUGIN_ID = 'aipet'

/** 只有已启用且当前安装的 aipet 插件能接管；这是唯一判据，不做分项能力授权。 */
export function isControllerPluginId(pluginId: string | undefined): boolean {
  return pluginId === EXCLUSIVE_CONTROLLER_PLUGIN_ID
}

// ========== 输入校验（严格；拒绝未知形状，不做宽松兜底） ==========

const MAX_ID_CHARS = 128
const MAX_TEXT_FIELD = 200

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 只允许声明的键出现（多余键一律拒绝：避免「静默忽略」被当成通过）。 */
function assertOnlyKeys(o: Record<string, unknown>, allowed: readonly string[]): string | null {
  for (const key of Object.keys(o)) {
    if (!allowed.includes(key)) return `unexpected field: ${key}`
  }
  return null
}

export function isBoundedId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_CHARS
}

/** viewer revision：单调递增的正整数（ms 量级时间戳，桥侧只接受严格更大的值）。 */
export function isViewerRevision(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0
}

/**
 * 严格解码桥上报的工作台查看器状态。形状不合法一律 `undefined`（不猜、不部分接受）——
 * 宁可让上层报「查看器状态不可用」，也不接受半个状态去驱动导航。
 */
export function readExclusiveViewerState(value: unknown): ExclusiveViewerState | undefined {
  if (!isPlainObject(value)) return undefined
  const v = value
  // 桥在首个浏览器挂载前使用 0；导航请求本身仍要求严格正 revision。
  if (typeof v.revision !== 'number' || !Number.isSafeInteger(v.revision) || v.revision < 0) return undefined
  if (typeof v.appliedRevision !== 'number' || !Number.isSafeInteger(v.appliedRevision) || v.appliedRevision < 0) return undefined
  const request = readViewerRequest(v.request)
  if (v.request !== null && v.request !== undefined && request === undefined) return undefined
  const lastAck = readViewerAck(v.lastAck)
  if (v.lastAck !== null && v.lastAck !== undefined && lastAck === undefined) return undefined
  return {
    revision: v.revision,
    appliedRevision: v.appliedRevision,
    currentSessionId: typeof v.currentSessionId === 'string' && v.currentSessionId.length > 0 ? v.currentSessionId.slice(0, MAX_ID_CHARS) : null,
    petSessionId: typeof v.petSessionId === 'string' && v.petSessionId.length > 0 ? v.petSessionId.slice(0, MAX_ID_CHARS) : null,
    request: request ?? null,
    lastAck: lastAck ?? null,
    connected: v.connected === true,
    // 缺失即 false：旧桥不报这个字段时，**不能**假定请求归当前 viewer（宁可少一个能力）
    ownedByCurrentViewer: v.ownedByCurrentViewer === true,
    updatedAt: typeof v.updatedAt === 'number' && Number.isFinite(v.updatedAt) ? v.updatedAt : 0
  }
}

function readViewerRequest(value: unknown): ExclusiveViewerRequest | undefined {
  if (!isPlainObject(value)) return undefined
  if (!isBoundedId(value.requestId) || !isBoundedId(value.sessionId)) return undefined
  if (!isViewerRevision(value.revision)) return undefined
  if (typeof value.epoch !== 'number' || !Number.isInteger(value.epoch) || value.epoch <= 0) return undefined
  return {
    requestId: value.requestId,
    sessionId: value.sessionId,
    revision: value.revision,
    epoch: value.epoch,
    requestedAt: typeof value.requestedAt === 'number' && Number.isFinite(value.requestedAt) ? value.requestedAt : 0
  }
}

const VIEWER_ACK_STATUSES: readonly ExclusiveViewerAckStatus[] = ['navigated', 'failed', 'superseded']

function readViewerAck(value: unknown): ExclusiveViewerAck | undefined {
  if (!isPlainObject(value)) return undefined
  if (!isBoundedId(value.requestId) || !isBoundedId(value.sessionId)) return undefined
  if (!isViewerRevision(value.revision)) return undefined
  if (typeof value.status !== 'string' || !VIEWER_ACK_STATUSES.includes(value.status as ExclusiveViewerAckStatus)) return undefined
  return {
    requestId: value.requestId,
    revision: value.revision,
    sessionId: value.sessionId,
    currentSessionId: typeof value.currentSessionId === 'string' && value.currentSessionId.length > 0 ? value.currentSessionId.slice(0, MAX_ID_CHARS) : null,
    status: value.status as ExclusiveViewerAckStatus,
    at: typeof value.at === 'number' && Number.isFinite(value.at) ? value.at : 0,
    ...(typeof value.reason === 'string' && value.reason.length > 0 ? { reason: value.reason.slice(0, 200) } : {})
  }
}

function boundedText(v: unknown, max = MAX_TEXT_FIELD): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max
}

export interface AcquireInput {
  pluginId: string
  pluginInstanceId: string
  /** 插件自报的启用标记；**不能**作为授权依据，真正判定在 LyShell 侧（启用状态 + 绑定） */
  enabled: true
}

export type ValidateResult<T> = { ok: true; value: T } | { ok: false; error: string }

export function validateAcquireInput(payload: unknown): ValidateResult<AcquireInput> {
  if (!isPlainObject(payload)) return { ok: false, error: 'body must be an object' }
  const extra = assertOnlyKeys(payload, ['pluginId', 'pluginInstanceId', 'enabled'])
  if (extra) return { ok: false, error: extra }
  if (!isBoundedId(payload.pluginId)) return { ok: false, error: 'pluginId must be a non-empty bounded string' }
  if (!isBoundedId(payload.pluginInstanceId)) return { ok: false, error: 'pluginInstanceId must be a non-empty bounded string' }
  if (payload.enabled !== true) return { ok: false, error: 'enabled must be true' }
  return { ok: true, value: { pluginId: payload.pluginId, pluginInstanceId: payload.pluginInstanceId, enabled: true } }
}

export interface EpochInput {
  epoch: number
}

export function validateEpochInput(payload: unknown): ValidateResult<EpochInput> {
  if (!isPlainObject(payload)) return { ok: false, error: 'body must be an object' }
  const extra = assertOnlyKeys(payload, ['epoch'])
  if (extra) return { ok: false, error: extra }
  if (typeof payload.epoch !== 'number' || !Number.isInteger(payload.epoch) || payload.epoch <= 0) {
    return { ok: false, error: 'epoch must be a positive integer' }
  }
  return { ok: true, value: { epoch: payload.epoch } }
}

export interface SubmitInput {
  epoch: number
  /** 目标会话；缺省 = 当前 Pet 绑定正在控制的会话 */
  sessionId?: string
  /** 用户消息正文（原样交给官方 agent loop；本层不解释、不改造） */
  text: string
}

export function validateSubmitInput(payload: unknown): ValidateResult<SubmitInput> {
  if (!isPlainObject(payload)) return { ok: false, error: 'body must be an object' }
  const extra = assertOnlyKeys(payload, ['epoch', 'sessionId', 'text'])
  if (extra) return { ok: false, error: extra }
  const epoch = validateEpochInput({ epoch: payload.epoch })
  if (!epoch.ok) return { ok: false, error: epoch.error }
  if (payload.sessionId !== undefined && !isBoundedId(payload.sessionId)) {
    return { ok: false, error: 'sessionId must be a non-empty bounded string when present' }
  }
  // 正文上限取 LyShell execute 侧同量级；空正文无意义
  if (!boundedText(payload.text, 100_000)) return { ok: false, error: 'text must be a non-empty string (max 100000)' }
  return {
    ok: true,
    value: {
      epoch: epoch.value.epoch,
      ...(payload.sessionId === undefined ? {} : { sessionId: payload.sessionId as string }),
      text: payload.text
    }
  }
}

export interface CancelInput {
  epoch: number
  taskId: string
}

export function validateCancelInput(payload: unknown): ValidateResult<CancelInput> {
  if (!isPlainObject(payload)) return { ok: false, error: 'body must be an object' }
  const extra = assertOnlyKeys(payload, ['epoch', 'taskId'])
  if (extra) return { ok: false, error: extra }
  const epoch = validateEpochInput({ epoch: payload.epoch })
  if (!epoch.ok) return { ok: false, error: epoch.error }
  if (!isBoundedId(payload.taskId)) return { ok: false, error: 'taskId must be a non-empty bounded string' }
  return { ok: true, value: { epoch: epoch.value.epoch, taskId: payload.taskId } }
}

export interface ApproveInput {
  epoch: number
  approvalId: string
  outcome: ExclusiveApprovalOutcome
}

const APPROVAL_OUTCOMES: readonly ExclusiveApprovalOutcome[] = ['allowed-once', 'rejected', 'cancelled', 'unavailable']

export function validateApproveInput(payload: unknown): ValidateResult<ApproveInput> {
  if (!isPlainObject(payload)) return { ok: false, error: 'body must be an object' }
  const extra = assertOnlyKeys(payload, ['epoch', 'approvalId', 'outcome'])
  if (extra) return { ok: false, error: extra }
  const epoch = validateEpochInput({ epoch: payload.epoch })
  if (!epoch.ok) return { ok: false, error: epoch.error }
  if (!isBoundedId(payload.approvalId)) return { ok: false, error: 'approvalId must be a non-empty bounded string' }
  if (typeof payload.outcome !== 'string' || !APPROVAL_OUTCOMES.includes(payload.outcome as ExclusiveApprovalOutcome)) {
    return { ok: false, error: `outcome must be one of ${APPROVAL_OUTCOMES.join('/')}` }
  }
  return {
    ok: true,
    value: { epoch: epoch.value.epoch, approvalId: payload.approvalId, outcome: payload.outcome as ExclusiveApprovalOutcome }
  }
}

/** 会话创建/选择：`mode` 决定是新建还是切到既有会话，两者都属「工作会话变更」。 */
export interface SessionInput {
  epoch: number
  mode: 'new' | 'select'
  sessionId?: string
}

export function validateSessionInput(payload: unknown): ValidateResult<SessionInput> {
  if (!isPlainObject(payload)) return { ok: false, error: 'body must be an object' }
  const extra = assertOnlyKeys(payload, ['epoch', 'mode', 'sessionId'])
  if (extra) return { ok: false, error: extra }
  const epoch = validateEpochInput({ epoch: payload.epoch })
  if (!epoch.ok) return { ok: false, error: epoch.error }
  if (payload.mode !== 'new' && payload.mode !== 'select') return { ok: false, error: 'mode must be new or select' }
  if (payload.mode === 'select' && !isBoundedId(payload.sessionId)) {
    return { ok: false, error: 'sessionId is required when mode=select' }
  }
  if (payload.mode === 'new' && payload.sessionId !== undefined) {
    return { ok: false, error: 'sessionId must be omitted when mode=new' }
  }
  return {
    ok: true,
    value: {
      epoch: epoch.value.epoch,
      mode: payload.mode,
      ...(payload.sessionId === undefined ? {} : { sessionId: payload.sessionId as string })
    }
  }
}

export interface EventsQuery {
  since: number
  limit: number
}

export function validateEventsQuery(sinceRaw: string | null, limitRaw: string | null): ValidateResult<EventsQuery> {
  const since = sinceRaw === null || sinceRaw === '' ? 0 : Number(sinceRaw)
  if (!Number.isInteger(since) || since < 0) return { ok: false, error: 'since must be a non-negative integer' }
  const limit = limitRaw === null || limitRaw === '' ? 100 : Number(limitRaw)
  if (!Number.isInteger(limit) || limit <= 0 || limit > EXCLUSIVE_EVENT_BUFFER_LIMIT) {
    return { ok: false, error: `limit must be an integer in 1..${EXCLUSIVE_EVENT_BUFFER_LIMIT}` }
  }
  return { ok: true, value: { since, limit } }
}

/** 历史 gate 输入类型/校验器；v3 无生产调用，不控制官方 Web 写操作。 */
export type ExclusiveWriteKind = 'submit' | 'cancel' | 'approve' | 'session' | 'config'

export interface GateQuery {
  instanceId: string
  instanceEpoch: number
  kind: ExclusiveWriteKind
  sessionId?: string
}

const WRITE_KINDS: readonly ExclusiveWriteKind[] = ['submit', 'cancel', 'approve', 'session', 'config']

export function validateGateQuery(payload: unknown): ValidateResult<GateQuery> {
  if (!isPlainObject(payload)) return { ok: false, error: 'body must be an object' }
  const extra = assertOnlyKeys(payload, ['instanceId', 'instanceEpoch', 'kind', 'sessionId'])
  if (extra) return { ok: false, error: extra }
  if (!isBoundedId(payload.instanceId)) return { ok: false, error: 'instanceId must be a non-empty bounded string' }
  if (typeof payload.instanceEpoch !== 'number' || !Number.isInteger(payload.instanceEpoch) || payload.instanceEpoch <= 0) {
    return { ok: false, error: 'instanceEpoch must be a positive integer' }
  }
  if (typeof payload.kind !== 'string' || !WRITE_KINDS.includes(payload.kind as ExclusiveWriteKind)) {
    return { ok: false, error: `kind must be one of ${WRITE_KINDS.join('/')}` }
  }
  if (payload.sessionId !== undefined && !isBoundedId(payload.sessionId)) {
    return { ok: false, error: 'sessionId must be a non-empty bounded string when present' }
  }
  return {
    ok: true,
    value: {
      instanceId: payload.instanceId,
      instanceEpoch: payload.instanceEpoch,
      kind: payload.kind as ExclusiveWriteKind,
      ...(payload.sessionId === undefined ? {} : { sessionId: payload.sessionId as string })
    }
  }
}

// ========== dsh 桥 ↔ LyShell 的控制协议（桥在其 web 路由上暴露；凭据走 host-only 头） ==========

/** 桥暴露的控制路由（dsh 进程内；LyShell 用 S2 的 host-only key 调用） */
// 历史路由常量：实际控制命令 POST 到握手 controlPort 的 /，不注册此 Web 路由。
export const BRIDGE_CONTROL_PATH = '/__lyshell/harness/control'

/** LyShell → 桥 的命令集合（每条都要求 epoch 对齐；桥侧逐条校验）。 */
export type BridgeCommand =
  | { cmd: 'acquire'; epoch: number; bindingId: string }
  | { cmd: 'release'; epoch: number }
  | { cmd: 'snapshot' }
  | {
      cmd: 'submit'
      epoch: number
      taskId: string
      sessionId: string
      text: string
    }
  | { cmd: 'cancel'; epoch: number; taskId: string }
  | { cmd: 'approve'; epoch: number; approvalId: string; outcome: ExclusiveApprovalOutcome }
  | { cmd: 'session'; epoch: number; mode: 'new' | 'select'; sessionId?: string }
  /**
   * 共享工作台导航：把**冻结**的 viewer/session/epoch/revision 下发给桥，
   * 由官方 client 半的真实导航服务落地；bridge revision 更旧的一律拒绝（viewer/stale）。
   */
  | { cmd: 'viewer-nav'; epoch: number; revision: number; requestId: string; sessionId: string }
  /** 审批长轮询：桥在收到 dsh 原生审批时用它向 LyShell 索取 Pet 的回答 */
  | { cmd: 'await-approval'; epoch: number; approval: ExclusiveApprovalView }
  /** 桥侧事件上报 + 命令拉取（一条请求同时完成两件事，减少往返） */
  | {
      cmd: 'poll'
      epoch: number
      events: ExclusiveControlEvent[]
      /** 桥侧当前活动任务状态（供 LyShell 校正 accepted/completed） */
      task: ExclusiveTaskView | null
    }

export interface BridgeIdentity {
  instanceId: string
  instanceEpoch: number
  cwd: string
  dshHome: string
  clientBundle: boolean
}

/**
 * 桥命令结果。`ok:false` 一律带固定分类码 —— 绝不含 dsh/模型原文（避免把子进程诊断
 * 或用户内容带回状态与日志）。
 */
export type BridgeResult =
  | { ok: true; identity?: BridgeIdentity; task?: ExclusiveTaskView | null; sessionId?: string; approval?: ExclusiveApprovalOutcome; viewer?: ExclusiveViewerState }
  | { ok: false; code: ExclusiveErrorCode; error: string; busy?: boolean }
  | {
      ok: true
      /** await-approval 专用：Pet 的回答（或取消/超时） */
      approvalOutcome?: ExclusiveApprovalOutcome
      /** 当前待答审批（供 LyShell 记快照） */
      pending?: ExclusiveApprovalView | null
    }

/** 桥侧上报的事件必须带 seq（LyShell 侧只接受严格递增，乱序/重复一律丢弃）。 */
export interface BridgePollPayload {
  events: ExclusiveControlEvent[]
  task: ExclusiveTaskView | null
  pendingApproval: ExclusiveApprovalView | null
  /** 桥侧是否已完成独占接管（acquire 成功后才为 true） */
  holding: boolean
  /** 桥侧认为的实例身份（供 LyShell 核对换代） */
  identity: BridgeIdentity
}

export function validateBridgeCommand(payload: unknown): ValidateResult<BridgeCommand> {
  if (!isPlainObject(payload)) return { ok: false, error: 'body must be an object' }
  const cmd = payload.cmd
  if (cmd === 'acquire') {
    const extra = assertOnlyKeys(payload, ['cmd', 'epoch', 'bindingId'])
    if (extra) return { ok: false, error: extra }
    const epoch = validateEpochInput({ epoch: payload.epoch })
    if (!epoch.ok) return { ok: false, error: epoch.error }
    if (!isBoundedId(payload.bindingId)) return { ok: false, error: 'bindingId must be a non-empty bounded string' }
    return { ok: true, value: { cmd: 'acquire', epoch: epoch.value.epoch, bindingId: payload.bindingId } }
  }
  if (cmd === 'snapshot') return { ok: true, value: { cmd: 'snapshot' } }
  if (cmd === 'release') {
    const extra = assertOnlyKeys(payload, ['cmd', 'epoch'])
    if (extra) return { ok: false, error: extra }
    const epoch = validateEpochInput({ epoch: payload.epoch })
    if (!epoch.ok) return { ok: false, error: epoch.error }
    return { ok: true, value: { cmd: 'release', epoch: epoch.value.epoch } }
  }
  if (cmd === 'submit') {
    const extra = assertOnlyKeys(payload, ['cmd', 'epoch', 'taskId', 'sessionId', 'text'])
    if (extra) return { ok: false, error: extra }
    const epoch = validateEpochInput({ epoch: payload.epoch })
    if (!epoch.ok) return { ok: false, error: epoch.error }
    if (!isBoundedId(payload.taskId)) return { ok: false, error: 'taskId must be a non-empty bounded string' }
    if (!isBoundedId(payload.sessionId)) return { ok: false, error: 'sessionId must be a non-empty bounded string' }
    if (!boundedText(payload.text, 100_000)) return { ok: false, error: 'text must be a non-empty string (max 100000)' }
    return {
      ok: true,
      value: { cmd: 'submit', epoch: epoch.value.epoch, taskId: payload.taskId, sessionId: payload.sessionId, text: payload.text }
    }
  }
  if (cmd === 'cancel') {
    const extra = assertOnlyKeys(payload, ['cmd', 'epoch', 'taskId'])
    if (extra) return { ok: false, error: extra }
    const epoch = validateEpochInput({ epoch: payload.epoch })
    if (!epoch.ok) return { ok: false, error: epoch.error }
    if (!isBoundedId(payload.taskId)) return { ok: false, error: 'taskId must be a non-empty bounded string' }
    return { ok: true, value: { cmd: 'cancel', epoch: epoch.value.epoch, taskId: payload.taskId } }
  }
  if (cmd === 'approve') {
    const extra = assertOnlyKeys(payload, ['cmd', 'epoch', 'approvalId', 'outcome'])
    if (extra) return { ok: false, error: extra }
    const epoch = validateEpochInput({ epoch: payload.epoch })
    if (!epoch.ok) return { ok: false, error: epoch.error }
    if (!isBoundedId(payload.approvalId)) return { ok: false, error: 'approvalId must be a non-empty bounded string' }
    if (typeof payload.outcome !== 'string' || !APPROVAL_OUTCOMES.includes(payload.outcome as ExclusiveApprovalOutcome)) {
      return { ok: false, error: `outcome must be one of ${APPROVAL_OUTCOMES.join('/')}` }
    }
    return {
      ok: true,
      value: {
        cmd: 'approve',
        epoch: epoch.value.epoch,
        approvalId: payload.approvalId,
        outcome: payload.outcome as ExclusiveApprovalOutcome
      }
    }
  }
  if (cmd === 'session') {
    const extra = assertOnlyKeys(payload, ['cmd', 'epoch', 'mode', 'sessionId'])
    if (extra) return { ok: false, error: extra }
    const epoch = validateEpochInput({ epoch: payload.epoch })
    if (!epoch.ok) return { ok: false, error: epoch.error }
    if (payload.mode !== 'new' && payload.mode !== 'select') return { ok: false, error: 'mode must be new or select' }
    if (payload.mode === 'select' && !isBoundedId(payload.sessionId)) {
      return { ok: false, error: 'sessionId is required when mode=select' }
    }
    return {
      ok: true,
      value: {
        cmd: 'session',
        epoch: epoch.value.epoch,
        mode: payload.mode,
        ...(payload.sessionId === undefined ? {} : { sessionId: payload.sessionId as string })
      }
    }
  }
  if (cmd === 'viewer-nav') {
    const extra = assertOnlyKeys(payload, ['cmd', 'epoch', 'revision', 'requestId', 'sessionId'])
    if (extra) return { ok: false, error: extra }
    const epoch = validateEpochInput({ epoch: payload.epoch })
    if (!epoch.ok) return { ok: false, error: epoch.error }
    if (!isViewerRevision(payload.revision)) return { ok: false, error: 'revision must be a positive integer' }
    if (!isBoundedId(payload.requestId)) return { ok: false, error: 'requestId must be a non-empty bounded string' }
    if (!isBoundedId(payload.sessionId)) return { ok: false, error: 'sessionId must be a non-empty bounded string' }
    return {
      ok: true,
      value: {
        cmd: 'viewer-nav',
        epoch: epoch.value.epoch,
        revision: payload.revision,
        requestId: payload.requestId,
        sessionId: payload.sessionId
      }
    }
  }
  if (cmd === 'await-approval') {
    const extra = assertOnlyKeys(payload, ['cmd', 'epoch', 'approval'])
    if (extra) return { ok: false, error: extra }
    const epoch = validateEpochInput({ epoch: payload.epoch })
    if (!epoch.ok) return { ok: false, error: epoch.error }
    const approval = validateApprovalView(payload.approval)
    if (!approval.ok) return { ok: false, error: approval.error }
    return { ok: true, value: { cmd: 'await-approval', epoch: epoch.value.epoch, approval: approval.value } }
  }
  if (cmd === 'poll') {
    const extra = assertOnlyKeys(payload, ['cmd', 'epoch', 'events', 'task'])
    if (extra) return { ok: false, error: extra }
    const epoch = validateEpochInput({ epoch: payload.epoch })
    if (!epoch.ok) return { ok: false, error: epoch.error }
    return { ok: true, value: { cmd: 'poll', epoch: epoch.value.epoch, events: [], task: null } }
  }
  return { ok: false, error: 'unknown cmd' }
}

function validateApprovalView(payload: unknown): ValidateResult<ExclusiveApprovalView> {
  if (!isPlainObject(payload)) return { ok: false, error: 'approval must be an object' }
  const extra = assertOnlyKeys(payload, ['approvalId', 'taskId', 'sessionId', 'epoch', 'toolName', 'callId', 'reason', 'askedAt'])
  if (extra) return { ok: false, error: extra }
  if (!isBoundedId(payload.approvalId)) return { ok: false, error: 'approvalId must be a non-empty bounded string' }
  if (!isBoundedId(payload.sessionId)) return { ok: false, error: 'sessionId must be a non-empty bounded string' }
  if (typeof payload.epoch !== 'number' || !Number.isInteger(payload.epoch) || payload.epoch <= 0) {
    return { ok: false, error: 'epoch must be a positive integer' }
  }
  if (!boundedText(payload.toolName)) return { ok: false, error: 'toolName must be a non-empty bounded string' }
  if (payload.taskId !== undefined && payload.taskId !== null && !isBoundedId(payload.taskId)) {
    return { ok: false, error: 'taskId must be a bounded string or null' }
  }
  if (payload.callId !== undefined && !boundedText(payload.callId)) return { ok: false, error: 'callId must be a bounded string' }
  if (payload.reason !== undefined && !boundedText(payload.reason, 2000)) {
    return { ok: false, error: 'reason must be a bounded string' }
  }
  if (typeof payload.askedAt !== 'number' || !Number.isFinite(payload.askedAt)) {
    return { ok: false, error: 'askedAt must be a number' }
  }
  return {
    ok: true,
    value: {
      approvalId: payload.approvalId,
      sessionId: payload.sessionId,
      epoch: payload.epoch,
      toolName: payload.toolName,
      askedAt: payload.askedAt,
      taskId: (payload.taskId as string | null | undefined) ?? null,
      ...(payload.callId === undefined ? {} : { callId: payload.callId }),
      ...(payload.reason === undefined ? {} : { reason: payload.reason })
    }
  }
}
