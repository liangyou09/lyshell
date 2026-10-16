import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const source = readFileSync(new URL('./postinstall.cjs', import.meta.url), 'utf8')

function install({ force = false, checkFails = false, buildFails = false, fromSource = false } = {}) {
  let checks = 0
  const execFileSync = vi.fn((command: string, _args: string[], _options: unknown) => {
    if (command === '/electron') {
      if (checkFails && checks++ === 0) throw new Error('incompatible prebuild')
    } else if (buildFails) throw new Error('build failed')
  })
  const requireModule = Object.assign((id: string) => {
    if (id === 'child_process') return { execFileSync }
    if (id === 'path') return path
    if (id === 'fs') return { readFileSync: () => JSON.stringify({ version: '43.7.11' }) }
    if (id === 'electron') return '/electron'
    throw new Error(`Unexpected module: ${id}`)
  }, { resolve: (id: string) => id === '@electron/rebuild' ? '/rebuild/lib/main.js' : '/electron/package.json' })
  const run = () => vm.runInNewContext(source, {
    require: requireModule, __dirname: path.resolve('scripts'), console: { log: vi.fn() },
    process: { argv: force ? ['node', 'postinstall.cjs', '--force'] : ['node', 'postinstall.cjs'],
      execPath: '/node', env: fromSource ? { npm_config_build_from_source: 'true' } : {} }
  })
  return { run, execFileSync }
}

describe('原生模块安装校验', () => {
  it('兼容预编译产物通过 Electron 校验后不重建', () => {
    const task = install()
    task.run()
    expect(task.execFileSync).toHaveBeenCalledOnce()
    expect(task.execFileSync.mock.calls[0][0]).toBe('/electron')
  })

  it.each([{ checkFails: true }, { force: true }, { fromSource: true }])('需要重建时禁止复用预编译模块：%j', options => {
    const task = install(options)
    task.run()
    const build = task.execFileSync.mock.calls.find(([command]) => command === '/node')!
    expect(build).toBeTruthy()
    expect(build[1]).toContain('--build-from-source')
    expect(task.execFileSync.mock.calls.at(-1)![0]).toBe('/electron')
  })

  it('源码编译失败中断安装，不报告成功', () => {
    const task = install({ force: true, buildFails: true })
    expect(task.run).toThrow('build failed')
    expect(task.execFileSync).toHaveBeenCalledOnce()
  })
})
