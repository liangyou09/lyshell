// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebviewTag } from 'electron'
import TaskShelfPreview from './TaskShelfPreview'
import { registerWebview, unregisterWebview } from './web-tab-controls'
import { useTerminalStore } from '../../stores/terminal-store'
import { paintTerminalPreview } from './task-shelf-terminal-preview'
import '../../i18n'

vi.mock('./task-shelf-terminal-preview', () => ({ paintTerminalPreview: vi.fn(() => true) }))
const captureImage = () => ({ isEmpty: () => false, getSize: () => ({ width: 1200, height: 800 }), resize: () => ({ toDataURL: () => 'data:image/png;base64,preview' }) })
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
  it('定时读取原网页实例，卸载后停止，绝不重新导航或聚焦', async () => {
    const page = { capturePage: vi.fn(async () => captureImage()), loadURL: vi.fn(), focus: vi.fn() }
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
    expect(paintTerminalPreview).toHaveBeenCalledWith(view.container.querySelector('canvas'), terminal)
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
    const page = { capturePage: vi.fn(async () => captureImage()) }
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
  it('慢截图不堆积请求，失败撤下旧画面，下一次成功后恢复', async () => {
    let finish: ((value: ReturnType<typeof captureImage>) => void) | undefined
    const page = { capturePage: vi.fn(() => new Promise<ReturnType<typeof captureImage>>(resolve => { finish = resolve })) }
    registerWebview('web', page as unknown as WebviewTag)
    const view = render(<TaskShelfPreview kind="web" id="web" />)
    await tick(1500)
    expect(page.capturePage).toHaveBeenCalledTimes(1)
    await act(async () => { finish!(captureImage()) })
    expect(view.container.querySelector('img')).toBeTruthy()
    page.capturePage.mockRejectedValueOnce(new Error('guest destroyed'))
    await tick(550)
    expect(view.container.querySelector('img')).toBeNull()
    expect(view.getByText('Preview unavailable')).toBeTruthy()
    page.capturePage.mockResolvedValueOnce(captureImage())
    await tick(550)
    expect(view.container.querySelector('img')).toBeTruthy()
  })
})
