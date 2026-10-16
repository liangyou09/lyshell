import { session } from 'electron'
import type { Certificate, WebContents } from 'electron'
import { randomUUID, X509Certificate } from 'crypto'
import { WEBBAR_PARTITION } from '@shared/constants'
import type { BrowserCertificateInfo, BrowserResult } from '@shared/browser-settings'

interface Failure extends BrowserCertificateInfo {
  url: string
  origin: string
  error: string
  fingerprint: string
  subject: string
  issuer: string
  validFrom: string
  validTo: string
}
interface GuestState {
  guest: WebContents
  failure?: Failure
}
const guests = new Map<number, GuestState>()
const trustedCertificates = new Map<string, string>()
const browserSession = () => session.fromPartition(WEBBAR_PARTITION)

function httpsUrl(raw: string): URL | null {
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' && !url.username && !url.password ? url : null
  } catch { return null }
}

function failureDetails(raw: string, error: string, certificate: Certificate): Failure | undefined {
  const url = httpsUrl(raw)
  if (!url) return
  try {
    // 指纹由实际 DER 证书计算，绝不接受 renderer 提供的证书或信任范围。
    const cert = new X509Certificate(certificate.data)
    return { certificateId: randomUUID(), url: url.href, origin: url.origin, error, fingerprint: cert.fingerprint256,
      subject: cert.subject, issuer: cert.issuer, validFrom: cert.validFrom, validTo: cert.validTo }
  } catch { return }
}

/** 错误归属具体 webview；信任仅存于内置浏览器会话，不修改系统证书。 */
export function setupBrowserCertificates(guest: WebContents): void {
  if (guest.session !== browserSession() || guest.getType() !== 'webview' || guests.has(guest.id)) return
  const state: GuestState = { guest }
  guests.set(guest.id, state)
  guest.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) state.failure = undefined
  })
  guest.on('certificate-error', (event, url, error, certificate, callback, isMainFrame) => {
    const failure = failureDetails(url, error, certificate)
    event.preventDefault()
    if (failure && trustedCertificates.get(new URL(failure.url).hostname) === failure.fingerprint) {
      callback(true)
      return
    }
    // 子资源的证书失败不能冒充主页面失败，为无关域名制造放行入口。
    if (failure && isMainFrame) state.failure = failure
    callback(false)
  })
  guest.once('destroyed', () => { state.failure = undefined; guests.delete(guest.id) })
}

export function invalidateBrowserCertificatePrompts(): void {
  for (const state of guests.values()) state.failure = undefined
}

function currentFailure(ownerId: number, guestId: number, rawUrl: string): { state: GuestState; failure: Failure } | undefined {
  const state = guests.get(guestId)
  const url = httpsUrl(rawUrl)
  const failure = state?.failure
  if (state && failure && !state.guest.isDestroyed() && state.guest.session === browserSession() &&
    state.guest.hostWebContents?.id === ownerId && url?.href === failure.url) return { state, failure }
  return undefined
}

export function getBrowserCertificate(ownerId: number, guestId: number, rawUrl: string): BrowserResult {
  const current = currentFailure(ownerId, guestId, rawUrl)
  if (!current) return { success: false, error: 'browserCertificateUnavailable' }
  const { certificateId, origin, error, subject, issuer, validFrom, validTo, fingerprint } = current.failure
  return { success: true, certificate: { certificateId, origin, error, subject, issuer, validFrom, validTo, fingerprint } }
}

/** 页内高级入口只可放行用户刚查看过的那次实际失败；页面换证书后旧 ID 失效。 */
export async function confirmBrowserCertificate(ownerId: number, guestId: number, rawUrl: string, certificateId: string): Promise<BrowserResult> {
  const initial = currentFailure(ownerId, guestId, rawUrl)
  if (!initial || initial.failure.certificateId !== certificateId) return { success: false, error: 'browserCertificateUnavailable' }
  try {
    await browserSession().closeAllConnections()
    const current = currentFailure(ownerId, guestId, rawUrl)
    if (current?.state !== initial.state || current.failure !== initial.failure) return { success: false, error: 'browserCertificateUnavailable' }
    // Chromium 的例外作用于当前 browser session 的主机和证书，完全退出后失效。
    trustedCertificates.set(new URL(initial.failure.url).hostname, initial.failure.fingerprint)
    return { success: true, certificateTrusted: true }
  } catch { return { success: false, error: 'browserCertificateUnavailable' } }
}
