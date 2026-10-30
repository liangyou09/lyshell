/**
 * 全局终端历史预算测试
 * 覆盖：授予容量、按实际长度记账、LRU 清理、租约释放、dispose、非法上限、
 * 缓存不会绕过预算（清理后增量读报历史缺口）。
 */

import { describe, expect, it } from 'vitest'
import { OutputBuffer } from './output-buffer'
import { OutputHistoryBudget, OutputHistoryBudgetError } from './output-budget'

describe('OutputHistoryBudget 全局历史预算', () => {
  it('跳过旧的空缓冲，仍回收非空历史以维持全局预算', () => {
    const budget = new OutputHistoryBudget({ totalLimit: 10, perBufferLimit: 10 })
    const empty = new OutputBuffer(), a = new OutputBuffer(), b = new OutputBuffer()
    for (const buffer of [empty, a, b]) budget.attach(buffer)
    a.append('12345678')
    b.append('abcdefgh')
    expect(budget.snapshot().usedChars).toBeLessThanOrEqual(10)
    expect(a.size()).toBe(0)
    budget.dispose()
  })
  it('授予容量取 min(perBufferLimit, totalLimit)，并按实际存活长度记账', () => {
    const budget = new OutputHistoryBudget({ totalLimit: 100, perBufferLimit: 30 })
    const buffer = new OutputBuffer()
    const lease = budget.attach(buffer)

    expect(lease.capacity).toBe(30)
    expect(buffer.getCapacity()).toBe(30)
    expect(lease.released).toBe(false)
    expect(budget.snapshot()).toMatchObject({
      totalLimit: 100,
      perBufferLimit: 30,
      usedChars: 0,
      budgetedChars: 30,
      bufferCount: 1,
      overBudget: false,
      disposed: false
    })

    buffer.append('x'.repeat(20))
    expect(budget.snapshot().usedChars).toBe(20)

    // 超过授予容量后自动回收，记账跟随实际长度而不是容量。
    buffer.append('y'.repeat(20))
    expect(buffer.size()).toBe(30)
    expect(budget.snapshot().usedChars).toBe(30)
  })

  it('重复 attach 幂等，不会重复计量', () => {
    const budget = new OutputHistoryBudget({ totalLimit: 100, perBufferLimit: 40 })
    const buffer = new OutputBuffer()
    const first = budget.attach(buffer)
    const second = budget.attach(buffer)

    expect(second.buffer).toBe(buffer)
    expect(budget.snapshot()).toMatchObject({ bufferCount: 1, budgetedChars: 40, usedChars: 0 })

    first.dispose()
    expect(second.released).toBe(true)
    expect(budget.snapshot()).toMatchObject({ bufferCount: 0, budgetedChars: 0, usedChars: 0 })
  })

  it('多个缓冲的授予容量不会预占全部全局上限', () => {
    const budget = new OutputHistoryBudget({ totalLimit: 100, perBufferLimit: 40 })
    const buffers = [new OutputBuffer(), new OutputBuffer(), new OutputBuffer()]
    for (const buffer of buffers) budget.attach(buffer)

    expect(budget.snapshot()).toMatchObject({
      usedChars: 0,
      budgetedChars: 120, // 只是上限合计，超过 totalLimit 也不代表已占用内存
      bufferCount: 3,
      overBudget: false
    })

    buffers[0].append('a'.repeat(40))
    buffers[1].append('b'.repeat(40))
    buffers[2].append('c'.repeat(40))
    // 存活合计 120 > 100，触发 LRU 清理到上限以内。
    const snapshot = budget.snapshot()
    expect(snapshot.usedChars).toBeLessThanOrEqual(100)
    expect(snapshot.overBudget).toBe(false)
    expect(snapshot.totalDroppedChars).toBeGreaterThan(0)
    expect(snapshot.evictions).toBeGreaterThan(0)
  })

  it('全局超限时清理最久未使用的缓冲，刚写入的缓冲不受影响', () => {
    const budget = new OutputHistoryBudget({ totalLimit: 100, perBufferLimit: 100 })
    const older = new OutputBuffer()
    const newer = new OutputBuffer()
    budget.attach(older)
    budget.attach(newer)

    older.append('a'.repeat(60))
    newer.append('b'.repeat(60))

    expect(older.size()).toBe(0)
    expect(newer.size()).toBe(60)
    const snapshot = budget.snapshot()
    expect(snapshot).toMatchObject({
      usedChars: 60,
      bufferCount: 2,
      totalDroppedChars: 60,
      evictions: 1,
      overBudget: false
    })
    expect(older.getOutputSince(0)).toMatchObject({ text: '', truncated: true })
  })

  it('清理后增量读报历史缺口而不是响应截断，缓存不会绕过预算', () => {
    const budget = new OutputHistoryBudget({ totalLimit: 100, perBufferLimit: 100 })
    const older = new OutputBuffer()
    const newer = new OutputBuffer()
    budget.attach(older)
    budget.attach(newer)

    older.append('a'.repeat(60))
    // 读取产生 joined/clean 缓存，随后被全局清理。
    expect(older.getOutputSince(0).text).toHaveLength(60)
    const epoch = older.getOutputEpoch()
    newer.append('b'.repeat(60))

    expect(older.size()).toBe(0)
    const read = older.readIncremental({ cursor: 0, outputEpoch: epoch })
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.text).toBe('')
    expect(read.historyGap).toEqual({ fromCursor: 0, toCursor: 60, lostChars: 60 })
    expect(read.responseTruncated).toBe(false)
    expect(read.nextCursor).toBe(60)
    expect(budget.snapshot().usedChars).toBe(60)
  })

  it('租约释放会解除观察者、清空历史并把容量收敛到 0', () => {
    const budget = new OutputHistoryBudget({ totalLimit: 100, perBufferLimit: 50 })
    const buffer = new OutputBuffer()
    const lease = budget.attach(buffer)
    buffer.append('z'.repeat(40))
    expect(budget.snapshot().usedChars).toBe(40)

    lease.dispose()
    expect(lease.released).toBe(true)
    expect(buffer.size()).toBe(0)
    expect(buffer.getCapacity()).toBe(0)
    expect(budget.snapshot()).toMatchObject({ usedChars: 0, budgetedChars: 0, bufferCount: 0 })
    expect(budget.release(buffer)).toBe(false) // 已释放

    // 释放后观察者已解除，继续写入不再影响记账。
    buffer.append('ignored')
    expect(budget.snapshot().usedChars).toBe(0)
  })

  it('dispose 释放全部缓冲并拒绝后续 attach，可重复调用', () => {
    const budget = new OutputHistoryBudget({ totalLimit: 100, perBufferLimit: 50 })
    const a = new OutputBuffer()
    const b = new OutputBuffer()
    budget.attach(a)
    budget.attach(b)
    a.append('a'.repeat(10))
    b.append('b'.repeat(10))

    budget.dispose()
    expect(budget.snapshot()).toMatchObject({
      usedChars: 0,
      budgetedChars: 0,
      bufferCount: 0,
      disposed: true
    })
    expect(a.size()).toBe(0)
    expect(b.size()).toBe(0)
    expect(() => budget.attach(new OutputBuffer())).toThrow(/disposed/)
    expect(() => budget.dispose()).not.toThrow()
  })

  it('非法上限抛 invalid-limit，默认值来自共享常量', () => {
    expect(() => new OutputHistoryBudget({ totalLimit: -1 })).toThrow(OutputHistoryBudgetError)
    expect(() => new OutputHistoryBudget({ perBufferLimit: Number.NaN })).toThrow(/Invalid output history limit/)
    try {
      new OutputHistoryBudget({ totalLimit: Number.POSITIVE_INFINITY })
    } catch (error) {
      expect(error).toBeInstanceOf(OutputHistoryBudgetError)
      expect((error as OutputHistoryBudgetError).code).toBe('invalid-limit')
    }

    const defaults = new OutputHistoryBudget()
    expect(defaults.snapshot()).toMatchObject({ totalLimit: 32 * 1024 * 1024, perBufferLimit: 1024 * 1024 })
  })
})
