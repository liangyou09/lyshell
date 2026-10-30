import { describe, expect, it } from 'vitest'
import { isStrongSecureStorage } from './secure-storage'

describe('OS 秘密存储强度', () => {
  it('Linux basic_text 即使 available 也拒绝，真实密钥环可用', () => {
    const storage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text' }
    expect(isStrongSecureStorage(storage, 'linux')).toBe(false)
    expect(isStrongSecureStorage({ ...storage, getSelectedStorageBackend: () => 'gnome_libsecret' }, 'linux')).toBe(true)
    expect(isStrongSecureStorage(storage, 'win32')).toBe(true)
  })
  it('不可用、缺失和后端查询失败均拒绝', () => {
    expect(isStrongSecureStorage(undefined)).toBe(false)
    expect(isStrongSecureStorage({ isEncryptionAvailable: () => false })).toBe(false)
    expect(isStrongSecureStorage({ isEncryptionAvailable: () => { throw new Error('locked') } })).toBe(false)
    expect(isStrongSecureStorage({ isEncryptionAvailable: () => true, getSelectedStorageBackend: () => { throw new Error('locked') } }, 'linux')).toBe(false)
  })
})
