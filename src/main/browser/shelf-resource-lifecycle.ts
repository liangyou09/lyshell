import { randomUUID } from 'crypto'

/**
 * P2 主进程普通网页资源生命周期内核（纯逻辑，不 import Electron、不触碰 DOM）。
 *
 * 实例由主进程长期持有；真实 guest 操作、原生事件核验与持久化全部由接入层注入回调。
 * 本模块只管理普通网页，不管理 PTY、终端、插件与 Harness 资源。
 *
 * 使用示例（接入层，节选）：
 * ```ts
 * const lifecycle = new ShelfResourceLifecycle({
 *   // P0 实测 Electron 43 的 webview.close 仍会销毁受保护 guest，默认 false。
 *   safeCloseSupported: false,
 *   allowlistedProviderIds: ['adapter:example.com'],
 *   // 只接受 main 侧核对过的原生 did-attach 事件，不接受 renderer 上报的 id。
 *   verifyNativeAttach: (event) => toNativeAttachEvidence(event),
 * })
 * lifecycle.setDemand({ scopeId, resourceId, ownerId, source: 'explicitMain', requestId })
 * const permit = lifecycle.createPermit({ scopeId, resourceId, ownerId })
 * if (permit.ok) {
 *   acquireGuest(permit.permit.permitId)            // renderer 拿 permitId 创建 webview
 *   lifecycle.beginAttach(permit.permit.permitId)   // 只能消费一次
 *   // main 收到原生 did-attach 后：
 *   lifecycle.recordAttached(evidenceFor(permit.permit.permitId, guestId))
 * }
 * // 闲置 5 分钟后：
 * const op = lifecycle.beginSuspend({ scopeId, resourceId, ownerId, policyAllowed, restore })
 * if (op.ok && (await saveMetadata(op.operation.restore))) {
 *   const close = lifecycle.commitSuspendSaved(op.operation.operationId)
 *   if (close.ok) guest.close({ waitForBeforeUnload: true }) // 只等匹配的 destroyed 证据
 * }
 * ```
 */

export type ResourceKind = 'web'
export type ResourceState = 'metadataOnly' | 'live' | 'suspending' | 'sleeping' | 'restoring' | 'closed'
export type RestoreStatus = 'idle' | 'queued' | 'loading' | 'ready' | 'failed'
export type PresentationOwner = 'main' | 'shelf' | 'none'
export type ProtectionDecision = 'safe' | 'blocked' | 'unknown'
export type DemandSource = 'explicitMain' | 'explicitShelf' | 'bulkVisible'
export type PermitState = 'pending' | 'attaching' | 'attached' | 'unknown' | 'closing'
export type SuspendPhase = 'saving' | 'closing'

/** 网页侧只能提供「阻止销毁」的原因；safe 必须没有任何 blocked 原因。 */
export type BlockReason =
  | 'editing'
  | 'unsaved-form'
  | 'beforeunload'
  | 'upload'
  | 'media'
  | 'devtools'
  | 'navigation'
  | 'post'
  | 'one-time-token'
  | 'credentials'
  | 'keepalive'
  | 'owner-keepalive'

export type LifecycleCode =
  | 'ok'
  | 'invalid'
  | 'not-found'
  | 'limit-reached'
  | 'owner-mismatch'
  | 'stale-token'
  | 'stale-generation'
  | 'stale-geometry'
  | 'already-closed'
  | 'instance-present'
  | 'permit-held'
  | 'permit-consumed'
  | 'permit-expired'
  | 'attach-untrusted'
  | 'attach-mismatch'
  | 'no-instance'
  | 'demand-required'
  | 'not-eligible'
  | 'unsupported-close'
  | 'policy-disabled'
  | 'kind-unsupported'
  | 'restore-unsafe'
  | 'demand-present'
  | 'idle-short'
  | 'protection-unknown'
  | 'protection-blocked'
  | 'protection-untrusted'
  | 'protection-stale'
  | 'protection-expired'
  | 'cooldown'
  | 'save-failed'
  | 'recheck-failed'
  | 'close-refused'
  | 'close-timeout'
  | 'stale-operation'
  | 'already-destroyed'
  | 'blocked:editing'
  | 'blocked:unsaved-form'
  | 'blocked:beforeunload'
  | 'blocked:upload'
  | 'blocked:media'
  | 'blocked:devtools'
  | 'blocked:navigation'
  | 'blocked:post'
  | 'blocked:one-time-token'
  | 'blocked:credentials'
  | 'blocked:keepalive'
  | 'blocked:owner-keepalive'

const BLOCK_CODES: Record<BlockReason, LifecycleCode> = {
  editing: 'blocked:editing',
  'unsaved-form': 'blocked:unsaved-form',
  beforeunload: 'blocked:beforeunload',
  upload: 'blocked:upload',
  media: 'blocked:media',
  devtools: 'blocked:devtools',
  navigation: 'blocked:navigation',
  post: 'blocked:post',
  'one-time-token': 'blocked:one-time-token',
  credentials: 'blocked:credentials',
  keepalive: 'blocked:keepalive',
  'owner-keepalive': 'blocked:owner-keepalive'
}

/**
 * 只认 BLOCK_CODES 的自有键：`in` 会把 `toString` / `__proto__` 等原型链键当成合法原因，
 * 于是未知原因既能绕过 blocked 判定，又会在 BLOCK_CODES[reason] 处取到非代码值。
 */
const BLOCK_REASON_KEYS: ReadonlySet<string> = new Set(Object.keys(BLOCK_CODES))

/** 与仓库其它 URL 边界一致（见 src/shared/task-shelf.ts）。 */
const MAX_URL_LENGTH = 4096
const MAX_RESOURCES = 100
const MAX_STRING = 512
const MAX_DIAGNOSTICS = 100
const MAX_BLOCK_REASONS = 16
const DEFAULT_DEEP_SLEEP_MS = 300_000
const DEFAULT_IDLE_LABEL_MS = 30_000
const DEFAULT_PROTECTION_TTL_MS = 2_000
const DEFAULT_PERMIT_TIMEOUT_MS = 30_000
// 控制字符检测是这里的目的本身，因此显式关闭该规则的告警。
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/
const KEY_SEPARATOR = '\u0000'

export interface Failure {
  ok: false
  code: LifecycleCode
  detail?: string
}

export type Result<T = unknown> = ({ ok: true } & T) | Failure

export interface ResourceInit {
  scopeId: string
  resourceId: string
  ownerId: string
}

export interface DemandInput extends ResourceInit {
  source: DemandSource
  requestId: string
}

export interface ResourceToken {
  scopeId: string
  resourceId: string
  instanceGeneration: number
  navigationGeneration: number
  demandRevision: number
}

export interface CreatePermitResult {
  permitId: string
  token: ResourceToken
}

export interface AttachTicket {
  permitId: string
  token: ResourceToken
  ownerId: string
}

/** 只能由 main 从原生 did-attach 事件构造并核验；renderer 上报的裸 id 一律拒绝。 */
export interface NativeAttachEvidence {
  kind: 'native-did-attach'
  permitId: string
  guestId: string
  scopeId: string
  resourceId: string
  ownerId: string
  instanceGeneration: number
  navigationGeneration: number
}

export interface Geometry {
  width: number
  height: number
  dpr: number
}

export interface GeometryInput {
  geometryRevision: number
  width: number
  height: number
  dpr: number
}

/** 仅供恢复的小型 GET 描述符：不含 JS 堆、POST 正文、Cookie 或凭据。 */
export interface RestoreMetadata {
  taskId: string
  resourceId: string
  method: 'GET'
  url: string
  partition: string
  zoom: number
  scrollY: number
  formatVersion: number
  recordedAt: number
}

export interface ProtectionReport extends ResourceInit {
  decision: ProtectionDecision
  providerId: string
  revision: number
  instanceGeneration: number
  navigationGeneration: number
  reasonCodes?: readonly BlockReason[]
}

export interface SuspendRequest extends ResourceInit {
  policyAllowed: boolean
  restore: RestoreMetadata
  now?: number
}

export interface SuspendOperation {
  operationId: string
  token: ResourceToken
  restore: RestoreMetadata
  protectionRevision: number
}

export interface CloseRequest {
  operationId: string
  guestId: string
  token: ResourceToken
}

export interface SuspendEvaluation {
  eligible: boolean
  codes: LifecycleCode[]
  idleForMs: number | null
  idleLabel: boolean
  state: ResourceState
  presentationOwner: PresentationOwner
}

export interface DestroyedEvidence {
  resourceId: string
  instanceGeneration: number
  guestId?: string
}

export interface DestroyedInput extends ResourceInit, DestroyedEvidence {}

export interface ResourceView {
  scopeId: string
  resourceId: string
  ownerId: string
  kind: ResourceKind
  state: ResourceState
  restoreStatus: RestoreStatus
  presentationReady: boolean
  presentationOwner: PresentationOwner
  token: ResourceToken
  geometryRevision: number
  geometry: Geometry | null
  permitId: string | null
  permitState: PermitState | null
  guestId: string | null
  hasMainDemand: boolean
  hasShelfDemand: boolean
  idleForMs: number | null
  idleLabel: boolean
  lastUrl: string | null
  protection: Pick<ProtectionRecord, 'decision' | 'providerId' | 'revision' | 'checkedAt'> | null
  suspend: Pick<SuspendRecord, 'operationId' | 'phase' | 'pendingDemand' | 'closeTimedOut'> | null
}

export interface LifecycleStats {
  resources: number
  metadataOnly: number
  live: number
  suspending: number
  sleeping: number
  restoring: number
  closed: number
  instances: number
  permits: number
  demands: number
}

export interface DiagnosticEntry {
  at: number
  scopeId: string
  resourceId: string
  event: string
  detail?: string
}

export interface ShelfResourceLifecycleOptions {
  now?: () => number
  createId?: () => string
  verifyNativeAttach?: (evidence: unknown) => NativeAttachEvidence | null
  maxResources?: number
  deepSleepAfterMs?: number
  idleLabelMs?: number
  /** 保护结论有效期上限，超过即按过期拒绝（规范上限 2000ms）。 */
  protectionTtlMs?: number
  permitTimeoutMs?: number
  allowlistedProviderIds?: readonly string[]
  /** 只有调用方专项验证过 close 可安全撤销时才能为 true；默认 false。 */
  safeCloseSupported?: boolean
  /** main 强制的可丢弃契约；不能来自网页/renderer 的 safe 声明。 */
  verifyDiscardContract?: (token: ResourceToken) => boolean
}

interface Demand {
  source: DemandSource
  requestId: string
}

interface PermitRecord {
  permitId: string
  ownerId: string
  instanceGeneration: number
  navigationGeneration: number
  demandRevision: number
  createdAt: number
  state: PermitState
  attachConsumed: boolean
  guestId: string | null
}

interface SuspendRecord {
  operationId: string
  token: ResourceToken
  restore: RestoreMetadata
  protectionRevision: number
  phase: SuspendPhase
  pendingDemand: boolean
  closeTimedOut: boolean
  createdAt: number
}

interface ProtectionRecord {
  decision: ProtectionDecision
  providerId: string
  revision: number
  checkedAt: number
  instanceGeneration: number
  navigationGeneration: number
  reasonCodes: BlockReason[]
}

interface GuestRecord {
  guestId: string
  permitId: string
  instanceGeneration: number
}

interface ResourceRecord {
  scopeId: string
  resourceId: string
  ownerId: string
  kind: ResourceKind
  state: ResourceState
  restoreStatus: RestoreStatus
  presentationReady: boolean
  presentationOwner: PresentationOwner
  instanceGeneration: number
  navigationGeneration: number
  demandRevision: number
  geometryRevision: number
  geometry: Geometry | null
  mainDemand: Demand | null
  shelfDemand: Demand | null
  permit: PermitRecord | null
  guest: GuestRecord | null
  protection: ProtectionRecord | null
  suspend: SuspendRecord | null
  idleSince: number | null
  lastUrl: string | null
  lastRefusedProtectionRevision: number | null
  createdAt: number
}

function fail(code: LifecycleCode, detail?: string): Failure {
  return detail === undefined ? { ok: false, code } : { ok: false, code, detail: clampText(detail) }
}

function isFailure(value: unknown): value is Failure {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false
}

function isSmallString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_STRING && !CONTROL_CHARS.test(value)
}

function clampText(value: string): string {
  return value.length <= MAX_STRING ? value : value.slice(0, MAX_STRING)
}

function isSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * 构造参数里的计数型阈值：非安全整数或小于 1 一律回退默认值。
 * 关键在 NaN/Infinity：`Math.min(NaN, cap)` 得到 NaN，`size >= NaN` 恒为 false，会让 100 记录预算静默失效。
 */
function boundedCount(value: unknown, fallback: number, cap: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return fallback
  return Math.min(value, cap)
}

/** 构造参数里的毫秒阈值：负数、0、NaN、Infinity 都回退默认值。 */
function boundedMs(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return fallback
  return value
}

/** 恢复用 URL：限长取仓库统一的 4096，并先挡住控制字符。 */
function isBoundedWebUrl(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_URL_LENGTH && !CONTROL_CHARS.test(value)
}

function isDemandSource(value: unknown): value is DemandSource {
  return value === 'explicitMain' || value === 'explicitShelf' || value === 'bulkVisible'
}

function isProtectionDecision(value: unknown): value is ProtectionDecision {
  return value === 'safe' || value === 'blocked' || value === 'unknown'
}

function keyOf(scopeId: string, resourceId: string): string {
  return scopeId + KEY_SEPARATOR + resourceId
}

/** 只接受 https/http 的 GET 恢复描述符；不接受凭据、非 GET 或非法 URL。 */
function isSafeRestore(record: ResourceRecord, meta: RestoreMetadata): boolean {
  if (!meta || typeof meta !== 'object' || meta.method !== 'GET') return false
  if (meta.resourceId !== record.resourceId) return false
  if (!isSmallString(meta.taskId) || !isBoundedWebUrl(meta.url) || !isSmallString(meta.partition)) return false
  if (!isPositiveInt(meta.formatVersion) || !isSafeInt(meta.recordedAt)) return false
  if (!isFinitePositive(meta.zoom) || meta.zoom > 10) return false
  if (typeof meta.scrollY !== 'number' || !Number.isFinite(meta.scrollY) || meta.scrollY < 0) return false
  let parsed: URL
  try {
    parsed = new URL(meta.url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  // 百分号编码可能让规范化后的 href 变长，规范化后再核一次上限。
  if (parsed.href.length > MAX_URL_LENGTH) return false
  return !parsed.username && !parsed.password
}

/** 只复制白名单字段，杜绝把调用方对象里的额外内容带进恢复记录。 */
function sanitizeRestore(meta: RestoreMetadata): RestoreMetadata {
  return {
    taskId: meta.taskId,
    resourceId: meta.resourceId,
    method: 'GET',
    url: meta.url,
    partition: meta.partition,
    zoom: meta.zoom,
    scrollY: meta.scrollY,
    formatVersion: meta.formatVersion,
    recordedAt: meta.recordedAt
  }
}

/**
 * 主进程长期持有的普通网页资源生命周期协调器。
 * 所有方法同步、无副作用回调；接入层负责真实 guest 创建/关闭与持久化。
 */
export class ShelfResourceLifecycle {
  /** 遗忘关闭记录后也不复用实例代际，防止同资源 ID 再次出现时旧异步结果通过 ABA 校验。 */
  private instanceSequence = 0
  private readonly records = new Map<string, ResourceRecord>()
  private readonly events: DiagnosticEntry[] = []
  private readonly clock: () => number
  private readonly createId: () => string
  private readonly verifyAttach?: (evidence: unknown) => NativeAttachEvidence | null
  private readonly maxResources: number
  private readonly deepSleepAfterMs: number
  private readonly idleLabelMs: number
  private readonly protectionTtlMs: number
  private readonly permitTimeoutMs: number
  private readonly providerIds: ReadonlySet<string>
  private readonly safeCloseSupported: boolean
  private readonly verifyDiscardContract?: (token: ResourceToken) => boolean

  constructor(options: ShelfResourceLifecycleOptions = {}) {
    this.clock = options.now ?? Date.now
    this.createId = options.createId ?? randomUUID
    this.verifyAttach = options.verifyNativeAttach
    this.maxResources = boundedCount(options.maxResources, MAX_RESOURCES, MAX_RESOURCES)
    this.deepSleepAfterMs = boundedMs(options.deepSleepAfterMs, DEFAULT_DEEP_SLEEP_MS)
    this.idleLabelMs = boundedMs(options.idleLabelMs, DEFAULT_IDLE_LABEL_MS)
    this.protectionTtlMs = boundedCount(options.protectionTtlMs, DEFAULT_PROTECTION_TTL_MS, DEFAULT_PROTECTION_TTL_MS)
    this.permitTimeoutMs = boundedMs(options.permitTimeoutMs, DEFAULT_PERMIT_TIMEOUT_MS)
    this.providerIds = new Set((options.allowlistedProviderIds ?? []).filter(isSmallString))
    this.safeCloseSupported = options.safeCloseSupported === true
    this.verifyDiscardContract = options.verifyDiscardContract
  }

  // ---- 需求与展示归属 -------------------------------------------------------

  setDemand(input: DemandInput): Result<{ changed: boolean }> {
    if (!isDemandSource(input.source) || !isSmallString(input.requestId)) return fail('invalid')
    const ensured = this.ensure(input)
    if (isFailure(ensured)) return ensured
    const record = ensured
    if (record.state === 'closed') return fail('already-closed', '用户已关闭，需显式 reopen')
    const isMain = input.source === 'explicitMain'
    const next: Demand = { source: input.source, requestId: input.requestId }
    const current = isMain ? record.mainDemand : record.shelfDemand
    if (current && current.source === next.source && current.requestId === next.requestId) {
      return { ok: true, changed: false }
    }
    record.demandRevision += 1
    if (isMain) record.mainDemand = next
    else record.shelfDemand = next
    this.onDemand(record, true)
    return { ok: true, changed: true }
  }

  clearDemand(input: ResourceInit & { source: DemandSource }): Result<{ changed: boolean }> {
    if (!isDemandSource(input.source)) return fail('invalid')
    const resolved = this.resolve(input)
    if (isFailure(resolved)) return resolved
    const isMain = input.source === 'explicitMain'
    const current = isMain ? resolved.mainDemand : resolved.shelfDemand
    // 只清掉与请求 source 完全相同的那条需求：迟到的 bulkVisible 清理不能误删当前 explicitShelf 需求。
    if (!current || current.source !== input.source) return { ok: true, changed: false }
    resolved.demandRevision += 1
    if (isMain) resolved.mainDemand = null
    else resolved.shelfDemand = null
    this.onDemand(resolved, false)
    return { ok: true, changed: true }
  }

  inspect(input: ResourceInit): Result<{ view: ResourceView }> {
    const resolved = this.resolve(input)
    if (isFailure(resolved)) return resolved
    const record = resolved
    const idleForMs = record.idleSince === null ? null : this.clock() - record.idleSince
    return {
      ok: true,
      view: {
        scopeId: record.scopeId,
        resourceId: record.resourceId,
        ownerId: record.ownerId,
        kind: record.kind,
        state: record.state,
        restoreStatus: record.restoreStatus,
        presentationReady: record.presentationReady,
        presentationOwner: record.presentationOwner,
        token: this.tokenOf(record),
        geometryRevision: record.geometryRevision,
        geometry: record.geometry ? { ...record.geometry } : null,
        permitId: record.permit?.permitId ?? null,
        permitState: record.permit?.state ?? null,
        guestId: record.guest?.guestId ?? null,
        hasMainDemand: record.mainDemand !== null,
        hasShelfDemand: record.shelfDemand !== null,
        idleForMs,
        idleLabel: idleForMs !== null && idleForMs >= this.idleLabelMs,
        lastUrl: record.lastUrl,
        protection: record.protection
          ? {
              decision: record.protection.decision,
              providerId: record.protection.providerId,
              revision: record.protection.revision,
              checkedAt: record.protection.checkedAt
            }
          : null,
        suspend: record.suspend
          ? {
              operationId: record.suspend.operationId,
              phase: record.suspend.phase,
              pendingDemand: record.suspend.pendingDemand,
              closeTimedOut: record.suspend.closeTimedOut
            }
          : null
      }
    }
  }

  // ---- 创建许可与原生附着 ------------------------------------------------

  createPermit(input: ResourceInit): Result<{ permit: CreatePermitResult }> {
    const resolved = this.resolve(input)
    if (isFailure(resolved)) return resolved
    const record = resolved
    if (record.state === 'closed') return fail('already-closed')
    if (!record.mainDemand && !record.shelfDemand) return fail('demand-required', '没有有效展示需求，不创建 guest')
    if (record.permit?.state === 'closing') return fail('permit-held', 'permit=closing')
    if (record.guest) return fail('instance-present')
    if (record.permit) return fail('permit-held', `permit=${record.permit.state}`)
    const permitId = this.createId()
    if (!isSmallString(permitId) || this.findPermit(permitId)) return fail('invalid', 'id 工厂返回了非法或重复的 permitId')
    const instanceGeneration = this.instanceSequence + 1
    if (!Number.isSafeInteger(instanceGeneration)) return fail('limit-reached', '实例代际已耗尽')
    this.instanceSequence = instanceGeneration
    record.instanceGeneration = instanceGeneration
    record.protection = null
    record.lastRefusedProtectionRevision = null
    record.permit = {
      permitId,
      ownerId: record.ownerId,
      instanceGeneration,
      navigationGeneration: record.navigationGeneration,
      demandRevision: record.demandRevision,
      createdAt: this.clock(),
      state: 'pending',
      attachConsumed: false,
      guestId: null
    }
    record.state = 'restoring'
    record.restoreStatus = 'queued'
    record.presentationReady = false
    record.geometry = null
    record.idleSince = null
    this.diagnose(record, 'permit', permitId)
    return { ok: true, permit: { permitId, token: this.tokenOf(record) } }
  }

  beginAttach(permitId: string): Result<{ ticket: AttachTicket }> {
    const found = this.findPermit(permitId)
    if (!found) return fail('not-found')
    const { record, permit } = found
    if (permit.attachConsumed || permit.state !== 'pending') return fail('permit-consumed', `permit=${permit.state}`)
    if (this.clock() - permit.createdAt > this.permitTimeoutMs) {
      permit.state = 'unknown'
      this.diagnose(record, 'create-timeout', '附着未完成，仅标 unknown，不发替代许可')
      return fail('permit-expired', '创建超时只记为 unknown')
    }
    permit.attachConsumed = true
    permit.state = 'attaching'
    return { ok: true, ticket: { permitId, token: this.tokenOf(record), ownerId: record.ownerId } }
  }

  /** 创建超时只把许可标为 unknown/blocked，槽位与句柄都保留。 */
  expirePermit(permitId: string): Result<{ state: PermitState }> {
    const found = this.findPermit(permitId)
    if (!found) return fail('not-found')
    if (found.permit.state !== 'pending') return { ok: true, state: found.permit.state }
    found.permit.state = 'unknown'
    this.diagnose(found.record, 'create-timeout', '创建超时只标 unknown，不发替代许可')
    return { ok: true, state: 'unknown' }
  }

  /** 宿主退出/附着失败：确认旧创建已终止才释放槽位，否则保持许可占用。 */
  abandonPermit(
    permitId: string,
    input: { terminationConfirmed: boolean; reason: 'host-exit' | 'attach-failed' | 'create-timeout' }
  ): Result<{ state: ResourceState }> {
    const found = this.findPermit(permitId)
    if (!found) return fail('not-found')
    const { record, permit } = found
    if (!input.terminationConfirmed) {
      permit.state = 'unknown'
      this.diagnose(record, `abandon-rejected:${input.reason}`, '未确认旧创建已终止，保留许可槽位')
      return fail('permit-held', '未确认旧创建已终止，不发替代许可')
    }
    record.permit = null
    record.presentationReady = false
    record.geometry = null
    record.state = record.state === 'closed' ? 'closed' : 'metadataOnly'
    record.restoreStatus = record.mainDemand || record.shelfDemand ? 'queued' : 'idle'
    this.diagnose(record, `abandon:${input.reason}`, permitId)
    return { ok: true, state: record.state }
  }

  recordAttached(evidence: unknown): Result<{ guestId: string; token: ResourceToken }> {
    if (!this.verifyAttach) return fail('attach-untrusted', '未注入原生 did-attach 核验器')
    const verified = this.verifyAttach(evidence)
    if (!verified || verified.kind !== 'native-did-attach') {
      return fail('attach-untrusted', '只接受调用方核验过的原生 did-attach 证据')
    }
    if (!isSmallString(verified.guestId)) return fail('invalid', 'guestId 非法')
    const found = this.findPermit(verified.permitId)
    if (!found) return fail('attach-mismatch', '未找到对应许可')
    const { record, permit } = found
    if (permit.state !== 'attaching' && permit.state !== 'unknown') return fail('attach-mismatch', `permit=${permit.state}`)
    if (verified.scopeId !== record.scopeId || verified.resourceId !== record.resourceId) {
      return fail('attach-mismatch', 'scope/resource 不符')
    }
    if (verified.ownerId !== record.ownerId) return fail('owner-mismatch')
    if (verified.instanceGeneration !== permit.instanceGeneration) return fail('stale-generation', 'instanceGeneration 不符')
    if (verified.navigationGeneration !== record.navigationGeneration) return fail('stale-generation', 'navigationGeneration 不符')
    record.guest = { guestId: verified.guestId, permitId: permit.permitId, instanceGeneration: permit.instanceGeneration }
    permit.state = 'attached'
    permit.guestId = verified.guestId
    record.state = 'live'
    record.restoreStatus = 'loading'
    record.presentationReady = false
    record.idleSince = !record.mainDemand && !record.shelfDemand ? this.clock() : null
    this.diagnose(record, 'attached', verified.guestId)
    return { ok: true, guestId: verified.guestId, token: this.tokenOf(record) }
  }

  /** 只有匹配本代的 destroyed 证据才释放句柄并允许新代实例。 */
  recordDestroyed(input: DestroyedInput): Result<{ state: ResourceState }> {
    const resolved = this.resolve(input)
    if (isFailure(resolved)) return resolved
    const record = resolved
    if (!isSafeInt(input.instanceGeneration)) return fail('invalid')
    if (input.instanceGeneration !== record.instanceGeneration) {
      return fail('stale-generation', `evidence=${input.instanceGeneration} current=${record.instanceGeneration}`)
    }
    if (input.guestId !== undefined && record.guest && record.guest.guestId !== input.guestId) {
      return fail('attach-mismatch', 'guest 不符')
    }
    const wasSuspending = record.state === 'suspending'
    record.permit = null
    record.guest = null
    record.suspend = null
    record.presentationReady = false
    record.geometry = null
    record.idleSince = null
    if (record.state !== 'closed') record.state = wasSuspending ? 'sleeping' : 'metadataOnly'
    record.restoreStatus = record.mainDemand || record.shelfDemand ? 'queued' : 'idle'
    this.diagnose(record, wasSuspending ? 'destroyed-sleep' : 'destroyed', input.guestId)
    return { ok: true, state: record.state }
  }

  // ---- 版本化事件 -------------------------------------------------------

  recordGeometry(token: ResourceToken, input: GeometryInput): Result<{ geometryRevision: number }> {
    const resolved = this.resolveToken(token)
    if (isFailure(resolved)) return resolved
    const record = resolved
    if (!isPositiveInt(input.geometryRevision)) return fail('invalid')
    if (input.geometryRevision <= record.geometryRevision) {
      return fail('stale-geometry', `revision=${input.geometryRevision}<=${record.geometryRevision}`)
    }
    if (!isFinitePositive(input.width) || !isFinitePositive(input.height) || !isFinitePositive(input.dpr)) {
      return fail('invalid')
    }
    record.geometryRevision = input.geometryRevision
    record.geometry = { width: input.width, height: input.height, dpr: input.dpr }
    return { ok: true, geometryRevision: record.geometryRevision }
  }

  recordNavigation(token: ResourceToken, url: string): Result<{ token: ResourceToken; navigationGeneration: number }> {
    const resolved = this.resolveToken(token)
    if (isFailure(resolved)) return resolved
    if (!isBoundedWebUrl(url)) return fail('invalid', 'url 非法')
    const record = resolved
    record.navigationGeneration += 1
    record.protection = null
    record.lastRefusedProtectionRevision = null
    record.idleSince = record.state === 'live' && !record.mainDemand && !record.shelfDemand ? this.clock() : null
    record.lastUrl = url
    record.geometry = null
    record.presentationReady = false
    record.restoreStatus = 'loading'
    // URL 可能含登录凭据或敏感查询参数；诊断只记录导航发生。
    this.diagnose(record, 'navigate')
    return { ok: true, token: this.tokenOf(record), navigationGeneration: record.navigationGeneration }
  }

  recordReady(token: ResourceToken): Result<{ restoreStatus: RestoreStatus }> {
    const resolved = this.resolveToken(token)
    if (isFailure(resolved)) return resolved
    const record = resolved
    if (record.state !== 'live' || !record.guest) return fail('no-instance')
    record.restoreStatus = 'ready'
    return { ok: true, restoreStatus: 'ready' }
  }

  /** 首帧呈现证据；presentationReady 与 restoreStatus 相互独立。 */
  recordPresentationReady(token: ResourceToken, owner: 'main' | 'shelf'): Result<{ presentationReady: boolean }> {
    if (owner !== 'main' && owner !== 'shelf') return fail('invalid')
    const resolved = this.resolveToken(token)
    if (isFailure(resolved)) return resolved
    const record = resolved
    if (record.state !== 'live' || !record.guest) return fail('no-instance')
    if (record.restoreStatus !== 'ready') return fail('not-eligible', `restoreStatus=${record.restoreStatus}`)
    if (!record.geometry) return fail('stale-geometry', '几何未就绪')
    if (record.presentationOwner !== owner) return fail('owner-mismatch', `owner=${record.presentationOwner}`)
    record.presentationReady = true
    this.diagnose(record, 'presentation-ready', owner)
    return { ok: true, presentationReady: true }
  }

  recordRestoreFailed(token: ResourceToken, detail?: string): Result<{ restoreStatus: RestoreStatus }> {
    const resolved = this.resolveToken(token)
    if (isFailure(resolved)) return resolved
    const record = resolved
    record.restoreStatus = 'failed'
    record.presentationReady = false
    if (!record.guest) record.state = record.state === 'sleeping' ? 'sleeping' : 'metadataOnly'
    this.diagnose(record, 'restore-failed', detail)
    return { ok: true, restoreStatus: 'failed' }
  }

  // ---- 深睡保护与关闭事务 -------------------------------------------------

  reportProtection(input: ProtectionReport): Result<{ decision: ProtectionDecision }> {
    if (!isProtectionDecision(input.decision)) return fail('invalid')
    if (!isSmallString(input.providerId) || !isPositiveInt(input.revision)) return fail('invalid')
    if (!isSafeInt(input.instanceGeneration) || !isSafeInt(input.navigationGeneration)) return fail('invalid')
    if (input.reasonCodes !== undefined && (!Array.isArray(input.reasonCodes) || input.reasonCodes.length > MAX_BLOCK_REASONS)) {
      return fail('invalid')
    }
    const reasons: BlockReason[] = []
    for (const reason of input.reasonCodes ?? []) {
      // 只认自有键，拒绝未知原因与 prototype 键（`in` 会放过 toString/__proto__）。
      if (typeof reason !== 'string' || !BLOCK_REASON_KEYS.has(reason)) return fail('invalid', '未知保护原因')
      reasons.push(reason as BlockReason)
    }
    const resolved = this.resolve(input)
    if (isFailure(resolved)) return resolved
    const record = resolved
    // 保护结论只属于具体实例与导航代际；旧代际报告必须拒绝，不能写进当前代。
    if (
      input.instanceGeneration !== record.instanceGeneration ||
      input.navigationGeneration !== record.navigationGeneration
    ) {
      return fail('protection-stale', 'instance/navigation 代际不符')
    }
    // revision 必须严格递增：旧报告既不能覆盖新结论，也不能借写入刷新 checkedAt 延长 TTL。
    if (record.protection && input.revision <= record.protection.revision) {
      return fail('protection-stale', `revision=${input.revision}<=${record.protection.revision}`)
    }
    // safe 与 blocked 原因矛盾时按 blocked 处理：宁可保活。
    const decision: ProtectionDecision = input.decision === 'safe' && reasons.length > 0 ? 'blocked' : input.decision
    record.protection = {
      decision,
      providerId: input.providerId,
      revision: input.revision,
      checkedAt: this.clock(),
      instanceGeneration: input.instanceGeneration,
      navigationGeneration: input.navigationGeneration,
      reasonCodes: reasons
    }
    this.diagnose(record, `protection:${decision}`, `${input.providerId}#${input.revision}`)
    return { ok: true, decision }
  }

  evaluateSuspend(input: SuspendRequest): Result<SuspendEvaluation> {
    const resolved = this.resolve(input)
    if (isFailure(resolved)) return resolved
    const record = resolved
    const now = input.now ?? this.clock()
    const codes = this.suspendCodes(record, input.policyAllowed, input.restore, now)
    const idleForMs = record.idleSince === null ? null : now - record.idleSince
    return {
      ok: true,
      eligible: codes.length === 0,
      codes,
      idleForMs,
      idleLabel: idleForMs !== null && idleForMs >= this.idleLabelMs,
      state: record.state,
      presentationOwner: record.presentationOwner
    }
  }

  beginSuspend(input: SuspendRequest): Result<{ operation: SuspendOperation }> {
    const resolved = this.resolve(input)
    if (isFailure(resolved)) return resolved
    const record = resolved
    const now = input.now ?? this.clock()
    const codes = this.suspendCodes(record, input.policyAllowed, input.restore, now)
    if (codes.length > 0) {
      this.diagnose(record, 'suspend-rejected', codes.join(','))
      return fail(codes[0], codes.join(','))
    }
    const protection = record.protection
    if (!protection) return fail('protection-unknown')
    const operationId = this.createId()
    if (!isSmallString(operationId) || this.findSuspend(operationId)) return fail('invalid', 'operationId 非法或重复')
    const operation: SuspendOperation = {
      operationId,
      token: this.tokenOf(record),
      restore: sanitizeRestore(input.restore),
      protectionRevision: protection.revision
    }
    record.suspend = {
      operationId,
      token: operation.token,
      restore: operation.restore,
      protectionRevision: protection.revision,
      phase: 'saving',
      pendingDemand: false,
      closeTimedOut: false,
      createdAt: now
    }
    record.state = 'suspending'
    this.diagnose(record, 'suspend-begin', operationId)
    return { ok: true, operation }
  }

  /** 保存成功后的复检；任一项不匹配都回到 live，绝不提前关闭。 */
  commitSuspendSaved(operationId: string, input?: { now?: number }): Result<{ close: CloseRequest }> {
    const found = this.findSuspend(operationId)
    if (!found) return fail('stale-operation')
    const { record, suspend } = found
    if (suspend.phase !== 'saving') return fail('stale-operation', `phase=${suspend.phase}`)
    const now = input?.now ?? this.clock()
    const code = this.suspendRecheck(record, suspend, now)
    if (code) {
      this.keepAlive(record, code, '保存后复检失败，保留原实例')
      return fail(code, '保存后复检失败，已回到 live')
    }
    const guest = record.guest
    if (!guest) {
      record.suspend = null
      record.state = 'metadataOnly'
      record.restoreStatus = 'idle'
      return fail('no-instance')
    }
    suspend.phase = 'closing'
    if (record.permit) record.permit.state = 'closing'
    this.diagnose(record, 'close-requested', guest.guestId)
    return { ok: true, close: { operationId, guestId: guest.guestId, token: this.tokenOf(record) } }
  }

  abortSuspend(operationId: string, reason: 'save-failed' | 'cancelled' | 'policy-revoked'): Result<{ state: ResourceState }> {
    const found = this.findSuspend(operationId)
    if (!found) return fail('stale-operation')
    if (found.suspend.phase !== 'saving') {
      return fail('stale-operation', '关闭已发出，不能假定取消成功；等待原生证据')
    }
    const record = found.record
    this.keepAlive(record, reason === 'save-failed' ? 'save-failed' : 'recheck-failed', `abort:${reason}`)
    return { ok: true, state: record.state }
  }

  failClose(
    operationId: string,
    reason: 'close-refused' | 'close-timeout'
  ): Result<{ state: ResourceState; holdHandle?: boolean }> {
    const found = this.findSuspend(operationId)
    if (!found) return fail('stale-operation')
    const { record, suspend } = found
    if (suspend.phase !== 'closing') return fail('stale-operation', `phase=${suspend.phase}`)
    if (reason === 'close-refused') {
      record.lastRefusedProtectionRevision = suspend.protectionRevision
      this.keepAlive(record, 'close-refused', 'beforeunload 拒绝关闭，保留实例；同保护版本不再自动重试')
      return { ok: true, state: record.state }
    }
    suspend.closeTimedOut = true
    this.diagnose(record, 'close-timeout', '仍持有 guest 句柄，不变 sleeping，不发替代许可')
    return { ok: true, state: record.state, holdHandle: true }
  }

  /** 只有匹配本代实例的 destroyed 证据才能提交 sleeping。 */
  confirmSuspendDestroyed(operationId: string, evidence: DestroyedEvidence): Result<{ demandPending: boolean }> {
    const found = this.findSuspend(operationId)
    if (!found) return fail('stale-operation')
    const { record, suspend } = found
    if (suspend.phase !== 'closing') return fail('stale-operation', `phase=${suspend.phase}`)
    if (!evidence || evidence.resourceId !== record.resourceId) return fail('attach-mismatch', 'resource 不符')
    if (evidence.instanceGeneration !== record.instanceGeneration) return fail('stale-generation')
    if (evidence.guestId !== undefined && record.guest && evidence.guestId !== record.guest.guestId) {
      return fail('attach-mismatch', 'guest 不符')
    }
    const demandPending = record.mainDemand !== null || record.shelfDemand !== null
    record.suspend = null
    record.permit = null
    record.guest = null
    record.presentationReady = false
    record.geometry = null
    record.idleSince = null
    record.state = 'sleeping'
    record.restoreStatus = demandPending ? 'queued' : 'idle'
    this.diagnose(record, 'sleeping', demandPending ? 'destroyed 后已有新需求，等待新许可' : undefined)
    return { ok: true, demandPending }
  }

  /** 用户主动关闭与原所有者确认是独立命令；迟到结果不能复活。 */
  closeResource(input: ResourceInit & { reason?: 'user' | 'owner' }): Result<{ alreadyClosed: boolean }> {
    const resolved = this.resolve(input)
    if (isFailure(resolved)) return resolved
    const record = resolved
    if (record.state === 'closed') return { ok: true, alreadyClosed: true }
    record.demandRevision += 1
    record.mainDemand = null
    record.shelfDemand = null
    record.suspend = null
    // 已发出的创建仍可能附着；关闭意图不等于终止证据，继续占槽直到原生收尾。
    if (record.permit) record.permit.state = 'closing'
    record.presentationReady = false
    record.presentationOwner = 'none'
    record.geometry = null
    record.idleSince = null
    record.state = 'closed'
    record.restoreStatus = 'idle'
    this.diagnose(record, 'closed', input.reason ?? 'user')
    return { ok: true, alreadyClosed: false }
  }

  reopenResource(input: ResourceInit): Result<{ state: ResourceState }> {
    const resolved = this.resolve(input)
    if (isFailure(resolved)) return resolved
    const record = resolved
    if (record.state !== 'closed') return fail('invalid', `state=${record.state}`)
    if (record.guest || record.permit) return fail('instance-present', '旧实例销毁证据未到，拒绝恢复')
    record.demandRevision += 1
    record.state = 'metadataOnly'
    record.restoreStatus = 'idle'
    record.presentationReady = false
    record.presentationOwner = 'none'
    record.idleSince = null
    this.diagnose(record, 'reopened')
    return { ok: true, state: 'metadataOnly' }
  }

  /**
   * 显式遗忘一条已关闭记录，释放 100 记录预算。
   * 只接受「已关闭 + guest/permit 均已清空」的明确证据（即 recordDestroyed 之后），
   * 不做任何自动驱逐，live 与 unknown 许可仍占槽位。
   */
  forgetClosed(input: ResourceInit): Result<{ removed: boolean }> {
    const resolved = this.resolve(input)
    if (isFailure(resolved)) return resolved
    const record = resolved
    if (record.state !== 'closed') return fail('not-eligible', `state=${record.state}`)
    // 用户关闭时只清需求，句柄要等匹配的 destroyed 证据；未清空前删除会丢跟踪。
    if (record.guest || record.permit) return fail('instance-present', '实例句柄未清空，不能删除记录')
    this.records.delete(keyOf(record.scopeId, record.resourceId))
    this.diagnose(record, 'forgotten')
    return { ok: true, removed: true }
  }

  // ---- 统计与诊断 -------------------------------------------------------

  /** 电源/锁屏/宿主展示边界失效旧期限，不累计睡眠期间的五分钟。 */
  invalidateIdle(): void {
    for (const record of this.records.values()) {
      record.protection = null
      if (record.suspend?.phase === 'saving') this.keepAlive(record, 'recheck-failed', 'host-boundary')
      record.idleSince = record.state === 'live' && !record.mainDemand && !record.shelfDemand ? this.clock() : null
    }
  }

  stats(): LifecycleStats {
    const stats: LifecycleStats = {
      resources: this.records.size,
      metadataOnly: 0,
      live: 0,
      suspending: 0,
      sleeping: 0,
      restoring: 0,
      closed: 0,
      instances: 0,
      permits: 0,
      demands: 0
    }
    for (const record of this.records.values()) {
      stats[record.state] += 1
      if (record.guest) stats.instances += 1
      if (record.permit) stats.permits += 1
      if (record.mainDemand || record.shelfDemand) stats.demands += 1
    }
    return stats
  }

  diagnostics(): DiagnosticEntry[] {
    return this.events.map((entry) => ({ ...entry }))
  }

  // ---- 内部 -----------------------------------------------------------

  private ensure(input: ResourceInit): ResourceRecord | Failure {
    if (!isSmallString(input.scopeId) || !isSmallString(input.resourceId) || !isSmallString(input.ownerId)) {
      return fail('invalid', 'scopeId/resourceId/ownerId 必须是 <=512 的小型字符串')
    }
    const key = keyOf(input.scopeId, input.resourceId)
    const existing = this.records.get(key)
    if (existing) return existing.ownerId === input.ownerId ? existing : fail('owner-mismatch')
    if (this.records.size >= this.maxResources) return fail('limit-reached', `最多 ${this.maxResources} 个资源`)
    const record: ResourceRecord = {
      scopeId: input.scopeId,
      resourceId: input.resourceId,
      ownerId: input.ownerId,
      kind: 'web',
      state: 'metadataOnly',
      restoreStatus: 'idle',
      presentationReady: false,
      presentationOwner: 'none',
      instanceGeneration: 0,
      navigationGeneration: 0,
      demandRevision: 0,
      geometryRevision: 0,
      geometry: null,
      mainDemand: null,
      shelfDemand: null,
      permit: null,
      guest: null,
      protection: null,
      suspend: null,
      idleSince: null,
      lastUrl: null,
      lastRefusedProtectionRevision: null,
      createdAt: this.clock()
    }
    this.records.set(key, record)
    return record
  }

  private resolve(input: ResourceInit): ResourceRecord | Failure {
    if (!isSmallString(input.scopeId) || !isSmallString(input.resourceId) || !isSmallString(input.ownerId)) {
      return fail('invalid')
    }
    const record = this.records.get(keyOf(input.scopeId, input.resourceId))
    if (!record) return fail('not-found')
    return record.ownerId === input.ownerId ? record : fail('owner-mismatch')
  }

  private resolveToken(token: ResourceToken): ResourceRecord | Failure {
    if (!token || !isSmallString(token.scopeId) || !isSmallString(token.resourceId)) return fail('invalid')
    const record = this.records.get(keyOf(token.scopeId, token.resourceId))
    if (!record) return fail('not-found')
    if (!this.tokenMatches(token, record)) return fail('stale-token')
    return record
  }

  private tokenMatches(token: ResourceToken, record: ResourceRecord): boolean {
    return (
      token.instanceGeneration === record.instanceGeneration &&
      token.navigationGeneration === record.navigationGeneration &&
      token.demandRevision === record.demandRevision
    )
  }

  private tokenOf(record: ResourceRecord): ResourceToken {
    return {
      scopeId: record.scopeId,
      resourceId: record.resourceId,
      instanceGeneration: record.instanceGeneration,
      navigationGeneration: record.navigationGeneration,
      demandRevision: record.demandRevision
    }
  }

  private findPermit(permitId: string): { record: ResourceRecord; permit: PermitRecord } | null {
    if (!isSmallString(permitId)) return null
    for (const record of this.records.values()) {
      if (record.permit && record.permit.permitId === permitId) return { record, permit: record.permit }
    }
    return null
  }

  private findSuspend(operationId: string): { record: ResourceRecord; suspend: SuspendRecord } | null {
    if (!isSmallString(operationId)) return null
    for (const record of this.records.values()) {
      if (record.suspend && record.suspend.operationId === operationId) return { record, suspend: record.suspend }
    }
    return null
  }

  private onDemand(record: ResourceRecord, activated: boolean): void {
    if (activated) {
      record.idleSince = null
      if (record.state === 'metadataOnly' || record.state === 'sleeping') record.restoreStatus = 'queued'
      const suspend = record.suspend
      if (record.state === 'suspending' && suspend) {
        if (suspend.phase === 'saving') {
          this.keepAlive(record, 'demand-present', 'suspending 保存阶段收到新需求，撤销本次休眠')
        } else {
          suspend.pendingDemand = true
          this.diagnose(record, 'demand-during-close', '关闭已发出，不假定取消成功，等待原生证据')
        }
      }
    } else if (!record.mainDemand && !record.shelfDemand) {
      if (record.restoreStatus === 'queued') record.restoreStatus = 'idle'
      if (record.state === 'live') record.idleSince = this.clock()
    }
    this.refreshOwner(record)
  }

  private refreshOwner(record: ResourceRecord): void {
    const next: PresentationOwner =
      record.state === 'closed' ? 'none' : record.mainDemand ? 'main' : record.shelfDemand ? 'shelf' : 'none'
    if (record.presentationOwner !== next) {
      record.presentationOwner = next
      record.presentationReady = false
    }
  }

  private keepAlive(record: ResourceRecord, code: LifecycleCode, detail?: string): void {
    record.suspend = null
    if (record.guest) {
      record.state = 'live'
      if (record.permit && record.permit.state === 'closing') record.permit.state = 'attached'
    } else {
      record.state = 'metadataOnly'
      record.permit = null
    }
    this.diagnose(record, `keep-alive:${code}`, detail)
  }

  private suspendCodes(record: ResourceRecord, policyAllowed: boolean, restore: RestoreMetadata, now: number): LifecycleCode[] {
    const codes: LifecycleCode[] = []
    if (!this.safeCloseSupported && !this.verifyDiscardContract?.(this.tokenOf(record))) codes.push('unsupported-close')
    if (record.state !== 'live' || !record.guest) codes.push('not-eligible')
    if (record.kind !== 'web') codes.push('kind-unsupported')
    if (!policyAllowed) codes.push('policy-disabled')
    if (!isSafeRestore(record, restore)) codes.push('restore-unsafe')
    if (record.mainDemand || record.shelfDemand) codes.push('demand-present')
    const idleForMs = record.idleSince === null ? null : now - record.idleSince
    if (idleForMs === null || idleForMs < this.deepSleepAfterMs) codes.push('idle-short')
    const protection = record.protection
    if (!protection || protection.decision === 'unknown') {
      codes.push('protection-unknown')
    } else if (protection.decision === 'blocked') {
      codes.push('protection-blocked')
    } else {
      if (!this.providerIds.has(protection.providerId)) codes.push('protection-untrusted')
      if (
        protection.instanceGeneration !== record.instanceGeneration ||
        protection.navigationGeneration !== record.navigationGeneration
      ) {
        codes.push('protection-stale')
      }
      if (now - protection.checkedAt > this.protectionTtlMs) codes.push('protection-expired')
      for (const reason of protection.reasonCodes) codes.push(BLOCK_CODES[reason])
      if (record.lastRefusedProtectionRevision === protection.revision) codes.push('cooldown')
    }
    return codes
  }

  private suspendRecheck(record: ResourceRecord, suspend: SuspendRecord, now: number): LifecycleCode | null {
    if (record.state !== 'suspending' || record.suspend !== suspend) return 'stale-operation'
    if (!this.tokenMatches(suspend.token, record)) return 'stale-token'
    if (record.mainDemand || record.shelfDemand) return 'demand-present'
    const protection = record.protection
    if (!protection || protection.decision !== 'safe') {
      return protection?.decision === 'blocked' ? 'protection-blocked' : 'protection-unknown'
    }
    if (protection.revision !== suspend.protectionRevision) return 'protection-stale'
    if (!this.providerIds.has(protection.providerId)) return 'protection-untrusted'
    if (
      protection.instanceGeneration !== record.instanceGeneration ||
      protection.navigationGeneration !== record.navigationGeneration
    ) {
      return 'protection-stale'
    }
    if (now - protection.checkedAt > this.protectionTtlMs) return 'protection-expired'
    if (!this.safeCloseSupported && !this.verifyDiscardContract?.(this.tokenOf(record))) return 'unsupported-close'
    return null
  }

  private diagnose(record: ResourceRecord, event: string, detail?: string): void {
    const entry: DiagnosticEntry = {
      at: this.clock(),
      scopeId: record.scopeId,
      resourceId: record.resourceId,
      event: clampText(event)
    }
    if (detail !== undefined) entry.detail = clampText(detail)
    this.events.push(entry)
    if (this.events.length > MAX_DIAGNOSTICS) this.events.splice(0, this.events.length - MAX_DIAGNOSTICS)
  }
}
