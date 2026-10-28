import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ResolvedDshWebLaunch } from './launch-resolve'

vi.mock('electron', () => ({ session: {} }))
vi.mock('../harness/config', () => ({ HARNESS_AGENTS: { dsh: {} } }))
vi.mock('./launch-resolve', () => ({ createDshWebLaunchResolver: () => ({}), buildChildEnv: vi.fn() }))
vi.mock('./web', () => ({
  dshWebManager: {},
  // 此处只隔离 Web 管理器；shell 解析需保持生产接口从最终 childEnv 大小写无关取值的语义。
  comSpecFromEnv: (env: Record<string, string | undefined>) =>
    Object.entries(env).find(([key, value]) => key.toLowerCase() === 'comspec' && value?.trim())?.[1]?.trim()
}))
import { runMarketTool } from './market'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe.skipIf(process.platform !== 'win32')('真实 Windows 市场命令启动', () => {
  it.each(['ComSpec', 'COMSPEC'])('Job 门控正常放行 cmd shim，保留带空格的路径、参数及 %s 环境键', async shellKey => {
    const directory = mkdtempSync(join(tmpdir(), 'lyshell market process '))
    directories.push(directory)
    writeFileSync(join(directory, 'pnpm.cmd'), '@echo off\r\necho %~1> argument.txt\r\nexit /b 0\r\n')
    const shell = Object.entries(process.env).find(([key]) => key.toLowerCase() === 'comspec')?.[1]
    if (!shell) throw new Error('Windows test requires a cmd.exe path in ComSpec/COMSPEC')
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'comspec'))
    env[shellKey] = shell
    // Vitest worker 的环境对象区分大小写，显式覆盖两种 Windows 常见拼写。
    vi.stubEnv('ComSpec', shellKey === 'ComSpec' ? shell : '')
    try {
      await runMarketTool('pnpm', ['argument with spaces'], { cwd: directory } as ResolvedDshWebLaunch, { ...env, PATH: directory })
    } finally { vi.unstubAllEnvs() }
    expect(readFileSync(join(directory, 'argument.txt'), 'utf8').trim()).toBe('argument with spaces')
  })
})
