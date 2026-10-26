import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanupTuiLaunchFiles, prepareTuiLaunch, type TuiLaunchOptions } from './tui-launch'
let dataDir: string
beforeEach(async () => { dataDir = await mkdtemp(join(tmpdir(), 'lyshell-tui-')) })
afterEach(async () => { await cleanupTuiLaunchFiles(); await rm(dataDir, { recursive: true, force: true }) })
const options = (): TuiLaunchOptions => ({ source: 'claude', terminalId: 'terminal-a', command: 'claude --model sonnet --permission-mode plan', dataDir,
  helperPath: 'C:/Program Files/LyShell/resources/tui-activity/notify.cjs', executable: 'C:/Program Files/LyShell/LyShell.exe', platform: 'win32', shell: 'C:/Program Files/PowerShell/7/pwsh.exe' })
describe('session scoped TUI integration', () => {
  it('adds Claude hooks without changing user settings or approval modes', async () => {
    const prepared = await prepareTuiLaunch(options())
    expect(await readFile(prepared.launchPath!, 'utf8')).toContain("claude --model sonnet --permission-mode plan '--settings'")
    expect(prepared.command.length).toBeLessThan(1500)
    const config = JSON.parse(await readFile(prepared.settingsPath!, 'utf8'))
    expect(Object.keys(config)).toEqual(['hooks'])
    expect(Object.keys(config.hooks)).toContain('StopFailure')
    expect(Object.keys(config.hooks)).toContain('PostToolUseFailure')
    for (const group of Object.values(config.hooks) as Array<Array<{ hooks: Array<{ command: string; onFailure: string }> }>>) {
      expect(group[0].hooks[0].onFailure).toBe('continue')
      const encoded = group[0].hooks[0].command.split(' ').at(-1)!
      expect(Buffer.from(encoded, 'base64').toString('utf16le')).toContain("& 'C:/Program Files/LyShell/LyShell.exe'")
    }
    expect(JSON.stringify(config)).not.toMatch(/token|permissionDecision|dangerously|continue.*false/)
  })
  it('adds Codex inline hooks, retains original command and preserves its trust flow', async () => {
    const prepared = await prepareTuiLaunch({ ...options(), source: 'codex', command: 'codex resume -c default_permissions=:read-only' })
    expect(prepared.settingsPath).toBeUndefined()
    const command = await readFile(prepared.launchPath!, 'utf8')
    expect(command).toContain('codex resume -c default_permissions=:read-only')
    expect(command).toContain('--no-daemon')
    expect(command).toContain('hooks.Interrupt=')
    expect(command).not.toContain('bypass')
    expect(command).not.toContain('features.hooks')
  })
  it('uses encoded PowerShell for cmd hosts and safely quotes POSIX paths', async () => {
    const cmd = await prepareTuiLaunch({ ...options(), source: 'codex', shell: undefined })
    expect(cmd.command).toMatch(/^powershell.exe -NoLogo -NoProfile -EncodedCommand /)
    expect(await readFile(cmd.launchPath!, 'utf8')).toContain('hooks.Stop=')
    const posix = await prepareTuiLaunch({ ...options(), platform: 'linux', executable: "/opt/Ly'Shell/lyshell", helperPath: '/opt/path $safe/notify.cjs' })
    const config = JSON.parse(await readFile(posix.settingsPath!, 'utf8'))
    expect(config.hooks.Stop[0].hooks[0].command).toContain("'/opt/Ly'\\''Shell/lyshell'")
    expect(config.hooks.Stop[0].hooks[0].command).toContain("'/opt/path $safe/notify.cjs'")
  })
})
