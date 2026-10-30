/**
 * 终端输入控制权服务（main 侧唯一权威）
 *
 * 解决的问题：此前只有 `mcpLockCount` 与 renderer 输入锁在前面挡键盘，谁拿到 connector
 * 谁就能写；没有「谁拥有这个会话的输入」这层事实，也没有代际，因此人工接管后旧队列
 * 仍然能落地。本服务给出一个**小型、可调用**的租约服务：
 *
 *   - 同一 session 至多一个有效租约；身份由 main 调用方注入（绝不信任请求体）。
 *   - 每个真实 connector 由 main 生成 `connectionInstanceId` 并 `bindSession` 登记；
 *     换连接 ⇒ 旧租约立即失效（旧 handle 的 assertInput 直接抛）。
 *   - 每次取得租约都分配更大的 `epoch`；取得失败也消耗一个值，绝不复用。
 *   - fence 更新（装到宿主/直连 PTY）**串行**执行；`acquire`/`renew` 只有在执行边界
 *     确认之后才返回，失败就不发租约（fail closed）。
 *   - `assertInput` 是写入前的唯一断言：等串行链落地 → 复核租约/连接代际/expiry/凭据。
 *
 * 本服务**从不发送任何按键**（不清理命令行、不补回车、不自动重试/重放）。
 */

import { randomUUID } from 'crypto'
import {
  CONTROL_LEASE_DEFAULT_TTL_MS,
  CONTROL_LEASE_MAX_TTL_MS,
  InputControlError,
  asInputControlError,
  fenceOf,
  isBoundedId,
  isControlHandle,
  isControllerIdentity,
  sameLease,
  type ControlHandle,
  type ControlSnapshot,
  type ControllerIdentity,
  type InputFence
} from '@shared/terminal-control'

/**
 * 把 fence 装到实际执行边界：`null` = 撤销（宿主清空并推进代际）。
 * 必须 resolve 才算安装成功；reject（含超时）⇒ 服务不发放租约。
 */
export type FenceHandler = (sessionId: string, fence: InputFence | null) => Promise<void>

export interface InputControlServiceDeps {
  /** 可注入时钟（测试）。默认 Date.now。 */
  now?: () => number
  /** 执行边界安装器；也可在构造后 setFenceHandler 补装。 */
  onFence?: FenceHandler
  /** 当前凭据是否仍然有效；返回 false 视为已撤销。缺省视为有效。 */
  isCredentialCurrent?: (identity: ControllerIdentity) => boolean
  /** 本 main 实例身份；默认 randomUUID()。main 重启即变。 */
  controllerInstanceId?: string
  /** 租约默认有效期（毫秒）。 */
  leaseTtlMs?: number
  /** 随机 id 源（测试）。默认 randomUUID。 */
  newId?: () => string
  /** 撤销时 fence 清理失败的观测点（不改变 fail closed 语义）。 */
  onError?: (error: unknown, context: { sessionId: string; operation: 'clear' | 'install' }) => void
}

export interface AcquireRequest {
  sessionId: string
  /** main 注入的可信身份。 */
  identity: ControllerIdentity
  /**
   * 自动化必须显式携带的用户上下文确认（由 GUI 真实确认后由 main 传入）。
   * `source === 'automation'` 时必须是 true，否则拒绝。
   */
  contextConfirmed?: boolean
  /** 仅 GUI：显式接管，先撤销旧租约再取得。自动化不允许。 */
  takeover?: boolean
}

interface LeaseRecord {
  leaseId: string
  epoch: number
  issuedAt: number
  expiresAt: number
  identity: ControllerIdentity
}

interface SessionState {
  /** null = 已 unbind，但保留 lastEpoch 让代际继续单调。 */
  connectionInstanceId: string | null
  generation: number
  lease: LeaseRecord | null
  /** 已分配的最大 epoch（含失败消耗）。 */
  lastEpoch: number
  /** 执行边界确认过、当前生效的 fence。 */
  installedFence: InputFence | null
  /** 撤销时 fence 清理失败：在重新清干净之前不再发放新租约。 */
  fenceDirty: boolean
  revision: number
  pendingPrincipalId?: string
}

const DEFAULT_LEASE_TTL_MS = CONTROL_LEASE_DEFAULT_TTL_MS

/** 读请求形状时只认这五种 source（内部类型已收窄，这里防运行时伪造）。 */
function copyIdentity(identity: ControllerIdentity): ControllerIdentity {
  return {
    principalId: identity.principalId,
    source: identity.source,
    ...(identity.credentialId === undefined ? {} : { credentialId: identity.credentialId })
  }
}

export class InputControlService {
  private lastEpoch = 0
  private readonly states = new Map<string, SessionState>()
  private readonly nowMs: () => number
  private readonly newId: () => string
  private readonly leaseTtlMs: number
  private readonly onError?: InputControlServiceDeps['onError']
  private readonly controllerInstanceId: string
  private fenceHandler: FenceHandler | null
  private credentialValidator: ((identity: ControllerIdentity) => boolean) | null

  /** fence 变更的单条串行链；任何 reject 都被吞掉，链本身永不失败。 */
  private chain: Promise<void> = Promise.resolve()

  constructor(deps: InputControlServiceDeps = {}) {
    this.nowMs = deps.now ?? Date.now
    this.newId = deps.newId ?? randomUUID
    const ttl = deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS
    this.leaseTtlMs = Number.isFinite(ttl) ? Math.max(1, Math.min(Math.floor(ttl), CONTROL_LEASE_MAX_TTL_MS)) : DEFAULT_LEASE_TTL_MS
    this.onError = deps.onError
    this.controllerInstanceId = deps.controllerInstanceId ?? randomUUID()
    this.fenceHandler = deps.onFence ?? null
    this.credentialValidator = deps.isCredentialCurrent ?? null
  }

  get controllerId(): string {
    return this.controllerInstanceId
  }

  /** 后置注入执行边界（Codex 在构造完 connector 之后接）。 */
  setFenceHandler(handler: FenceHandler | null): void {
    this.fenceHandler = handler
  }

  setCredentialValidator(validator: ((identity: ControllerIdentity) => boolean) | null): void {
    this.credentialValidator = validator
  }

  // ── 连接登记 ────────────────────────────────────────────────────────────

  /**
   * main 为每个真实 connector 登记连接实例。
   * `connectionInstanceId` 变化 ⇒ 立即撤销旧租约并推进 generation，旧 fence 后台清掉
   * （串行链保证：下一次 acquire 一定在清理之后执行）。
   */
  bindSession(sessionId: string, connectionInstanceId: string): number {
    if (!isBoundedId(sessionId) || !isBoundedId(connectionInstanceId)) {
      throw new InputControlError('invalid-input', 'sessionId and connectionInstanceId must be bounded ids')
    }
    const state = this.states.get(sessionId)
    if (!state) {
      this.states.set(sessionId, {
        connectionInstanceId,
        generation: 1,
        lease: null,
        lastEpoch: 0,
        installedFence: null,
        fenceDirty: false,
        revision: 0
      })
      return 1
    }
    if (state.connectionInstanceId === connectionInstanceId) return state.generation
    const hadFence = state.installedFence !== null
    state.connectionInstanceId = connectionInstanceId
    state.revision++
    state.generation += 1
    state.lease = null
    state.installedFence = null
    if (hadFence) void this.enqueue(() => this.clearFence(sessionId, state))
    return state.generation
  }

  /** 连接结束：撤销租约并清 fence（保留 lastEpoch，使代际继续单调）。 */
  async unbindSession(sessionId: string): Promise<void> {
    const state = this.states.get(sessionId)
    if (!state) return
    const hadFence = state.installedFence !== null
    state.connectionInstanceId = null
    state.revision++
    state.generation += 1
    state.lease = null
    state.installedFence = null
    if (hadFence) await this.enqueue(() => this.clearFence(sessionId, state))
  }

  // ── 租约 ────────────────────────────────────────────────────────────────

  /**
   * 取得输入控制权。同一 session 至多一个有效控制者：
   *   - 同一持有者重复取得 ⇒ 返回当前句柄（不涨 epoch、不自动续期）；
   *   - 他人持有：GUI 需显式 `takeover:true`（先撤销），自动化一律拒绝；
   *   - 自动化必须 `contextConfirmed === true`（main 传入的用户确认事实）。
   *
   * 返回前 fence 已在执行边界安装并确认；安装失败 ⇒ 抛错且不发放租约。
   */
  async acquire(request: AcquireRequest): Promise<ControlHandle> {
    if (!request || typeof request !== 'object') throw new InputControlError('invalid-input')
    const { sessionId } = request
    if (!isBoundedId(sessionId)) throw new InputControlError('invalid-input', 'sessionId must be a bounded id')
    if (!isControllerIdentity(request.identity)) throw new InputControlError('invalid-input', 'identity is not a valid controller identity')
    const identity = copyIdentity(request.identity)
    if (identity.source === 'automation' && request.contextConfirmed !== true) {
      throw new InputControlError('context-not-confirmed')
    }
    if (identity.source === 'automation' && request.takeover === true) {
      throw new InputControlError('automation-takeover-denied')
    }

    return this.enqueue(async () => {
      const state = this.requireState(sessionId)
      state.pendingPrincipalId = identity.principalId
      try {
      const now = this.nowMs()
      const revision = state.revision
      const connection = state.connectionInstanceId

      const current = state.lease
      if (current) {
        if (!(now < current.expiresAt)) {
          // 过期租约：先撤销（清 fence），再按新租约发放；不静默续期。
          state.lease = null
          state.installedFence = null
          await this.clearFence(sessionId, state)
        } else if (this.isSameHolder(current, identity)) {
          this.assertCredentialCurrent(current)
          return this.toHandle(sessionId, state, current)
        } else if (request.takeover !== true || identity.source !== 'gui') {
          // 接管只能由 GUI 的显式操作发起；automation/internal 不得抢占。
          throw new InputControlError('held-by-other')
        } else {
          // GUI 显式接管：旧租约在这里失效，旧 handle 之后的 assertInput 必然失败。
          state.lease = null
          state.installedFence = null
          await this.clearFence(sessionId, state)
        }
      }

      if (state.fenceDirty) {
        // 上次撤销没清干净：先重试清理；仍失败则宁可不发租约。
        await this.clearFenceStrict(sessionId, state)
      }

      const epoch = Math.max(state.lastEpoch + 1, ++this.lastEpoch)
      this.lastEpoch = epoch
      // 失败也消耗：绝不复用已被拒绝/撤销的代际。
      state.lastEpoch = epoch
      const lease: LeaseRecord = {
        leaseId: this.newId(),
        epoch,
        issuedAt: now,
        expiresAt: now + this.leaseTtlMs,
        identity
      }
      if (state.revision !== revision || state.connectionInstanceId !== connection) throw new InputControlError('connection-replaced')
      this.assertCredentialCurrent(lease)
      const fence = this.fenceFor(state, lease)
      try {
        await this.installFence(sessionId, fence)
        if (state.revision !== revision || state.connectionInstanceId !== connection) throw new InputControlError('lease-revoked')
        this.assertCredentialCurrent(lease)
        if (!(this.nowMs() < lease.expiresAt)) throw new InputControlError('lease-expired')
      } catch (error) {
        state.lease = null
        state.installedFence = null
        await this.clearFence(sessionId, state)
        throw error
      }
      state.lease = lease
      state.installedFence = fence
      state.fenceDirty = false
      return this.toHandle(sessionId, state, lease)
      } finally { state.pendingPrincipalId = undefined }
    })
  }

  /**
   * 续期：只延长 `expiresAt`，`epoch`/`leaseId` 不变（客户端不能靠续期改代际）。
   * 过期/被撤销/换了连接一律失败；续期同样要在执行边界确认（宿主侧按“同代际续期”接受）。
   */
  async renew(handle: ControlHandle): Promise<ControlHandle> {
    if (!isControlHandle(handle)) throw new InputControlError('invalid-input', 'renew requires a control handle')
    return this.enqueue(async () => {
      const state = this.requireState(handle.sessionId)
      const lease = state.lease
      if (!lease) throw new InputControlError('lease-revoked')
      const revision = state.revision
      if (handle.controllerInstanceId !== this.controllerInstanceId || !this.isSameHolder(lease, handle)) throw new InputControlError('not-holder')
      if (lease.leaseId !== handle.leaseId || lease.epoch !== handle.epoch) throw new InputControlError('not-holder')
      if (state.connectionInstanceId !== handle.connectionInstanceId) throw new InputControlError('connection-replaced')
      const now = this.nowMs()
      if (!(now < lease.expiresAt)) throw new InputControlError('lease-expired')
      this.assertCredentialCurrent(lease)
      const capped = now + this.leaseTtlMs
      if (!(now < capped)) throw new InputControlError('lease-expired', 'The lease lifetime limit was reached; a new lease is required')
      const renewed: LeaseRecord = { ...lease, expiresAt: capped }
      const fence = this.fenceFor(state, renewed)
      try {
        await this.installFence(handle.sessionId, fence)
        if (state.revision !== revision || state.lease !== lease || state.connectionInstanceId !== handle.connectionInstanceId) throw new InputControlError('lease-revoked')
        this.assertCredentialCurrent(renewed)
      } catch (error) {
        state.lease = null
        state.installedFence = null
        await this.clearFence(handle.sessionId, state)
        throw error
      }
      state.lease = renewed
      state.installedFence = fence
      state.fenceDirty = false
      return this.toHandle(handle.sessionId, state, renewed)
    })
  }

  /** 释放：撤销租约并清 fence。已释放 ⇒ 幂等成功；不是当前租约 ⇒ 失败。 */
  async release(handle: ControlHandle): Promise<void> {
    if (!isControlHandle(handle)) throw new InputControlError('invalid-input', 'release requires a control handle')
    return this.enqueue(async () => {
      const state = this.states.get(handle.sessionId)
      if (!state) return
      const lease = state.lease
      if (!lease) return
      if (handle.controllerInstanceId !== this.controllerInstanceId || !this.isSameHolder(lease, handle)) throw new InputControlError('not-holder')
      if (lease.leaseId !== handle.leaseId || lease.epoch !== handle.epoch) throw new InputControlError('not-holder')
      state.lease = null
      state.installedFence = null
      await this.clearFence(handle.sessionId, state)
    })
  }

  /**
   * 写入前的唯一断言。**必须**在 `connector.write(data, fence)` 之前 await：
   *   - 先等串行链落地（在途撤销/接管已生效）；
   *   - 再复核 租约 / 连接代际 / epoch / expiresAt / 当前凭据；
   *   - 返回应随写入携带的 fence（宿主会再核对一次）。
   * 任何不满足都抛 InputControlError；调用方**不得**在拒绝后自动重取租约并重放。
   */
  async assertInput(handle: ControlHandle): Promise<InputFence> {
    if (!isControlHandle(handle)) throw new InputControlError('invalid-input', 'assertInput requires a control handle')
    await this.chain
    const state = this.states.get(handle.sessionId)
    if (!state) throw new InputControlError('session-not-bound')
    // 先看连接代际：换了连接时，说「连接已替换」比笼统的「租约被撤销」更有诊断价值。
    if (state.connectionInstanceId === null) throw new InputControlError('lease-revoked', 'The session connection is closed')
    if (state.connectionInstanceId !== handle.connectionInstanceId) throw new InputControlError('connection-replaced')
    const lease = state.lease
    if (!lease) throw new InputControlError('lease-revoked')
    if (lease.leaseId !== handle.leaseId || lease.epoch !== handle.epoch) throw new InputControlError('not-holder')
    if (lease.identity.principalId !== handle.principalId) throw new InputControlError('not-holder')
    const now = this.nowMs()
    if (!(now < lease.expiresAt)) throw new InputControlError('lease-expired')
    this.assertCredentialCurrent(lease)
    if (state.fenceDirty) throw new InputControlError('fence-not-installed')
    const installed = state.installedFence
    if (!installed || !sameLease(installed, this.fenceFor(state, lease))) {
      throw new InputControlError('fence-not-installed')
    }
    if (!(now < installed.expiresAt)) throw new InputControlError('lease-expired')
    return fenceOf(installed)
  }

  // ── 撤销 ────────────────────────────────────────────────────────────────

  /** 凭据撤销/登出：该主体的全部租约失效。 */
  async invalidatePrincipal(principalId: string): Promise<void> {
    if (!isBoundedId(principalId)) throw new InputControlError('invalid-input', 'principalId must be a bounded id')
    const targets = [...this.states.entries()].filter(([, state]) => state.lease?.identity.principalId === principalId || state.pendingPrincipalId === principalId)
    for (const [, state] of targets) {
      state.revision++
      state.lease = null
      state.installedFence = null
    }
    for (const [sessionId, state] of targets) await this.enqueue(() => this.clearFence(sessionId, state))
  }

  /** 单会话撤权（删除会话、人工关闭控制等）。 */
  async invalidateSession(sessionId: string): Promise<void> {
    if (!isBoundedId(sessionId)) throw new InputControlError('invalid-input', 'sessionId must be a bounded id')
    const state = this.states.get(sessionId)
    if (!state) return
    state.revision++
    state.lease = null
    state.installedFence = null
    await this.enqueue(() => this.clearFence(sessionId, state))
  }

  /** 全部撤销（main 退出/重置）。 */
  async invalidateAll(): Promise<void> {
    const targets = [...this.states.entries()]
    for (const [, state] of targets) {
      state.revision++
      state.lease = null
      state.installedFence = null
    }
    for (const [sessionId, state] of targets) await this.enqueue(() => this.clearFence(sessionId, state))
  }

  // ── 只读快照 ────────────────────────────────────────────────────────────

  /** 删除已断开的会话记录；所有后续新连接使用全局递增 epoch。 */
  async forgetSession(sessionId: string): Promise<void> {
    await this.unbindSession(sessionId)
    await this.chain
    if (this.states.get(sessionId)?.connectionInstanceId === null) this.states.delete(sessionId)
  }

  currentSnapshot(sessionId: string): ControlSnapshot | null {
    const state = this.states.get(sessionId)
    if (!state) return null
    const lease = state.lease
    return {
      sessionId,
      connectionInstanceId: state.connectionInstanceId,
      controllerInstanceId: this.controllerInstanceId,
      generation: state.generation,
      lease: lease
        ? {
            leaseId: lease.leaseId,
            epoch: lease.epoch,
            issuedAt: lease.issuedAt,
            expiresAt: lease.expiresAt,
            principalId: lease.identity.principalId,
            ...(lease.identity.credentialId === undefined ? {} : { credentialId: lease.identity.credentialId }),
            source: lease.identity.source
          }
        : null
    }
  }

  /** 诊断用：不含任何凭据值。 */
  snapshots(): ControlSnapshot[] {
    return [...this.states.keys()].map((sessionId) => this.currentSnapshot(sessionId)).filter((snapshot): snapshot is ControlSnapshot => snapshot !== null)
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  /** 单条串行链：所有 fence 变更按调用顺序落地。任务自身失败不影响后续任务。 */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task)
    this.chain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private requireState(sessionId: string): SessionState {
    const state = this.states.get(sessionId)
    if (!state) throw new InputControlError('session-not-bound')
    if (state.connectionInstanceId === null) throw new InputControlError('session-not-bound', 'The session connection is not bound')
    return state
  }

  private fenceFor(state: SessionState, lease: LeaseRecord): InputFence {
    const connectionInstanceId = state.connectionInstanceId
    if (connectionInstanceId === null) throw new InputControlError('connection-replaced')
    return {
      epoch: lease.epoch,
      connectionInstanceId,
      controllerInstanceId: this.controllerInstanceId,
      leaseId: lease.leaseId,
      expiresAt: lease.expiresAt
    }
  }

  private toHandle(sessionId: string, state: SessionState, lease: LeaseRecord): ControlHandle {
    return Object.freeze({
      ...this.fenceFor(state, lease),
      sessionId,
      principalId: lease.identity.principalId,
      ...(lease.identity.credentialId === undefined ? {} : { credentialId: lease.identity.credentialId }),
      source: lease.identity.source,
      issuedAt: lease.issuedAt
    }) as ControlHandle
  }

  private isSameHolder(lease: LeaseRecord, identity: ControllerIdentity): boolean {
    return (
      lease.identity.principalId === identity.principalId &&
      lease.identity.source === identity.source &&
      lease.identity.credentialId === identity.credentialId
    )
  }

  private assertCredentialCurrent(lease: LeaseRecord): void {
    const validator = this.credentialValidator
    if (!validator) return
    let current = false
    try {
      current = validator(lease.identity) === true
    } catch {
      current = false
    }
    if (!current) throw new InputControlError('credential-revoked')
  }

  /** 安装 fence：失败 ⇒ 抛错（调用方据此不发租约）。 */
  private async installFence(sessionId: string, fence: InputFence): Promise<void> {
    const handler = this.fenceHandler
    if (!handler) {
      throw new InputControlError('fence-install-failed', 'No input fence handler is installed; refusing to issue a lease')
    }
    try {
      await handler(sessionId, fence)
    } catch (error) {
      this.onError?.(error, { sessionId, operation: 'install' })
      throw asInputControlError(error, 'fence-install-failed')
    }
  }

  /**
   * 撤销 fence：权限判定已经在本进程完成（租约已清），这里尽力把执行边界也清干净。
   * 清不掉就记 `fenceDirty`，后续 acquire 必须先把脏 fence 清掉才发放（fail closed）。
   */
  private async clearFence(sessionId: string, state: SessionState): Promise<void> {
    const handler = this.fenceHandler
    if (!handler) {
      state.fenceDirty = false
      return
    }
    try {
      await handler(sessionId, null)
      state.fenceDirty = false
    } catch (error) {
      state.fenceDirty = true
      this.onError?.(error, { sessionId, operation: 'clear' })
    }
  }

  /** 脏 fence 的严格清理：清不掉就不允许发放新租约。 */
  private async clearFenceStrict(sessionId: string, state: SessionState): Promise<void> {
    const handler = this.fenceHandler
    if (!handler) {
      state.fenceDirty = false
      return
    }
    try {
      await handler(sessionId, null)
      state.fenceDirty = false
    } catch (error) {
      this.onError?.(error, { sessionId, operation: 'clear' })
      throw asInputControlError(error, 'fence-not-installed')
    }
  }
}
