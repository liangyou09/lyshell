import { describe, it, expect } from 'vitest'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { expandTilde, resolveWorkspaceCwd } from './cwd'

describe('expandTilde', () => {
  it('展开 ~ 为 home 目录', () => {
    expect(expandTilde('~')).toBe(homedir())
  })

  it('展开 ~/ 前缀', () => {
    expect(expandTilde('~/projects')).toBe(join(homedir(), 'projects'))
  })

  it('展开 ~\\ 前缀（Windows）', () => {
    expect(expandTilde('~\\projects')).toBe(join(homedir(), 'projects'))
  })

  it('非 ~ 前缀原样返回', () => {
    expect(expandTilde('/abs/path')).toBe('/abs/path')
    expect(expandTilde('relative/path')).toBe('relative/path')
  })
})

describe('resolveWorkspaceCwd', () => {
  it('拒绝空目录', () => {
    expect(resolveWorkspaceCwd('  ').ok).toBe(false)
  })

  it('拒绝相对路径', () => {
    expect(resolveWorkspaceCwd('relative/path').ok).toBe(false)
  })

  it('拒绝不存在的目录', () => {
    const r = resolveWorkspaceCwd(join(tmpdir(), 'lyshell-cwd-definitely-missing'))
    expect(r.ok).toBe(false)
  })

  it('拒绝指向文件的路径', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lyshell-cwd-'))
    const file = join(dir, 'file.txt')
    writeFileSync(file, '')
    expect(resolveWorkspaceCwd(file).ok).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('接受存在的目录并返回绝对路径', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lyshell-cwd-'))
    const r = resolveWorkspaceCwd(dir)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.path).toBe(dir)
    rmSync(dir, { recursive: true, force: true })
  })

  it('展开 ~ 后再校验（home 恒存在）', () => {
    const r = resolveWorkspaceCwd('~')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.path).toBe(homedir())
  })
})
