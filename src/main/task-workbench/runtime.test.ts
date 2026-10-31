import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const mocks = vi.hoisted(() => ({
  userData: '', phase: 'running', initialize: vi.fn(), request: vi.fn(), observe: vi.fn(), stop: vi.fn(), flush: vi.fn(),
  read: vi.fn(), exportArtifact: vi.fn(), harness: vi.fn(), navigation: vi.fn(), saveDialog: vi.fn(), register: vi.fn()
}))
vi.mock('electron', () => ({ app: { getPath: () => mocks.userData }, dialog: { showSaveDialog: mocks.saveDialog } }))
vi.mock('electron-log', () => ({ default: { warn: vi.fn() } }))
vi.mock('../lifecycle/app-lifecycle', () => ({ businessGate: { get phase() { return mocks.phase } } }))
vi.mock('../dsh/work', () => ({ runHarnessWork: mocks.harness }))
vi.mock('../dsh/activity', () => ({ registerWorkbenchActivityOwner: mocks.register }))
vi.mock('../dsh/activity-navigation', () => ({ navigateWorkbenchActivity: mocks.navigation }))
vi.mock('./repository', () => ({ TaskWorkbenchRepository: class { read = mocks.read } }))
vi.mock('./results', () => ({ TaskWorkbenchResults: class { exportArtifact = mocks.exportArtifact } }))
vi.mock('./service', () => ({ TaskWorkbenchService: class {
  initialize = mocks.initialize; request = mocks.request; observe = mocks.observe; stop = mocks.stop; flush = mocks.flush
} }))

let directory: string
beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.phase = 'running'
  directory = await mkdtemp(join(tmpdir(), 'lyshell-workbench-runtime-'))
  mocks.userData = directory
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

describe('task workbench runtime', () => {
  it('keeps an independent stable owner and refuses damaged scope instead of taking another scope', async () => {
    const { taskWorkbenchOwner } = await import('./runtime')
    const root = join(directory, 'scope')
    const owner = await taskWorkbenchOwner(root)
    expect(owner).toMatch(/^[a-f0-9]{64}$/)
    expect(await taskWorkbenchOwner(root)).toBe(owner)
    const another = await taskWorkbenchOwner(join(directory, 'other'))
    expect(another).not.toBe(owner)
    await writeFile(join(root, 'scope-id'), 'corrupt')
    await expect(taskWorkbenchOwner(root)).rejects.toThrow('invalid')
    expect(await readFile(join(root, 'scope-id'), 'utf8')).toBe('corrupt')
  })

  it('initializes/observes without starting a backend and stops through a synchronous gate', async () => {
    const runtime = await import('./runtime')
    await runtime.initializeTaskWorkbench()
    expect(mocks.initialize).toHaveBeenCalledOnce()
    expect(mocks.register).toHaveBeenCalledOnce()
    await runtime.observeTaskWorkbench()
    expect(mocks.observe).toHaveBeenCalledOnce()
    expect(mocks.harness).not.toHaveBeenCalled()
    runtime.stopTaskWorkbench()
    expect(mocks.stop).toHaveBeenCalledOnce()
    await runtime.observeTaskWorkbench()
    expect(mocks.observe).toHaveBeenCalledOnce()
    expect(await runtime.requestTaskWorkbench({ kind: 'list' })).toMatchObject({ ok: false })
    await runtime.flushTaskWorkbench()
    expect(mocks.flush).toHaveBeenCalledOnce()
  })

  it('never opens a different native attempt', async () => {
    const runtime = await import('./runtime')
    const reference = { sessionId: 's', taskId: 't', attemptId: 'new', executionIdentity: { instanceId: 'backend', instanceEpoch: 10 } }
    mocks.read.mockResolvedValue({ submissions: [{ id: 'submission', nativeExecutionRef: reference }] })
    mocks.harness.mockResolvedValue({ status: 200, body: { ok: true, status: 'idle', sessionId: 's', taskId: 't',
      identity: reference.executionIdentity, task: { ...reference, attemptId: 'old' } } })
    expect(await runtime.requestTaskWorkbench({ kind: 'openNative', submissionId: 'submission' })).toMatchObject({ ok: false })
    expect(mocks.navigation).not.toHaveBeenCalled()
    mocks.harness.mockResolvedValue({ status: 200, body: { ok: true, status: 'idle', sessionId: 's', taskId: 't',
      identity: reference.executionIdentity, task: { ...reference } } })
    mocks.navigation.mockResolvedValue({ success: true, requestId: 'nav', navigation: 'pending' })
    expect(await runtime.requestTaskWorkbench({ kind: 'openNative', submissionId: 'submission' })).toMatchObject({ ok: true })
    expect(mocks.navigation).toHaveBeenCalledWith({ kind: 'open', identity: reference.executionIdentity, sessionId: 's' })
  })

  it('does not export an artifact after the application starts draining during a dialog', async () => {
    const runtime = await import('./runtime')
    mocks.read.mockResolvedValue({ results: [{ artifacts: [{ artifactId: 'artifact', name: '../result.md' }] }] })
    mocks.saveDialog.mockImplementation(async () => { mocks.phase = 'draining'; return { canceled: false, filePath: join(directory, 'result.md') } })
    expect(await runtime.requestTaskWorkbench({ kind: 'exportArtifact', artifactId: 'artifact' })).toMatchObject({ ok: false })
    expect(mocks.exportArtifact).not.toHaveBeenCalled()
  })
})
