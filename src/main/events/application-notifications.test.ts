import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ windows: [] as Array<{ isDestroyed: () => boolean; webContents: { trusted: boolean; send: ReturnType<typeof vi.fn> } }> }))
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => mocks.windows } }))
vi.mock('../security/application-caller', () => ({ applicationCallers: { isTrusted: (contents: { trusted: boolean }) => contents.trusted } }))
import { broadcastDshWebDetail, broadcastMcpSessionLocked, broadcastMcpSessionUnlocked, broadcastSessionsChanged } from './application-notifications'

describe('application notification adapter', () => {
  beforeEach(() => { mocks.windows = [] })
  it('only broadcasts to live trusted application windows', () => {
    const window = (destroyed: boolean, trusted: boolean) => ({ isDestroyed: () => destroyed, webContents: { trusted, send: vi.fn() } })
    const trusted = window(false, true), guest = window(false, false), closed = window(true, true)
    mocks.windows = [trusted, guest, closed]
    broadcastSessionsChanged()
    broadcastMcpSessionLocked('session-1')
    broadcastMcpSessionUnlocked('session-1')
    expect(trusted.webContents.send.mock.calls).toEqual([
      ['sessions:changed'], ['mcp:session-locked', { sessionId: 'session-1' }], ['mcp:session-unlocked', { sessionId: 'session-1' }]
    ])
    expect(guest.webContents.send).not.toHaveBeenCalled()
    expect(closed.webContents.send).not.toHaveBeenCalled()
  })
  it('preserves explicit shared-workbench navigation flags and identity', () => {
    const send = vi.fn()
    mocks.windows = [{ isDestroyed: () => false, webContents: { trusted: true, send } }]
    const detail = { key: null, phase: 'free', petSessionId: null, taskId: null, instanceEpoch: null, readOnly: true, updatedAt: 5 } as Parameters<typeof broadcastDshWebDetail>[0]
    broadcastDshWebDetail(detail, true, true)
    expect(send).toHaveBeenCalledWith('dsh:web:detail-changed', { detail, force: true, reopen: true })
  })
})
