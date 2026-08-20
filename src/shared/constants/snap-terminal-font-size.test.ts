import { describe, it, expect } from 'vitest'
import { snapTerminalFontSize } from './index'

describe('snapTerminalFontSize', () => {
  it('吸附到最近的 5 的整数倍', () => {
    expect(snapTerminalFontSize(12)).toBe(10)
    expect(snapTerminalFontSize(13)).toBe(15)
    expect(snapTerminalFontSize(17)).toBe(15)
    expect(snapTerminalFontSize(18)).toBe(20)
  })

  it('夹到 [10,30] 区间（低于 min 上抬、高于 max 下压）', () => {
    // 7 先吸附到 5，但 5 < MIN(10)，最终被夹到 10
    expect(snapTerminalFontSize(7)).toBe(10)
    // 33 先吸附到 35，但 35 > MAX(30)，最终被夹到 30
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
