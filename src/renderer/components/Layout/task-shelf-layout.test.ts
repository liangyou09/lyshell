import { describe, expect, it } from 'vitest'
import { shelfDocked, shelfPanelWidth, shelfGridLayout, shelfHorizontalLayout, shelfDropEdge, shelfEdge, shelfPanelHeight } from './task-shelf-layout'

describe('任务区按实际窗口空间适配', () => {
  it('横向任务栏先填满每列，再向右扩展；高度不足时只显示方块', () => {
    const tall = shelfHorizontalLayout(1400, 440, 7)
    expect(tall).toMatchObject({ rows: 3, columns: 3, gridWidth: 420, showPreviews: true })
    expect(tall.previewWidth).toBeCloseTo((440 - 70) * 16 / 9)
    const short = shelfHorizontalLayout(1400, 160, 7)
    expect(short).toMatchObject({ rows: 1, columns: 7, showPreviews: false })
    expect(shelfHorizontalLayout(552, 350, 2)).toMatchObject({ rows: 2, columns: 1, previewWidth: 376, previewCardWidth: 378, showPreviews: true })
    expect(shelfHorizontalLayout(552, 220, 2).showPreviews).toBe(false)
    expect(shelfHorizontalLayout(552, 300, 4)).toMatchObject({ rows: 2, columns: 2, gridWidth: 284, showPreviews: false })
    expect(shelfHorizontalLayout(400, 440, 7).showPreviews).toBe(false)
    expect(shelfHorizontalLayout(1400, 0, 0)).toMatchObject({ rows: 1, showPreviews: false })
  })
  it('窗口宽度随横栏可用高度变化，保持 16:9；不足最小可读尺寸时只显示方块', () => {
    const requiredHeight = 70 + 280 * 9 / 16
    expect(shelfHorizontalLayout(1400, requiredHeight, 2).showPreviews).toBe(true)
    expect(shelfHorizontalLayout(1400, requiredHeight - 1, 2).showPreviews).toBe(false)
    expect(shelfHorizontalLayout(1400, 400, 2).previewWidth).toBeGreaterThan(shelfHorizontalLayout(1400, 300, 2).previewWidth)
    expect(shelfHorizontalLayout(552, 400, 2).previewWidth).toBe(376)
  })
  it('显式选择横版任务时限制方块区域，为小窗口留出空间', () => {
    expect(shelfHorizontalLayout(552, 300, 4).showPreviews).toBe(false)
    const selected = shelfHorizontalLayout(552, 300, 4, true)
    expect(selected.showPreviews).toBe(true)
    expect(selected.previewWidth).toBeGreaterThanOrEqual(280)
    expect(selected.gridWidth + selected.previewWidth + 28).toBeLessThanOrEqual(552)
    expect(shelfHorizontalLayout(1400, 440, 50, true).showPreviews).toBe(true)
    expect(shelfHorizontalLayout(400, 440, 7, true).showPreviews).toBe(false)
  })
  it('仅吸附到有效内容区四边，中央或窗口外不换边', () => {
    const rect = { left: 100, top: 36, width: 1000, height: 700 }
    expect(shelfDropEdge(101, 350, rect)).toBe('left')
    expect(shelfDropEdge(1090, 350, rect)).toBe('right')
    expect(shelfDropEdge(500, 40, rect)).toBe('top')
    expect(shelfDropEdge(500, 730, rect)).toBe('bottom')
    expect(shelfDropEdge(500, 350, rect)).toBeNull()
    expect(shelfDropEdge(500, 20, rect)).toBeNull()
    expect(shelfDropEdge(500, 800, rect)).toBeNull()
    expect(shelfEdge('unknown')).toBe('right')
    expect(shelfPanelHeight(1000, 700)).toBe(455)
    expect(shelfPanelHeight(300, 100)).toBe(65)
  })
  it('任务卡随栏宽适配，宽栏保留可读宽度并限制五列', () => {
    expect(shelfGridLayout(200)).toEqual({ columns: 1 })
    expect(shelfGridLayout(240)).toEqual({ columns: 2 })
    expect(shelfGridLayout(304)).toEqual({ columns: 2 })
    expect(shelfGridLayout(400)).toEqual({ columns: 2 })
    expect(shelfGridLayout(640)).toEqual({ columns: 4 })
    expect(shelfGridLayout(800)).toEqual({ columns: 5 })
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
  it('最大宽度随窗口变化且不超过五分之二', () => {
    expect(shelfPanelWidth(1200, 1700, 2000)).toBe(800)
    expect(shelfPanelWidth(1200, 1000, 1200)).toBe(480)
    expect(shelfPanelWidth(1200, 260, 1200)).toBe(228)
    expect(shelfPanelWidth(1200, 400, 500)).toBe(200)
  })
  it('阈值附近保持上次模式并钳制面板宽度', () => {
    expect(shelfDocked('auto', 1760, 1600, 304, true)).toBe(true)
    expect(shelfDocked('auto', 1760, 1600, 304, false)).toBe(false)
    expect(shelfPanelWidth(600, 2000)).toBe(600)
    expect(shelfPanelWidth(900, 2000)).toBe(800)
    expect(shelfPanelWidth(320, 300, 1000)).toBe(268)
  })
})
