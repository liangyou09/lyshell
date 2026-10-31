import { createHash, randomUUID } from 'crypto'
import { realpath, stat } from 'fs/promises'
import { isAbsolute } from 'path'
import type { HarnessWorkRequest } from '@shared/harness-work'
import type {
  NativeExecutionRef, TaskArtifact, TaskDefinition, TaskEntry, TaskOperationReceipt,
  TaskResultBundle, TaskSubmission, TaskWorkbenchManifest, TaskWorkbenchReply,
  TaskWorkbenchRequest, TaskWorkbenchSnapshot
} from '@shared/task-workbench'
import { approveWorkbenchActivity, type WorkbenchActivityApproveRequest } from '../dsh/activity'
import type { WorkbenchActivitySnapshot } from '@shared/workbench-activity'
import type { TaskWorkbenchRepository } from './repository'
import { buildTaskPrompt, taskReportInstructions } from './templates/component-performance'
import {
  isTerminal, parseCreatedSession, parseNativeTask, sameBackend, sameExecution, submissionRejected,
  type NativeTaskView, type TaskHarnessReply
} from './harness-adapter'
import { isWaiting, selectPendingSubmission } from './pending-queue'

export interface TaskWorkbenchResultService {
  freeze(definition: TaskDefinition, submissionId: string): Promise<{ relativePath: string; sha256: string }>
  verify(submission: TaskSubmission): Promise<TaskResultBundle>
  readArtifact(artifact: TaskArtifact): Promise<string>
}

export interface TaskWorkbenchServiceOptions {
  repository: TaskWorkbenchRepository
  results: TaskWorkbenchResultService
  harness: (request: HarnessWorkRequest) => Promise<TaskHarnessReply>
  gate: () => boolean
  now?: () => number
  approve?: (request: WorkbenchActivityApproveRequest) => Promise<WorkbenchActivitySnapshot>
}

/** 一个业务 scope 的唯一派发者；原生执行事实仍由 Harness 持有。 */
export class TaskWorkbenchService {
  private readonly repository: TaskWorkbenchRepository
  private readonly results: TaskWorkbenchResultService
  private readonly harness: TaskWorkbenchServiceOptions['harness']
  private readonly gate: () => boolean
  private readonly now: () => number
  private readonly approve: NonNullable<TaskWorkbenchServiceOptions['approve']>
  private initialized?: Promise<void>
  private commandLane: Promise<unknown> = Promise.resolve()
  private pumpPromise?: Promise<void>
  private pumpRequested = false
  private observationPromise?: Promise<void>
  private stopped = false
  private startupError?: string
  private dispatchError?: string
  /** 只授权本次进程中明确派发的新执行；重启不恢复旧审批的自动允许。 */
  private readonly autoAllowedRequests = new Set<string>()
  private readonly revisions = new Map<string, number>()
  private readonly knownRefs = new Map<string, NativeExecutionRef>()
  private readonly cancelSent = new Set<string>()

  constructor(options: TaskWorkbenchServiceOptions) {
    this.repository = options.repository
    this.results = options.results
    this.harness = options.harness
    this.gate = options.gate
    this.now = options.now ?? Date.now
    this.approve = options.approve ?? approveWorkbenchActivity
  }

  initialize(): Promise<void> {
    if (!this.initialized) this.initialized = this.load()
    return this.initialized
  }

  private async load(): Promise<void> {
    try {
      const manifest = await this.repository.load()
      for (const item of manifest.submissions) if (item.nativeExecutionRef) this.knownRefs.set(item.id, item.nativeExecutionRef)
      if (manifest.queueEnabled || manifest.submissions.some(item => item.handoffState === 'sending' ||
        item.resumeIntent?.state === 'sending' || item.observation && !item.observation.stale)) {
        await this.repository.transact(draft => {
          draft.queueEnabled = false
          for (const item of draft.submissions) {
            if (item.handoffState === 'sending') {
              item.handoffState = 'unknown'
              item.error = 'Interrupted handoff; inspect the original execution before continuing.'
              if (item.sessionCreate?.state === 'sending') item.sessionCreate.state = 'unknown'
            }
            if (item.resumeIntent?.state === 'sending') item.resumeIntent.state = 'unknown'
            if (item.observation) item.observation.stale = true
          }
        })
      }
    } catch (error) {
      this.startupError = message(error)
    }
  }

  async request(request: TaskWorkbenchRequest): Promise<TaskWorkbenchReply> {
    await this.initialize()
    const run = async (): Promise<TaskWorkbenchReply> => {
      try {
        if (this.startupError) throw new Error(this.startupError)
        if (request.kind === 'list') return { ok: true, snapshot: await this.snapshot() }
        if (request.kind === 'readArtifact') {
          const manifest = await this.repository.read()
          const artifact = manifest.results.flatMap(result => result.artifacts).find(item => item.artifactId === request.artifactId)
          if (!artifact) throw new Error('Artifact not found')
          return { ok: true, artifactContent: await this.results.readArtifact(artifact) }
        }
        if (request.kind === 'inspect') {
          const item = findSubmission(await this.repository.read(), request.submissionId)
          await this.inspectSubmission(item)
          this.kick()
          return { ok: true, snapshot: await this.snapshot() }
        }
        if (request.kind === 'recover') {
          this.assertRunning()
          const reply = await this.harness({ kind: 'recover' })
          if (reply.status !== 200 || reply.body.ok !== true) throw new Error('Harness backend recovery was not confirmed')
          return { ok: true, snapshot: await this.snapshot() }
        }
        if (request.kind === 'openNative' || request.kind === 'exportArtifact') throw new Error('This action requires the application navigation service')
        this.assertRunning()
        if (this.dispatchError && request.kind !== 'cancel' && request.kind !== 'addNote' && request.kind !== 'releaseResources' &&
          !(request.kind === 'setQueueEnabled' && !request.enabled)) throw new Error(this.dispatchError)
        const fingerprint = operationFingerprint(request)
        const existing = operation(await this.repository.read(), request.operationId, fingerprint)
        if (existing) return { ok: true, entityId: existing.entityId, snapshot: await this.snapshot() }
        const entityId = await this.mutate(request, fingerprint)
        this.kick()
        return { ok: true, entityId, snapshot: await this.snapshot() }
      } catch (error) {
        let operationUnconfirmed = false
        if ('operationId' in request) {
          try {
            const manifest = await this.repository.read()
            const receipt = manifest.operations.find(item => item.id === request.operationId)
            if (receipt?.fingerprint === operationFingerprint(request)) {
              return { ok: true, entityId: receipt.entityId, snapshot: await this.snapshot() }
            }
          } catch { operationUnconfirmed = true }
        }
        // 元数据故障只关闭新增执行；仍可对本进程已核实的所属原生任务请求紧急停止。
        if (request.kind === 'cancel' && this.canRun() && !this.cancelSent.has(request.operationId) &&
          (this.repository.error || this.startupError || storageFailure(error))) {
          const ref = this.knownRefs.get(request.submissionId)
          if (ref) {
            this.cancelSent.add(request.operationId)
            try {
              await this.harness({ kind: 'cancel', sessionId: ref.sessionId, taskId: ref.taskId })
              return { ok: false, operationUnconfirmed: true, error: `Stop request sent; execution still needs confirmation and its audit record could not be saved. ${message(error)}` }
            } catch {
              return { ok: false, operationUnconfirmed: true, error: `Stop outcome is unconfirmed and its audit record could not be saved. ${message(error)}` }
            }
          }
        }
        let snapshot: TaskWorkbenchSnapshot | undefined
        try { snapshot = await this.snapshot() } catch { /* 损坏存储不伪造成空历史。 */ }
        return { ok: false, error: message(error), ...(operationUnconfirmed ? { operationUnconfirmed: true } : {}), ...(snapshot ? { snapshot } : {}) }
      }
    }
    const pending = this.commandLane.then(run, run)
    this.commandLane = pending.then(() => {}, () => {})
    return pending
  }

  private async mutate(request: Exclude<TaskWorkbenchRequest, { kind: 'list' | 'inspect' | 'recover' | 'openNative' | 'readArtifact' | 'exportArtifact' }>, fingerprint: string): Promise<string> {
    const now = this.now()
    if (request.kind === 'save') {
      await validateWorkspace(request.definition.workspace)
      this.assertRunning()
      return this.commitOperation(request.operationId, fingerprint, draft => {
        if (request.entryId) {
          const entry = draft.entries.find(item => item.id === request.entryId)
          if (!entry) throw new Error('Task not found')
          if (entry.revision !== request.expectedRevision) throw new Error('Task revision changed; refresh before saving')
          Object.assign(entry, structuredClone(request.definition), { revision: entry.revision + 1, updatedAt: now })
          return entry.id
        }
        const entry: TaskEntry = { ...structuredClone(request.definition), id: randomUUID(), revision: 1, createdAt: now, updatedAt: now }
        draft.entries.push(entry)
        return entry.id
      })
    }
    if (request.kind === 'start') {
      const manifest = await this.repository.read()
      const entry = manifest.entries.find(item => item.id === request.entryId)
      if (!entry) throw new Error('Task not found')
      if (entry.revision !== request.expectedRevision) throw new Error('Task revision changed; refresh before starting')
      if (manifest.submissions.filter(isWaiting).length >= 100) throw new Error('The pending queue is full (100)')
      const workspaceFingerprint = await validateWorkspace(entry.workspace)
      this.assertRunning()
      const definition = definitionOf(entry)
      const submissionId = randomUUID()
      if (buildTaskPrompt(definition, submissionId, '0'.repeat(64)).length > 32000) {
        throw new Error('Task inputs exceed the native Harness prompt limit (32000 characters)')
      }
      const frozen = await this.results.freeze(definition, submissionId)
      this.assertRunning()
      return this.commitOperation(request.operationId, fingerprint, draft => {
        const current = draft.entries.find(item => item.id === entry.id)
        if (!current || current.revision !== entry.revision) throw new Error('Task revision changed during input freezing')
        draft.submissions.push({ id: submissionId, taskEntryId: entry.id, taskRevision: entry.revision,
          clientOperationId: request.operationId, queueMode: 'host', enqueueSeq: draft.nextEnqueueSeq++,
          frozenDefinition: definition, frozenInputRef: frozen.relativePath, frozenInputHash: frozen.sha256,
          workspaceFingerprint,
          templateVersion: 1, requestId: `workbench:${submissionId}`, handoffState: 'waiting',
          executionHistory: [], slotHeld: false, resourcesHeld: [], notes: [], createdAt: now, updatedAt: now })
        return submissionId
      })
    }
    if (request.kind === 'setQueueEnabled') {
      return this.commitOperation(request.operationId, fingerprint, draft => {
        if (request.maxActive !== undefined) {
          if (!Number.isInteger(request.maxActive) || request.maxActive < 1 || request.maxActive > 8) throw new Error('Concurrency must be between 1 and 8')
          draft.maxActive = request.maxActive
        }
        draft.queueEnabled = request.enabled
        return 'queue'
      })
    }
    if (request.kind === 'withdraw') {
      return this.commitOperation(request.operationId, fingerprint, draft => {
        const item = findSubmission(draft, request.submissionId)
        if (item.resumeIntent?.state === 'waiting') {
          delete item.resumeIntent
        } else {
          if (item.handoffState !== 'waiting') throw new Error('A handoff already started; inspect or request stop instead')
          item.handoffState = 'withdrawn'
        }
        item.updatedAt = now
        return item.id
      })
    }
    if (request.kind === 'addNote' || request.kind === 'releaseResources') {
      if (!request.text.trim()) throw new Error('A verification note is required')
      return this.commitOperation(request.operationId, fingerprint, draft => {
        const item = findSubmission(draft, request.submissionId)
        if (request.kind === 'releaseResources') {
          // 人工资源核对不会改写执行状态，也不解除仍未确认的原生活动额度。
          if (item.slotHeld || item.handoffState === 'sending' || item.handoffState === 'unknown' || item.resumeIntent) {
            throw new Error('Confirm the native execution has ended before releasing its resources')
          }
          item.resourcesHeld = []
        }
        item.notes.push({ id: randomUUID(), text: request.text.trim(), at: now, kind: request.kind === 'addNote' ? 'note' : 'resource-release' })
        item.updatedAt = now
        return item.id
      })
    }
    if (request.kind === 'cancel') {
      const item = findSubmission(await this.repository.read(), request.submissionId)
      if (!item.nativeExecutionRef) throw new Error('No confirmed native execution; inspect the original handoff')
      const ref = item.nativeExecutionRef
      // 先持久登记控制意图；回执未知时同一 operationId 不会再次发送。
      const id = await this.commitOperation(request.operationId, fingerprint, draft => {
        const target = findSubmission(draft, item.id)
        target.cancelRequestedAt = now
        target.updatedAt = now
        return target.id
      })
      this.assertRunning()
      try {
        this.cancelSent.add(request.operationId)
        const reply = await this.harness({ kind: 'cancel', sessionId: ref.sessionId, taskId: ref.taskId })
        await this.applyObservation(item.id, reply, ref)
      } catch {
        await this.markStale(item.id, 'Stop requested; its result is unconfirmed')
      }
      return id
    }
    if (request.kind === 'resume') {
      if (!request.text.trim()) throw new Error('Describe the verified remaining work')
      const item = findSubmission(await this.repository.read(), request.submissionId)
      if (!item.nativeExecutionRef || item.resumeIntent) throw new Error('This execution cannot be queued for continuation')
      const ref = item.nativeExecutionRef
      const reply = await this.harness({ kind: 'state', sessionId: ref.sessionId, taskId: ref.taskId })
      this.assertRunning()
      const fresh = parseNativeTask(reply)
      if (!fresh || !sameExecution(ref, fresh.ref) || !fresh.recoveryRequired || isTerminal(fresh.state)) {
        throw new Error('The native backend has not confirmed this execution can be resumed')
      }
      return this.commitOperation(request.operationId, fingerprint, draft => {
        const target = findSubmission(draft, item.id)
        if (!target.nativeExecutionRef || !sameExecution(ref, target.nativeExecutionRef) || target.resumeIntent) throw new Error('Execution changed before continuation was recorded')
        if (draft.submissions.filter(isWaiting).length >= 100) throw new Error('The pending queue is full (100)')
        target.resumeIntent = { operationId: request.operationId, requestId: `resume:${randomUUID()}`, text: request.text,
          ...(ref.attemptId ? { sourceAttemptId: ref.attemptId } : {}), enqueueSeq: draft.nextEnqueueSeq++, state: 'waiting' }
        target.updatedAt = now
        return target.id
      })
    }
    if (request.kind === 'verify') {
      await this.inspectSubmission(findSubmission(await this.repository.read(), request.submissionId))
      const item = findSubmission(await this.repository.read(), request.submissionId)
      const bundle = await this.results.verify(item)
      this.assertRunning()
      if (bundle.submissionId !== item.id || bundle.frozenInputHash !== item.frozenInputHash) throw new Error('Verification result does not match this submission')
      return this.commitOperation(request.operationId, fingerprint, draft => {
        const current = findSubmission(draft, item.id)
        if (current.nativeExecutionRef && (!bundle.nativeExecutionRef || !sameExecution(current.nativeExecutionRef, bundle.nativeExecutionRef))) {
          throw new Error('Execution changed during verification; verify the new attempt')
        }
        draft.results.push(bundle)
        return bundle.id
      })
    }
    if (request.kind === 'accept') {
      if (!request.text.trim()) throw new Error('A reviewer note is required')
      const manifest = await this.repository.read()
      const currentResult = [...manifest.results].reverse().find(bundle => bundle.submissionId === request.submissionId)
      if (!currentResult || currentResult.decision !== 'needs-human' || currentResult.checks.some(check => !check.passed && check.name !== 'human-criteria')) {
        throw new Error('Only complete, valid results awaiting human judgment can be accepted')
      }
      // 人工判断不能绕过成果在验收后遭到替换、删除或路径逃逸的检查。
      for (const artifact of currentResult.artifacts) await this.results.readArtifact(artifact)
      this.assertRunning()
      return this.commitOperation(request.operationId, fingerprint, draft => {
        const item = findSubmission(draft, request.submissionId)
        const result = [...draft.results].reverse().find(bundle => bundle.submissionId === item.id)
        if (!result || result.id !== currentResult.id || result.decision !== 'needs-human' || result.checks.some(check => !check.passed && check.name !== 'human-criteria')) {
          throw new Error('Only complete, valid results awaiting human judgment can be accepted')
        }
        if (!item.nativeExecutionRef || !result.nativeExecutionRef || !sameExecution(item.nativeExecutionRef, result.nativeExecutionRef) ||
          item.observation?.state !== 'completed' || item.observation.stale || item.slotHeld || item.resumeIntent) {
          throw new Error('Confirm the matching native attempt completed before acceptance')
        }
        result.decision = 'passed'
        result.reviewer = request.text.trim()
        result.verifiedAt = now
        result.checks = result.checks.map(check => check.name === 'human-criteria'
          ? { ...check, passed: true, detail: 'User confirmed the saved acceptance criteria; see the reviewer note.' } : check)
        item.notes.push({ id: randomUUID(), kind: 'note', text: request.text.trim(), at: now })
        return result.id
      })
    }
    throw new Error('Unsupported task operation')
  }

  private async commitOperation(operationId: string, fingerprint: string, change: (draft: TaskWorkbenchManifest) => string): Promise<string> {
    this.assertRunning()
    return this.repository.transact(draft => {
      const previous = operation(draft, operationId, fingerprint)
      if (previous) return previous.entityId
      if (draft.operations.length >= 10000) throw new Error('Operation retention capacity reached; existing execution records are preserved')
      const entityId = change(draft)
      draft.operations.push({ id: operationId, fingerprint, entityId, at: this.now() })
      return entityId
    })
  }

  private kick(): void {
    if (!this.canRun() || this.startupError || this.dispatchError || this.repository.error) return
    this.pumpRequested = true
    if (this.pumpPromise) return
    this.pumpPromise = (async () => {
      do {
        this.pumpRequested = false
        await this.pump()
      } while (this.pumpRequested && this.canRun() && !this.repository.error)
    })().catch(error => { this.dispatchError = `Dispatch paused: ${message(error)}` })
      .finally(() => { this.pumpPromise = undefined })
  }

  private async pump(): Promise<void> {
    while (this.canRun() && !this.repository.error) {
      const manifest = await this.repository.read()
      const candidate = selectPendingSubmission(manifest)
      if (!candidate || !this.canRun()) return
      const claimed = await this.repository.transact(draft => {
        if (!this.canRun()) return undefined
        const next = selectPendingSubmission(draft)
        if (!next || next.id !== candidate.id) return undefined
        next.slotHeld = true
        next.resourcesHeld = [...new Set([...next.resourcesHeld, ...next.frozenDefinition.resourceIds])]
        next.updatedAt = this.now()
        delete next.error
        if (next.resumeIntent) next.resumeIntent.state = 'sending'
        else {
          next.handoffState = 'sending'
          if (next.sessionCreate?.state !== 'bound') next.sessionCreate = { state: 'sending', workspace: next.frozenDefinition.workspace }
        }
        return structuredClone(next)
      })
      if (!claimed) continue
      await this.dispatch(claimed, { slotHeld: candidate.slotHeld, resourcesHeld: candidate.resourcesHeld })
    }
  }

  private async dispatch(item: TaskSubmission, prior: { slotHeld: boolean; resourcesHeld: string[] }): Promise<void> {
    let nativeCallStarted = false
    try {
      this.assertRunning()
      const workspaceFingerprint = await validateWorkspace(item.frozenDefinition.workspace)
      if (item.workspaceFingerprint && workspaceFingerprint !== item.workspaceFingerprint) throw new Error('Workspace identity changed since this run was frozen')
      this.assertRunning()
      if (!await this.checkQueueBeforeSend(item, prior)) return
      if (item.resumeIntent) {
        const ref = item.nativeExecutionRef
        if (!ref) throw new Error('Continuation has no native execution reference')
        this.autoAllowedRequests.add(item.resumeIntent.requestId)
        nativeCallStarted = true
        const reply = await this.harness({ kind: 'resume', sessionId: ref.sessionId, taskId: ref.taskId,
          requestId: item.resumeIntent.requestId, idempotencyKey: item.resumeIntent.requestId,
          text: `${item.resumeIntent.text}\n\n${taskReportInstructions(item.frozenDefinition, item.id, item.frozenInputHash, item.resumeIntent.requestId)}` })
        const view = parseNativeTask(reply)
        if (!view || view.ref.sessionId !== ref.sessionId || view.ref.taskId !== ref.taskId ||
          view.requestId !== item.resumeIntent.requestId || view.ref.attemptId === ref.attemptId) {
          await this.markUnknown(item.id, 'Continuation receipt is unconfirmed; inspect the original task')
          return
        }
        await this.bind(item.id, view, item.resumeIntent.requestId)
        return
      }
      let sessionId = item.sessionCreate?.state === 'bound' ? item.sessionCreate.sessionId : undefined
      if (!sessionId) {
        nativeCallStarted = true
        const created = await this.harness({ kind: 'new', workspace: item.frozenDefinition.workspace })
        sessionId = parseCreatedSession(created, item.frozenDefinition.workspace) ?? undefined
        if (!sessionId) {
          await this.markUnknown(item.id, 'Session creation is unconfirmed; do not create another session automatically')
          return
        }
      }
      const confirmedSessionId = sessionId
      await this.repository.transact(draft => {
        const target = findSubmission(draft, item.id)
        target.sessionCreate = { state: 'bound', workspace: item.frozenDefinition.workspace, sessionId: confirmedSessionId }
        target.updatedAt = this.now()
      })
      this.assertRunning()
      if (item.workspaceFingerprint && await validateWorkspace(item.frozenDefinition.workspace) !== item.workspaceFingerprint) {
        throw new Error('Workspace identity changed during session preparation')
      }
      if (!await this.checkQueueBeforeSend(item, prior)) return
      const text = buildTaskPrompt(item.frozenDefinition, item.id, item.frozenInputHash)
      this.assertRunning()
      this.autoAllowedRequests.add(item.requestId)
      nativeCallStarted = true
      const reply = await this.harness({ kind: 'submit', sessionId, text, requestId: item.requestId, idempotencyKey: item.requestId })
      const view = parseNativeTask(reply)
      if (view && view.ref.sessionId === sessionId && view.requestId === item.requestId) {
        await this.bind(item.id, view, item.requestId)
      } else if (submissionRejected(reply)) {
        await this.repository.transact(draft => {
          const target = findSubmission(draft, item.id)
          target.handoffState = 'rejected'
          target.slotHeld = false
          target.resourcesHeld = []
          target.error = 'The native session was busy; this submission was not queued'
          target.updatedAt = this.now()
        })
      } else {
        await this.markUnknown(item.id, 'Submission receipt is unconfirmed; inspect the original session')
      }
    } catch (error) {
      if (!nativeCallStarted && this.canRun()) {
        await this.repository.transact(draft => {
          const target = findSubmission(draft, item.id)
          if (target.resumeIntent) {
            target.notes.push({ id: randomUUID(), kind: 'note', at: this.now(), text: `Continuation rejected before native dispatch: ${message(error)}` })
            delete target.resumeIntent
          } else {
            target.handoffState = 'rejected'
            if (target.sessionCreate?.state === 'sending') delete target.sessionCreate
          }
          target.slotHeld = prior.slotHeld
          target.resourcesHeld = [...prior.resourcesHeld]
          target.error = `Rejected before native dispatch: ${message(error)}`
          target.updatedAt = this.now()
        })
      } else {
        await this.markUnknown(item.id, `Handoff requires inspection: ${message(error)}`)
      }
    }
  }

  private async checkQueueBeforeSend(item: TaskSubmission, prior: { slotHeld: boolean; resourcesHeld: string[] }): Promise<boolean> {
    this.assertRunning()
    const manifest = await this.repository.read()
    this.assertRunning()
    if (manifest.queueEnabled && manifest.submissions.filter(submission => submission.slotHeld).length <= manifest.maxActive) return true
    // 这里只处理尚未调用 submit/resume 的交接；已确认的新会话仍绑定给原冻结输入。
    await this.repository.transact(draft => {
      const target = findSubmission(draft, item.id)
      if (target.resumeIntent) target.resumeIntent.state = 'waiting'
      else target.handoffState = 'waiting'
      if (target.sessionCreate?.state === 'sending') delete target.sessionCreate
      target.slotHeld = prior.slotHeld
      target.resourcesHeld = [...prior.resourcesHeld]
      target.error = manifest.queueEnabled ? 'Concurrency limit changed before native execution was submitted' : 'Queue paused before native execution was submitted'
      target.updatedAt = this.now()
    })
    return false
  }

  private async bind(submissionId: string, view: NativeTaskView, requestId: string): Promise<void> {
    await this.repository.transact(draft => {
      const item = findSubmission(draft, submissionId)
      if (view.requestId !== requestId) throw new Error('Native request identity does not match')
      if (item.resumeIntent) {
        if (item.resumeIntent.requestId !== requestId || !item.nativeExecutionRef ||
          item.nativeExecutionRef.sessionId !== view.ref.sessionId || item.nativeExecutionRef.taskId !== view.ref.taskId ||
          item.nativeExecutionRef.attemptId === view.ref.attemptId) throw new Error('Continuation identity does not match')
        item.executionHistory.push(item.nativeExecutionRef)
        delete item.resumeIntent
      } else if ((item.executionRequestId ?? item.requestId) !== requestId || item.sessionCreate?.sessionId !== view.ref.sessionId) {
        throw new Error('Native task belongs to another handoff')
      } else if (item.nativeExecutionRef) {
        if (!sameExecution(item.nativeExecutionRef, view.ref)) throw new Error('An existing handoff cannot be rebound to another execution')
        if (isTerminal(item.observation?.state ?? '') && item.observation?.state !== view.state ||
          item.observation?.state === 'running' && view.state === 'accepted') return
      }
      item.nativeExecutionRef = view.ref
      item.executionRequestId = requestId
      this.knownRefs.set(item.id, structuredClone(view.ref))
      item.handoffState = 'bound'
      item.observation = { state: view.state, stale: false, identity: view.identity, observedAt: this.now(),
        executionIdentity: view.ref.executionIdentity, attemptId: view.ref.attemptId,
        lastConfirmedState: confirmedState(view, item) }
      item.slotHeld = !isTerminal(view.state)
      if (isTerminal(view.state)) delete item.cancelRequestedAt
      delete item.error
      item.updatedAt = this.now()
    })
    await this.autoApproveSafely(submissionId, view)
  }

  /** 与现有活动读取节拍共用，不创建第二个定时器；同一 scope 的观察不重入。 */
  async observe(): Promise<void> {
    await this.initialize()
    if (this.stopped || this.startupError) return
    if (!this.observationPromise) this.observationPromise = this.observeAll().finally(() => { this.observationPromise = undefined })
    return this.observationPromise
  }

  private async observeAll(): Promise<void> {
    const manifest = await this.repository.read()
    const pending = manifest.submissions.filter(item => item.slotHeld || item.handoffState === 'unknown' || item.resumeIntent || item.observation?.stale)
    // 优先核对占用，再补查历史；与既有活动观察保持有界并发，避免重启时同时读取全部历史。
    pending.sort((left, right) => Number(right.slotHeld) - Number(left.slotHeld))
    let index = 0
    const deadline = this.now() + 6000
    await Promise.allSettled(Array.from({ length: Math.min(4, pending.length) }, async () => {
      while (index < pending.length && this.canRun() && this.now() < deadline) {
        const item = pending[index++]
        await this.inspectSubmission(item)
      }
    }))
    this.kick()
  }

  private async inspectSubmission(item: TaskSubmission): Promise<void> {
    const ref = item.nativeExecutionRef
    const sessionId = ref?.sessionId ?? item.sessionCreate?.sessionId
    if (!sessionId) return
    try {
      const reply = await this.harness({ kind: 'state', sessionId, ...(ref ? { taskId: ref.taskId } : {}) })
      const view = parseNativeTask(reply)
      const pendingRequest = item.resumeIntent?.state === 'unknown' || item.resumeIntent?.state === 'sending'
        ? item.resumeIntent.requestId : item.requestId
      if (!ref && view && view.ref.sessionId === sessionId && view.requestId === pendingRequest) {
        await this.bind(item.id, view, pendingRequest)
      } else if (item.resumeIntent && item.resumeIntent.state !== 'waiting' && view && view.requestId === pendingRequest &&
        ref?.taskId === view.ref.taskId && ref.attemptId !== view.ref.attemptId) {
        await this.bind(item.id, view, pendingRequest)
      } else if (ref) {
        await this.applyObservation(item.id, reply, ref)
      } else {
        await this.markStale(item.id, 'No matching native submission found; handoff remains unconfirmed')
      }
    } catch (error) {
      await this.markStale(item.id, `Native observation unavailable: ${message(error)}`)
    }
  }

  private async applyObservation(submissionId: string, reply: TaskHarnessReply, expected: NativeExecutionRef): Promise<void> {
    const view = parseNativeTask(reply)
    if (!view || !sameExecution(expected, view.ref)) {
      await this.markStale(submissionId, 'The matching native execution could not be confirmed', expected)
      return
    }
    const key = JSON.stringify([view.identity, view.ref])
    const lastRevision = this.revisions.get(key)
    if (view.revision !== undefined && lastRevision !== undefined && view.revision < lastRevision) return
    if (view.revision !== undefined) this.revisions.set(key, view.revision)
    await this.repository.transact(draft => {
      const item = findSubmission(draft, submissionId)
      if (!item.nativeExecutionRef || !sameExecution(expected, item.nativeExecutionRef)) return
      if (isTerminal(item.observation?.state ?? '') && item.observation?.state !== view.state) return
      if (item.observation?.state === 'running' && view.state === 'accepted') return
      item.observation = { state: view.state, stale: false, observedAt: this.now(), identity: view.identity,
        executionIdentity: view.ref.executionIdentity, attemptId: view.ref.attemptId,
        lastConfirmedState: confirmedState(view, item) }
      if (isTerminal(view.state) && !item.resumeIntent) {
        item.slotHeld = false
        delete item.cancelRequestedAt
      }
      item.updatedAt = this.now()
      delete item.error
    })
    await this.autoApproveSafely(submissionId, view)
  }

  private async autoApproveSafely(submissionId: string, view: NativeTaskView): Promise<void> {
    try { await this.autoApprove(submissionId, view) }
    catch (error) {
      // 审批观察失败不能把已经持久绑定的原生提交改回“交接未知”。
      this.autoAllowedRequests.delete(view.requestId)
      await this.markStale(submissionId, `Automatic approval needs manual review: ${message(error)}`, view.ref)
    }
  }

  private async autoApprove(submissionId: string, view: NativeTaskView): Promise<void> {
    if (!this.canRun() || !this.autoAllowedRequests.has(view.requestId) || !sameBackend(view.identity, view.ref.executionIdentity)) return
    for (const approval of view.approvals) {
      if (!approval.options.includes('allowed-once') || !this.canRun()) continue
      const marker = `approval:${createHash('sha256').update(approval.id).digest('hex')}`
      const claimed = await this.repository.transact(draft => {
        const item = findSubmission(draft, submissionId)
        if (item.frozenDefinition.approvalPolicy !== 'auto-allow' || !item.nativeExecutionRef ||
          !sameExecution(view.ref, item.nativeExecutionRef) || item.observation?.stale ||
          isTerminal(item.observation?.state ?? '') || item.notes.some(note => note.id === marker)) return false
        item.notes.push({ id: marker, kind: 'approval', at: this.now(), text: `Automatic allowed-once requested for native approval ${approval.id}; outcome must be observed.` })
        return true
      })
      if (!claimed || !this.canRun()) continue
      // 复用现有 fresh-read、操作完整性及精确归属校验；不更改后端权限模式。
      const after = await this.approve({ kind: 'approve', identity: view.identity, sessionId: view.ref.sessionId,
        taskId: view.ref.taskId, approvalId: approval.id, optionId: 'allowed-once' })
      if (after.error) await this.markStale(submissionId, after.error, view.ref)
    }
  }

  private async markUnknown(submissionId: string, error: string): Promise<void> {
    await this.repository.transact(draft => {
      const item = findSubmission(draft, submissionId)
      if (item.resumeIntent) item.resumeIntent.state = 'unknown'
      else item.handoffState = 'unknown'
      if (item.sessionCreate?.state === 'sending') item.sessionCreate.state = 'unknown'
      item.error = error
      item.updatedAt = this.now()
    })
  }

  private async markStale(submissionId: string, error: string, expected?: NativeExecutionRef): Promise<void> {
    await this.repository.transact(draft => {
      const item = findSubmission(draft, submissionId)
      if (expected && (!item.nativeExecutionRef || !sameExecution(expected, item.nativeExecutionRef))) return
      if (item.observation) item.observation.stale = true
      item.error = error
      item.updatedAt = this.now()
    })
  }

  private async snapshot(): Promise<TaskWorkbenchSnapshot> {
    const manifest = await this.repository.read()
    return { revision: manifest.revision, queueEnabled: manifest.queueEnabled, maxActive: manifest.maxActive,
      entries: manifest.entries, submissions: manifest.submissions, results: manifest.results,
      ...(this.repository.error || this.dispatchError ? { storageError: this.repository.error ?? this.dispatchError } : {}) }
  }

  private canRun(): boolean { return !this.stopped && this.gate() }
  private assertRunning(): void { if (!this.canRun()) throw new Error('Task dispatch is paused by the application lifecycle or permission gate') }

  stop(): void { this.stopped = true }
  async flush(): Promise<void> {
    await this.commandLane
    await this.pumpPromise
    await this.observationPromise
    await this.repository.flush()
  }
}

function findSubmission(manifest: TaskWorkbenchManifest, id: string): TaskSubmission {
  const item = manifest.submissions.find(submission => submission.id === id)
  if (!item) throw new Error('Submission not found')
  return item
}

function operation(manifest: TaskWorkbenchManifest, id: string, fingerprint: string): TaskOperationReceipt | undefined {
  const found = manifest.operations.find(item => item.id === id)
  if (found && found.fingerprint !== fingerprint) throw new Error('This operation ID is already bound to different parameters')
  return found
}

function definitionOf(entry: TaskEntry): TaskDefinition {
  return structuredClone({ title: entry.title, goal: entry.goal, workspace: entry.workspace,
    templateId: entry.templateId, acceptanceCriteria: entry.acceptanceCriteria,
    resourceIds: entry.resourceIds, approvalPolicy: entry.approvalPolicy,
    ...(entry.performance ? { performance: entry.performance } : {}) })
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
  return value
}

function operationFingerprint(request: TaskWorkbenchRequest): string {
  return createHash('sha256').update(JSON.stringify(canonical(request))).digest('hex')
}

async function validateWorkspace(workspace: string): Promise<string> {
  if (!isAbsolute(workspace)) throw new Error('Workspace must be an existing absolute directory')
  const target = await realpath(workspace)
  const info = await stat(target, { bigint: true })
  if (!info.isDirectory()) throw new Error('Workspace must be an existing absolute directory')
  return createHash('sha256').update(JSON.stringify([process.platform === 'win32' ? target.toLowerCase() : target,
    info.dev.toString(), info.ino.toString()])).digest('hex')
}

function message(error: unknown): string { return error instanceof Error ? error.message : 'Task workbench operation failed' }

function storageFailure(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error &&
    ['TASK_WORKBENCH_WRITE_FAILED', 'TASK_WORKBENCH_WRITE_UNCERTAIN', 'TASK_WORKBENCH_CORRUPT',
      'TASK_WORKBENCH_UNREADABLE'].includes(String(error.code))
}

function confirmedState(view: NativeTaskView, item: TaskSubmission): string | undefined {
  return view.lastConfirmedState ?? (view.state !== 'unconfirmed' && view.state !== 'unknown' ? view.state : item.observation?.lastConfirmedState)
}
