/**
 * Pet 托管控制服务（LyShell 主进程侧）—— 授权、准入与状态机。
 *
 * 分界（docs/petlink-shared-harness.md（v3））：
 *   - 本模块：谁在控制（真实 host token 归属 + 插件启用态 + 绑定 + 代际）、Pet 单活动任务、
 *     有界事件与工作输出、快照、错误分类、变更准入串行；
 *   - dsh 桥（resources/dsh-bridge/index.mjs）：真实执行（官方服务调用、Pet 原生审批、真实 turn/end）。
 * 本模块**不重写 agent loop**，也**不自己造终态**：终态只来自桥上报的真实 turn/end。
 *
 * 凭据边界：只说 pluginId/pluginInstanceId；token 明文绝不进本模块、快照、事件或日志。
 */

import { randomUUID } from 'crypto'
import log from 'electron-log'
import {
  EXCLUSIVE_EVENT_BUFFER_LIMIT,
  EXCLUSIVE_TRANSCRIPT_LIMIT,
  EXCLUSIVE_TRANSCRIPT_TEXT_LIMIT,
  isControllerPluginId,
  type ExclusiveApprovalOutcome,
  type ExclusiveApprovalView,
  type ExclusiveBindingView,
  type ExclusiveControlEvent,
  type ExclusiveControlEventType,
  type ExclusiveControlSnapshot,
  type ExclusiveErrorCode,
  type ExclusiveEventBatch,
  type ExclusiveTaskView,
  type ExclusiveTranscriptEntry,
  type ExclusiveViewerState
} from '@shared/exclusive-control'

/** 桥命令的结果（成功时可能带回实例身份/任务/会话/审批列表/工作输出/工作台查看器状态）。 */
export interface ExclusiveBridgeOutcome {
  diagnostic?: import('@shared/exclusive-control').ExclusiveDiagnostic
  ok: boolean
  code?: ExclusiveErrorCode
  error?: string
  identity?: { instanceId: string; instanceEpoch: number }
  task?: ExclusiveTaskView | null
  sessionId?: string
  approval?: ExclusiveApprovalOutcome
  /** 桥侧全部待答原生审批（并发审批；消失的由同步自动清理） */
  approvals?: ExclusiveApprovalView[]
  /** 桥侧是否仍持有独占 */
  holding?: boolean
  /** 官方 Web 是否有任务在跑（桥读到的真实状态） */
  webBusy?: boolean
  /** 新增工作输出（有界；桥只回新增部分） */
  transcript?: ExclusiveTranscriptEntry[]
  /** 工作台查看器状态（S4：官方页面当前会话 / 未落地导航请求 / 最近一次真实 ack） */
  viewer?: ExclusiveViewerState
}

export type ExclusiveBridgeCommand =
  | { cmd: 'acquire'; epoch: number; bindingId: string }
  | { cmd: 'release'; epoch: number }
  | { cmd: 'snapshot' }
  | { cmd: 'submit'; epoch: number; taskId: string; sessionId: string; text: string }
  | { cmd: 'cancel'; epoch: number; taskId: string }
  | { cmd: 'approve'; epoch: number; approvalId: string; outcome: ExclusiveApprovalOutcome }
  | { cmd: 'session'; epoch: number; mode: 'new' | 'select'; sessionId?: string }
  /** 共享工作台导航：冻结 viewer/session/epoch/revision 下发；更旧的 revision 由桥拒绝 */
  | { cmd: 'viewer-nav'; epoch: number; revision: number; requestId: string; sessionId: string }

/** 受控后台的一次租约（S2 DshWebManager 的 acquire/release 语义：只解绑，绝不 kill）。 */
export interface ExclusiveBackendLease {
  bindingId: string
  release: () => void
}

export interface ExclusiveControlDeps {
  /**
   * 把一条命令送到 dsh 桥并等结果。桥不可达/超时必须返回 bridge/unavailable 或 bridge/timeout，
   * **绝不**本地兜底（不 local fallback、不盲重发）。
   */
  runBridge: (command: ExclusiveBridgeCommand) => Promise<ExclusiveBridgeOutcome>
  /** 当前受控 dsh 实例身份（未就绪时 null） */
  currentInstance: () => { instanceId: string; instanceEpoch: number } | null
  /**
   * 插件**启用态**判定（真实来源：pluginRepository）。真实状态由调用方读生命周期，
   * **不采信**请求体自报的 enabled。
   */
  isPluginEnabled: (pluginId: string) => boolean
  /**
   * 复用/首次启动 S2 后台并拿一条租约（不自动 restart、不另建后台）。
   * 失败返回 null —— 本次 acquire 到此为止，绝不在没有后台的情况下继续。
   */
  acquireBackend?: (bindingId: string) => Promise<ExclusiveBackendLease | null>
  now?: () => number
}

export type ExclusiveOk<T> = { ok: true } & T
export type ExclusiveFail = { ok: false; code: ExclusiveErrorCode; error: string; snapshot?: ExclusiveControlSnapshot }
export type ExclusiveResult<T> = ExclusiveOk<T> | ExclusiveFail

type ExclusiveEventInput = Omit<ExclusiveControlEvent, 'seq' | 'at'> & { at?: number }

/** 凭据层鉴权用的最小事实（来自 mcpAuth.resolveToken 的 TokenBinding）。 */
export interface ExclusiveAuthFacts {
  kind: string
  pluginId?: string
  tokenSource?: 'host' | 'ui'
}

/** 凭据层鉴权失败分类（调用方据此回 401/403）。 */
export type ExclusiveAuthFailure = 'auth/invalid-token' | 'auth/impersonation' | 'auth/not-enabled'

export class ExclusiveControlService {
  private readonly deps: ExclusiveControlDeps
  /** 当前绑定；null = free（官方 Web 写操作放行） */
  private binding: ExclusiveBindingView | null = null
  private phase: ExclusiveControlSnapshot['phase'] = 'free'
  private epochCounter = 0
  private activeTask: ExclusiveTaskView | null = null
  /** 待答原生审批（approvalId → view）；并发审批各占一条 */
  private readonly approvals = new Map<string, ExclusiveApprovalView>()
  private readonly events: ExclusiveControlEvent[] = []
  private readonly transcript: ExclusiveTranscriptEntry[] = []
  private eventSeq = 0
  /** 本次绑定的后台租约（release/revoke 时解绑，绝不 kill） */
  private lease: ExclusiveBackendLease | null = null
  /** 工作台查看器状态（S4；随绑定失效清空） */
  private viewer: ExclusiveViewerState | null = null
  /** 查看器导航的串行链（与任务准入分离：长任务不得阻塞工作台导航） */
  private viewerTail: Promise<unknown> = Promise.resolve()
  /** 变更准入串行链：acquire/release/submit/cancel/session 一次只有一条在飞 */
  private admitTail: Promise<unknown> = Promise.resolve()
  /** 撤销中的换代标记：撤销后旧请求一律拒绝，且在飞 acquire 不得复活 */
  private revokedEpoch = 0
  /** 最近一次**分配**出去的代际（绑定可能还没登记；撤销据此让在飞 acquire 失效） */
  private lastAllocatedEpoch = 0

  constructor(deps: ExclusiveControlDeps) {
    this.deps = deps
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  /**
   * 变更准入：把一次变更排进唯一串行链。
   * 读路径（snapshot/events）与审批回答不进链 —— 长任务不得阻塞展示与回答。
   * 链自身吞掉失败，避免一次拒绝毒死后续准入。
   */
  private admit<T>(task: () => Promise<T>): Promise<T> {
    const run = this.admitTail.then(task, task)
    this.admitTail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private snapshot(webBusy = false): ExclusiveControlSnapshot {
    const approvals = [...this.approvals.values()].map((view) => ({ ...view }))
    return {
      phase: this.phase,
      binding: this.binding ? { ...this.binding } : null,
      activeTask: this.activeTask ? { ...this.activeTask } : null,
      pendingApproval: approvals.length > 0 ? approvals[0] : null,
      approvals,
      transcript: this.transcript.map((entry) => ({ ...entry })),
      lastEventSeq: this.eventSeq,
      webBusy,
      ...(this.viewer === null
        ? {}
        : { viewer: { ...this.viewer, request: this.viewer.request ? { ...this.viewer.request } : null, lastAck: this.viewer.lastAck ? { ...this.viewer.lastAck } : null } })
    }
  }

  /** 控制状态快照 —— S4/S5 共享工作台直接消费（无凭据）。 */
  getSnapshot(): ExclusiveControlSnapshot {
    return this.snapshot()
  }

  get isHeld(): boolean {
    return this.phase === 'held' && this.binding !== null
  }

  /** 是否处于「已撤销、等桥确认」状态（S4 只读显示用；此期间 Pet 绑定仍待确认；Web 继续可操作）。 */
  get isReleasing(): boolean {
    return this.phase === 'releasing'
  }

  /**
   * 凭据层鉴权：只认**受控插件自己的 host token**。
   *   - kind 必须是 plugin；
   *   - tokenSource 必须是 host（UI token 是界面视图凭据，不可冒充控制面）；
   *   - pluginId 必须是受控 PetLink 插件（其他插件、global/session 一律拒绝）；
   *   - 该插件当前必须处于启用态（真实读仓库）。
   * 身份全部来自 auth binding，**不采信**请求体。
   */
  authorize(facts: ExclusiveAuthFacts): { ok: true } | { ok: false; code: ExclusiveAuthFailure; error: string } {
    if (facts.kind !== 'plugin' || !facts.pluginId) {
      return {
        ok: false,
        code: 'auth/impersonation',
        error: `exclusive control requires the PetLink plugin host credential (got ${facts.kind})`
      }
    }
    if (facts.tokenSource !== 'host') {
      return { ok: false, code: 'auth/impersonation', error: 'UI credentials cannot drive exclusive control' }
    }
    if (!isControllerPluginId(facts.pluginId)) {
      return { ok: false, code: 'auth/impersonation', error: 'this plugin is not the PetLink controller' }
    }
    if (!this.deps.isPluginEnabled(facts.pluginId)) {
      return { ok: false, code: 'auth/not-enabled', error: 'the PetLink plugin is not enabled' }
    }
    return { ok: true }
  }

  /** 只读快照是否允许该凭据读：任一已鉴权凭据都可读（不含凭据），但 UI/global 不获得写能力。 */
  canReadSnapshot(_facts: ExclusiveAuthFacts): boolean {
    void _facts
    return true
  }

  // ========== 事件与工作输出（有界） ==========

  private pushEvent(input: ExclusiveEventInput): ExclusiveControlEvent {
    const event: ExclusiveControlEvent = { ...input, seq: ++this.eventSeq, at: input.at ?? this.now() }
    this.events.push(event)
    if (this.events.length > EXCLUSIVE_EVENT_BUFFER_LIMIT) {
      this.events.splice(0, this.events.length - EXCLUSIVE_EVENT_BUFFER_LIMIT)
    }
    return event
  }

  /**
   * 从 `since` 之后拉事件。游标太旧（已被有界缓冲丢弃）⇒ `gap: true`，
   * 调用方必须用 snapshot 重新对齐，**不得**盲目重发任务。
   */
  getEvents(since: number, limit: number, webBusy = false): ExclusiveEventBatch {
    const oldest = this.events.length > 0 ? this.events[0].seq : this.eventSeq + 1
    const gap = since < oldest - 1
    const events = this.events.filter((e) => e.seq > since).slice(0, limit)
    return { events, lastEventSeq: this.eventSeq, gap, snapshot: this.snapshot(webBusy) }
  }

  // ========== 控制权 ==========

  /**
   * 取得Pet 托管控制。**一次完整授权**：不做能力细分。
   * 流程：启用态核对 → 复用/首次启动 S2 后台拿租约 → 桥 acquire。
   * 桥失败**释放本次租约**（不留下占着后台的空绑定）；不自动 restart、不另建后台。
   */
  async acquire(input: {
    pluginId: string
    pluginInstanceId: string
  }, signal?: AbortSignal): Promise<ExclusiveResult<{ binding: ExclusiveBindingView; snapshot: ExclusiveControlSnapshot }>> {
    if (!isControllerPluginId(input.pluginId)) {
      return { ok: false, code: 'auth/impersonation', error: 'not the PetLink controller', snapshot: this.snapshot() }
    }
    if (!this.deps.isPluginEnabled(input.pluginId)) {
      return { ok: false, code: 'auth/not-enabled', error: 'the PetLink plugin is not enabled', snapshot: this.snapshot() }
    }
    // 代际在这里**同步**分配（不是进入准入链之后）：这样「本次 acquire 排队期间发生的
    // 撤销/换代」能被下面的复核看到 —— 准入链会延后一拍执行，链内再分配就看不到它。
    const epoch = ++this.epochCounter
    this.lastAllocatedEpoch = epoch
    const bindingId = randomUUID()
    return this.admit(async () => {
      if (this.binding) {
        // 同一插件实例重复 acquire 幂等（复用当前绑定，不换 epoch、不重启后台）
        if (this.binding.pluginId === input.pluginId && this.binding.pluginInstanceId === input.pluginInstanceId) {
          return { ok: true as const, binding: { ...this.binding }, snapshot: this.snapshot() }
        }
        return {
          ok: false as const,
          code: 'control/held-by-other' as const,
          error: 'another PetLink binding already holds exclusive control',
          snapshot: this.snapshot()
        }
      }
      if (epoch <= this.revokedEpoch || signal?.aborted) {
        return {
          ok: false as const,
          code: 'auth/generation-stale' as const,
          error: 'control was revoked during acquire',
          snapshot: this.snapshot()
        }
      }

      this.phase = 'acquiring'
      // 复用当前后台 / 首次启动：不要求 HTTP 调用前已存在 instance
      if (this.deps.acquireBackend) {
        const lease = await this.deps.acquireBackend(bindingId)
        if (!lease) {
          this.phase = 'free'
          return {
            ok: false as const,
            code: 'instance/no-bridge' as const,
            error: 'the harness backend could not be acquired',
            snapshot: this.snapshot()
          }
        }
        this.lease = lease
      }
      // 撤销/换代在这段 await 里发生 ⇒ 本次 acquire 不得复活（桥还没接管，只放租约即可）
      if (epoch <= this.revokedEpoch || signal?.aborted) {
        this.releaseLease()
        this.phase = 'free'
        return {
          ok: false as const,
          code: 'auth/generation-stale' as const,
          error: 'control was revoked during acquire',
          snapshot: this.snapshot()
        }
      }

      const outcome = await this.deps.runBridge({ cmd: 'acquire', epoch, bindingId })
      if (!outcome.ok) {
        this.releaseLease()
        this.phase = 'free'
        const broken =
          outcome.code === 'bridge/unavailable' || outcome.code === 'bridge/timeout' || outcome.code === 'instance/no-bridge'
        return {
          ok: false as const,
          code: broken ? ('instance/no-bridge' as const) : (outcome.code ?? ('bridge/unavailable' as const)),
          error: outcome.error ?? 'bridge refused the acquire command',
          snapshot: this.snapshot()
        }
      }
      const identity = outcome.identity ?? this.deps.currentInstance()
      this.binding = {
        bindingId,
        epoch,
        pluginId: input.pluginId,
        pluginInstanceId: input.pluginInstanceId,
        instanceId: identity?.instanceId ?? '',
        instanceEpoch: identity?.instanceEpoch ?? 0,
        acquiredAt: this.now()
      }
      // 登记后复核：撤销可能恰好在桥往返期间落地。
      // 桥**已经持有**这个 epoch，所以必须向它发真实 release 并等回执 —— 否则新 epoch 会去
      // 接管一个仍持有旧 epoch 的桥（旧绑定和旧任务仍在）。
      const revokedDuringAcquire = epoch <= this.revokedEpoch || signal?.aborted || !this.deps.isPluginEnabled(input.pluginId)
      if (revokedDuringAcquire) {
        return await this.releaseBridgeHolding('control/revoked', epoch, 'revoked during acquire')
      }
      this.phase = 'held'
      this.pushEvent({ type: 'control/acquired', epoch })
      log.info(`[Exclusive] acquired by ${input.pluginId} (epoch ${epoch})`)
      return { ok: true as const, binding: { ...this.binding }, snapshot: this.snapshot() }
    })
  }

  /**
   * 桥已接管、但本地必须放弃这次控制（撤销/换代）：向**该 epoch** 发真实 release 并等回执。
   *
   *   - 桥确认 ⇒ 清绑定 + 解租约（后台不 kill），推撤销事件；
   *   - 桥失败/超时 ⇒ **保持 releasing**、保留绑定信息与租约，返回明确错误；
   *     旧请求仍被拒绝（撤销标记已推进），绝不假 free。
   */
  private async releaseBridgeHolding(
    type: Extract<ExclusiveControlEventType, 'control/released' | 'control/revoked'>,
    epoch: number,
    reason: string
  ): Promise<ExclusiveFail | ExclusiveOk<{ binding: ExclusiveBindingView; snapshot: ExclusiveControlSnapshot }>> {
    this.phase = 'releasing'
    const outcome = await this.deps.runBridge({ cmd: 'release', epoch })
    if (!outcome.ok) {
      // 保持 releasing 与绑定：保留未确认的 Pet 绑定，用户看到明确错误，可重试 release
      return {
        ok: false,
        code: outcome.code ?? 'bridge/unavailable',
        error: outcome.error ?? 'bridge did not confirm release after revoke',
        snapshot: this.snapshot()
      }
    }
    this.applyBridgeTask(outcome.task, epoch)
    this.dropBinding(type, epoch, reason)
    return { ok: false, code: 'auth/generation-stale', error: reason, snapshot: this.snapshot() }
  }

  /**
   * 显式交回控制：等桥**确认**（真实回合结束）后才解绑并清 lease。
   * 桥失败 ⇒ 保留 held 并报明确错误（不假成功、不自造 cancelled）；后台不 kill。
   */
  async release(epoch: number): Promise<ExclusiveResult<{ snapshot: ExclusiveControlSnapshot }>> {
    return this.admit(async () => {
      const guard = this.requireEpoch(epoch)
      if (guard) return guard
      this.phase = 'releasing'
      const outcome = await this.deps.runBridge({ cmd: 'release', epoch })
      if (!outcome.ok) {
        // 保持 held：保留未确认的 Pet 绑定，用户看到明确错误
        this.phase = 'held'
        return {
          ok: false as const,
          code: outcome.code ?? ('bridge/unavailable' as const),
          error: outcome.error ?? 'bridge did not confirm release',
          snapshot: this.snapshot()
        }
      }
      this.applyBridgeTask(outcome.task, epoch)
      this.dropBinding('control/released', epoch)
      return { ok: true as const, snapshot: this.snapshot() }
    })
  }

  /**
   * 插件撤销路径（禁用/卸载/host token 撤销）：**立即**拒绝旧请求并停止接受新绑定，
   * 再走桥 release（桥会真实取消官方回合）。桥未确认期间保持撤销中（phase 不为 free），
   * 不假 free；共享后台继续活着（只解租约，不 kill）。
   */
  revoke(reason: string): void {
    if (!this.binding) {
      // 在飞 acquire 还没登记绑定：把「最近分配出去的代际」标记为已撤销，
      // 它在桥往返之后复核时会看到 epoch <= revokedEpoch 而拒绝复活。
      this.revokedEpoch = Math.max(this.revokedEpoch, this.lastAllocatedEpoch, this.epochCounter)
      return
    }
    const epoch = this.binding.epoch
    // 立即让在飞/后续 acquire 失效（幂等：同一 epoch 不会复活）
    this.revokedEpoch = Math.max(this.revokedEpoch, epoch)
    this.phase = 'releasing'
    this.approvals.clear()
    void this.admit(async () => {
      const outcome = await this.deps.runBridge({ cmd: 'release', epoch })
      if (outcome.ok) {
        this.applyBridgeTask(outcome.task, epoch)
        this.dropBinding('control/revoked', epoch, reason)
        log.info(`[Exclusive] revoked and released (${reason})`)
        return
      }
      // 桥未确认：保持 releasing（Pet 绑定仍待确认；Web 继续可操作；不假 free、不 kill 后台）
      this.phase = 'releasing'
      log.warn(`[Exclusive] revoke pending: bridge did not confirm release (${reason})`)
    }).catch(() => undefined)
  }

  /** 解租约（只解绑，绝不 kill 共享后台）。 */
  private releaseLease(): void {
    const lease = this.lease
    this.lease = null
    if (!lease) return
    try {
      lease.release()
    } catch (err) {
      log.warn('[Exclusive] backend lease release failed:', (err as Error).message)
    }
  }

  /**
   * 清空绑定：任务终态**只**采用桥上报的真实状态；桥没报终态就保持 open（不造 cancelled）。
   */
  private dropBinding(
    type: Extract<ExclusiveControlEventType, 'control/released' | 'control/revoked'>,
    epoch: number,
    reason?: string
  ): void {
    this.binding = null
    this.phase = 'free'
    this.approvals.clear()
    // 解绑后不再有「谁在控制官方 Web」：查看器状态随之清空（避免旧 held 快照被继续展示）
    this.viewer = null
    this.releaseLease()
    this.pushEvent({ type, epoch, ...(reason === undefined ? {} : { reason }) })
  }

  /**
   * 本次变更是否已被撤销/换代（撤销会推进 revokedEpoch）。
   * 所有变更在**拿到桥结果之后**都要复核一次：撤销可能发生在桥往返期间。
   */
  private revokedSince(epoch: number): boolean {
    return epoch <= this.revokedEpoch
  }

  private requireEpoch(epoch: number): ExclusiveFail | null {
    if (!this.binding) {
      return { ok: false, code: 'control/not-held', error: 'exclusive control is not held', snapshot: this.snapshot() }
    }
    if (this.binding.epoch !== epoch) {
      return {
        ok: false,
        code: 'task/stale-epoch',
        error: 'stale control epoch; this request belongs to an older controller generation',
        snapshot: this.snapshot()
      }
    }
    if (this.revokedSince(epoch)) {
      return {
        ok: false,
        code: 'task/stale-epoch',
        error: 'control was revoked; this request belongs to a revoked controller generation',
        snapshot: this.snapshot()
      }
    }
    return null
  }

  // ========== 任务 ==========

  /**
   * 提交任务。**Pet 控制通道单活动任务**：已有未结束任务时明确 busy。
   * accepted ≠ completed：这里只登记 accepted，终态只认桥上报的真实 turn/end。
   */
  async submit(input: {
    epoch: number
    sessionId?: string
    text: string
  }): Promise<ExclusiveResult<{ task: ExclusiveTaskView; snapshot: ExclusiveControlSnapshot }>> {
    return this.admit(async () => {
      const guard = this.requireEpoch(input.epoch)
      if (guard) return guard
      const binding = this.binding!
      if (this.activeTask && this.isTaskOpen(this.activeTask)) {
        return { ok: false as const, code: 'task/busy' as const, error: 'a task is already active for this instance', snapshot: this.snapshot() }
      }
      const sessionId = input.sessionId ?? binding.sessionIdForTask
      if (!sessionId) {
        return {
          ok: false as const,
          code: 'bad-request' as const,
          error: 'sessionId is required (no controlled session is selected)',
          snapshot: this.snapshot()
        }
      }
      const taskId = randomUUID()
      const outcome = await this.deps.runBridge({ cmd: 'submit', epoch: input.epoch, taskId, sessionId, text: input.text })
      // 桥异步回来：绑定/代际必须仍是当前，且期间没有被撤销，否则不登记陈旧结果
      if (this.binding?.epoch !== input.epoch || this.revokedSince(input.epoch)) {
        return {
          ok: false as const,
          code: 'task/stale-epoch' as const,
          error: 'control binding changed during submit',
          snapshot: this.snapshot()
        }
      }
      if (!outcome.ok) {
        return {
          ok: false as const,
          code: outcome.code ?? ('bridge/unavailable' as const),
          error: outcome.error ?? 'bridge refused the submit command',
          snapshot: this.snapshot()
        }
      }
      if (outcome.task && (outcome.task.taskId !== taskId || outcome.task.epoch !== input.epoch || outcome.task.sessionId !== sessionId)) {
        return { ok: false as const, code: 'bridge/unavailable' as const, error: 'bridge returned a different submitted task', snapshot: this.snapshot() }
      }
      this.activeTask = {
        taskId,
        sessionId: outcome.sessionId ?? sessionId,
        epoch: input.epoch,
        state: 'accepted' as const,
        acceptedAt: outcome.task?.acceptedAt ?? this.now()
      }
      this.transcript.length = 0
      this.approvals.clear()
      this.pushEvent({ type: 'task/accepted', epoch: input.epoch, taskId, sessionId })
      this.applyBridgeTask(outcome.task, input.epoch)
      const task = this.activeTask
      this.binding = { ...this.binding, sessionIdForTask: task.sessionId }
      return { ok: true as const, task: { ...task }, snapshot: this.snapshot() }
    })
  }

  /** 取消任务：只接受**当前**任务的取消（旧 taskId/旧 epoch 明确拒绝）；只 ack，终态等桥。 */
  async cancel(input: {
    epoch: number
    taskId: string
  }): Promise<ExclusiveResult<{ task: ExclusiveTaskView; snapshot: ExclusiveControlSnapshot }>> {
    return this.admit(async () => {
      const guard = this.requireEpoch(input.epoch)
      if (guard) return guard
      const task = this.activeTask
      if (!task || task.taskId !== input.taskId) {
        return { ok: false as const, code: 'task/not-found' as const, error: 'no such active task for this instance', snapshot: this.snapshot() }
      }
      if (!this.isTaskOpen(task)) {
        return { ok: false as const, code: 'task/not-found' as const, error: 'task already ended', snapshot: this.snapshot() }
      }
      const outcome = await this.deps.runBridge({ cmd: 'cancel', epoch: input.epoch, taskId: input.taskId })
      if (this.binding?.epoch !== input.epoch || this.revokedSince(input.epoch)) {
        return {
          ok: false as const,
          code: 'task/stale-epoch' as const,
          error: 'control binding changed during cancel',
          snapshot: this.snapshot()
        }
      }
      if (!outcome.ok) {
        return {
          ok: false as const,
          code: outcome.code ?? ('bridge/unavailable' as const),
          error: outcome.error ?? 'bridge refused the cancel command',
          snapshot: this.snapshot()
        }
      }
      // 取消只是 ack：终态由桥的真实 turn/end 上报，这里不改 state
      this.applyBridgeTask(outcome.task, input.epoch)
      return { ok: true as const, task: { ...(this.activeTask ?? task) }, snapshot: this.snapshot() }
    })
  }

  /** 回答原生审批：不进准入链（长任务不得阻塞回答）；只接受**当前待答**且同代际。 */
  async approve(input: {
    epoch: number
    approvalId: string
    outcome: ExclusiveApprovalOutcome
  }): Promise<ExclusiveResult<{ outcome: ExclusiveApprovalOutcome; snapshot: ExclusiveControlSnapshot }>> {
    const guard = this.requireEpoch(input.epoch)
    if (guard) return guard
    const pending = this.approvals.get(input.approvalId)
    if (!pending) {
      return { ok: false, code: 'approval/not-pending', error: 'no such pending approval', snapshot: this.snapshot() }
    }
    // 撤销/换代后旧审批回答一律拒绝（陈旧答案不执行）
    if (this.binding?.epoch !== pending.epoch || this.revokedSince(input.epoch)) {
      return { ok: false, code: 'approval/stale', error: 'pending approval belongs to a stale control epoch', snapshot: this.snapshot() }
    }
    const outcome = await this.deps.runBridge({
      cmd: 'approve',
      epoch: input.epoch,
      approvalId: input.approvalId,
      outcome: input.outcome
    })
    if (!outcome.ok) {
      return {
        ok: false,
        code: outcome.code ?? 'bridge/unavailable',
        error: outcome.error ?? 'bridge refused the approval answer',
        snapshot: this.snapshot()
      }
    }
    this.approvals.delete(input.approvalId)
    this.pushEvent({
      type: 'approval/decided',
      epoch: input.epoch,
      approvalId: input.approvalId,
      ...(pending.taskId === null ? {} : { taskId: pending.taskId }),
      sessionId: pending.sessionId,
      outcome: input.outcome
    })
    return { ok: true, outcome: input.outcome, snapshot: this.snapshot() }
  }

  /** 工作会话创建/选择（与执行配置变更同属官方 Web 的写面）。 */
  async session(input: {
    epoch: number
    mode: 'new' | 'select'
    sessionId?: string
  }): Promise<ExclusiveResult<{ sessionId: string; snapshot: ExclusiveControlSnapshot }>> {
    return this.admit(async () => {
      const guard = this.requireEpoch(input.epoch)
      if (guard) return guard
      const outcome = await this.deps.runBridge({
        cmd: 'session',
        epoch: input.epoch,
        mode: input.mode,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId })
      })
      if (this.binding?.epoch !== input.epoch || this.revokedSince(input.epoch)) {
        return {
          ok: false as const,
          code: 'task/stale-epoch' as const,
          error: 'control binding changed during session change',
          snapshot: this.snapshot()
        }
      }
      if (!outcome.ok || !outcome.sessionId) {
        return {
          ok: false as const,
          code: outcome.code ?? ('bridge/unavailable' as const),
          error: outcome.error ?? 'bridge did not return a session id',
          snapshot: this.snapshot()
        }
      }
      if (this.binding) this.binding = { ...this.binding, sessionIdForTask: outcome.sessionId }
      return { ok: true as const, sessionId: outcome.sessionId, snapshot: this.snapshot() }
    })
  }

  // ========== 共享工作台查看器（S4） ==========

  /** 当前工作台查看器状态（无绑定 / 桥未上报时为 null）。 */
  getViewerState(): ExclusiveViewerState | null {
    return this.viewer === null ? null : { ...this.viewer }
  }

  /**
   * 桥上报的查看器状态 → 本地。只接纳**当前绑定代际**的状态（旧代际不污染新绑定）。
   *
   * 事件只在**真实进展**时产生：新的一次 ack、或用户浏览推进了 revision；
   * 同一份快照反复同步不会重复加事件。
   */
  private applyViewer(next: ExclusiveViewerState | undefined, epoch: number): void {
    if (!next) return
    if (this.binding?.epoch !== epoch) return
    const previous = this.viewer
    this.viewer = {
      ...next,
      request: next.request ? { ...next.request } : null,
      lastAck: next.lastAck ? { ...next.lastAck } : null
    }
    const ack = this.viewer.lastAck
    const ackIsNew = ack !== null && ack.requestId !== previous?.lastAck?.requestId
    if (ackIsNew && ack) {
      const type: ExclusiveControlEventType =
        ack.status === 'navigated' ? 'viewer/navigated' : ack.status === 'failed' ? 'viewer/failed' : 'viewer/browsed'
      this.pushEvent({
        type,
        epoch,
        requestId: ack.requestId,
        revision: ack.revision,
        sessionId: ack.sessionId,
        ...(ack.reason === undefined ? {} : { reason: ack.reason })
      })
      return
    }
    if (previous !== null && this.viewer.revision > previous.revision) {
      // 用户浏览推进了 revision（没有对应 ack 时也要让上层看到「先前请求已作废」）
      this.pushEvent({ type: 'viewer/browsed', epoch, revision: this.viewer.revision })
    }
  }

  /**
   * 请求共享工作台导航到某个会话 —— **冻结 viewer/session/epoch/revision**。
   *
   * 关键语义（S4）：
   *   - 先读桥的权威 viewer 状态，用它的 revision 分配一个**更大**的 revision；
   *   - 同实例同会话（官方 UI 已在该会话、且没有别的未落地请求）⇒ 直接复用，**不重发导航**、不 restart；
   *   - 迟到的请求（revision 已被用户浏览推进）由桥以 `viewer/stale` 拒绝 —— 这里如实报错，**绝不重试**；
   *   - 落地与否由桥的 ack 决定（ack 必须来自官方 UI 实际当前会话）；本方法只登记请求。
   */
  async requestViewerNavigation(input: {
    epoch: number
    sessionId: string
    forceAcknowledgement?: boolean
  }): Promise<ExclusiveResult<{ viewer: ExclusiveViewerState; skipped: boolean }>> {
    return this.admitViewer(async () => {
      const guard = this.requireEpoch(input.epoch)
      if (guard) return guard
      // 先同步一次桥状态：revision 必须基于桥的权威值分配（否则会被自己的过期判断挡住）
      const synced = await this.deps.runBridge({ cmd: 'snapshot' })
      if (this.binding?.epoch !== input.epoch || this.revokedSince(input.epoch)) {
        return { ok: false as const, code: 'task/stale-epoch' as const, error: 'control binding changed during viewer navigation', snapshot: this.snapshot() }
      }
      if (!synced.ok) {
        return {
          ok: false as const,
          code: synced.code ?? ('bridge/unavailable' as const),
          error: synced.error ?? 'bridge snapshot failed before viewer navigation',
          snapshot: this.snapshot()
        }
      }
      this.applyViewer(synced.viewer, input.epoch)
      const current = this.viewer
      if (!current) {
        return { ok: false as const, code: 'viewer/unavailable' as const, error: 'the bridge did not report viewer state', snapshot: this.snapshot() }
      }
      // 同实例同会话：官方 UI 已经在该会话（且无未落地请求）⇒ 复用，不重发、不 restart
      if (!input.forceAcknowledgement && !current.request && current.currentSessionId === input.sessionId) {
        return { ok: true as const, viewer: { ...current }, skipped: true }
      }
      if (current.request && current.request.sessionId === input.sessionId) {
        return { ok: true as const, viewer: { ...current }, skipped: true }
      }
      const revision = Math.max(Date.now(), current.revision + 1)
      const requestId = randomUUID()
      const outcome = await this.deps.runBridge({
        cmd: 'viewer-nav',
        epoch: input.epoch,
        revision,
        requestId,
        sessionId: input.sessionId
      })
      if (this.binding?.epoch !== input.epoch || this.revokedSince(input.epoch)) {
        return { ok: false as const, code: 'task/stale-epoch' as const, error: 'control binding changed during viewer navigation', snapshot: this.snapshot() }
      }
      if (!outcome.ok) {
        // 迟到（revision 已被用户浏览推进）/ 桥不可达：明确报错，绝不重试、绝不拽回
        return {
          ok: false as const,
          code: outcome.code ?? ('bridge/unavailable' as const),
          error: outcome.error ?? 'bridge refused the viewer navigation',
          snapshot: this.snapshot()
        }
      }
      this.applyViewer(outcome.viewer, input.epoch)
      const viewer = this.viewer ?? { ...current }
      this.pushEvent({ type: 'viewer/navigation-requested', epoch: input.epoch, requestId, revision, sessionId: input.sessionId })
      return { ok: true as const, viewer: { ...viewer }, skipped: false }
    })
  }

  /** 查看器导航的串行链（与任务准入分离；链自身吞错，一次拒绝不毒死后续）。 */
  private admitViewer<T>(task: () => Promise<T>): Promise<T> {
    const run = this.viewerTail.then(task, task)
    this.viewerTail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  // ========== 桥状态同步（读路径；不进准入链） ==========

  /**
   * 把桥的快照同步进本地状态：任务终态、待答审批列表、工作输出。
   *
   * 这是主进程唯一的状态来源，且**幂等**：
   *   - 同一 taskId + 相同 state 不重复加事件；
   *   - 同一 approvalId 不重复加事件、不改 askedAt；
   *   - 桥侧消失的 approval 自动清理（回合结束/撤销后不会留下幽灵审批）；
   *   - 迟到的旧快照（更低的 task 进展/更早的 taskId）不覆盖更新的本地状态。
   *
   * 同步前必须核对**真实身份**：桥自报 identity 与绑定的 instance 不一致（后台换代）、
   * 或桥 holding=false（桥已不持有独占）⇒ 明确 generation-stale / bridge 错误，
   * **不**继续报旧的 held 快照。桥不可达同样明确失败（不 local fallback、不盲重发）。
   */
  async syncFromBridge(): Promise<{ ok: true } | { ok: false; code: ExclusiveErrorCode; error: string }> {
    if (!this.binding) return { ok: true }
    const epoch = this.binding.epoch
    const boundInstance = this.binding.instanceId
    const outcome = await this.deps.runBridge({ cmd: 'snapshot' })
    if (!outcome.ok) {
      return { ok: false, code: outcome.code ?? 'bridge/unavailable', error: outcome.error ?? 'bridge snapshot failed' }
    }
    // 同步期间本地换代 ⇒ 这次结果作废（不是错误，只是过期）
    if (this.binding?.epoch !== epoch) return { ok: true }
    // 桥自报身份必须仍是绑定的那个实例（后台换代/换了后台）
    if (outcome.identity && boundInstance && outcome.identity.instanceId !== boundInstance) {
      return { ok: false, code: 'auth/generation-stale', error: 'the bridge reports a different dsh instance' }
    }
    const current = this.deps.currentInstance()
    if (current && boundInstance && current.instanceId !== boundInstance) {
      return { ok: false, code: 'auth/generation-stale', error: 'the controlled dsh instance was replaced' }
    }
    // 桥已不持有独占（release 落地/被外部撤销）⇒ 不能继续报 held
    if (outcome.holding === false) {
      return { ok: false, code: 'bridge/unavailable', error: 'the bridge no longer holds exclusive control' }
    }
    this.applyBridgeTask(outcome.task, epoch)
    this.applyApprovals(outcome.approvals, epoch)
    this.applyTranscript(outcome.transcript)
    // 工作台查看器状态（S4）：官方页面当前会话 / 未落地导航请求 / 最近一次真实 ack
    this.applyViewer(outcome.viewer, epoch)
    return { ok: true }
  }

  /**
   * 桥侧审批列表 → 本地：新增登记（幂等），消失的清理。
   *
   * 只接纳**属于当前绑定**的审批：raw epoch 必须等于当前 epoch、session 必须是当前绑定/任务的会话；
   * 绝不用当前 epoch 覆盖 raw 里声明的旧 epoch（否则旧审批会被伪装成当前代际的审批）。
   */
  private applyApprovals(views: ExclusiveApprovalView[] | undefined, epoch: number): void {
    if (!this.binding || this.binding.epoch !== epoch) return
    if (!this.activeTask || !this.isTaskOpen(this.activeTask)) {
      this.approvals.clear()
      return
    }
    if (!Array.isArray(views)) return
    const boundSession = this.activeTask?.sessionId ?? this.binding.sessionIdForTask
    const seen = new Set<string>()
    for (const raw of views) {
      const view = raw && typeof raw === 'object' ? raw : null
      if (!view || typeof view.approvalId !== 'string' || view.approvalId.length === 0) continue
      // raw 自报的 epoch 必须与当前一致：不一致即旧代际的审批，整条丢弃（不覆盖成当前 epoch）
      if (view.epoch !== epoch) continue
      // 会话必须属于当前绑定/任务（没有绑定会话信息时只接受与当前任务一致的）
      if (boundSession !== undefined && view.sessionId !== boundSession) continue
      if (view.taskId !== null && this.activeTask && view.taskId !== this.activeTask.taskId) continue
      seen.add(view.approvalId)
      if (this.approvals.has(view.approvalId)) continue
      const normalized: ExclusiveApprovalView = { ...view, epoch }
      this.approvals.set(view.approvalId, normalized)
      this.pushEvent({
        type: 'approval/asked',
        epoch,
        approvalId: normalized.approvalId,
        sessionId: normalized.sessionId,
        ...(normalized.taskId === null ? {} : { taskId: normalized.taskId })
      })
    }
    // 桥侧已不存在的待答审批：本地同步清掉（不留下幽灵审批）
    for (const approvalId of [...this.approvals.keys()]) {
      if (!seen.has(approvalId)) this.approvals.delete(approvalId)
    }
  }

  /** 桥侧新增的工作输出 → 有界 transcript（按 seq 去重）。 */
  private applyTranscript(entries: ExclusiveTranscriptEntry[] | undefined): void {
    if (!Array.isArray(entries) || entries.length === 0) return
    const known = new Set(this.transcript.map((entry) => entry.seq))
    for (const raw of entries) {
      if (!raw || typeof raw !== 'object') continue
      if (typeof raw.seq !== 'number' || typeof raw.text !== 'string') continue
      if (!this.activeTask || raw.sessionId !== this.activeTask.sessionId) continue
      if (raw.taskId !== undefined && raw.taskId !== this.activeTask.taskId) continue
      if (known.has(raw.seq)) continue
      known.add(raw.seq)
      this.transcript.push({
        seq: raw.seq,
        at: typeof raw.at === 'number' ? raw.at : this.now(),
        kind: raw.kind,
        sessionId: String(raw.sessionId ?? ''),
        ...(typeof raw.taskId === 'string' ? { taskId: raw.taskId } : {}),
        ...(typeof raw.toolName === 'string' ? { toolName: raw.toolName.slice(0, 120) } : {}),
        text: raw.text.slice(0, EXCLUSIVE_TRANSCRIPT_TEXT_LIMIT),
        ...(raw.failed === true ? { failed: true } : {})
      })
    }
    this.transcript.sort((a, b) => a.seq - b.seq)
    if (this.transcript.length > EXCLUSIVE_TRANSCRIPT_LIMIT) {
      this.transcript.splice(0, this.transcript.length - EXCLUSIVE_TRANSCRIPT_LIMIT)
    }
  }

  /**
   * 桥上报的任务状态 → 本地。**幂等**：同 taskId + 同 state 不重复加事件。
   * 终态只来自桥的真实 turn/end（本方法不做任何推断）。
   *
   * 只接纳**属于当前绑定代际**的任务：
   *   - task.epoch 必须是当前 epoch（旧代际任务不覆盖新绑定）；
   *   - 本地已有活动任务时，只有**同一 taskId** 的状态才被接受（绝不用另一旧 task 无条件跟随）；
   *   - 本地任务已终结时，更高代际/更晚的同 task 不允许回退成 open（迟到旧快照不覆盖终态）。
   */
  private applyBridgeTask(task: ExclusiveTaskView | null | undefined, epoch: number): void {
    if (!task || typeof task !== 'object') return
    if (typeof task.taskId !== 'string' || task.taskId.length === 0) return
    if (this.binding?.epoch !== epoch) return
    if (task.epoch !== epoch) return
    const current = this.activeTask
    if (current && current.taskId !== task.taskId) return
    if (!current) {
      // 本地还没有任务（例如主进程重启后首次同步）：采纳桥的真实状态
      this.activeTask = { ...task }
    } else {
      if (current.state === task.state && current.endedAt === task.endedAt) {
        if (task.diagnostic) this.activeTask = { ...current, diagnostic: task.diagnostic }
        return
      }
      // 已终结的任务不得被迟到的旧快照拉回 open
      if (!this.isTaskOpen(current) && this.isTaskOpen(task)) return
      this.activeTask = { ...task }
    }
    const type: ExclusiveControlEventType =
      task.state === 'running'
        ? 'task/started'
        : task.state === 'completed'
          ? 'task/completed'
          : task.state === 'cancelled'
            ? 'task/cancelled'
            : task.state === 'failed'
              ? 'task/failed'
              : 'task/accepted'
    this.pushEvent({
      type,
      epoch,
      taskId: task.taskId,
      sessionId: task.sessionId,
      ...(task.endReason === undefined ? {} : { reason: task.endReason })
    })
    if (!this.isTaskOpen(task)) {
      // 任务终结 ⇒ 该任务的待答审批一律作废（陈旧答案不会被接受）
      for (const approvalId of [...this.approvals.keys()]) {
        const view = this.approvals.get(approvalId)
        if (view && view.taskId === task.taskId) this.approvals.delete(approvalId)
      }
    }
  }

  private isTaskOpen(task: ExclusiveTaskView): boolean {
    return task.state === 'accepted' || task.state === 'running'
  }
}

/**
 * 生产单例。`isPluginEnabled` 由插件生命周期提供：**未接线时一律拒绝**（fail closed）——
 * 宁可独占不可用，也不接受任何自报身份的接管请求。
 */
export interface ExclusiveServiceWiring {
  runBridge: ExclusiveControlDeps['runBridge']
  currentInstance: ExclusiveControlDeps['currentInstance']
  isPluginEnabled?: ExclusiveControlDeps['isPluginEnabled']
  acquireBackend?: ExclusiveControlDeps['acquireBackend']
}

let service: ExclusiveControlService | null = null

export function initExclusiveControl(wiring: ExclusiveServiceWiring): ExclusiveControlService {
  service = new ExclusiveControlService({
    runBridge: wiring.runBridge,
    currentInstance: wiring.currentInstance,
    // 未接线的插件状态查询 → 永远 false（fail closed）
    isPluginEnabled: wiring.isPluginEnabled ?? (() => false),
    ...(wiring.acquireBackend === undefined ? {} : { acquireBackend: wiring.acquireBackend })
  })
  return service
}

export function getExclusiveControl(): ExclusiveControlService | null {
  return service
}

/** 退出路径：清掉单例（不触碰共享后台；进程回收仍走原有 Job/进程树路径）。 */
export function disposeExclusiveControl(): void {
  service = null
}
