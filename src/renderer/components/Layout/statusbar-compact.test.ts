/**
 * evaluateStatusbarCompact 真值表直测 —— 覆盖进入/退出阈值、6px 迟滞与
 * 两档独立性(行数档先于尺寸档,尺寸隐藏时行数必已隐藏)。
 * 不测 observer 接线:jsdom 无布局(clientWidth 恒 0)且无 ResizeObserver 实现,
 * 接线层测试只能验证自己的 mock,视觉边界仍需 npm run dev 拖侧栏确认。
 */
import { describe, it, expect } from 'vitest'
import { evaluateStatusbarCompact, type StatusbarCompactState } from './statusbar-compact'

const SHOW: StatusbarCompactState = { hideLines: false, hideSize: false }

describe('evaluateStatusbarCompact 宽裕区间', () => {
  it('350px:全显', () => {
    expect(evaluateStatusbarCompact(350, SHOW)).toEqual({ hideLines: false, hideSize: false })
  })

  it('默认侧栏宽 240px:两档全隐(240<260<300),只留协议码与编码读数', () => {
    expect(evaluateStatusbarCompact(240, SHOW)).toEqual({ hideLines: true, hideSize: true })
  })

  it('极窄 180px(侧栏下限):整段隐藏尺寸', () => {
    expect(evaluateStatusbarCompact(180, SHOW)).toEqual({ hideLines: true, hideSize: true })
  })
})

describe('evaluateStatusbarCompact 边界与迟滞', () => {
  it('行数档进入边界:299 隐藏、300 不隐藏', () => {
    expect(evaluateStatusbarCompact(299, SHOW).hideLines).toBe(true)
    expect(evaluateStatusbarCompact(300, SHOW).hideLines).toBe(false)
  })

  it('行数档迟滞:进入隐藏后 300-305px 维持隐藏,306px 才恢复', () => {
    const hidden: StatusbarCompactState = { hideLines: true, hideSize: false }
    expect(evaluateStatusbarCompact(305, hidden).hideLines).toBe(true)
    expect(evaluateStatusbarCompact(306, hidden).hideLines).toBe(false)
  })

  it('尺寸档进入边界:259 隐藏、260 不隐藏(行数必已隐藏)', () => {
    const atSizeEdge: StatusbarCompactState = { hideLines: true, hideSize: false }
    expect(evaluateStatusbarCompact(259, atSizeEdge)).toEqual({ hideLines: true, hideSize: true })
    expect(evaluateStatusbarCompact(260, atSizeEdge).hideSize).toBe(false)
  })

  it('尺寸档迟滞:进入隐藏后 260-265px 维持隐藏,266px 才恢复', () => {
    const bothHidden: StatusbarCompactState = { hideLines: true, hideSize: true }
    expect(evaluateStatusbarCompact(265, bothHidden).hideSize).toBe(true)
    expect(evaluateStatusbarCompact(266, bothHidden).hideSize).toBe(false)
  })

  it('无震荡:阈值附近往复(299→302→299)不产生显隐翻转', () => {
    let state = evaluateStatusbarCompact(299, SHOW)
    expect(state.hideLines).toBe(true)
    state = evaluateStatusbarCompact(302, state)
    expect(state.hideLines).toBe(true) // 迟滞区内维持隐藏
    state = evaluateStatusbarCompact(299, state)
    expect(state.hideLines).toBe(true) // 再进阈值内,未翻转
  })
})
