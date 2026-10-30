import { describe, it, expect, beforeEach, vi } from 'vitest'
import { tmpdir } from 'os'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'

// electron-log / electron 在 Node 测试环境不存在；本套用例全部注入 cipher，不碰 safeStorage
vi.mock('electron-log', () => ({
  default: { info: () => {}, error: () => {}, warn: () => {} }
}))
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() }
}))

import { SecretStore, SecretStoreError, isSecretRef, assertResolvedSecrets } from './secret-store'
import { SECRET_PLACEHOLDER } from '@shared/harness'
import { createTestCipher, resetSecretFiles, secretTestPath } from './secret-store.test-support'

const vaultPath = secretTestPath('secret-store-unit.json')

function newStore(options: { available?: boolean; maxEntries?: number } = {}): SecretStore {
  return new SecretStore({
    filePath: vaultPath,
    cipher: createTestCipher({ available: options.available }),
    ...(options.maxEntries !== undefined ? { maxEntries: options.maxEntries } : {})
  })
}

function readVault(): { version: number; entries: Record<string, { ciphertext: string }> } {
  return JSON.parse(readFileSync(vaultPath, 'utf-8'))
}

beforeEach(() => {
  resetSecretFiles(vaultPath)
  rmSync(vaultPath, { recursive: true, force: true })
})

it('启动时缺失/占位符秘密必须失败，正常解析的快照可用', () => {
  const envSecretRefs = { TOKEN: 'sec_' + 'a'.repeat(32) }
  expect(() => assertResolvedSecrets({ envSecretRefs, env: {} })).toThrow(SecretStoreError)
  expect(() => assertResolvedSecrets({ envSecretRefs, env: { TOKEN: SECRET_PLACEHOLDER } })).toThrow(SecretStoreError)
  expect(() => assertResolvedSecrets({ apiKeyRef: envSecretRefs.TOKEN })).toThrow(SecretStoreError)
  expect(() => assertResolvedSecrets({ envSecretRefs, env: { TOKEN: 'fixture-resolved' } })).not.toThrow()
})

describe('SecretStore 基本读写', () => {
  it('put 返回随机 ref，磁盘只保存密文，resolve 可还原', () => {
    const store = newStore()
    const secret = 'sk-test-secret-value-123'
    const ref = store.put(secret)

    expect(isSecretRef(ref)).toBe(true)
    const raw = readVault()
    expect(raw.version).toBe(1)
    expect(Object.keys(raw.entries)).toEqual([ref])
    expect(raw.entries[ref].ciphertext.length).toBeGreaterThan(0)
    // 磁盘（主文件与备份）都不含明文
    expect(readFileSync(vaultPath, 'utf-8')).not.toContain(secret)
    expect(readFileSync(`${vaultPath}.bak`, 'utf-8')).not.toContain(secret)

    expect(store.resolve(ref)).toEqual({ ok: true, value: secret })
    expect(store.status()).toMatchObject({ available: true, entries: 1, corrupt: false })
  })

  it('每次 put 生成不同 ref，互不覆盖', () => {
    const store = newStore()
    const a = store.put('secret-a')
    const b = store.put('secret-b')
    expect(a).not.toBe(b)
    expect(store.resolve(a)).toEqual({ ok: true, value: 'secret-a' })
    expect(store.resolve(b)).toEqual({ ok: true, value: 'secret-b' })
  })

  it('resolve 对非法/缺失 ref 返回明确原因', () => {
    const store = newStore()
    expect(store.resolve('not-a-ref')).toEqual({ ok: false, reason: 'invalid_ref' })
    expect(store.resolve('sec_00000000000000000000000000000000')).toEqual({ ok: false, reason: 'not_found' })
  })

  it('delete 幂等，删除后 resolve 为 not_found 且释放容量', () => {
    const store = newStore({ maxEntries: 1 })
    const ref = store.put('only-secret')
    expect(store.delete(ref)).toBe(true)
    expect(store.resolve(ref)).toEqual({ ok: false, reason: 'not_found' })
    expect(store.delete(ref)).toBe(true)
    // 容量已释放，可再写入
    expect(isSecretRef(store.put('another'))).toBe(true)
    expect(store.status().entries).toBe(1)
  })

  it('空值/超长值被拒绝，错误信息不含秘密', () => {
    const store = newStore()
    expect(() => store.put('')).toThrowError(SecretStoreError)
    expect(() => store.put(('x'.repeat(65537)))).toThrowError(/maximum length/)
    try {
      store.put('')
    } catch (error) {
      expect((error as Error).message).not.toContain('sk-')
    }
  })

  it('达到容量上限后 put 明确失败，已有条目不受影响', () => {
    const store = newStore({ maxEntries: 2 })
    const first = store.put('one')
    store.put('two')
    expect(() => store.put('three')).toThrowError(/capacity/)
    expect(store.resolve(first)).toEqual({ ok: true, value: 'one' })
    expect(store.status().entries).toBe(2)
  })
})

describe('SecretStore 平台不可用', () => {
  it('安全存储不可用时 put 明确失败且不写明文', () => {
    const store = newStore({ available: false })
    expect(store.status()).toMatchObject({ available: false, reason: 'unavailable' })
    expect(() => store.put('sk-should-not-be-stored')).toThrowError(/not available/)
    expect(existsSync(vaultPath)).toBe(false)
  })

  it('Linux basic_text 弱后端按不可用处理（写入与读取都失败）', () => {
    // 先造一条正常条目，再用弱后端实例读取同一文件
    const normal = newStore()
    const ref = normal.put('linux-secret')

    const weak = new SecretStore({
      filePath: vaultPath,
      cipher: createTestCipher({ backend: 'basic_text' }),
      platform: 'linux'
    })
    expect(weak.status()).toMatchObject({ available: false, weak: true, backend: 'basic_text', reason: 'basic_text' })
    expect(() => weak.put('nope')).toThrowError(/basic_text/)
    expect(weak.resolve(ref)).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('解密失败返回 decrypt_failed，不返回值也不抛错', () => {
    const normal = newStore()
    const ref = normal.put('will-be-tampered')

    const broken = new SecretStore({
      filePath: vaultPath,
      cipher: {
        isEncryptionAvailable: () => true,
        encryptString: () => Buffer.from('x'),
        decryptString: () => {
          throw new Error('bad key')
        },
        getSelectedStorageBackend: () => 'test_backend'
      }
    })
    expect(broken.resolve(ref)).toEqual({ ok: false, reason: 'decrypt_failed' })
  })
})

describe('SecretStore 损坏保护', () => {
  it('非法 JSON fail closed：读失败、写拒绝、原件保留', () => {
    const damaged = '{"version":1,"entries":' // 截断
    writeFileSync(vaultPath, damaged, 'utf-8')
    const store = newStore()

    expect(store.status()).toMatchObject({ corrupt: true, available: false, entries: 0, reason: 'corrupt' })
    expect(store.resolve('sec_00000000000000000000000000000000')).toEqual({ ok: false, reason: 'corrupt' })
    expect(() => store.put('secret')).toThrowError(/damaged/)
    expect(readFileSync(vaultPath, 'utf-8')).toBe(damaged)
  })

  it('未知 version 同样 fail closed，不尝试覆盖', () => {
    writeFileSync(vaultPath, JSON.stringify({ version: 2, entries: {} }), 'utf-8')
    const store = newStore()
    expect(store.status().corrupt).toBe(true)
    expect(() => store.put('secret')).toThrowError(/damaged/)
  })

  it('畸形条目使整个 vault 只读，后续保存不能抹掉原密文', () => {
    const store = newStore()
    const good = store.put('good-secret')
    const raw = readVault()
    raw.entries['sec_11111111111111111111111111111111'] = { ciphertext: '' } as never
    raw.entries['bad-ref'] = { ciphertext: 'abc' } as never
    writeFileSync(vaultPath, JSON.stringify(raw), 'utf-8')
    const before = readFileSync(vaultPath, 'utf-8')

    const reread = newStore()
    expect(reread.status()).toMatchObject({ corrupt: true, entries: 0 })
    expect(reread.resolve(good)).toEqual({ ok: false, reason: 'corrupt' })
    expect(() => reread.put('replacement')).toThrow(/damaged/)
    expect(readFileSync(vaultPath, 'utf-8')).toBe(before)
  })

  it('写入失败（路径被目录占用）不更新内存，也不留半条记录', () => {
    const store = newStore()
    expect(store.status().entries).toBe(0)
    mkdirSync(vaultPath, { recursive: true })
    expect(() => store.put('secret')).toThrowError(/failed to write/)
    expect(store.status().entries).toBe(0)
  })
})
