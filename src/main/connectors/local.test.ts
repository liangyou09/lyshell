import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// node-pty 是按 Electron ABI 编译的原生模块，vitest 的 Node 环境加载会炸，mock 掉
// （本文件只测 findPwshPath 纯函数，不触 PTY）；electron-log 对齐既有测试的 mock 手法。
vi.mock('node-pty', () => ({
  spawn: vi.fn()
}))
vi.mock('electron-log', () => ({
  default: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }
}))

import { findPwshPath } from './local'

// findPwshPath 的常规安装位置兜底读 process.env.ProgramFiles / LOCALAPPDATA，
// 测试里补丁到临时目录并还原，避免结果依赖开发机是否真的装了 pwsh。
const origProgramFiles = process.env.ProgramFiles
const origLocalAppData = process.env.LOCALAPPDATA

/** 造一个「没装 pwsh」的环境：两个兜底根都指向空临时目录 */
let emptyRoot: string

beforeEach(() => {
  emptyRoot = mkdtempSync(join(tmpdir(), 'lyshell-local-empty-'))
  process.env.ProgramFiles = emptyRoot
  process.env.LOCALAPPDATA = emptyRoot
})

afterEach(() => {
  rmSync(emptyRoot, { recursive: true, force: true })
  if (origProgramFiles === undefined) delete process.env.ProgramFiles
  else process.env.ProgramFiles = origProgramFiles
  if (origLocalAppData === undefined) delete process.env.LOCALAPPDATA
  else process.env.LOCALAPPDATA = origLocalAppData
})

describe('findPwshPath (win32 分支)', () => {
  it.skipIf(process.platform !== 'win32')('PATH 上命中时返回完整路径', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lyshell-local-pathdir-'))
    try {
      writeFileSync(join(dir, 'pwsh.exe'), '')
      expect(findPwshPath(dir)).toBe(join(dir, 'pwsh.exe'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== 'win32')('PATH 未命中时回落 Program Files 安装位置', () => {
    const pfRoot = mkdtempSync(join(tmpdir(), 'lyshell-local-pf-'))
    try {
      mkdirSync(join(pfRoot, 'PowerShell', '7'), { recursive: true })
      writeFileSync(join(pfRoot, 'PowerShell', '7', 'pwsh.exe'), '')
      process.env.ProgramFiles = pfRoot
      expect(findPwshPath(emptyRoot)).toBe(join(pfRoot, 'PowerShell', '7', 'pwsh.exe'))
    } finally {
      rmSync(pfRoot, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== 'win32')('Program Files 未装时回落 WindowsApps 执行别名', () => {
    const appDataRoot = mkdtempSync(join(tmpdir(), 'lyshell-local-appdata-'))
    try {
      mkdirSync(join(appDataRoot, 'Microsoft', 'WindowsApps'), { recursive: true })
      writeFileSync(join(appDataRoot, 'Microsoft', 'WindowsApps', 'pwsh.exe'), '')
      process.env.LOCALAPPDATA = appDataRoot
      expect(findPwshPath(emptyRoot)).toBe(join(appDataRoot, 'Microsoft', 'WindowsApps', 'pwsh.exe'))
    } finally {
      rmSync(appDataRoot, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== 'win32')('PATH 与常规位置都未命中时返回 null', () => {
    expect(findPwshPath(emptyRoot)).toBeNull()
  })
})

describe('findPwshPath (POSIX 分支)', () => {
  it.skipIf(process.platform === 'win32')('非 Windows 恒为 null（保持 $SHELL 现状）', () => {
    expect(findPwshPath('/usr/local/bin:/usr/bin')).toBeNull()
  })
})
