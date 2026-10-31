import { app, dialog, type BrowserWindow } from 'electron'
import { createHash, randomBytes } from 'crypto'
import { lstat, mkdir, open, readFile } from 'fs/promises'
import { join } from 'path'
import log from 'electron-log'
import type { TaskWorkbenchReply, TaskWorkbenchRequest, NativeExecutionRef } from '@shared/task-workbench'
import type { ActivityNavigationResult } from '@shared/activity-navigation'
import { runHarnessWork } from '../dsh/work'
import { registerWorkbenchActivityOwner } from '../dsh/activity'
import { navigateWorkbenchActivity } from '../dsh/activity-navigation'
import { businessGate } from '../lifecycle/app-lifecycle'
import { TaskWorkbenchRepository } from './repository'
import { TaskWorkbenchResults } from './results'
import { TaskWorkbenchService } from './service'

interface TaskWorkbenchRuntime {
  owner: string
  repository: TaskWorkbenchRepository
  results: TaskWorkbenchResults
  service: TaskWorkbenchService
}

let runtime: TaskWorkbenchRuntime | undefined
let initialization: Promise<TaskWorkbenchRuntime> | undefined
let stopped = false
const gate = (): boolean => !stopped && businessGate.phase === 'running'

/** 专有业务 scope；不使用外部 global/session token，不接管其会话。 */
export async function taskWorkbenchOwner(rootDir: string): Promise<string> {
  await mkdir(rootDir, { recursive: true })
  const root = await lstat(rootDir)
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Task workbench storage directory is unsafe')
  const file = join(rootDir, 'scope-id')
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(file, 'wx', 0o600)
    await handle.writeFile(randomBytes(32).toString('hex'), 'utf8')
    await handle.sync()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('Task workbench scope is unavailable')
  } finally { await handle?.close() }
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.size !== 64) throw new Error('Task workbench scope is invalid')
  const value = await readFile(file, 'utf8')
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Task workbench scope is invalid')
  return createHash('sha256').update('lyshell-task-workbench-v1\0').update(value).digest('hex')
}

async function getRuntime(): Promise<TaskWorkbenchRuntime> {
  if (!initialization) initialization = (async () => {
    if (!gate()) throw new Error('Task workbench is shutting down')
    const rootDir = join(app.getPath('userData'), 'task-workbench')
    const owner = await taskWorkbenchOwner(rootDir)
    const repository = new TaskWorkbenchRepository(rootDir)
    const results = new TaskWorkbenchResults(rootDir)
    const service = new TaskWorkbenchService({ repository, results, gate,
      harness: request => runHarnessWork(owner, request, gate) })
    const value = { owner, repository, results, service }
    runtime = value
    await service.initialize()
    registerWorkbenchActivityOwner(owner)
    if (!gate()) service.stop()
    return value
  })()
  return initialization
}

/** 启动只读取并暂停业务队列，不 acquire/recover Harness。业务损坏不阻断终端启动。 */
export async function initializeTaskWorkbench(): Promise<void> {
  try { await getRuntime() }
  catch { log.warn('[task-workbench] Business storage unavailable; new work is blocked') }
}

/** 同步撤销派发许可；即使服务还在异步准备中，gate 也立即失效。 */
export function stopTaskWorkbench(): void {
  stopped = true
  runtime?.service.stop()
}

export async function flushTaskWorkbench(): Promise<void> {
  if (runtime) await runtime.service.flush()
}

/** 由已有活动轮询唤醒，不建立第二个 timer。失败不污染原生/Web/TUI 观察。 */
export async function observeTaskWorkbench(): Promise<TaskWorkbenchReply | undefined> {
  if (!gate() || !initialization) return undefined
  try {
    const value = await getRuntime()
    await value.service.observe()
    return await value.service.request({ kind: 'list' })
  } catch { return undefined }
}

function matchesExecution(task: Record<string, unknown>, reference: NativeExecutionRef): boolean {
  const identity = task.executionIdentity as { instanceId?: unknown; instanceEpoch?: unknown } | undefined
  return task.sessionId === reference.sessionId && task.taskId === reference.taskId &&
    (reference.attemptId === undefined || task.attemptId === reference.attemptId) &&
    (reference.executionSessionId === undefined || task.executionSessionId === reference.executionSessionId) &&
    identity?.instanceId === reference.executionIdentity.instanceId && identity.instanceEpoch === reference.executionIdentity.instanceEpoch
}

export async function requestTaskWorkbench(
  request: TaskWorkbenchRequest, parent?: BrowserWindow
): Promise<TaskWorkbenchReply> {
  try {
    const value = await getRuntime()
    if (!gate()) return { ok: false, error: 'Task workbench is shutting down' }
    if (request.kind === 'exportArtifact') {
      const manifest = await value.repository.read()
      const artifact = manifest.results.flatMap(bundle => bundle.artifacts).find(item => item.artifactId === request.artifactId)
      if (!artifact) return { ok: false, error: 'Artifact was not found' }
      const safeName = [...artifact.name.replace(/[<>:"/\\|?*]/g, '_')]
        .map(character => character.charCodeAt(0) < 32 ? '_' : character).join('')
      const options = { title: 'Export task artifact', defaultPath: safeName }
      const choice = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
      if (choice.canceled || !choice.filePath) return { ok: false, error: 'Export cancelled' }
      if (!gate() || parent?.isDestroyed()) return { ok: false, error: 'Task workbench is shutting down' }
      await value.results.exportArtifact(artifact, choice.filePath)
      return { ok: true, entityId: artifact.artifactId }
    }
    if (request.kind === 'openNative') {
      const manifest = await value.repository.read()
      const submission = manifest.submissions.find(item => item.id === request.submissionId)
      const reference = submission?.nativeExecutionRef
      if (!reference) return { ok: false, error: 'This submission has no confirmed native execution' }
      const fresh = await runHarnessWork(value.owner, { kind: 'state', sessionId: reference.sessionId, taskId: reference.taskId }, gate)
      const task = fresh.body.task as Record<string, unknown> | undefined
      const identity = fresh.body.identity as { instanceId: string; instanceEpoch: number } | undefined
      if (!gate() || fresh.body.ok !== true || fresh.body.status === 'offline' || fresh.body.sessionId !== reference.sessionId ||
        fresh.body.taskId !== reference.taskId || !identity || typeof identity.instanceId !== 'string' ||
        !Number.isSafeInteger(identity.instanceEpoch) || identity.instanceEpoch < 1 || !task || !matchesExecution(task, reference)) {
        return { ok: false, error: 'Native execution is unavailable or changed; inspect this submission first' }
      }
      const navigation: ActivityNavigationResult = await navigateWorkbenchActivity({ kind: 'open', identity, sessionId: reference.sessionId })
      return navigation.success ? { ok: true, navigation } : { ok: false, error: navigation.error }
    }
    return await value.service.request(request)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Task workbench unavailable' }
  }
}
