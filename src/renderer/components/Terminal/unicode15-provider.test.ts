import { describe, it, expect } from 'vitest'
import { Unicode15Provider } from './unicode15-provider'

const { wcwidth, charProperties } = Unicode15Provider

describe('Unicode15Provider.wcwidth', () => {
  it('ASCII 可打印字符占 1 格', () => {
    expect(wcwidth(0x41)).toBe(1) // 'A'
    expect(wcwidth(0x20)).toBe(1) // 空格
    expect(wcwidth(0x7e)).toBe(1) // '~'
  })

  it('emoji 占 2 格', () => {
    expect(wcwidth(0x2705)).toBe(2) // ✅
    expect(wcwidth(0x1f9e0)).toBe(2) // 🧠（增补平面 emoji）
  })

  it('全角 CJK 占 2 格', () => {
    expect(wcwidth(0x4e2d)).toBe(2) // 中
    expect(wcwidth(0x6587)).toBe(2) // 文
  })

  it('组合符占 0 格（é 的组合形式：e + U+0301）', () => {
    expect(wcwidth(0x0301)).toBe(0) // combining acute accent
    // 预组合 é（U+00E9）是普通拉丁字符，占 1 格，作对比
    expect(wcwidth(0x00e9)).toBe(1)
  })

  it('零宽字符占 0 格', () => {
    expect(wcwidth(0x200d)).toBe(0) // ZWJ
    expect(wcwidth(0xfe0f)).toBe(0) // VS16
    expect(wcwidth(0x1f3fb)).toBe(0) // emoji 肤色修饰符
    expect(wcwidth(0x000a)).toBe(0) // \n
    expect(wcwidth(0x0000)).toBe(0) // NUL
  })
})

describe('Unicode15Provider.charProperties（手工移植的位打包/shouldJoin）', () => {
  it('普通字符：width 打包进 bit1-2，shouldJoin=0', () => {
    expect(charProperties(0x41, 0)).toBe(2) // width 1 → (1<<1)|0
    expect(charProperties(0x4e2d, 0)).toBe(4) // width 2 → (2<<1)|0
  })

  it('组合符无前一字符时：width 0、shouldJoin=0', () => {
    expect(charProperties(0x0301, 0)).toBe(0) // (0<<1)|0
  })

  it('组合符紧跟普通字符时：shouldJoin=1 且继承前一字符宽度', () => {
    // 前一字符 charProperties('A') = 2（width 1），组合符 join → width 继承为 1 → (1<<1)|1 = 3
    expect(charProperties(0x0301, 2)).toBe(3)
  })
})
