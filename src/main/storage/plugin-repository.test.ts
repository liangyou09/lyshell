import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'path'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'fs'
import { randomUUID } from 'crypto'

const env = vi.hoisted(() => ({
  base: '',
  failWrite: false
}))

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    writeFileSync: ((...args: Parameters<typeof actual.writeFileSync>) => {
      if (env.failWrite) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
      return actual.writeFileSync(...args)
    }) as typeof actual.writeFileSync
  }
})

vi.mock('electron-log', () => ({ default: { info: () => {}, error: () => {}, warn: () => {} } }))
vi.mock('electron', () => ({ app: { getPath: () => env.base } }))

import { PluginRepository, getPluginsDir, RevisionOptions } from './plugin-repository'
import { RevisionConflictError } from './atomic-json'
import type { PluginRegistryEntry } from '@shared/plugin-types'

const entry = (id: string, enabled = true): PluginRegistryEntry =>
  ({
    id,
    version: '1.0.0',
    path: id,
    dev: false,
    enabled,
    grantedCapabilities: [],
    installedAt: new Date(0).toISOString(),
    source: 'builtin'
  }) as PluginRegistryEntry

let registryPath = ''

const newRepo = () => new PluginRepository()

beforeEach(() => {
  env.base = join(process.env.TMPDIR ?? process.env.TEMP ?? '.', `lyshell-plugin-${randomUUID()}`)
  mkdirSync(env.base, { recursive: true })
  env.failWrite = false
  registryPath = join(getPluginsDir(), 'registry.json')
})

afterEach(() => {
  rmSync(env.base, { recursive: true, force: true })
})

describe('PluginRepository 损坏与提交失败保护', () => {
  it('损坏注册表保留原件、内存为空且拒绝写入', () => {
    const broken = '{ not valid json'
    writeFileSync(registryPath, broken)
    const repo = newRepo()
    expect(repo.getAll()).toEqual([])
    expect(repo.getLoadError()?.reason).toBe('corrupt')
    expect(() => repo.upsert(entry('p1'))).toThrow()
    expect(readFileSync(registryPath, 'utf8')).toBe(broken)
    expect(repo.setEnabled('p1', false)).toBe(false)
    expect(readdirSync(getPluginsDir()).filter(name => name.includes('.tmp'))).toEqual([])
  })

  it('未知 schema（非数组）同样保留并阻止写入', () => {
    writeFileSync(registryPath, '{"plugins":[]}')
    const repo = newRepo()
    expect(repo.getAll()).toEqual([])
    expect(repo.getLoadError()).not.toBeNull()
    expect(readFileSync(registryPath, 'utf8')).toBe('{"plugins":[]}')
  })

  it('写盘失败时 upsert 抛错并回滚内存，磁盘保持上一次提交', () => {
    const repo = newRepo()
    repo.upsert(entry('p1'))
    const before = readFileSync(registryPath, 'utf8')
    env.failWrite = true
    expect(() => repo.upsert(entry('p2'))).toThrow('disk full')
    env.failWrite = false
    expect(repo.getAll().map(e => e.id)).toEqual(['p1'])
    expect(readFileSync(registryPath, 'utf8')).toBe(before)
    expect(readdirSync(getPluginsDir()).filter(name => name.includes('.tmp'))).toEqual([])
  })

  it('setEnabled / remove 写盘失败返回 false 并恢复原状态', () => {
    const repo = newRepo()
    repo.upsert(entry('p1', true))
    env.failWrite = true
    expect(repo.setEnabled('p1', false)).toBe(false)
    expect(repo.remove('p1')).toBe(false)
    env.failWrite = false
    expect(repo.get('p1')?.enabled).toBe(true)
    expect(repo.get('p1')).toBeTruthy()
  })

  it('expectedRevision 过期时抛 RevisionConflictError 且不落盘', () => {
    const repo = newRepo()
    repo.upsert(entry('p1'))
    const stale = repo.getRevision() - 1
    expect(() => repo.upsert(entry('p2'), { expectedRevision: stale })).toThrow(RevisionConflictError)
    expect(repo.get('p2')).toBeUndefined()
    expect(repo.getRevision()).toBe(stale + 1)
  })

  it('get 返回副本，外部修改不污染仓储内存', () => {
    const repo = newRepo()
    repo.upsert(entry('p1'))
    const copy = repo.get('p1')!
    copy.version = 'mutated'
    expect(repo.get('p1')?.version).toBe('1.0.0')
  })

  it('读取时清理历史固定 .tmp 残留', () => {
    writeFileSync(`${registryPath}.tmp`, 'stale')
    const repo = newRepo()
    expect(repo.getAll()).toEqual([])
    expect(existsSync(`${registryPath}.tmp`)).toBe(false)
  })
})

// 避免未使用告警：RevisionOptions 作为 API 契约的编译期锚点。
const _options: RevisionOptions = {}
void _options
