import { describe, it, expect } from 'vitest'
import { homedir } from 'os'
import { join } from 'path'
import { normalizeDshHomeEnv, resolveDshHome } from './env'

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

describe('resolveDshHome', () => {
  it('展开 ~/.dsh 为绝对 home 子目录', () => {
    expect(resolveDshHome('~/.dsh')).toBe(join(homedir(), '.dsh'))
  })

  it('相对路径回落 ~/.dsh', () => {
    expect(resolveDshHome('relative/path')).toBe(join(homedir(), '.dsh'))
  })

  it('绝对路径原样通过', () => {
    expect(resolveDshHome('/abs/.dsh')).toBe('/abs/.dsh')
  })

  it('空白/未设回落 ~/.dsh', () => {
    expect(resolveDshHome(undefined)).toBe(join(homedir(), '.dsh'))
    expect(resolveDshHome('   ')).toBe(join(homedir(), '.dsh'))
  })
})
