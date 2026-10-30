import { describe, expect, it, vi } from 'vitest'
import { assertBrowserHostsClosed, runConcurrentCleanup, runSequentialCleanup } from './shutdown-checks'

describe('顺序清理分组', () => {
  it('单项失败仍执行后续任务，最后以固定说明拒绝', async () => {
    const order: string[] = []
    const cleanup = runSequentialCleanup('Terminal cleanup', [
      { name: 'first', run: () => { order.push('first') } },
      {
        name: 'second',
        run: () => {
          order.push('second')
          throw new Error('second failed')
        }
      },
      { name: 'third', run: () => { order.push('third') } }
    ])

    await expect(cleanup).rejects.toThrow(/Terminal cleanup was not confirmed \(second\)/)
    await expect(cleanup).rejects.toThrow(/second failed/)
    expect(order).toEqual(['first', 'second', 'third'])
  })

  it('全部成功时静默完成', async () => {
    const first = vi.fn()
    const second = vi.fn()
    await expect(runSequentialCleanup('Dialog and download cleanup', [
      { name: 'dialogs', run: first },
      { name: 'downloads', run: second }
    ])).resolves.toBeUndefined()
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
  })
})

describe('并发清理分组', () => {
  it('等待全部任务落定后，把失败项汇总成固定说明', async () => {
    const completed: string[] = []
    const cleanup = runConcurrentCleanup('Transfer cleanup', [
      { name: 'download-workers', run: () => { completed.push('download-workers') } },
      {
        name: 'upload-workers',
        run: async () => {
          await Promise.resolve()
          completed.push('upload-workers')
          throw new Error('upload cleanup failed')
        }
      }
    ])

    await expect(cleanup).rejects.toThrow(/Transfer cleanup was not confirmed \(upload-workers\)/)
    // allSettled：失败不会取消另一个任务。
    expect(completed.sort()).toEqual(['download-workers', 'upload-workers'])
  })

  it('失败项超过上限时截断名称并给出计数', async () => {
    const tasks = Array.from({ length: 10 }, (_unused, index) => ({
      name: `task-${index}`,
      run: () => { throw new Error('boom') }
    }))
    await expect(runConcurrentCleanup('Many tasks', tasks)).rejects.toThrow(/\+2 more/)
  })
})

describe('浏览器宿主关闭确认', () => {
  it('全部 closed 时通过', () => {
    expect(() => assertBrowserHostsClosed([{ phase: 'closed' }, { phase: 'closed' }])).not.toThrow()
  })

  it('任何未 closed 的宿主都拒绝并给出固定说明', () => {
    expect(() => assertBrowserHostsClosed([
      { phase: 'closed' },
      { phase: 'close-unconfirmed' }
    ])).toThrow(/Browser host shutdown was not confirmed \(1 host\(s\) not closed: close-unconfirmed\)/)
  })
})
