import { describe, it, expect } from 'vitest'
import { snapTerminalFontSize } from './index'

describe('snapTerminalFontSize', () => {
  it('整数原样保留（1px 步进，不再吸附 5 的倍数）', () => {
    expect(snapTerminalFontSize(12)).toBe(12)
    expect(snapTerminalFontSize(13)).toBe(13)
    expect(snapTerminalFontSize(17)).toBe(17)
    expect(snapTerminalFontSize(18)).toBe(18)
  })

  it('小数取整到最近的整数', () => {
    expect(snapTerminalFontSize(15.4)).toBe(15)
    expect(snapTerminalFontSize(16.6)).toBe(17)
  })

  it('夹到 [10,30] 区间（低于 min 上抬、高于 max 下压）', () => {
    expect(snapTerminalFontSize(7)).toBe(10)
    expect(snapTerminalFontSize(33)).toBe(30)
  })

  it('精确命中边界档位时不改变', () => {
    expect(snapTerminalFontSize(10)).toBe(10)
    expect(snapTerminalFontSize(15)).toBe(15)
    expect(snapTerminalFontSize(30)).toBe(30)
  })

  it('非有限值兜底回默认字号 15', () => {
    expect(snapTerminalFontSize(NaN)).toBe(15)
    expect(snapTerminalFontSize(Infinity)).toBe(15)
    expect(snapTerminalFontSize(-Infinity)).toBe(15)
  })

  it('负数/零也夹到下限 10', () => {
    expect(snapTerminalFontSize(0)).toBe(10)
    expect(snapTerminalFontSize(-5)).toBe(10)
  })
})
