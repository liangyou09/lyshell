import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SshHostKeyError,
  computeSshHostKeyFingerprint,
  type SshHostKeyChallenge
} from './ssh-host-key'
import {
  SshTrustStore,
  authorizeSshHostKey,
  resolveTransferHostKey
} from './ssh-trust'

/** 最小 SSH wire-format 公钥 */
const wireHostKey = (material: string): Buffer => {
  const name = Buffer.from('ssh-ed25519')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(name.length, 0)
  return Buffer.concat([length, name, Buffer.from(material)])
}
const keyA = wireHostKey('key-a')
const keyB = wireHostKey('key-b')
const fpA = computeSshHostKeyFingerprint(keyA)
const fpB = computeSshHostKeyFingerprint(keyB)

let dir: string
let filePath: string
let store: SshTrustStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lyshell-ssh-trust-'))
  filePath = join(dir, 'ssh-trusted-hosts.json')
  store = new SshTrustStore({ filePath })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const expectCode = (error: unknown, code: string): void => {
  expect(error).toBeInstanceOf(SshHostKeyError)
  expect((error as SshHostKeyError).code).toBe(code)
}

describe('SshTrustStore 持久化', () => {
  it('写入走同目录临时文件 + rename，成功后落盘且不留 .tmp', () => {
    const record = store.trust({ host: 'Example.COM', port: 2222, fingerprint: fpA, algorithm: 'ssh-ed25519' })
    expect(record).toMatchObject({
      schemaVersion: 1,
      endpoint: 'example.com:2222',
      host: 'example.com',
      port: 2222,
      algorithm: 'ssh-ed25519',
      fingerprint: fpA
    })
    const persisted = JSON.parse(readFileSync(filePath, 'utf-8')) as {
      schemaVersion: number
      records: Array<Record<string, unknown>>
    }
    expect(persisted.schemaVersion).toBe(1)
    expect(persisted.records).toHaveLength(1)
    expect(persisted.records[0]).toMatchObject({ endpoint: 'example.com:2222', fingerprint: fpA })
    expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('记录里只有身份信息，不含任何凭据字段', () => {
    const record = store.trust({ host: 'example.com', port: 22, fingerprint: fpA, algorithm: 'ssh-ed25519' })
    for (const forbidden of ['password', 'privateKey', 'passphrase', 'token']) {
      expect(Object.keys(record)).not.toContain(forbidden)
    }
  })

  it('查询按规范化 endpoint 命中，删除后写入空列表', () => {
    store.trust({ host: 'Example.COM', port: 22, fingerprint: fpA, algorithm: 'ssh-ed25519' })
    expect(store.get('example.com')?.fingerprint).toBe(fpA)
    expect(store.get('example.com', 22)?.endpoint).toBe('example.com:22')
    expect(store.get('example.com', 2222)).toBeNull()
    expect(store.list()).toHaveLength(1)
    expect(store.delete('EXAMPLE.com', 22)).toBe(true)
    expect(store.delete('example.com', 22)).toBe(false)
    expect(store.list()).toEqual([])
    const persisted = JSON.parse(readFileSync(filePath, 'utf-8')) as { records: unknown[] }
    expect(persisted.records).toEqual([])
  })

  it('替换时保留 trustedAt、只更新 updatedAt', () => {
    let clock = new Date('2024-01-01T00:00:00.000Z')
    const timed = new SshTrustStore({ filePath, now: () => clock })
    const first = timed.trust({ host: 'example.com', port: 22, fingerprint: fpA, algorithm: 'ssh-ed25519' })
    clock = new Date('2024-02-02T00:00:00.000Z')
    const second = timed.trust({ host: 'example.com', port: 22, fingerprint: fpB, algorithm: 'ssh-ed25519' })
    expect(second.trustedAt).toBe(first.trustedAt)
    expect(second.updatedAt).not.toBe(first.updatedAt)
    expect(second.fingerprint).toBe(fpB)
  })

  it('指纹格式非法时拒绝写入且不落盘', () => {
    for (const fingerprint of ['', 'SHA256:short', 'md5:aa:bb', 'SHA256:' + 'A'.repeat(42)]) {
      try {
        store.trust({ host: 'example.com', port: 22, fingerprint, algorithm: 'ssh-ed25519' })
        throw new Error('应当拒绝')
      } catch (error) {
        expectCode(error, 'SSH_HOST_KEY_INVALID')
      }
    }
    expect(existsSync(filePath)).toBe(false)
  })

  it('文件损坏时拒绝一切读写（不会静默丢弃后重新信任）', () => {
    writeFileSync(filePath, '{"schemaVersion":2,"records":[]}', 'utf-8')
    expect(store.getStatus().corrupt).toBe(true)
    expect(store.getStatus().message).toContain('schemaVersion')
    expect(() => store.list()).toThrowError(SshHostKeyError)
    expect(() => store.get('example.com', 22)).toThrowError(SshHostKeyError)
    expect(() => store.trust({ host: 'example.com', port: 22, fingerprint: fpA, algorithm: 'ssh-ed25519' })).toThrowError(SshHostKeyError)
    expect(() => store.delete('example.com', 22)).toThrowError(SshHostKeyError)
    try {
      store.list()
    } catch (error) {
      expectCode(error, 'SSH_HOST_KEY_STORE_CORRUPT')
      expect((error as Error).message).toContain('不会自动信任任何主机')
    }
    // 损坏文件内容保持原样，未被覆盖成空列表
    expect(readFileSync(filePath, 'utf-8')).toContain('"schemaVersion":2')
  })

  it('读取失败（路径不可读）同样按损坏处理', () => {
    const blocked = join(dir, 'as-directory.json')
    mkdirSync(blocked)
    const unreadable = new SshTrustStore({ filePath: blocked })
    expect(unreadable.getStatus().corrupt).toBe(true)
    expect(() => unreadable.list()).toThrowError(SshHostKeyError)
  })

  it('保存失败抛 SAVE_FAILED 且内存不更新', () => {
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'not-a-directory', 'utf-8')
    const broken = new SshTrustStore({ filePath: join(blocker, 'nested', 'ssh-trusted-hosts.json') })
    try {
      broken.trust({ host: 'example.com', port: 22, fingerprint: fpA, algorithm: 'ssh-ed25519' })
      throw new Error('应当拒绝')
    } catch (error) {
      expectCode(error, 'SSH_HOST_KEY_SAVE_FAILED')
      expect((error as Error).message).toContain('本次连接不会被记忆为可信')
    }
    expect(broken.list()).toEqual([])
  })

  it('reload 丢弃缓存后重新读盘', () => {
    store.trust({ host: 'example.com', port: 22, fingerprint: fpA, algorithm: 'ssh-ed25519' })
    writeFileSync(filePath, JSON.stringify({
      schemaVersion: 1,
      records: [{
        schemaVersion: 1,
        endpoint: 'example.com:22',
        host: 'example.com',
        port: 22,
        algorithm: 'ssh-ed25519',
        fingerprint: fpB,
        trustedAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z'
      }]
    }), 'utf-8')
    expect(store.get('example.com')?.fingerprint).toBe(fpA)
    store.reload()
    expect(store.get('example.com')?.fingerprint).toBe(fpB)
  })
})

describe('authorizeSshHostKey', () => {
  it('未知主机且没有确认回调 → 明确拒绝，且不会首次即信任', async () => {
    await expect(authorizeSshHostKey(keyA, 'Example.COM', 22, { store })).rejects.toMatchObject({
      code: 'SSH_HOST_KEY_UNKNOWN'
    })
    await expect(authorizeSshHostKey(keyA, 'example.com', 22, { store })).rejects.toThrowError(/需人工确认/)
    expect(store.list()).toEqual([])
    expect(existsSync(filePath)).toBe(false)
  })

  it('人工确认后先保存再返回，第二次直接命中可信记录（不再询问）', async () => {
    const confirm = vi.fn(async (challenge: SshHostKeyChallenge) => {
      expect(challenge).toMatchObject({
        host: 'example.com',
        port: 22,
        endpoint: 'example.com:22',
        algorithm: 'ssh-ed25519',
        fingerprint: fpA,
        changed: false
      })
      expect(challenge.previousFingerprint).toBeUndefined()
      return true
    })
    const record = await authorizeSshHostKey(keyA, 'example.com', 22, { store, confirm })
    expect(record.fingerprint).toBe(fpA)
    expect(existsSync(filePath)).toBe(true)
    expect(store.get('example.com', 22)?.fingerprint).toBe(fpA)

    const secondConfirm = vi.fn(async () => true)
    const again = await authorizeSshHostKey(keyA, 'example.com', 22, { store, confirm: secondConfirm })
    expect(again.fingerprint).toBe(fpA)
    expect(secondConfirm).not.toHaveBeenCalled()
  })

  it('确认被拒绝 / 抛错 / 超时 → REJECTED 且不保存', async () => {
    const cases: Array<() => Promise<boolean>> = [
      async () => false,
      async () => { throw new Error('user closed dialog') },
      () => new Promise<boolean>(() => {})
    ]
    for (const confirm of cases) {
      await expect(
        authorizeSshHostKey(keyA, 'example.com', 22, { store, confirm, confirmTimeoutMs: 10 })
      ).rejects.toMatchObject({ code: 'SSH_HOST_KEY_REJECTED' })
      expect(store.list()).toEqual([])
      expect(existsSync(filePath)).toBe(false)
    }
  })

  it('确认期间连接已关闭/取消 → 晚到的确认作废，不写记录', async () => {
    let active = true
    const confirm = vi.fn(async () => {
      active = false
      return true
    })
    await expect(
      authorizeSshHostKey(keyA, 'example.com', 22, { store, confirm, isActive: () => active })
    ).rejects.toThrowError(/作废/)
    expect(store.list()).toEqual([])
    expect(existsSync(filePath)).toBe(false)
  })

  it('密钥变化且无确认 → CHANGED，带双方指纹，旧记录保持', async () => {
    store.trust({ host: 'example.com', port: 22, fingerprint: fpA, algorithm: 'ssh-ed25519' })
    try {
      await authorizeSshHostKey(keyB, 'example.com', 22, { store })
      throw new Error('应当拒绝')
    } catch (error) {
      const typed = error as SshHostKeyError
      expect(typed.code).toBe('SSH_HOST_KEY_CHANGED')
      expect(typed.fingerprint).toBe(fpB)
      expect(typed.previousFingerprint).toBe(fpA)
      expect(typed.message).toContain('需人工确认后更新可信记录')
    }
    expect(store.get('example.com', 22)?.fingerprint).toBe(fpA)
  })

  it('密钥变化经人工确认后替换记录（challenge 标注 changed 与旧指纹）', async () => {
    store.trust({ host: 'example.com', port: 22, fingerprint: fpA, algorithm: 'ssh-ed25519' })
    const seen: SshHostKeyChallenge[] = []
    const record = await authorizeSshHostKey(keyB, 'example.com', 22, {
      store,
      confirm: async (challenge) => {
        seen.push(challenge)
        return true
      }
    })
    expect(seen[0]).toMatchObject({ changed: true, fingerprint: fpB, previousFingerprint: fpA })
    expect(record.fingerprint).toBe(fpB)
    expect(store.get('example.com', 22)?.fingerprint).toBe(fpB)
  })

  it('确认通过但保存失败 → SAVE_FAILED，连接不得放行', async () => {
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'not-a-directory', 'utf-8')
    const broken = new SshTrustStore({ filePath: join(blocker, 'nested', 'ssh-trusted-hosts.json') })
    await expect(
      authorizeSshHostKey(keyA, 'example.com', 22, { store: broken, confirm: async () => true })
    ).rejects.toMatchObject({ code: 'SSH_HOST_KEY_SAVE_FAILED' })
    expect(broken.list()).toEqual([])
  })

  it('记录损坏时即便有人工确认也拒绝（不能靠一次确认覆盖损坏文件）', async () => {
    writeFileSync(filePath, 'not json at all', 'utf-8')
    await expect(
      authorizeSshHostKey(keyA, 'example.com', 22, { store, confirm: async () => true })
    ).rejects.toMatchObject({ code: 'SSH_HOST_KEY_STORE_CORRUPT' })
    expect(readFileSync(filePath, 'utf-8')).toBe('not json at all')
  })
})

describe('resolveTransferHostKey', () => {
  it('没有可信记录 → UNKNOWN，提示先在终端确认', () => {
    try {
      resolveTransferHostKey({ host: 'Example.COM', port: 22 }, store)
      throw new Error('应当拒绝')
    } catch (error) {
      expectCode(error, 'SSH_HOST_KEY_UNKNOWN')
      expect((error as Error).message).toContain('example.com:22')
      expect((error as Error).message).toContain('请先在终端连接该主机并确认指纹')
    }
  })

  it('已受信任 → 返回规范化 endpoint 与固定指纹', () => {
    store.trust({ host: 'Example.COM', port: 2222, fingerprint: fpA, algorithm: 'ssh-ed25519' })
    expect(resolveTransferHostKey({ host: 'example.com', port: 2222 }, store)).toEqual({
      endpoint: 'example.com:2222',
      fingerprint: fpA
    })
  })

  it('记录损坏 → STORE_CORRUPT（不会退化成「无记录」）', () => {
    writeFileSync(filePath, '{"schemaVersion":1,"records":[{}]}', 'utf-8')
    try {
      resolveTransferHostKey({ host: 'example.com', port: 22 }, store)
      throw new Error('应当拒绝')
    } catch (error) {
      expectCode(error, 'SSH_HOST_KEY_STORE_CORRUPT')
    }
  })
})
