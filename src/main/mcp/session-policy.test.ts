import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ security: {} as Record<string, unknown>, legacy: {} as Record<string, unknown>, sessions: [] as Array<{ id: string; config: { originSavedSessionId: string }; status: string; lastActiveAt: Date }> }))
vi.mock('../storage/repository', () => ({ preferencesRepository: { get: (key: string) => key === 'security' ? { mcp: mocks.security } : mocks.legacy } }))
vi.mock('../terminal/session-manager', () => ({ sessionManager: { getSession: (id: string) => mocks.sessions.find(item => item.id === id), getAllSessions: () => mocks.sessions } }))
import { getMcpSecuritySettings, isSessionAllowedForMcp, resolveRuntimeSessionId } from './session-policy'

describe('shared MCP session policy', () => {
  beforeEach(() => { mocks.security = {}; mocks.legacy = {}; mocks.sessions = [] })
  it('resolves saved aliases by live status before activity and preserves live IDs', () => {
    mocks.sessions = [
      { id: 'new-disconnected', config: { originSavedSessionId: 'saved' }, status: 'disconnected', lastActiveAt: new Date(30) },
      { id: 'older-connected', config: { originSavedSessionId: 'saved' }, status: 'connected', lastActiveAt: new Date(10) },
      { id: 'newer-connected', config: { originSavedSessionId: 'saved' }, status: 'connected', lastActiveAt: new Date(20) }
    ]
    expect(resolveRuntimeSessionId('saved')).toBe('newer-connected')
    expect(resolveRuntimeSessionId('older-connected')).toBe('older-connected')
    expect(resolveRuntimeSessionId('missing')).toBe('missing')
  })
  it('checks saved and runtime deny rules after each permission change', () => {
    mocks.sessions = [{ id: 'runtime', config: { originSavedSessionId: 'saved' }, status: 'connected', lastActiveAt: new Date() }]
    mocks.security = { allowedSessionIds: ['runtime'] }
    expect(isSessionAllowedForMcp('saved')).toBe(true)
    mocks.security.deniedSessionIds = ['saved']
    expect(isSessionAllowedForMcp('saved')).toBe(false)
    mocks.security = { deniedSessionIds: ['runtime'] }
    expect(isSessionAllowedForMcp('saved')).toBe(false)
    mocks.security = { enabled: false }
    expect(isSessionAllowedForMcp('saved')).toBe(false)
    expect(getMcpSecuritySettings().requireConfirmation).toBe(true)
  })
})
