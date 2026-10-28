// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebviewTag } from 'electron'
import TaskShelfPreview from './TaskShelfPreview'
import { registerWebview, unregisterWebview } from './web-tab-controls'
import { useTerminalStore } from '../../stores/terminal-store'
import { paintTerminalPreview } from './task-shelf-terminal-preview'
import { shelfPreviewDiagnostics } from './task-shelf-web-frame'
import '../../i18n'

vi.mock('./task-shelf-terminal-preview', () => ({ paintTerminalPreview: vi.fn(() => true) }))
const captureImage = (url = 'data:image/png;base64,preview') => ({ isEmpty: () => false, getSize: () => ({ width: 1200, height: 800 }), resize: () => ({ toDataURL: () => url }) })
/** 采集管线先核实 guest 视口再截图；假页面必须提供可测几何，否则不会发起 capturePage。 */
const fakePage = (capturePage = vi.fn(async () => captureImage())) => ({
  capturePage,
  getBoundingClientRect: () => ({ width: 1200, height: 800 }),
  isConnected: true,
  ownerDocument: { defaultView: { devicePixelRatio: 1 } },
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  loadURL: vi.fn(),
  focus: vi.fn(),
})
const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  vi.mocked(paintTerminalPreview).mockClear()
})
afterEach(() => {
  cleanup(); unregisterWebview('web'); vi.restoreAllMocks(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals()
})

describe('任务缩略预览的只读生命周期', () => {
  it('画布已分配后绘图失败会释放实际像素与预留', async () => {
    const terminal = { resize: vi.fn(), write: vi.fn(), focus: vi.fn() }
    vi.spyOn(useTerminalStore.getState(), 'getTerminal').mockReturnValue({ terminal } as unknown as NonNullable<ReturnType<ReturnType<typeof useTerminalStore.getState>['getTerminal']>>)
    const before = shelfPreviewDiagnostics().cache.decodedBytes
    vi.mocked(paintTerminalPreview).mockImplementationOnce((canvas, _terminal, options) => {
      expect(options?.beforeResize?.(800, 400)).toBe(true)
      canvas.width = 800; canvas.height = 400
      return false
    })
    const view = render(<TaskShelfPreview kind="terminal" id="terminal" />)
    await tick(0)
    expect(view.container.querySelector('canvas')?.width).toBe(0)
    expect(view.container.querySelector('canvas')?.height).toBe(0)
    expect(shelfPreviewDiagnostics().cache.decodedBytes).toBe(before)
  })
  it('定时读取原网页实例，卸载后停止，绝不重新导航或聚焦', async () => {
    const page = fakePage()
    registerWebview('web', page as unknown as WebviewTag)
    const view = render(<TaskShelfPreview kind="web" id="web" />)
    await tick(50)
    expect(view.container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,preview')
    await tick(500)
    expect(page.capturePage).toHaveBeenCalledTimes(2)
    expect(page.loadURL).not.toHaveBeenCalled(); expect(page.focus).not.toHaveBeenCalled()
    view.unmount(); await tick(1000)
    expect(page.capturePage).toHaveBeenCalledTimes(2)
  })
  it('只读原终端，切换来源后不会残留前一个预览', async () => {
    const terminal = { resize: vi.fn(), write: vi.fn(), focus: vi.fn() }
    vi.spyOn(useTerminalStore.getState(), 'getTerminal').mockReturnValue({ terminal } as unknown as NonNullable<ReturnType<ReturnType<typeof useTerminalStore.getState>['getTerminal']>>)
    const view = render(<TaskShelfPreview kind="terminal" id="terminal" />)
    await tick(0)
    expect(paintTerminalPreview).toHaveBeenCalledWith(
      view.container.querySelector('canvas'),
      terminal,
      expect.objectContaining({ beforeResize: expect.any(Function) })
    )
    expect(view.container.querySelector('canvas')?.hidden).toBe(false)
    expect(terminal.resize).not.toHaveBeenCalled(); expect(terminal.write).not.toHaveBeenCalled(); expect(terminal.focus).not.toHaveBeenCalled()
    view.rerender(<TaskShelfPreview />)
    expect(view.getByText('Open task to preview')).toBeTruthy()
    expect(view.container.querySelector('canvas')).toBeNull()
  })
  it('视口外与隐藏窗口不截图，恢复可见时继续', async () => {
    let intersect: IntersectionObserverCallback | undefined
    const disconnect = vi.fn()
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback) { intersect = callback }
      observe() {} disconnect = disconnect
    })
    const page = fakePage()
    registerWebview('web', page as unknown as WebviewTag)
    const view = render(<TaskShelfPreview kind="web" id="web" />)
    await tick(1000)
    expect(page.capturePage).not.toHaveBeenCalled()
    await act(async () => { intersect!([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver) })
    await tick(50)
    expect(page.capturePage).toHaveBeenCalledTimes(1)
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    await tick(1000)
    expect(page.capturePage).toHaveBeenCalledTimes(1)
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await tick(50)
    expect(page.capturePage).toHaveBeenCalledTimes(2)
    view.unmount(); expect(disconnect).toHaveBeenCalled()
  })
  it('慢截图不堆积请求，瞬时失败保留旧帧，恢复后换成新帧', async () => {
    let finish: ((value: ReturnType<typeof captureImage>) => void) | undefined
    const page = fakePage(vi.fn(() => new Promise<ReturnType<typeof captureImage>>(resolve => { finish = resolve })))
    registerWebview('web', page as unknown as WebviewTag)
    const view = render(<TaskShelfPreview kind="web" id="web" />)
    await tick(1500)
    expect(page.capturePage).toHaveBeenCalledTimes(1)
    await act(async () => { finish!(captureImage()) })
    expect(view.container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,preview')
    page.capturePage.mockRejectedValueOnce(new Error('guest destroyed'))
    await tick(550)
    // 瞬时失败（例如隐藏 guest 的 UnknownVizError）不清空旧帧，也不叠加请求。
    expect(view.container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,preview')
    expect(page.capturePage).toHaveBeenCalledTimes(2)
    page.capturePage.mockResolvedValueOnce(captureImage('data:image/png;base64,next'))
    await tick(550)
    expect(view.container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,next')
    expect(page.capturePage).toHaveBeenCalledTimes(3)
  })
  it('没有旧帧时采集失败显示不可用，恢复可见轮询后重新出图', async () => {
    const page = fakePage()
    page.capturePage.mockRejectedValueOnce(new Error('guest destroyed'))
    registerWebview('web', page as unknown as WebviewTag)
    const view = render(<TaskShelfPreview kind="web" id="web" />)
    await tick(50)
    expect(view.container.querySelector('img')).toBeNull()
    expect(view.getByText('Preview unavailable')).toBeTruthy()
    await tick(500)
    expect(view.container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,preview')
  })
})
