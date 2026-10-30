import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: {} }))
vi.mock('../storage/repository', () => ({ preferencesRepository: {} }))
import { buildMcpClientConfig } from './client-config'

describe('MCP client configuration contract', () => {
  it('preserves Windows paths and Electron environment in JSON/TOML without credentials', () => {
    const execPath = 'C:\\Program Files\\LyShell\\LyShell.exe'
    const scriptPath = 'C:\\Program Files\\LyShell\\resources\\app.asar\\dist\\main\\mcpServer.js'
    const userDataDir = 'C:\\Users\\fixture\\AppData\\Roaming\\LyShell'
    const result = buildMcpClientConfig({ execPath, scriptPath, userDataDir, externalAccess: false })
    expect(JSON.parse(result.config)).toEqual({ mcpServers: { lyshell: {
      command: execPath, args: [scriptPath], env: { LYSHELL_USER_DATA: userDataDir, ELECTRON_RUN_AS_NODE: '1' }
    } } })
    expect(result.codexConfig).toContain('command = "C:\\\\Program Files\\\\LyShell\\\\LyShell.exe"')
    expect(result.codexConfig).toContain('ELECTRON_RUN_AS_NODE = "1"')
    expect(result.claudeCommand).toContain('-- "' + execPath + '" "' + scriptPath + '"')
    expect(result.systemNodeConfig).toBeUndefined()
    expect(result.externalAccess).toBe(false)
    expect(result.config).not.toContain('token')
  })
  it('keeps a standalone Node fallback separate from the Electron environment', () => {
    const result = buildMcpClientConfig({ execPath: '/app/lyshell', scriptPath: '/app/mcpServer.js', userDataDir: '/data/lyshell', systemNodePath: '/usr/bin/node', externalAccess: true })
    expect(JSON.parse(result.systemNodeConfig!)).toEqual({ mcpServers: { lyshell: {
      command: '/usr/bin/node', args: ['/app/mcpServer.js'], env: { LYSHELL_USER_DATA: '/data/lyshell' }
    } } })
    expect(result.externalAccess).toBe(true)
  })
})
