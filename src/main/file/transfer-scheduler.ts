/**
 * 文件传输 Worker 全局调度器
 *
 * 上传与下载 Worker 各自会建立独立的 SSH/SFTP 连接。批量选择/拖入大量文件时，
 * 若按“启动即创建 Worker”执行，线程、V8 实例与连接数会随文件数线性增长。
 * 本调度器为两条链路提供共享的并发额度：
 * - 全局最多 maxConcurrent 个 Worker（默认 4）；
 * - 同一 SSH endpoint（host:port）最多 maxPerEndpoint 个（默认 2）；
 * - 排队总容量 maxPending（默认 64），超出后立即以 TransferQueueFullError 拒绝，
 *   避免把“无限 Worker”换成“无限排队”。
 *
 * 额度生命周期约定（关键）：
 * complete 消息只代表传输协议完成，并不证明 Worker 线程已退出。调用方必须等
 * Worker 的 exit 事件触发后再调用 lease.release()，否则实际活线程会超过上限。
 *
 * 调度器只管理“排队中”的任务；已启动任务的取消由各 Worker 管理器负责
 * （terminate + 等待 exit），排队任务的取消通过 cancelId / cancelSession /
 * cancelAll 完成，并返回被取消的 taskId 供管理器补发 UI 回执。
 */

export const DEFAULT_MAX_CONCURRENT_TRANSFERS = 4
export const DEFAULT_MAX_PER_ENDPOINT = 2
export const DEFAULT_MAX_PENDING_TRANSFERS = 64

export interface TransferSchedulerOptions {
  maxConcurrent?: number
  maxPerEndpoint?: number
  maxPending?: number
}

export interface TransferJob {
  taskId: string
  sessionId: string
  /** 并发计数键，通常为 `${host}:${port}` */
  endpoint: string
  /** 排队期间被取消/清空时的轻量清理（例如删除下载元信息），不得抛错 */
  onCancel?: () => void
}

export interface TransferLease {
  /**
   * 释放并发额度。必须在 Worker 线程触发 exit 之后调用；
   * 幂等，重复调用不会把额度还成负数。
   */
  release(): void
}

/** 排队容量已满，调用方应明确拒绝新任务 */
export class TransferQueueFullError extends Error {
  readonly limit: number

  constructor(limit: number) {
    super(`Transfer queue is full (max pending ${limit})`)
    this.name = 'TransferQueueFullError'
    this.limit = limit
  }
}

/** 排队任务在启动前被取消 */
export class TransferCancelledError extends Error {
  constructor(message = 'Transfer cancelled before start') {
    super(message)
    this.name = 'TransferCancelledError'
  }
}

export interface TransferSchedulerStats {
  active: number
  queued: number
  activeByEndpoint: Record<string, number>
}

export interface TransferScheduler {
  /** 申请一个 Worker 并发额度；额度在 release() 之前一直占用 */
  acquire(job: TransferJob): Promise<TransferLease>
  /** 取消排队中的单个任务，返回是否命中 */
  cancelId(taskId: string): boolean
  /** 取消某会话排队中的所有任务，返回被取消的 taskId */
  cancelSession(sessionId: string): string[]
  /** 取消全部排队任务（已启动的任务由管理器 terminate），返回被取消的 taskId */
  cancelAll(): string[]
  stats(): TransferSchedulerStats
}

interface QueueEntry {
  job: TransferJob
  resolve: (lease: TransferLease) => void
  reject: (error: Error) => void
}

/**
 * 同一 SSH endpoint（主机 + 端口）的并发计数键。
 * 相同主机不同端口属于不同 endpoint，各自计数。
 */
export function transferEndpointKey(host: string, port: number): string {
  return `${host}:${port}`
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(1, Math.floor(value))
}

export function createTransferScheduler(options: TransferSchedulerOptions = {}): TransferScheduler {
  const maxConcurrent = normalizeLimit(options.maxConcurrent, DEFAULT_MAX_CONCURRENT_TRANSFERS)
  const maxPerEndpoint = normalizeLimit(options.maxPerEndpoint, DEFAULT_MAX_PER_ENDPOINT)
  const maxPending = normalizeLimit(options.maxPending, DEFAULT_MAX_PENDING_TRANSFERS)

  const queue: QueueEntry[] = []
  const activeByEndpoint = new Map<string, number>()
  let activeTotal = 0

  function canStart(endpoint: string): boolean {
    if (activeTotal >= maxConcurrent) return false
    return (activeByEndpoint.get(endpoint) ?? 0) < maxPerEndpoint
  }

  function makeLease(job: TransferJob): TransferLease {
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        if (activeTotal > 0) activeTotal--
        const current = activeByEndpoint.get(job.endpoint) ?? 0
        if (current <= 1) {
          activeByEndpoint.delete(job.endpoint)
        } else {
          activeByEndpoint.set(job.endpoint, current - 1)
        }
        pump()
      }
    }
  }

  function startEntry(entry: QueueEntry): void {
    activeTotal++
    activeByEndpoint.set(entry.job.endpoint, (activeByEndpoint.get(entry.job.endpoint) ?? 0) + 1)
    entry.resolve(makeLease(entry.job))
  }

  /** 从队首扫描，跳过仍受 endpoint 限制的任务，避免队头阻塞其他 endpoint */
  function pump(): void {
    let index = 0
    while (index < queue.length && activeTotal < maxConcurrent) {
      const entry = queue[index]
      if (canStart(entry.job.endpoint)) {
        queue.splice(index, 1)
        startEntry(entry)
      } else {
        index++
      }
    }
  }

  function acquire(job: TransferJob): Promise<TransferLease> {
    // 容量包含已启动 + 排队中的任务：并发额度本身不会无限增长
    if (activeTotal + queue.length >= maxPending) {
      return Promise.reject(new TransferQueueFullError(maxPending))
    }
    return new Promise<TransferLease>((resolve, reject) => {
      const entry: QueueEntry = { job, resolve, reject }
      if (canStart(job.endpoint)) {
        startEntry(entry)
        return
      }
      queue.push(entry)
    })
  }

  function cancelWhere(predicate: (job: TransferJob) => boolean): string[] {
    const cancelled: string[] = []
    for (let index = queue.length - 1; index >= 0; index--) {
      const entry = queue[index]
      if (!predicate(entry.job)) continue
      queue.splice(index, 1)
      try {
        entry.job.onCancel?.()
      } catch {
        // 清理回调不得影响取消流程
      }
      cancelled.push(entry.job.taskId)
      entry.reject(new TransferCancelledError())
    }
    // 逆序扫描会反向收集，恢复提交顺序便于回执与断言
    return cancelled.reverse()
  }

  return {
    acquire,
    cancelId(taskId: string): boolean {
      return cancelWhere(job => job.taskId === taskId).length > 0
    },
    cancelSession(sessionId: string): string[] {
      return cancelWhere(job => job.sessionId === sessionId)
    },
    cancelAll(): string[] {
      return cancelWhere(() => true)
    },
    stats(): TransferSchedulerStats {
      return {
        active: activeTotal,
        queued: queue.length,
        activeByEndpoint: Object.fromEntries(activeByEndpoint)
      }
    }
  }
}

/**
 * 上传/下载管理器共享的全局 Worker 调度器。
 * 两条链路共用同一份额度，才能保证全局 4 / 每 endpoint 2 的上限。
 */
export const transferScheduler = createTransferScheduler()
