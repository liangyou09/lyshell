import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import type { IpcMainInvokeEvent } from 'electron'
const mocks = vi.hoisted(() => ({ handler: undefined as ((event: IpcMainInvokeEvent, raw: unknown) => Promise<unknown>) | undefined, create: vi.fn() }))
vi.mock('../ipc/application-ipc', () => ({ applicationIpc: { handle: (_channel: string, handler: typeof mocks.handler) => { mocks.handler = handler } } }))
vi.mock('../security/application-caller', () => ({ applicationCallers: {
  context: (event: { sender: { trusted: boolean; mainFrame: object }; senderFrame: object }) => { if (!event.sender.trusted || event.sender.mainFrame !== event.senderFrame) throw Error('Rejected application frame') },
  isTrusted: (sender: { trusted: boolean }) => sender.trusted
} }))
vi.mock('./readonly-view-pilot', () => ({ createReadonlyViewPilotPort: mocks.create }))
import { registerBrowserHostIpc } from './browser-host-ipc'
class Sender extends EventEmitter { trusted = true; mainFrame = { url: 'file:///application.html' } }
const event = (sender: Sender, frame = sender.mainFrame) => ({ sender, senderFrame: frame } as unknown as IpcMainInvokeEvent)
describe('browser host IPC ownership adapter', () => {
  beforeEach(() => { vi.clearAllMocks() })
  it('rejects subframes and untrusted application documents before native creation', async () => {
    const registration = registerBrowserHostIpc(), sender = new Sender()
    const request = { kind: 'create-readonly-pilot', url: 'https://page.test/' }
    expect(await mocks.handler!(event(sender, { url: 'file:///application.html' }), request)).toMatchObject({ success: false })
    sender.trusted = false
    expect(await mocks.handler!(event(sender), request)).toMatchObject({ success: false })
    expect(mocks.create).not.toHaveBeenCalled()
    await registration.shutdown()
  })
  it('revokes and removes old document listeners on main-frame navigation', async () => {
    const registration = registerBrowserHostIpc(), sender = new Sender()
    expect(await mocks.handler!(event(sender), { kind: 'capabilities' })).toMatchObject({ success: true })
    expect(sender.listenerCount('did-start-navigation')).toBe(1)
    sender.emit('did-start-navigation', {}, 'https://elsewhere.test/', true, true)
    expect(sender.listenerCount('did-start-navigation')).toBe(1)
    sender.emit('did-start-navigation', {}, 'file:///application.html', false, true)
    expect(sender.listenerCount('did-start-navigation')).toBe(0)
    expect(sender.listenerCount('render-process-gone')).toBe(0)
    sender.mainFrame = { url: 'file:///application.html' }
    await mocks.handler!(event(sender), { kind: 'capabilities' })
    expect(sender.listenerCount('did-start-navigation')).toBe(1)
    sender.emit('destroyed')
    expect(sender.listenerCount('did-start-navigation')).toBe(0)
    await registration.shutdown()
  })
})
