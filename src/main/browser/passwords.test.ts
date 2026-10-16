import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const mocks = vi.hoisted(() => ({ dir: '', available: true }))
vi.mock('electron', () => ({ safeStorage: {
  isEncryptionAvailable: () => mocks.available,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: (v: string) => Buffer.from(v).map(b => b ^ 0x4a),
  decryptString: (v: Buffer) => Buffer.from(v).map(b => b ^ 0x4a).toString()
} }))
vi.mock('../storage/repository', async () => ({
  getConfigDir: () => mocks.dir,
  atomicWriteFileSync: (file: string, text: string) => writeFileSync(file, text)
}))
import { BrowserPasswords } from './passwords'

describe('系统加密密码库', () => {
  beforeEach(() => { mocks.dir = mkdtempSync(join(tmpdir(), 'lyshell-password-test-')); mocks.available = true })
  afterEach(() => rmSync(mocks.dir, { recursive: true, force: true }))
  it('只落加密密码，列表不返回密文或明文，填充严格匹配 origin', () => {
    const vault = new BrowserPasswords()
    vault.save('https://example.com/login', 'alice', 'secret-password-123')
    const disk = readFileSync(join(mocks.dir, 'browser-passwords.json'), 'utf8')
    expect(disk).not.toContain('secret-password-123')
    expect(vault.list()[0]).toEqual({ id: expect.any(String), origin: 'https://example.com', username: 'alice', updatedAt: expect.any(Number) })
    expect(vault.find('https://example.com')).toEqual({ username: 'alice', password: 'secret-password-123' })
    expect(vault.find('http://example.com')).toBeNull()
    expect(vault.find('https://example.com:8443')).toBeNull()
    expect(vault.find('https://example.com.evil.test')).toBeNull()
  })
  it('同站点同用户更新保留 ID，其他用户独立，支持逐条删除', () => {
    const vault = new BrowserPasswords()
    vault.save('https://example.com', 'alice', 'first')
    const id = vault.list()[0].id
    vault.save('https://example.com', 'alice', 'updated')
    vault.save('https://example.com', 'bob', 'second')
    expect(vault.list()).toHaveLength(2)
    expect(vault.list().find(v => v.username === 'alice')?.id).toBe(id)
    vault.delete(id)
    expect(vault.list().map(v => v.username)).toEqual(['bob'])
  })
  it('系统密钥不可用时禁止写入且不返回密码', () => {
    mocks.available = false
    const vault = new BrowserPasswords()
    expect(() => vault.save('https://example.com', 'alice', 'secret')).toThrow('encryption')
    expect(existsSync(join(mocks.dir, 'browser-passwords.json'))).toBe(false)
    expect(vault.find('https://example.com')).toBeNull()
  })
  it('拒绝非法 origin、空密码，损坏文件不能被新保存覆盖', () => {
    const vault = new BrowserPasswords()
    expect(() => vault.save('javascript:alert(1)', 'a', 'b')).toThrow()
    expect(() => vault.save('https://example.com', 'a', '')).toThrow()
    writeFileSync(join(mocks.dir, 'browser-passwords.json'), '{broken')
    expect(() => vault.save('https://example.com', 'a', 'b')).toThrow()
    expect(readFileSync(join(mocks.dir, 'browser-passwords.json'), 'utf8')).toBe('{broken')
  })
  it('达到文件容量时拒绝新增，已有密码仍可读取和删除', () => {
    const vault = new BrowserPasswords()
    const path = join(mocks.dir, 'browser-passwords.json')
    const items = Array.from({ length: 999 }, (_, i) => ({
      id: String(i), origin: 'https://example.com', username: String(i),
      encrypted: 'A'.repeat(8290), updatedAt: i
    }))
    // 有效条目数尚未到上限，磁盘文件距读取上限只剩几 KB。
    writeFileSync(path, JSON.stringify(items))
    const before = readFileSync(path, 'utf8')
    expect(before.length).toBeLessThan(8 * 1024 * 1024)
    expect(() => vault.save('https://example.com', 'new', '密'.repeat(4096))).toThrow('full')
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(vault.list()).toHaveLength(999)
    vault.delete('0')
    expect(vault.list()).toHaveLength(998)
  })
})
