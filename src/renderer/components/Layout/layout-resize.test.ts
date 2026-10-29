import { beforeEach, describe, expect, it, vi } from 'vitest'

type LayoutResizeModule = typeof import('./layout-resize')

describe('布局手势租约', () => {
  let layout: LayoutResizeModule

  beforeEach(async () => {
    // 模块持有租约计数：每个用例重新加载，避免用例之间共享状态。
    vi.resetModules()
    layout = await import('./layout-resize')
  })

  it('初始不活动；首个租约开始与结束时各通知一次', () => {
    const seen: boolean[] = []
    expect(layout.isLayoutResizing()).toBe(false)
    layout.subscribeLayoutResize(active => seen.push(active))

    const release = layout.beginLayoutResize()
    expect(layout.isLayoutResizing()).toBe(true)
    expect(seen).toEqual([true])

    release()
    expect(layout.isLayoutResizing()).toBe(false)
    expect(seen).toEqual([true, false])
  })

  it('重叠手势只在 0 与 >=1 的边界通知，先释放者不会提前结束', () => {
    const seen: boolean[] = []
    layout.subscribeLayoutResize(active => seen.push(active))

    const first = layout.beginLayoutResize()
    const second = layout.beginLayoutResize()
    expect(seen).toEqual([true])

    first()
    expect(layout.isLayoutResizing()).toBe(true)
    expect(seen).toEqual([true])

    second()
    expect(layout.isLayoutResizing()).toBe(false)
    expect(seen).toEqual([true, false])
  })

  it('release 幂等，重复调用不会把租约减成负数', () => {
    const seen: boolean[] = []
    layout.subscribeLayoutResize(active => seen.push(active))

    const lease = layout.beginLayoutResize()
    const other = layout.beginLayoutResize()
    lease()
    lease()
    lease()
    expect(layout.isLayoutResizing()).toBe(true)
    expect(seen).toEqual([true])

    other()
    other()
    expect(layout.isLayoutResizing()).toBe(false)
    expect(seen).toEqual([true, false])
  })

  it('取消订阅后不再收到通知，且取消可重复调用', () => {
    const first: boolean[] = []
    const second: boolean[] = []
    const unsubscribe = layout.subscribeLayoutResize(active => first.push(active))
    layout.subscribeLayoutResize(active => second.push(active))

    const lease = layout.beginLayoutResize()
    lease()
    unsubscribe()
    unsubscribe()

    const next = layout.beginLayoutResize()
    next()

    expect(first).toEqual([true, false])
    expect(second).toEqual([true, false, true, false])
  })

  it('订阅不回放当前状态，只接收之后的变化', () => {
    const lease = layout.beginLayoutResize()
    const seen: boolean[] = []
    layout.subscribeLayoutResize(active => seen.push(active))
    expect(seen).toEqual([])

    lease()
    expect(seen).toEqual([false])
  })

  it('单个订阅者抛错不影响其他订阅者与租约状态', () => {
    const seen: boolean[] = []
    layout.subscribeLayoutResize(() => {
      throw new Error('listener boom')
    })
    layout.subscribeLayoutResize(active => seen.push(active))

    const lease = layout.beginLayoutResize()
    expect(layout.isLayoutResizing()).toBe(true)
    expect(seen).toEqual([true])

    expect(() => lease()).not.toThrow()
    expect(layout.isLayoutResizing()).toBe(false)
    expect(seen).toEqual([true, false])
  })
})
