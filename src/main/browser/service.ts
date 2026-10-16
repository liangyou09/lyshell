import { BrowserWindow, dialog, ipcMain, session, webContents } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { atomicWriteFileSync, getConfigDir, preferencesRepository } from '../storage/repository'
import { WEBBAR_PARTITION } from '@shared/constants'
import { BROWSER_CAPTURE_CHANNEL, BROWSER_FILL_CHANNEL, DEFAULT_BROWSER_SETTINGS, browserOrigin, type BrowserPermission, type BrowserRequest, type BrowserResult, type BrowserSettings } from '@shared/browser-settings'
import { validateBrowserSettings } from './validation'
import { BrowserPasswords } from './passwords'

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
  ipcMain.handle(BROWSER_FILL_CHANNEL, (event) => {
    const origin = guestOrigin(event)
    if (!origin || !getBrowserSettings().savePasswords) return null
    try { return passwords.find(origin) } catch { return null }
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
    const parent = BrowserWindow.fromWebContents(guest.hostWebContents ?? guest)
    const options: Electron.MessageBoxOptions = { type: 'question', title: label('保存密码', 'Save password'), message: label('保存此网站的登录密码？', 'Save the password for this website?'), detail: `${origin}\n${username}\n\n${label('使用系统加密保存到本机。', 'Stored on this computer using system encryption.')}`, buttons: [label('暂不保存', 'Not now'), label('保存', 'Save')], defaultId: 0, cancelId: 0, noLink: true }
    void (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)).then(result => {
      if (result.response === 1 && getBrowserSettings().savePasswords) passwords.save(origin, username, password)
    }).catch(() => {
      // 只展示固定文案，异常内容可能带有凭据或磁盘上下文。
      void dialog.showMessageBox({ type: 'error', title: label('保存密码失败', 'Password was not saved'), message: label('请检查系统加密和本机存储状态后重试。', 'Check system encryption and local storage, then try again.') }).catch(() => undefined)
    }).finally(() => prompting.delete(guest.id))
  })
}

/** 由已验证的宿主 IPC 调用。写入串行，代理应用失败不会保存半份配置。 */
export function browserRequest(request: BrowserRequest): Promise<BrowserResult> {
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
          grants.clear()
          for (const wc of webContents.getAllWebContents()) if (!wc.isDestroyed() && wc.session === browserSession()) wc.setZoomFactor(next.zoomFactor)
          return { success: true, settings: next }
        }
        case 'clear':
          if (request.target === 'cache') await browserSession().clearCache()
          else { await browserSession().clearStorageData(); await browserSession().closeAllConnections(); grants.clear() }
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
