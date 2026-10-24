// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OverlayPayload, PaneLeaf } from '@shared/types'
import { ConnectionType, ConnectionStatus } from '@shared/types'
import { attachProjectEntrySession } from './project-entry-launch'
import { usePaneStore } from './pane-store'
import { useSessionStore } from './session-store'

const payload: Extract<OverlayPayload, { kind: 'projectEntry' }> = { kind: 'projectEntry', projectSceneId: 'scene-a', target: { presetId: 'a', cwd: 'C:/a' }, entry: { kind: 'directory' } }
const leaf = (id: string, entry = false): PaneLeaf => ({ id, type: 'leaf', sessions: [], activeSessionId: null, overlays: entry ? [{ id: 'entry', kind: 'projectEntry', active: true, slot: null }] : [] })
const config = { id: 'new-session', name: 'Alpha', type: ConnectionType.LOCAL, local: { cwd: 'C:/a' }, tags: [], terminal: {} as Parameters<ReturnType<typeof useSessionStore.getState>['createSession']>[0]['terminal'], createdAt: new Date(), updatedAt: new Date() }
beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { platform: 'win32', getSession: vi.fn(async () => config) } })
  useSessionStore.setState({ sessions: [], pendingSessionCwd: {}, pendingRuntimeEncoding: {}, pendingSessionStatus: {} })
  usePaneStore.setState({ layout: { activePaneId: 'other', root: { id: 'root', type: 'split', direction: 'horizontal', splitRatio: .5, firstChild: leaf('origin', true), secondChild: leaf('other') } }, overlayPayloads: { entry: payload }, hiddenTabSessions: {} })
})
describe('scene terminal placement', () => {
  it('replaces the original entry even when another split is active', async () => {
    await attachProjectEntrySession('entry', payload, config.id)
    expect(usePaneStore.getState().getPaneBySessionId(config.id)?.id).toBe('origin')
    expect(usePaneStore.getState().getOverlayPaneId('entry')).toBeNull()
    expect(useSessionStore.getState().sessions.find(session => session.id === config.id)?.status).toBe(ConnectionStatus.CONNECTING)
  })
  it('preserves a terminal already known to have exited', async () => {
    useSessionStore.getState().addTemporarySession({ id: config.id, config, status: ConnectionStatus.DISCONNECTED })
    await attachProjectEntrySession('entry', payload, config.id)
    expect(useSessionStore.getState().sessions[0].status).toBe(ConnectionStatus.DISCONNECTED)
  })
  it('preserves an exit received while the terminal configuration is still loading', async () => {
    let finish!: (value: typeof config) => void
    vi.mocked(window.electronAPI.getSession).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const placement = attachProjectEntrySession('entry', payload, config.id)
    useSessionStore.getState().updateSessionStatus(config.id, ConnectionStatus.ERROR, 'process exited')
    finish(config)
    await placement
    expect(useSessionStore.getState().sessions[0]).toMatchObject({ status: ConnectionStatus.ERROR, lastError: 'process exited' })
    expect(useSessionStore.getState().pendingSessionStatus).toEqual({})
  })
})
