import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'

const env = vi.hoisted(() => {
  const values = new Map<string, string>()
  return {
    dir: '',
    available: true,
    failDecrypt: false,
    values,
    reset() {
      this.available = true
      this.failDecrypt = false
      this.values.clear()
    }
  }
})

vi.mock('electron-log', () => ({ default: { info: () => {}, error: () => {}, warn: () => {} } }))
vi.mock('electron', () => ({
  app: { getPath: () => env.dir },
  safeStorage: {
    isEncryptionAvailable: () => env.available,
    encryptString: (plain: string) => {
      const cipher = Buffer.from(Buffer.from(plain, 'utf8').map(byte => byte ^ 0x5a))
      env.values.set(cipher.toString('base64'), plain)
      return cipher
    },
    decryptString: (cipher: Buffer) => {
      if (env.failDecrypt) throw new Error('simulated decrypt failure')
      const plain = env.values.get(Buffer.from(cipher).toString('base64'))
      if (plain === undefined) throw new Error('unknown ciphertext')
      return plain
    }
  }
}))

import { SessionRepository } from './repository'
import { ConnectionType, type SessionConfig } from '@shared/types'
import { SECRET_PLACEHOLDER } from '@shared/harness'

const session = (id: string): SessionConfig =>
  ({
    id,
    name: 'secret-holder',
    type: ConnectionType.SSH,
    ssh: { host: 'example.com', port: 22, username: 'user', password: 'hunter2', privateKey: 'PRIVATE-KEY', passphrase: 'phrase' },
    terminal: { fontSize: 14, encoding: 'utf-8' },
    tags: [],
    createdAt: new Date(),
    updatedAt: new Date()
  }) as unknown as SessionConfig

const sessionsPath = () => join(env.dir, 'config', 'sessions.json')
// getConfigDir 在模块内缓存，因此整个文件复用一个 userData 目录，每个用例只清理内容。
env.dir = join(tmpdir(), `lyshell-secrets-${process.pid}-${Math.random().toString(16).slice(2)}`)

beforeEach(() => {
  env.reset()
  rmSync(env.dir, { recursive: true, force: true })
  mkdirSync(join(env.dir, 'config'), { recursive: true })
})

afterEach(() => {
  rmSync(env.dir, { recursive: true, force: true })
})

describe('SessionRepository 安全存储失败时保留密文', () => {
  it('锁定凭据可明确清空，目标变化不能悄悄携带旧密文', () => {
    new SessionRepository().saveSession(session('locked-clear'))
    env.available = false
    const repo = new SessionRepository()
    const config = repo.get('locked-clear')!
    expect(() => repo.updateSession({ ...config, ssh: { ...config.ssh!, host: 'other.test' } })).toThrow(/SSH target changed/)
    repo.updateSession({ ...config, ssh: { ...config.ssh!, password: '', privateKey: '', passphrase: '' } })
    const stored = JSON.parse(readFileSync(sessionsPath(), 'utf8'))[0]
    expect(stored.ssh.password).toBeUndefined()
    env.available = true
    expect(new SessionRepository().get('locked-clear')?.ssh?.privateKey).toBeUndefined()
  })

  it('安全存储不可用时读取不丢密文，改名保存后密文与备份仍是原密文', () => {
    new SessionRepository().saveSession(session('ssh-secret'))
    const ciphertext = JSON.parse(readFileSync(sessionsPath(), 'utf8'))[0].ssh.password as string
    expect(ciphertext).not.toContain('hunter2')
    expect(readFileSync(`${sessionsPath()}.bak`, 'utf8')).not.toContain('hunter2')

    env.available = false
    const offline = new SessionRepository()
    const loaded = offline.get('ssh-secret')!
    expect(loaded.ssh?.password).toBeUndefined()
    offline.updateSession({ ...loaded, name: 'renamed-while-offline' })

    const onDisk = readFileSync(sessionsPath(), 'utf8')
    expect(onDisk).not.toContain('hunter2')
    expect(JSON.parse(onDisk)[0].ssh.password).toBe(ciphertext)
    expect(JSON.parse(onDisk)[0].name).toBe('renamed-while-offline')
    expect(readFileSync(`${sessionsPath()}.bak`, 'utf8')).not.toContain('hunter2')
    expect(JSON.parse(readFileSync(`${sessionsPath()}.bak`, 'utf8'))[0].ssh.password).toBe(ciphertext)

    env.available = true
    expect(new SessionRepository().get('ssh-secret')?.ssh?.password).toBe('hunter2')
  })

  it('解密抛错与不可用同等处理：保留密文而不是清空', () => {
    new SessionRepository().saveSession(session('ssh-secret'))
    const ciphertext = JSON.parse(readFileSync(sessionsPath(), 'utf8'))[0].ssh.password as string

    env.failDecrypt = true
    const repo = new SessionRepository()
    expect(repo.get('ssh-secret')?.ssh?.password).toBeUndefined()
    repo.updateSession({ ...repo.get('ssh-secret')!, name: 'renamed-after-failure' })
    env.failDecrypt = false

    expect(JSON.parse(readFileSync(sessionsPath(), 'utf8'))[0].ssh.password).toBe(ciphertext)
    env.available = true
    expect(new SessionRepository().get('ssh-secret')?.ssh?.password).toBe('hunter2')
  })

  it('安全存储不可用时删除 SSH 块会拒绝保存，磁盘密文和备份保持完整', () => {
    new SessionRepository().saveSession(session('ssh-secret'))
    const before = readFileSync(sessionsPath(), 'utf8')
    const beforeBackup = readFileSync(`${sessionsPath()}.bak`, 'utf8')

    env.available = false
    const repo = new SessionRepository()
    const loaded = repo.get('ssh-secret')!
    const withoutSsh = { ...loaded }
    delete withoutSsh.ssh
    expect(() => repo.updateSession(withoutSsh)).toThrow(/安全存储不可用/)
    expect(readFileSync(sessionsPath(), 'utf8')).toBe(before)
    expect(readFileSync(`${sessionsPath()}.bak`, 'utf8')).toBe(beforeBackup)
  })

  it('新建含明文 SSH 秘密的会话在安全存储不可用时拒绝写入且不留明文', () => {
    env.available = false
    const repo = new SessionRepository()
    expect(() => repo.saveSession(session('new-secret'))).toThrow(/安全存储不可用/)
    if (existsSync(sessionsPath())) expect(readFileSync(sessionsPath(), 'utf8')).not.toContain('hunter2')
  })

  it('getPublic 只给占位符与存在状态，不回传密码/私钥/口令', () => {
    const repo = new SessionRepository()
    repo.saveSession(session('ssh-public'))
    const loaded = new SessionRepository()
    const pub = loaded.getPublic('ssh-public')!

    expect(pub.ssh?.password).toBe(SECRET_PLACEHOLDER)
    expect(pub.ssh?.privateKey).toBe(SECRET_PLACEHOLDER)
    expect(pub.ssh?.passphrase).toBe(SECRET_PLACEHOLDER)
    expect(pub.sshSecrets).toEqual({
      password: { present: true },
      privateKey: { present: true },
      passphrase: { present: true }
    })
    // DTO 里不能出现任何真实秘密或 safe:v1 密文
    const serialized = JSON.stringify([pub, ...loaded.getAllPublic()])
    expect(serialized).not.toContain('hunter2')
    expect(serialized).not.toContain('PRIVATE-KEY')
    expect(serialized).not.toContain('safe:v1:')
  })

  it('安全存储不可用时 getPublic 把仍有密文的字段标记 locked，占位符改名保存不丢密文', () => {
    new SessionRepository().saveSession(session('ssh-locked'))
    const ciphertext = JSON.parse(readFileSync(sessionsPath(), 'utf8'))[0].ssh.password as string

    env.available = false
    const offline = new SessionRepository()
    const pub = offline.getPublic('ssh-locked')!
    // 解不出来的字段不回传密文，只给「存在但锁定」
    expect(pub.ssh?.password).toBeUndefined()
    expect(pub.sshSecrets?.password).toEqual({ present: true, locked: true })
    expect(JSON.stringify(pub)).not.toContain(ciphertext)

    // UI 发回占位符表示「保持原密码」：locked 字段不返回明文，写盘时由 protectedSecrets 写回原密文
    offline.updateSession({
      ...pub,
      name: 'renamed-via-placeholder',
      ssh: { ...pub.ssh!, password: SECRET_PLACEHOLDER }
    })

    const onDisk = JSON.parse(readFileSync(sessionsPath(), 'utf8'))[0]
    expect(onDisk.name).toBe('renamed-via-placeholder')
    expect(onDisk.ssh.password).toBe(ciphertext)
    expect(readFileSync(sessionsPath(), 'utf8')).not.toContain('hunter2')
  })

  it('改 SSH 目标却沿用占位符必须拒绝，旧密码不会发到新主机', () => {
    new SessionRepository().saveSession(session('ssh-retarget'))
    const repo = new SessionRepository()
    const pub = repo.getPublic('ssh-retarget')!
    const before = readFileSync(sessionsPath(), 'utf8')

    expect(() =>
      repo.saveSession({
        ...pub,
        ssh: {
          ...pub.ssh!,
          host: 'evil.example.com',
          password: SECRET_PLACEHOLDER
        }
      })
    ).toThrow(/SSH target changed/)
    expect(readFileSync(sessionsPath(), 'utf8')).toBe(before)
  })
})
