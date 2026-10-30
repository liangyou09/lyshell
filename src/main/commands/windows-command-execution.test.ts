import { EventEmitter } from 'events'
import { describe, expect, it, vi, type Mock } from 'vitest'
import { OperationError } from '@shared/operation'
import type { CommandWorkerRequest } from './command-worker-protocol'
import {
  createWindowsCommandExecution,
  type WindowsCommandDeps,
  type WindowsCommandOptions,
  type WindowsHelperProcess
} from './windows-command-execution'
import type { DshProcessJob } from '../dsh/windows-job'

class FakeHelper extends EventEmitter implements WindowsHelperProcess {
  pid = 4321
  sent: CommandWorkerRequest[] = []
  sendResult = true
  sendError?: Error
  autoExitOnKill = true
  killResult = true
  kill = vi.fn(() => {
    if (this.killResult && this.autoExitOnKill) queueMicrotask(() => this.emit('exit', null, 'SIGTERM'))
    return this.killResult
  })
  send(message: CommandWorkerRequest): boolean {
    this.sent.push(message)
    if (this.sendError) throw this.sendError
    return this.sendResult
  }
}

function fakeJob(active: () => number | undefined): DshProcessJob & {
  terminate: Mock<[], boolean>
  close: Mock<[], boolean>
} {
  return {
    terminate: vi.fn<[], boolean>(() => true),
    close: vi.fn<[], boolean>(() => true),
    activeProcesses: active
  }
}

interface HarnessOptions extends Partial<WindowsCommandOptions> {
  job?: DshProcessJob
  attachResult?: DshProcessJob | null
  spawnError?: Error
  autoExitOnKill?: boolean
  killResult?: boolean
}

function harness(options: HarnessOptions = {}) {
  const helper = new FakeHelper()
  helper.autoExitOnKill = options.autoExitOnKill ?? true
  helper.killResult = options.killResult ?? true
  const attach = vi.fn(() => options.job ?? null)
  const spawnHelper = vi.fn(() => {
    if (options.spawnError) throw options.spawnError
    return helper
  })
  const deps: WindowsCommandDeps = {
    workerScriptPath: 'C:/build/localCommandWorker.js',
    attachJob: options.attachResult !== undefined ? () => options.attachResult ?? null : attach,
    spawnHelper,
    pollIntervalMs: 1,
    readyTimeoutMs: 2_000,
    now: () => Date.now()
  }
  const execution = createWindowsCommandExecution({
    command: 'run',
    treeSettleMs: 10,
    terminationConfirmMs: 50,
    ...options
  }, deps)
  // 结果可早于资源关闭失败；立即观察拒绝，不改变调用方稍后 await 原 promise 的语义。
  void execution.result.catch(() => {})
  return { helper, attach, spawnHelper, execution }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('createWindowsCommandExecution', () => {
  it('Job 验证通过且 helper ready 之前不发送 start', async () => {
    let active = 1
    const job = fakeJob(() => active)
    const { helper, attach, execution } = harness({ job })
    expect(attach).toHaveBeenCalledWith(4321, expect.any(Number))
    expect(helper.sent).toHaveLength(0)

    helper.emit('message', { type: 'ready', pid: 4321 })
    expect(helper.sent).toEqual([expect.objectContaining({ type: 'start', command: 'run' })])

    helper.emit('message', { type: 'ready', pid: 4321 })
    expect(helper.sent).toHaveLength(1)

    helper.emit('message', { type: 'started', pid: 9 })
    active = 0
    helper.emit('message', { type: 'exit', code: 0, signal: null })
    await expect(execution.result).resolves.toEqual({ output: '', exitCode: 0 })
    await expect(execution.resourceClosed).resolves.toMatchObject({ state: 'closed' })
  })

  it('Job 绑定失败：不发送 start，明确拒绝并清理 helper', async () => {
    const { helper, execution } = harness({ attachResult: null })
    await expect(execution.result).rejects.toThrow(/Job Object could not be verified/)
    await expect(execution.resourceClosed).resolves.toEqual({
      state: 'closed',
      localClosed: true,
      remoteTerminated: 'not-dispatched'
    })
    expect(helper.sent).toHaveLength(0)
    expect(helper.kill).toHaveBeenCalled()
  })

  it('Job 查询不可用或活跃数为 0：同样视为绑定失败，绝不无 Job 执行', async () => {
    const undefinedQuery = harness({ job: { terminate: vi.fn(), close: vi.fn() } as unknown as DshProcessJob })
    await expect(undefinedQuery.execution.result).rejects.toThrow(/Job Object could not be verified/)
    expect(undefinedQuery.helper.sent).toHaveLength(0)

    const emptyJob = harness({ job: fakeJob(() => 0) })
    await expect(emptyJob.execution.result).rejects.toThrow(/Job Object could not be verified/)
    expect(emptyJob.helper.sent).toHaveLength(0)
    expect(emptyJob.helper.kill).toHaveBeenCalled()
  })

  it('分片 UTF-8、stderr 与真实非零退出码', async () => {
    let active = 1
    const job = fakeJob(() => active)
    const chunks: string[] = []
    const { helper, execution } = harness({
      job,
      treeSettleMs: 5,
      terminationConfirmMs: 20,
      onData: chunk => chunks.push(chunk)
    })

    helper.emit('message', { type: 'ready', pid: 4321 })
    const bytes = Buffer.from('中文')
    helper.emit('message', { type: 'stdout', data: bytes.subarray(0, 1).toString('base64') })
    helper.emit('message', { type: 'stderr', data: Buffer.from('err').toString('base64') })
    helper.emit('message', { type: 'stdout', data: bytes.subarray(1).toString('base64') })
    active = 0
    helper.emit('message', { type: 'exit', code: 7, signal: null })

    await expect(execution.result).resolves.toEqual({ output: 'err中文', exitCode: 7 })
    await expect(execution.resourceClosed).resolves.toEqual({ state: 'closed', localClosed: true, remoteTerminated: 'confirmed' })
    expect(chunks.join('')).toBe('err中文')
  })

  it('helper 在 start 前退出：not-dispatched，不声称执行过命令', async () => {
    let active = 1
    const job = fakeJob(() => active)
    const { helper, execution } = harness({ job })
    active = 0
    helper.emit('exit', 3, null)
    await expect(execution.result).rejects.toThrow(/helper exited before the command started/)
    await expect(execution.resourceClosed).resolves.toMatchObject({ state: 'closed', remoteTerminated: 'not-dispatched' })
    expect(helper.sent).toHaveLength(0)
  })

  it('根进程退出但 Job 仍有后代：terminate 后 ActiveProcesses=0 才归还名额', async () => {
    let active = 2
    const job = fakeJob(() => active)
    const { helper, execution } = harness({ job, treeSettleMs: 5, terminationConfirmMs: 100 })
    helper.emit('message', { type: 'ready', pid: 4321 })
    helper.emit('message', { type: 'exit', code: 0, signal: null })

    await expect(execution.result).resolves.toEqual({ output: '', exitCode: 0 })
    let closed = false
    void execution.resourceClosed.then(() => { closed = true })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(closed).toBe(false)
    expect(job.terminate).toHaveBeenCalledTimes(1)

    active = 0
    await expect(execution.resourceClosed).resolves.toEqual({ state: 'closed', localClosed: true, remoteTerminated: 'confirmed' })
  })

  it('Job 始终非空：关闭未确认，保持名额', async () => {
    const job = fakeJob(() => 3)
    const { helper, execution } = harness({ job, treeSettleMs: 5, terminationConfirmMs: 30 })
    helper.emit('message', { type: 'ready', pid: 4321 })
    helper.emit('message', { type: 'exit', code: 1, signal: null })

    await expect(execution.result).resolves.toEqual({ output: '', exitCode: 1 })
    await expect(execution.resourceClosed).resolves.toMatchObject({
      state: 'unconfirmed',
      localClosed: true,
      remoteTerminated: 'unknown',
      detail: expect.stringMatching(/Windows job still reported 3 process/)
    })
    expect(job.close).not.toHaveBeenCalled()
  })

  it('ActiveProcesses 查询失败：关闭未确认', async () => {
    let active: number | undefined = 1
    const job = fakeJob(() => active)
    const { helper, execution } = harness({ job, treeSettleMs: 5 })
    helper.emit('message', { type: 'ready', pid: 4321 })
    expect(helper.sent).toHaveLength(1)
    active = undefined
    helper.emit('message', { type: 'exit', code: 0, signal: null })
    await expect(execution.result).resolves.toEqual({ output: '', exitCode: 0 })
    await expect(execution.resourceClosed).resolves.toMatchObject({
      state: 'unconfirmed',
      remoteTerminated: 'unknown',
      detail: 'Job object query failed'
    })
    expect(job.terminate).toHaveBeenCalled()
    expect(job.close).not.toHaveBeenCalled()
  })

  it('运行中取消：结果先失败，Job 空后关闭；迟到帧与重复取消幂等', async () => {
    let active = 1
    const job = fakeJob(() => active)
    const { helper, execution } = harness({ job })
    helper.emit('message', { type: 'ready', pid: 4321 })
    helper.emit('message', { type: 'started', pid: 99 })

    execution.cancel('client')
    await expect(execution.result).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', retryDisposition: 'reconcile-first', reason: 'COMMAND_CANCELLED' })
    expect(job.terminate).toHaveBeenCalledTimes(1)

    execution.cancel('client')
    helper.emit('message', { type: 'exit', code: 0, signal: null })
    helper.emit('exit', 0, null)
    expect(job.terminate).toHaveBeenCalledTimes(1)

    active = 0
    await expect(execution.resourceClosed).resolves.toMatchObject({ state: 'closed', remoteTerminated: 'confirmed' })
  })

  it('超时先失败结果，但 Job 未空时关闭保持未确认', async () => {
    const job = fakeJob(() => 2)
    const { helper, execution } = harness({ job, timeoutMs: 5, terminationConfirmMs: 20 })
    helper.emit('message', { type: 'ready', pid: 4321 })
    await expect(execution.result).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', retryDisposition: 'reconcile-first', reason: 'COMMAND_TIMEOUT' })
    await expect(execution.resourceClosed).resolves.toMatchObject({
      state: 'unconfirmed',
      remoteTerminated: 'unknown',
      detail: expect.stringMatching(/still reported 2 process/)
    })
    expect(job.terminate).toHaveBeenCalled()
  })

  it('start send=false 只表示IPC背压：保留已派发语义，取消后等Job为空才能关闭', async () => {
    let active = 1
    const job = fakeJob(() => active)
    const { helper, execution } = harness({ job })
    helper.sendResult = false
    helper.emit('message', { type: 'ready', pid: 4321 })
    let resultSettled = false
    void execution.result.then(() => { resultSettled = true }, () => { resultSettled = true })
    let closed = false
    void execution.resourceClosed.then(() => { closed = true })
    await flush()
    expect(helper.sent).toEqual([expect.objectContaining({ type: 'start', command: 'run' })])
    expect(resultSettled).toBe(false)
    execution.cancel('client')
    await expect(execution.result).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', retryDisposition: 'reconcile-first', reason: 'COMMAND_CANCELLED' })
    await flush()
    expect(closed).toBe(false)
    expect(job.terminate).toHaveBeenCalledOnce()
    active = 0
    await expect(execution.resourceClosed).resolves.toMatchObject({ state: 'closed', localClosed: true, remoteTerminated: 'confirmed' })
    await flush()
  })

  it('start send 抛错后也可能已派发，固定unknown且不泄露传输异常原文', async () => {
    let active = 1
    const job = fakeJob(() => active)
    const { helper, execution } = harness({ job })
    helper.sendError = new Error('fixture-secret-in-ipc-error')
    helper.emit('message', { type: 'ready', pid: 4321 })
    const error = await execution.result.then(() => null, (error: unknown) => error)
    expect(error).toMatchObject({ code: 'OUTCOME_UNKNOWN', retryDisposition: 'reconcile-first' })
    expect(String(error)).not.toContain('fixture-secret-in-ipc-error')
    expect(helper.sent).toHaveLength(1)
    let closed = false
    void execution.resourceClosed.then(() => { closed = true })
    await flush()
    expect(closed).toBe(false)
    active = 0
    await expect(execution.resourceClosed).resolves.toMatchObject({ state: 'closed', localClosed: true })
  })

  it('Job绑定失败后kill只提出请求，无Job时必须等helper实际exit再确认关闭', async () => {
    const { helper, execution } = harness({ attachResult: null, autoExitOnKill: false })
    await expect(execution.result).rejects.toThrow(/Job Object could not be verified/)
    expect(helper.kill).toHaveBeenCalled()
    expect(helper.sent).toHaveLength(0)
    let closed = false
    void execution.resourceClosed.then(() => { closed = true })
    await flush()
    expect(closed).toBe(false)
    helper.emit('exit', null, 'SIGTERM')
    await expect(execution.resourceClosed).resolves.toMatchObject({ state: 'closed', localClosed: true, remoteTerminated: 'not-dispatched' })
  })

  it('helper kill成功但没有exit证据时关闭未确认，不伪造清理完成', async () => {
    const { helper, execution } = harness({ attachResult: null, autoExitOnKill: false, terminationConfirmMs: 15 })
    await expect(execution.result).rejects.toThrow(/Job Object could not be verified/)
    expect(helper.kill).toHaveBeenCalled()
    await expect(execution.resourceClosed).resolves.toMatchObject({ state: 'unconfirmed', localClosed: false })
    expect(helper.sent).toHaveLength(0)
    helper.emit('exit', null, 'SIGTERM')
  })

  it('Job已明确为空但Job.close失败，仍保留本地关闭未确认', async () => {
    let active = 1
    const job = fakeJob(() => active)
    job.close.mockReturnValue(false)
    const { helper, execution } = harness({ job })
    helper.emit('message', { type: 'ready', pid: 4321 })
    active = 0
    helper.emit('message', { type: 'exit', code: 0, signal: null })
    await expect(execution.result).resolves.toEqual({ output: '', exitCode: 0 })
    await expect(execution.resourceClosed).resolves.toMatchObject({ state: 'unconfirmed', localClosed: false })
    expect(job.close).toHaveBeenCalled()
  })

  it('输出预算失败保留固定OUTPUT_LIMIT与有界片段，资源等Job为空', async () => {
    let active = 1
    let reserved = 0
    const job = fakeJob(() => active)
    const { helper, execution } = harness({ job, reserveBytes: bytes => {
      if (reserved + bytes > 4) throw new OperationError('RESOURCE_LIMIT', 'fixture budget reached', 'never')
      reserved += bytes
    } })
    helper.emit('message', { type: 'ready', pid: 4321 })
    helper.emit('message', { type: 'stdout', data: Buffer.from('ok').toString('base64') })
    helper.emit('message', { type: 'stderr', data: Buffer.from('too much').toString('base64') })
    await expect(execution.result).rejects.toMatchObject({
      code: 'OUTCOME_UNKNOWN', retryDisposition: 'reconcile-first', reason: 'OUTPUT_LIMIT', partialOutput: 'ok'
    })
    let closed = false
    void execution.resourceClosed.then(() => { closed = true })
    await flush()
    expect(closed).toBe(false)
    expect(job.terminate).toHaveBeenCalledOnce()
    active = 0
    await expect(execution.resourceClosed).resolves.toMatchObject({ state: 'closed', remoteTerminated: 'confirmed' })
  })
})
