/**
 * 全局终端历史预算
 *
 * 每个会话的 OutputBuffer 仍然是“按容量自回收”的独立队列；这里再加一层全局记账：
 * - 所有受管缓冲的存活码元（UTF-16 代码单元）合计不超过 totalLimit；
 * - 单个缓冲的容量不超过 perBufferLimit —— 新建缓冲不会把全局上限整个预占；
 * - 超出全局上限时按最近最少使用（LRU）顺序对整个缓冲调用 dropHistory()，
 *   被清理的码元计入 totalDroppedChars / evictions，不会静默发生；
 * - 记账来自 buffer 的 size 观察者，按**实际存活长度**累加，容量只是上限。
 *
 * 本类不接管 buffer 的读写，也不改变 getOutputSince/readIncremental 的游标语义；
 * 它只提供 attach / release(dispose) / snapshot，由 SessionManager 在会话创建、
 * 销毁时接入。缓存本身只由 chunks 派生，chunks 被 dropHistory 清空后缓存也随
 * generation 失效，因此不存在绕过预算的额外历史副本。
 *
 * 所有容量单位都是 UTF-16 代码单元，不是 UTF-8 字节。
 */

import {
  TERMINAL_OUTPUT_HISTORY_LIMIT,
  TERMINAL_OUTPUT_HISTORY_TOTAL_BUDGET
} from '@shared/terminal-output'
import type { OutputBuffer } from './output-buffer'

export interface OutputHistoryBudgetLimits {
  /** 所有受管缓冲的存活码元合计上限 */
  totalLimit: number
  /** 单个缓冲的容量上限 */
  perBufferLimit: number
}

export interface OutputHistoryBudgetSnapshot {
  totalLimit: number
  perBufferLimit: number
  /** 当前存活码元合计 */
  usedChars: number
  /** 已授予各缓冲的容量合计（诊断用，可能大于 usedChars） */
  budgetedChars: number
  bufferCount: number
  /** 因全局上限被清理掉的码元总数 */
  totalDroppedChars: number
  /** 因全局上限触发的清理次数（按 buffer 计） */
  evictions: number
  overBudget: boolean
  disposed: boolean
}

export type OutputHistoryBudgetErrorCode = 'disposed' | 'invalid-limit'

export class OutputHistoryBudgetError extends Error {
  constructor(readonly code: OutputHistoryBudgetErrorCode, message: string) {
    super(message)
    this.name = 'OutputHistoryBudgetError'
  }
}

/**
 * 一个缓冲的预算租约。会话销毁时调用 `dispose()` 立即释放记账并清空历史，
 * 也可通过 `OutputHistoryBudget.release(buffer)` 释放。
 */
export interface OutputHistoryLease {
  readonly buffer: OutputBuffer
  /** 本租约实际授予的容量（码元） */
  readonly capacity: number
  readonly released: boolean
  dispose(): void
}

/**
 * 租约实现。`released` 同时反映本句柄是否已释放、以及该缓冲是否仍受预算管理，
 * 因此同一缓冲的多个幂等 attach 句柄不会出现“一个已释放、另一个仍报告有效”的分歧。
 */
class OutputHistoryLeaseHandle implements OutputHistoryLease {
  private releasedFlag = false

  constructor(
    readonly buffer: OutputBuffer,
    readonly capacity: number,
    private readonly budget: OutputHistoryBudget
  ) {}

  get released(): boolean {
    return this.releasedFlag || !this.budget.has(this.buffer)
  }

  dispose(): void {
    if (this.released) return
    this.releasedFlag = true
    this.budget.release(this.buffer)
  }
}

interface Entry {
  buffer: OutputBuffer
  /** 授予容量（码元） */
  capacity: number
  /** 最近一次写入/访问的单调序号，用于 LRU */
  tick: number
  /** 最近一次观察到的存活长度 */
  size: number
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value < 0) {
    throw new OutputHistoryBudgetError('invalid-limit', `Invalid output history limit: ${String(value)}`)
  }
  return Math.floor(value)
}

export class OutputHistoryBudget {
  private readonly totalLimit: number
  private readonly perBufferLimit: number
  private readonly entries = new Map<OutputBuffer, Entry>()
  private usedChars = 0
  private budgetedChars = 0
  private tick = 0
  private totalDroppedChars = 0
  private evictions = 0
  private evicting = false
  private disposing = false
  private disposed = false

  constructor(limits: Partial<OutputHistoryBudgetLimits> = {}) {
    this.totalLimit = normalizeLimit(limits.totalLimit, TERMINAL_OUTPUT_HISTORY_TOTAL_BUDGET)
    this.perBufferLimit = normalizeLimit(limits.perBufferLimit, TERMINAL_OUTPUT_HISTORY_LIMIT)
  }

  /**
   * 把一个缓冲纳入全局预算，返回租约。重复 attach 同一缓冲是幂等的。
   * 授予容量 = min(perBufferLimit, totalLimit)，因此新缓冲不会预占全部上限。
   */
  attach(buffer: OutputBuffer): OutputHistoryLease {
    if (this.disposed) throw new OutputHistoryBudgetError('disposed', 'Output history budget is disposed')
    const existing = this.entries.get(buffer)
    if (existing) return this.createLease(existing)

    const capacity = Math.min(this.perBufferLimit, this.totalLimit)
    buffer.setCapacity(capacity)
    this.tick += 1
    const entry: Entry = { buffer, capacity, tick: this.tick, size: buffer.size() }
    this.entries.set(buffer, entry)
    this.budgetedChars += capacity
    this.usedChars += entry.size
    buffer.setSizeObserver((observed, size) => this.observe(observed, size))
    this.evictIfNeeded(buffer)
    return this.createLease(entry)
  }

  /**
   * 释放一个缓冲：解除观察者与记账，并清空其历史（会话销毁即释放内存）。
   * 未受管的缓冲是 no-op。
   */
  release(buffer: OutputBuffer): boolean {
    const entry = this.entries.get(buffer)
    if (!entry) return false
    this.detach(entry)
    return true
  }

  /** 该缓冲当前是否仍受本预算管理（租约有效性判断用） */
  has(buffer: OutputBuffer): boolean {
    return this.entries.has(buffer)
  }

  /**
   * 释放全部缓冲并停止记账。之后 attach 会抛 `disposed`。
   */
  dispose(): void {
    if (this.disposed) return
    this.disposing = true
    for (const entry of [...this.entries.values()]) this.detach(entry)
    this.entries.clear()
    this.disposing = false
    this.disposed = true
    this.usedChars = 0
    this.budgetedChars = 0
  }

  /** 只读快照，供诊断接口/测试断言 */
  snapshot(): OutputHistoryBudgetSnapshot {
    return {
      totalLimit: this.totalLimit,
      perBufferLimit: this.perBufferLimit,
      usedChars: this.usedChars,
      budgetedChars: this.budgetedChars,
      bufferCount: this.entries.size,
      totalDroppedChars: this.totalDroppedChars,
      evictions: this.evictions,
      overBudget: this.usedChars > this.totalLimit,
      disposed: this.disposed
    }
  }

  private createLease(entry: Entry): OutputHistoryLease {
    return new OutputHistoryLeaseHandle(entry.buffer, entry.capacity, this)
  }

  private detach(entry: Entry): void {
    const buffer = entry.buffer
    buffer.setSizeObserver(null)
    this.entries.delete(buffer)
    this.usedChars -= entry.size
    this.budgetedChars -= entry.capacity
    if (this.usedChars < 0) this.usedChars = 0
    if (this.budgetedChars < 0) this.budgetedChars = 0
    // 释放即归还内存：清空历史并把容量收敛到 0，避免未记账的历史继续驻留。
    buffer.dropHistory()
    buffer.setCapacity(0)
  }

  /** 大小变化回调：按实际长度记账，超出全局上限时清理 LRU 缓冲 */
  private observe(buffer: OutputBuffer, size: number): void {
    if (this.disposed || this.disposing) return
    const entry = this.entries.get(buffer)
    if (!entry) return
    const delta = size - entry.size
    if (delta !== 0) {
      entry.size = size
      this.usedChars += delta
      if (this.usedChars < 0) this.usedChars = 0
    }
    this.tick += 1
    entry.tick = this.tick
    // 正在清理时不再递归触发（dropHistory 会同步回调到这里）。
    if (!this.evicting) this.evictIfNeeded(buffer)
  }

  /**
   * 全局超限时按 LRU 清理：优先清理触发者之外的缓冲，避免刚写入的数据立刻被清掉；
   * 只有一个缓冲时它自身容量不会超过授予容量 ≤ totalLimit，正常不会触发。
   */
  private evictIfNeeded(trigger: OutputBuffer | null): void {
    if (this.evicting || this.disposing || this.disposed) return
    if (this.usedChars <= this.totalLimit) return
    this.evicting = true
    try {
      let guard = 0
      while (this.usedChars > this.totalLimit && this.entries.size > 0 && guard++ <= this.entries.size) {
        let victim: Entry | null = null
        for (const entry of this.entries.values()) {
          if (entry.size === 0) continue
          if (trigger && entry.buffer === trigger && this.entries.size > 1) continue
          if (!victim || entry.tick < victim.tick) victim = entry
        }
        if (!victim) break
        const before = victim.size
        if (!victim.buffer.dropHistory()) break
        const dropped = before - victim.size
        if (dropped <= 0) break
        this.totalDroppedChars += dropped
        this.evictions += 1
      }
    } finally {
      this.evicting = false
    }
  }
}
