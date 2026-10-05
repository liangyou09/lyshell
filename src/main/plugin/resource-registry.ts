interface ReleaseHooks {
  notifyReleased(): void
  listSessions(): Array<{ id: string; originSavedSessionId?: string; ownerPluginId?: string }>
  deleteSaved(id: string): void
  notifySessionDeleted(id: string): void
  notifyChanged(): void
  deleteLive(id: string): Promise<unknown>
}

interface SessionCleanup {
  pluginId: string
  sessionId: string
  saved: boolean
  saveFailure?: { error: unknown }
  promise: Promise<void>
  resolve(): void
  reject(error: unknown): void
}

/** 插件资源归属独立于 token；正在清理的资源保留归属，直到关闭得到成功回执。 */
export class PluginResourceRegistry {
  private generations = new Map<string, number>()
  private sessions = new Map<string, { pluginId: string; saved: boolean }>()
  private cleanups = new Map<string, SessionCleanup>()

  generation(pluginId: string): number {
    return this.generations.get(pluginId) ?? 0
  }

  isCurrent(pluginId: string, generation: number): boolean {
    return this.generation(pluginId) === generation
  }

  owner(sessionId: string): string | undefined {
    return this.cleanups.get(sessionId)?.pluginId ?? this.sessions.get(sessionId)?.pluginId
  }

  track(pluginId: string, sessionId: string, generation: number, saved = false): boolean {
    if (!this.isCurrent(pluginId, generation)) return false
    const existing = this.sessions.get(sessionId)
    // 复用其他插件的资源不能转移归属。
    const owner = this.owner(sessionId)
    if (owner && owner !== pluginId) return false
    this.sessions.set(sessionId, { pluginId, saved: saved || !!existing?.saved })
    return true
  }

  /** 连接保存项时按持久化归属登记；借用用户配置只认领运行时。 */
  trackSavedConnection(pluginId: string, config: { id: string; ownerPluginId?: string }, generation: number): boolean {
    return this.track(pluginId, config.id, generation, config.ownerPluginId === pluginId)
  }

  forgetLiveSession(sessionId: string): void {
    if (!this.sessions.get(sessionId)?.saved) this.sessions.delete(sessionId)
  }

  release(pluginId: string): Array<{ sessionId: string; saved: boolean }> {
    this.generations.set(pluginId, this.generation(pluginId) + 1)
    const resources: Array<{ sessionId: string; saved: boolean }> = []
    for (const [sessionId, resource] of this.sessions) {
      if (resource.pluginId !== pluginId) continue
      resources.push({ sessionId, saved: resource.saved })
      this.sessions.delete(sessionId)
    }
    return resources
  }

  /** 同步失效代次并预登记全部清理任务，通知中的重入回收也能加入同一批在途任务。 */
  async releaseSessions(pluginId: string, hooks: ReleaseHooks): Promise<void> {
    const resources = this.release(pluginId)
    const savedIds = new Set(resources.filter(resource => resource.saved).map(resource => resource.sessionId))
    const tasks = new Map<string, SessionCleanup>()
    const ownedTasks: SessionCleanup[] = []
    const failures: Array<{ id: string; error: unknown }> = []
    const attempt = (id: string, action: () => void): void => {
      try { action() } catch (error) { failures.push({ id, error }) }
    }
    const reserve = (id: string, saved = false): void => {
      if (tasks.has(id)) {
        if (saved) tasks.get(id)!.saved = true
        return
      }
      const owner = this.owner(id)
      if (owner && owner !== pluginId) throw new Error(`Session ownership changed: ${id}`)
      let task = this.cleanups.get(id)
      if (!task) {
        let resolve!: () => void
        let reject!: (error: unknown) => void
        const promise = new Promise<void>((onResolve, onReject) => { resolve = onResolve; reject = onReject })
        task = { pluginId, sessionId: id, saved, promise, resolve, reject }
        this.cleanups.set(id, task)
        ownedTasks.push(task)
      }
      tasks.set(id, task)
    }

    // 所有调用都等待仍在关闭的借用终端；不能依靠 config.ownerPluginId 重建这类归属。
    for (const task of this.cleanups.values()) {
      if (task.pluginId === pluginId) {
        tasks.set(task.sessionId, task)
        if (task.saved) savedIds.add(task.sessionId)
      }
    }
    for (const resource of resources) attempt(resource.sessionId, () => reserve(resource.sessionId, resource.saved))
    attempt(pluginId, () => {
      for (const session of hooks.listSessions()) {
        if (session.ownerPluginId ? session.ownerPluginId === pluginId
          : !!session.originSavedSessionId && savedIds.has(session.originSavedSessionId)) {
          attempt(session.id, () => reserve(session.id))
        }
      }
    })

    // IO 失败不能使预登记的任务悬空；通知、保存项删除都尝试后，仍完成所有原生关闭。
    attempt(pluginId, () => hooks.notifyReleased())
    for (const id of savedIds) {
      const task = tasks.get(id)
      if (!task || !task.saved) continue
      try {
        hooks.deleteSaved(id)
        task.saved = false
        task.saveFailure = undefined
      } catch (error) {
        // 共享回执覆盖保存项与运行时；其他等待者不能把保存项删除失败误报为完成。
        task.saved = true
        task.saveFailure = { error }
      }
    }
    for (const id of tasks.keys()) attempt(id, () => hooks.notifySessionDeleted(id))
    attempt(pluginId, () => hooks.notifyChanged())
    // 只有预登记任务的调用启动关闭，其他调用仅等待；同步通知重入也不会提前关闭。
    for (const task of ownedTasks) void this.closeSession(task, hooks)
    const entries = [...tasks.values()]
    const results = await Promise.allSettled(entries.map(task => task.promise))
    results.forEach((result, index) => {
      if (result.status === 'rejected') failures.push({ id: entries[index].sessionId, error: result.reason as unknown })
    })
    if (failures.length) {
      throw new AggregateError(failures.map(failure => failure.error),
        `Plugin resource cleanup failed (${pluginId}): ${failures.map(failure => `${failure.id}: ${String(failure.error)}`).join('; ')}`)
    }
  }

  private async closeSession(task: SessionCleanup, hooks: ReleaseHooks): Promise<void> {
    try {
      await hooks.deleteLive(task.sessionId)
    } catch (error) {
      // 当前代次只保留清理归属，不恢复旧代次的权限；失败项可由下一次回收重试。
      this.track(task.pluginId, task.sessionId, this.generation(task.pluginId), task.saved)
      this.cleanups.delete(task.sessionId)
      task.reject(error)
      return
    }
    // 保存项删除失败时，运行时已关闭仍要保留保存项归属，供下次回收补完。
    if (task.saved) this.track(task.pluginId, task.sessionId, this.generation(task.pluginId), true)
    this.cleanups.delete(task.sessionId)
    if (task.saved) task.reject(task.saveFailure?.error ?? new Error(`Saved session cleanup incomplete: ${task.sessionId}`))
    else task.resolve()
  }
}

export const pluginResources = new PluginResourceRegistry()

/** 生命周期编排通过 hooks 注入 IO，确保失效通知与保存项删除都先于异步断开。 */
export function releasePluginSessions(registry: PluginResourceRegistry, pluginId: string, hooks: ReleaseHooks): Promise<void> {
  return registry.releaseSessions(pluginId, hooks)
}
