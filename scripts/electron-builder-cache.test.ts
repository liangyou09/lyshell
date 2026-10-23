import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const source = readFileSync(new URL('./electron-builder-cache.cjs', import.meta.url), 'utf8')

function resolveDist({ platform = 'win32', arch = 'x64', installedVersion = '43.7.11',
  distVersion = '43.7.11', executableExists = true, missing = false,
  runtimePlatform = 'win32', runtimeArch = 'x64', runtimeVersion = '43.7.11', brokenRuntime = false } = {}) {
  const packagePath = path.resolve('/project/node_modules/electron/package.json')
  const read = vi.fn((file: string) => {
    if (missing) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    return file === packagePath ? JSON.stringify({ version: installedVersion }) : distVersion
  })
  const requireModule = Object.assign((id: string) => {
    if (id === 'node:fs') return { readFileSync: read, existsSync: () => executableExists }
    if (id === 'node:path') return path
    if (id === 'node:child_process') return { execFileSync: () => {
      if (brokenRuntime) throw new Error('runtime cannot start')
      return JSON.stringify({ platform: runtimePlatform, arch: runtimeArch, version: runtimeVersion })
    } }
    throw new Error(`Unexpected module: ${id}`)
  }, { resolve: () => packagePath })
  const module = { exports: {} as { electronDist: (options: unknown) => string | undefined } }
  vm.runInNewContext(source, { require: requireModule, module, process: { platform: 'win32', arch: 'x64' } })
  const result = module.exports.electronDist({ platformName: platform, arch, version: '43.7.11',
    packager: { projectDir: path.resolve('/project') } })
  return { result, read, expected: path.join(path.dirname(packagePath), 'dist') }
}

describe('打包优先复用本地 Electron', () => {
  it('目标、依赖和解压版本都匹配时复用本地运行时', () => {
    const { result, expected } = resolveDist()
    expect(result).toBe(expected)
  })

  it.each([{ platform: 'linux' }, { arch: 'arm64' }])('交叉打包不复用本机运行时：%j', options => {
    const { result, read } = resolveDist(options)
    expect(result).toBeUndefined()
    expect(read).not.toHaveBeenCalled()
  })

  it.each([{ runtimePlatform: 'linux' }, { runtimeArch: 'arm64' }, { runtimeVersion: '42.0.0' }, { brokenRuntime: true }])(
    '实际运行时不匹配或无法启动时回退到缓存：%j', options => {
      expect(resolveDist(options).result).toBeUndefined()
    }
  )

  it.each([{ installedVersion: '28.3.3' }, { distVersion: '28.3.3' },
    { executableExists: false }, { missing: true }])('不完整或版本不匹配时回退下载缓存：%j', options => {
    expect(resolveDist(options).result).toBeUndefined()
  })
})
