import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, rename } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { HarnessWorkRequest } from '@shared/harness-work'
import type { TaskDefinition, TaskSubmission, TaskWorkbenchRequest } from '@shared/task-workbench'
import { TaskWorkbenchRepository } from './repository'
import { atomicWriteFile } from '../storage/atomic-json'
import { TaskWorkbenchService, type TaskWorkbenchResultService } from './service'
import type { TaskHarnessReply } from './harness-adapter'

const IDENTITY = { instanceId: 'fixture-backend', instanceEpoch: 1 }
const roots: string[] = []
const services = new Set<TaskWorkbenchService>()
afterEach(async () => {
  for (const service of services) service.stop()
  await Promise.all([...services].map(service => service.flush()))
  services.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
})

interface FixtureTask { sessionId: string; taskId: string; requestId: string; attemptId: string; state: string; recoveryRequired?: boolean; approval?: string }
async function rig() {
  const tempRoot = join(process.cwd(), 'tmp', 'task-workbench-tests')
  await mkdir(tempRoot, { recursive: true })
  const workspace = await mkdtemp(join(tempRoot, 'service-'))
  roots.push(workspace)
  const controls = { gate: true, loseNew: false, loseSubmit: false, approvals: 0, freeze: 0, failStorage: false }
  const repository = new TaskWorkbenchRepository(join(workspace, 'metadata'), { writeFile: async (path, data) => {
    if (controls.failStorage) throw new Error('Fixture storage write unavailable')
    await atomicWriteFile(path, data)
  } })
  const calls: HarnessWorkRequest[] = []
  const tasks = new Map<string, FixtureTask>()
  const nativeReply = (task: FixtureTask): TaskHarnessReply => ({ status: 200, body: {
    ok: true, status: 'running', identity: IDENTITY, sessionId: task.sessionId, workspace,
    taskId: task.taskId, taskState: task.state, task: { ...task, executionIdentity: IDENTITY, executionSessionId: task.sessionId },
    approvals: task.approval ? [{ id: task.approval, taskId: task.taskId, sessionId: task.sessionId, options: ['allowed-once', 'rejected'] }] : [],
    sessions: [], transcript: []
  } })
  const harness = async (request: HarnessWorkRequest): Promise<TaskHarnessReply> => {
    calls.push(structuredClone(request))
    if (request.kind === 'new') {
      if (controls.loseNew) throw new Error('Response lost after session creation')
      return { status: 200, body: { ok: true, identity: IDENTITY, sessionId: `session-${calls.length}`, workspace } }
    }
    if (request.kind === 'submit') {
      const task = { sessionId: request.sessionId, taskId: randomUUID(), requestId: request.requestId, attemptId: randomUUID(), state: 'running' }
      tasks.set(request.sessionId, task)
      if (controls.loseSubmit) throw new Error('Response lost after acceptance')
      return nativeReply(task)
    }
    if (request.kind === 'resume') {
      const previous = tasks.get(request.sessionId)!
      const task = { ...previous, requestId: request.requestId, attemptId: randomUUID(), state: 'running', recoveryRequired: false }
      tasks.set(request.sessionId, task)
      return nativeReply(task)
    }
    if (request.kind === 'state' || request.kind === 'cancel') {
      const task = tasks.get(request.sessionId ?? '')
      return task ? nativeReply(task) : { status: 409, body: { ok: false, code: 'task/not-found' } }
    }
    return { status: 200, body: { ok: true } }
  }
  const results: TaskWorkbenchResultService = {
    freeze: async (_definition, submissionId) => { controls.freeze++; return { relativePath: `inputs/${submissionId}.json`, sha256: 'a'.repeat(64) } },
    verify: async (submission: TaskSubmission) => ({ id: randomUUID(), submissionId: submission.id, artifacts: [], decision: 'needs-human',
      checks: [{ name: 'integrity', passed: true, detail: 'fixture' }], businessOutcome: 'not-evaluated', frozenInputHash: submission.frozenInputHash,
      nativeExecutionRef: submission.nativeExecutionRef, verifierVersion: 1, verifiedAt: Date.now() }),
    readArtifact: async () => 'fixture'
  }
  const options = { repository, harness, results, gate: () => controls.gate,
    approve: async () => { controls.approvals++; return { observedAt: Date.now(), identity: IDENTITY, connection: 'connected' as const, sessions: [] } } }
  const service = new TaskWorkbenchService(options)
  services.add(service)
  await service.initialize()
  const definition = (title = 'Fixture', resourceIds: string[] = []): TaskDefinition => ({ title, goal: 'Analyze existing data',
    workspace, templateId: 'general', acceptanceCriteria: '', resourceIds, approvalPolicy: 'auto-allow' })
  const request = (input: TaskWorkbenchRequest) => service.request(input)
  const save = async (title?: string, resources?: string[]) => {
    const reply = await request({ kind: 'save', operationId: randomUUID(), definition: definition(title, resources) })
    expect(reply.ok, reply.error).toBe(true)
    return reply.entityId!
  }
  const start = async (entryId: string, operationId = randomUUID()) => {
    const reply = await request({ kind: 'start', operationId, entryId, expectedRevision: 1 })
    expect(reply.ok, reply.error).toBe(true)
    return reply.entityId!
  }
  const enable = async (enabled = true, maxActive?: number) => {
    const reply = await request({ kind: 'setQueueEnabled', operationId: randomUUID(), enabled, ...(maxActive ? { maxActive } : {}) })
    expect(reply.ok, reply.error).toBe(true)
    await service.flush()
  }
  return { workspace, repository, service, options, calls, tasks, controls, request, save, start, enable, definition }
}

describe('TaskWorkbenchService persistent handoff and admission', () => {
  it('keeps a confirmed handoff bound when automatic approval observation fails', async () => {
    const r = await rig()
    const service = new TaskWorkbenchService({ ...r.options, approve: async () => { throw new Error('Approval receipt lost') } })
    services.add(service)
    await service.initialize()
    const saved = await service.request({ kind: 'save', operationId: randomUUID(), definition: r.definition() })
    const created = await service.request({ kind: 'start', operationId: randomUUID(), entryId: saved.entityId!, expectedRevision: 1 })
    await service.request({ kind: 'setQueueEnabled', operationId: randomUUID(), enabled: true })
    await service.flush()
    const task = [...r.tasks.values()][0]
    task.approval = 'approval-unconfirmed'
    await service.observe()
    const item = (await r.repository.read()).submissions.find(submission => submission.id === created.entityId)!
    expect(item.handoffState).toBe('bound')
    expect(item.slotHeld).toBe(true)
    expect(item.observation?.stale).toBe(true)
    expect(item.error).toContain('Automatic approval needs manual review')
    expect(r.calls.filter(request => request.kind === 'submit')).toHaveLength(1)
  })
  it('refuses a queued workspace replaced at the same path before dispatch', async () => {
    const r = await rig()
    const target = join(r.workspace, 'replaceable')
    await mkdir(target)
    const saved = await r.request({ kind: 'save', operationId: randomUUID(), definition: { ...r.definition(), workspace: target } })
    const id = await r.start(saved.entityId!)
    await rename(target, join(r.workspace, 'original'))
    await mkdir(target)
    await r.enable()
    const run = (await r.repository.read()).submissions.find(item => item.id === id)!
    expect(run.handoffState).toBe('rejected')
    expect(run.slotHeld).toBe(false)
    expect(run.error).toContain('Workspace identity changed')
    expect(r.calls).toHaveLength(0)
  })
  it('accepts only the human criteria check and does not bypass integrity or native completion failures', async () => {
    const r = await rig()
    const submissionId = await r.start(await r.save())
    await r.enable()
    const task = [...r.tasks.values()][0]
    task.state = 'completed'
    await r.service.observe()
    const verify = r.options.results.verify
    let unsafe = false
    r.options.results.verify = async submission => ({ ...await verify(submission),
      checks: [{ name: 'human-criteria', passed: false, detail: 'Awaiting user judgment' },
        { name: 'integrity', passed: !unsafe, detail: 'Snapshot integrity' }] })
    const checked = await r.request({ kind: 'verify', submissionId, operationId: randomUUID() })
    expect(checked.ok, checked.error).toBe(true)
    const accepted = await r.request({ kind: 'accept', submissionId, operationId: randomUUID(), text: 'Reviewed the saved report against the criteria. ' + 'a'.repeat(3000) })
    expect(accepted.ok, accepted.error).toBe(true)
    expect((await r.repository.read()).results.at(-1)?.checks.every(check => check.passed)).toBe(true)
    unsafe = true
    await r.request({ kind: 'verify', submissionId, operationId: randomUUID() })
    const rejected = await r.request({ kind: 'accept', submissionId, operationId: randomUUID(), text: 'Cannot override corrupt data.' })
    expect(rejected.ok).toBe(false)
  })

  it('does not send an emergency cancel when an operation ID belongs to different parameters', async () => {
    const r = await rig()
    const submissionId = await r.start(await r.save())
    await r.enable()
    const operationId = randomUUID()
    await r.request({ kind: 'addNote', submissionId, operationId, text: 'Original operation' })
    const reply = await r.request({ kind: 'cancel', submissionId, operationId })
    expect(reply.ok).toBe(false)
    expect(reply.error).toContain('different parameters')
    expect(r.calls.filter(request => request.kind === 'cancel')).toHaveLength(0)
  })

  it('deduplicates a repeated start operation and preserves the frozen task revision', async () => {
    const r = await rig()
    const entryId = await r.save()
    const operationId = randomUUID()
    const [first, second] = await Promise.all([r.start(entryId, operationId), r.start(entryId, operationId)])
    expect(second).toBe(first)
    expect(r.controls.freeze).toBe(1)
    const edited = await r.request({ kind: 'save', operationId: randomUUID(), entryId, expectedRevision: 1,
      definition: { ...r.definition(), goal: 'Changed goal' } })
    expect(edited.ok).toBe(true)
    const manifest = await r.repository.read()
    expect(manifest.submissions).toHaveLength(1)
    expect(manifest.submissions[0].frozenDefinition.goal).toBe('Analyze existing data')
    expect(manifest.submissions[0].taskRevision).toBe(1)
    const conflict = await r.request({ kind: 'start', operationId, entryId, expectedRevision: 2 })
    expect(conflict.ok).toBe(false)
    expect(r.calls).toHaveLength(0)
  })

  it('admits A1 and B1 within the limit while A2 waits for its exact resource', async () => {
    const r = await rig()
    const a1 = await r.start(await r.save('A1', ['environment-a']))
    const a2 = await r.start(await r.save('A2', ['environment-a']))
    const b1 = await r.start(await r.save('B1', ['environment-b']))
    await r.enable()
    let manifest = await r.repository.read()
    expect(manifest.submissions.filter(item => item.slotHeld)).toHaveLength(2)
    expect(manifest.submissions.find(item => item.id === a1)?.handoffState).toBe('bound')
    expect(manifest.submissions.find(item => item.id === a2)?.handoffState).toBe('waiting')
    expect(manifest.submissions.find(item => item.id === b1)?.handoffState).toBe('bound')
    const taskA1 = r.tasks.get(manifest.submissions.find(item => item.id === a1)!.nativeExecutionRef!.sessionId)!
    const stopped = await r.request({ kind: 'cancel', operationId: randomUUID(), submissionId: a1 })
    expect(stopped.ok).toBe(true)
    expect((await r.repository.read()).submissions.find(item => item.id === a1)?.slotHeld).toBe(true)
    taskA1.state = 'completed'
    await r.service.observe()
    await r.service.flush()
    manifest = await r.repository.read()
    expect(manifest.submissions.find(item => item.id === a1)?.slotHeld).toBe(false)
    expect(manifest.submissions.find(item => item.id === a1)?.resourcesHeld).toEqual(['environment-a'])
    expect(manifest.submissions.find(item => item.id === a2)?.handoffState).toBe('waiting')
    const released = await r.request({ kind: 'releaseResources', operationId: randomUUID(), submissionId: a1,
      text: 'Verified the target process ended and environment A is free.' })
    expect(released.ok, released.error).toBe(true)
    await r.service.flush()
    expect((await r.repository.read()).submissions.find(item => item.id === a2)?.handoffState).toBe('bound')
  })

  it('keeps unknown submit occupancy and reconciles by the original request without resubmitting', async () => {
    const r = await rig()
    r.controls.loseSubmit = true
    const first = await r.start(await r.save('First'))
    await r.start(await r.save('Second'))
    await r.enable(true, 1)
    let manifest = await r.repository.read()
    expect(manifest.submissions.find(item => item.id === first)?.handoffState).toBe('unknown')
    expect(manifest.submissions.find(item => item.id === first)?.slotHeld).toBe(true)
    expect(r.calls.filter(item => item.kind === 'submit')).toHaveLength(1)
    await r.service.observe()
    await r.service.flush()
    manifest = await r.repository.read()
    expect(manifest.submissions.find(item => item.id === first)?.handoffState).toBe('bound')
    expect(r.calls.filter(item => item.kind === 'submit')).toHaveLength(1)
    expect(manifest.submissions[1].handoffState).toBe('waiting')
  })

  it('does not repeat new after its response was lost or dispatch a waiting item after restart', async () => {
    const r = await rig()
    r.controls.loseNew = true
    await r.start(await r.save('First'))
    await r.start(await r.save('Second'))
    await r.enable(true, 1)
    await r.service.observe()
    expect(r.calls.filter(item => item.kind === 'new')).toHaveLength(1)
    r.service.stop()
    await r.service.flush()
    const restarted = new TaskWorkbenchService({ ...r.options, repository: new TaskWorkbenchRepository(join(r.workspace, 'metadata')) })
    services.add(restarted)
    await restarted.initialize()
    const reply = await restarted.request({ kind: 'list' })
    expect(reply.snapshot?.queueEnabled).toBe(false)
    expect(reply.snapshot?.submissions[0].handoffState).toBe('unknown')
    await restarted.observe()
    await restarted.flush()
    expect(r.calls.filter(item => item.kind === 'new')).toHaveLength(1)
  })

  it('withdraws only a never dispatched waiting item and does not release an unknown handoff', async () => {
    const r = await rig()
    const waiting = await r.start(await r.save())
    const result = await r.request({ kind: 'withdraw', operationId: randomUUID(), submissionId: waiting })
    expect(result.ok).toBe(true)
    await r.enable()
    expect(r.calls).toHaveLength(0)
    r.controls.loseNew = true
    const unknown = await r.start(await r.save())
    await r.service.flush()
    expect((await r.request({ kind: 'withdraw', operationId: randomUUID(), submissionId: unknown })).ok).toBe(false)
    expect((await r.request({ kind: 'releaseResources', operationId: randomUUID(), submissionId: unknown, text: 'clear' })).ok).toBe(false)
    expect((await r.repository.read()).submissions.find(item => item.id === unknown)?.slotHeld).toBe(true)
  })

  it('queues a resume behind the same activity budget and binds only its new native attempt', async () => {
    const r = await rig()
    const first = await r.start(await r.save('First'))
    const second = await r.start(await r.save('Second'))
    await r.enable(true, 2)
    const initial = (await r.repository.read()).submissions.find(item => item.id === first)!
    const ref = initial.nativeExecutionRef!
    const task = r.tasks.get(ref.sessionId)!
    task.state = 'unconfirmed'
    task.recoveryRequired = true
    await r.service.observe()
    await r.enable(false)
    const resumed = await r.request({ kind: 'resume', operationId: randomUUID(), submissionId: first, text: 'Checked side effects; finish the report.' })
    expect(resumed.ok, resumed.error).toBe(true)
    expect(r.calls.filter(item => item.kind === 'resume')).toHaveLength(0)
    await r.enable(true, 2)
    const manifest = await r.repository.read()
    const current = manifest.submissions.find(item => item.id === first)!
    expect(current.nativeExecutionRef?.taskId).toBe(ref.taskId)
    expect(current.nativeExecutionRef?.attemptId).not.toBe(ref.attemptId)
    expect(current.executionHistory).toEqual([ref])
    expect(current.resumeIntent).toBeUndefined()
    const resume = r.calls.find(call => call.kind === 'resume')!
    expect(resume.kind === 'resume' && resume.text).toContain(`Execution-Request: ${current.executionRequestId}`)
    expect(manifest.submissions.find(item => item.id === second)?.slotHeld).toBe(true)
    expect(manifest.submissions.filter(item => item.slotHeld)).toHaveLength(2)
  })

  it('keeps a resumed attempt bound when observation confirms it before the resume receipt arrives', async () => {
    const r = await rig()
    let entered!: () => void
    const didEnter = new Promise<void>(resolve => { entered = resolve })
    let release!: () => void
    const wait = new Promise<void>(resolve => { release = resolve })
    const service = new TaskWorkbenchService({ ...r.options, harness: async request => {
      const reply = await r.options.harness(request)
      if (request.kind === 'resume') { entered(); await wait }
      return reply
    } })
    services.add(service)
    await service.initialize()
    const entry = await service.request({ kind: 'save', operationId: randomUUID(), definition: r.definition() })
    const start = await service.request({ kind: 'start', operationId: randomUUID(), entryId: entry.entityId!, expectedRevision: 1 })
    await service.request({ kind: 'setQueueEnabled', operationId: randomUUID(), enabled: true })
    await service.flush()
    const task = [...r.tasks.values()][0]
    task.state = 'unconfirmed'; task.recoveryRequired = true
    await service.request({ kind: 'resume', operationId: randomUUID(), submissionId: start.entityId!, text: 'Verified side effects; finish the report.' })
    await didEnter
    await service.observe()
    release()
    await service.flush()
    const item = (await r.repository.read()).submissions[0]
    expect(item.handoffState).toBe('bound')
    expect(item.error).toBeUndefined()
    expect(item.executionHistory).toHaveLength(1)
    expect(item.executionRequestId).toBe([...r.tasks.values()][0].requestId)
  })

  it('refreshes a historical completion before collecting results', async () => {
    const r = await rig()
    const submissionId = await r.start(await r.save())
    await r.enable()
    const task = [...r.tasks.values()][0]
    task.state = 'completed'
    await r.service.observe()
    const oldTime = Date.now() - 120000
    await r.repository.transact(draft => { draft.submissions[0].observation!.observedAt = oldTime })
    let verified: TaskSubmission | undefined
    const verify = r.options.results.verify
    r.options.results.verify = async item => { verified = item; return verify(item) }
    const reply = await r.request({ kind: 'verify', submissionId, operationId: randomUUID() })
    expect(reply.ok, reply.error).toBe(true)
    expect(verified?.observation?.observedAt).toBeGreaterThan(oldTime)
    expect(verified?.observation?.stale).toBe(false)
  })

  it('applies default approval only once for new owned attempts and leaves restarted approvals manual', async () => {
    const r = await rig()
    await r.start(await r.save())
    await r.enable()
    const task = [...r.tasks.values()][0]
    task.approval = 'approval-1'
    await r.service.observe()
    await r.service.observe()
    expect(r.controls.approvals).toBe(1)
    task.approval = 'approval-after-restart'
    r.service.stop()
    await r.service.flush()
    const restarted = new TaskWorkbenchService({ ...r.options, repository: new TaskWorkbenchRepository(join(r.workspace, 'metadata')) })
    services.add(restarted)
    await restarted.initialize()
    await restarted.observe()
    expect(r.controls.approvals).toBe(1)
    const manifest = await r.repository.read()
    expect(manifest.submissions[0].notes.filter(note => note.kind === 'approval')).toHaveLength(1)
  })

  it('closes the dispatch gate synchronously when new is still awaiting its response', async () => {
    const r = await rig()
    let entered!: () => void
    const didEnter = new Promise<void>(resolve => { entered = resolve })
    let release!: (reply: TaskHarnessReply) => void
    const lateNew = new Promise<TaskHarnessReply>(resolve => { release = resolve })
    const harness = async (request: HarnessWorkRequest) => {
      if (request.kind === 'new') { entered(); return lateNew }
      r.calls.push(request)
      return { status: 503, body: { ok: false } }
    }
    const service = new TaskWorkbenchService({ ...r.options, harness })
    services.add(service)
    await service.initialize()
    const entry = await service.request({ kind: 'save', operationId: randomUUID(), definition: r.definition() })
    await service.request({ kind: 'start', operationId: randomUUID(), entryId: entry.entityId!, expectedRevision: 1 })
    await service.request({ kind: 'setQueueEnabled', operationId: randomUUID(), enabled: true })
    await didEnter
    service.stop()
    release({ status: 200, body: { ok: true, identity: IDENTITY, sessionId: 'late-session', workspace: r.workspace } })
    await service.flush()
    expect(r.calls.filter(item => item.kind === 'submit')).toHaveLength(0)
    expect((await r.repository.read()).submissions[0].handoffState).toBe('unknown')
  })

  it('preserves emergency stop for a known native binding when its audit storage is unavailable', async () => {
    const r = await rig()
    const submissionId = await r.start(await r.save())
    await r.enable()
    r.controls.failStorage = true
    const operationId = randomUUID()
    const reply = await r.request({ kind: 'cancel', submissionId, operationId })
    expect(reply.ok).toBe(false)
    expect(reply.error).toContain('Stop request sent')
    expect(reply.error).toContain('audit record could not be saved')
    await r.request({ kind: 'cancel', submissionId, operationId })
    expect(r.calls.filter(request => request.kind === 'cancel')).toHaveLength(1)
    expect((await r.repository.read()).submissions[0].slotHeld).toBe(true)
  })

  it('honors pause after session preparation without submitting, then reuses its confirmed unsubmitted session', async () => {
    const r = await rig()
    let entered!: () => void
    const didEnter = new Promise<void>(resolve => { entered = resolve })
    let release!: (reply: TaskHarnessReply) => void
    const lateNew = new Promise<TaskHarnessReply>(resolve => { release = resolve })
    let newCount = 0
    const service = new TaskWorkbenchService({ ...r.options, harness: async request => {
      if (request.kind === 'new') { newCount++; entered(); return lateNew }
      return r.options.harness(request)
    } })
    services.add(service)
    await service.initialize()
    const entry = await service.request({ kind: 'save', operationId: randomUUID(), definition: r.definition() })
    await service.request({ kind: 'start', operationId: randomUUID(), entryId: entry.entityId!, expectedRevision: 1 })
    await service.request({ kind: 'setQueueEnabled', operationId: randomUUID(), enabled: true })
    await didEnter
    await service.request({ kind: 'setQueueEnabled', operationId: randomUUID(), enabled: false })
    release({ status: 200, body: { ok: true, identity: IDENTITY, sessionId: 'prepared-session', workspace: r.workspace } })
    await service.flush()
    let manifest = await r.repository.read()
    expect(manifest.submissions[0].handoffState).toBe('waiting')
    expect(manifest.submissions[0].slotHeld).toBe(false)
    expect(r.calls.filter(request => request.kind === 'submit')).toHaveLength(0)
    await service.request({ kind: 'setQueueEnabled', operationId: randomUUID(), enabled: true })
    await service.flush()
    manifest = await r.repository.read()
    expect(manifest.submissions[0].handoffState).toBe('bound')
    expect(newCount).toBe(1)
    expect(r.calls.filter(request => request.kind === 'submit')).toHaveLength(1)
  })

  it('honors a lower concurrency limit while a second session is still being prepared', async () => {
    const r = await rig()
    let entered!: () => void
    const didEnter = new Promise<void>(resolve => { entered = resolve })
    let release!: (reply: TaskHarnessReply) => void
    const lateNew = new Promise<TaskHarnessReply>(resolve => { release = resolve })
    let newCount = 0
    const service = new TaskWorkbenchService({ ...r.options, harness: async request => {
      if (request.kind === 'new' && ++newCount === 2) { entered(); return lateNew }
      return r.options.harness(request)
    } })
    services.add(service)
    await service.initialize()
    for (const title of ['First', 'Second']) {
      const entry = await service.request({ kind: 'save', operationId: randomUUID(), definition: r.definition(title) })
      await service.request({ kind: 'start', operationId: randomUUID(), entryId: entry.entityId!, expectedRevision: 1 })
    }
    await service.request({ kind: 'setQueueEnabled', operationId: randomUUID(), enabled: true, maxActive: 2 })
    await didEnter
    await service.request({ kind: 'setQueueEnabled', operationId: randomUUID(), enabled: true, maxActive: 1 })
    release({ status: 200, body: { ok: true, identity: IDENTITY, sessionId: 'second-session', workspace: r.workspace } })
    await service.flush()
    const manifest = await r.repository.read()
    expect(manifest.submissions[1].handoffState).toBe('waiting')
    expect(manifest.submissions[1].slotHeld).toBe(false)
    expect(r.calls.filter(request => request.kind === 'submit')).toHaveLength(1)
  })

  it('does not submit into a workspace replaced while the native session was being prepared', async () => {
    const r = await rig()
    const workspace = join(r.workspace, 'target')
    await mkdir(workspace)
    let entered!: () => void
    const didEnter = new Promise<void>(resolve => { entered = resolve })
    let release!: (reply: TaskHarnessReply) => void
    const lateNew = new Promise<TaskHarnessReply>(resolve => { release = resolve })
    const service = new TaskWorkbenchService({ ...r.options, harness: async request => {
      if (request.kind === 'new') { entered(); return lateNew }
      return r.options.harness(request)
    } })
    services.add(service)
    await service.initialize()
    const entry = await service.request({ kind: 'save', operationId: randomUUID(), definition: { ...r.definition(), workspace } })
    await service.request({ kind: 'start', operationId: randomUUID(), entryId: entry.entityId!, expectedRevision: 1 })
    await service.request({ kind: 'setQueueEnabled', operationId: randomUUID(), enabled: true })
    await didEnter
    await rename(workspace, join(r.workspace, 'original'))
    await mkdir(workspace)
    release({ status: 200, body: { ok: true, identity: IDENTITY, sessionId: 'prepared-session', workspace } })
    await service.flush()
    expect(r.calls.filter(request => request.kind === 'submit')).toHaveLength(0)
    const item = (await r.repository.read()).submissions[0]
    expect(item.error).toContain('Workspace identity changed')
    expect(item.slotHeld).toBe(true)
  })

  it('releases only the unused admission when a queued workspace is invalid before any native call', async () => {
    const r = await rig()
    const target = join(r.workspace, 'target')
    await mkdir(target)
    const saved = await r.request({ kind: 'save', operationId: randomUUID(), definition: { ...r.definition(), workspace: target, resourceIds: ['unused-resource'] } })
    expect(saved.ok).toBe(true)
    const id = await r.start(saved.entityId!)
    await rm(target, { recursive: true })
    await r.enable()
    const item = (await r.repository.read()).submissions.find(submission => submission.id === id)!
    expect(item.handoffState).toBe('rejected')
    expect(item.slotHeld).toBe(false)
    expect(item.resourcesHeld).toEqual([])
    expect(r.calls).toHaveLength(0)
  })
})
