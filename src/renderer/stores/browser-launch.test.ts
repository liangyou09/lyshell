// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
const deps = vi.hoisted(() => ({ load: vi.fn(), open: vi.fn() }))
vi.mock('./browser-settings-store', () => ({ useBrowserSettingsStore: { getState: () => ({ load: deps.load }) } }))
vi.mock('./pane-store', () => ({ usePaneStore: { getState: () => ({ openWebTab: deps.open }) } }))
import { initializeBrowserLaunches } from './browser-launch'

beforeEach(() => { deps.load.mockReset().mockResolvedValue(undefined); deps.open.mockReset().mockReturnValue({ ok: true }) })
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve() }

function setup(take = vi.fn().mockResolvedValue([])) {
  let onPending = () => {}
  const off = vi.fn()
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    takeBrowserLaunches: take, onBrowserLaunchPending: (fn: () => void) => { onPending = fn; return off }
  } })
  return { take, notify: () => onPending(), off }
}

describe('外部网页链接消费', () => {
  it('等待隐私配置后拉取冷启动批次，并继续串行打开运行中收到的链接', async () => {
    let ready!: () => void
    deps.load.mockReturnValue(new Promise<void>(resolve => { ready = resolve }))
    const api = setup(vi.fn().mockResolvedValueOnce(['https://example.com/first', 'file:///C:/secret']).mockResolvedValueOnce(['http://localhost/next']))
    const dispose = initializeBrowserLaunches()
    api.notify()
    await flush()
    expect(api.take).not.toHaveBeenCalled()
    ready()
    await flush()
    expect(deps.open.mock.calls).toEqual([['https://example.com/first'], ['http://localhost/next']])
    dispose()
    expect(api.off).toHaveBeenCalledOnce()
  })
  it('StrictMode 清理尚未就绪的订阅不会取走批次，重新挂载可消费', async () => {
    const api = setup(vi.fn().mockResolvedValue(['https://example.com/']))
    const dispose = initializeBrowserLaunches()
    dispose()
    await flush()
    expect(api.take).not.toHaveBeenCalled()
    const disposeAgain = initializeBrowserLaunches()
    await flush()
    expect(deps.open).toHaveBeenCalledOnce()
    disposeAgain()
  })
  it('已认领的 IPC 批次在 effect 清理后仍落地，避免链接丢失', async () => {
    let resolve!: (urls: string[]) => void
    const api = setup(vi.fn().mockReturnValue(new Promise<string[]>(done => { resolve = done })))
    const dispose = initializeBrowserLaunches()
    await flush()
    expect(api.take).toHaveBeenCalledOnce()
    dispose()
    resolve(['https://example.com/claimed'])
    await flush()
    expect(deps.open).toHaveBeenCalledWith('https://example.com/claimed')
  })
})
