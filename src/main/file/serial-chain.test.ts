import { describe, it, expect } from 'vitest'
import { createSerialChain } from './serial-chain'

// 这些测试锁定并发同路径文件传输的串行化保证（round-5 🟡#3 修复）：
// 同 key 任务必须排队执行，避免 open(path,'wb') 互相 truncate + 交错写入损坏文件。

describe('createSerialChain', () => {
  it('同 key 串行：第二个 fn 在第一个 resolve 后才执行', async () => {
    const chain = createSerialChain()
    const order: string[] = []
    let resolveA!: () => void
    const a = new Promise<void>((r) => { resolveA = r })
    const pA = chain.run('k', () => { order.push('startA'); return a.then(() => { order.push('endA') }) })
    // 让 microtask 跑一下，确保 A 已入链
    await Promise.resolve()
    const pB = chain.run('k', () => { order.push('startB'); return Promise.resolve().then(() => { order.push('endB') }) })
    await Promise.resolve()
    expect(order).toEqual(['startA']) // B 还没开始
    resolveA()
    await pA
    await pB
    expect(order).toEqual(['startA', 'endA', 'startB', 'endB'])
  })

  it('不同 key 并行：不互相阻塞', async () => {
    const chain = createSerialChain()
    const order: string[] = []
    let resolveA!: () => void
    const a = new Promise<void>((r) => { resolveA = r })
    const pA = chain.run('k1', () => { order.push('startA'); return a.then(() => { order.push('endA') }) })
    await Promise.resolve()
    const pB = chain.run('k2', () => { order.push('startB'); return Promise.resolve().then(() => { order.push('endB') }) })
    await Promise.resolve()
    await pB
    expect(order).toEqual(['startA', 'startB', 'endB'])
    resolveA()
    await pA
    expect(order).toEqual(['startA', 'startB', 'endB', 'endA'])
  })

  it('前一个 reject 不阻塞后续同 key 任务', async () => {
    const chain = createSerialChain()
    const order: string[] = []
    const pA = chain.run('k', () => { order.push('A'); return Promise.reject(new Error('boom')) }).catch(() => {})
    await pA
    const pB = chain.run('k', () => { order.push('B'); return Promise.resolve() })
    await pB
    expect(order).toEqual(['A', 'B'])
  })

  it('reject 的错误透传给调用方（不吞当前任务自身错误）', async () => {
    const chain = createSerialChain()
    const p = chain.run('k', () => Promise.reject(new Error('boom')))
    await expect(p).rejects.toThrow('boom')
  })

  it('resolve 的结果透传给调用方', async () => {
    const chain = createSerialChain()
    const p = chain.run('k', () => Promise.resolve())
    await expect(p).resolves.toBeUndefined()
  })

  it('结算后清理链项，不泄漏', async () => {
    const chain = createSerialChain()
    const pA = chain.run('k', () => Promise.resolve())
    expect(chain.pendingCount()).toBe(1)
    await pA
    expect(chain.pendingCount()).toBe(0)
  })

  it('并发入链多个同 key 任务，全部串行执行且链最终清空', async () => {
    const chain = createSerialChain()
    const order: string[] = []
    const tasks = Array.from({ length: 5 }, (_, i) =>
      chain.run('k', () => { order.push(String(i)); return Promise.resolve() })
    )
    await Promise.all(tasks)
    expect(order).toEqual(['0', '1', '2', '3', '4'])
    expect(chain.pendingCount()).toBe(0)
  })

  it('按 group 取消尚未启动的排队任务，不取消正在运行的队首', async () => {
    const chain = createSerialChain()
    const started: string[] = []
    const cancelled: string[] = []
    let resolveActive!: () => void
    const active = new Promise<void>((resolve) => { resolveActive = resolve })
    const p1 = chain.run('same-path', () => { started.push('active'); return active }, { id: '1', group: 's' })
    const p2 = chain.run('same-path', () => { started.push('queued'); return Promise.resolve() }, {
      id: '2', group: 's', onCancel: () => cancelled.push('2')
    })

    expect(chain.cancelGroup('s')).toEqual(['2'])
    await expect(p2).rejects.toThrow('cancelled before start')
    expect(started).toEqual(['active'])
    expect(cancelled).toEqual(['2'])

    resolveActive()
    await p1
    expect(chain.pendingCount()).toBe(0)
  })

  it('cancelId 只取消指定的待启动任务', async () => {
    const chain = createSerialChain()
    let resolveActive!: () => void
    const active = new Promise<void>((resolve) => { resolveActive = resolve })
    const p1 = chain.run('k', () => active, { id: '1', group: 's' })
    const p2 = chain.run('k', () => Promise.resolve(), { id: '2', group: 's' })
    const p3 = chain.run('k', () => Promise.resolve(), { id: '3', group: 's' })

    expect(chain.cancelId('2')).toBe(true)
    await expect(p2).rejects.toThrow('cancelled before start')
    resolveActive()
    await Promise.all([p1, p3])
  })
})
