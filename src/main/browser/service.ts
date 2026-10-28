import { BrowserWindow, dialog, ipcMain, session, webContents } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { atomicWriteFileSync, getConfigDir, preferencesRepository } from '../storage/repository'
import { WEBBAR_PARTITION } from '@shared/constants'
import { BROWSER_CAPTURE_CHANNEL, BROWSER_FILL_CHANNEL, DEFAULT_BROWSER_SETTINGS, browserOrigin, type BrowserPermission, type BrowserRequest, type BrowserResult, type BrowserSettings } from '@shared/browser-settings'
import { validateBrowserSettings } from './validation'
import { BrowserPasswords } from './passwords'
import { confirmBrowserCertificate, getBrowserCertificate, invalidateBrowserCertificatePrompts, setupBrowserCertificates } from './certificates'
import { initializeBrowserPrompts, requestBrowserPrompt } from './prompts'
import { browserDownloadAction, getBrowserDownloads, initializeBrowserDownloads, openBrowserDownloadDirectory } from './downloads'
import { browserSearchSuggestions, clearBrowserSearchSuggestions } from './search-suggestions'

const passwords = new BrowserPasswords()
let settings: BrowserSettings | null = null
let operations: Promise<unknown> = Promise.resolve()
const grants = new Set<string>()
const prompting = new Set<number>()
const lastCapture = new Map<number, number>()
const documentEpochs = new Map<number, number>()
const browserSession = () => session.fromPartition(WEBBAR_PARTITION)
const settingsPath = () => join(getConfigDir(), 'browser-settings.json')
const zh = () => String(preferencesRepository.get('locale')).startsWith('zh')
const label = (cn: string, en: string) => zh() ? cn : en

export function getBrowserSettings(): BrowserSettings {
  if (!settings) {
    const path = settingsPath()
    try { settings = existsSync(path) ? validateBrowserSettings(JSON.parse(readFileSync(path, 'utf8'))) : structuredClone(DEFAULT_BROWSER_SETTINGS) }
    catch { settings = structuredClone(DEFAULT_BROWSER_SETTINGS) }
  }
  return settings
}

function guestOrigin(event: IpcMainEvent | IpcMainInvokeEvent): string | null {
  if (event.sender.isDestroyed() || event.sender.session !== browserSession() || event.sender.getType() !== 'webview' || event.senderFrame !== event.sender.mainFrame) return null
  return browserOrigin(event.senderFrame.url)
}

async function applyProxy(value: BrowserSettings): Promise<void> {
  const ses = browserSession()
  await ses.setProxy(value.proxyMode === 'fixed'
    ? { mode: 'fixed_servers', proxyRules: value.proxyServer, proxyBypassRules: value.proxyBypass }
    : { mode: value.proxyMode })
  await ses.closeAllConnections()
}

export function setupBrowserGuest(guest: WebContents): void {
  setupBrowserCertificates(guest)
  const reset = () => {
    documentEpochs.set(guest.id, (documentEpochs.get(guest.id) ?? 0) + 1)
    for (const key of grants) if (key.startsWith(`${guest.id}|`)) grants.delete(key)
  }
  guest.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) reset() })
  guest.on('dom-ready', () => { if (!guest.isDestroyed()) guest.setZoomFactor(getBrowserSettings().zoomFactor) })
  guest.once('destroyed', () => { reset(); lastCapture.delete(guest.id); documentEpochs.delete(guest.id) })
}

function permissionKeys(permission: string, mediaTypes?: string[]): BrowserPermission[] {
  if (permission === 'media') return mediaTypes?.length ? mediaTypes.flatMap(v => v === 'video' ? ['camera' as const] : v === 'audio' ? ['microphone' as const] : []) : ['camera', 'microphone']
  if (permission === 'notifications' || permission === 'geolocation') return [permission]
  if (permission === 'clipboard-read' || permission === 'deprecated-sync-clipboard-read') return ['clipboard']
  return []
}

export async function initializeBrowser(): Promise<void> {
  initializeBrowserPrompts()
  initializeBrowserDownloads()
  await applyProxy(getBrowserSettings())
  const ses = browserSession()
  ses.setPermissionCheckHandler((guest, permission, origin, details) => {
    if (!guest || guest.isDestroyed() || browserOrigin(origin) !== browserOrigin(guest.getURL())) return false
    if (['fullscreen', 'pointerLock', 'clipboard-sanitized-write'].includes(permission)) return true
    const keys = permissionKeys(permission, 'mediaType' in details ? [String(details.mediaType)] : undefined)
    return keys.length > 0 && keys.every(key => getBrowserSettings().permissions[key] !== 'deny' && grants.has(`${guest.id}|${browserOrigin(origin)}|${key}`))
  })
  ses.setPermissionRequestHandler((guest, permission, callback, details) => {
    const origin = browserOrigin(details.requestingUrl || guest.getURL())
    if (!origin || origin !== browserOrigin(guest.getURL())) { callback(false); return }
    if (['fullscreen', 'pointerLock', 'clipboard-sanitized-write'].includes(permission)) { callback(true); return }
    const keys = permissionKeys(permission, 'mediaTypes' in details ? details.mediaTypes : undefined)
    if (!keys.length || keys.some(key => getBrowserSettings().permissions[key] === 'deny') || prompting.has(guest.id)) { callback(false); return }
    const names: Record<BrowserPermission, string> = {
      camera: label('摄像头', 'camera'), microphone: label('麦克风', 'microphone'), notifications: label('通知', 'notifications'), geolocation: label('位置', 'location'), clipboard: label('剪贴板', 'clipboard')
    }
    prompting.add(guest.id)
    const epoch = documentEpochs.get(guest.id)
    const parent = BrowserWindow.fromWebContents(guest.hostWebContents ?? guest)
    const options: Electron.MessageBoxOptions = { type: 'question', title: label('网站权限', 'Website permission'), message: origin, detail: label('请求访问：', 'Requesting access to: ') + keys.map(key => names[key]).join(', '), buttons: [label('拒绝', 'Deny'), label('仅允许本页', 'Allow for this page')], defaultId: 0, cancelId: 0, noLink: true }
    void (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)).then(result => {
      const allowed = result.response === 1 && !guest.isDestroyed() && documentEpochs.get(guest.id) === epoch && browserOrigin(guest.getURL()) === origin && keys.every(key => getBrowserSettings().permissions[key] !== 'deny')
      if (allowed) for (const key of keys) grants.add(`${guest.id}|${origin}|${key}`)
      callback(allowed)
    }).catch(() => callback(false)).finally(() => prompting.delete(guest.id))
  })

  // 仅专用隔离 preload 可发起；密码不经过宿主 renderer 或日志。
  ipcMain.handle(BROWSER_FILL_CHANNEL, (event, raw: unknown) => {
    const origin = guestOrigin(event)
    if (!origin || !getBrowserSettings().savePasswords || !passwords.available() || !raw || typeof raw !== 'object') return null
    const request = raw as Record<string, unknown>
    try {
      // 候选阶段只返回当前站点的账号元数据；用户选定后才解密对应密码。
      if (request.kind === 'suggestions') return passwords.list().filter(item => item.origin === origin).sort((a, b) => b.updatedAt - a.updatedAt).map(({ id, username }) => ({ id, username }))
      if (request.kind === 'fill' && typeof request.id === 'string' && request.id.length > 0 && request.id.length <= 128) return passwords.find(origin, request.id)
      return null
    } catch { return null }
  })
  ipcMain.on(BROWSER_CAPTURE_CHANNEL, (event, raw: unknown) => {
    const origin = guestOrigin(event)
    if (!origin || !getBrowserSettings().savePasswords || !passwords.available() || !raw || typeof raw !== 'object') return
    const { username, password, origin: sourceOrigin } = raw as Record<string, unknown>
    if (sourceOrigin !== origin) return
    if (typeof username !== 'string' || username.length > 1024 || typeof password !== 'string' || !password || password.length > 4096) return
    const guest = event.sender
    if (prompting.has(guest.id) || Date.now() - (lastCapture.get(guest.id) ?? 0) < 15000) return
    try { const old = passwords.find(origin); if (old?.username === username && old.password === password) return } catch { return }
    lastCapture.set(guest.id, Date.now())
    prompting.add(guest.id)
    const current = () => !guest.isDestroyed() && browserOrigin(guest.getURL()) === origin && getBrowserSettings().savePasswords
    // 密码仅保留在 main 闭包中；独立确认页只收到站点和用户名。保存失败留在弹窗内重试。
    void requestBrowserPrompt(guest, { kind: 'password', origin, username }, {
      current,
      confirm: () => { if (!current()) throw new Error('Password confirmation expired'); passwords.save(origin, username, password) }
    }).catch(() => undefined).finally(() => prompting.delete(guest.id))
  })
}

/** 由已验证的宿主 IPC 调用。写入串行，代理应用失败不会保存半份配置。 */
export function browserRequest(request: Exclude<BrowserRequest, { kind: 'defaultBrowserStatus' | 'requestDefaultBrowser' }>, ownerId?: number): Promise<BrowserResult> {
  if (request.kind === 'searchSuggestions') {
    const searchEngine = getBrowserSettings().searchEngine
    return browserSearchSuggestions(browserSession(), request.query, searchEngine)
      .then(searchSuggestions => ({ success: true, searchSuggestions, searchEngine }))
  }
  if (request.kind === 'downloads') return Promise.resolve({ success: true, downloadSnapshot: getBrowserDownloads() })
  if (request.kind === 'openDownloadDirectory') return openBrowserDownloadDirectory().then(success => ({ success })).catch(() => ({ success: false, error: 'browserDownloadFailed' }))
  if (request.kind === 'downloadAction') {
    try { return Promise.resolve(browserDownloadAction(request.id, request.action)).then(success => ({ success })).catch(() => ({ success: false, error: 'browserDownloadFailed' })) }
    catch { return Promise.resolve({ success: false, error: 'browserDownloadFailed' }) }
  }
  if (request.kind === 'certificateInfo') return Promise.resolve(getBrowserCertificate(ownerId ?? -1, request.guestId, request.url))
  if (request.kind === 'trustCertificate') return confirmBrowserCertificate(ownerId ?? -1, request.guestId, request.url, request.certificateId)
  const result = operations.then(async (): Promise<BrowserResult> => {
    try {
      switch (request.kind) {
        case 'get': return { success: true, settings: getBrowserSettings(), encryptionAvailable: passwords.available() }
        case 'save': {
          const next = validateBrowserSettings(request.settings)
          const previous = getBrowserSettings()
          const proxyChanged = next.proxyMode !== previous.proxyMode || next.proxyServer !== previous.proxyServer || next.proxyBypass !== previous.proxyBypass
          if (proxyChanged) {
            try { await applyProxy(next) }
            catch (error) { await applyProxy(previous); throw error }
          }
          try { atomicWriteFileSync(settingsPath(), JSON.stringify(next, null, 2)) }
          catch (error) { if (proxyChanged) await applyProxy(previous); throw error }
          settings = next
          clearBrowserSearchSuggestions()
          grants.clear()
          for (const wc of webContents.getAllWebContents()) if (!wc.isDestroyed() && wc.session === browserSession()) wc.setZoomFactor(next.zoomFactor)
          return { success: true, settings: next }
        }
        case 'clear':
          clearBrowserSearchSuggestions()
          if (request.target === 'cache') await browserSession().clearCache()
          else { invalidateBrowserCertificatePrompts(); await browserSession().clearStorageData(); await browserSession().closeAllConnections(); grants.clear() }
          return { success: true }
        case 'passwords': return { success: true, passwords: passwords.list(), encryptionAvailable: passwords.available() }
        case 'savePassword': passwords.save(request.origin, request.username, request.password); return { success: true, passwords: passwords.list() }
        case 'deletePassword': passwords.delete(request.id); return { success: true, passwords: passwords.list() }
      }
    } catch { return { success: false, error: 'browserOperationFailed' } }
  })
  operations = result.catch(() => undefined)
  return result
}
