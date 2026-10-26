import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { request } from 'http'
import { TuiActivityRegistry, parseTuiEvent } from './tui-activity'

let registry: TuiActivityRegistry
let now: number
let number = 0
beforeEach(() => { now = Date.now(); registry = new TuiActivityRegistry(() => now); registry.register('terminal-a', 'codex', 'D:/project'); number = 0 })
afterEach(async () => registry.close())
async function token() { await registry.start(); return registry.env('terminal-a').LYSHELL_TUI_ACTIVITY_TOKEN }
const event = (hookEvent: string, extra: Record<string, unknown> = {}) => ({ hookEvent, sessionId: 'cli-a', eventId: `event-${++number}`, at: now, ...extra })
describe('TUI lifecycle evidence', () => {
  it('preserves the active turn and approvals when SessionStart repeats during compaction', async () => {
    const credential = await token()
    registry.receive(credential, event('UserPromptSubmit', { turnId: 'turn-a' }))
    registry.receive(credential, event('SessionStart'))
    expect(registry.snapshot().sessions[0]).toMatchObject({ state: 'running', turnId: 'turn-a' })
    registry.receive(credential, event('PermissionRequest', { turnId: 'turn-a', callId: 'call-a' }))
    const approvalEventId = registry.snapshot().sessions[0].approvalEventId
    registry.receive(credential, event('SessionStart'))
    expect(registry.snapshot().sessions[0]).toMatchObject({ state: 'waiting-approval', turnId: 'turn-a', approvalEventId })
    registry.receive(credential, event('PostToolUse', { turnId: 'turn-a', callId: 'call-a' }))
    expect(registry.snapshot().sessions[0].state).toBe('running')
    registry.receive(credential, event('SessionStart', { sessionId: 'cli-new' }))
    expect(registry.snapshot().sessions[0]).toMatchObject({ state: 'idle', turnId: null, cliSessionId: 'cli-new' })
  })
  it('clears a Claude approval when its tool fails without treating the turn as failed', async () => {
    registry.register('terminal-b', 'claude', 'D:/other')
    await registry.start()
    const credential = registry.env('terminal-b').LYSHELL_TUI_ACTIVITY_TOKEN
    registry.receive(credential, event('UserPromptSubmit'))
    registry.receive(credential, event('PermissionRequest'))
    expect(registry.receive(credential, event('PostToolUseFailure', { callId: 'call-a' }))).toBe(true)
    expect(registry.snapshot().sessions[1]).toMatchObject({ state: 'running', approvalEventId: undefined })
    expect(registry.snapshot().events.map(item => item.kind)).toEqual(['approval'])
  })
  it('separates running, approval, turn-end and process disconnection', async () => {
    const credential = await token()
    registry.receive(credential, event('SessionStart'))
    expect(registry.snapshot().sessions[0].state).toBe('idle')
    registry.receive(credential, event('UserPromptSubmit', { turnId: 'turn-a' }))
    registry.receive(credential, event('PermissionRequest', { turnId: 'turn-a' }))
    expect(registry.snapshot().sessions[0].state).toBe('waiting-approval')
    registry.receive(credential, event('PostToolUse', { turnId: 'turn-a' }))
    expect(registry.snapshot().sessions[0].state).toBe('running')
    registry.deactivate('terminal-a')
    expect(registry.snapshot().sessions[0]).toMatchObject({ state: 'unknown', active: false })
    expect(registry.receive(credential, event('Stop', { turnId: 'turn-a' }))).toBe(false)
    expect(registry.snapshot().events.map(item => item.kind)).toEqual(['approval'])
  })
  it('does not repeat stops or let an old turn overwrite a newer turn', async () => {
    const credential = await token()
    registry.receive(credential, event('UserPromptSubmit', { turnId: 'turn-a' }))
    registry.receive(credential, event('Stop', { turnId: 'turn-a' }))
    registry.receive(credential, event('Stop', { turnId: 'turn-a' }))
    expect(registry.snapshot().events).toHaveLength(1)
    registry.receive(credential, event('UserPromptSubmit', { turnId: 'turn-b' }))
    expect(registry.receive(credential, event('Stop', { turnId: 'turn-a' }))).toBe(false)
    expect(registry.snapshot().sessions[0]).toMatchObject({ state: 'running', turnId: 'turn-b' })
    registry.receive(credential, event('Interrupt', { turnId: 'turn-b' }))
    expect(registry.snapshot().events[0].kind).toBe('interrupted')
  })
  it('retains distinct Claude turns without a CLI turn ID and ignores idle notifications', async () => {
    registry.register('terminal-b', 'claude', 'D:/other')
    await registry.start()
    const credential = registry.env('terminal-b').LYSHELL_TUI_ACTIVITY_TOKEN
    registry.receive(credential, event('UserPromptSubmit'))
    const first = registry.snapshot().sessions[1].turnId
    registry.receive(credential, event('Stop'))
    registry.receive(credential, event('Notification', { notificationType: 'idle_prompt' }))
    expect(registry.snapshot().sessions[1].state).toBe('turn-ended')
    registry.receive(credential, event('UserPromptSubmit'))
    expect(registry.snapshot().sessions[1].turnId).not.toBe(first)
    registry.receive(credential, event('StopFailure'))
    expect(registry.snapshot().events.map(item => item.kind)).toEqual(['failed', 'turn-ended'])
    expect(registry.snapshot().sessions[0].state).toBe('unknown')
  })
  it('rotates credentials and launch identity on reconnection', async () => {
    const credential = await token()
    const original = registry.snapshot().sessions[0].launchId
    registry.deactivate('terminal-a')
    const replacement = registry.connectEnv('terminal-a').LYSHELL_TUI_ACTIVITY_TOKEN
    expect(replacement).not.toBe(credential)
    expect(registry.snapshot().sessions[0].launchId).not.toBe(original)
    expect(registry.receive(credential, event('Stop'))).toBe(false)
    expect(registry.receive(replacement, event('SessionStart'))).toBe(true)
  })
  it('does not dismiss another parallel tool approval', async () => {
    const credential = await token()
    registry.receive(credential, event('UserPromptSubmit', { turnId: 'turn-a' }))
    registry.receive(credential, event('PermissionRequest', { turnId: 'turn-a', callId: 'call-a' }))
    registry.receive(credential, event('PreToolUse', { turnId: 'turn-a', callId: 'call-b' }))
    registry.receive(credential, event('PostToolUse', { turnId: 'turn-a', callId: 'call-b' }))
    expect(registry.snapshot().sessions[0].state).toBe('waiting-approval')
    registry.receive(credential, event('PostToolUse', { turnId: 'turn-a', callId: 'call-a' }))
    expect(registry.snapshot().sessions[0].state).toBe('running')
  })
  it('does not retire the active turn when the CLI submits another prompt with the same turn id', async () => {
    const credential = await token()
    registry.receive(credential, event('SessionStart', { turnId: 'turn-a' }))
    registry.receive(credential, event('UserPromptSubmit', { turnId: 'turn-a' }))
    registry.receive(credential, event('UserPromptSubmit', { turnId: 'turn-a' }))
    expect(registry.receive(credential, event('Stop', { turnId: 'turn-a' }))).toBe(true)
    expect(registry.snapshot().sessions[0].state).toBe('turn-ended')
  })
  it('rejects duplicate, malformed, expired, foreign session and obsolete launch evidence', async () => {
    const credential = await token()
    const start = event('SessionStart')
    expect(registry.receive(credential, start)).toBe(true)
    expect(registry.receive(credential, start)).toBe(false)
    expect(registry.receive(credential, event('Stop', { sessionId: 'foreign' }))).toBe(false)
    expect(registry.receive(credential, event('Stop', { at: now - 40000 }))).toBe(false)
    registry.receive(credential, event('SessionStart', { sessionId: 'cli-new' }))
    expect(registry.receive(credential, event('SessionStart'))).toBe(false)
    registry.register('terminal-a', 'codex', 'D:/project')
    expect(registry.receive(credential, event('Stop'))).toBe(false)
    for (const payload of [null, [], event('approve'), event('Stop', { command: 'never execute' }), event('Stop', { sessionId: '' }), event('Stop', { turnId: 3 })]) expect(parseTuiEvent(payload, now)).toBeNull()
    expect(JSON.stringify(registry.snapshot())).not.toContain(credential)
  })
  it('bounds history, leaves returned snapshots isolated and never offers approval controls', async () => {
    const credential = await token()
    for (let i = 0; i < 120; i++) {
      registry.receive(credential, event('UserPromptSubmit', { turnId: `turn-${i}` }))
      registry.receive(credential, event('Stop', { turnId: `turn-${i}` }))
    }
    expect(registry.snapshot().events).toHaveLength(100)
    const snapshot = registry.snapshot()
    snapshot.sessions[0].state = 'failed'
    expect(registry.snapshot().sessions[0].state).toBe('turn-ended')
    expect(JSON.stringify(snapshot)).not.toContain('options')
  })
  it('authenticates the HTTP ingress and rejects browser requests', async () => {
    const credential = await token()
    const endpoint = registry.env('terminal-a').LYSHELL_TUI_ACTIVITY_ENDPOINT
    const post = (headers: Record<string, string>, payload = event('SessionStart')) => new Promise<number>(resolve => {
      const req = request(endpoint, { method: 'POST', headers }, res => { res.resume(); resolve(res.statusCode!) })
      req.end(JSON.stringify(payload))
    })
    expect(await post({ 'x-lyshell-tui-token': credential, origin: 'https://example.com' })).toBe(403)
    expect(await post({ 'x-lyshell-tui-token': '0'.repeat(64) })).toBe(400)
    expect(await post({ 'x-lyshell-tui-token': credential })).toBe(204)
    expect(registry.snapshot().sessions[0].state).toBe('idle')
  })
})
