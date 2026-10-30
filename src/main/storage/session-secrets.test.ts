import { describe, it, expect } from 'vitest'
import { SECRET_PLACEHOLDER } from '@shared/harness'
import { ConnectionType, type SessionConfig } from '@shared/types'
import {
  SessionSecretError,
  assertNoSecretPlaceholders,
  hasSameSshTarget,
  hydrateSessionSecrets,
  publicSessionConfig
} from './session-secrets'

const REF_A = `sec_${'a'.repeat(32)}`
const REF_B = `sec_${'b'.repeat(32)}`

function makeSession(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    id: 's1',
    name: 'session',
    type: ConnectionType.SSH,
    ssh: { host: 'example.com', port: 22, username: 'user', password: 'hunter2' },
    terminal: { fontSize: 14, encoding: 'utf-8' },
    tags: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  } as unknown as SessionConfig
}

function makeLocal(env: Record<string, string>, extra: Record<string, unknown> = {}): SessionConfig {
  return makeSession({
    type: ConnectionType.LOCAL,
    ssh: undefined,
    local: { shell: 'bash', env, ...extra }
  })
}

describe('publicSessionConfig', () => {
  it('SSH 三个秘密只给占位符与存在状态，真实值不出现在 DTO', () => {
    const session = makeSession({
      ssh: {
        host: 'example.com',
        port: 22,
        username: 'user',
        password: 'hunter2',
        privateKey: 'PRIVATE-KEY',
        passphrase: 'PASSPHRASE-SECRET'
      }
    })
    const pub = publicSessionConfig(session)
    expect(pub.ssh?.password).toBe(SECRET_PLACEHOLDER)
    expect(pub.ssh?.privateKey).toBe(SECRET_PLACEHOLDER)
    expect(pub.ssh?.passphrase).toBe(SECRET_PLACEHOLDER)
    expect(pub.sshSecrets).toEqual({
      password: { present: true },
      privateKey: { present: true },
      passphrase: { present: true }
    })
    const serialized = JSON.stringify(pub)
    expect(serialized).not.toContain('hunter2')
    expect(serialized).not.toContain('PRIVATE-KEY')
    expect(serialized).not.toContain('PASSPHRASE-SECRET')
    // 未提供的字段不会伪装成「存在」
    expect(Object.keys(pub.sshSecrets ?? {})).toEqual(['password', 'privateKey', 'passphrase'])
  })

  it('安全存储失败留下的密文标记 locked，但仍不泄漏密文', () => {
    const ciphertext = 'safe:v1:ZmFrZS1jaXBoZXI='
    const pub = publicSessionConfig(
      makeSession({
        ssh: { host: 'example.com', port: 22, username: 'user', password: ciphertext }
      }),
      { lockedSshFields: ['password'] }
    )
    expect(pub.ssh?.password).toBe(SECRET_PLACEHOLDER)
    expect(pub.sshSecrets?.password).toEqual({ present: true, locked: true })
    expect(JSON.stringify(pub)).not.toContain(ciphertext)
  })

  it('local.env 只遮蔽秘密键：isSecretEnvKey 命中 + 显式 secretEnvKeys，普通键保持可见', () => {
    const pub = publicSessionConfig(
      makeLocal(
        {
          PATH: '/usr/bin',
          OPENAI_API_KEY: 'sk-secret',
          GITHUB_TOKEN: 'ghp-secret',
          CUSTOM_CRED: 'custom-secret',
          EMPTY_VALUE: ''
        },
        { secretEnvKeys: ['CUSTOM_CRED'] }
      )
    )
    expect(pub.local?.env).toEqual({
      PATH: '/usr/bin',
      OPENAI_API_KEY: SECRET_PLACEHOLDER,
      GITHUB_TOKEN: SECRET_PLACEHOLDER,
      CUSTOM_CRED: SECRET_PLACEHOLDER,
      EMPTY_VALUE: ''
    })
    expect(JSON.stringify(pub)).not.toContain('sk-secret')
    expect(JSON.stringify(pub)).not.toContain('ghp-secret')
    expect(JSON.stringify(pub)).not.toContain('custom-secret')
  })
  it('本次解析失败的引用在 DTO 中仍以占位符出现，避免 UI 把整行当已删除', () => {
    const pub = publicSessionConfig(makeLocal({ PATH: '/usr/bin' }, { envSecretRefs: { API_TOKEN: REF_A } }))
    expect(pub.local?.env).toEqual({ PATH: '/usr/bin', API_TOKEN: SECRET_PLACEHOLDER })
  })
})

describe('hydrateSessionSecrets', () => {
  it('空串表示删除 SSH 秘密，只有占位符才表示保留', () => {
    const previous = makeSession({ id: 's1' })
    const cleared = makeSession({
      id: 's1',
      ssh: { host: 'example.com', port: 22, username: 'user', password: '' }
    })
    const { config } = hydrateSessionSecrets(cleared, previous)
    expect(config.ssh?.password).toBeUndefined()
  })

  it('占位符保留同记录同目标的原秘密', () => {
    const previous = makeSession({ id: 's1' })
    const incoming = makeSession({ id: 's1', ssh: { host: 'example.com', port: 22, username: 'user', password: SECRET_PLACEHOLDER } })
    const { config, lockedSshFields } = hydrateSessionSecrets(incoming, previous)
    expect(config.ssh?.password).toBe('hunter2')
    expect(lockedSshFields).toEqual([])
  })

  it('新记录/伪造占位符明确拒绝', () => {
    const forged = makeSession({ id: 'brand-new' })
    forged.ssh = { host: 'example.com', port: 22, username: 'user', password: SECRET_PLACEHOLDER }
    expect(() => hydrateSessionSecrets(forged, null)).toThrow(SessionSecretError)
    expect(() => hydrateSessionSecrets(forged, null)).toThrow(/requires the original saved SSH credentials/)
    try {
      hydrateSessionSecrets(forged, null)
    } catch (error) {
      expect((error as SessionSecretError).code).toBe('placeholder_without_secret')
    }
  })

  it('改目标却沿用占位符必须拒绝（旧密钥不能发到新主机）', () => {
    const previous = makeSession({ id: 's1' })
    const changed = makeSession({
      id: 's1',
      ssh: { host: 'other.example.com', port: 22, username: 'user', password: SECRET_PLACEHOLDER }
    })
    try {
      hydrateSessionSecrets(changed, previous)
      throw new Error('expected target_changed')
    } catch (error) {
      expect((error as SessionSecretError).code).toBe('target_changed')
    }
  })

  it('改端口/用户名同样视为目标变化', () => {
    const previous = makeSession({ id: 's1' })
    const portChanged = makeSession({
      id: 's1',
      ssh: { host: 'example.com', port: 2222, username: 'user', password: SECRET_PLACEHOLDER }
    })
    expect(() => hydrateSessionSecrets(portChanged, previous)).toThrow(/target changed/)
    const userChanged = makeSession({
      id: 's1',
      ssh: { host: 'example.com', port: 22, username: 'root', password: SECRET_PLACEHOLDER }
    })
    expect(() => hydrateSessionSecrets(userChanged, previous)).toThrow(/target changed/)
  })

  it('locked 字段不回传明文，只报告需要重新输入', () => {
    const previous = makeSession({ id: 's1' })
    previous.ssh = { host: 'example.com', port: 22, username: 'user' }
    const incoming = makeSession({
      id: 's1',
      ssh: { host: 'example.com', port: 22, username: 'user', password: SECRET_PLACEHOLDER }
    })
    const { config, lockedSshFields } = hydrateSessionSecrets(incoming, previous, {
      lockedSshFields: ['password']
    })
    expect(config.ssh?.password).toBeUndefined()
    expect(lockedSshFields).toEqual(['password'])
  })

  it('local.env 占位符回填同记录原值；有引用但本次解析失败时保留占位符', () => {
    const previous = makeLocal({ PATH: '/usr/bin', API_TOKEN: 'token-value' }, { envSecretRefs: { API_TOKEN: REF_A } })
    const incoming = makeLocal({ PATH: '/usr/bin', API_TOKEN: SECRET_PLACEHOLDER }, { envSecretRefs: { API_TOKEN: REF_A } })
    const { config } = hydrateSessionSecrets(incoming, previous)
    expect(config.local?.env?.API_TOKEN).toBe('token-value')
    // 引用是仓储自己维护的元数据，hydrate 一律清掉，避免外部输入参与写盘规划
    expect(config.local?.envSecretRefs).toBeUndefined()

    const unresolvedPrevious = makeLocal({ PATH: '/usr/bin' }, { envSecretRefs: { API_TOKEN: REF_A } })
    const kept = hydrateSessionSecrets(incoming, unresolvedPrevious)
    expect(kept.config.local?.env?.API_TOKEN).toBe(SECRET_PLACEHOLDER)
  })

  it('local.env 伪造占位符（本记录没有对应值/引用）拒绝', () => {
    const previous = makeLocal({ PATH: '/usr/bin' })
    const incoming = makeLocal({ PATH: '/usr/bin', API_TOKEN: SECRET_PLACEHOLDER })
    try {
      hydrateSessionSecrets(incoming, previous)
      throw new Error('expected placeholder_without_secret')
    } catch (error) {
      expect((error as SessionSecretError).code).toBe('placeholder_without_secret')
    }
  })

  it('跨记录复制 local env 引用被拒绝', () => {
    const previous = makeLocal({ API_TOKEN: 'token-b' }, { envSecretRefs: { API_TOKEN: REF_B } })
    const copyFromOther = makeLocal(
      { API_TOKEN: SECRET_PLACEHOLDER },
      { envSecretRefs: { API_TOKEN: REF_A } }
    )
    expect(() => hydrateSessionSecrets(copyFromOther, previous)).toThrow(/cannot be copied between sessions/)
  })
})

describe('hasSameSshTarget / assertNoSecretPlaceholders', () => {
  it('引用解析全部失败仍显示秘密行，磁盘密文不能作为连接凭据', () => {
    const config = makeSession()
    config.local = { envSecretRefs: { API_TOKEN: REF_A } }
    expect(publicSessionConfig(config).local?.env?.API_TOKEN).toBe(SECRET_PLACEHOLDER)
    config.ssh = { host: 'fixture', port: 22, username: 'user', password: 'safe:v1:cipher' }
    expect(() => assertNoSecretPlaceholders(config)).toThrow(/ssh.password/)
    expect(() => hydrateSessionSecrets(config, config)).toThrow(/ciphertext/)
  })
  it('目标比较按 host + port + username', () => {
    const base = { host: 'example.com', port: 22, username: 'user' }
    expect(hasSameSshTarget(base, { ...base })).toBe(true)
    expect(hasSameSshTarget(base, { ...base, host: 'other' })).toBe(false)
    expect(hasSameSshTarget(base, { ...base, port: 2222 })).toBe(false)
    expect(hasSameSshTarget(base, { ...base, username: 'root' })).toBe(false)
    expect(hasSameSshTarget(undefined, base)).toBe(false)
  })

  it('残留占位符在连接/导出前必须抛错，且错误信息不含秘密', () => {
    const session = makeSession()
    session.ssh = { host: 'example.com', port: 22, username: 'user', password: SECRET_PLACEHOLDER }
    session.local = { env: { API_TOKEN: SECRET_PLACEHOLDER } }
    try {
      assertNoSecretPlaceholders(session)
      throw new Error('expected secret_unavailable')
    } catch (error) {
      expect((error as SessionSecretError).code).toBe('secret_unavailable')
      expect((error as Error).message).toContain('ssh.password')
      expect((error as Error).message).toContain('local.env.API_TOKEN')
      expect((error as Error).message).not.toContain('hunter2')
    }
  })

  it('没有占位符时通过', () => {
    expect(() => assertNoSecretPlaceholders(makeSession())).not.toThrow()
  })
})
