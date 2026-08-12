import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { createPluginApi, type PluginHttpClient } from './api'
import type { PluginSpec } from '@shared/plugin-types'

// spawnControlled 测试需要：mock spawn（不真起进程）+ mock existsSync
// （测试环境 __dirname 是 src/，mcpServer.js 不在此 -> existsSync 默认 true 模拟打包态）。
vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({ pid: 12345, kill: vi.fn(), on: vi.fn() }))
}))
vi.mock('fs', () => ({
  existsSync: vi.fn(() => true)
}))

function makeSpec(overrides: Partial<PluginSpec> = {}): PluginSpec {
  return {
    pluginId: 'test-plugin',
    token: 't',
    grantedCapabilities: ['read'],
    manifestPath: '/tmp/lyshell-plugin.json',
    pluginDir: '/tmp',
    main: 'index.js',
    runtime: 'node',
    lifecycle: 'persistent',
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

describe('spawnControlled', () => {
  const TOKEN64 = 'a'.repeat(64)

  beforeEach(() => {
    process.env.LYSHELL_MCP_PORT = '4242'
    process.env.ELECTRON_RUN_AS_NODE = '1'
    vi.mocked(spawn).mockClear()
    // mockReset 清掉上轮 mockReturnValue(false)(test 5 等)的残留,再恢复默认 true,
    // 否则 false 会泄漏到后续测试触发 loud warn 噪音。
    vi.mocked(existsSync).mockReset()
    vi.mocked(existsSync).mockReturnValue(true)
  })

  afterEach(() => {
    delete process.env.LYSHELL_MCP_PORT
    delete process.env.ELECTRON_RUN_AS_NODE
    delete process.env.LYSHELL_MCP_SERVER_SCRIPT
  })

  /** 取最近一次 spawn 调用的 env（第 3 参数 .env）。 */
  function lastSpawnEnv(): Record<string, string | undefined> | undefined {
    const calls = vi.mocked(spawn).mock.calls
    return calls[calls.length - 1]?.[2]?.env
  }

  it('注入连接包：PORT / TOKEN / SERVER_SCRIPT / ELECTRON_EXE', () => {
    const api = createPluginApi(makeSpec({ token: TOKEN64 }), makeClient())
    api.spawnControlled('pet.exe', ['--x'])
    expect(spawn).toHaveBeenCalledWith('pet.exe', ['--x'], expect.objectContaining({
      env: expect.objectContaining({
        LYSHELL_MCP_PORT: '4242',
        LYSHELL_MCP_TOKEN: TOKEN64,
        LYSHELL_MCP_SERVER_SCRIPT: expect.any(String),
        LYSHELL_ELECTRON_EXE: expect.any(String)
      })
    }))
  })

  it('插件 opts.env 合并，但 token/port 覆盖优先（插件无法篡改）', () => {
    const api = createPluginApi(makeSpec({ token: TOKEN64 }), makeClient())
    api.spawnControlled('pet.exe', [], {
      env: { FOO: 'bar', LYSHELL_MCP_TOKEN: 'evil', LYSHELL_MCP_PORT: '9999' }
    })
    expect(lastSpawnEnv()).toMatchObject({
      FOO: 'bar',
      LYSHELL_MCP_TOKEN: TOKEN64,   // 插件传的 'evil' 被覆盖
      LYSHELL_MCP_PORT: '4242'      // 插件传的 '9999' 被覆盖
    })
  })

  it('gui 默认 true：清掉继承的 ELECTRON_RUN_AS_NODE（让 Electron 子进程有 GUI）', () => {
    const api = createPluginApi(makeSpec({ token: TOKEN64 }), makeClient())
    api.spawnControlled('pet.exe')
    expect(lastSpawnEnv()?.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })

  it('gui:false 保留 ELECTRON_RUN_AS_NODE（headless 子进程）', () => {
    const api = createPluginApi(makeSpec({ token: TOKEN64 }), makeClient())
    api.spawnControlled('node-tool.exe', [], { gui: false })
    expect(lastSpawnEnv()?.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('mcpServer.js 不存在时不注入 SCRIPT/EXE（no-mcp 兜底）', () => {
    vi.mocked(existsSync).mockReturnValue(false)
    const api = createPluginApi(makeSpec({ token: TOKEN64 }), makeClient())
    api.spawnControlled('pet.exe')
    const env = lastSpawnEnv()
    expect(env?.LYSHELL_MCP_SERVER_SCRIPT).toBeUndefined()
    expect(env?.LYSHELL_ELECTRON_EXE).toBeUndefined()
    // port/token 仍注入
    expect(env?.LYSHELL_MCP_PORT).toBe('4242')
    expect(env?.LYSHELL_MCP_TOKEN).toBe(TOKEN64)
  })

  it('缺 LYSHELL_MCP_PORT 抛错且不 spawn', () => {
    delete process.env.LYSHELL_MCP_PORT
    const api = createPluginApi(makeSpec({ token: TOKEN64 }), makeClient())
    expect(() => api.spawnControlled('pet.exe')).toThrow(/LYSHELL_MCP_PORT/)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('返回句柄有 pid / kill / on', () => {
    const api = createPluginApi(makeSpec({ token: TOKEN64 }), makeClient())
    const child = api.spawnControlled('pet.exe')
    expect(child.pid).toBe(12345)
    expect(typeof child.kill).toBe('function')
    expect(typeof child.on).toBe('function')
  })

  it('默认挂 error 监听,防 ENOENT 异步 error 崩共享 host', () => {
    const api = createPluginApi(makeSpec({ token: TOKEN64 }), makeClient())
    const child = api.spawnControlled('pet.exe')
    // spawn 对坏 exe 异步发 'error'(非同步抛);无监听则 uncaughtException 崩整个 host
    expect(child.on).toHaveBeenCalledWith('error', expect.any(Function))
  })

  it('onSpawn 钩子:host 登记子进程做退出兜底 kill', () => {
    const onSpawn = vi.fn()
    const api = createPluginApi(makeSpec({ token: TOKEN64 }), makeClient(), { onSpawn })
    const child = api.spawnControlled('pet.exe')
    expect(onSpawn).toHaveBeenCalledTimes(1)
    expect(onSpawn).toHaveBeenCalledWith(child)
  })

  it('LYSHELL_MCP_SERVER_SCRIPT env 优先(main 权威下发,不靠 __dirname)', () => {
    vi.mocked(existsSync).mockReturnValue(true)
    process.env.LYSHELL_MCP_SERVER_SCRIPT = '/canonical/mcpServer.js'
    const api = createPluginApi(makeSpec({ token: TOKEN64 }), makeClient())
    api.spawnControlled('pet.exe')
    expect(lastSpawnEnv()?.LYSHELL_MCP_SERVER_SCRIPT).toBe('/canonical/mcpServer.js')
  })
})
