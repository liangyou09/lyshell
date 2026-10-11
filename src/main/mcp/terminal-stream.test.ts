import { describe, it, expect, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import type { ServerResponse } from 'http'
import { streamTerminal, closeTerminalStreams } from './terminal-stream'

afterEach(() => { closeTerminalStreams(); vi.useRealTimers() })
function setup() {
  const source = Object.assign(new EventEmitter(), { readOutput: () => ({ output: 'initial screen' }) })
  const response = Object.assign(new EventEmitter(), { writeHead: vi.fn(), write: vi.fn((_text: string) => true), end: vi.fn((_body?: string) => {}) })
  return { source, response, res: response as unknown as ServerResponse }
}
describe('terminal SSE subscription', () => {
  it('does not subscribe after the client disconnected during authorization', () => {
    vi.useFakeTimers()
    const { source, response, res } = setup()
    Object.assign(response, { destroyed: true })
    streamTerminal(source, 'target', res, () => true)
    expect(response.writeHead).not.toHaveBeenCalled()
    expect(source.listenerCount('terminal:data')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('cleans up when the response errors or the snapshot fails', () => {
    vi.useFakeTimers()
    const first = setup()
    streamTerminal(first.source, 'target', first.res, () => true)
    first.response.emit('error', new Error('connection reset'))
    expect(first.source.listenerCount('terminal:data')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    const second = setup()
    second.source.readOutput = () => { throw new Error('unavailable') }
    streamTerminal(second.source, 'target', second.res, () => true)
    expect(second.source.listenerCount('terminal:data')).toBe(0)
    expect(second.response.end.mock.calls[0][0]).toContain('snapshot_failed')
    expect(vi.getTimerCount()).toBe(0)
  })
  it('sends an initial snapshot and only target terminal output/status; removes listeners on close', () => {
    const { source, response, res } = setup()
    streamTerminal(source, 'target', res, () => true)
    expect(response.write.mock.calls[0][0]).toContain('initial screen')
    source.emit('terminal:data', { sessionId: 'other', data: 'private other terminal' })
    source.emit('terminal:data', { sessionId: 'target', data: 'actual output' })
    source.emit('session:status', { id: 'target', status: 'connected' })
    expect(response.write.mock.calls).toHaveLength(3)
    expect(response.write.mock.calls[1][0]).toContain('actual output')
    expect(response.write.mock.calls[2][0]).toContain('connected')
    response.emit('close')
    expect(source.listenerCount('terminal:data')).toBe(0)
    expect(source.listenerCount('session:status')).toBe(0)
  })
  it('revocation closes the stream before publishing more output', () => {
    const { source, response, res } = setup()
    let allowed = true
    streamTerminal(source, 'target', res, () => allowed)
    allowed = false
    source.emit('terminal:data', { sessionId: 'target', data: 'must not leak' })
    expect(response.write.mock.calls).toHaveLength(1)
    expect(response.end).toHaveBeenCalledOnce()
    expect(response.end.mock.calls[0][0]).toContain('access_revoked')
    expect(source.listenerCount('terminal:data')).toBe(0)
  })
  it('cleans up a disconnected/slow consumer and heartbeat timers', () => {
    vi.useFakeTimers()
    const { source, response, res } = setup()
    streamTerminal(source, 'target', res, () => true)
    response.write.mockReturnValue(false)
    vi.advanceTimersByTime(5000)
    expect(response.end).toHaveBeenCalledOnce()
    expect(response.end.mock.calls[0][0]).toContain('consumer_backpressure')
    expect(source.listenerCount('session:deleted')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
