import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedDshWebLaunch } from './launch-resolve'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), attach: vi.fn() }))
vi.mock('child_process', () => ({ spawn: mocks.spawn }))
vi.mock('electron', () => ({ session: {} }))
vi.mock('../harness/config', () => ({ HARNESS_AGENTS: { dsh: {} } }))
vi.mock('./launch-resolve', () => ({ createDshWebLaunchResolver: () => ({}), buildChildEnv: vi.fn() }))
vi.mock('./web', () => ({ dshWebManager: {}, comSpecFromEnv: (env: Record<string, string>) => env.ComSpec }))
vi.mock('./windows-job', () => ({ attachDshProcessJob: mocks.attach }))
import { runMarketTool } from './market'

const launch = { cwd: 'C:\\workspace with spaces' } as ResolvedDshWebLaunch
let child: EventEmitter & { pid: number; stdout: EventEmitter; stderr: EventEmitter; stdin: EventEmitter & { end: ReturnType<typeof vi.fn> }; kill: ReturnType<typeof vi.fn> }
let job: { terminate: ReturnType<typeof vi.fn<[], boolean>>; close: ReturnType<typeof vi.fn<[], boolean>> }
beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  child = Object.assign(new EventEmitter(), { pid: 1234, stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: Object.assign(new EventEmitter(), { end: vi.fn() }), kill: vi.fn() })
  job = { terminate: vi.fn(() => true), close: vi.fn(() => true) }
  mocks.attach.mockReturnValue(job)
  mocks.spawn.mockReturnValue(child)
})
afterEach(() => { vi.useRealTimers() })

describe.skipIf(process.platform !== 'win32')('Windows 市场安装进程树', () => {
  it('先接入 Job 再放行带空格参数的命令，沿用启动快照 ComSpec', async () => {
    const task = runMarketTool('npm', ['install', '--prefix', 'C:\\managed tools'], launch, { ComSpec: 'C:\\Windows\\System32\\cmd.exe' })
    expect(mocks.spawn).toHaveBeenCalledWith('C:\\Windows\\System32\\cmd.exe', [
      '/d', '/s', '/c', expect.stringContaining('set /p LYSHELL_MARKET_GATE= && npm install --prefix "C:\\managed tools"')
    ], expect.objectContaining({ windowsVerbatimArguments: true, cwd: launch.cwd }))
    expect(mocks.attach.mock.invocationCallOrder[0]).toBeLessThan(child.stdin.end.mock.invocationCallOrder[0])
    expect(child.stdin.end).toHaveBeenCalledWith('start\n')
    child.emit('close', 0)
    await task
    expect(job.close).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('超时回收整棵树，等待进程回执才返回失败', async () => {
    let settled = false
    const task = runMarketTool('dsh', ['plugin', '--profile', 'web', 'add', 'dshmarket'], launch, {})
    const result = task.catch(error => { settled = true; return error as Error })
    await vi.advanceTimersByTimeAsync(300_000)
    expect(job.terminate).toHaveBeenCalled()
    expect(job.close).toHaveBeenCalled()
    expect(settled).toBe(false)
    child.emit('close', 0)
    expect(await result).toMatchObject({ message: expect.stringContaining('timeout') })
  })
  it('无法持有 Job 时禁止执行安装命令', async () => {
    mocks.attach.mockReturnValue(null)
    const task = runMarketTool('pnpm', ['--version'], launch, {})
    expect(child.stdin.end).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalled()
    child.emit('close', 1)
    await expect(task).rejects.toThrow('containment unavailable')
  })
  it('输出超限立即回收进程树，并等待关闭回执', async () => {
    const task = runMarketTool('pnpm', ['--version'], launch, {})
    child.stdout.emit('data', Buffer.alloc(2 * 1024 * 1024 + 1))
    expect(job.terminate).toHaveBeenCalled()
    child.emit('close', 1)
    await expect(task).rejects.toThrow('output limit')
    expect(vi.getTimerCount()).toBe(0)
  })
  it('CLI 错误只回传诊断码，不带输出中的凭据', async () => {
    const task = runMarketTool('dsh', ['plugin'], launch, {})
    child.stdout.emit('data', Buffer.from('PRIVATE_KEY=secret'))
    child.stderr.emit('data', Buffer.from('ERR_PNPM_FETCH_404 private output'))
    child.emit('close', 1)
    await expect(task).rejects.toThrow('ERR_PNPM_FETCH_')
    await expect(task).rejects.not.toThrow('secret')
  })
})
