import { describe, expect, it } from 'vitest'
import { shelfDocked, shelfPanelWidth, shelfGridLayout } from './task-shelf-layout'

describe('任务区按实际窗口空间适配', () => {
  it('大任务格随宽度从两列排到五列，末行和空面板保留空白格', () => {
    expect(shelfGridLayout(240, 1)).toEqual({ columns: 2, slots: 2 })
    expect(shelfGridLayout(304, 3)).toEqual({ columns: 2, slots: 4 })
    expect(shelfGridLayout(400, 4)).toEqual({ columns: 3, slots: 6 })
    expect(shelfGridLayout(640, 7)).toEqual({ columns: 5, slots: 10 })
    expect(shelfGridLayout(400, 0)).toEqual({ columns: 3, slots: 3 })
  })
  it('带鱼屏大窗口常驻，半屏和大侧栏占用回退悬停', () => {
    expect(shelfDocked('auto', 2400, 2000, 320, false)).toBe(true)
    expect(shelfDocked('auto', 1400, 1200, 320, true)).toBe(false)
    expect(shelfDocked('auto', 2400, 1000, 320, true)).toBe(false)
  })
  it('尊重显式悬停和常驻偏好，但不挤坏小窗口工作区', () => {
    expect(shelfDocked('hover', 3400, 3000, 320, true)).toBe(false)
    expect(shelfDocked('fixed', 1600, 1500, 280, false)).toBe(true)
    expect(shelfDocked('fixed', 1000, 900, 280, true)).toBe(false)
  })
  it('阈值附近保持上次模式并钳制面板宽度', () => {
    expect(shelfDocked('auto', 1760, 1600, 304, true)).toBe(true)
    expect(shelfDocked('auto', 1760, 1600, 304, false)).toBe(false)
    expect(shelfPanelWidth(600, 2000)).toBe(600)
    expect(shelfPanelWidth(900, 2000)).toBe(640)
    expect(shelfPanelWidth(320, 300)).toBe(268)
  })
})
