import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserRestoreScheduler } from './browser-restore-scheduler'
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
afterEach(() => { vi.useRealTimers() })
describe('普通网页有界恢复', () => {
  it('同资源合并并提高主区优先级，撤销侧栏不取消主区', async () => {
    const d = deferred<string>(), run = vi.fn(() => d.promise)
    const q = createBrowserRestoreScheduler({ run })
    const a = q.submit('a', 'explicitShelf', () => true)
    expect(q.submit('a', 'explicitMain', () => true)).toBe(a)
    q.withdraw('a', 'explicitShelf'); await tick(); expect(run).toHaveBeenCalledTimes(1)
    d.resolve('page'); expect(await a).toEqual({ status: 'ready', value: 'page' })
  })
  it('超时不归还真实在途许可，重试不创建第二个实例', async () => {
    vi.useFakeTimers(); const d = deferred<string>(), run = vi.fn(() => d.promise)
    const q = createBrowserRestoreScheduler({ run, timeoutMs: 50 })
    const a = q.submit('a', 'explicitShelf', () => true); await tick()
    await vi.advanceTimersByTimeAsync(50)
    expect(await a).toMatchObject({ status: 'timeout' })
    expect(q.diagnostics().running).toBe(1)
    expect(q.submit('a', 'explicitMain', () => true)).toBe(a)
    q.submit('b', 'explicitMain', () => true); await tick()
    expect(run).toHaveBeenCalledTimes(1)
    d.resolve('page'); await tick(); expect(run).toHaveBeenCalledTimes(2)
  })
  it('排队期间失去需求不创建，先处理显式主区请求', async () => {
    const d = deferred<string>(), order: string[] = []; let visible = true
    const q = createBrowserRestoreScheduler({ run: async context => { order.push(context.resourceId); return context.resourceId === 'a' ? d.promise : context.resourceId } })
    const a = q.submit('a', 'explicitMain', () => true); await tick()
    const old = q.submit('old', 'bulkVisible', () => visible)
    const main = q.submit('main', 'explicitMain', () => true)
    visible = false; d.resolve('a'); await a; await main
    expect(await old).toMatchObject({ status: 'cancelled' }); expect(order).toEqual(['a', 'main'])
  })
  it('自动驻留达到上限时保留记录且拒绝新增，不强制销毁保护页', async () => {
    const q = createBrowserRestoreScheduler({ automaticResidentLimit: 1, run: async context => { context.onCreated(); return context.resourceId } })
    expect(await q.submit('a', 'bulkVisible', () => true)).toMatchObject({ status: 'ready' }); await tick()
    expect(await q.submit('b', 'bulkVisible', () => true)).toMatchObject({ status: 'busy' })
    q.releaseResident('a')
    expect(await q.submit('b', 'bulkVisible', () => true)).toMatchObject({ status: 'ready' })
  })
  it('描述符满时显式需求淘汰低优先级自动项', async () => {
    const d = deferred<string>(), q = createBrowserRestoreScheduler({ pendingLimit: 2, run: () => d.promise })
    q.submit('a', 'explicitMain', () => true); await tick()
    const automatic = q.submit('auto', 'bulkVisible', () => true)
    q.submit('main', 'explicitMain', () => true)
    expect(await automatic).toEqual({ status: 'busy' })
    expect(q.diagnostics().pending).toBe(2)
    d.resolve('page'); await tick()
  })
})
