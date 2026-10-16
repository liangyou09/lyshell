import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { rootCertificates } from 'tls'
import { X509Certificate } from 'crypto'
const mocks = vi.hoisted(() => ({ session: { closeAllConnections: vi.fn() } }))
vi.mock('electron', () => ({ session: { fromPartition: () => mocks.session } }))
const url = 'https://10.5.20.36:8072/'
function guest(id = 1) {
  return Object.assign(new EventEmitter(), { id, hostWebContents: { id: 100 }, session: mocks.session, getType: () => 'webview', isDestroyed: () => false }) as unknown as Electron.WebContents
}
function fail(wc: Electron.WebContents, target = url, pem = rootCertificates[0], mainFrame = true) {
  const callback = vi.fn()
  wc.emit('certificate-error', { preventDefault: vi.fn() }, target, 'ERR_CERT_AUTHORITY_INVALID', { data: pem }, callback, mainFrame)
  return callback
}
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); mocks.session.closeAllConnections.mockResolvedValue(undefined) })
describe('页内证书例外', () => {
  it('默认拒绝；实际证书详情带一次性失败 ID，匹配该 ID 才能放行', async () => {
    const service = await import('./certificates')
    const wc = guest(); service.setupBrowserCertificates(wc)
    expect(fail(wc)).toHaveBeenCalledWith(false)
    const result = service.getBrowserCertificate(100, 1, url)
    expect(result.certificate?.fingerprint).toBe(new X509Certificate(rootCertificates[0]).fingerprint256)
    expect(result.certificate?.origin).toBe(url.slice(0, -1))
    expect(await service.confirmBrowserCertificate(100, 1, url, 'forged')).toMatchObject({ success: false })
    expect(await service.confirmBrowserCertificate(100, 1, url, result.certificate!.certificateId)).toMatchObject({ success: true, certificateTrusted: true })
    wc.emit('did-start-navigation', {}, url, false, true)
    expect(fail(wc)).toHaveBeenCalledWith(true)
    expect(fail(wc, url + 'asset.js', rootCertificates[0], false)).toHaveBeenCalledWith(true)
    expect(fail(wc, 'https://10.5.20.36:8073/')).toHaveBeenCalledWith(true)
    expect(fail(wc, url, rootCertificates[1])).toHaveBeenCalledWith(false)
    expect(fail(wc, 'https://other.example/')).toHaveBeenCalledWith(false)
    const other = guest(2); service.setupBrowserCertificates(other)
    expect(fail(other)).toHaveBeenCalledWith(true)
  })
  it.each(['navigation', 'destroyed', 'clear', 'certificate'])('%s 使已展示的证书 ID 失效', async action => {
    const service = await import('./certificates')
    const wc = guest(); service.setupBrowserCertificates(wc); fail(wc)
    const id = service.getBrowserCertificate(100, 1, url).certificate!.certificateId
    if (action === 'navigation') wc.emit('did-start-navigation', {}, url, false, true)
    if (action === 'destroyed') wc.emit('destroyed')
    if (action === 'clear') service.invalidateBrowserCertificatePrompts()
    if (action === 'certificate') fail(wc, url, rootCertificates[1])
    expect((await service.confirmBrowserCertificate(100, 1, url, id)).success).toBe(false)
    expect(fail(wc)).toHaveBeenCalledWith(false)
  })
  it('禁止其他窗口、其他 URL、无记录及子资源冒充主页面证书', async () => {
    const service = await import('./certificates')
    const wc = guest(); service.setupBrowserCertificates(wc)
    expect(service.getBrowserCertificate(100, 1, url).success).toBe(false)
    fail(wc, url, rootCertificates[0], false)
    expect(service.getBrowserCertificate(100, 1, url).success).toBe(false)
    fail(wc, url, 'not a certificate')
    expect(service.getBrowserCertificate(100, 1, url).success).toBe(false)
    fail(wc)
    for (const [owner, target] of [[200, url], [100, url + 'other'], [100, 'http://10.5.20.36:8072/'], [100, 'https://u:p@10.5.20.36:8072/']] as const) {
      expect(service.getBrowserCertificate(owner, 1, target).success).toBe(false)
    }
    const foreign = guest(2); Object.assign(foreign, { session: {} }); service.setupBrowserCertificates(foreign)
    expect(foreign.listenerCount('certificate-error')).toBe(0)
  })
  it('关闭连接期间换页仍不能授予旧证书例外', async () => {
    const service = await import('./certificates')
    const wc = guest(); service.setupBrowserCertificates(wc); fail(wc)
    const id = service.getBrowserCertificate(100, 1, url).certificate!.certificateId
    let finish!: () => void
    mocks.session.closeAllConnections.mockImplementationOnce(() => new Promise<void>(r => { finish = r }))
    const pending = service.confirmBrowserCertificate(100, 1, url, id)
    wc.emit('did-start-navigation', {}, url, false, true); finish()
    expect((await pending).success).toBe(false)
    expect(fail(wc)).toHaveBeenCalledWith(false)
  })
  it('清除数据和关闭页签不会虚构 Chromium 不支持的 SSL 例外撤销', async () => {
    const service = await import('./certificates')
    const wc = guest(); service.setupBrowserCertificates(wc); fail(wc)
    await service.confirmBrowserCertificate(100, 1, url, service.getBrowserCertificate(100, 1, url).certificate!.certificateId)
    service.invalidateBrowserCertificatePrompts(); expect(fail(wc)).toHaveBeenCalledWith(true)
    wc.emit('destroyed'); const other = guest(); service.setupBrowserCertificates(other)
    expect(fail(other)).toHaveBeenCalledWith(true)
  })
})
