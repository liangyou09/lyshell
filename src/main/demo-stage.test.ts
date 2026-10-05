import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'

const electron = vi.hoisted(() => ({ getPath: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: electron.getPath } }))
import { startDemoStage } from './demo-stage'

const originalArgs = process.argv
let directory: string
let windows: EventEmitter[]

function createWindow(): BrowserWindow {
  const window = Object.assign(new EventEmitter(), {
    webContents: Object.assign(new EventEmitter(), {
      setBackgroundThrottling: vi.fn(), setZoomFactor: vi.fn(),
      executeJavaScript: vi.fn(async () => 0)
    }),
    isDestroyed: () => false, isMinimized: () => false, isMaximized: () => false,
    setTitle: vi.fn(), setContentSize: vi.fn(), center: vi.fn(), showInactive: vi.fn()
  })
  windows.push(window)
  return window as unknown as BrowserWindow
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'lyshell-demo-test-'))
  windows = []
  electron.getPath.mockReturnValue(directory)
  process.argv = [...originalArgs.filter(arg => arg !== '--demo-stage'), '--demo-stage']
})

afterEach(() => {
  vi.useRealTimers()
  for (const window of windows) window.emit('closed')
  process.argv = originalArgs
  rmSync(directory, { recursive: true, force: true })
})

describe('演示服务生命周期', () => {
  it.each(['resolve', 'reject'] as const)('超时后保持互斥，旧执行 %s 后允许重试', async (outcome) => {
    const window = createWindow()
    let finish!: () => void
    let notifyStarted!: () => void
    const started = new Promise<void>(resolve => { notifyStarted = resolve })
    const execution = new Promise<number>((resolve, reject) => {
      finish = () => outcome === 'resolve' ? resolve(0) : reject(new Error('迟到的场景失败'))
    })
    vi.mocked(window.webContents.executeJavaScript).mockImplementationOnce(() => {
      notifyStarted()
      return execution
    })
    startDemoStage(window)
    const file = join(directory, 'demo-stage.json')
    await vi.waitFor(() => expect(existsSync(file)).toBe(true))
    const connection = JSON.parse(readFileSync(file, 'utf8')) as { port: number; token: string }
    const requestScene = () => fetch(`http://127.0.0.1:${connection.port}/scene`, {
      method: 'POST', headers: { Authorization: `Bearer ${connection.token}` },
      body: JSON.stringify({ index: 0 })
    })

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const first = requestScene()
    await started
    await vi.advanceTimersByTimeAsync(15000)
    const timedOut = await first
    expect(timedOut.status).toBe(500)
    expect(await timedOut.json()).toEqual({ error: '画面切换超时' })
    const blocked = await requestScene()
    expect(blocked.status).toBe(409)
    await blocked.text()
    expect(window.webContents.executeJavaScript).toHaveBeenCalledTimes(1)

    finish()
    await execution.catch(() => {})
    const retry = await requestScene()
    expect(retry.status).toBe(200)
    expect(await retry.json()).toEqual({ ready: true, index: 0 })
    expect(window.webContents.executeJavaScript).toHaveBeenCalledTimes(2)
  })

  it('普通启动不创建接口或连接文件', () => {
    process.argv = originalArgs.filter(arg => arg !== '--demo-stage')
    const window = createWindow()
    startDemoStage(window)
    expect(window.webContents.setBackgroundThrottling).not.toHaveBeenCalled()
    expect(existsSync(join(directory, 'demo-stage.json'))).toBe(false)
  })

  it('关窗清理后，新窗口能发布新令牌并响应场景请求', async () => {
    const file = join(directory, 'demo-stage.json')
    const readConnection = (): { port: number; token: string } => JSON.parse(readFileSync(file, 'utf8'))
    const first = createWindow()
    startDemoStage(first)
    await vi.waitFor(() => expect(existsSync(file)).toBe(true))
    const previous = readConnection()
    first.emit('closed')
    expect(existsSync(file)).toBe(false)

    const second = createWindow()
    startDemoStage(second)
    await vi.waitFor(() => expect(existsSync(file)).toBe(true))
    const current = readConnection()
    expect(current.token).not.toBe(previous.token)
    const response = await fetch(`http://127.0.0.1:${current.port}/scene`, {
      method: 'POST', headers: { Authorization: `Bearer ${current.token}` },
      body: JSON.stringify({ index: 0 })
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ready: true, index: 0 })
    expect(second.webContents.executeJavaScript).toHaveBeenCalledWith('window.lyshellDemoScene(0)')
  })
})
