import { describe, expect, it } from 'vitest'
import type { ActivityNotice } from './workbench-activity'
import {
  ACTIVITY_TOAST_DURATION_MS,
  activityToastTimeout,
  createActivityToastTracker,
  mergeActivityToasts
} from './activity-toast'

let sequence = 0
function notice(id: string, kind: ActivityNotice['kind'] = 'completed', at = 1000): ActivityNotice {
  sequence += 1
  return { id, workspace: 'C:/project', sessionId: 'session-a', taskId: `task-${id}`, kind, at: at + sequence }
}

function fixed(id: string, kind: ActivityNotice['kind'], at: number): ActivityNotice {
  return { id, workspace: 'C:/project', sessionId: 'session-a', taskId: 'task-a', kind, at }
}

describe('activityToastTimeout', () => {
  it('审批常驻，完成与失败按 8 秒超时', () => {
    expect(ACTIVITY_TOAST_DURATION_MS).toBe(8000)
    expect(activityToastTimeout('approval')).toBeNull()
    expect(activityToastTimeout('completed')).toBe(8000)
    expect(activityToastTimeout('failed')).toBe(ACTIVITY_TOAST_DURATION_MS)
  })
})

describe('createActivityToastTracker', () => {
  it('构造时的 initial 已见，重新挂载不重播历史', () => {
    const a = notice('a'), b = notice('b')
    const tracker = createActivityToastTracker([a, b])
    expect(tracker.take([a, b])).toEqual([])
    expect(tracker.take([])).toEqual([])
  })

  it('重复轮询同一事件只提醒一次', () => {
    const tracker = createActivityToastTracker()
    const a = notice('a')
    expect(tracker.take([a])).toEqual([a])
    expect(tracker.take([a])).toEqual([])
    expect(tracker.take([a, a])).toEqual([])
  })

  it('同一次输入里的重复 ID 只输出一次并保留首次出现', () => {
    const first = notice('dup', 'completed', 10)
    const second = notice('dup', 'failed', 20)
    const tracker = createActivityToastTracker()
    const fresh = tracker.take([first, second])
    expect(fresh).toHaveLength(1)
    expect(fresh[0]).toBe(first)
    expect(tracker.take([first, second])).toEqual([])
  })
  it('超容量批次中同一 ID 即使已被 FIFO 淘汰也不在该批次重复输出', () => {
    const tracker = createActivityToastTracker()
    const batch = Array.from({ length: 513 }, (_, index) => notice(`batch-${index}`))
    expect(tracker.take([...batch, batch[0]])).toHaveLength(513)
  })

  it('不同后台 ID 的同类事件各自提醒，并保持输入次序', () => {
    const tracker = createActivityToastTracker()
    const newest = notice('backend-b', 'completed', 300)
    const middle = notice('backend-c', 'approval', 200)
    const oldest = notice('backend-a', 'failed', 100)
    const batch = [newest, middle, oldest]
    expect(tracker.take(batch)).toEqual([newest, middle, oldest])
    expect(tracker.take(batch)).toEqual([])
  })

  it('不修改输入数组与事件对象', () => {
    const batch = Object.freeze([Object.freeze(notice('a')), Object.freeze(notice('b'))])
    const snapshot = batch.map(item => item.id)
    const tracker = createActivityToastTracker()
    expect(() => tracker.take(batch)).not.toThrow()
    expect(batch.map(item => item.id)).toEqual(snapshot)
  })

  it('容量 512：保留最近 512 个已见 ID，淘汰最早已见', () => {
    const tracker = createActivityToastTracker()
    const ids = Array.from({ length: 512 }, (_, index) => `id-${index}`)
    expect(tracker.take(ids.map(id => fixed(id, 'completed', 1000)))).toHaveLength(512)
    expect(tracker.take([fixed('id-0', 'completed', 1000)])).toEqual([])
    expect(tracker.take([fixed('id-511', 'completed', 1000)])).toEqual([])
    // 第 513 个事件使最早已见（id-0）被淘汰，其余保持已见。
    expect(tracker.take([fixed('id-512', 'completed', 1000)])).toHaveLength(1)
    expect(tracker.take([fixed('id-1', 'completed', 1000)])).toEqual([])
    expect(tracker.take([fixed('id-0', 'completed', 1000)])).toHaveLength(1)
    // 重新记入已淘汰的 id-0 会挤掉下一个最早已见 id-1。
    expect(tracker.take([fixed('id-2', 'completed', 1000)])).toEqual([])
    expect(tracker.take([fixed('id-1', 'completed', 1000)])).toHaveLength(1)
  })

  it('initial 超出容量同样淘汰最早已见', () => {
    const initial = Array.from({ length: 513 }, (_, index) => fixed(`init-${index}`, 'completed', 1000))
    const tracker = createActivityToastTracker(initial)
    // 只保留最近的 512 个：init-0 被淘汰，init-1..init-512 仍已见。
    expect(tracker.take([initial[512]])).toEqual([])
    expect(tracker.take([initial[1]])).toEqual([])
    expect(tracker.take([initial[0]])).toHaveLength(1)
    // 重新记入 init-0 后，最早已见变成 init-1。
    expect(tracker.take([initial[2]])).toEqual([])
    expect(tracker.take([initial[1]])).toHaveLength(1)
  })
})

describe('mergeActivityToasts', () => {
  it('同类按 at 降序，默认最多 3 条', () => {
    const result = mergeActivityToasts([], [
      fixed('a', 'completed', 100),
      fixed('b', 'completed', 300),
      fixed('c', 'failed', 200),
      fixed('d', 'completed', 400)
    ])
    expect(result.map(item => item.id)).toEqual(['d', 'b', 'c'])
  })

  it('审批排在其他通知之前，即使审批时间更早', () => {
    const result = mergeActivityToasts([
      fixed('done', 'completed', 900),
      fixed('ask', 'approval', 100)
    ], [], 3)
    expect(result.map(item => item.id)).toEqual(['ask', 'done'])
  })

  it('相同 at 保持稳定次序，不做需要推断任务变化的排序', () => {
    const result = mergeActivityToasts(
      [fixed('x', 'completed', 500), fixed('y', 'completed', 500)],
      [fixed('z', 'completed', 500)],
      3
    )
    expect(result.map(item => item.id)).toEqual(['x', 'y', 'z'])
    expect(result.map(item => item.kind)).toEqual(['completed', 'completed', 'completed'])
  })

  it('按 ID 去重且 incoming 覆盖 current', () => {
    const current = fixed('same', 'completed', 100)
    const incoming = fixed('same', 'failed', 50)
    const result = mergeActivityToasts([current], [incoming], 3)
    expect(result).toHaveLength(1)
    expect(result[0]).toBe(incoming)
    expect(result[0].kind).toBe('failed')
  })

  it('limit 为 0 或负数返回空数组', () => {
    const items = [fixed('a', 'completed', 100), fixed('b', 'approval', 200)]
    expect(mergeActivityToasts(items, items, 0)).toEqual([])
    expect(mergeActivityToasts(items, items, -1)).toEqual([])
  })

  it('自定义 limit 截断已排序结果', () => {
    const result = mergeActivityToasts([], [
      fixed('a', 'completed', 100),
      fixed('b', 'approval', 50),
      fixed('c', 'failed', 300)
    ], 1)
    expect(result.map(item => item.id)).toEqual(['b'])
  })

  it('不修改任何输入，空输入返回空数组', () => {
    const current = Object.freeze([Object.freeze(fixed('a', 'completed', 100))])
    const incoming = Object.freeze([Object.freeze(fixed('b', 'approval', 200)), Object.freeze(fixed('c', 'completed', 300))])
    const before = [current.map(item => item.id), incoming.map(item => item.id)]
    expect(() => mergeActivityToasts(current, incoming, 2)).not.toThrow()
    expect([current.map(item => item.id), incoming.map(item => item.id)]).toEqual(before)
    expect(mergeActivityToasts([], [])).toEqual([])
  })
})
