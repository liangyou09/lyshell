import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { ConnectionType, type SessionConfig } from '@shared/types'

vi.mock('electron-log', () => ({
  default: { info: () => {}, error: () => {}, warn: () => {} }
}))

// getConfigDir 在模块内缓存，整个文件复用一个隔离 userData 目录
const userDataDir = join(
  tmpdir(),
  `lyshell-secret-ref-precedence-${process.pid}-${Math.random().toString(16).slice(2)}`
)
const configDir = join(userDataDir, 'config')

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  safeStorage: {}
}))

import { SessionRepository } from './repository'
import { AgentRepository } from './agent-repository'
import { EnvProfileRepository } from './env-profile-repository'
import { HarnessWorkspaceRepository } from './harness-workspace-repository'
import { SecretStore } from './secret-store'
import { createTestCipher, resetSecretFiles, secretTestPath } from './secret-store.test-support'

/**
 * F06 回归：`envSecretRefs` 与明文副本并存时，已有引用是唯一事实来源。
 *
 * 磁盘形态（手工编辑 / 部分迁移的配置）可能同时带 env 明文与 refs —— 加载必须
 * 以 ref 为准剔除多余明文；ref 不可解析时必须保持原字节并拒绝任何保存，
 * 绝不能把明文当 fallback 写进新的 primary/.bak。
 *
 * 用真实仓储 + 真实 SecretStore（隔离 vault 文件）覆盖 4 类仓储：
 * - 名字像秘密的键（API_TOKEN）
 * - 名字不像秘密、只靠 ref 识别的键（CUSTOM_OPTION）且没有 secretEnvKeys
 */

const vaultPath = secretTestPath('secret-ref-precedence-vault.json')
const sessionsPath = join(configDir, 'sessions.json')
const agentFile = (name: string): string => join(configDir, name)
const profileFile = (name: string): string => join(configDir, name)
const workspaceFile = (name: string): string => join(configDir, name)

function newStore(available = true): SecretStore {
  resetSecretFiles(vaultPath)
  return new SecretStore({
    filePath: vaultPath,
    cipher: createTestCipher({ available })
  })
}

function writeJson(filePath: string, value: unknown): string {
  mkdirSync(configDir, { recursive: true })
  const json = JSON.stringify(value, null, 2)
  writeFileSync(filePath, json, 'utf-8')
  return json
}

function readJson<T = Record<string, any>>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf-8'))
}

/** primary 必查；.bak 仅在存在时检查（部分仓储不会刷新备份） */
function assertNoPlaintext(filePath: string, secret: string): void {
  expect(readFileSync(filePath, 'utf-8')).not.toContain(secret)
  if (existsSync(`${filePath}.bak`)) {
    expect(readFileSync(`${filePath}.bak`, 'utf-8')).not.toContain(secret)
  }
}

function makeLocal(
  id: string,
  env: Record<string, string>,
  extra: { envSecretRefs?: Record<string, string>; secretEnvKeys?: string[] } = {}
): SessionConfig {
  return {
    id,
    name: `local-${id}`,
    type: ConnectionType.LOCAL,
    local: { shell: 'bash', env, ...extra },
    terminal: { fontSize: 14, encoding: 'utf-8' },
    tags: [],
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-01T00:00:00.000Z')
  } as unknown as SessionConfig
}

function seedProfiles(filePath: string, profiles: unknown[]): string {
  return writeJson(filePath, { profiles, activeProfileId: null })
}

function seedWorkspaces(filePath: string, workspaces: unknown[]): string {
  return writeJson(filePath, workspaces)
}

describe('F06 已有 ref 覆盖同名明文', () => {
  beforeEach(() => {
    rmSync(userDataDir, { recursive: true, force: true })
    mkdirSync(configDir, { recursive: true })
    resetSecretFiles(vaultPath)
  })

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true })
    resetSecretFiles(vaultPath)
  })

  describe('SessionRepository', () => {
    it('有效 ref + 明文副本：剔除明文、ref 原样保留且不重建，改另一条记录也不回写明文', () => {
      const store = newStore()
      const apiRef = store.put('vault-api-value')
      const customRef = store.put('vault-custom-value')
      const vaultBefore = readFileSync(vaultPath, 'utf-8')

      writeJson(sessionsPath, [
        makeLocal(
          'local-1',
          {
            PATH: '/usr/bin',
            API_TOKEN: 'stale-api-plaintext',
            CUSTOM_OPTION: 'stale-custom-plaintext'
          },
          { envSecretRefs: { API_TOKEN: apiRef, CUSTOM_OPTION: customRef } }
        ),
        makeLocal('local-2', { PATH: '/usr/bin' })
      ])

      const repo = new SessionRepository(store)

      // 运行期以 ref 解析值为准，明文不是 fallback
      expect(repo.get('local-1')?.local?.env).toMatchObject({
        PATH: '/usr/bin',
        API_TOKEN: 'vault-api-value',
        CUSTOM_OPTION: 'vault-custom-value'
      })

      let disk = readJson<Array<Record<string, any>>>(sessionsPath)
      expect(disk.find(s => s.id === 'local-1')!.local.env).toEqual({ PATH: '/usr/bin' })
      // 引用保持不变（不 rebuild、不重新 put）
      expect(disk.find(s => s.id === 'local-1')!.local.envSecretRefs).toEqual({
        API_TOKEN: apiRef,
        CUSTOM_OPTION: customRef
      })
      expect(readFileSync(vaultPath, 'utf-8')).toBe(vaultBefore)
      expect(existsSync(`${sessionsPath}.bak`)).toBe(true)
      assertNoPlaintext(sessionsPath, 'stale-api-plaintext')
      assertNoPlaintext(sessionsPath, 'stale-custom-plaintext')
      assertNoPlaintext(sessionsPath, 'vault-api-value')
      assertNoPlaintext(sessionsPath, 'vault-custom-value')

      // 修改另一条（无秘密的）记录：primary/.bak 仍不得残留多余明文
      const other = repo.get('local-2')!
      repo.updateSession({ ...other, name: 'renamed-local-2' })
      disk = readJson<Array<Record<string, any>>>(sessionsPath)
      expect(disk.find(s => s.id === 'local-2')!.name).toBe('renamed-local-2')
      expect(disk.find(s => s.id === 'local-1')!.local.env).toEqual({ PATH: '/usr/bin' })
      expect(disk.find(s => s.id === 'local-1')!.local.envSecretRefs).toEqual({
        API_TOKEN: apiRef,
        CUSTOM_OPTION: customRef
      })
      assertNoPlaintext(sessionsPath, 'stale-api-plaintext')
      assertNoPlaintext(sessionsPath, 'stale-custom-plaintext')
    })

    it('ref 无法解析：保持原字节，更新其他记录失败', () => {
      const store = newStore()
      const missingRef = `sec_${'b'.repeat(32)}`
      const original = writeJson(sessionsPath, [
        makeLocal(
          'local-1',
          { PATH: '/usr/bin', API_TOKEN: 'leaked-api-plaintext' },
          { envSecretRefs: { API_TOKEN: missingRef } }
        ),
        makeLocal('local-2', { PATH: '/usr/bin' })
      ])

      const repo = new SessionRepository(store)
      const other = repo.get('local-2')!
      expect(() => repo.updateSession({ ...other, name: 'renamed-local-2' })).toThrow(/refusing/i)
      expect(readFileSync(sessionsPath, 'utf-8')).toBe(original)
      // 原文件未被成功写过：.bak 不应出现，更不能带明文
      expect(existsSync(`${sessionsPath}.bak`)).toBe(false)
    })

    it('安全存储不可用（真实 ref 已存在）：不回落明文、保持原字节并拒绝保存', () => {
      // 先用可用后端写入真实条目，再对**同一 vault 文件**构造「后端不可用」的 store。
      // 不能用 newStore(false)：它会 reset 掉文件，ref 变成 not_found，覆盖不到 unavailable 分支。
      const writer = newStore()
      const apiRef = writer.put('unavailable-api-value')
      const unreadable = new SecretStore({
        filePath: vaultPath,
        cipher: createTestCipher({ available: false })
      })
      // 前提校验：条目存在但读不出 → unavailable（不是 not_found）
      expect(unreadable.resolve(apiRef)).toEqual({ ok: false, reason: 'unavailable' })

      const original = writeJson(sessionsPath, [
        makeLocal(
          'local-1',
          { PATH: '/usr/bin', API_TOKEN: 'unavailable-api-plaintext' },
          { envSecretRefs: { API_TOKEN: apiRef } }
        ),
        makeLocal('local-2', { PATH: '/usr/bin' })
      ])

      const repo = new SessionRepository(unreadable)
      // 运行期不回落明文：ref 解析失败只留缺失键
      const runtimeEnv = repo.get('local-1')?.local?.env
      expect(runtimeEnv?.API_TOKEN).toBeUndefined()
      expect(JSON.stringify(runtimeEnv)).not.toContain('unavailable-api-plaintext')

      const other = repo.get('local-2')!
      expect(() => repo.updateSession({ ...other, name: 'renamed-local-2' })).toThrow(/refusing/i)
      expect(readFileSync(sessionsPath, 'utf-8')).toBe(original)
      // 从未成功提交过：.bak 不得出现
      expect(existsSync(`${sessionsPath}.bak`)).toBe(false)
    })
  })

  describe('AgentRepository', () => {
    it('ref 命名的非敏感键（无 secretEnvKeys）：加载时剔除多余明文', () => {
      const store = newStore()
      const ref = store.put('vault-custom-value')
      const vaultBefore = readFileSync(vaultPath, 'utf-8')
      const file = agentFile('secret-ref-agents-custom.json')

      writeJson(file, [
        {
          id: 'agent-1',
          name: 'a1',
          command: 'claude',
          order: 0,
          env: { PATH: '/usr/bin', CUSTOM_OPTION: 'stale-custom-plaintext' },
          envSecretRefs: { CUSTOM_OPTION: ref }
        },
        { id: 'agent-2', name: 'a2', command: 'claude', order: 1, env: { PATH: '/usr/bin' } }
      ])

      const repo = new AgentRepository(store, { fileName: 'secret-ref-agents-custom.json' })
      expect(repo.get('agent-1')?.env).toMatchObject({
        PATH: '/usr/bin',
        CUSTOM_OPTION: 'vault-custom-value'
      })

      let disk = readJson<Array<Record<string, any>>>(file)
      expect(disk.find(a => a.id === 'agent-1')!.env).toEqual({ PATH: '/usr/bin' })
      expect(disk.find(a => a.id === 'agent-1')!.envSecretRefs).toEqual({ CUSTOM_OPTION: ref })
      expect(disk.find(a => a.id === 'agent-1')!.secretEnvKeys).toBeUndefined()
      expect(readFileSync(vaultPath, 'utf-8')).toBe(vaultBefore)
      expect(existsSync(`${file}.bak`)).toBe(true)
      assertNoPlaintext(file, 'stale-custom-plaintext')
      assertNoPlaintext(file, 'vault-custom-value')

      expect(repo.update({ ...repo.get('agent-2')!, name: 'renamed-a2' })).toBe(true)
      disk = readJson<Array<Record<string, any>>>(file)
      expect(disk.find(a => a.id === 'agent-2')!.name).toBe('renamed-a2')
      assertNoPlaintext(file, 'stale-custom-plaintext')
    })

    it('名字像秘密的 API_TOKEN：ref+明文并存时保留 ref 值并剔除明文', () => {
      const store = newStore()
      const apiRef = store.put('vault-api-value')
      const file = agentFile('secret-ref-agents-api-token.json')

      writeJson(file, [
        {
          id: 'agent-1',
          name: 'a1',
          command: 'claude',
          order: 0,
          env: { API_TOKEN: 'stale-api-plaintext' },
          envSecretRefs: { API_TOKEN: apiRef }
        }
      ])

      const repo = new AgentRepository(store, { fileName: 'secret-ref-agents-api-token.json' })
      expect(repo.get('agent-1')?.env).toMatchObject({ API_TOKEN: 'vault-api-value' })

      const disk = readJson<Array<Record<string, any>>>(file)
      expect(disk[0].env).toBeUndefined()
      expect(disk[0].envSecretRefs).toEqual({ API_TOKEN: apiRef })
      assertNoPlaintext(file, 'stale-api-plaintext')
      assertNoPlaintext(file, 'vault-api-value')
    })

    it('ref 无法解析：保持原字节，更新其他记录失败', () => {
      const store = newStore()
      const missingRef = `sec_${'e'.repeat(32)}`
      const file = agentFile('secret-ref-agents-bad-ref.json')
      const original = writeJson(file, [
        {
          id: 'agent-1',
          name: 'a1',
          command: 'claude',
          order: 0,
          env: { CUSTOM_OPTION: 'leaked-custom-plaintext' },
          envSecretRefs: { CUSTOM_OPTION: missingRef }
        },
        { id: 'agent-2', name: 'a2', command: 'claude', order: 1, env: { PATH: '/usr/bin' } }
      ])

      const repo = new AgentRepository(store, { fileName: 'secret-ref-agents-bad-ref.json' })
      expect(repo.update({ ...repo.get('agent-2')!, name: 'renamed-a2' })).toBe(false)
      expect(readFileSync(file, 'utf-8')).toBe(original)
    })
  })

  describe('EnvProfileRepository', () => {
    it('ref 命名的非敏感键：加载时剔除多余明文并保留 ref', () => {
      const store = newStore()
      const ref = store.put('vault-custom-value')
      const vaultBefore = readFileSync(vaultPath, 'utf-8')
      const file = profileFile('secret-ref-profiles.json')

      seedProfiles(file, [
        {
          id: 'profile-1',
          name: 'p1',
          order: 0,
          env: { PATH: '/usr/bin', CUSTOM_OPTION: 'stale-custom-plaintext' },
          envSecretRefs: { CUSTOM_OPTION: ref }
        },
        { id: 'profile-2', name: 'p2', order: 1, env: { PATH: '/usr/bin' } }
      ])

      const repo = new EnvProfileRepository('secret-ref-profiles.json', store)
      expect(repo.get('profile-1')?.env).toMatchObject({
        PATH: '/usr/bin',
        CUSTOM_OPTION: 'vault-custom-value'
      })

      const disk = readJson<{ profiles: Array<Record<string, any>> }>(file)
      expect(disk.profiles.find(p => p.id === 'profile-1')!.env).toEqual({ PATH: '/usr/bin' })
      expect(disk.profiles.find(p => p.id === 'profile-1')!.envSecretRefs).toEqual({
        CUSTOM_OPTION: ref
      })
      expect(readFileSync(vaultPath, 'utf-8')).toBe(vaultBefore)
      assertNoPlaintext(file, 'stale-custom-plaintext')
      assertNoPlaintext(file, 'vault-custom-value')
    })

    it('安全存储不可用（真实 ref 已存在）：不回落明文、新增/更新失败且保持原字节', () => {
      // 同上：真实条目 + 同文件的后端不可用 store，确保 resolve 报 unavailable
      const writer = newStore()
      const ref = writer.put('unavailable-custom-value')
      const unreadable = new SecretStore({
        filePath: vaultPath,
        cipher: createTestCipher({ available: false })
      })
      expect(unreadable.resolve(ref)).toEqual({ ok: false, reason: 'unavailable' })

      const file = profileFile('secret-ref-profiles-unavailable.json')
      const original = seedProfiles(file, [
        {
          id: 'profile-1',
          name: 'p1',
          order: 0,
          env: { PATH: '/usr/bin', CUSTOM_OPTION: 'unavailable-custom-plaintext' },
          envSecretRefs: { CUSTOM_OPTION: ref }
        },
        { id: 'profile-2', name: 'p2', order: 1, env: { PATH: '/usr/bin' } }
      ])

      const repo = new EnvProfileRepository('secret-ref-profiles-unavailable.json', unreadable)
      // 运行期不回落明文
      const runtimeEnv = repo.get('profile-1')?.env
      expect(runtimeEnv?.CUSTOM_OPTION).toBeUndefined()
      expect(JSON.stringify(runtimeEnv)).not.toContain('unavailable-custom-plaintext')

      // 迁移无法完成 → 任何写入都失败
      expect(repo.add({ name: 'p3', env: { FOO: 'bar' } })).toBeNull()
      expect(repo.update({ ...repo.get('profile-2')!, name: 'renamed-p2' })).toBe(false)
      expect(readFileSync(file, 'utf-8')).toBe(original)
    })
  })

  describe('HarnessWorkspaceRepository', () => {
    it('ref 命名的非敏感键：加载时剔除多余明文并保留 ref', () => {
      const store = newStore()
      const ref = store.put('vault-custom-value')
      const vaultBefore = readFileSync(vaultPath, 'utf-8')
      const file = workspaceFile('secret-ref-workspaces.json')

      seedWorkspaces(file, [
        {
          id: 'ws-1',
          name: 'w1',
          cwd: '/tmp/project',
          order: 0,
          env: { PATH: '/usr/bin', CUSTOM_OPTION: 'stale-custom-plaintext' },
          envSecretRefs: { CUSTOM_OPTION: ref }
        },
        { id: 'ws-2', name: 'w2', cwd: '/tmp/other', order: 1, env: { PATH: '/usr/bin' } }
      ])

      const repo = new HarnessWorkspaceRepository('secret-ref-workspaces.json', { secretStore: store })
      expect(repo.get('ws-1')?.env).toMatchObject({
        PATH: '/usr/bin',
        CUSTOM_OPTION: 'vault-custom-value'
      })

      const disk = readJson<Array<Record<string, any>>>(file)
      expect(disk.find(w => w.id === 'ws-1')!.env).toEqual({ PATH: '/usr/bin' })
      expect(disk.find(w => w.id === 'ws-1')!.envSecretRefs).toEqual({ CUSTOM_OPTION: ref })
      expect(readFileSync(vaultPath, 'utf-8')).toBe(vaultBefore)
      assertNoPlaintext(file, 'stale-custom-plaintext')
      assertNoPlaintext(file, 'vault-custom-value')
    })

    it('ref 无法解析：保持原字节，更新其他记录失败', () => {
      const store = newStore()
      const missingRef = `sec_${'f'.repeat(32)}`
      const file = workspaceFile('secret-ref-workspaces-bad-ref.json')
      const original = seedWorkspaces(file, [
        {
          id: 'ws-1',
          name: 'w1',
          cwd: '/tmp/project',
          order: 0,
          env: { CUSTOM_OPTION: 'leaked-custom-plaintext' },
          envSecretRefs: { CUSTOM_OPTION: missingRef }
        },
        { id: 'ws-2', name: 'w2', cwd: '/tmp/other', order: 1, env: { PATH: '/usr/bin' } }
      ])

      const repo = new HarnessWorkspaceRepository('secret-ref-workspaces-bad-ref.json', {
        secretStore: store
      })
      expect(repo.update({ ...repo.get('ws-2')!, name: 'renamed-w2' })).toBe(false)
      expect(readFileSync(file, 'utf-8')).toBe(original)
    })
  })
})
