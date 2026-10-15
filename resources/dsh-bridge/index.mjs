// LyShell 托管 Harness 的 dsh 桥 —— **host 半**（在真实 dsh 进程内运行）。
//
// 职责：
//   S2 —— 仅 host-only 鉴权的握手（协议版本、本进程铸造的实例身份、启动身份）。
//   S3 —— v3 共享可用后台：官方 Web 的提交、取消、会话和执行配置沿用官方路径；
//         Pet 当前回合的原生审批交给 Pet；其他请求继续官方 approval waterfall。
//         submit/cancel/session 直调官方服务（ctx.sessionController），不重写 agent loop。
//   S4 —— 共享工作台：给官方页面同源的**签名 cookie** 只读状态 / 导航 ack / 用户浏览上报端点，
//         以及 host-only 的 `viewer-nav` 命令（冻结 viewer/session/epoch/revision）。
//         浏览器只拿到 viewer 作用域的 cookie —— LyShell 全局 token、插件 host token 与
//         host bridge key 都不出现在任何浏览器可达的响应里。
//
// 安全边界：
//   * host-only 凭据只经 spawn env（LYSHELL_HARNESS_BRIDGE_KEY）注入；apply 时**捕获进闭包**
//     并立即从 process.env 抹掉（否则 dsh 之后 spawn 的工具子进程会继承它），只在内存中；
//     不进 patch 文件、不进 URL/query、不打日志，也**不**发给插件/Pet。
//   * 凭据缺失即**不注册**任何路由（fail closed）：没有凭据 ⇒ 不暴露任何宿主面。
//   * Pet 托管控制状态只在内存：LyShell 用同一 host-only 头下发 epoch，桥按 epoch 对齐。
//   * clientBundle 只报**实测事实**（exports['./client'] 指向的文件真实存在且平台为 web），
//     不用常量自报能力。
//   * 除注册路由与 `ctx.sessionController` / `ctx.agents` 外不 import 已安装 dsh 的内部模块。
import { randomUUID, timingSafeEqual, createHmac, randomBytes, createHash } from 'node:crypto'
import { accessSync, constants, existsSync, readFileSync } from 'node:fs'
import http from 'node:http'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

// Diagnostics contain only fixed codes and phases, never provider text, stacks, headers or bodies.
export function workDiagnostic(error) {
  const known = new Set(['TRANSPORT', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
    'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
    'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'TimeoutError', 'AbortError'])
  const found = [], seen = new Set()
  const visit = value => {
    if (!value || typeof value !== 'object' || seen.has(value) || seen.size >= 8) return
    seen.add(value)
    const code = known.has(value.code) ? value.code : known.has(value.name) ? value.name : null
    if (code && !found.includes(code)) found.push(code)
    visit(value.cause)
    if (Array.isArray(value.errors)) value.errors.slice(0, 4).forEach(visit)
  }
  visit(error)
  return { code: found[0] || 'unknown', causeCodes: found.slice(1), phase: 'agent', httpResponse: 'unknown' }
}

export const name = 'lyshell-harness-bridge'
// `connection` 是官方浏览器面鉴权/信任边界（`ctx.connection.admit`）：viewer 端点必须经它
// 验证「这个请求确实来自已登录的官方页面」，而不是给任何能连上回环端口的人签 cookie。
export const inject = ['webServer', 'sessionController', 'agents', 'connection']

/** 与 LyShell 主进程 dsh/bridge.ts 的常量必须一致（测试会核对两份常量不漂移）。 */
const HARNESS_PROTOCOL_VERSION = 2
const HANDSHAKE_PATH = '/__lyshell/harness/handshake'
const KEY_HEADER = 'x-lyshell-harness-key'
const KEY_ENV = 'LYSHELL_HARNESS_BRIDGE_KEY'
const BRIDGE_VERSION = '0.3.0'

/** 等待 Pet 回答一次原生审批的上限（毫秒）。超时按 cancelled 处理（fail closed，不自动 allow）。 */
const APPROVAL_WAIT_MS = 15 * 60 * 1000
const TRANSCRIPT_LIMIT = 256
const TRANSCRIPT_TEXT_LIMIT = 512

/**
 * 共享工作台的浏览器面端点（与官方页面同源，注册在 dsh 自己的 webServer 上）。
 *
 * 鉴权分两级，缺一不可：
 *   1. **官方登录**：`ctx.connection.admit(req)` —— 官方浏览器面鉴权/信任边界
 *      （Host/Origin(含 sec-fetch-site) 信任栅栏 + 官方 process-token 交换出来的签名 cookie）。
 *      官方页面用 `dsh web` 打印的 `?token=…` 打开，交换后浏览器持有官方 cookie；
 *      没有它一律 401，**绝不**给未认证请求签任何 cookie（此前实现会直接签发，等于把
 *      回环端口上的任何客户端都当成登录用户）。
 *   2. **viewer cookie**：通过官方鉴权后才签发，绑定 host + 短 TTL，只作用域到「读只读状态 /
 *      报导航结果」。它与 LyShell 全局 token、插件 host token、host bridge key 完全分离 ——
 *      浏览器永远拿不到那三个。
 */
const VIEWER_STATUS_PATH = '/__lyshell/harness/viewer/status'
const VIEWER_ACK_PATH = '/__lyshell/harness/viewer/ack'
const VIEWER_BROWSE_PATH = '/__lyshell/harness/viewer/browse'
const VIEWER_COOKIE = 'lyshell_harness_viewer'
/** 浏览器半离线判定：超过它没往返即 connected=false（只读状态里如实上报） */
const VIEWER_STALE_MS = 15_000
/** viewer cookie 有效期（秒）：过期必须重新通过官方鉴权换签，旧 cookie 不能长期当凭据 */
const VIEWER_COOKIE_TTL_SECONDS = 12 * 60 * 60
/** 单条 ack/browse 正文上限（防止把页面内容灌进来） */
const VIEWER_BODY_LIMIT = 8 * 1024

/** 浏览器半可以上报的导航结果（其余一律拒绝 —— 不 fake ack）。 */
const VIEWER_ACK_STATUSES = new Set(['navigated', 'failed'])

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

/** 与 LyShell 的 resolveDshHome 同口径：绝对路径直接用，否则回落 ~/.dsh。 */
function resolveDshHome(raw) {
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  let expanded = trimmed
  if (trimmed === '~') expanded = homedir()
  else if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) expanded = join(homedir(), trimmed.slice(2))
  return expanded && isAbsolute(expanded) ? expanded : join(homedir(), '.dsh')
}

function keyMatches(expected, provided) {
  if (typeof provided !== 'string' || provided.length === 0) return false
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(provided, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function isBoundedId(v, max = 128) {
  return typeof v === 'string' && v.length > 0 && v.length <= max
}

/** 出错时给出固定的分类码 —— 绝不把 dsh/模型原文带回给调用方。 */
class BridgeError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/**
 * 取错误的固定分类码。
 * 不直接用 `instanceof BridgeError`：控制面可能由**另一份模块副本**（不同 URL 的 data:/query 装载）
 * 抛错，跨副本的 instanceof 不可靠。这里用鸭子类型判据（Error + 固定码字符串），更稳。
 */
const BRIDGE_ERROR_CODES = new Set([
  'bad-request',
  'control/not-held',
  'control/held-by-other',
  'task/stale-epoch',
  'task/busy',
  'task/not-found',
  'approval/not-pending',
  'approval/stale',
  'instance/busy',
  'instance/no-bridge',
  'viewer/stale',
  'viewer/unavailable',
  'bridge/unavailable'
])

function codeOf(error) {
  const code = error && typeof error === 'object' ? error.code : undefined
  return typeof code === 'string' && BRIDGE_ERROR_CODES.has(code) ? code : 'bridge/unavailable'
}

/**
 * client 半是否**真的可装载** —— 用可读文件事实回答，不用常量自报能力。
 *
 * 判据（对齐官方 clientModules 图的装载前置条件，任一条不成立即 false，不猜）：
 *   1. package.json 的 exports['./client'] 存在且解析出的绝对路径**真的能读出内容**
 *      （只证明「存在」不够：目录、权限不足、损坏的链接都过不了读取这道门）；
 *   2. dsh.client.platform === 'web'（本桥只为 web 工作台装载）；
 *   3. package.json 的 name 与声明一致（双端包不漂移）。
 * bundle 只读 basename（绝不把绝对路径写进响应体）。
 */
function detectClientBundle(manifestPath, baseDir, expectedName) {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return { bundle: false, file: null }
  }
  try {
    const spec = manifest?.exports?.['./client']
    if (typeof spec !== 'string' || spec.length === 0 || manifest?.name !== expectedName) {
      return { bundle: false, file: null }
    }
    if (manifest?.dsh?.client?.platform !== 'web') return { bundle: false, file: null }
    const entry = resolve(baseDir, spec)
    if (!isAbsolute(entry) || !existsSync(entry)) return { bundle: false, file: null }
    try {
      // 可读判据：R_OK 检查 + 真实读一次（能读才算「可装载的 bundle」）
      accessSync(entry, constants.R_OK)
      if (readFileSync(entry).length === 0) return { bundle: false, file: null }
    } catch {
      return { bundle: false, file: null }
    }
    return { bundle: true, file: entry }
  } catch {
    return { bundle: false, file: null }
  }
}

export function apply(ctx) {
  // host-only 凭据：**捕获进闭包后立即从 process.env 抹掉**。
  // 留在 env 里的话，dsh 随后用继承环境 spawn 的任何子进程（工具调用、shell 命令）都能读到它，
  // 那就等于把「只有宿主知道」的凭据发给了我们不控制的环境。抹掉后凭据只存在于本闭包中。
  const key = process.env[KEY_ENV]
  delete process.env[KEY_ENV]
  if (typeof key !== 'string' || key.length === 0) {
    // 无凭据 ⇒ 不注册任何路由（fail closed）。只输出一行固定提示，不含任何凭据。
    process.stdout.write('lyshell-harness-bridge: host-only key missing; handshake route not registered\n')
    return
  }

  // 实例身份由**本进程**在启动时铸造一次：重启（新进程）必然换 instanceId 与 epoch。
  const instanceId = randomUUID()
  const instanceEpoch = Date.now()
  const startedAt = Date.now()
  // client 半的就绪事实在启动时算一次（本次进程内不变）。
  // 位置一律取**本模块自身的真实 URL**（与官方 loader 同一路径）；测试也用真实临时包文件导入，
  // 不为测试留任何旁路分支。
  let manifestPath = ''
  try {
    manifestPath = join(dirname(fileURLToPath(import.meta.url)), 'package.json')
  } catch {
    manifestPath = ''
  }
  const client = manifestPath ? detectClientBundle(manifestPath, dirname(manifestPath), name) : { bundle: false, file: null }

  // One serialized control lane; reads and approval answers remain responsive.
  let heldEpoch = null
  let heldBinding = null
  let activeTask = null
  let floorSeq = 0
  let activeTurn = null
  let controlPort = 0
  let controlTail = Promise.resolve()
  let transcriptSeq = 0
  const transcript = []
  const toolNames = new Map()
  const pendingApprovals = new Map()
  const taskWaiters = new Set()
  // 原生外部工作通道独立持有会话、任务与审批，不占用 Pet 的 heldEpoch。
  const nativeWork = createNativeWorkController(ctx, () => ({ instanceId, instanceEpoch }))

  // ===== 工作台查看器（S4）：官方页面的当前会话、未落地导航请求、最近一次真实 ack =====
  // 全部状态只在内存；不含凭据、不含页面内容。
  const viewerSecret = randomBytes(32)
  const viewer = {
    /** 最高已观察到的 viewer revision（用户浏览历史会推进它 → 旧请求作废） */
    revision: 0,
    /** 最后一次真实落地（官方 UI 已在该会话）的请求 revision */
    appliedRevision: 0,
    /** 官方 UI 当前所在会话（浏览器半上报） */
    currentSessionId: null,
    /** 未落地的导航请求 */
    request: null,
    /** 最近一次导航结果 */
    lastAck: null,
    /** 浏览器半最近一次往返时刻（0 = 从未） */
    seenAt: 0
  }
  const viewerConnected = () => viewer.seenAt > 0 && Date.now() - viewer.seenAt <= VIEWER_STALE_MS
  const petSession = () => (activeTask && !terminal(activeTask) ? activeTask.sessionId : null)
  /** 只读状态（浏览器可消费；不含任何凭据、不含 viewer 身份本身）。 */
  const viewerPublic = () => ({
    revision: viewer.revision,
    appliedRevision: viewer.appliedRevision,
    currentSessionId: viewer.currentSessionId,
    petSessionId: petSession(),
    // request 只出「请求本身」的公开字段：owner（哪个浏览器）是内部身份，绝不外带
    request: viewer.request
      ? { requestId: viewer.request.requestId, sessionId: viewer.request.sessionId,
          revision: viewer.request.revision, epoch: viewer.request.epoch, requestedAt: viewer.request.requestedAt }
      : null,
    lastAck: viewer.lastAck ? { ...viewer.lastAck } : null,
    connected: viewerConnected(),
    updatedAt: Date.now()
  })
  const viewerMarkSeen = () => {
    viewer.seenAt = Date.now()
  }
  /** 用户自己浏览（或导航落地）后推进 revision：作废先前未落地的请求，绝不把用户拽回。 */
  const viewerBump = () => {
    viewer.revision = Math.max(viewer.revision + 1, Date.now())
    return viewer.revision
  }

  // ---- viewer cookie（浏览器面凭据；与 host-only key 完全分离）----
  //
  // 签名绑定 `host`：cookie 只在它被签发的那个 authority 上有效，别处重放不通过。
  // viewerId 就是「哪个浏览器」的身份；导航请求的归属（owner）与 ack/browse 都按它核对，
  // 所以另一个浏览器既不能 ack 别人的请求，也不能拿别人的 pending 去宣告落地。
  const viewerMac = (viewerId, issuedAt, host) =>
    createHmac('sha256', viewerSecret).update(`${viewerId}.${issuedAt}.${host}`).digest('hex')
  const readCookie = (header, name) => {
    if (typeof header !== 'string' || header.length === 0) return null
    for (const part of header.split(';')) {
      const eq = part.indexOf('=')
      if (eq < 0) continue
      if (part.slice(0, eq).trim() !== name) continue
      return part.slice(eq + 1).trim()
    }
    return null
  }
  /** 请求的 authority（签名/比对用；取不到即不可信）。 */
  const requestHost = req => {
    const host = req.headers?.host
    return typeof host === 'string' && host.length > 0 && host.length <= 255 ? host.toLowerCase() : null
  }
  /**
   * 校验 viewer cookie：签名、host 绑定、TTL 三道都要过。
   * 返回 viewerId（字符串）或 null；**绝不放行**未签名/跨 host/过期的 cookie。
   */
  const verifyViewerCookie = (req) => {
    const host = requestHost(req)
    if (host === null) return null
    const raw = readCookie(req.headers.cookie, VIEWER_COOKIE)
    if (typeof raw !== 'string') return null
    const parts = raw.split('.')
    if (parts.length !== 3) return null
    const [viewerId, issuedAt, mac] = parts
    if (!isBoundedId(viewerId, 64) || !/^\d{1,16}$/.test(issuedAt) || !/^[0-9a-f]{64}$/.test(mac)) return null
    const issued = Number(issuedAt)
    if (!Number.isSafeInteger(issued) || issued <= 0) return null
    if (Date.now() - issued > VIEWER_COOKIE_TTL_SECONDS * 1000) return null
    const expected = Buffer.from(viewerMac(viewerId, issuedAt, host), 'utf8')
    const provided = Buffer.from(mac, 'utf8')
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null
    return viewerId
  }
  /** 官方登录验证通过后才调用：签发（或换签）一个绑定 host 的 viewer cookie。 */
  const issueViewerCookie = (res, host) => {
    const viewerId = randomUUID()
    const issuedAt = String(Date.now())
    const value = `${viewerId}.${issuedAt}.${viewerMac(viewerId, issuedAt, host)}`
    res.setHeader('set-cookie', `${VIEWER_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${VIEWER_COOKIE_TTL_SECONDS}`)
    return viewerId
  }
  /**
   * 官方浏览器面鉴权：`ctx.connection.admit(req)`。
   * 返回 401/403（未登录 / 非可信来源）或 null（已认证）。
   * 服务缺失（老版本 dsh 无 connection 服务）⇒ 503 fail closed：不猜、不放行。
   */
  const viewerAsk = (req) => {
    const connection = service('connection')
    if (!connection || typeof connection.admit !== 'function') return 503
    try {
      const admission = connection.admit(req)
      if (admission && typeof admission === 'object') {
        const rejection = admission.rejection
        if (rejection === 401 || rejection === 403) return rejection
        if (admission.peer) return null
      }
      // 形状不符（既没有 rejection 也没有 peer）：不猜，按认证失败处理
      return 401
    } catch (error) {
      return 503
    }
  }
  /**
   * 导航请求归属核对：只有**同一个浏览器**能 ack 它自己看到的请求。
   *
   * LyShell 侧发起的 `viewer-nav` 还没有浏览器身份，归属在第一个通过官方鉴权的 viewer
   * 拉到这条请求时**一次性**认领（先到先得，幂等：已认领就只看是不是自己）。
   * 别的浏览器拿到这条请求只能只读展示，不能替它宣告落地 —— 否则它就能伪造 ack。
   */
  const viewerClaim = (request, viewerId) => {
    if (!request) return false
    if (typeof request.owner !== 'string' || request.owner.length === 0) {
      request.owner = viewerId
      return true
    }
    return request.owner === viewerId
  }
  /** 读一个小 JSON 正文（严格上限；超限/非对象一律 null）。 */
  const readViewerBody = (req) => new Promise((resolvePromise) => {
    let body = ''
    let tooLarge = false
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > VIEWER_BODY_LIMIT) {
        tooLarge = true
        req.destroy()
      }
    })
    req.on('end', () => {
      if (tooLarge || body.length === 0) {
        resolvePromise(null)
        return
      }
      try {
        const parsed = JSON.parse(body)
        resolvePromise(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null)
      } catch {
        resolvePromise(null)
      }
    })
    req.on('error', () => resolvePromise(null))
  })
  /**
   * 状态响应（三种端点共用；readOnly=false、gatedPaths=[] 为兼容字段，不拦 Web 写操作）。
   * `ownedByCurrentViewer` 只在 status 端点上按请求方填：这个浏览器的 cookie 是 HttpOnly，
   * 它无法自证身份，只能由服务端告诉它「这条未落地请求归不归你」。
   */
  const viewerStatusBody = (ownedByCurrentViewer) => ({
    ok: true,
    held: heldEpoch !== null,
    readOnly: false,
    phase: heldEpoch !== null ? 'held' : 'free',
    epoch: heldEpoch,
    reason: heldEpoch === null ? null : pendingApprovals.size > 0 ? 'approval-pending' : 'held',
    viewer: typeof ownedByCurrentViewer === 'boolean'
      ? { ...viewerPublic(), ownedByCurrentViewer }
      : viewerPublic(),
    gatedPaths: []
  })
  const terminal = task => task && ['completed', 'cancelled', 'failed'].includes(task.state)
  const service = name => typeof ctx.get === 'function' ? ctx.get(name) : ctx[name]
  const controller = () => {
    const value = service('sessionController')
    if (!value) throw new BridgeError('bridge/unavailable', 'session controller unavailable')
    return value
  }
  const identity = () => ({ instanceId, instanceEpoch, cwd: process.cwd(),
    dshHome: resolveDshHome(process.env.DSH_HOME), clientBundle: client.bundle })
  const requireEpoch = payload => {
    if (heldEpoch === null) throw new BridgeError('control/not-held', 'exclusive control is not held')
    if (payload.epoch !== heldEpoch) throw new BridgeError('task/stale-epoch', 'stale control epoch')
  }
  const views = () => [...pendingApprovals.values()].map(entry => ({ ...entry.view }))
  const snapshot = () => ({ ok: true, identity: identity(), holding: heldEpoch !== null,
    task: activeTask, approvals: views(), viewer: viewerPublic(), transcript: transcript.map(entry => ({ ...entry })) })
  ctx.effect(() => ctx.on('agent/error', ({ agent, error }) => {
    if (!activeTask || agent?.id !== activeTask.sessionId || terminal(activeTask)) return
    activeTask = { ...activeTask, diagnostic: workDiagnostic(error) }
    // agent/error is evidence of failure detail, not terminal evidence; turn/end owns the task state.
  }), 'lyshell-harness-bridge: safe error evidence')
  const wakeTask = () => {
    for (const waiter of [...taskWaiters]) if (activeTask?.taskId === waiter.taskId && waiter.predicate(activeTask)) waiter.finish()
  }
  const waitTask = (taskId, predicate) => {
    if (activeTask?.taskId === taskId && predicate(activeTask)) return Promise.resolve()
    return new Promise((resolvePromise, reject) => {
      const waiter = { taskId, predicate, finish: () => { clearTimeout(timer); taskWaiters.delete(waiter); resolvePromise() } }
      const timer = setTimeout(() => { taskWaiters.delete(waiter); reject(new BridgeError('bridge/timeout', 'official turn did not settle')) }, 10000)
      taskWaiters.add(waiter)
    })
  }
  const cancelApprovals = () => { for (const entry of [...pendingApprovals.values()]) entry.finish('cancelled') }
  const anyRunning = () => {
    const agents = service('agents')
    if (!agents || typeof agents.list !== 'function' || typeof agents.get !== 'function') throw new BridgeError('bridge/unavailable', 'agent registry unavailable')
    for (const item of agents.list()) {
      const agent = agents.get(typeof item === 'string' ? item : item.id)
      if (!agent) throw new BridgeError('bridge/unavailable', 'agent state unavailable')
      if (agent.status === 'running') return true
    }
    return false
  }
  const resolveAgent = async sessionId => {
    const result = await controller().resolveAgent(sessionId)
    if (!result || result.error || !result.agent) throw new BridgeError('task/not-found', 'session unavailable')
    return result.agent
  }

  ctx.effect(() => ctx.on('approval/request', function (request, next) {
    if (heldEpoch === null) return next()
    // 只承接 Pet 当前回合的审批；普通 Web 会话继续官方审批链。
    if (!activeTask || terminal(activeTask) || request.agent?.session?.id !== activeTask.sessionId) return next()
    if (request.signal?.aborted) return 'cancelled'
    const approvalId = randomUUID()
    const view = { approvalId, taskId: activeTask.taskId, sessionId: activeTask.sessionId,
      epoch: heldEpoch, toolName: request.toolName, callId: request.callId,
      reason: typeof request.reason === 'string' ? request.reason.slice(0, 2000) : undefined, askedAt: Date.now() }
    return new Promise(resolvePromise => {
      const finish = outcome => {
        if (!pendingApprovals.delete(approvalId)) return
        clearTimeout(timer)
        request.signal?.removeEventListener('abort', abort)
        resolvePromise(outcome)
      }
      const abort = () => finish('cancelled')
      const timer = setTimeout(abort, APPROVAL_WAIT_MS)
      pendingApprovals.set(approvalId, { view, finish })
      request.signal?.addEventListener('abort', abort, { once: true })
      if (request.signal?.aborted) abort()
    })
  }, { prepend: true }), 'lyshell-harness-bridge: pet approval ownership')

  ctx.effect(() => ctx.on('session/event', (session, event) => {
    if (!activeTask || terminal(activeTask) || session?.id !== activeTask.sessionId || event.seq < floorSeq) return
    const pushText = (kind, value, extra = {}) => {
      if (typeof value !== 'string' || !value.length) return
      for (let offset = 0; offset < value.length; offset += TRANSCRIPT_TEXT_LIMIT) {
        transcript.push({ seq: ++transcriptSeq, at: event.time ?? Date.now(), kind,
          sessionId: activeTask.sessionId, taskId: activeTask.taskId, ...extra,
          text: value.slice(offset, offset + TRANSCRIPT_TEXT_LIMIT) })
      }
      if (transcript.length > TRANSCRIPT_LIMIT) transcript.splice(0, transcript.length - TRANSCRIPT_LIMIT)
    }
    const textOf = message => (message?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')
    if (event.type === 'user/message') pushText('user', textOf(event.data))
    else if (event.type === 'assistant/message') pushText('assistant', textOf(event.data.message))
    else if (event.type === 'tool/call') {
      toolNames.set(event.data.callId, event.data.name)
      pushText('tool-call', event.data.arguments, { toolName: event.data.name })
    } else if (event.type === 'tool/result') {
      pushText('tool-result', textOf(event.data.message), {
        toolName: toolNames.get(event.data.message.toolCallId), failed: event.data.message.isError === true })
    }
    if (event.type === 'turn/start') {
      activeTurn = event.data.turn
      activeTask = { ...activeTask, state: 'running' }
      wakeTask()
      return
    }
    if (event.type !== 'turn/end' || activeTurn === null || event.data.turn !== activeTurn) return
    const kind = event.data.reason?.kind
    const state = kind === 'completed' ? 'completed' : ['aborted', 'interrupted', 'forked'].includes(kind) ? 'cancelled' : 'failed'
    activeTask = { ...activeTask, state, endedAt: Date.now(), endReason: kind || 'unknown' }
    cancelApprovals()
    wakeTask()
  }), 'lyshell-harness-bridge: official turn evidence')

  async function mutate(payload) {
    if (payload.cmd === 'acquire') {
      if (!Number.isSafeInteger(payload.epoch) || payload.epoch < 1 || !isBoundedId(payload.bindingId)) throw new BridgeError('bad-request', 'invalid acquire')
      if (heldEpoch !== null) {
        if (heldEpoch !== payload.epoch || heldBinding !== payload.bindingId) throw new BridgeError('control/held-by-other', 'exclusive control already held')
        return snapshot()
      }
      heldEpoch = payload.epoch
      heldBinding = payload.bindingId
      return snapshot()
    }
    requireEpoch(payload)
    if (payload.cmd === 'release') {
      if (activeTask && !terminal(activeTask)) {
        // A queued prompt must start (or settle) before cancellation, so no inbox work survives release.
        await waitTask(activeTask.taskId, task => task.state !== 'accepted')
        cancelApprovals()
        if (!terminal(activeTask)) {
          controller().cancel({ sessionId: activeTask.sessionId })
          await waitTask(activeTask.taskId, terminal)
        }
      }
      cancelApprovals()
      // 交回控制：未落地的导航请求随之作废（不 fake 落地，也不留一个会拽用户的悬空请求）
      if (viewer.request) {
        viewer.lastAck = { requestId: viewer.request.requestId, revision: viewer.request.revision,
          sessionId: viewer.request.sessionId, currentSessionId: viewer.currentSessionId,
          status: 'superseded', at: Date.now(), reason: 'control-released' }
        viewer.request = null
      }
      heldEpoch = null
      heldBinding = null
      return snapshot()
    }
    if (payload.cmd === 'submit') {
      if (!isBoundedId(payload.taskId) || !isBoundedId(payload.sessionId) || typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 32000) throw new BridgeError('bad-request', 'invalid submit')
      if (activeTask && !terminal(activeTask)) throw new BridgeError('task/busy', 'task already active')
      if (nativeWork.owns(payload.sessionId)) throw new BridgeError('control/held-by-other', 'native work session')
      const agent = await resolveAgent(payload.sessionId)
      if (!Number.isSafeInteger(agent.session.seq)) throw new BridgeError('bridge/unavailable', 'session boundary unavailable')
      floorSeq = agent.session.seq
      transcript.length = 0
      toolNames.clear()
      activeTurn = null
      activeTask = { taskId: payload.taskId, sessionId: payload.sessionId, epoch: heldEpoch,
        state: 'accepted', acceptedAt: Date.now() }
      try {
        await controller().prompt({ sessionId: payload.sessionId, requestId: payload.taskId,
          mode: 'queue', content: [{ type: 'text', text: payload.text }] }, new AbortController().signal)
      } catch (error) {
        if (activeTask.state === 'accepted') activeTask = null
        throw error
      }
      return snapshot()
    }
    if (payload.cmd === 'cancel') {
      if (!activeTask || activeTask.taskId !== payload.taskId || terminal(activeTask)) throw new BridgeError('task/not-found', 'no active task')
      await waitTask(activeTask.taskId, task => task.state !== 'accepted')
      cancelApprovals()
      if (!terminal(activeTask)) controller().cancel({ sessionId: activeTask.sessionId })
      return snapshot()
    }
    if (payload.cmd === 'session') {
      if (activeTask && !terminal(activeTask)) throw new BridgeError('task/busy', 'task already active')
      if (payload.mode === 'new') {
        const created = await controller().create({ cwd: process.cwd() })
        if (!isBoundedId(created?.sessionId)) throw new BridgeError('bridge/unavailable', 'session create failed')
        return { ...snapshot(), sessionId: created.sessionId }
      }
      if (payload.mode !== 'select' || !isBoundedId(payload.sessionId)) throw new BridgeError('bad-request', 'invalid session selection')
      if (nativeWork.owns(payload.sessionId)) throw new BridgeError('control/held-by-other', 'native work session')
      await resolveAgent(payload.sessionId)
      return { ...snapshot(), sessionId: payload.sessionId }
    }
    if (payload.cmd === 'viewer-nav') {
      // 冻结的 viewer 请求：revision 必须是严格更新的（更旧的请求 = 迟到的详情请求，一律拒绝；
      // 用户浏览历史已经把它作废，绝不覆盖用户当前的查看位置）。
      if (!Number.isSafeInteger(payload.revision) || payload.revision <= 0) throw new BridgeError('bad-request', 'invalid viewer revision')
      if (!isBoundedId(payload.requestId) || !isBoundedId(payload.sessionId)) throw new BridgeError('bad-request', 'invalid viewer request')
      if (payload.revision <= viewer.revision) throw new BridgeError('viewer/stale', 'viewer navigation was superseded')
      viewer.revision = payload.revision
      viewer.request = { requestId: payload.requestId, sessionId: payload.sessionId,
        revision: payload.revision, epoch: heldEpoch, requestedAt: Date.now() }
      return snapshot()
    }
    throw new BridgeError('bad-request', 'unknown command')
  }
  async function runCommand(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new BridgeError('bad-request', 'invalid command')
    if (payload.cmd === 'native-work') return nativeWork.request(payload.owner, payload.request)
    if (payload.cmd === 'snapshot' || payload.cmd === 'poll') return { ...snapshot(), webBusy: anyRunning() }
    if (payload.cmd === 'approve') {
      requireEpoch(payload)
      const entry = pendingApprovals.get(payload.approvalId)
      if (!entry) throw new BridgeError('approval/not-pending', 'approval no longer pending')
      if (entry.view.epoch !== heldEpoch || entry.view.taskId !== activeTask?.taskId || entry.view.sessionId !== activeTask?.sessionId) throw new BridgeError('approval/stale', 'stale approval')
      if (!['allowed-once', 'rejected', 'cancelled'].includes(payload.outcome)) throw new BridgeError('bad-request', 'invalid approval outcome')
      entry.finish(payload.outcome)
      return { ...snapshot(), approval: payload.outcome }
    }
    const result = controlTail.then(() => mutate(payload))
    controlTail = result.catch(() => {})
    return result
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: HANDSHAKE_PATH,
    handler: (req, res) => {
      if (!keyMatches(key, req.headers[KEY_HEADER])) {
        json(res, 401, { error: 'unauthorized' })
        return
      }
      json(res, 200, {
        protocolVersion: HARNESS_PROTOCOL_VERSION,
        bridgeVersion: BRIDGE_VERSION,
        instanceId,
        instanceEpoch,
        // 启动身份取自本进程的真实状态（不是请求方给的期望值）—— 宿主据此核对「同一个后台」。
        cwd: process.cwd(),
        dshHome: resolveDshHome(process.env.DSH_HOME),
        hostBridge: true,
        clientBundle: client.bundle,
        // 诊断用：只给文件名，不给绝对路径
        clientBundleFile: client.file ? basename(client.file) : null,
        // Pet 托管控制监听端口（仅回环；鉴权仍用 host-only 头）。0 = 本次没起来（桥退化）。
        controlPort,
        uptimeMs: Date.now() - startedAt
      })
    }
  }), 'lyshell-harness-bridge: host-only handshake')

  // ===== 共享工作台的浏览器面端点（S4）=====
  // 与官方页面同源。**先过官方鉴权**（`ctx.connection.admit`），再谈 viewer cookie；
  // 这里只发：
  //   - 不含凭据的只读状态（held/phase/viewer/gatedPaths）
  //   - 导航结果（必须核对官方 UI 实际当前会话，绝不只凭调用 openSession 就宣告成功）
  //   - 用户自己的浏览（推进 revision，作废先前未落地请求）
  // 官方 /api 继续原处理链，本桥不注册 connection/request 写门禁。
  const viewerHandler = (route) => (req, res) => {
    // ① 官方登录/信任栅栏：未登录一律 401（403 = 非可信来源），**不签任何 cookie**。
    const rejection = viewerAsk(req)
    if (rejection !== null) {
      json(res, rejection, { ok: false, code: rejection === 401 ? 'auth/invalid-token' : 'auth/impersonation', error: 'official browser session required' })
      return
    }
    const host = requestHost(req)
    if (host === null) {
      json(res, 400, { ok: false, code: 'bad-request', error: 'Host header is required' })
      return
    }
    // ② viewer 身份：**只认已经持有的合法 cookie**。没有合法 cookie 就先换签一个，
    //    但这一拍不执行任何「要凭身份的动作」（认领/报告）—— 否则任何人打一次端点
    //    就白得一个身份并能抢先认领别人的导航请求。换签只用于让页面拿到身份，
    //    真正的动作等它带着 cookie 再来（浏览器会自动带上 HttpOnly cookie）。
    const presented = verifyViewerCookie(req)
    const fresh = presented === null
    const viewerId = presented ?? issueViewerCookie(res, host)
    if (fresh) {
      // 新签发的身份只能读状态（用于让页面确认自己是已登录的 viewer），
      // 不认领、不 ack、不 browse —— 下一拍带上 cookie 才具备这些能力。
      if (route === VIEWER_STATUS_PATH) {
        viewerMarkSeen()
        json(res, 200, viewerStatusBody(false))
        return
      }
      json(res, 401, { ok: false, code: 'auth/invalid-token', error: 'viewer credential required (reload the page to receive it)' })
      return
    }
    viewerMarkSeen()
    if (route === VIEWER_STATUS_PATH) {
      if (req.method !== 'GET' && req.method !== 'POST') {
        json(res, 405, { ok: false, code: 'bad-request', error: 'viewer status accepts GET or POST' })
        return
      }
      // 认领这条未落地请求（先到先得）：只有认领它的浏览器能 ack。
      if (viewer.request) viewerClaim(viewer.request, viewerId)
      json(res, 200, viewerStatusBody(viewer.request ? viewer.request.owner === viewerId : true))
      return
    }
    if (req.method !== 'POST') {
      json(res, 405, { ok: false, code: 'bad-request', error: 'viewer report accepts POST only' })
      return
    }
    void readViewerBody(req).then((body) => {
      if (body === null) {
        json(res, 400, { ok: false, code: 'bad-request', error: 'viewer report must be a JSON object' })
        return
      }
      if (route === VIEWER_ACK_PATH) {
        const pending = viewer.request
        const requestId = typeof body.requestId === 'string' ? body.requestId : ''
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        const currentSessionId = typeof body.currentSessionId === 'string' && body.currentSessionId.length > 0
          ? body.currentSessionId.slice(0, 128) : null
        const status = typeof body.status === 'string' ? body.status : ''
        // 迟到/未知 ack（含伪造 requestId 的探测）：明确拒绝，且**不认领**这条请求 ——
        // 认领必须发生在「确实在回应这条未落地请求」之后，否则任何人拿假 id 就能抢走归属，
        // 把合法浏览器的 ack 顶成 409。
        if (!pending || pending.requestId !== requestId || pending.revision !== body.revision || pending.sessionId !== sessionId) {
          json(res, 409, { ok: false, code: 'viewer/stale', error: 'no such pending viewer navigation' })
          return
        }
        // 归属核对：这条请求不是你这个 viewer 的 ⇒ 拒绝（另一个浏览器不能替我宣告落地）
        if (!viewerClaim(pending, viewerId)) {
          json(res, 409, { ok: false, code: 'viewer/stale', error: 'this navigation belongs to another viewer session' })
          return
        }
        if (!VIEWER_ACK_STATUSES.has(status)) {
          json(res, 400, { ok: false, code: 'bad-request', error: 'viewer ack status must be navigated or failed' })
          return
        }
        // 落地只能由「官方 UI 实际就在该会话」证明：调用 openSession 不算，必须核对当前会话。
        if (status === 'navigated' && currentSessionId !== pending.sessionId) {
          json(res, 409, { ok: false, code: 'viewer/stale', error: 'official UI is not on the requested session' })
          return
        }
        if (status === 'navigated') viewer.appliedRevision = pending.revision
        viewer.currentSessionId = currentSessionId
        viewer.lastAck = { requestId, revision: pending.revision, sessionId: pending.sessionId,
          currentSessionId, status, at: Date.now(),
          ...(status === 'failed' ? { reason: typeof body.reason === 'string' ? body.reason.slice(0, 200) : 'navigation-failed' } : {}) }
        viewer.request = null
        json(res, 200, viewerStatusBody())
        return
      }
      // browse：用户自己的浏览 → 推进 revision + 作废先前未落地的请求
      const currentSessionId = typeof body.currentSessionId === 'string' && body.currentSessionId.length > 0
        ? body.currentSessionId.slice(0, 128) : null
      viewer.currentSessionId = currentSessionId
      const superseded = viewer.request
      viewerBump()
      if (superseded) {
        viewer.lastAck = { requestId: superseded.requestId, revision: superseded.revision, sessionId: superseded.sessionId,
          currentSessionId, status: 'superseded', at: Date.now(), reason: 'user-browsed' }
        viewer.request = null
      }
      json(res, 200, viewerStatusBody())
    }).catch(() => {
      json(res, 400, { ok: false, code: 'bad-request', error: 'viewer report failed' })
    })
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: VIEWER_STATUS_PATH,
    handler: viewerHandler(VIEWER_STATUS_PATH)
  }), 'lyshell-harness-bridge: viewer read-only status')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: VIEWER_ACK_PATH,
    handler: viewerHandler(VIEWER_ACK_PATH)
  }), 'lyshell-harness-bridge: viewer navigation ack')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: VIEWER_BROWSE_PATH,
    handler: viewerHandler(VIEWER_BROWSE_PATH)
  }), 'lyshell-harness-bridge: viewer browse report')

  // ===== Pet 托管控制：本桥自己的回环监听 =====
  // 为什么不挂在 dsh 的 webServer 上：官方 `/api` 前缀路由是官方 client-connection 注册的
  // （`{kind:'prefix', path:'/api'}`），重复注册会抛，且它沿用官方会话鉴权。
  // Pet 控制通道用单独的 host-only 回环监听，官方路由保持可用。
  ctx.effect(() => {
    const server = http.createServer((req, res) => {
      if (!keyMatches(key, req.headers[KEY_HEADER])) {
        json(res, 401, { ok: false, code: 'auth/invalid-token', error: 'unauthorized' })
        return
      }
      if (req.method !== 'POST') {
        json(res, 405, { ok: false, code: 'bad-request', error: 'control accepts POST only' })
        return
      }
      let body = ''
      let tooLarge = false
      req.setEncoding('utf8')
      req.on('data', (chunk) => {
        body += chunk
        if (body.length > 256 * 1024) {
          tooLarge = true
          req.destroy()
        }
      })
      req.on('end', () => {
        if (tooLarge) {
          json(res, 413, { ok: false, code: 'bad-request', error: 'control payload too large' })
          return
        }
        let payload
        try {
          payload = JSON.parse(body)
        } catch {
          json(res, 400, { ok: false, code: 'bad-request', error: 'control payload must be JSON' })
          return
        }
        // 官方服务调用可能挂起（等待回合结束等），必须兜住 rejection，绝不逃逸成 unhandled
        Promise.resolve()
          .then(() => runCommand(payload))
          .then(
            (result) => json(res, 200, result),
            (error) => {
              const code = codeOf(error)
              // 只回固定分类码与固定文案，不回显原始 error.message（可能含模型/文件内容）
              json(res, code === 'bad-request' ? 400 : 409, { ok: false, code, error: 'bridge refused the command' })
            }
          )
      })
    })
    server.on('error', () => {
      // 监听失败 ⇒ Pet 托管控制不可用（桥退化）；不抛，避免拖垮 dsh 启动。
      process.stdout.write('lyshell-harness-bridge: exclusive control listener unavailable\n')
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      controlPort = typeof address === 'object' && address ? address.port : 0
    })
    return () => {
      controlPort = 0
      try {
        server.close()
      } catch {
        /* 关闭失败不影响退出路径 */
      }
    }
  }, 'lyshell-harness-bridge: exclusive control listener')

  process.stdout.write(`lyshell-harness-bridge: host half applied (protocol ${HARNESS_PROTOCOL_VERSION})\n`)
}

/** 原生工作通道：仅接受宿主转发，绝不接管现有 Web/Pet 会话。 */
export function createNativeWorkController(ctx, identity) {
  const owners = new Map()
  const ownedSessions = new Set()
  const service = name => typeof ctx.get === 'function' ? ctx.get(name) : ctx[name]
  const controller = () => service('sessionController')
  const terminal = task => task && ['completed', 'failed', 'cancelled'].includes(task.state)
  const fail = (code = 'bad-request') => { throw new BridgeError(code, 'native work request refused') }
  const stateOf = owner => {
    if (typeof owner !== 'string' || !/^[a-f0-9]{64}$/.test(owner)) fail()
    let state = owners.get(owner)
    if (!state) {
      if (owners.size >= 64) fail('task/busy')
      state = { sessionId: null, sessions: new Map(), task: null, turn: null, floor: 0,
        transcript: [], seq: 0, truncated: false, approvals: new Map(), requests: new Map(), tail: Promise.resolve() }
      owners.set(owner, state)
    }
    return state
  }
  const snapshot = state => ({ ok: true, identity: identity(),
    status: state.approvals.size ? 'approval' : state.task?.state === 'unconfirmed' ? 'error' : state.task && !terminal(state.task) ? 'running' : 'idle',
    sessionId: state.sessionId, taskId: state.task?.taskId ?? null,
    taskState: state.task?.state ?? null, task: state.task ? { ...state.task } : null,
    workspace: state.sessions.get(state.sessionId)?.workspace ?? null,
    sessions: [...state.sessions.values()].map(row => ({ ...row })),
    approvals: [...state.approvals.values()].map(entry => ({ ...entry.view })),
    transcript: state.transcript.map(entry => ({ ...entry })),
    transcriptTruncated: state.truncated || state.seq > state.transcript.length })
  const clearApprovals = state => { for (const entry of [...state.approvals.values()]) entry.finish('cancelled') }
  const active = sessionId => [...owners.values()].find(state => state.task?.sessionId === sessionId && !terminal(state.task))
  const push = (state, kind, text, extra = {}) => {
    if (typeof text !== 'string') return
    // 先截取再分块，避免巨大工具结果产生无界临时分配。
    const bounded = text.slice(-128 * 1024)
    if (bounded.length < text.length) state.truncated = true
    for (let offset = 0; offset < bounded.length; offset += 512) {
      state.transcript.push({ seq: ++state.seq, kind, text: bounded.slice(offset, offset + 512),
        at: Date.now(), taskId: state.task.taskId, sessionId: state.task.sessionId, ...extra })
    }
    if (state.transcript.length > 256) state.transcript.splice(0, state.transcript.length - 256)
  }
  const textOf = message => (message?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    const state = active(session?.id)
    if (!state || event.seq < state.floor) return
    if (event.type === 'turn/start') {
      state.turn = event.data.turn
      state.task.state = 'running'
      const receipt = state.requests.get(state.task.requestId)
      if (receipt) receipt.accepted = true
    } else if (event.type === 'turn/end' && state.turn !== null && event.data.turn === state.turn) {
      const reason = event.data.reason?.kind
      state.task.state = reason === 'completed' ? 'completed' : ['aborted', 'interrupted', 'forked'].includes(reason) ? 'cancelled' : 'failed'
      state.task.endedAt = Date.now()
      state.task.endReason = reason || 'unknown'
      clearApprovals(state)
    } else if (event.type === 'user/message') push(state, 'user', textOf(event.data))
    else if (event.type === 'assistant/message') push(state, 'assistant', textOf(event.data.message))
    else if (event.type === 'tool/call') push(state, 'tool-call', event.data.arguments, { toolName: event.data.name, callId: event.data.callId })
    else if (event.type === 'tool/result') push(state, 'tool-result', textOf(event.data.message), { callId: event.data.message.toolCallId, failed: event.data.message.isError === true })
  }), 'lyshell native work: turn evidence')
  ctx.effect(() => ctx.on('agent/error', ({ agent, error }) => {
    const state = active(agent?.id)
    if (state) state.task.diagnostic = workDiagnostic(error)
  }), 'lyshell native work: error evidence')
  ctx.effect(() => ctx.on('approval/request', (request, next) => {
    const state = active(request.agent?.session?.id)
    if (!state) return next()
    if (state.approvals.size >= 128) return 'cancelled'
    if (request.signal?.aborted) return 'cancelled'
    const id = randomUUID()
    const view = { id, taskId: state.task.taskId, sessionId: state.task.sessionId,
      toolName: request.toolName, callId: request.callId, reason: typeof request.reason === 'string' ? request.reason.slice(0, 2000) : '',
      options: ['allowed-once', 'rejected', 'cancelled'], askedAt: Date.now() }
    return new Promise(resolvePromise => {
      const finish = value => {
        if (!state.approvals.delete(id)) return
        clearTimeout(timer)
        request.signal?.removeEventListener('abort', abort)
        resolvePromise(value)
      }
      const abort = () => finish('cancelled')
      const timer = setTimeout(abort, APPROVAL_WAIT_MS)
      state.approvals.set(id, { view, finish })
      request.signal?.addEventListener('abort', abort, { once: true })
      if (request.signal?.aborted) abort()
    })
  }, { prepend: true }), 'lyshell native work: isolated approvals')
  ctx.effect(() => () => { for (const state of owners.values()) clearApprovals(state) }, 'lyshell native work: cleanup')

  async function mutate(state, request) {
    const busy = state.task && !terminal(state.task)
    if (request.kind === 'submit') {
      if (request.sessionId !== state.sessionId) fail('task/not-found')
      const previous = state.requests.get(request.requestId)
      const digest = createHash('sha256').update(request.text).digest('hex')
      if (previous) {
        if (previous.digest !== digest || previous.sessionId !== state.sessionId) fail()
        return { ...snapshot(state), accepted: previous.accepted, duplicate: true, acceptedTaskId: previous.taskId }
      }
      if (busy) fail('task/busy')
      if (!state.sessionId || !state.sessions.has(state.sessionId)) fail('task/not-found')
      const result = await controller().resolveAgent(state.sessionId)
      const agent = result?.agent
      if (!agent || result.error || !Number.isSafeInteger(agent.session.seq)) fail('task/not-found')
      // 用户可能在官方工作台运行该会话。拒绝排队混入其它回合。
      if (agent.status === 'running') fail('task/busy')
      const taskId = randomUUID()
      state.floor = agent.session.seq
      state.turn = null
      state.transcript = []
      state.seq = 0
      state.truncated = false
      state.task = { taskId, sessionId: state.sessionId, state: 'accepted', acceptedAt: Date.now(), requestId: request.requestId }
      // 在 prompt 往返之前记账：超时/抛错不能触发重复提交。
      const receipt = { taskId, sessionId: state.sessionId, digest, accepted: false }
      state.requests.set(request.requestId, receipt)
      if (state.requests.size > 256) state.requests.delete(state.requests.keys().next().value)
      try {
        await controller().prompt({ sessionId: state.sessionId, requestId: taskId, mode: 'queue',
          content: [{ type: 'text', text: request.text }] }, new AbortController().signal)
        receipt.accepted = true
      } catch {
        if (state.task.state === 'accepted') state.task.state = 'unconfirmed'
        fail('bridge/unavailable')
      }
      return { ...snapshot(state), accepted: true, acceptedTaskId: taskId }
    }
    if (request.kind === 'cancel') {
      if (!busy || state.task.taskId !== request.taskId) fail('task/not-found')
      // 已接受但尚未进入回合时，不谎报取消成功；调用方稍后读状态再停止。
      if (state.task.state !== 'running') fail('task/busy')
      clearApprovals(state)
      await controller().cancel({ sessionId: state.task.sessionId })
      return snapshot(state)
    }
    if (busy) fail('task/busy')
    if (request.kind === 'disconnect') {
      state.sessionId = null
      return snapshot(state)
    }
    if (request.kind === 'new') {
      if (state.sessions.size >= 64) fail('task/busy')
      const cwd = request.workspace ?? process.cwd()
      if (typeof cwd !== 'string' || !isAbsolute(cwd)) fail()
      const created = await controller().create({ cwd })
      if (!isBoundedId(created?.sessionId)) fail('bridge/unavailable')
      ownedSessions.add(created.sessionId)
      state.sessions.set(created.sessionId, { sessionId: created.sessionId, workspace: cwd })
      state.sessionId = created.sessionId
    } else if (request.kind === 'select') {
      if (!state.sessions.has(request.sessionId)) fail('task/not-found')
      state.sessionId = request.sessionId
    } else fail()
    state.task = null
    state.transcript = []
    state.seq = 0
    state.truncated = false
    return snapshot(state)
  }
  return {
    owns: sessionId => ownedSessions.has(sessionId),
    async request(owner, request) {
      const state = stateOf(owner)
      if (!request || typeof request !== 'object') fail()
      if (request.kind === 'state' || request.kind === 'targets') return snapshot(state)
      if (request.kind === 'approve') {
        const entry = state.approvals.get(request.id)
        if (!entry || entry.view.taskId !== state.task?.taskId || terminal(state.task)) fail('approval/not-pending')
        if (!entry.view.options.includes(request.optionId)) fail()
        entry.finish(request.optionId)
        return snapshot(state)
      }
      if (request.kind === 'submit' && (!isBoundedId(request.requestId) || typeof request.text !== 'string' ||
        !request.text.trim() || request.text.length > 32000)) fail()
      const result = state.tail.then(() => mutate(state, request))
      state.tail = result.catch(() => {})
      return result
    }
  }
}

export default { name, inject, apply }
