import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { SECRET_PLACEHOLDER } from '@shared/harness'
import { ConnectionType, type SessionConfig } from '@shared/types'

const logState = vi.hoisted(() => ({ calls: [] as string[] }))
const fsState = vi.hoisted(() => ({ failSessionsWrite: false }))

vi.mock('electron-log', () => ({
  default: {
    info: (...args: unknown[]) => logState.calls.push(args.map(a => String(a)).join(' ')),
    error: (...args: unknown[]) => logState.calls.push(args.map(a => String(a)).join(' ')),
    warn: (...args: unknown[]) => logState.calls.push(args.map(a => String(a)).join(' '))
  }
}))

// getConfigDir 在模块内缓存，整个文件复用一个隔离 userData 目录
const userDataDir = join(
  tmpdir(),
  `lyshell-session-local-secrets-${process.pid}-${Math.random().toString(16).slice(2)}`
)

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  safeStorage: {}
}))

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    // 原子写用 fd 写临时文件，无法从 writeFileSync 参数识别目标；改在 rename 提交阶段
    // 按最终路径注入失败，语义与真实磁盘写失败一致（旧文件保持不变）。
    renameSync: (from: Parameters<typeof actual.renameSync>[0], to: Parameters<typeof actual.renameSync>[1]) => {
      if (fsState.failSessionsWrite && String(to).includes('sessions.json')) {
        throw new Error('disk full')
      }
      return actual.renameSync(from, to)
    }
  }
})

import { SessionRepository } from './repository'
import { SecretStore } from './secret-store'
import { createTestCipher, resetSecretFiles, secretTestPath } from './secret-store.test-support'

const sessionsPath = join(userDataDir, 'config', 'sessions.json')
const vaultPath = secretTestPath('session-local-secrets-vault.json')

function makeLocal(id: string, env: Record<string, string>, secretEnvKeys?: string[]): SessionConfig {
  return {
    id,
    name: `local-${id}`,
    type: ConnectionType.LOCAL,
    local: { shell: 'bash', env, ...(secretEnvKeys ? { secretEnvKeys } : {}) },
    terminal: { fontSize: 14, encoding: 'utf-8' },
    tags: [],
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-01T00:00:00.000Z')
  } as unknown as SessionConfig
}

function seed(sessions: SessionConfig[]): string {
  mkdirSync(join(userDataDir, 'config'), { recursive: true })
  const json = JSON.stringify(sessions, null, 2)
  writeFileSync(sessionsPath, json, 'utf-8')
  return json
}

function readDisk(): Array<Record<string, any>> {
  return JSON.parse(readFileSync(sessionsPath, 'utf-8'))
}

function assertNoPlaintext(secret: string): void {
  expect(readFileSync(sessionsPath, 'utf-8')).not.toContain(secret)
  expect(readFileSync(`${sessionsPath}.bak`, 'utf-8')).not.toContain(secret)
}

function newStore(available = true): SecretStore {
  resetSecretFiles(vaultPath)
  return new SecretStore({
    filePath: vaultPath,
    cipher: createTestCipher({ available })
  })
}

describe('SessionRepository local env 秘密边界', () => {
  let store: SecretStore

  beforeEach(() => {
    fsState.failSessionsWrite = false
    logState.calls.length = 0
    rmSync(join(userDataDir, 'config'), { recursive: true, force: true })
    mkdirSync(join(userDataDir, 'config'), { recursive: true })
    store = newStore()
  })

  afterEach(() => {
    fsState.failSessionsWrite = false
    rmSync(userDataDir, { recursive: true, force: true })
    resetSecretFiles(vaultPath)
  })

  it('加载时把 local 明文秘密迁移到 vault，sessions.json/.bak 与 public DTO 都不含明文', () => {
    const token = 'token-secret-0001'
    const custom = 'custom-secret-0001'
    seed([
      makeLocal(
        'local-1',
        { PATH: '/usr/bin', API_TOKEN: token, CUSTOM_CRED: custom, EMPTY_ONE: '' },
        ['CUSTOM_CRED']
      )
    ])

    const repo = new SessionRepository(store)
    // 运行期 get 仍是解析值（启动路径兼容）
    expect(repo.get('local-1')?.local?.env).toMatchObject({
      PATH: '/usr/bin',
      API_TOKEN: token,
      CUSTOM_CRED: custom,
      EMPTY_ONE: ''
    })

    const disk = readDisk()
    expect(disk[0].local.env).toEqual({ PATH: '/usr/bin', EMPTY_ONE: '' })
    const refs = disk[0].local.envSecretRefs as Record<string, string>
    expect(refs.API_TOKEN).toMatch(/^sec_[0-9a-f]{32}$/)
    expect(refs.CUSTOM_CRED).toMatch(/^sec_[0-9a-f]{32}$/)
    expect(disk[0].local.secretEnvKeys).toEqual(['CUSTOM_CRED'])
    assertNoPlaintext(token)
    assertNoPlaintext(custom)
    expect(readFileSync(store.getFilePath(), 'utf-8')).not.toContain(token)

    const pub = repo.getPublic('local-1')!
    expect(pub.local?.env).toEqual({
      PATH: '/usr/bin',
      API_TOKEN: SECRET_PLACEHOLDER,
      CUSTOM_CRED: SECRET_PLACEHOLDER,
      EMPTY_ONE: ''
    })
    expect(JSON.stringify(repo.getAllPublic())).not.toContain(token)
    // 日志只允许出现 ref/错误类别，不允许出现明文
    expect(logState.calls.join('\n')).not.toContain(token)
  })

  it('迁移失败（vault 不可用）保留原始字节与内存明文，并拒绝后续保存', () => {
    const token = 'token-secret-0002'
    const original = seed([makeLocal('local-1', { PATH: '/usr/bin', API_TOKEN: token })])
    store = newStore(false)

    const repo = new SessionRepository(store)
    const loaded = repo.get('local-1')!
    // 内存不被失败迁移改写
    expect(loaded.local?.env).toMatchObject({ PATH: '/usr/bin', API_TOKEN: token })
    // 原文件逐字节保留
    expect(readFileSync(sessionsPath, 'utf-8')).toBe(original)

    // 后续任何保存都不能把明文重新写盘（vault 写入失败 / fail-closed 均可）
    expect(() => repo.updateSession({ ...loaded, name: 'renamed' })).toThrow()
    expect(readFileSync(sessionsPath, 'utf-8')).toBe(original)
  })

  it('迁移提交写盘失败时回滚内存与新建引用，磁盘仍是原字节', () => {
    const token = 'token-secret-0003'
    const original = seed([makeLocal('local-1', { API_TOKEN: token })])
    fsState.failSessionsWrite = true

    const repo = new SessionRepository(store)
    // 内存回滚到迁移前（明文仍在），但保存路径已被 fail-closed
    expect(repo.get('local-1')?.local?.env?.API_TOKEN).toBe(token)
    expect(readFileSync(sessionsPath, 'utf-8')).toBe(original)
    // 本次新建的引用已删除，vault 里没有孤儿秘密
    expect(store.status().entries).toBe(0)
    expect(() => repo.delete('local-1')).toThrow()
    expect(readFileSync(sessionsPath, 'utf-8')).toBe(original)
  })

  it('占位符更新保留原秘密与引用，不重加密', () => {
    const token = 'token-secret-0004'
    seed([makeLocal('local-1', { PATH: '/usr/bin', API_TOKEN: token })])
    const repo = new SessionRepository(store)
    // 先触发懒加载迁移，再记录引用基线
    expect(repo.get('local-1')?.local?.env?.API_TOKEN).toBe(token)
    const refsBefore = readDisk()[0].local.envSecretRefs
    const entriesBefore = store.status().entries

    const pub = repo.getPublic('local-1')!
    expect(pub.local?.env?.API_TOKEN).toBe(SECRET_PLACEHOLDER)
    const updated = repo.saveSession({ ...pub, name: 'renamed' } as SessionConfig)

    expect(updated.name).toBe('renamed')
    expect(updated.local?.env?.API_TOKEN).toBe(token)
    expect(repo.get('local-1')?.local?.env?.API_TOKEN).toBe(token)
    expect(readDisk()[0].local.envSecretRefs).toEqual(refsBefore)
    expect(store.status().entries).toBe(entriesBefore)
    assertNoPlaintext(token)
  })

  it('新记录提交失败不回填 id，安全 DTO 保留暂时无法解析的引用行', () => {
    const repo = new SessionRepository(store)
    const input = makeLocal('', { API_TOKEN: 'new-token' })
    fsState.failSessionsWrite = true
    expect(() => repo.saveSession(input)).toThrow()
    expect(input.id).toBe('')
    expect(repo.getAll()).toEqual([])
  })

  it('新记录伪造 local 占位符被拒绝，且不落盘', () => {
    const token = 'token-secret-0005'
    seed([makeLocal('local-1', { API_TOKEN: token })])
    const repo = new SessionRepository(store)
    // 仓储懒加载：先触发 load+迁移，再捕获基线
    repo.get('local-1')
    const before = readFileSync(sessionsPath, 'utf-8')

    const forged = makeLocal('brand-new', { API_TOKEN: SECRET_PLACEHOLDER })
    expect(() => repo.saveSession(forged)).toThrow(/has no saved value to preserve/)
    expect(readFileSync(sessionsPath, 'utf-8')).toBe(before)
    expect(repo.get('brand-new')).toBeNull()
  })

  it('跨记录复制 local 引用被拒绝（不能借此获得解密权限）', () => {
    const tokenA = 'token-secret-0006'
    const tokenB = 'token-secret-0007'
    seed([
      makeLocal('a', { API_TOKEN: tokenA }),
      makeLocal('b', { API_TOKEN: tokenB })
    ])
    const repo = new SessionRepository(store)
    repo.getAll()
    const disk = readDisk()
    const refA = (disk.find(row => row.id === 'a')!.local.envSecretRefs as Record<string, string>).API_TOKEN
    const pubB = repo.getPublic('b')!

    const forged = {
      ...pubB,
      local: {
        ...pubB.local!,
        env: { ...pubB.local!.env!, API_TOKEN: SECRET_PLACEHOLDER },
        envSecretRefs: { API_TOKEN: refA }
      }
    } as SessionConfig
    expect(() => repo.saveSession(forged)).toThrow(/cannot be copied between sessions/)
    // b 仍然只能解出自己的秘密
    expect(repo.get('b')?.local?.env?.API_TOKEN).toBe(tokenB)
  })

  it('删除一条记录只回收它独占的引用，另一条本地配置的秘密不受影响', () => {
    const tokenA = 'token-secret-0008'
    const tokenB = 'token-secret-0009'
    seed([
      makeLocal('a', { API_TOKEN: tokenA }),
      makeLocal('b', { API_TOKEN: tokenB })
    ])
    const repo = new SessionRepository(store)
    repo.getAll()
    const disk = readDisk()
    const refsA = disk.find(row => row.id === 'a')!.local.envSecretRefs as Record<string, string>
    const refsB = disk.find(row => row.id === 'b')!.local.envSecretRefs as Record<string, string>
    expect(refsA.API_TOKEN).not.toBe(refsB.API_TOKEN)

    expect(repo.delete('a')).toBe(true)

    expect(repo.get('a')).toBeNull()
    expect(repo.get('b')?.local?.env?.API_TOKEN).toBe(tokenB)
    expect(store.resolve(refsA.API_TOKEN).ok).toBe(false)
    expect(store.resolve(refsB.API_TOKEN)).toMatchObject({ ok: true, value: tokenB })
    assertNoPlaintext(tokenA)
    assertNoPlaintext(tokenB)

    // 重新加载后 b 仍可解析，引用没有被误删
    const reloaded = new SessionRepository(store)
    expect(reloaded.get('b')?.local?.env?.API_TOKEN).toBe(tokenB)
  })
})
