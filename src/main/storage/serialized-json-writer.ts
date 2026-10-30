import { performance } from 'perf_hooks'
import { resolve } from 'path'
import type { McpAuditPersistenceFailure, McpAuditPersistenceState } from '@shared/mcp-audit'
import { atomicWriteFile, writeBackup } from './atomic-json'

interface FlushWaiter {
  revision: number
  resolve: () => void
  reject: (error: Error) => void
}

export interface SerializedJsonWriterOptions {
  debounceMs?: number
  maxWaitMs?: number
  now?: () => number
  writePrimary?: (path: string, json: string) => Promise<void>
  writeBackup?: (path: string, json: string) => Promise<boolean>
  onFailure?: (failure: McpAuditPersistenceFailure) => void
}

// 同一路径上的主提交和备份共用锁；第二个仓储实例也不能并行 rename。
const pathTails = new Map<string, Promise<void>>()

async function withPathWriter(path: string, write: () => Promise<void>): Promise<void> {
  const absolute = resolve(path)
  const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute
  const previous = pathTails.get(key) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(write)
  pathTails.set(key, current)
  try {
    await current
  } finally {
    if (pathTails.get(key) === current) pathTails.delete(key)
  }
}

/**
 * 完整快照的串行异步提交器。失败不自动忙重试；下一次变更或显式 flush 才重试。
 * JSON.stringify 仍在主线程，耗时单独公开，不能把 async fs 当作零阻塞保证。
 */
export class SerializedJsonWriter {
  private revision = 0
  private committed = 0
  private dirtySince: number | null = null
  private nextDirtySince: number | null = null
  private activeRevision = 0
  private active = false
  private accepting = true
  private due = false
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private maxWaitTimer: ReturnType<typeof setTimeout> | null = null
  private waiters: FlushWaiter[] = []
  private lastFailure: McpAuditPersistenceFailure | null = null
  private serializationMs = 0
  private writeMs = 0
  private readonly now: () => number
  private readonly debounceMs: number
  private readonly maxWaitMs: number
  private readonly writePrimary: (path: string, json: string) => Promise<void>
  private readonly writeBackup: (path: string, json: string) => Promise<boolean>

  constructor(
    private readonly path: string,
    private readonly snapshot: () => string,
    private readonly options: SerializedJsonWriterOptions = {}
  ) {
    this.now = options.now ?? (() => performance.now())
    this.debounceMs = options.debounceMs ?? 2000
    this.maxWaitMs = options.maxWaitMs ?? 5000
    this.writePrimary = options.writePrimary ?? atomicWriteFile
    this.writeBackup = options.writeBackup ?? writeBackup
  }

  markDirty(): number {
    if (!this.accepting) throw new Error('Persistence writer is draining')
    this.revision++
    const now = this.now()
    this.dirtySince ??= now
    if (this.active && this.revision > this.activeRevision) this.nextDirtySince ??= now
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => this.requestWrite(), this.debounceMs)
    this.debounceTimer.unref?.()
    if (!this.maxWaitTimer) {
      this.maxWaitTimer = setTimeout(() => this.requestWrite(), this.maxWaitMs)
      this.maxWaitTimer.unref?.()
    }
    return this.revision
  }

  stopAcceptingWrites(): number {
    this.accepting = false
    this.clearTimers()
    return this.revision
  }

  getState(): McpAuditPersistenceState {
    return {
      currentRevision: this.revision,
      committedRevision: this.committed,
      dirtySince: this.dirtySince,
      activeWrite: this.active,
      lastFailure: this.lastFailure ? { ...this.lastFailure } : null,
      serializationMs: this.serializationMs,
      writeMs: this.writeMs
    }
  }

  flush(targetRevision = this.revision): Promise<void> {
    if (!Number.isSafeInteger(targetRevision) || targetRevision < 0 || targetRevision > this.revision) {
      return Promise.reject(new Error('Invalid persistence revision'))
    }
    if (targetRevision <= this.committed) return Promise.resolve()
    const promise = new Promise<void>((resolve, reject) => {
      this.waiters.push({ revision: targetRevision, resolve, reject })
    })
    this.requestWrite()
    return promise
  }

  private clearTimers(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer)
    this.debounceTimer = this.maxWaitTimer = null
  }

  private requestWrite(): void {
    this.clearTimers()
    if (this.active) {
      this.due = true
      return
    }
    if (this.revision <= this.committed) return
    this.active = true
    this.activeRevision = this.revision
    this.nextDirtySince = null
    this.due = false
    void this.commit(this.activeRevision)
  }

  private fail(revision: number, phase: McpAuditPersistenceFailure['phase']): void {
    const failure: McpAuditPersistenceFailure = { revision, phase, code: 'PERSISTENCE_FAILED' }
    this.lastFailure = failure
    try { this.options.onFailure?.(failure) } catch { /* 诊断不能中断资源收尾 */ }
  }

  private async commit(revision: number): Promise<void> {
    let phase: McpAuditPersistenceFailure['phase'] = 'serialize'
    let succeeded = false
    try {
      const serializationStart = this.now()
      const json = this.snapshot()
      this.serializationMs = Math.max(0, this.now() - serializationStart)
      phase = 'primary'
      const writeStart = this.now()
      await withPathWriter(this.path, async () => {
        await this.writePrimary(this.path, json)
        // 主文件提交点：备份失败不能回滚 committedRevision 或谎报主写失败。
        this.committed = revision
        this.lastFailure = null
        phase = 'backup'
        if (!await this.writeBackup(this.path, json)) this.fail(revision, 'backup')
      })
      this.writeMs = Math.max(0, this.now() - writeStart)
      succeeded = true
    } catch {
      this.fail(revision, phase)
      // 注入的备份实现也可能 throw；已提交主文件仍然算成功。
      succeeded = this.committed >= revision
    } finally {
      this.active = false
      if (this.revision <= this.committed) this.dirtySince = null
      else if (succeeded) this.dirtySince = this.nextDirtySince ?? this.now()
      const waiters = this.waiters
      this.waiters = []
      for (const waiter of waiters) {
        if (waiter.revision <= this.committed) waiter.resolve()
        else if (!succeeded) waiter.reject(new Error('Persistence commit failed'))
        else this.waiters.push(waiter)
      }
      // 新变更的 debounce/maxWait、或显式 flush 可要求下一快照；失败不自旋。
      if (succeeded && this.revision > this.committed && (this.due || this.waiters.length > 0)) {
        this.requestWrite()
      }
    }
  }
}
