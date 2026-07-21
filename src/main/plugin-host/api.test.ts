import { describe, it, expect, vi } from 'vitest'
import { createPluginApi, type PluginHttpClient } from './api'
import type { PluginSpec } from '@shared/plugin-types'

function makeSpec(overrides: Partial<PluginSpec> = {}): PluginSpec {
  return {
    pluginId: 'test-plugin',
    token: 't',
    grantedCapabilities: ['read'],
    manifestPath: '/tmp/lyshell-plugin.json',
    pluginDir: '/tmp',
    main: 'index.js',
    runtime: 'node',
    ...overrides
  }
}

function makeClient(): PluginHttpClient {
  return {
    get: vi.fn().mockResolvedValue({ data: { via: 'get' } }),
    post: vi.fn().mockResolvedValue({ data: { via: 'post' } })
  } as unknown as PluginHttpClient
}

describe('createPluginApi', () => {
  it('gate passes for granted capability and calls HTTP', async () => {
    const client = makeClient()
    const api = createPluginApi(makeSpec(), client)
    const data = await api.call('lyshell_list_sessions')
    expect(data).toEqual({ via: 'post' })
    expect(client.post).toHaveBeenCalledWith('/api/sessions', undefined)
  })

  it('gate rejects when plugin lacks the route capability', async () => {
    const client = makeClient()
    const api = createPluginApi(makeSpec({ grantedCapabilities: ['read'] }), client)
    await expect(
      api.call('lyshell_execute_command', { sessionId: 's1', command: 'ls' })
    ).rejects.toThrow(/lacks capability/)
    expect(client.post).not.toHaveBeenCalled()
  })

  it('gate accepts either candidate capability (execute | localExecute)', async () => {
    const client = makeClient()
    const api = createPluginApi(makeSpec({ grantedCapabilities: ['execute'] }), client)
    await api.call('lyshell_execute_command', { sessionId: 's1', command: 'ls' })
    expect(client.post).toHaveBeenCalledWith('/api/execute', { sessionId: 's1', command: 'ls' })
  })

  it(':id path moves sessionId into path (GET)', async () => {
    const client = makeClient()
    const api = createPluginApi(makeSpec(), client)
    await api.call('lyshell_read_session_notes', { sessionId: 's1' })
    expect(client.get).toHaveBeenCalledWith('/api/sessions/s1/notes')
  })

  it('GET builds query string from extra params (future GET routes)', async () => {
    const client = makeClient()
    const api = createPluginApi(makeSpec(), client)
    // sessionId 入路径;其余原始值拼 query,undefined/对象跳过
    await api.call('lyshell_read_session_notes', {
      sessionId: 's1',
      foo: 'bar',
      n: 5,
      flag: true,
      skip: undefined,
      obj: { a: 1 }
    })
    expect(client.get).toHaveBeenCalledWith('/api/sessions/s1/notes?foo=bar&n=5&flag=true')
  })

  it(':id path moves sessionId out of body (POST)', async () => {
    const client = makeClient()
    const api = createPluginApi(makeSpec({ grantedCapabilities: ['sessionMetadataWrite'] }), client)
    await api.call('lyshell_write_session_notes', { sessionId: 's1', summary: 'x' })
    expect(client.post).toHaveBeenCalledWith('/api/sessions/s1/notes', { summary: 'x' })
  })

  it('throws on unknown tool', async () => {
    const client = makeClient()
    const api = createPluginApi(makeSpec(), client)
    await expect(api.call('lyshell_nonexistent')).rejects.toThrow(/unknown tool/)
  })

  it('exposes pluginId and grantedCapabilities', () => {
    const api = createPluginApi(
      makeSpec({ pluginId: 'p1', grantedCapabilities: ['read', 'execute'] }),
      makeClient()
    )
    expect(api.pluginId).toBe('p1')
    expect(api.grantedCapabilities).toEqual(['read', 'execute'])
  })
})
