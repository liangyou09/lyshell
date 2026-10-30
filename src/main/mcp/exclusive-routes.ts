/**
 * Pet 托管控制的 HTTP 路由（LyShell 本机 API 上）。
 *
 * 挂载点：mcp/http-server 的 `/api/exclusive-control/*`。这一族**不走** stdio MCP、
 * 不进 API_ROUTES，普通 MCP 工具权限不能代替受控插件 host 身份。
 *
 * 鉴权两级：
 *   - 凭据：只有**已启用 aipet 插件的 host token** 能走控制面
 *     （global/session/UI token/其他插件一律按冒充拒绝）；身份全部来自 mcpAuth 的绑定；
 *   - 只读：`GET snapshot` 允许任何已鉴权 token 读（S4/S5 共享工作台消费），但**不含凭据**。
 */

import type * as http from 'http'
import {
  EXCLUSIVE_CONTROL_BASE,
  EXCLUSIVE_CONTROL_ROUTES,
  isBoundedId,
  validateAcquireInput,
  validateApproveInput,
  validateCancelInput,
  validateEpochInput,
  validateEventsQuery,
  validateSessionInput,
  validateSubmitInput,
  type ExclusiveControlSnapshot,
  type ExclusiveErrorCode,
  type ExclusiveWorkbenchDetail
} from '@shared/exclusive-control'
import { getExclusiveControl, type ExclusiveAuthFacts, type ExclusiveResult } from '../dsh/exclusive-control'
import {
  acquireWorkbenchDetail,
  publishWorkbenchDetail,
  confirmWorkbenchNavigation,
  syncExclusiveBridgeState
} from '../dsh/exclusive-runtime'
import { broadcastDshWebDetail } from '../events/application-notifications'

/**
 * 控制状态可能变了 ⇒ 重算共享工作台详情面，**只在身份真变时**推给渲染层。
 *
 * 为什么写路径也在这里推：PetLink 走的是 LyShell 本机 HTTP 控制面（不是 IPC），
 * 详情页签的打开必须以**真实控制变化**为触发源 —— 否则渲染层只能靠轮询猜「是不是该开了」。
 */
function publishDetail(force = false): ExclusiveWorkbenchDetail | null {
  try {
    const { detail, changed } = publishWorkbenchDetail(force)
    if (changed || force) broadcastDshWebDetail(detail, force)
    return detail
  } catch {
    // 详情面是展示辅助：推送失败绝不能连累控制面本身的成功/失败语义
    return null
  }
}

export interface ExclusiveHttpResult {
  status: number
  body: unknown
}

/**
 * 路由后缀常量（从共享契约的完整路径派生）—— 避免「契约里改了路径、这里还写着字面量」的漂移。
 * 下面所有 `path === ...` 分支都用它比较（`path` 是去掉 `EXCLUSIVE_CONTROL_BASE` 之后的剩余部分）。
 */
const ROUTE = {
  snapshot: EXCLUSIVE_CONTROL_ROUTES.snapshot.slice(EXCLUSIVE_CONTROL_BASE.length),
  acquire: EXCLUSIVE_CONTROL_ROUTES.acquire.slice(EXCLUSIVE_CONTROL_BASE.length),
  release: EXCLUSIVE_CONTROL_ROUTES.release.slice(EXCLUSIVE_CONTROL_BASE.length),
  events: EXCLUSIVE_CONTROL_ROUTES.events.slice(EXCLUSIVE_CONTROL_BASE.length),
  submit: EXCLUSIVE_CONTROL_ROUTES.submit.slice(EXCLUSIVE_CONTROL_BASE.length),
  cancel: EXCLUSIVE_CONTROL_ROUTES.cancel.slice(EXCLUSIVE_CONTROL_BASE.length),
  approve: EXCLUSIVE_CONTROL_ROUTES.approve.slice(EXCLUSIVE_CONTROL_BASE.length),
  session: EXCLUSIVE_CONTROL_ROUTES.session.slice(EXCLUSIVE_CONTROL_BASE.length),
  detail: EXCLUSIVE_CONTROL_ROUTES.detail.slice(EXCLUSIVE_CONTROL_BASE.length)
} as const

function fail(status: number, code: ExclusiveErrorCode, error: string, snapshot?: ExclusiveControlSnapshot): ExclusiveHttpResult {
  return { status, body: { ok: false, code, error, ...(snapshot === undefined ? {} : { snapshot }) } }
}

/** 控制面错误码 → HTTP 状态（固定映射；不要在这里引入新的分类）。 */
function statusForCode(code: ExclusiveErrorCode): number {
  switch (code) {
    case 'bad-request':
      return 400
    case 'auth/not-enabled':
    case 'auth/impersonation':
    case 'auth/invalid-token':
    case 'auth/generation-stale':
      return 403
    case 'control/not-held':
    case 'control/held-by-other':
      return 409
    case 'instance/busy':
    case 'task/busy':
      return 409
    case 'task/stale-epoch':
    case 'approval/stale':
    case 'task/not-found':
    case 'approval/not-pending':
      return 409
    case 'instance/no-bridge':
    case 'instance/unavailable':
    case 'bridge/unavailable':
    case 'bridge/timeout':
      return 503
    default:
      return 500
  }
}

function fromService<T extends Record<string, unknown>>(result: ExclusiveResult<T>): ExclusiveHttpResult {
  if (result.ok) {
    const { ok, ...rest } = result
    void ok
    return { status: 200, body: { ok: true, ...rest } }
  }
  return fail(statusForCode(result.code), result.code, result.error, result.snapshot)
}

/**
 * 变更后统一收尾：先算详情面并推事件，再按服务结果回 HTTP。
 * **失败也推** —— 一次被拒的 acquire/submit 同样可能改了控制相位（releasing/busy），
 * 共享工作台的可读原因必须跟上，不能停在旧状态上。
 */
async function settled<T extends Record<string, unknown>>(run: Promise<ExclusiveResult<T>>): Promise<ExclusiveHttpResult> {
  const result = await run
  publishDetail()
  return fromService(result)
}

async function readJsonBody(req: http.IncomingMessage, maxBytes = 256 * 1024): Promise<unknown> {
  return await new Promise((resolve) => {
    let body = ''
    let tooLarge = false
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      body += chunk
      if (body.length > maxBytes) {
        tooLarge = true
        req.destroy()
      }
    })
    req.on('end', () => {
      if (tooLarge) {
        resolve(undefined)
        return
      }
      try {
        resolve(body.length === 0 ? {} : JSON.parse(body))
      } catch {
        resolve(undefined)
      }
    })
    req.on('error', () => resolve(undefined))
  })
}

/**
 * 桥状态同步失败时的明确 host 错误（不回退本地、不盲重发）。
 * 只要**仍持有或正在释放**（Pet 绑定仍待确认），读路径就必须让调用方看到明确错误 ——
 * releasing 时 isHeld 已是 false，但绝不是「一切正常」。
 */
function mustSurfaceSyncFailure(service: { isHeld: boolean; isReleasing: boolean }): boolean {
  return service.isHeld || service.isReleasing
}

function bridgeSyncFailure(code: string, error: string): ExclusiveHttpResult {
  return fail(503, (code as ExclusiveErrorCode) ?? 'bridge/unavailable', error)
}

/**
 * Pet 托管控制路由的总入口。返回 null 表示「不是这一族路径」。
 * `binding` 是已通过 mcpAuth.resolveToken 的凭据绑定（调用方负责先鉴权）。
 */
export async function handleExclusiveControlRequest(
  req: http.IncomingMessage,
  url: URL,
  binding: ExclusiveAuthFacts
): Promise<ExclusiveHttpResult | null> {
  if (!url.pathname.startsWith(EXCLUSIVE_CONTROL_BASE)) return null
  const service = getExclusiveControl()
  if (!service) return fail(503, 'instance/unavailable', 'exclusive control is not initialized')

  const path = url.pathname.slice(EXCLUSIVE_CONTROL_BASE.length)
  const canRead = service.canReadSnapshot(binding)

  // 只读快照：允许任何**已鉴权**凭据读（S4/S5 共享工作台消费），不含凭据。
  if (path === ROUTE.snapshot && req.method === 'GET') {
    if (!canRead) return fail(403, 'auth/impersonation', 'credential cannot read the control snapshot')
    const synced = await syncExclusiveBridgeState()
    if (!synced.ok && mustSurfaceSyncFailure(service)) {
      // host 错误明确：不同步成功就不谎报状态（含 releasing）
      publishDetail()
      return bridgeSyncFailure(synced.code, synced.error)
    }
    publishDetail()
    return { status: 200, body: { ok: true, snapshot: service.getSnapshot() } }
  }

  // 其余一切（含写操作与事件）都要求受控插件的 host 凭据
  const auth = service.authorize(binding)
  if (!auth.ok) return fail(403, auth.code, auth.error)

  if (path === ROUTE.acquire && req.method === 'POST') {
    const parsed = validateAcquireInput(await readJsonBody(req))
    if (!parsed.ok) return fail(400, 'bad-request', parsed.error)
    // 身份只认 token：请求体声明的 pluginId 必须与凭据一致，否则按冒充拒绝
    if (parsed.value.pluginId !== binding.pluginId) {
      return fail(403, 'auth/impersonation', 'request pluginId does not match the credential')
    }
    // HTTP 超时/退出期间后台仍可能正在启动；断开的 acquire 不得迟到铸造孤立绑定。
    const abort = new AbortController()
    const disconnected = (): void => abort.abort()
    req.socket?.once('close', disconnected)
    if (req.socket?.destroyed) abort.abort()
    try { return await settled(
      service.acquire({
        pluginId: binding.pluginId as string,
        pluginInstanceId: parsed.value.pluginInstanceId
      }, abort.signal)
    ) } finally { req.socket?.removeListener('close', disconnected) }
  }

  if (path === ROUTE.release && req.method === 'POST') {
    const parsed = validateEpochInput(await readJsonBody(req))
    if (!parsed.ok) return fail(400, 'bad-request', parsed.error)
    return settled(service.release(parsed.value.epoch))
  }

  if (path === ROUTE.events && req.method === 'GET') {
    const parsed = validateEventsQuery(url.searchParams.get('since'), url.searchParams.get('limit'))
    if (!parsed.ok) return fail(400, 'bad-request', parsed.error)
    const synced = await syncExclusiveBridgeState()
    if (!synced.ok && mustSurfaceSyncFailure(service)) {
      publishDetail()
      return bridgeSyncFailure(synced.code, synced.error)
    }
    publishDetail()
    const batch = service.getEvents(parsed.value.since, parsed.value.limit, service.getSnapshot().webBusy)
    return { status: 200, body: { ok: true, ...batch } }
  }

  if (path === ROUTE.submit && req.method === 'POST') {
    const parsed = validateSubmitInput(await readJsonBody(req))
    if (!parsed.ok) return fail(400, 'bad-request', parsed.error)
    return settled(service.submit(parsed.value))
  }

  if (path === ROUTE.cancel && req.method === 'POST') {
    const parsed = validateCancelInput(await readJsonBody(req))
    if (!parsed.ok) return fail(400, 'bad-request', parsed.error)
    return settled(service.cancel(parsed.value))
  }

  if (path === ROUTE.approve && req.method === 'POST') {
    const parsed = validateApproveInput(await readJsonBody(req))
    if (!parsed.ok) return fail(400, 'bad-request', parsed.error)
    return settled(service.approve(parsed.value))
  }

  if (path === ROUTE.session && req.method === 'POST') {
    const parsed = validateSessionInput(await readJsonBody(req))
    if (!parsed.ok) return fail(400, 'bad-request', parsed.error)
    return settled(service.session(parsed.value))
  }

  /**
   * 托管工作台详情（S5）：受控插件（Pet）请求打开/回到官方工作台。
   *
   * 这里**只**复用已有路径：与渲染层 `dsh:web:detail` IPC 走同一份 runtime（`acquireWorkbenchDetail`
   * 复用同一后台 + `requestWorkbenchNavigation` 冻结 viewer 请求），并由同一条详情面广播驱动
   * LyShell 主区域单例页签。不新造导航实现、不在 Pet 侧 load 另一份 Web、不开独立 URL。
   *
   * epoch 必须等于**当前绑定**代际（旧代际明确拒绝）；导航落地与否由 viewer ack 决定 ——
   * 未落地如实回 `navigation.ok=false`，绝不 fake ack。
   *
   * 凭据边界（v3 凭据边界）：本响应**不含官方 Web 地址**。`acquireWorkbenchDetail().url` 是带登录
   * 凭据的官方启动地址（可能带 token），只由 LyShell 自己交给自己的 webview（渲染层
   * `dsh:web:detail` IPC）。外部控制者拿到它就等于拿到 dsh 凭据，所以这里只回
   * 实例身份 / 复用情况 / 只读相位 / 导航回执。
   */
  if (path === ROUTE.detail && req.method === 'POST') {
    const body = await readJsonBody(req)
    const fingerprint = isPlainRecord(body) ? body : {}
    const extra = Object.keys(fingerprint).filter((key) => key !== 'epoch' && key !== 'sessionId')
    if (extra.length > 0) return fail(400, 'bad-request', `unexpected field: ${extra[0]}`)
    const epoch = validateEpochInput({ epoch: fingerprint.epoch })
    if (!epoch.ok) return fail(400, 'bad-request', epoch.error)
    if (fingerprint.sessionId !== undefined && !isBoundedId(fingerprint.sessionId)) {
      return fail(400, 'bad-request', 'sessionId must be a non-empty bounded string when present')
    }
    const binding = service.getSnapshot().binding
    if (!binding) return fail(409, 'control/not-held', 'exclusive control is not held')
    if (binding.epoch !== epoch.value.epoch) {
      return fail(409, 'task/stale-epoch', 'stale control epoch; this detail request belongs to an older controller generation')
    }
    const detail = await acquireWorkbenchDetail()
    if (!detail.ok) return fail(statusForCode(detail.code as ExclusiveErrorCode), detail.code as ExclusiveErrorCode, detail.error)
    const sessionId = fingerprint.sessionId as string | undefined
    // 先让真实渲染层挂载官方工作台，再等页面 ack；否则冷页签无法完成导航。
    const { detail: surface } = publishWorkbenchDetail(true)
    broadcastDshWebDetail(surface, true, true)
    let navigation: { ok: boolean; skipped?: boolean; code?: string; error?: string } | null = null
    if (sessionId) {
      const nav = await confirmWorkbenchNavigation(sessionId)
      navigation = nav.ok ? { ok: true, skipped: nav.skipped } : { ok: false, code: nav.code, error: nav.error }
    }
    // **绝不回传官方 Web 地址**：`detail.url` 是带登录凭据的官方启动地址（可能带 token），
    // 只由 LyShell 自己把它交给自己的 webview（渲染层那条 `dsh:web:detail` IPC）。
    // 外部控制者（Pet）只需要「已复用同一后台 + 导航落地与否 + 只读相位」这些无凭据事实。
    return {
      status: 200,
      body: {
        ok: true,
        cwd: detail.cwd,
        instanceId: detail.instanceId,
        instanceEpoch: detail.instanceEpoch,
        reused: detail.reused,
        readOnly: detail.readOnly,
        petSessionId: detail.viewer?.petSessionId ?? surface.petSessionId,
        currentSessionId: detail.viewer?.currentSessionId ?? null,
        viewerRevision: detail.viewer?.revision ?? 0,
        navigation,
        surface
      }
    }
  }

  return fail(404, 'bad-request', 'unknown exclusive-control route')
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
