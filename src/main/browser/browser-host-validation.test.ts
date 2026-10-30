import { describe, expect, it } from 'vitest'
import { validateBrowserHostRequest } from './browser-host-validation'
const host = { hostId: '8f06a56e-cfe4-45a1-ad09-7e1fce31a005', generation: 1, kind: 'web-contents-view' }
describe('browser host untrusted request validation', () => {
  it('accepts the bounded public protocol', () => {
    for (const request of [{ kind: 'capabilities' }, { kind: 'create-readonly-pilot', url: 'https://page.test/' }, { kind: 'inspect', host }, { kind: 'reload', host, ignoreCache: true }, { kind: 'bounds', host, bounds: { x: 1, y: 2, width: 640, height: 480 } }]) expect(validateBrowserHostRequest(request)).toEqual(request)
  })
  it('rejects owner/path injection, forged handles and oversized geometry', () => {
    for (const request of [{ kind: 'create-readonly-pilot', url: 'https://page.test/', preload: '/arbitrary' }, { kind: 'inspect', host, ownerId: 1 }, { kind: 'inspect', host: { ...host, generation: 0 } }, { kind: 'inspect', host: { ...host, kind: 'webview' } }, { kind: 'bounds', host, bounds: { x: -1, y: 0, width: 20, height: 20 } }, { kind: 'bounds', host, bounds: { x: 0, y: 0, width: 16384, height: 16384 } }, { kind: 'navigate', host, url: 'x'.repeat(4097) }, { kind: 'visibility', host, visible: 'true' }]) expect(() => validateBrowserHostRequest(request)).toThrow('Invalid browser host request')
  })
})
