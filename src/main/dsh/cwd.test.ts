import { describe, it, expect } from 'vitest'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { expandTilde, resolveWorkspaceCwd, normalizeDshHomeEnv } from './cwd'

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

describe('normalizeDshHomeEnv', () => {
  it('无 env 或未设 DSH_HOME 时原样通过', () => {
    expect(normalizeDshHomeEnv(undefined)).toEqual({ ok: true, env: undefined })
    const r = normalizeDshHomeEnv({ K1: 'v1' })
    expect(r).toEqual({ ok: true, env: { K1: 'v1' } })
  })

  it('空 DSH_HOME 视为未设置并删除该键', () => {
    const r = normalizeDshHomeEnv({ DSH_HOME: '' })
    expect(r).toEqual({ ok: true, env: undefined })
  })

  it('纯空白 DSH_HOME 视为未设置，其余键保留', () => {
    const r = normalizeDshHomeEnv({ DSH_HOME: '   ', K1: 'v1' })
    expect(r).toEqual({ ok: true, env: { K1: 'v1' } })
  })

  it('相对 DSH_HOME 返回错误', () => {
    const r = normalizeDshHomeEnv({ DSH_HOME: 'relative/path' })
    expect(r.ok).toBe(false)
  })

  it('展开 ~ 前缀后保留', () => {
    const r = normalizeDshHomeEnv({ DSH_HOME: '~/.dsh' })
    expect(r).toEqual({ ok: true, env: { DSH_HOME: join(homedir(), '.dsh') } })
  })

  it('绝对 DSH_HOME 原样通过', () => {
    const r = normalizeDshHomeEnv({ DSH_HOME: '/abs/.dsh' })
    expect(r).toEqual({ ok: true, env: { DSH_HOME: '/abs/.dsh' } })
  })
})
