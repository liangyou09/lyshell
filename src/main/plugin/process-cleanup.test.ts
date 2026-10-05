import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ execFile: vi.fn() }))
vi.mock('child_process', () => ({ execFile: mocks.execFile }))
import { terminatePluginProcess } from './process-cleanup'

const child = (): ChildProcess => Object.assign(new EventEmitter(), {
  pid: 12345, exitCode: null, signalCode: null, kill: vi.fn(() => true)
}) as unknown as ChildProcess

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); mocks.execFile.mockReset() })

describe('插件进程回收', () => {
  it('Windows 等待整棵进程树退出，隐藏 taskkill 窗口', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    let complete: ((error: Error | null) => void) | undefined
    mocks.execFile.mockImplementation((_exe, _args, _opts, callback) => { complete = callback })
    const proc = child()
    let finished = false
    const cleanup = terminatePluginProcess(proc).then(() => { finished = true })
    expect(mocks.execFile).toHaveBeenCalledWith('taskkill', ['/PID', '12345', '/T', '/F'],
      { windowsHide: true, timeout: 5000 }, expect.any(Function))
    expect(finished).toBe(false)
    complete?.(null)
    await cleanup
    expect(finished).toBe(true)
    expect(proc.kill).not.toHaveBeenCalled()
  })

  it('已退出进程不再终止，避免 PID 复用误杀', async () => {
    const proc = child()
    Object.assign(proc, { exitCode: 0 })
    await terminatePluginProcess(proc)
    expect(proc.kill).not.toHaveBeenCalled()
    expect(mocks.execFile).not.toHaveBeenCalled()
  })

  it('非 Windows 先等待优雅退出，超时强制终止', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    vi.useFakeTimers()
    const proc = child()
    const cleanup = terminatePluginProcess(proc)
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
    await vi.advanceTimersByTimeAsync(2500)
    await cleanup
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL')
    expect(proc.listenerCount('close')).toBe(0)
  })

  it('POSIX 根已退出也清理整组，后代未退出时等待到强制终止', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    vi.useFakeTimers()
    const proc = child()
    Object.assign(proc, { exitCode: 0 })
    let finished = false
    const cleanup = terminatePluginProcess(proc, { processGroup: true }).then(() => { finished = true })
    expect(kill).toHaveBeenCalledWith(-12345, 'SIGTERM')
    await vi.advanceTimersByTimeAsync(2400)
    expect(finished).toBe(false)
    await vi.advanceTimersByTimeAsync(100)
    await cleanup
    expect(kill).toHaveBeenCalledWith(-12345, 'SIGKILL')
    expect(proc.kill).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('进程组自然清空就结束，ESRCH 不报错也不再强杀', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const kill = vi.spyOn(process, 'kill').mockReturnValueOnce(true).mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    })
    vi.useFakeTimers()
    const cleanup = terminatePluginProcess(child(), { processGroup: true })
    await vi.advanceTimersByTimeAsync(50)
    await cleanup
    expect(kill).not.toHaveBeenCalledWith(-12345, 'SIGKILL')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('组信号失败不能伪装成清理完成', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) })
    await expect(terminatePluginProcess(child(), { processGroup: true })).rejects.toThrow('denied')
  })

  it('Windows taskkill 失败时报告错误，不能只杀根后回成功', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    mocks.execFile.mockImplementation((_exe, _args, _opts, callback) => callback(new Error('denied')))
    const proc = child()
    await expect(terminatePluginProcess(proc)).rejects.toThrow('denied')
    expect(proc.kill).not.toHaveBeenCalled()
  })

  it.each(['exitCode', 'signalCode'] as const)('Windows 树杀报错前根已退出（%s），本次与后续重试都不能误报成功', async field => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    let complete!: (error: Error | null) => void
    mocks.execFile.mockImplementation((_exe, _args, _opts, callback) => { complete = callback })
    const proc = child()
    const failure = new Error('tree cleanup unconfirmed')
    const cleanup = terminatePluginProcess(proc)
    Object.assign(proc, { [field]: field === 'exitCode' ? 0 : 'SIGTERM' })
    complete(failure)
    await expect(cleanup).rejects.toBe(failure)
    await expect(terminatePluginProcess(proc)).rejects.toBe(failure)
    expect(mocks.execFile).toHaveBeenCalledOnce()
    expect(proc.kill).not.toHaveBeenCalled()
  })

  it('Windows 根仍存活时允许重试，树杀成功后解除失败状态', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    mocks.execFile.mockImplementationOnce((_exe, _args, _opts, callback) => callback(new Error('denied')))
    mocks.execFile.mockImplementationOnce((_exe, _args, _opts, callback) => callback(null))
    const proc = child()
    await expect(terminatePluginProcess(proc)).rejects.toThrow('denied')
    await expect(terminatePluginProcess(proc)).resolves.toBeUndefined()
    Object.assign(proc, { exitCode: 0 })
    await expect(terminatePluginProcess(proc)).resolves.toBeUndefined()
    expect(mocks.execFile).toHaveBeenCalledTimes(2)
  })
})
