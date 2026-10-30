import { randomUUID } from 'crypto'
import type { SessionConfig, SessionPublicConfig } from '@shared/types'
import { publicSessionConfig } from './session-secrets'

/** 解密后的导入内容只暂存在 main，UI 选择条目后用一次性票据提交。 */
export class SessionImportStaging {
  private entries = new Map<string, { token: string; expires: number; sessions: SessionConfig[]; timer: ReturnType<typeof setTimeout> }>()

  constructor(private readonly now = Date.now) {}

  stage(principal: string, sessions: SessionConfig[]): { token: string; sessions: SessionPublicConfig[] } {
    for (const [owner, entry] of this.entries) if (entry.expires <= this.now()) this.forget(owner)
    if (!Array.isArray(sessions) || sessions.length > 1024) throw new Error('Import session limit exceeded')
    if (!this.entries.has(principal) && this.entries.size >= 8) throw new Error('Import preview limit exceeded')
    const copies = structuredClone(sessions)
    for (const session of copies) {
      session.id = randomUUID()
      delete session.ownerPluginId
      if (session.local) delete session.local.envSecretRefs
    }
    const token = randomUUID()
    this.forget(principal)
    const timer = setTimeout(() => { if (this.entries.get(principal)?.token === token) this.forget(principal) }, 10 * 60_000)
    timer.unref()
    this.entries.set(principal, { token, expires: this.now() + 10 * 60_000, sessions: copies, timer })
    return { token, sessions: copies.map(session => publicSessionConfig(session)) }
  }

  take(principal: string, token: string, ids: string[]): SessionConfig[] {
    const entry = this.entries.get(principal)
    if (entry && entry.expires <= this.now()) this.forget(principal)
    if (!entry || entry.expires <= this.now() || entry.token !== token) throw new Error('Import preview expired; reopen the file')
    const selected = new Set(ids)
    if (selected.size !== ids.length || ids.some(id => !entry.sessions.some(session => session.id === id))) throw new Error('Invalid import selection')
    // 先消费票据：部分持久化失败也不能重复提交，再次导入需重新预览。
    this.forget(principal)
    return entry.sessions.filter(session => selected.has(session.id)).map(session => ({ ...session, id: '' }))
  }

  forget(principal: string): void {
    const entry = this.entries.get(principal)
    if (entry) clearTimeout(entry.timer)
    this.entries.delete(principal)
  }
}
