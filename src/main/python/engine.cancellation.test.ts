import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PythonEngine, type ExecutionContext } from './engine'

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('child_process', () => ({ spawn: mocks.spawn }))
vi.mock('fs', () => ({ existsSync: () => true }))
vi.mock('electron', () => ({ app: { getPath: () => process.cwd() } }))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    pid: 12345, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn()
  })
  mocks.spawn.mockReturnValue(child)
  const engine = new PythonEngine()
  engine.setPythonPath('python')
  const close = () => {
    child.signalCode = 'SIGTERM'
    child.emit('exit', null, 'SIGTERM')
    child.emit('close', null, 'SIGTERM')
  }
  return { engine, child, close }
}

beforeEach(() => { vi.useFakeTimers(); mocks.spawn.mockReset() })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe.each(['execute', 'runScript'] as const)('PythonEngine.%s 进程树取消', method => {
  function run(engine: PythonEngine, context: ExecutionContext) {
    return method === 'execute' ? engine.execute('pass', context) : engine.runScript('test.py', [], context)
  }

  it('超时在根进程存活时回收整棵树，close 和重复 abort 都等待同一清理回执', async () => {
    const { engine, child, close } = fixture()
    const controller = new AbortController()
    let finish!: () => void
    const onCancel = vi.fn((proc: ChildProcess) => {
      expect(proc.signalCode).toBeNull()
      close()
      return new Promise<void>(resolve => { finish = resolve })
    })
    let settled = false
    const result = run(engine, { timeout: 100, signal: controller.signal, onCancel }).then(value => { settled = true; return value })
    expect(mocks.spawn.mock.calls[0][2].timeout).toBeUndefined()
    await vi.advanceTimersByTimeAsync(99)
    expect(onCancel).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(onCancel).toHaveBeenCalledWith(child)
    controller.abort()
    expect(onCancel).toHaveBeenCalledOnce()
    expect(child.kill).not.toHaveBeenCalled()
    expect(settled).toBe(false)
    finish()
    expect((await result).signal).toBe('SIGTERM')
  })

  it('根进程 close 不能把进程树清理失败误报为成功', async () => {
    const { engine, close } = fixture()
    const onCancel = vi.fn(() => { close(); return Promise.reject(new Error('tree cleanup failed')) })
    const result = run(engine, { timeout: 100, onCancel })
    const check = expect(result).rejects.toThrow('tree cleanup failed')
    await vi.advanceTimersByTimeAsync(100)
    await check
  })

  it('自然退出取消超时定时器，不再请求清理', async () => {
    const { engine, child } = fixture()
    const onCancel = vi.fn()
    const result = run(engine, { timeout: 100, onCancel })
    child.exitCode = 0
    child.emit('exit', 0, null)
    child.emit('close', 0, null)
    expect((await result).exitCode).toBe(0)
    await vi.advanceTimersByTimeAsync(200)
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('启动前已取消时，同步 close 不丢失，执行仍等待清理回执', async () => {
    const { engine, close } = fixture()
    const controller = new AbortController()
    controller.abort()
    let finish!: () => void
    const onCancel = vi.fn(() => {
      close()
      return new Promise<void>(resolve => { finish = resolve })
    })
    let settled = false
    const result = run(engine, { signal: controller.signal, onCancel }).then(value => { settled = true; return value })
    await vi.advanceTimersByTimeAsync(0)
    expect(onCancel).toHaveBeenCalledOnce()
    expect(settled).toBe(false)
    finish()
    expect((await result).signal).toBe('SIGTERM')
  })

  it('普通执行保留原生 timeout，abort 仍终止根进程', async () => {
    const { engine, child, close } = fixture()
    const controller = new AbortController()
    const result = run(engine, { timeout: 100, signal: controller.signal })
    expect(mocks.spawn.mock.calls[0][2].timeout).toBe(100)
    controller.abort()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    close()
    await result
  })
})
