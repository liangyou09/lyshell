import type { BrowserWindow, Rectangle } from 'electron'

let captureWindow: BrowserWindow | null = null
export function setTerminalCaptureWindow(window: BrowserWindow | null): void { captureWindow = window }

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Terminal capture timed out')), 5000)
    })])
  } finally { clearTimeout(timer) }
}

export interface TerminalBounds {
  sessionId: string
  x: number
  y: number
  width: number
  height: number
  visible: boolean
}

/** 只接受完整位于视口中的可见终端，不能把截取区域扩到侧栏/其它页签。 */
export function terminalCaptureRect(bounds: TerminalBounds, viewport: { width: number; height: number }, zoom: number): Rectangle {
  const values = [bounds.x, bounds.y, bounds.width, bounds.height, viewport.width, viewport.height, zoom]
  if (!bounds.visible || values.some(value => !Number.isFinite(value)) || zoom <= 0 ||
    bounds.width < 2 || bounds.height < 2 || bounds.x < 0 || bounds.y < 0 ||
    bounds.x + bounds.width > viewport.width || bounds.y + bounds.height > viewport.height) {
    throw new Error('Terminal is hidden, obscured or outside the viewport; show the target terminal first')
  }
  // 向内取整，不包含相邻 UI 的像素。capturePage 使用 DIP，不乘屏幕 devicePixelRatio。
  const x = Math.ceil(bounds.x * zoom), y = Math.ceil(bounds.y * zoom)
  const width = Math.floor((bounds.x + bounds.width) * zoom) - x
  const height = Math.floor((bounds.y + bounds.height) * zoom) - y
  if (width < 1 || height < 1 || width > 8192 || height > 8192) throw new Error('Invalid terminal capture size')
  return { x, y, width, height }
}

export async function captureTerminalScreenshot(sessionId: string): Promise<{ mimeType: 'image/png'; data: string; width: number; height: number }> {
  const window = captureWindow
  if (!window || window.isDestroyed() || window.isMinimized() || !window.isVisible()) {
    throw new Error('LyShell window must be visible and not minimized to capture a terminal')
  }
  // 常量脚本只查询 LyShell 自己的终端 DOM；请求参数不作为脚本执行。
  const script = `(() => ({
    width: innerWidth, height: innerHeight,
    terminals: Array.from(document.querySelectorAll('[data-terminal-session-id]')).map(element => {
      const rect = element.getBoundingClientRect();
      let visible = element.getClientRects().length > 0;
      for (let parent = element; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) visible = false;
      }
      const points = [[rect.left + 0.5, rect.top + 0.5], [rect.right - 0.5, rect.top + 0.5],
        [rect.left + 0.5, rect.bottom - 0.5], [rect.right - 0.5, rect.bottom - 0.5], [rect.left + rect.width / 2, rect.top + rect.height / 2]];
      // 五点采样会漏掉局部菜单/提示；对每个外部元素与终端的交叠区域也做遮挡检查。
      for (const other of document.querySelectorAll('body *')) {
        if (other.contains(element) || element.contains(other)) continue;
        const style = getComputedStyle(other);
        if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) continue;
        for (const box of other.getClientRects()) {
          const left = Math.max(rect.left, box.left), right = Math.min(rect.right, box.right);
          const top = Math.max(rect.top, box.top), bottom = Math.min(rect.bottom, box.bottom);
          if (right <= left || bottom <= top) continue;
          points.push([(left + right) / 2, (top + bottom) / 2]);
          // 不接收指针的浮层不会出现在 elementFromPoint，但仍会被 capturePage 拍到。
          if (style.pointerEvents === 'none' && ['fixed', 'absolute'].includes(style.position) && Number(style.zIndex) > 0) visible = false;
        }
      }
      for (const [x, y] of points) {
        const top = document.elementFromPoint(x, y);
        if (!top || !element.contains(top)) visible = false;
      }
      return { sessionId: element.dataset.terminalSessionId, x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible };
    })
  }))()`
  const layout = await bounded(window.webContents.executeJavaScript(script)) as { width: number; height: number; terminals: TerminalBounds[] }
  const targets = layout.terminals.filter(terminal => terminal.sessionId === sessionId && terminal.visible)
  if (targets.length !== 1) throw new Error('Target terminal is not visible or has multiple visible views; show one target terminal first')
  const rect = terminalCaptureRect(targets[0], layout, window.webContents.getZoomFactor())
  const image = await bounded(window.webContents.capturePage(rect))
  const after = await bounded(window.webContents.executeJavaScript(script)) as typeof layout
  const stillVisible = after.terminals.filter(terminal => terminal.sessionId === sessionId && terminal.visible)
  if (stillVisible.length !== 1 || JSON.stringify(terminalCaptureRect(stillVisible[0], after, window.webContents.getZoomFactor())) !== JSON.stringify(rect)) {
    throw new Error('Terminal layout changed during capture; retry after the target view settles')
  }
  if (image.isEmpty()) throw new Error('Terminal capture returned an empty image')
  const png = image.toPNG()
  if (png.length > 6 * 1024 * 1024) throw new Error('Terminal screenshot exceeds 6 MB; reduce the terminal window size')
  return { mimeType: 'image/png', data: png.toString('base64'), ...image.getSize() }
}
