import { BrowserWindow, clipboard, screen } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { join } from 'path'
import type { McpConfirmationContent, McpConfirmationData, McpConfirmationReply, McpConfirmationRequest } from '@shared/mcp-confirmation'
import { MCP_CONFIRMATION_THEME } from '@shared/mcp-confirmation'
import { preferencesRepository } from '../storage/repository'
import { getRendererThemeMode } from '../ui-theme'

interface PendingConfirmation {
  window: BrowserWindow
  data: McpConfirmationData
  ready: boolean
  current: () => boolean
  finish: (allowed: boolean) => void
}
const pending = new Map<number, PendingConfirmation>()
let owner: BrowserWindow | null = null
let queue: Promise<unknown> = Promise.resolve()
let queueSize = 0

export function setMcpConfirmationWindow(window: BrowserWindow | null): void {
  if (owner !== window) for (const item of pending.values()) item.finish(false)
  owner = window
}

export function updateMcpConfirmationTheme(theme: unknown): void {
  if (theme !== 'light' && theme !== 'dark') return
  for (const item of pending.values()) {
    item.data.theme = theme
    item.window.setBackgroundColor(theme === 'light' ? '#ffffff' : '#20252b')
    item.window.webContents.send(MCP_CONFIRMATION_THEME, theme)
  }
}

/** 只接受该独立确认页顶层框架的回执，普通 renderer / 网页不能代为批准。 */
export function mcpConfirmationRequest(event: IpcMainInvokeEvent, request: McpConfirmationRequest): McpConfirmationReply {
  const item = pending.get(event.sender.id)
  if (!item || event.sender !== item.window.webContents || event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame) return null
  if (request.kind === 'reject') { item.finish(false); return true }
  if (!item.current()) { item.finish(false); return false }
  if (request.kind === 'get') return item.data
  if (request.kind === 'ready') {
    if (!item.ready) { item.ready = true; item.window.show(); item.window.focus() }
    return true
  }
  if (!item.ready) return false
  if (request.kind === 'copy') { clipboard.writeText(item.data.content); return true }
  if (request.kind === 'allow') { item.finish(true); return true }
  return false
}

/** 排队展示，关闭、渲染失败、来源失效均按拒绝处理；完整内容只留在内存。 */
export function requestMcpConfirmation(content: McpConfirmationContent, current: () => boolean = () => true): Promise<boolean> {
  const parent = owner
  if (!parent || parent.isDestroyed() || queueSize >= 20) return Promise.resolve(false)
  queueSize++
  const run = async (): Promise<boolean> => {
    try {
      if (owner !== parent || parent.isDestroyed() || !current()) return false
      return await openConfirmation(parent, content, current)
    } catch { return false }
    finally { queueSize-- }
  }
  const result = queue.then(run, run)
  queue = result
  return result
}

function openConfirmation(parent: BrowserWindow, content: McpConfirmationContent, current: () => boolean): Promise<boolean> {
  const theme = getRendererThemeMode()
  const locale = String(preferencesRepository.get('locale')).startsWith('zh') ? 'zh' : 'en'
  const bounds = parent.getBounds()
  const area = screen.getDisplayMatching(bounds).workArea
  const width = Math.min(720, area.width)
  const height = Math.min(580, area.height)
  const win = new BrowserWindow({
    parent, modal: true, show: false, width, height, minWidth: Math.min(520, width), minHeight: Math.min(380, height),
    x: Math.round(Math.max(area.x, Math.min(bounds.x + (bounds.width - width) / 2, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(bounds.y + (bounds.height - height) / 2, area.y + area.height - height))),
    frame: false, resizable: true, minimizable: false, maximizable: false, skipTaskbar: true, autoHideMenuBar: true,
    title: content.title, backgroundColor: theme === 'light' ? '#ffffff' : '#20252b',
    webPreferences: { preload: join(__dirname, '../preload/mcpConfirmation.js'), partition: 'mcp-confirmations', sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false }
  })
  const id = win.webContents.id
  return new Promise<boolean>(resolve => {
    let settled = false
    const finish = (allowed: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      pending.delete(id)
      parent.removeListener('closed', cancelled)
      parent.webContents.removeListener('render-process-gone', cancelled)
      resolve(allowed)
      if (!win.isDestroyed()) win.destroy()
    }
    const cancelled = () => finish(false)
    const timeout = setTimeout(() => { if (!pending.get(id)?.ready) cancelled() }, 15000)
    pending.set(id, { window: win, data: { ...content, locale, theme }, ready: false,
      current: () => { try { return !settled && owner === parent && !parent.isDestroyed() && current() } catch { return false } }, finish })
    parent.once('closed', cancelled)
    parent.webContents.once('render-process-gone', cancelled)
    win.once('closed', cancelled)
    win.webContents.once('render-process-gone', cancelled)
    win.webContents.on('will-navigate', event => event.preventDefault())
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const rendererUrl = process.env['ELECTRON_RENDERER_URL']
    try {
      const load = rendererUrl ? win.loadURL(new URL('mcp-confirmation.html', rendererUrl.endsWith('/') ? rendererUrl : rendererUrl + '/').href) : win.loadFile(join(__dirname, '../renderer/mcp-confirmation.html'))
      void load.catch(cancelled)
    } catch { cancelled() }
  })
}
