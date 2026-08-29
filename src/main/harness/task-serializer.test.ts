import { describe, it, expect } from 'vitest'
import { createTaskSerializer } from './task-serializer'

/** 微任务排空 + 一拍定时器：等 promise 链上的清理回调跑完 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('createTaskSerializer', () => {
  it('同 key 任务严格串行且保持提交顺序（后来的被挡在门外）', async () => {
    const ser = createTaskSerializer()
    const order: number[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const p1 = ser('a', async () => { order.push(1); await gate; order.push(2); return 'r1' })
    const p2 = ser('a', async () => { order.push(3); return 'r2' })
    await flush()
    // 第一个任务卡在 gate 上时，第二个任务尚未开始
    expect(order).toEqual([1])
    expect(ser.pending).toBe(1)
    release()
    expect(await p1).toBe('r1')
    expect(await p2).toBe('r2')
    expect(order).toEqual([1, 2, 3])
  })

  it('不同 key 互不阻塞（并行）', async () => {
    const ser = createTaskSerializer()
    let releaseA!: () => void
    const gateA = new Promise<void>((resolve) => { releaseA = resolve })
    const pA = ser('a', () => gateA)
    const pB = ser('b', async () => 'b')
    expect(await pB).toBe('b')
    releaseA()
    await pA
  })

  it('前序失败不连坐后来者，异常透传给发起方', async () => {
    const ser = createTaskSerializer()
    const p1 = ser('a', async () => { throw new Error('boom') })
    await expect(p1).rejects.toThrow('boom')
    await expect(ser('a', async () => 'ok')).resolves.toBe('ok')
  })

  it('队列空闲后清理登记项（pending 归零，Map 不随历史增长）', async () => {
    const ser = createTaskSerializer()
    await ser('a', async () => 1)
    await ser('a', async () => 2)
    await ser('b', async () => 3)
    await flush()
    expect(ser.pending).toBe(0)
  })
})
