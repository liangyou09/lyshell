// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { captureTerminalScreenshot, setTerminalCaptureWindow, terminalCaptureRect } from './terminal-screenshot'

afterEach(() => { setTerminalCaptureWindow(null); document.body.innerHTML = ''; vi.restoreAllMocks() })

describe('terminal screenshot boundary', () => {
  function setupCapture() {
    const layout = { width: 800, height: 600, terminals: [{ sessionId: 'target', x: 10, y: 20, width: 100, height: 80, visible: true }] }
    const executeJavaScript = vi.fn().mockResolvedValue(layout)
    const capturePage = vi.fn().mockResolvedValue({ isEmpty: () => false, toPNG: () => Buffer.from('png'), getSize: () => ({ width: 100, height: 80 }) })
    setTerminalCaptureWindow({
      isDestroyed: () => false, isMinimized: () => false, isVisible: () => true,
      webContents: { executeJavaScript, getZoomFactor: () => 1, capturePage }
    } as unknown as BrowserWindow)
    return { layout, executeJavaScript, capturePage }
  }

  it('returns only the requested crop and checks layout again before returning the PNG', async () => {
    const { executeJavaScript, capturePage } = setupCapture()
    await expect(captureTerminalScreenshot('target')).resolves.toEqual({ mimeType: 'image/png', data: Buffer.from('png').toString('base64'), width: 100, height: 80 })
    expect(capturePage).toHaveBeenCalledWith({ x: 10, y: 20, width: 100, height: 80 })
    expect(executeJavaScript).toHaveBeenCalledTimes(2)
  })

  it('does not return a capture after the target was hidden or replaced', async () => {
    const { executeJavaScript, layout } = setupCapture()
    executeJavaScript.mockResolvedValueOnce(layout).mockResolvedValueOnce({ ...layout, terminals: [] })
    await expect(captureTerminalScreenshot('target')).rejects.toThrow('layout changed')
  })

  it('rounds inward at zoom and rejects hidden/out-of-viewport bounds', () => {
    const bounds = { sessionId: 'target', x: 10.2, y: 20.2, width: 100.5, height: 80.5, visible: true }
    expect(terminalCaptureRect(bounds, { width: 800, height: 600 }, 1.25)).toEqual({ x: 13, y: 26, width: 125, height: 99 })
    expect(() => terminalCaptureRect({ ...bounds, visible: false }, { width: 800, height: 600 }, 1)).toThrow()
    expect(() => terminalCaptureRect(bounds, { width: 100, height: 600 }, 1)).toThrow()
    expect(() => terminalCaptureRect(bounds, { width: 800, height: 600 }, NaN)).toThrow()
  })

  it.each(['auto', 'none'])('rejects a small overlay with pointer-events=%s between the original sample points', async (pointerEvents) => {
    document.body.innerHTML = '<div data-terminal-session-id="target"></div><div id="overlay"></div>'
    const terminal = document.body.children[0]
    const overlay = document.body.children[1]
    const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, toJSON() {} })
    const terminalBox = rect(10, 10, 100, 100)
    const overlayBox = rect(30, 30, 10, 10)
    vi.spyOn(terminal, 'getBoundingClientRect').mockReturnValue(terminalBox)
    vi.spyOn(terminal, 'getClientRects').mockReturnValue([terminalBox] as unknown as DOMRectList)
    vi.spyOn(overlay, 'getClientRects').mockReturnValue([overlayBox] as unknown as DOMRectList)
    vi.stubGlobal('getComputedStyle', () => ({ display: 'block', visibility: 'visible', opacity: '1', pointerEvents, position: 'absolute', zIndex: '10' }))
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: (x: number, y: number) => pointerEvents === 'auto' && x >= 30 && x <= 40 && y >= 30 && y <= 40 ? overlay : terminal })
    const capturePage = vi.fn()
    setTerminalCaptureWindow({
      isDestroyed: () => false, isMinimized: () => false, isVisible: () => true,
      webContents: { executeJavaScript: async (script: string) => window.eval(script), getZoomFactor: () => 1, capturePage }
    } as unknown as BrowserWindow)
    try {
      await expect(captureTerminalScreenshot('target')).rejects.toThrow('not visible')
      expect(capturePage).not.toHaveBeenCalled()
    } finally { vi.unstubAllGlobals() }
  })
})
