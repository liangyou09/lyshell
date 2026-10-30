import { describe, expect, it } from 'vitest'
import { isLocalApiHost, RequestBudget, isBoundedJson } from './local-request'

describe('本机HTTP边界', () => {
  it('只允许明确回环Host和实际监听端口', () => {
    expect(isLocalApiHost('127.0.0.1:32123', 32123)).toBe(true)
    expect(isLocalApiHost('localhost:32123', 32123)).toBe(true)
    for (const host of [undefined, 'evil.test:32123', '127.0.0.1:22', 'localhost.evil:32123', 'user@localhost:32123', 'localhost']) {
      expect(isLocalApiHost(host, 32123)).toBe(false)
    }
  })
  it('同时限制全局与调用方名额并幂等释放', () => {
    const budget = new RequestBudget(3, 2)
    const a = budget.acquire('a')!, b = budget.acquire('a')!, c = budget.acquire('b')!
    expect(budget.acquire('a')).toBeUndefined()
    expect(budget.acquire('c')).toBeUndefined()
    a(); a()
    expect(budget.acquire('a')).toBeTypeOf('function')
    expect(budget.acquire('c')).toBeUndefined()
    b(); c()
    expect(budget.acquire('c')).toBeTypeOf('function')
  })
  it('拒绝过深或过多节点的合法JSON', () => {
    expect(isBoundedJson({ data: ['ok'] })).toBe(true)
    expect(isBoundedJson({ a: { b: { c: 1 } } }, 2)).toBe(false)
    expect(isBoundedJson([1, 2, 3], 32, 3)).toBe(false)
  })
})
