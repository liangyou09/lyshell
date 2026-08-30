/**
 * 大纲折叠纯函数测试 —— 可见行推导 / 激活祖先上溯 / 有子判定。
 * 层级 fixture：h1 A / h2 A1 / h3 A1a / h2 A2 / h1 B / h2 B1（索引 0-5）。
 */
import { describe, expect, it } from 'vitest'
import { hasChildrenAt, visibleHeadingIdxs, displayActiveIdx } from './OutlineRail'
import type { DocHeading } from './OutlineRail'

const H: DocHeading[] = [
  { level: 1, text: 'A' },
  { level: 2, text: 'A1' },
  { level: 3, text: 'A1a' },
  { level: 2, text: 'A2' },
  { level: 1, text: 'B' },
  { level: 2, text: 'B1' }
]

describe('hasChildrenAt', () => {
  it('下一行层级更深即有子；叶子与末行无子', () => {
    expect(hasChildrenAt(H, 0)).toBe(true)   // h1 后跟 h2
    expect(hasChildrenAt(H, 1)).toBe(true)   // h2 后跟 h3
    expect(hasChildrenAt(H, 2)).toBe(false)  // h3 后回 h2
    expect(hasChildrenAt(H, 3)).toBe(false)  // h2 后回 h1
    expect(hasChildrenAt(H, 4)).toBe(true)   // h1 后跟 h2
    expect(hasChildrenAt(H, 5)).toBe(false)  // 末行
  })
})

describe('visibleHeadingIdxs', () => {
  it('无折叠全可见', () => {
    expect(visibleHeadingIdxs(H, new Set())).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('收起 h1 隐藏整个子树（含下级 h2/h3），兄弟 h1 不受影响', () => {
    expect(visibleHeadingIdxs(H, new Set([0]))).toEqual([0, 4, 5])
  })

  it('收起 h2 只隐藏自己的子级，同级 h2 不受影响', () => {
    expect(visibleHeadingIdxs(H, new Set([1]))).toEqual([0, 1, 3, 4, 5]) // 仅 A1a 隐藏，A2 保住
  })

  it('多点折叠叠加', () => {
    expect(visibleHeadingIdxs(H, new Set([0, 4]))).toEqual([0, 4])
  })

  it('收起叶子 / 无子标题是 no-op', () => {
    expect(visibleHeadingIdxs(H, new Set([2]))).toEqual([0, 1, 2, 3, 4, 5])
    expect(visibleHeadingIdxs(H, new Set([3]))).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('隔代嵌套：收起 h1 整树收走；只收中间 h2 保 h1', () => {
    const deep: DocHeading[] = [
      { level: 1, text: 'r' },
      { level: 2, text: 'm' },
      { level: 3, text: 'l' }
    ]
    expect(visibleHeadingIdxs(deep, new Set([0]))).toEqual([0])
    expect(visibleHeadingIdxs(deep, new Set([1]))).toEqual([0, 1])
  })
})

describe('displayActiveIdx', () => {
  it('激活行可见时原样返回', () => {
    expect(displayActiveIdx(H, visibleHeadingIdxs(H, new Set()), 5)).toBe(5)
    expect(displayActiveIdx(H, visibleHeadingIdxs(H, new Set([0])), 0)).toBe(0)
  })

  it('激活行被折叠隐藏时上溯最近可见祖先', () => {
    const vis = visibleHeadingIdxs(H, new Set([0])) // [0,4,5]
    expect(displayActiveIdx(H, vis, 1)).toBe(0) // A1 隐藏 → A
    expect(displayActiveIdx(H, vis, 2)).toBe(0) // A1a 隐藏 → A
    expect(displayActiveIdx(H, vis, 3)).toBe(0) // A2 隐藏 → A
    expect(displayActiveIdx(H, vis, 4)).toBe(4) // B 可见
  })

  it('只收 h2 时孙级归到 h2 而不是 h1', () => {
    const vis = visibleHeadingIdxs(H, new Set([1])) // [0,1,3,4,5]
    expect(displayActiveIdx(H, vis, 2)).toBe(1) // A1a → A1
  })

  it('无激活（-1）返回 -1', () => {
    expect(displayActiveIdx(H, [0, 4, 5], -1)).toBe(-1)
  })
})
