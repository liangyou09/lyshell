import { createHash, randomUUID } from 'node:crypto'
import { SHELF_ACTIVATION_LIMIT, type ShelfClassificationStatus, type TaskShelfActivation, type TaskShelfStartup } from '@shared/task-shelf'
import type { TaskShelfRepository, ShelfArchiveStatus } from '../storage/task-shelf-repository'

/** 启动归档与分类命令的失败码：渲染层据此区分「初始化未完成」和「请求冲突」。 */
export const SHELF_INITIALIZATION_BLOCKED = 'INITIALIZATION_BLOCKED'
export const SHELF_CONFLICT = 'CONFLICT'
export const SHELF_STALE_BOOT = 'STALE_BOOT'

/** 去重表只按本次运行限制容量；淘汰后旧请求仍由版本校验保证不产生重复副作用。 */
const DEDUPE_LIMIT = 256

export type ShelfCommandFailure = { success: false; error: string; code: string }
export type ShelfActivateOutcome = { success: true; activation: TaskShelfActivation } | ShelfCommandFailure
export type ShelfStartupOutcome = { success: true; startup: TaskShelfStartup } | ShelfCommandFailure

export interface TaskShelfCommandDeps {
  repository: TaskShelfRepository
  /** 生产默认开启；关闭时只做读取校验，不归档任何记录。 */
  startupArchiveEnabled?: boolean
  /** 测试可固定；生产每次运行生成一个，重载 renderer 不换 bootId。 */
  bootId?: string
  scopeId?: string
  now?: () => number
}

export interface TaskShelfCommandService {
  /** 首次调用完成启动快照与归档，之后幂等返回同一状态。 */
  ensureStartup: () => TaskShelfStartup
  startup: () => TaskShelfStartup
  /** 当前初始化未完成时的错误说明；ready 返回 undefined。 */
  blockedError: () => string | undefined
  retryInitialization: (bootId: string, scopeId: string) => ShelfStartupOutcome
  activate: (request: { bootId: string; scopeId: string; requestId: string; items: Array<{ taskId: string; expectedRevision: number }> }) => ShelfActivateOutcome
}

/**
 * 启动归档协调器：只拥有「固定启动快照 → 原子归档 → ready/blocked」和分类命令。
 * 不做恢复、不建实例、不执行命令；重试永远复用受校验的同一批快照。
 */
export function createTaskShelfCommandService(deps: TaskShelfCommandDeps): TaskShelfCommandService {
  const now = deps.now ?? Date.now
  const bootId = deps.bootId ?? randomUUID()
  const scopeId = deps.scopeId ?? `shelf:${createHash('sha256').update(deps.repository.filePath).digest('hex').slice(0, 16)}`
  const archiveOnBoot = deps.startupArchiveEnabled === true

  let started = false
  let readFailed = false
  let status: 'ready' | 'blocked' = 'ready'
  let errorText: string | undefined
  /** 启动时固定的快照（id + revision），归档与重试都只针对它。 */
  let snapshot: Array<{ id: string; revision: number }> = []
  /** 启动前保存区文件摘要：重试时用来发现合法外部写入。 */
  let digest: string | undefined
  const dedupe = new Map<string, { digest: string; activation: TaskShelfActivation }>()

  function view(): TaskShelfStartup {
    const startup: TaskShelfStartup = { bootId, scopeId, status, archiveOnBoot }
    if (status === 'blocked' && errorText) startup.error = errorText
    return startup
  }

  function owns(requestBootId: string, requestScopeId: string): boolean {
    return requestBootId === bootId && requestScopeId === scopeId
  }

  /**
   * 归档固定快照；返回是否已持久就绪。写盘失败或快照记录已漂移时绝不发布 ready。
   * 成功后不再刷新摘要：那一步既无消费者（ready 后重试直接返回），读取异常还会把成功伪装成失败。
   */
  function commitSnapshot(): boolean {
    const result = deps.repository.archiveSnapshot(snapshot.map(item => ({ id: item.id, expectedRevision: item.revision })), now())
    // 原子写入失败：仓储已回滚内存与文件，本次全部待改项都是 failed。
    if (result.items.some(item => item.status === 'failed')) {
      status = 'blocked'
      errorText = `启动归档保存失败：${result.error ?? '保存区写入失败'}`
      return false
    }
    // 快照内的记录已在别处变化或消失：即使其余项写入成功，初始化也未完成。
    if (result.items.some(item => item.status === 'conflict' || item.status === 'missing')) {
      status = 'blocked'
      errorText = '启动归档未完成：保存区记录已在别处变化，请重新加载后再归档'
      return false
    }
    status = 'ready'
    errorText = undefined
    return true
  }

  function initialize(): void {
    started = true
    readFailed = false
    try {
      // 摘要和快照必须在同一个 try 里：任一读取失败都不允许走到写盘分支。
      digest = deps.repository.diskDigest()
      snapshot = deps.repository.list().map(entry => ({ id: entry.id, revision: entry.revision }))
    } catch (error) {
      // 归档文件读取失败时连快照都无法固定：保持 blocked，由 list 自己报告真实读取错误。
      readFailed = true
      status = 'blocked'
      errorText = `启动归档无法读取保存区：${(error as Error).message}`
      return
    }
    status = 'ready'
    errorText = undefined
    if (!archiveOnBoot || snapshot.length === 0) return
    commitSnapshot()
  }

  function startup(): TaskShelfStartup {
    return ensureStartup()
  }

  function ensureStartup(): TaskShelfStartup {
    // 初始化整体同步执行：任何一次写入之前一定先做完加载和归档。
    if (!started) initialize()
    return view()
  }

  function blockedError(): string | undefined {
    return status === 'blocked' ? errorText ?? '任务保存区初始化未完成' : undefined
  }

  function retryInitialization(requestBootId: string, requestScopeId: string): ShelfStartupOutcome {
    ensureStartup()
    if (!owns(requestBootId, requestScopeId)) return { success: false, error: '启动批次不属于当前运行；请重新加载任务保存区', code: SHELF_STALE_BOOT }
    if (status === 'ready') return { success: true, startup: view() }

    // 摘要读不出来不等于「文件没变」：保持 blocked，绝不拿旧快照写盘。
    let current: string | undefined
    try {
      current = deps.repository.diskDigest()
    } catch (error) {
      status = 'blocked'
      errorText = `启动归档无法读取保存区：${(error as Error).message}`
      return { success: false, error: errorText, code: SHELF_INITIALIZATION_BLOCKED }
    }
    if (readFailed) {
      // 首次初始化没有拿到可信快照（读取失败／归档损坏）：重新完整加载一次，而不是复用旧快照去覆盖。
      started = false
      ensureStartup()
      return status === 'blocked'
        ? { success: false, error: blockedError()!, code: SHELF_INITIALIZATION_BLOCKED }
        : { success: true, startup: view() }
    }
    if (current !== digest) {
      return { success: false, error: '保存区文件已被外部修改，旧启动批次不覆盖新内容；请重新加载后再归档', code: SHELF_CONFLICT }
    }
    // 复用同一批快照，但先核对版本：期间的删除/修改一律记冲突，不用旧快照覆盖。
    const changed = snapshot.some(item => {
      const entry = deps.repository.get(item.id)
      return !entry || entry.revision !== item.revision
    })
    if (changed) return { success: false, error: '保存区记录已变化，旧启动批次不能覆盖；请重新加载后再归档', code: SHELF_CONFLICT }
    return commitSnapshot()
      ? { success: true, startup: view() }
      : { success: false, error: blockedError()!, code: SHELF_INITIALIZATION_BLOCKED }
  }

  function requestDigest(request: { bootId: string; scopeId: string; requestId: string; items: Array<{ taskId: string; expectedRevision: number }> }): string {
    return createHash('sha256')
      .update(JSON.stringify([request.bootId, request.scopeId, request.requestId, request.items.map(item => [item.taskId, item.expectedRevision])]))
      .digest('hex')
  }

  function toActivation(requestId: string, items: Array<{ id: string; status: ShelfArchiveStatus }>): TaskShelfActivation {
    // 激活方向不会产生 alreadyArchived；为类型收窄统一折叠成「已经在 Tasks」。
    const normalized = items.map(item => ({ id: item.id, status: item.status === 'alreadyArchived' ? 'alreadyTasks' as const : item.status }))
    const activation: TaskShelfActivation = {
      requestId,
      items: normalized.map(item => ({ taskId: item.id, status: item.status as ShelfClassificationStatus })),
      total: normalized.length,
      moved: 0,
      alreadyTasks: 0,
      conflict: 0,
      missing: 0,
      failed: 0
    }
    for (const item of activation.items) activation[item.status] += 1
    return activation
  }

  function remember(requestId: string, fingerprint: string, activation: TaskShelfActivation): void {
    dedupe.delete(requestId)
    dedupe.set(requestId, { digest: fingerprint, activation })
    while (dedupe.size > DEDUPE_LIMIT) {
      const oldest = dedupe.keys().next().value
      if (oldest === undefined) break
      dedupe.delete(oldest)
    }
  }

  function activate(request: { bootId: string; scopeId: string; requestId: string; items: Array<{ taskId: string; expectedRevision: number }> }): ShelfActivateOutcome {
    ensureStartup()
    if (!owns(request.bootId, request.scopeId)) return { success: false, error: '启动批次不属于当前运行；请重新加载任务保存区', code: SHELF_STALE_BOOT }
    if (status === 'blocked') return { success: false, error: blockedError()!, code: SHELF_INITIALIZATION_BLOCKED }
    if (request.items.length > SHELF_ACTIVATION_LIMIT) {
      return { success: false, error: `一次最多激活 ${SHELF_ACTIVATION_LIMIT} 条保存记录`, code: SHELF_CONFLICT }
    }

    const fingerprint = requestDigest(request)
    const cached = dedupe.get(request.requestId)
    if (cached) {
      if (cached.digest !== fingerprint) return { success: false, error: '同一 requestId 不能提交不同载荷；请为新请求生成新 ID', code: SHELF_CONFLICT }
      // 只复用分类结果；envelope 的 entries 由调用方重新读取，避免旧快照回退 UI。
      return { success: true, activation: { ...cached.activation, items: cached.activation.items.map(item => ({ ...item })) } }
    }

    const batch = deps.repository.archiveBatch(request.items.map(item => ({ id: item.taskId, expectedRevision: item.expectedRevision })), now())
    const activation = toActivation(request.requestId, batch.items)
    remember(request.requestId, fingerprint, activation)
    return { success: true, activation }
  }

  return { ensureStartup, startup, blockedError, retryInitialization, activate }
}
