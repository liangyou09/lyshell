import { describe, it, expect, beforeEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'

const logState = vi.hoisted(() => ({ calls: [] as string[] }))
vi.mock('electron-log', () => ({
  default: {
    info: (...args: unknown[]) => logState.calls.push(args.map((a) => String(a)).join(' ')),
    error: (...args: unknown[]) => logState.calls.push(args.map((a) => String(a)).join(' ')),
    warn: (...args: unknown[]) => logState.calls.push(args.map((a) => String(a)).join(' '))
  }
}))
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() }
}))

import { AgentRepository } from './agent-repository'
import { EnvProfileRepository } from './env-profile-repository'
import { HarnessWorkspaceRepository } from './harness-workspace-repository'
import { SecretStore } from './secret-store'
import { createTestCipher, resetSecretFiles, secretTestPath } from './secret-store.test-support'
import { SECRET_PLACEHOLDER } from '@shared/harness'

const configDir = join(tmpdir(), 'config')
mkdirSync(configDir, { recursive: true })

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(configDir, { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf-8')
}

function assertNoPlaintext(path: string, secret: string): void {
  expect(readFileSync(path, 'utf-8')).not.toContain(secret)
  expect(readFileSync(`${path}.bak`, 'utf-8')).not.toContain(secret)
}

/* ------------------------------------------------------------------ *
 * Agent 配置
 * ------------------------------------------------------------------ */

const agentsPath = join(configDir, 'agents-secret-migration-test.json')

function agentRepo(store: SecretStore): AgentRepository {
  return new AgentRepository(store, { fileName: 'agents-secret-migration-test.json' })
}

describe('Agent 配置秘密迁移', () => {
  let store: SecretStore

  beforeEach(() => {
    rmSync(agentsPath, { recursive: true, force: true })
    rmSync(`${agentsPath}.bak`, { force: true })
    const vaultPath = secretTestPath('agent-secret-migration-vault.json')
    resetSecretFiles(vaultPath)
    store = new SecretStore({ filePath: vaultPath, cipher: createTestCipher() })
  })

  it('加载时把明文秘密写入 vault，磁盘/备份/public DTO 都不含明文', () => {
    const secret = 'sk-agent-secret-0001'
    writeJson(agentsPath, [{
      id: 'a1',
      name: 'Agent 1',
      command: 'codex',
      order: 0,
      env: { PATH: '/usr/bin', OPENAI_API_KEY: secret, CUSTOM_TOKEN: 'custom-secret-1' },
      secretEnvKeys: ['CUSTOM_TOKEN']
    }])

    const repo = agentRepo(store)
    // 运行期仍可取到真实值（启动路径兼容）
    expect(repo.get('a1')?.env).toMatchObject({
      PATH: '/usr/bin',
      OPENAI_API_KEY: secret,
      CUSTOM_TOKEN: 'custom-secret-1'
    })

    // 主文件与备份只剩引用
    const disk = readJson<Array<Record<string, unknown>>>(agentsPath)
    expect(disk[0].env).toEqual({ PATH: '/usr/bin' })
    const refs = disk[0].envSecretRefs as Record<string, string>
    expect(refs.OPENAI_API_KEY).toMatch(/^sec_[0-9a-f]{32}$/)
    expect(refs.CUSTOM_TOKEN).toMatch(/^sec_[0-9a-f]{32}$/)
    assertNoPlaintext(agentsPath, secret)
    // vault 只保存密文
    expect(readFileSync(store.getFilePath(), 'utf-8')).not.toContain(secret)

    // public DTO：秘密值统一占位符，非秘密值保持可见
    const pub = repo.getPublic('a1')!
    expect(pub.env.OPENAI_API_KEY).toBe(SECRET_PLACEHOLDER)
    expect(pub.env.CUSTOM_TOKEN).toBe(SECRET_PLACEHOLDER)
    expect(pub.env.PATH).toBe('/usr/bin')
    expect(JSON.stringify(pub)).not.toContain(secret)
    expect(JSON.stringify(repo.getAllPublic())).not.toContain(secret)
    // 迁移/解析日志只允许出现 ref 与错误类别，不允许出现明文
    expect(logState.calls.join('\n')).not.toContain(secret)
  })

  it('placeholder 更新保留原秘密且不重加密', () => {
    const secret = 'sk-agent-secret-0002'
    writeJson(agentsPath, [{
      id: 'a1', name: 'A', command: 'codex', order: 0,
      env: { OPENAI_API_KEY: secret }
    }])
    const repo = agentRepo(store)
    // 触发加载期迁移后再记录基线，避免把「尚未迁移」误当基线
    repo.get('a1')
    const entriesBefore = store.status().entries
    const refBefore = readJson<Array<Record<string, unknown>>>(agentsPath)[0].envSecretRefs as Record<string, string>

    expect(repo.update(repo.getPublic('a1')!)).toBe(true)
    expect(store.status().entries).toBe(entriesBefore)
    expect(repo.get('a1')?.env?.OPENAI_API_KEY).toBe(secret)
    expect((readJson<Array<Record<string, unknown>>>(agentsPath)[0].envSecretRefs as Record<string, string>).OPENAI_API_KEY)
      .toBe(refBefore.OPENAI_API_KEY)
    assertNoPlaintext(agentsPath, secret)
  })

  it('真实新值替换：旧引用删除，新值可解析', () => {
    const oldSecret = 'sk-agent-old-0003'
    const newSecret = 'sk-agent-new-0003'
    writeJson(agentsPath, [{
      id: 'a1', name: 'A', command: 'codex', order: 0,
      env: { OPENAI_API_KEY: oldSecret }
    }])
    const repo = agentRepo(store)
    repo.get('a1')
    const oldRef = (readJson<Array<Record<string, unknown>>>(agentsPath)[0].envSecretRefs as Record<string, string>).OPENAI_API_KEY

    expect(repo.update({ ...repo.get('a1')!, env: { OPENAI_API_KEY: newSecret } })).toBe(true)
    expect(repo.get('a1')?.env?.OPENAI_API_KEY).toBe(newSecret)
    expect(store.resolve(oldRef)).toEqual({ ok: false, reason: 'not_found' })
    expect(store.status().entries).toBe(1)
    assertNoPlaintext(agentsPath, newSecret)
    expect(readFileSync(agentsPath, 'utf-8')).not.toContain(oldSecret)
  })

  it('空字符串清除秘密，引用被删除', () => {
    const secret = 'sk-agent-clear-0004'
    writeJson(agentsPath, [{
      id: 'a1', name: 'A', command: 'codex', order: 0,
      env: { PATH: '/bin', OPENAI_API_KEY: secret }
    }])
    const repo = agentRepo(store)
    expect(repo.get('a1')?.env?.OPENAI_API_KEY).toBe(secret)
    expect(store.status().entries).toBe(1)

    // public DTO 把秘密显示为占位符；把该键显式改成空串表示删除
    const pub = repo.getPublic('a1')!
    expect(repo.update({ ...pub, env: { PATH: '/bin', OPENAI_API_KEY: '' } })).toBe(true)
    expect(repo.get('a1')?.env?.OPENAI_API_KEY).toBeUndefined()
    expect(store.status().entries).toBe(0)
    const disk = readJson<Array<Record<string, unknown>>>(agentsPath)
    expect(disk[0].envSecretRefs).toBeUndefined()
  })

  it('不同 Agent 取到各自的显式秘密，互不影响', () => {
    const one = 'sk-agent-one-0005'
    const two = 'sk-agent-two-0005'
    writeJson(agentsPath, [
      { id: 'a1', name: 'A1', command: 'codex', order: 0, env: { OPENAI_API_KEY: one } },
      { id: 'a2', name: 'A2', command: 'codex', order: 1, env: { OPENAI_API_KEY: two } }
    ])
    const repo = agentRepo(store)
    expect(repo.get('a1')?.env?.OPENAI_API_KEY).toBe(one)
    expect(repo.get('a2')?.env?.OPENAI_API_KEY).toBe(two)

    const disk = readJson<Array<Record<string, unknown>>>(agentsPath)
    const ref1 = (disk[0].envSecretRefs as Record<string, string>).OPENAI_API_KEY
    const ref2 = (disk[1].envSecretRefs as Record<string, string>).OPENAI_API_KEY
    expect(ref1).not.toBe(ref2)

    // 只改 a1，a2 的值与引用不变
    expect(repo.update({ ...repo.get('a1')!, env: { OPENAI_API_KEY: 'sk-agent-one-updated' } })).toBe(true)
    expect(repo.get('a2')?.env?.OPENAI_API_KEY).toBe(two)
    expect((readJson<Array<Record<string, unknown>>>(agentsPath)[1].envSecretRefs as Record<string, string>).OPENAI_API_KEY)
      .toBe(ref2)
  })

  it('安全存储不可用：保留原件与运行期明文，拒绝任何落盘', () => {
    const secret = 'sk-agent-unavailable-0006'
    const original = JSON.stringify([{
      id: 'a1', name: 'A', command: 'codex', order: 0,
      env: { OPENAI_API_KEY: secret }
    }], null, 2)
    mkdirSync(configDir, { recursive: true })
    writeFileSync(agentsPath, original, 'utf-8')

    const unavailable = new SecretStore({
      filePath: secretTestPath('agent-unavailable-vault.json'),
      cipher: createTestCipher({ available: false })
    })
    const repo = agentRepo(unavailable)
    // 运行期仍可读到旧明文，配置不被破坏
    expect(repo.get('a1')?.env?.OPENAI_API_KEY).toBe(secret)
    expect(readFileSync(agentsPath, 'utf-8')).toBe(original)
    // 即使迁移/保存不可用，public DTO 也不能回发明文
    expect(JSON.stringify(repo.getAllPublic())).not.toContain(secret)
    expect(repo.getPublic('a1')?.env.OPENAI_API_KEY).toBe(SECRET_PLACEHOLDER)

    // 后续写入被拒绝，避免把明文写回磁盘或丢数据
    expect(repo.add({ name: 'B', command: 'codex', order: 1, env: {} })).toBeNull()
    expect(repo.update({ ...repo.get('a1')!, name: 'renamed' })).toBe(false)
    expect(repo.delete('a1')).toBe(false)
    expect(readFileSync(agentsPath, 'utf-8')).toBe(original)
  })

  it('read-back 校验失败：迁移中止，原件与明文保留', () => {
    const secret = 'sk-agent-readback-0007'
    const original = JSON.stringify([{
      id: 'a1', name: 'A', command: 'codex', order: 0,
      env: { OPENAI_API_KEY: secret }
    }], null, 2)
    mkdirSync(configDir, { recursive: true })
    writeFileSync(agentsPath, original, 'utf-8')

    const broken = new SecretStore({
      filePath: secretTestPath('agent-readback-vault.json'),
      cipher: {
        isEncryptionAvailable: () => true,
        encryptString: () => Buffer.from('ciphertext'),
        decryptString: () => 'tampered-value',
        getSelectedStorageBackend: () => 'test_backend'
      }
    })
    const repo = agentRepo(broken)
    expect(repo.get('a1')?.env?.OPENAI_API_KEY).toBe(secret)
    expect(readFileSync(agentsPath, 'utf-8')).toBe(original)
    expect(broken.status().entries).toBe(0)
  })

  it('配置提交失败：新引用回滚，旧引用与旧值保留', () => {
    const secret = 'sk-agent-commit-0008'
    writeJson(agentsPath, [{
      id: 'a1', name: 'A', command: 'codex', order: 0,
      env: { OPENAI_API_KEY: secret }
    }])
    const repo = agentRepo(store)
    repo.get('a1')
    const oldRef = (readJson<Array<Record<string, unknown>>>(agentsPath)[0].envSecretRefs as Record<string, string>).OPENAI_API_KEY

    // 用目录占住配置文件路径，模拟落盘失败
    rmSync(agentsPath, { force: true })
    mkdirSync(agentsPath)

    expect(repo.update({ ...repo.get('a1')!, env: { OPENAI_API_KEY: 'sk-agent-commit-new' } })).toBe(false)
    // 内存回滚
    expect(repo.get('a1')?.env?.OPENAI_API_KEY).toBe(secret)
    // 旧引用仍在，新引用已回滚
    expect(store.resolve(oldRef)).toEqual({ ok: true, value: secret })
    expect(store.status().entries).toBe(1)
  })

  it('解密失败：保留 ref 与记录，不写 undefined 覆盖', () => {
    const secret = 'sk-agent-decrypt-0009'
    writeJson(agentsPath, [{
      id: 'a1', name: 'A', command: 'codex', order: 0,
      env: { OPENAI_API_KEY: secret }
    }])
    const repo = agentRepo(store)
    repo.get('a1')
    const ref = (readJson<Array<Record<string, unknown>>>(agentsPath)[0].envSecretRefs as Record<string, string>).OPENAI_API_KEY

    // 用同一文件、但解密总失败的 store 重新加载
    const broken = new SecretStore({
      filePath: store.getFilePath(),
      cipher: {
        isEncryptionAvailable: () => true,
        encryptString: () => Buffer.from('ciphertext'),
        decryptString: () => {
          throw new Error('cannot decrypt')
        },
        getSelectedStorageBackend: () => 'test_backend'
      }
    })
    const repoBroken = agentRepo(broken)
    const loaded = repoBroken.get('a1')!
    expect(loaded.env?.OPENAI_API_KEY).toBeUndefined()
    expect(loaded.envSecretRefs?.OPENAI_API_KEY).toBe(ref)

    // 前端拿到占位符后原样回写：ref 必须保留
    expect(repoBroken.update({ ...repoBroken.getPublic('a1')!, name: 'renamed' })).toBe(true)
    const disk = readJson<Array<Record<string, unknown>>>(agentsPath)
    expect((disk[0].envSecretRefs as Record<string, string>).OPENAI_API_KEY).toBe(ref)
    expect(disk[0].name).toBe('renamed')

    // 运行期 get 在解密失败时缺该键；整条回写同样不能把引用当删除
    expect(repoBroken.update({ ...repoBroken.get('a1')!, name: 'renamed-again' })).toBe(true)
    expect(
      (readJson<Array<Record<string, unknown>>>(agentsPath)[0].envSecretRefs as Record<string, string>).OPENAI_API_KEY
    ).toBe(ref)
  })
})

/* ------------------------------------------------------------------ *
 * 环境变量组
 * ------------------------------------------------------------------ */

const profilesPath = join(configDir, 'env-profile-secret-migration-test.json')

describe('变量组秘密迁移', () => {
  let store: SecretStore

  beforeEach(() => {
    rmSync(profilesPath, { recursive: true, force: true })
    rmSync(`${profilesPath}.bak`, { force: true })
    const vaultPath = secretTestPath('env-profile-secret-migration-vault.json')
    resetSecretFiles(vaultPath)
    store = new SecretStore({ filePath: vaultPath, cipher: createTestCipher() })
  })

  function seedProfile(apiKey: string, token: string): void {
    writeJson(profilesPath, {
      profiles: [{
        id: 'p1',
        name: 'Profile 1',
        order: 0,
        baseUrl: 'https://api.example.test',
        apiKey,
        env: { PATH: '/usr/bin', AUTH_TOKEN: token }
      }],
      activeProfileId: 'p1'
    })
  }

  it('apiKey 与秘密 env 迁移进 vault，可见配置保留', () => {
    const apiKey = 'sk-profile-secret-0010'
    const token = 'token-profile-secret-0010'
    seedProfile(apiKey, token)
    const repo = new EnvProfileRepository('env-profile-secret-migration-test.json', store)

    const runtime = repo.get('p1')!
    expect(runtime.apiKey).toBe(apiKey)
    expect(runtime.env.AUTH_TOKEN).toBe(token)
    expect(runtime.baseUrl).toBe('https://api.example.test')

    const disk = readJson<{ profiles: Array<Record<string, unknown>>; activeProfileId: string }>(profilesPath)
    const stored = disk.profiles[0]
    expect(stored.apiKey).toBeUndefined()
    expect(stored.apiKeyRef).toMatch(/^sec_[0-9a-f]{32}$/)
    expect((stored.env as Record<string, string>).AUTH_TOKEN).toBeUndefined()
    expect((stored.env as Record<string, string>).PATH).toBe('/usr/bin')
    expect((stored.envSecretRefs as Record<string, string>).AUTH_TOKEN).toMatch(/^sec_[0-9a-f]{32}$/)
    expect(disk.activeProfileId).toBe('p1')
    assertNoPlaintext(profilesPath, apiKey)
    assertNoPlaintext(profilesPath, token)
    expect(readFileSync(store.getFilePath(), 'utf-8')).not.toContain(apiKey)

    const pub = repo.getPublic('p1')!
    expect(pub.apiKey).toBe(SECRET_PLACEHOLDER)
    expect(pub.apiKeySecret).toEqual({ present: true, ref: stored.apiKeyRef })
    expect(pub.env.AUTH_TOKEN).toBe(SECRET_PLACEHOLDER)
    expect(pub.env.PATH).toBe('/usr/bin')
    expect(pub.baseUrl).toBe('https://api.example.test')
    expect(JSON.stringify(repo.getAllPublic())).not.toContain(apiKey)
    expect(JSON.stringify(repo.getAllPublic())).not.toContain(token)
  })

  it('placeholder 回写保留 apiKey 与 env 秘密；空串清除 apiKey', () => {
    const apiKey = 'sk-profile-secret-0011'
    const token = 'token-profile-secret-0011'
    seedProfile(apiKey, token)
    const repo = new EnvProfileRepository('env-profile-secret-migration-test.json', store)
    // 先在 load 阶段完成迁移，再记录基线条目数
    repo.getAll()
    const entriesBefore = store.status().entries

    expect(repo.update(repo.getPublic('p1')!)).toBe(true)
    expect(store.status().entries).toBe(entriesBefore)
    expect(repo.get('p1')?.apiKey).toBe(apiKey)
    expect(repo.get('p1')?.env.AUTH_TOKEN).toBe(token)

    const pub = repo.getPublic('p1')!
    expect(repo.update({ ...pub, apiKey: '' })).toBe(true)
    expect(repo.get('p1')?.apiKey).toBeUndefined()
    // env 秘密仍在（public 里是占位符，语义为保留）
    expect(repo.get('p1')?.env.AUTH_TOKEN).toBe(token)
    expect(store.status().entries).toBe(1)
    expect(readJson<{ profiles: Array<Record<string, unknown>> }>(profilesPath).profiles[0].apiKeyRef)
      .toBeUndefined()
    assertNoPlaintext(profilesPath, apiKey)
  })

  it('add/importProfiles 的新秘密同样只写引用', () => {
    const repo = new EnvProfileRepository('env-profile-secret-migration-test.json', store)
    const added = repo.add({
      name: 'Added',
      baseUrl: 'https://added.example.test',
      apiKey: 'sk-added-0012',
      env: { PASSWORD: 'pw-added-0012', PATH: '/bin' }
    })
    expect(added?.apiKey).toBe('sk-added-0012')
    expect(added?.env.PASSWORD).toBe('pw-added-0012')

    const count = repo.importProfiles([{
      id: 'legacy',
      name: 'Legacy',
      order: 0,
      apiKey: 'sk-imported-0012',
      env: { PRIVATE_KEY: 'private-key-0012', CODEX_HOME: '/home/user/.codex' }
    }], 'legacy')
    expect(count).toBe(1)
    expect(repo.get('legacy')?.apiKey).toBe('sk-imported-0012')
    expect(repo.get('legacy')?.env.PRIVATE_KEY).toBe('private-key-0012')
    const raw = readFileSync(profilesPath, 'utf-8')
    for (const secret of ['sk-added-0012', 'pw-added-0012', 'sk-imported-0012', 'private-key-0012']) {
      expect(raw).not.toContain(secret)
    }
    expect(repo.getActiveProfileId()).toBe('legacy')
    expect(repo.getPublic('legacy')?.env.CODEX_HOME).toBe('/home/user/.codex')
  })
})

/* ------------------------------------------------------------------ *
 * Harness 工作区
 * ------------------------------------------------------------------ */

const workspacesPath = join(configDir, 'workspace-secret-migration-test.json')

describe('工作区内联 env 秘密迁移', () => {
  let store: SecretStore

  beforeEach(() => {
    rmSync(workspacesPath, { recursive: true, force: true })
    rmSync(`${workspacesPath}.bak`, { force: true })
    const vaultPath = secretTestPath('workspace-secret-migration-vault.json')
    resetSecretFiles(vaultPath)
    store = new SecretStore({ filePath: vaultPath, cipher: createTestCipher() })
  })

  function seedWorkspace(token: string): void {
    writeJson(workspacesPath, [{
      id: 'w1',
      name: 'Workspace 1',
      cwd: 'C:\\work\\demo',
      order: 0,
      env: { PATH: '/usr/bin', ANTHROPIC_AUTH_TOKEN: token, CODEX_HOME: '/home/user/.codex' }
    }])
  }

  it('秘密 env 迁移，getAll/get 运行期可用，public 占位', () => {
    const token = 'token-workspace-secret-0013'
    seedWorkspace(token)
    const repo = new HarnessWorkspaceRepository('workspace-secret-migration-test.json', { secretStore: store })

    expect(repo.getAll()[0].env).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: token,
      CODEX_HOME: '/home/user/.codex',
      PATH: '/usr/bin'
    })
    const disk = readJson<Array<Record<string, unknown>>>(workspacesPath)
    expect((disk[0].env as Record<string, string>).ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect((disk[0].envSecretRefs as Record<string, string>).ANTHROPIC_AUTH_TOKEN)
      .toMatch(/^sec_[0-9a-f]{32}$/)
    assertNoPlaintext(workspacesPath, token)

    const pub = repo.getPublic('w1')!
    expect(pub.env?.ANTHROPIC_AUTH_TOKEN).toBe(SECRET_PLACEHOLDER)
    expect(pub.env?.CODEX_HOME).toBe('/home/user/.codex')
    expect(JSON.stringify(repo.getAllPublic())).not.toContain(token)
  })

  it('public 回写保留秘密，空串删除', () => {
    const token = 'token-workspace-secret-0014'
    seedWorkspace(token)
    const repo = new HarnessWorkspaceRepository('workspace-secret-migration-test.json', { secretStore: store })
    repo.getAll()
    const entriesBefore = store.status().entries

    expect(repo.update({ ...repo.getAll()[0], name: 'Renamed' })).toBe(true)
    expect(store.status().entries).toBe(entriesBefore)
    expect(repo.get('w1')?.env?.ANTHROPIC_AUTH_TOKEN).toBe(token)

    const pub = repo.getPublic('w1')!
    expect(repo.update({
      ...pub,
      env: { PATH: '/usr/bin', ANTHROPIC_AUTH_TOKEN: '', CODEX_HOME: '/home/user/.codex' }
    })).toBe(true)
    expect(repo.get('w1')?.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(store.status().entries).toBe(0)
    expect(readJson<Array<Record<string, unknown>>>(workspacesPath)[0].envSecretRefs).toBeUndefined()
  })

  it('replaceAll 会把明文秘密迁入 vault，且不覆盖旧引用', () => {
    const repo = new HarnessWorkspaceRepository('workspace-secret-migration-test.json', { secretStore: store })
    expect(repo.replaceAll([{
      id: 'w1',
      name: 'W1',
      cwd: 'C:\\work',
      order: 0,
      env: { PASSWORD: 'pw-workspace-0015' }
    }])).toBe(true)
    expect(repo.get('w1')?.env?.PASSWORD).toBe('pw-workspace-0015')
    expect(readFileSync(workspacesPath, 'utf-8')).not.toContain('pw-workspace-0015')
  })
})
