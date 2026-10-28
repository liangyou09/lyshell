/** 普通网页恢复准入。UI 超时只结束等待，真实创建/导航结束前不归还并发许可。 */
export type BrowserRestoreSource = 'explicitMain' | 'explicitShelf' | 'bulkVisible'
export type BrowserRestoreResult<T> = { status: 'ready'; value: T } | { status: 'failed' | 'timeout' | 'cancelled' | 'busy'; error?: string }
export interface BrowserRestoreContext {
  resourceId: string
  isValid(): boolean
  source(): BrowserRestoreSource
  /** 实体/创建许可已经产生后调用；失败也必须继续计入驻留，直到真实销毁或用户接管。 */
  onCreated(): void
}
interface Demand { source: BrowserRestoreSource; isValid: () => boolean }
interface Pending<T> {
  id: string
  demands: Map<BrowserRestoreSource, Demand>
  promise: Promise<BrowserRestoreResult<T>>
  resolve: (result: BrowserRestoreResult<T>) => void
  created: boolean
  running: boolean
  timer?: ReturnType<typeof setTimeout>
}
const priority: Record<BrowserRestoreSource, number> = { explicitMain: 3, explicitShelf: 2, bulkVisible: 1 }

export function createBrowserRestoreScheduler<T>(options: {
  run(context: BrowserRestoreContext): Promise<T>
  timeoutMs?: number
  pendingLimit?: number
  automaticResidentLimit?: number
}) {
  const timeoutMs = options.timeoutMs ?? 30000
  const pendingLimit = options.pendingLimit ?? 16
  const residentLimit = options.automaticResidentLimit ?? 4
  if (![timeoutMs, pendingLimit, residentLimit].every(n => Number.isSafeInteger(n) && n >= 1)) throw new RangeError('Invalid browser restore limits')
  const pending = new Map<string, Pending<T>>()
  const residents = new Set<string>()
  let active: Pending<T> | null = null
  const validDemand = (demand: Demand) => { try { return demand.isValid() } catch { return false } }
  const valid = (item: Pending<T>) => [...item.demands.values()].some(validDemand)
  const rank = (item: Pending<T>) => Math.max(0, ...[...item.demands.values()].filter(validDemand).map(d => priority[d.source]))
  const finishQueued = (item: Pending<T>, status: 'cancelled' | 'busy') => { pending.delete(item.id); item.resolve({ status }) }
  const pump = () => {
    if (active) return
    const queue = [...pending.values()].filter(item => !item.running).sort((a, b) => rank(b) - rank(a))
    for (const item of queue) {
      if (!valid(item)) { finishQueued(item, 'cancelled'); continue }
      const automatic = rank(item) === priority.bulkVisible
      if (automatic && residents.size >= residentLimit && !residents.has(item.id)) { finishQueued(item, 'busy'); continue }
      active = item; item.running = true
      if (automatic) residents.add(item.id)
      const timer = setTimeout(() => item.resolve({ status: 'timeout', error: 'Navigation is still running' }), timeoutMs)
      item.timer = timer
      void Promise.resolve().then(() => {
        if (!valid(item)) return Promise.reject(new Error('STALE_DEMAND'))
        return options.run({ resourceId: item.id, isValid: () => valid(item), source: () => [...item.demands.values()].filter(validDemand).sort((a, b) => priority[b.source] - priority[a.source])[0]?.source ?? 'bulkVisible', onCreated: () => { item.created = true } })
      }).then(value => item.resolve(valid(item) ? { status: 'ready', value } : { status: 'cancelled' }), error => item.resolve({ status: valid(item) ? 'failed' : 'cancelled', error: error instanceof Error ? error.message : String(error) })).finally(() => {
        clearTimeout(timer)
        if (!item.created) residents.delete(item.id)
        pending.delete(item.id); active = null; pump()
      })
      return
    }
  }
  const submit = (id: string, source: BrowserRestoreSource, isValid: () => boolean): Promise<BrowserRestoreResult<T>> => {
    if (!id || id.length > 512 || !Object.prototype.hasOwnProperty.call(priority, source)) return Promise.resolve({ status: 'busy', error: 'Invalid restore request' })
    const current = pending.get(id)
    if (source !== 'bulkVisible' && validDemand({ source, isValid })) residents.delete(id)
    if (current) { current.demands.set(source, { source, isValid }); return current.promise }
    for (const item of pending.values()) if (!item.running && !valid(item)) finishQueued(item, 'cancelled')
    if (pending.size >= pendingLimit) {
      const victim = [...pending.values()].find(item => !item.running && rank(item) < priority[source])
      if (!victim) return Promise.resolve({ status: 'busy' })
      finishQueued(victim, 'busy')
    }
    let resolve!: Pending<T>['resolve']
    const promise = new Promise<BrowserRestoreResult<T>>(done => { resolve = done })
    const item: Pending<T> = { id, demands: new Map([[source, { source, isValid }]]), promise, resolve, created: false, running: false }
    pending.set(id, item); pump(); return promise
  }
  return {
    submit,
    /** 只撤销这一来源，主区需求不受侧栏收起影响。 */
    withdraw: (id: string, source: BrowserRestoreSource) => { const item = pending.get(id); if (!item) return; item.demands.delete(source); if (!item.running && !valid(item)) finishQueued(item, 'cancelled') },
    /** 只能由实际销毁证据或用户明确接管为手动打开调用。 */
    releaseResident: (id: string) => { residents.delete(id); pump() },
    diagnostics: () => ({ running: active ? 1 : 0, pending: pending.size, automaticResidents: residents.size }),
  }
}
