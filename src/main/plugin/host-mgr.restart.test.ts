import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginSpec } from '@shared/plugin-types'

const mocks = vi.hoisted(() => ({ terminate: vi.fn(), bindToken: vi.fn(), port: null as number | null, enabled: ['plugin'] }))
vi.mock('./process-cleanup', () => ({ terminatePluginProcess: mocks.terminate }))
vi.mock('electron', () => ({ app: {} }))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@main/storage/plugin-repository', () => ({ pluginRepository: { getEnabled: () => mocks.enabled.map(id => ({ id })) }, getPluginsDir: vi.fn() }))
vi.mock('@main/mcp/auth', () => ({ revokePluginToken: vi.fn(), bindPluginToken: mocks.bindToken }))
vi.mock('@main/mcp/http-server', () => ({ getMcpHttpPort: () => mocks.port }))
vi.mock('@main/python/engine', () => ({ pythonEngine: {} }))
vi.mock('@main/plugin/view-registry', () => ({ getPluginViewRegistry: () => ({ clearRuntimeForPlugins: vi.fn() }) }))
import { PluginHostManager } from './host-mgr'

function pendingCleanup() {
  const manager = new PluginHostManager()
  const child = Object.assign(new EventEmitter(), { pid: 12345, killed: false, exitCode: null, signalCode: null }) as ChildProcess
  ;(manager as unknown as { child: ChildProcess }).child = child
  const start = vi.spyOn(manager, 'start').mockImplementation(() => {})
  let finish!: () => void
  mocks.terminate.mockReturnValue(new Promise<void>(resolve => { finish = resolve }))
  return { manager, start, finish }
}

beforeEach(() => { mocks.port = null; mocks.enabled = ['plugin']; mocks.bindToken.mockReset() })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); mocks.terminate.mockReset() })

describe('插件宿主重启顺序', () => {
  it('取消回调返回共享树清理任务，执行方与宿主都等待实际完成', async () => {
    const { manager, finish } = pendingCleanup()
    const internal = manager as unknown as { child: ChildProcess; terminateProcess(child: ChildProcess): Promise<void> }
    const cleanup = internal.terminateProcess(internal.child)
    expect(internal.terminateProcess(internal.child)).toBe(cleanup)
    let settled = false
    const waiting = manager.waitForProcessCleanup().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(mocks.terminate).toHaveBeenCalledOnce()
    finish()
    await Promise.all([cleanup, waiting])
    expect(settled).toBe(true)
  })

  it('旧进程树清理完成前不启动新宿主', async () => {
    const { manager, start, finish } = pendingCleanup()
    const restart = manager.restart()
    expect(mocks.terminate).toHaveBeenCalledOnce()
    expect(start).not.toHaveBeenCalled()
    finish()
    await restart
    expect(start).toHaveBeenCalledOnce()
  })

  it('等待期间连续重启只启动最新一代', async () => {
    const { manager, start, finish } = pendingCleanup()
    const first = manager.restart()
    const second = manager.restart()
    finish()
    await Promise.all([first, second])
    expect(start).toHaveBeenCalledOnce()
  })

  it('等待期间 stop 不会被旧重启操作复活', async () => {
    const { manager, start, finish } = pendingCleanup()
    const restart = manager.restart()
    manager.stop()
    finish()
    await restart
    expect(start).not.toHaveBeenCalled()
  })

  it('清理失败时重启失败，不启动新宿主', async () => {
    const { manager, start } = pendingCleanup()
    mocks.terminate.mockRejectedValue(new Error('cleanup failed'))
    await expect(manager.restart()).rejects.toThrow('cleanup failed')
    expect(start).not.toHaveBeenCalled()
    mocks.terminate.mockResolvedValue(undefined)
    await manager.restart()
    expect(mocks.terminate).toHaveBeenCalledTimes(2)
    expect(start).toHaveBeenCalledOnce()
  })
})

describe('宿主异常退出自动重启', () => {
  function autoRestart() {
    vi.useFakeTimers()
    mocks.port = 1234
    const manager = new PluginHostManager()
    const internal = manager as unknown as {
      terminateProcess(child: ChildProcess): void
      maybeAutoRestartNodeHost(code: number, signal: null, specs: PluginSpec[], gen: number): void
      spawnNodeHost(specs: PluginSpec[], port: number): void
    }
    const spawn = vi.spyOn(internal, 'spawnNodeHost').mockImplementation(() => {})
    const spec: PluginSpec = { pluginId: 'plugin', token: 'old', grantedCapabilities: [], manifestPath: '', pluginDir: '', runtime: 'node', lifecycle: 'persistent' }
    const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: 1, signalCode: null }) as ChildProcess
    internal.terminateProcess(child)
    internal.maybeAutoRestartNodeHost(1, null, [spec], 0)
    return { manager, spawn }
  }
  it('定时器触发后继续等待旧树清理，完成才签发 token 和启动', async () => {
    let finish!: () => void
    mocks.terminate.mockReturnValue(new Promise<void>(resolve => { finish = resolve }))
    const { spawn } = autoRestart()
    await vi.advanceTimersByTimeAsync(3000)
    expect(spawn).not.toHaveBeenCalled()
    expect(mocks.bindToken).not.toHaveBeenCalled()
    finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(spawn).toHaveBeenCalledOnce()
    expect(mocks.bindToken).toHaveBeenCalledOnce()
  })
  it('清理失败时自动重启取消，后续等待者也不能将失败误判为成功', async () => {
    mocks.terminate.mockRejectedValue(new Error('cleanup failed'))
    const { manager, spawn } = autoRestart()
    await vi.advanceTimersByTimeAsync(3000)
    expect(spawn).not.toHaveBeenCalled()
    expect(mocks.bindToken).not.toHaveBeenCalled()
    await expect(manager.waitForProcessCleanup()).rejects.toThrow('cleanup failed')
  })
  it('后台清理失败尚未被等待器消费，首次手动重试成功即可恢复宿主', async () => {
    mocks.terminate.mockRejectedValueOnce(new Error('old cleanup failed'))
    const { manager } = autoRestart()
    await vi.advanceTimersByTimeAsync(0)
    const start = vi.spyOn(manager, 'start').mockImplementation(() => {})
    let finish!: () => void
    mocks.terminate.mockReturnValue(new Promise<void>(resolve => { finish = resolve }))

    const restart = manager.restart()
    expect(mocks.terminate).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(0)
    expect(start).not.toHaveBeenCalled()
    finish()
    await restart
    expect(start).toHaveBeenCalledOnce()
    await expect(manager.waitForProcessCleanup()).resolves.toBeUndefined()
  })
  it('后台清理失败后的手动重试仍失败，只报告本次错误并阻止启动', async () => {
    mocks.terminate.mockRejectedValueOnce(new Error('old cleanup failed'))
    const { manager } = autoRestart()
    await vi.advanceTimersByTimeAsync(0)
    const start = vi.spyOn(manager, 'start').mockImplementation(() => {})
    mocks.terminate.mockRejectedValueOnce(new Error('retry cleanup failed'))

    await expect(manager.restart()).rejects.toThrow('retry cleanup failed')
    expect(mocks.terminate).toHaveBeenCalledTimes(2)
    expect(start).not.toHaveBeenCalled()
    await expect(manager.waitForProcessCleanup()).rejects.toThrow('cleanup failed')
  })
  it('自动重启已在等待清理时 stop 仍阻止复活', async () => {
    let finish!: () => void
    mocks.terminate.mockReturnValue(new Promise<void>(resolve => { finish = resolve }))
    const { manager, spawn } = autoRestart()
    await vi.advanceTimersByTimeAsync(3000)
    manager.stop()
    finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(spawn).not.toHaveBeenCalled()
    expect(mocks.bindToken).not.toHaveBeenCalled()
  })
  it('清理完成后重新检查启用集合', async () => {
    let finish!: () => void
    mocks.terminate.mockReturnValue(new Promise<void>(resolve => { finish = resolve }))
    const { spawn } = autoRestart()
    await vi.advanceTimersByTimeAsync(3000)
    mocks.enabled = []
    finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(spawn).not.toHaveBeenCalled()
    expect(mocks.bindToken).not.toHaveBeenCalled()
  })
})
