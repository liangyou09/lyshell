import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserHostService, type BrowserHostOwner, type BrowserHostPort } from './browser-host'
import type { BrowserHostSnapshot } from '@shared/browser-host'

function fixture(overrides: { enabled?: boolean; closeConfirms?: boolean; detachConfirms?: boolean } = {}) {
  const owner: BrowserHostOwner = { sender: {}, document: {} }
  let current = true, enabled = overrides.enabled ?? true, destroyed = false, detached = true, visible = false, verified = true
  let url = '', bounds = { x: 0, y: 0, width: 0, height: 0 }
  const listeners = new Set<(event: 'changed' | 'crashed' | 'destroyed') => void>()
  const emit = (event: 'changed' | 'crashed' | 'destroyed') => { for (const listener of [...listeners]) listener(event) }
  const port: BrowserHostPort = {
    state: () => ({ url, loading: false, canGoBack: false, canGoForward: false, visible, bounds, protection: 'safe' }),
    verified: () => verified, destroyed: () => destroyed, detached: () => detached,
    attach: vi.fn(() => { detached = false }),
    detach: vi.fn(() => { if (overrides.detachConfirms !== false) detached = true }),
    navigate: vi.fn(async value => { url = value; emit('changed') }),
    back: vi.fn(), forward: vi.fn(), reload: vi.fn(), stop: vi.fn(), focus: vi.fn(),
    setBounds: value => { bounds = value }, setVisible: value => { visible = value },
    capture: vi.fn(async () => 'data:image/png;base64,AA=='),
    close: vi.fn(() => { if (overrides.closeConfirms !== false) { destroyed = true; emit('destroyed') } }),
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } }
  }
  const create = vi.fn(() => port)
  const service = new BrowserHostService({ enabled: () => enabled, isOwnerCurrent: () => current, create, validateUrl: value => value === 'https://page.test/', closeTimeoutMs: 5, captureBytes: 1024 })
  const start = async () => { const result = await service.request(owner, { kind: 'create-readonly-pilot', url: 'https://page.test/' }); if (!result.success || !result.snapshot) throw Error('Expected host'); return result.snapshot.handle }
  return { owner, port, service, create, start, emit, setCurrent: (value: boolean) => { current = value }, setEnabled: (value: boolean) => { enabled = value }, setVerified: (value: boolean) => { verified = value }, destroy: () => { destroyed = true; emit('destroyed') }, confirmDetach: () => { detached = true } }
}
const snapshot = (value: Awaited<ReturnType<BrowserHostService['request']>>): BrowserHostSnapshot => { if (!value.success || !value.snapshot) throw Error('Expected snapshot'); return value.snapshot }
describe('browser host ownership and lifecycle', () => {
  beforeEach(() => { vi.restoreAllMocks() })
  it('defaults to unavailable when the explicit pilot capability is off', async () => {
    const f = fixture({ enabled: false })
    expect(await f.service.request(f.owner, { kind: 'capabilities' })).toEqual({ success: true, pilotEnabled: false })
    await expect(f.start()).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' })
    expect(f.create).not.toHaveBeenCalled()
  })
  it('rejects another sender, another document, and stale generation handles', async () => {
    const f = fixture(), host = await f.start()
    for (const owner of [{ sender: {}, document: f.owner.document }, { sender: f.owner.sender, document: {} }]) {
      await expect(f.service.request(owner, { kind: 'inspect', host })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    }
    await expect(f.service.request(f.owner, { kind: 'focus', host: { ...host, generation: 2 } })).rejects.toMatchObject({ code: 'STALE_GENERATION' })
    expect(f.port.focus).not.toHaveBeenCalled()
  })
  it('keeps its only slot until both view removal and WebContents destruction are confirmed', async () => {
    const f = fixture({ closeConfirms: false }), host = await f.start()
    await f.service.request(f.owner, { kind: 'attach', host })
    const closing = f.service.request(f.owner, { kind: 'close', host })
    await expect(f.start()).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
    expect(snapshot(await closing).phase).toBe('close-unconfirmed')
    await expect(f.start()).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
    f.destroy()
    expect(snapshot(await f.service.request(f.owner, { kind: 'inspect', host })).phase).toBe('closed')
    expect(f.port.close).toHaveBeenCalledOnce()
  })
  it('does not treat destroyed contents as a confirmed detach and allows explicit reconciliation', async () => {
    const f = fixture({ detachConfirms: false }), host = await f.start()
    await f.service.request(f.owner, { kind: 'attach', host })
    expect(snapshot(await f.service.request(f.owner, { kind: 'close', host })).phase).toBe('close-unconfirmed')
    await expect(f.start()).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
    f.confirmDetach()
    expect(snapshot(await f.service.request(f.owner, { kind: 'close', host })).phase).toBe('closed')
  })
  it('rechecks the owner document after async navigation and closes its exact host', async () => {
    const f = fixture()
    let finish!: () => void
    vi.mocked(f.port.navigate).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    const created = f.start()
    f.setCurrent(false); finish()
    await expect(created).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(f.port.detach).toHaveBeenCalledOnce()
    expect(f.port.close).toHaveBeenCalledOnce()
  })
  it('refuses capture results after owner invalidation and does not navigate forbidden URLs', async () => {
    const f = fixture(), host = await f.start()
    await expect(f.service.request(f.owner, { kind: 'navigate', host, url: 'https://page.test/?secret=value' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(f.port.navigate).toHaveBeenCalledTimes(1)
    let finish!: (value: string) => void
    vi.mocked(f.port.capture).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const captured = f.service.request(f.owner, { kind: 'capture', host })
    f.setCurrent(false); finish('data:image/png;base64,AA==')
    await expect(captured).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('allows only one native capture in flight and releases the permit after success or failure', async () => {
    const f = fixture(), host = await f.start()
    let finish!: (value: string) => void
    vi.mocked(f.port.capture).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const first = f.service.request(f.owner, { kind: 'capture', host })
    await expect(f.service.request(f.owner, { kind: 'capture', host })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' })
    expect(f.port.capture).toHaveBeenCalledOnce()
    finish('data:image/png;base64,AA==')
    expect(await first).toMatchObject({ success: true, image: 'data:image/png;base64,AA==' })
    vi.mocked(f.port.capture).mockRejectedValueOnce(new Error('native capture failed'))
    await expect(f.service.request(f.owner, { kind: 'capture', host })).rejects.toThrow('native capture failed')
    expect(await f.service.request(f.owner, { kind: 'capture', host })).toMatchObject({ success: true })
    expect(f.port.capture).toHaveBeenCalledTimes(3)
  })
  it('rejects a captured image when its exact host closed while capture was pending', async () => {
    const f = fixture(), host = await f.start()
    let finish!: (value: string) => void
    vi.mocked(f.port.capture).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const captured = f.service.request(f.owner, { kind: 'capture', host })
    expect(snapshot(await f.service.request(f.owner, { kind: 'close', host })).phase).toBe('closed')
    finish('data:image/png;base64,AA==')
    await expect(captured).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', retryDisposition: 'reconcile-first' })
  })


  it('rejects an image captured across a changed revision and releases its capture permit', async () => {
    const f = fixture(), host = await f.start()
    const before = snapshot(await f.service.request(f.owner, { kind: 'inspect', host })).revision
    let finish!: (value: string) => void
    vi.mocked(f.port.capture).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const captured = f.service.request(f.owner, { kind: 'capture', host })
    f.emit('changed')
    expect(snapshot(await f.service.request(f.owner, { kind: 'inspect', host })).revision).toBeGreaterThan(before)
    finish('data:image/png;base64,old-revision')
    await expect(captured).rejects.toMatchObject({ code: 'STALE_GENERATION', retryDisposition: 'safe' })
    expect(await f.service.request(f.owner, { kind: 'capture', host })).toMatchObject({ success: true, image: 'data:image/png;base64,AA==' })
    expect(f.port.capture).toHaveBeenCalledTimes(2)
  })

  it('supports attach/hide/bounds/focus and rejects commands after a native crash', async () => {
    const f = fixture(), host = await f.start()
    await f.service.request(f.owner, { kind: 'visibility', host, visible: true })
    expect(snapshot(await f.service.request(f.owner, { kind: 'inspect', host })).visible).toBe(false)
    await f.service.request(f.owner, { kind: 'attach', host })
    await f.service.request(f.owner, { kind: 'bounds', host, bounds: { x: 10, y: 20, width: 100, height: 80 } })
    await f.service.request(f.owner, { kind: 'visibility', host, visible: true })
    await f.service.request(f.owner, { kind: 'focus', host })
    expect(f.port.focus).toHaveBeenCalledOnce()
    f.emit('crashed')
    expect(snapshot(await f.service.request(f.owner, { kind: 'inspect', host })).phase).toBe('crashed')
    await expect(f.service.request(f.owner, { kind: 'reload', host })).rejects.toMatchObject({ code: 'STALE_GENERATION' })
    expect(snapshot(await f.service.request(f.owner, { kind: 'close', host })).phase).toBe('closed')
  })
  it('ignores late events after confirmed close and closes on owner release or application shutdown', async () => {
    const f = fixture(), host = await f.start()
    const before = snapshot(await f.service.request(f.owner, { kind: 'close', host }))
    f.emit('changed'); f.emit('crashed')
    expect(snapshot(await f.service.request(f.owner, { kind: 'inspect', host }))).toEqual(before)
    await f.service.releaseOwner(f.owner.sender)
    await f.service.shutdown()
    expect(f.port.close).toHaveBeenCalledOnce()
    await expect(f.start()).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' })
  })
})
