import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { commandExists, windowsExecutableExtensions, detectDependencies } from './detect'

const origPath = process.env.PATH
const origPathext = process.env.PATHEXT

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lyshell-harness-detect-'))
  process.env.PATHEXT = '.EXE;.CMD;.BAT'
  process.env.PATH = dir
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  if (origPath === undefined) delete process.env.PATH
  else process.env.PATH = origPath
  if (origPathext === undefined) delete process.env.PATHEXT
  else process.env.PATHEXT = origPathext
})

describe('windowsExecutableExtensions', () => {
  it('PATHEXT 未设置时返回默认扩展', () => {
    delete process.env.PATHEXT
    expect(windowsExecutableExtensions()).toEqual(['.com', '.exe', '.bat', '.cmd'])
  })

  it('解析 PATHEXT：小写化 + 补点 + 去空', () => {
    process.env.PATHEXT = 'COM;.BAT;.CMD;;EXE'
    expect(windowsExecutableExtensions()).toEqual(['.com', '.bat', '.cmd', '.exe'])
  })
})

describe('commandExists (win32 分支)', () => {
  it.skipIf(process.platform !== 'win32')('按 PATHEXT 匹配 .cmd 扩展', () => {
    writeFileSync(join(dir, 'codex.cmd'), '')
    expect(commandExists('codex')).toBe(true)
  })

  it.skipIf(process.platform !== 'win32')('无扩展名普通文件不误判（无 extensionless 兜底）', () => {
    writeFileSync(join(dir, 'codex'), '')
    expect(commandExists('codex')).toBe(false)
  })

  it.skipIf(process.platform !== 'win32')('非可执行扩展名 .txt 不匹配', () => {
    writeFileSync(join(dir, 'codex.txt'), '')
    expect(commandExists('codex')).toBe(false)
  })
})

describe('detectDependencies', () => {
  it.skipIf(process.platform !== 'win32')('PATH 上有 shim 时都检测到', () => {
    writeFileSync(join(dir, 'codex.cmd'), '')
    writeFileSync(join(dir, 'claude.cmd'), '')
    expect(detectDependencies(['codex', 'claude'])).toEqual({ codex: true, claude: true })
  })

  it.skipIf(process.platform !== 'win32')('缺失的依赖返回 false', () => {
    writeFileSync(join(dir, 'codex.cmd'), '')
    expect(detectDependencies(['codex', 'claude'])).toEqual({ codex: true, claude: false })
  })
})
