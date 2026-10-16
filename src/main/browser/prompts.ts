import { BrowserWindow, ipcMain, screen } from 'electron'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { join } from 'path'
import { BROWSER_PROMPT_ACTION, BROWSER_PROMPT_GET, BROWSER_PROMPT_THEME, type BrowserPromptContent, type BrowserPromptData, type BrowserPromptResult } from '@shared/browser-prompt'
import { preferencesRepository } from '../storage/repository'
import { getRendererThemeMode } from '../ui-theme'
import { browserOrigin } from '@shared/browser-settings'

interface PendingPrompt {
  window: BrowserWindow
  ownerId: number
  data: BrowserPromptData
  ready: boolean
  busy: boolean
  current: () => boolean
  confirm: (isOpen: () => boolean) => void | Promise<void>
  finish: (accepted: boolean) => void
}
const pending = new Map<number, PendingPrompt>()
const owners = new Set<number>()
let initialized = false

function promptFor(event: IpcMainInvokeEvent): PendingPrompt | undefined {
  if (event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame) return
  return pending.get(event.sender.id)
}

export function initializeBrowserPrompts(): void {
  if (initialized) return
  initialized = true
  ipcMain.on('ui:theme-mode', (event, theme: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame || theme !== 'light' && theme !== 'dark') return
    for (const prompt of pending.values()) if (prompt.ownerId === event.sender.id && !prompt.window.isDestroyed()) {
      prompt.data.theme = theme
      prompt.window.setBackgroundColor(theme === 'dark' ? '#292a2d' : '#ffffff')
      prompt.window.webContents.send(BROWSER_PROMPT_THEME, theme)
    }
  })
  ipcMain.handle(BROWSER_PROMPT_GET, event => promptFor(event)?.data ?? null)
  ipcMain.handle(BROWSER_PROMPT_ACTION, async (event, raw: unknown): Promise<BrowserPromptResult> => {
    const prompt = promptFor(event)
    if (!prompt || !raw || typeof raw !== 'object') return { success: false, error: 'unavailable' }
    const action = raw as Record<string, unknown>
    if (action.kind === 'cancel') { prompt.finish(false); return { success: true } }
    if (!prompt.current()) { prompt.finish(false); return { success: false, error: 'unavailable' } }
    if (action.kind === 'ready') { prompt.ready = true; prompt.window.showInactive(); return { success: true } }
    if (action.kind !== 'confirm' || !prompt.ready || prompt.busy) return { success: false, error: 'unavailable' }
    prompt.busy = true
    const isOpen = () => pending.get(event.sender.id) === prompt && prompt.current()
    try {
      await prompt.confirm(isOpen)
      if (!isOpen()) { prompt.finish(false); return { success: false, error: 'unavailable' } }
      prompt.finish(true)
      return { success: true }
    } catch {
      if (!isOpen()) { prompt.finish(false); return { success: false, error: 'unavailable' } }
      return { success: false, error: 'saveFailed' }
    } finally { prompt.busy = false }
  })
}

/** 右上角独立提示卡；网页拿不到 bridge、密码或确认回执通道，不抢走页面焦点。 */
export function requestBrowserPrompt(guest: WebContents, content: BrowserPromptContent, options: {
  current: () => boolean
  confirm: (isOpen: () => boolean) => void | Promise<void>
}): Promise<boolean> {
  initializeBrowserPrompts()
  const host = guest.hostWebContents
  const parent = host && BrowserWindow.fromWebContents(host)
  if (!host || !parent || parent.isDestroyed() || guest.isDestroyed() || owners.has(host.id) || !options.current()) return Promise.resolve(false)
  const theme = getRendererThemeMode()
  const locale = String(preferencesRepository.get('locale')).startsWith('zh') ? 'zh' : 'en'
  const area = screen.getDisplayMatching(parent.getBounds()).workArea
  const width = Math.min(320, Math.max(280, area.width - 32))
  const height = Math.min(204, Math.max(180, area.height - 32))
  const anchor = () => {
    const bounds = parent.getBounds()
    const display = screen.getDisplayMatching(bounds).workArea
    return {
      x: Math.max(display.x + 12, Math.min(bounds.x + bounds.width - width - 16, display.x + display.width - width - 12)),
      y: Math.max(display.y + 12, Math.min(bounds.y + 64, display.y + display.height - height - 12))
    }
  }
  const win = new BrowserWindow({
    parent, modal: false, show: false, skipTaskbar: true, width, height, ...anchor(), resizable: false, minimizable: false, maximizable: false,
    frame: false, autoHideMenuBar: true, backgroundColor: theme === 'dark' ? '#292a2d' : '#ffffff',
    title: locale === 'zh' ? 'LyShell · 网站确认' : 'LyShell · Website confirmation',
    webPreferences: { preload: join(__dirname, '../preload/browserPrompt.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'browser-prompts', devTools: false }
  })
  owners.add(host.id)
  const ownerId = host.id
  const promptId = win.webContents.id
  return new Promise<boolean>(resolve => {
    let settled = false
    const finish = (accepted: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      pending.delete(promptId)
      owners.delete(ownerId)
      guest.removeListener('destroyed', cancelled)
      guest.removeListener('did-start-navigation', navigated)
      parent.removeListener('move', reposition)
      parent.removeListener('resize', reposition)
      resolve(accepted)
      if (!win.isDestroyed()) win.destroy()
    }
    const cancelled = () => finish(false)
    // 登录后的同源跳转保留提示；换站和来源销毁仍按取消处理。
    const navigated = (_event: Electron.Event, target: string, inPlace: boolean, mainFrame: boolean) => { if (mainFrame && !inPlace && browserOrigin(target) !== content.origin) cancelled() }
    const reposition = () => { if (!win.isDestroyed() && !parent.isDestroyed()) win.setPosition(anchor().x, anchor().y) }
    const timeout = setTimeout(() => { if (!pending.get(promptId)?.ready) finish(false) }, 15000)
    pending.set(promptId, { window: win, ownerId, data: { content, theme, locale }, ready: false, busy: false,
      current: () => !settled && !guest.isDestroyed() && !parent.isDestroyed() && options.current(), confirm: options.confirm, finish })
    guest.once('destroyed', cancelled)
    guest.on('did-start-navigation', navigated)
    parent.on('move', reposition)
    parent.on('resize', reposition)
    win.once('closed', cancelled)
    win.webContents.once('render-process-gone', cancelled)
    win.webContents.on('will-navigate', event => event.preventDefault())
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const rendererUrl = process.env['ELECTRON_RENDERER_URL']
    const load = rendererUrl ? win.loadURL(new URL('browser-prompt.html', rendererUrl.endsWith('/') ? rendererUrl : rendererUrl + '/').href) : win.loadFile(join(__dirname, '../renderer/browser-prompt.html'))
    void load.catch(cancelled)
  })
}
