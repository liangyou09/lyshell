import { safeStorage } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { atomicWriteFileSync, getConfigDir } from '../storage/repository'
import { browserOrigin, type BrowserPasswordInfo } from '@shared/browser-settings'

interface StoredPassword extends BrowserPasswordInfo { encrypted: string }
const MAX_STORAGE_CHARS = 8 * 1024 * 1024

/** 浏览器密码独立存放，不参与普通配置导出；系统密钥不可用时禁止明文回退。 */
export class BrowserPasswords {
  private path(): string { return join(getConfigDir(), 'browser-passwords.json') }
  available(): boolean {
    return safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text')
  }
  private read(): StoredPassword[] {
    const path = this.path()
    if (!existsSync(path)) return []
    const text = readFileSync(path, 'utf8')
    if (text.length > MAX_STORAGE_CHARS) throw new Error('Password storage is too large')
    const items: unknown = JSON.parse(text)
    if (!Array.isArray(items) || items.length > 1000) throw new Error('Invalid password storage')
    const valid = (v: unknown): v is StoredPassword => {
      if (!v || typeof v !== 'object') return false
      const item = v as Record<string, unknown>
      return typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 128 &&
        typeof item.origin === 'string' && browserOrigin(item.origin) === item.origin &&
        typeof item.username === 'string' && item.username.length <= 1024 &&
        typeof item.encrypted === 'string' && item.encrypted.length > 0 && item.encrypted.length <= 32768 &&
        typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt)
    }
    if (!items.every(valid)) throw new Error('Invalid password storage')
    return items
  }
  list(): BrowserPasswordInfo[] {
    return this.read().map(({ id, origin, username, updatedAt }) => ({ id, origin, username, updatedAt }))
  }
  save(origin: string, username: string, password: string): void {
    if (!this.available()) throw new Error('System password encryption is unavailable')
    const normalized = browserOrigin(origin)
    if (!normalized || typeof username !== 'string' || username.length > 1024 || typeof password !== 'string' || !password || password.length > 4096) throw new Error('Invalid password entry')
    const items = this.read()
    const old = items.find(p => p.origin === normalized && p.username === username)
    if (!old && items.length >= 1000) throw new Error('Password storage is full')
    const item: StoredPassword = { id: old?.id ?? randomUUID(), origin: normalized, username, encrypted: safeStorage.encryptString(password).toString('base64'), updatedAt: Date.now() }
    const text = JSON.stringify([...items.filter(p => p.id !== item.id), item])
    // 写入边界必须与读取一致；仅限制条目数仍可能写出无法再次读取的密码库。
    if (text.length > MAX_STORAGE_CHARS) throw new Error('Password storage is full')
    atomicWriteFileSync(this.path(), text)
  }
  delete(id: string): void {
    const items = this.read()
    atomicWriteFileSync(this.path(), JSON.stringify(items.filter(p => p.id !== id)))
  }
  find(origin: string): { username: string; password: string } | null {
    if (!this.available()) return null
    const item = this.read().filter(p => p.origin === origin).sort((a, b) => b.updatedAt - a.updatedAt)[0]
    return item ? { username: item.username, password: safeStorage.decryptString(Buffer.from(item.encrypted, 'base64')) } : null
  }
}
