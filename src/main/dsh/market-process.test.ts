import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ResolvedDshWebLaunch } from './launch-resolve'

vi.mock('electron', () => ({ session: {} }))
vi.mock('../harness/config', () => ({ HARNESS_AGENTS: { dsh: {} } }))
vi.mock('./launch-resolve', () => ({ createDshWebLaunchResolver: () => ({}), buildChildEnv: vi.fn() }))
vi.mock('./web', () => ({ dshWebManager: {}, comSpecFromEnv: () => process.env.ComSpec }))
import { runMarketTool } from './market'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe.skipIf(process.platform !== 'win32')('真实 Windows 市场命令启动', () => {
  it('Job 门控正常放行 cmd shim，保留带空格的工具路径和参数', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lyshell market process '))
    directories.push(directory)
    writeFileSync(join(directory, 'pnpm.cmd'), '@echo off\r\necho %~1> argument.txt\r\nexit /b 0\r\n')
    await runMarketTool('pnpm', ['argument with spaces'], { cwd: directory } as ResolvedDshWebLaunch, { ...process.env, PATH: directory })
    expect(readFileSync(join(directory, 'argument.txt'), 'utf8').trim()).toBe('argument with spaces')
  })
})
