import { OperationError } from '@shared/operation'
import { COMMAND_LIMITS } from './types'

/**
 * 命令输出/响应预算。
 *
 * - 保留量（retained）覆盖活动收集与等待发送的完整结果，按结果实际字节增量预留；
 * - 发送量（send）覆盖序列化后的响应体，JSON 转义会扩大原文，不能只按原文长度预留；
 * - 两者都必须在入口确认响应发送完成或结果被丢弃后释放。
 */

export interface OutputBudgetLimits {
  batchBytes: number
  globalBytes: number
  sendBytes: number
}

export const DEFAULT_OUTPUT_BUDGET_LIMITS: OutputBudgetLimits = {
  batchBytes: COMMAND_LIMITS.batchOutputBytes,
  globalBytes: COMMAND_LIMITS.globalOutputBytes,
  sendBytes: COMMAND_LIMITS.globalSendBytes
}

/** UTF-8 内容量；不是 JS 内存或 RSS 承诺。 */
export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

const SHORT_ESCAPES = new Set([0x08, 0x09, 0x0a, 0x0c, 0x0d])

/**
 * JSON.stringify 对字符串的转义后字节数（不含两侧引号）。
 * 只扫描不构建大字符串，供发送预算预留；孤立代理项按 \uXXXX 的 6 字节计。
 */
export function jsonEscapedBytes(text: string): number {
  let bytes = 0
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code === 0x22 || code === 0x5c) { bytes += 2; continue }
    if (code < 0x20) { bytes += SHORT_ESCAPES.has(code) ? 2 : 6; continue }
    if (code < 0x80) { bytes += 1; continue }
    if (code < 0x800) { bytes += 2; continue }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        // 成对代理项按一个 4 字节码点计。
        bytes += 4
        index++
      } else {
        bytes += 6
      }
      continue
    }
    if (code >= 0xdc00 && code <= 0xdfff) { bytes += 6; continue }
    bytes += 3
  }
  return bytes
}

export class CommandOutputBudget {
  private readonly limits: OutputBudgetLimits
  private readonly retained = new Map<string, number>()
  private readonly send = new Map<string, number>()
  private retainedTotal = 0
  private sendTotal = 0

  constructor(limits: Partial<OutputBudgetLimits> = {}) {
    this.limits = { ...DEFAULT_OUTPUT_BUDGET_LIMITS, ...limits }
  }

  /** 增量预留保留量；触达单批次或全局上限时整体拒绝，不部分记账。 */
  reserveRetained(ownerId: string, bytes: number): void {
    if (!Number.isFinite(bytes) || bytes <= 0) return
    const current = this.retained.get(ownerId) ?? 0
    if (current + bytes > this.limits.batchBytes) {
      throw new OperationError(
        'RESOURCE_LIMIT',
        `Command output limit exceeded (batch max ${this.limits.batchBytes} bytes)`,
        'never'
      )
    }
    if (this.retainedTotal + bytes > this.limits.globalBytes) {
      throw new OperationError(
        'RESOURCE_LIMIT',
        `Command output limit exceeded (global max ${this.limits.globalBytes} bytes)`,
        'never'
      )
    }
    this.retained.set(ownerId, current + bytes)
    this.retainedTotal += bytes
  }

  /** 结果发送完成或丢弃后调用；幂等。 */
  releaseRetained(ownerId: string): void {
    const current = this.retained.get(ownerId)
    if (!current) return
    this.retained.delete(ownerId)
    this.retainedTotal -= current
  }

  /** 单个目标失败时归还其已占用的字节；批次仍保留其余结果。 */
  releaseRetainedBytes(ownerId: string, bytes: number): void {
    const current = this.retained.get(ownerId)
    if (!current || bytes <= 0) return
    const released = Math.min(current, bytes)
    if (released >= current) this.retained.delete(ownerId)
    else this.retained.set(ownerId, current - released)
    this.retainedTotal -= released
  }

  /** 序列化/待发送预留；无容量时调用方必须排队或明确拒绝。 */
  reserveSend(ownerId: string, bytes: number): void {
    if (!Number.isFinite(bytes) || bytes <= 0) return
    if (this.sendTotal + bytes > this.limits.sendBytes) {
      throw new OperationError(
        'RESOURCE_LIMIT',
        `Command response limit exceeded (send max ${this.limits.sendBytes} bytes)`,
        'never'
      )
    }
    this.send.set(ownerId, (this.send.get(ownerId) ?? 0) + bytes)
    this.sendTotal += bytes
  }

  releaseSend(ownerId: string): void {
    const current = this.send.get(ownerId)
    if (!current) return
    this.send.delete(ownerId)
    this.sendTotal -= current
  }

  retainedBytesFor(ownerId: string): number {
    return this.retained.get(ownerId) ?? 0
  }

  sendBytesFor(ownerId: string): number {
    return this.send.get(ownerId) ?? 0
  }

  get retainedBytes(): number { return this.retainedTotal }
  get sendBytes(): number { return this.sendTotal }
  get retainedOwners(): number { return this.retained.size }
  get limitsSnapshot(): OutputBudgetLimits { return { ...this.limits } }
}
