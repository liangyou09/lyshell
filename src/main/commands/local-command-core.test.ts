import { EventEmitter } from 'events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OperationError } from '@shared/operation'

const { spawnMock, terminateMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  terminateMock: vi.fn()
}))

vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args)
}))
vi.mock('../plugin/process-cleanup', () => ({
  terminatePluginProcess: (...args: unknown[]) => terminateMock(...args)
}))
vi.mock('electron-log', () => ({
  default: { info: vi.fn(), warn: vi.fn() }
}))

import { createLocalCommandExecution } from './local-command-core'

interface FakeChild extends EventEmitter {
  pid?: number
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  stdout: EventEmitter & { destroy: () => void; destroyed: boolean }
  stderr: EventEmitter & { destroy: () => void; destroyed: boolean }
}

function fakeChild(pid = 4242): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.pid = pid
  child.exitCode = null
  child.signalCode = null
  const stream = (): FakeChild['stdout'] => {
    const emitter = new EventEmitter() as FakeChild['stdout']
    emitter.destroyed = false
    emitter.destroy = vi.fn(() => { emitter.destroyed = true })
    return emitter
  }
  child.stdout = stream()
  child.stderr = stream()
  return child
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** 这些用例覆盖 POSIX 进程组分支；Windows 走独立的 Job helper（见 windows-command-execution.test.ts）。 */
const create = (options: Parameters<typeof createLocalCommandExecution>[0]) =>
  createLocalCommandExecution(options, { platform: 'linux' })

beforeEach(() => {
  spawnMock.mockReset()
  terminateMock.mockReset()
})

describe('createLocalCommandExecution', () => {
  it('合并 stdout+stderr、增量 UTF-8、真实 exitCode', async () => {
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    const chunks: string[] = []
    const execution = create({
      command: 'run',
      onData: chunk => chunks.push(chunk),
      timeoutMs: 5_000,
      probeTreeGone: () => true
    })
    const bytes = Buffer.from('中文')
    child.stdout.emit('data', bytes.subarray(0, 2))
    child.stderr.emit('data', Buffer.from('err'))
    child.stdout.emit('data', bytes.subarray(2))
    child.emit('close', 7)

    await expect(execution.result).resolves.toEqual({ output: 'err中文', exitCode: 7 })
    await expect(execution.resourceClosed).resolves.toEqual({ state: 'closed', localClosed: true, remoteTerminated: 'confirmed' })
    expect(chunks.join('')).toBe('err中文')
  })

  it('调用前已取消：不 spawn、明确 not-dispatched', async () => {
    const controller = new AbortController()
    controller.abort()
    const execution = create({ command: 'run', signal: controller.signal })
    await expect(execution.result).rejects.toThrow('Command aborted')
    await expect(execution.resourceClosed).resolves.toEqual({ state: 'closed', localClosed: true, remoteTerminated: 'not-dispatched' })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('超时先失败结果，进程树确认退出后才结算关闭', async () => {
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    const termination = deferred<void>()
    terminateMock.mockReturnValue(termination.promise)
    const execution = create({ command: 'run', timeoutMs: 5, probeTreeGone: () => true })

    await expect(execution.result).rejects.toThrow(/timeout after 5ms/)
    let closeSettled = false
    void execution.resourceClosed.then(() => { closeSettled = true })
    await Promise.resolve()
    expect(closeSettled).toBe(false)
    expect(terminateMock).toHaveBeenCalledTimes(1)
    termination.resolve()
    await expect(execution.resourceClosed).resolves.toEqual({ state: 'closed', localClosed: true, remoteTerminated: 'confirmed' })
  })

  it('清理失败保持名额（关闭未确认）并给出原因', async () => {
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    terminateMock.mockRejectedValue(new Error('taskkill failed'))
    const execution = create({ command: 'run', timeoutMs: 5 })

    await expect(execution.result).rejects.toThrow(/timeout/)
    await expect(execution.resourceClosed).resolves.toEqual({
      state: 'failed',
      localClosed: false,
      remoteTerminated: 'unknown',
      detail: 'taskkill failed'
    })
  })

  it('输出预算超限：拒绝结果保留 partialOutput，且只清理一次', async () => {
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    terminateMock.mockResolvedValue(undefined)
    const execution = create({
      command: 'run',
      reserveBytes: delta => {
        throw new OperationError('RESOURCE_LIMIT', `Command output limit exceeded (batch max 3 bytes) after ${delta}`, 'never')
      },
      probeTreeGone: () => true
    })
    child.stdout.emit('data', Buffer.from('abcd'))

    await expect(execution.result).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT',
      partialOutput: ''
    })
    await expect(execution.resourceClosed).resolves.toMatchObject({ state: 'closed' })
    expect(terminateMock).toHaveBeenCalledTimes(1)
  })

  it('spawn 同步抛错：未派发、不清理进程', async () => {
    spawnMock.mockImplementation(() => { throw new Error('spawn ENOENT') })
    const execution = create({ command: 'run' })
    await expect(execution.result).rejects.toThrow('spawn ENOENT')
    await expect(execution.resourceClosed).resolves.toEqual({ state: 'closed', localClosed: true, remoteTerminated: 'not-dispatched' })
    expect(terminateMock).not.toHaveBeenCalled()
  })

  it('运行中取消：terminate 一次，保留取消原因', async () => {
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    terminateMock.mockResolvedValue(undefined)
    const execution = create({ command: 'run', probeTreeGone: () => true })
    execution.cancel('client')
    await expect(execution.result).rejects.toThrow('Command aborted')
    await expect(execution.resourceClosed).resolves.toMatchObject({ state: 'closed' })
    expect(terminateMock).toHaveBeenCalledTimes(1)
    execution.cancel('client')
    expect(terminateMock).toHaveBeenCalledTimes(1)
  })

  it('terminate 已 resolve 但进程树仍在：不宣称关闭，探测确认后才 closed', async () => {
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    terminateMock.mockResolvedValue(undefined)
    const probes: Array<(gone: boolean) => void> = []
    const execution = create({
      command: 'run',
      timeoutMs: 5,
      probeTreeGone: () => new Promise<boolean>(resolve => { probes.push(resolve) })
    })

    await expect(execution.result).rejects.toThrow(/timeout after 5ms/)
    await vi.waitFor(() => expect(probes.length).toBeGreaterThan(0))
    let closedSettled = false
    void execution.resourceClosed.then(() => { closedSettled = true })
    await Promise.resolve()
    // terminatePluginProcess 已 resolve，但独立探测未确认前不得报告 closed。
    expect(closedSettled).toBe(false)
    probes.shift()?.(true)

    await expect(execution.resourceClosed).resolves.toEqual({
      state: 'closed',
      localClosed: true,
      remoteTerminated: 'confirmed'
    })
  })

  it('进程树持续存在：关闭记为 unconfirmed 并保留名额', async () => {
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    terminateMock.mockResolvedValue(undefined)
    const execution = create({
      command: 'run',
      timeoutMs: 5,
      terminationConfirmMs: 40,
      probeTreeGone: () => false
    })

    await expect(execution.result).rejects.toThrow(/timeout after 5ms/)
    await expect(execution.resourceClosed).resolves.toMatchObject({
      state: 'unconfirmed',
      localClosed: true,
      remoteTerminated: 'unknown',
      detail: expect.stringMatching(/Local process tree was still present 40ms/)
    })
  })

  it('根进程 close 后仍有后台组：结果立即可用，但整树关闭不伪报 confirmed', async () => {
    const child = fakeChild()
    spawnMock.mockReturnValue(child)
    const execution = create({
      command: 'run',
      treeSettleMs: 20,
      probeTreeGone: () => false
    })
    child.emit('close', 0)

    await expect(execution.result).resolves.toEqual({ output: '', exitCode: 0 })
    await expect(execution.resourceClosed).resolves.toMatchObject({
      state: 'unconfirmed',
      localClosed: true,
      remoteTerminated: 'unknown',
      detail: expect.stringMatching(/Background processes were still alive 20ms/)
    })
    expect(terminateMock).not.toHaveBeenCalled()
  })

  it('win32 路由到 Job 实现，不触发 POSIX spawn', async () => {
    const windowsExecution = vi.fn(() => ({
      result: Promise.resolve({ output: 'win', exitCode: 0 }),
      resourceClosed: Promise.resolve({ state: 'closed' as const, localClosed: true, remoteTerminated: 'confirmed' as const }),
      cancel: vi.fn()
    }))
    const execution = createLocalCommandExecution({ command: 'run' }, { platform: 'win32', windowsExecution })

    expect(windowsExecution).toHaveBeenCalledTimes(1)
    expect(spawnMock).not.toHaveBeenCalled()
    await expect(execution.result).resolves.toEqual({ output: 'win', exitCode: 0 })
  })
})
